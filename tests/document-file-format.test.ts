import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import type { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";
import { registerDocumentReadTools } from "../src/tools/documents.js";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

const schemas: Record<string, Record<string, unknown>> = {};

function setup(getBinary: LexwareClient["getBinary"]) {
  const client = { getBinary } as unknown as LexwareClient;
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool(cfg: { name: string; inputSchema?: Record<string, unknown> }, handler: Handler) {
      handlers[cfg.name] = handler;
      if (cfg.inputSchema) schemas[cfg.name] = cfg.inputSchema;
      return server;
    },
  } as unknown as McpServer;
  registerDocumentReadTools(server, client, "https://app.test");
  return handlers;
}

/** Fresh spies per test — a shared mock would carry calls between them. */
const pdfOk = () =>
  vi.fn(async () => ({ data: Buffer.from("%PDF-1.7"), contentType: "application/pdf" }));
const xmlOk = () =>
  vi.fn(async () => ({
    data: Buffer.from("<?xml version='1.0'?><Invoice/>"),
    contentType: "application/xml",
  }));

/** The (path, accept) pair of the first getBinary call. */
function call(spy: ReturnType<typeof vi.fn>): [string, string | undefined] {
  return spy.mock.calls[0] as [string, string | undefined];
}

describe("document file downloads: PDF vs e-invoice XML", () => {
  it("asks for application/pdf by default", async () => {
    const spy = pdfOk();
    await setup(spy as never)["render-invoice-pdf"]({ id: "inv-1", format: "pdf" });
    expect(call(spy)).toEqual(["/v1/invoices/inv-1/file", "application/pdf"]);
  });

  it("asks for application/xml when the XML is wanted", async () => {
    // The point of the parameter: Lexware's PDF of an XRechnung is a preview and is
    // explicitly not a valid e-invoice, so the XML has to be reachable.
    const spy = xmlOk();
    await setup(spy as never)["render-invoice-pdf"]({ id: "inv-1", format: "xml" });
    expect(call(spy)).toEqual(["/v1/invoices/inv-1/file", "application/xml"]);
  });

  it("threads the format through get-document-file too", async () => {
    const spy = xmlOk();
    await setup(spy as never)["get-document-file"]({
      resourceType: "credit-notes",
      id: "cn-1",
      format: "xml",
    });
    expect(call(spy)).toEqual(["/v1/credit-notes/cn-1/file", "application/xml"]);
  });

  it("percent-encodes the id in both tools", async () => {
    const spy = pdfOk();
    await setup(spy as never)["render-invoice-pdf"]({ id: "a/b", format: "pdf" });
    expect(call(spy)[0]).toBe("/v1/invoices/a%2Fb/file");
  });

  it("reports the format in the result, not a hardcoded 'PDF'", async () => {
    const result = (await setup(xmlOk() as never)["render-invoice-pdf"]({
      id: "inv-1",
      format: "xml",
    })) as { structuredContent: Record<string, unknown>; content: unknown };
    expect(result.structuredContent.format).toBe("xml");
    expect(result.structuredContent.mimeType).toBe("application/xml");
  });

  it("translates the 404 on an XML request into what actually happened", async () => {
    // Verified live: an EN16931 (ZUGFeRD) invoice answers 404 for application/xml,
    // because its XML is embedded in the PDF rather than served separately. The raw
    // 404 reads as "no such invoice" and would send the caller after the wrong problem.
    const notFound = vi.fn(async () => {
      throw new LexwareApiError(404, "Not Found");
    });
    await expect(
      setup(notFound as never)["render-invoice-pdf"]({ id: "inv-1", format: "xml" }),
    ).rejects.toThrow(/not an XRechnung .* embedded in the PDF/s);
  });

  it("leaves a 404 on a PDF request alone — there it really does mean not found", async () => {
    const notFound = vi.fn(async () => {
      throw new LexwareApiError(404, "Not Found");
    });
    await expect(
      setup(notFound as never)["render-invoice-pdf"]({ id: "nope", format: "pdf" }),
    ).rejects.toThrow(LexwareApiError);
  });

  it("offers format only where an e-invoice is possible", () => {
    // A quotation, order confirmation, delivery note or dunning always reports
    // electronicDocumentProfile "NONE", so advertising format="xml" on those tools
    // would offer a choice that can only fail.
    setup(pdfOk() as never);
    for (const name of ["render-invoice-pdf", "render-credit-note-pdf", "render-down-payment-invoice-pdf"]) {
      expect(Object.keys(schemas[name])).toContain("format");
    }
    for (const name of [
      "render-quotation-pdf",
      "render-order-confirmation-pdf",
      "render-delivery-note-pdf",
      "render-dunning-pdf",
    ]) {
      expect(Object.keys(schemas[name])).not.toContain("format");
    }
  });

  it("refuses an XML request for a resource that can never have one, without a request", async () => {
    const spy = pdfOk();
    await expect(
      setup(spy as never)["get-document-file"]({
        resourceType: "quotations",
        id: "q-1",
        format: "xml",
      }),
    ).rejects.toThrow(/never has an e-invoice XML/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("names both causes of the 404, not just the profile one", async () => {
    // The same status covers "exists but has no standalone XML" and "no such id".
    // Naming only the first sends someone with a typo hunting through the profile.
    const notFound = vi.fn(async () => {
      throw new LexwareApiError(404, "Not Found");
    });
    await expect(
      setup(notFound as never)["render-invoice-pdf"]({ id: "typo", format: "xml" }),
    ).rejects.toThrow(/no document exists with that id/);
  });

  it("reports the normalized format in get-document-file too, not the raw input", async () => {
    // Its render-*-pdf twin normalized; this one echoed the raw value, so a call made
    // without the zod default reported `format: undefined` beside PDF bytes.
    const result = (await setup(pdfOk() as never)["get-document-file"]({
      resourceType: "invoices",
      id: "inv-1",
    })) as { structuredContent: Record<string, unknown> };
    expect(result.structuredContent.format).toBe("pdf");
  });

  it("leaves other errors alone, including a 409 draft", async () => {
    // A draft has no file at all; Lexware answers 409 on /file. That must surface as
    // itself, not get rewritten into the XML explanation.
    const conflict = vi.fn(async () => {
      throw new LexwareApiError(409, "Conflict");
    });
    await expect(
      setup(conflict as never)["render-invoice-pdf"]({ id: "draft-1", format: "xml" }),
    ).rejects.toThrow(LexwareApiError);
  });
});
