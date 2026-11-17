import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerDocumentReadTools } from "../src/tools/documents.js";
import { registerFileReadTools } from "../src/tools/files.js";
import { imageOnlyPdf, textPdf, TINY_PNG } from "./fixtures/pdf.js";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;
type Result = { content: { type: string; text?: string; mimeType?: string }[]; structuredContent: Record<string, unknown> };

/**
 * The three download tools, registered against a fake client that serves `file`. Calls go
 * through the published schema, as the SDK does, so `output` must really be declared.
 */
function downloadTools(file: { data: Buffer; contentType: string }) {
  const client = {
    get: vi.fn(async () => ({ files: ["file-1"] })),
    getBinary: vi.fn(async () => file),
  } as unknown as LexwareClient;
  const handlers: Record<string, Handler> = {};
  const schemas: Record<string, z.ZodRawShape> = {};
  const server = {
    registerTool(cfg: { name: string; inputSchema: z.ZodRawShape }, handler: Handler) {
      handlers[cfg.name] = handler;
      schemas[cfg.name] = cfg.inputSchema;
      return server;
    },
  } as unknown as McpServer;
  registerDocumentReadTools(server, client, "https://app.test");
  registerFileReadTools(server, client);
  const call = async (name: string, input: Record<string, unknown>) =>
    (await handlers[name]!(z.object(schemas[name]!).parse(input) as Record<string, unknown>)) as Result;
  return {
    "get-voucher-file": (output?: string) => call("get-voucher-file", { id: "v1", output }),
    "download-file": (output?: string) => call("download-file", { id: "file-1", output }),
    "get-document-file": (output?: string) => call("get-document-file", { resourceType: "invoices", id: "i1", output }),
  };
}

const TOOLS = ["get-voucher-file", "download-file", "get-document-file"] as const;

describe.each(TOOLS)("%s returns readable content", (tool) => {
  it("a PDF with a text layer: extracted text + the embedded resource", async () => {
    const res = await downloadTools({ data: textPdf([["Rechnung Nr. RE-2026-0042", "USt-IdNr. DE123456789"]]), contentType: "application/pdf" })[tool]();
    expect(res.content.map((c) => c.type)).toEqual(["text", "text", "resource"]);
    expect(res.content[1]!.text).toContain("RE-2026-0042");
    expect(res.structuredContent.readable).toMatchObject({ kind: "text" });
  });

  it("a scanned PDF: a page image + the embedded resource", async () => {
    const res = await downloadTools({ data: imageOnlyPdf(), contentType: "application/pdf" })[tool]();
    expect(res.content.filter((c) => c.type === "image")).toEqual([expect.objectContaining({ mimeType: "image/jpeg" })]);
    expect(res.content.at(-1)!.type).toBe("resource");
  });

  it("an image attachment: the image itself", async () => {
    const res = await downloadTools({ data: TINY_PNG, contentType: "image/png" })[tool]("readable");
    expect(res.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it('output="resource" keeps today\'s shape for clients that save the file', async () => {
    const res = await downloadTools({ data: textPdf([["Rechnung"]]), contentType: "application/pdf" })[tool]("resource");
    expect(res.content.map((c) => c.type)).toEqual(["text", "resource"]);
    expect(res.structuredContent.readable).toBeUndefined();
  });
});
