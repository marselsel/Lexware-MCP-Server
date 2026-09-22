import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { RO, WRITE, binaryResult, decodeBase64Strict, text } from "./shared.js";

/** Read tools for the file store. Always registered. */
export function registerFileReadTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "download-file",
      title: "Download file",
      description:
        "Download a file (a rendered document PDF or an uploaded receipt) by its file id. Returns the " +
        "bytes inline as an embedded resource. File ids come from upload-file, an upload ticket, or a voucher's files[].",
      inputSchema: {
        id: z.string().describe("The Lexware file id."),
        accept: z
          .string()
          .optional()
          .describe('Preferred MIME type to request, e.g. "application/pdf". Defaults to any type.'),
      },
      annotations: RO,
    },
    async ({ id, accept }) => {
      const { data, contentType } = await client.getBinary(
        `/v1/files/${encodeURIComponent(id)}`,
        accept ?? "*/*",
      );
      return binaryResult({
        uri: `lexware://files/${id}`,
        data,
        contentType,
        structuredContent: { fileId: id, mimeType: contentType, byteLength: data.length },
        message: `Downloaded file ${id} (${data.length} bytes, ${contentType}).`,
      });
    },
  );
}

/** Write tools for the file store. Registered with the drafts tier. */
export function registerFileWriteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "upload-file",
      title: "Upload file",
      description:
        "Upload a file to Lexware's file store — the first step of attaching a receipt to a bookkeeping " +
        "voucher. Provide the file as base64; returns the new file id to reference elsewhere. The base64 travels " +
        "inline in the request (~12 MB body cap), so keep the source file under ~8 MB.",
      inputSchema: {
        fileBase64: z.string().describe("File contents, base64-encoded."),
        filename: z.string().describe('e.g. "receipt-2024-01.pdf".'),
        mimeType: z.string().describe('Content type, e.g. "application/pdf" or "image/png".'),
        // VERIFY: allowed `type` values for POST /v1/files (Lexware uses "voucher" for receipts).
        type: z
          .string()
          .default("voucher")
          .describe('File category. Lexware uses "voucher" for bookkeeping receipts.'),
      },
      annotations: WRITE,
    },
    async ({ fileBase64, filename, mimeType, type }) => {
      const bytes = decodeBase64Strict(fileBase64, "fileBase64");
      const created = await client.postMultipart<{ id: string }>(
        "/v1/files",
        { bytes, filename, contentType: mimeType },
        { type },
      );
      return {
        structuredContent: created,
        content: text(`Uploaded file ${created.id} (${filename}).`),
      };
    },
  );
}
