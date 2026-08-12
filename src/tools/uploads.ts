import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { TicketState, TicketStore } from "../uploads/tickets.js";
import { text, WRITE } from "./shared.js";

/**
 * A media type safe to paste into a single-quoted shell argument: RFC 9110 token
 * characters only, `type/subtype`. Anything else — most importantly a `'` — is
 * refused rather than escaped, because the value comes from the model and the
 * result is a command a human is told to run. Refusing drops the header and lets
 * the server's own fallback chain decide; escaping would keep a hostile value in
 * a command line, one quoting mistake away from executing.
 */
const MEDIA_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/**
 * Builds the ready-to-run curl command for the local-file path.
 *
 * Exactly ONE thing to replace — the `FILE=` path. Name and type are NOT derived
 * in the shell; they are precomputed HERE, from what the model already knew when
 * it issued the ticket. Two measured defects killed the shell-derivation form:
 *
 *  1. `-H "X-Filename: $(basename "$FILE")"` sends raw bytes, and a header value
 *     is Latin-1 on the wire: `Rechnung Müller.pdf` reached Lexware as
 *     `Rechnung MÃ¼ller.pdf`, `Beleg – Januar 2026.pdf` as `Beleg â Januar
 *     2026.pdf`. Exactly the failure class already closed for the browser — so
 *     the same lock is used: `X-Filename-B64`, base64url of the UTF-8 bytes,
 *     computed server-side. base64url output is `[A-Za-z0-9_-]` and therefore
 *     always safe inside single quotes.
 *  2. `$(file -b --mime-type "$FILE")` made `file(1)` a silent prerequisite. It
 *     is absent on this host (and on slim containers generally): the substitution
 *     printed `file: command not found`, the header went out EMPTY, and the
 *     receipt was filed as `application/octet-stream` — while curl still reported
 *     success with a file id.
 *
 * Without `filename`/`mimeType` the respective header is OMITTED entirely rather
 * than guessed. The server then falls back to the ticket's own values and finally
 * to `upload.bin` / `application/octet-stream` — the same outcome as before, but
 * without a foreign dependency and without a header that promises something false.
 */
export function buildCurlCommand(uploadUrl: string, file: { filename?: string; mimeType?: string } = {}): string {
  const headers: string[] = [];
  const mimeType = file.mimeType?.trim();
  if (mimeType && MEDIA_TYPE_RE.test(mimeType)) {
    headers.push(` -H 'Content-Type: ${mimeType}'`);
  }
  const filename = file.filename?.trim();
  if (filename) {
    headers.push(` -H 'X-Filename-B64: ${Buffer.from(filename, "utf8").toString("base64url")}'`);
  }
  // The placeholder path is SINGLE-QUOTED, and that is not cosmetic: measured by
  // running this command literally, `FILE=/path with spaces/file.pdf` fails at
  // the ASSIGNMENT ("spaces/file.pdf: command not found") — before curl ever starts. The
  // naive edit is to paste a real path over the placeholder, and real paths contain
  // spaces, so the quotes have to already be there. `"$FILE"` is likewise quoted at
  // every expansion, and the URL stays single-quoted so the ticket value can never
  // be re-interpreted by the shell.
  return `FILE='/path/to/file.pdf'; curl -sS -X POST '${uploadUrl}'${headers.join("")} --data-binary @"$FILE"`;
}

/** Pure: builds the client-facing shape of a freshly issued ticket. Unit-tested. */
export function buildTicketResponse(
  state: Pick<TicketState, "ticket" | "type" | "expiresAt" | "filename" | "mimeType">,
  publicBaseUrl: string,
): { ticket: string; uploadUrl: string; curlCommand: string; expiresAt: string } {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const uploadUrl = `${base}/upload/${state.ticket}`;
  return {
    ticket: state.ticket,
    uploadUrl,
    // The ticket's own filename/mimeType are the values the model supplied — the
    // command gets them baked in, so the local path is the only thing to edit.
    curlCommand: buildCurlCommand(uploadUrl, { filename: state.filename, mimeType: state.mimeType }),
    expiresAt: new Date(state.expiresAt).toISOString(),
  };
}

export function registerUploadTools(
  server: McpServer,
  store: TicketStore,
  publicBaseUrl: string,
): void {
  server.registerTool(
    {
      name: "create-upload-ticket",
      description:
        "Issue a short-lived, single-use upload ticket so a file can reach Lexware WITHOUT its bytes passing " +
        "through the model context (unlike upload-file, which needs base64). Returns a browser URL for " +
        "drag-and-drop and a ready-to-run curl command — run the curl locally where the file lives, replacing " +
        "ONLY the FILE=/path/to/file.pdf path at the front; nothing else must be edited. " +
        "PASS filename AND mimeType whenever you know them: they are baked into the command as headers, so the " +
        "receipt is filed under its real name (umlauts, dashes and quotes included) and its real type. Omit " +
        "them and the file lands in the bookkeeping generically named 'upload.bin' as application/octet-stream. " +
        "The command needs no extra tools installed. It prints the Lexware file id; in the browser case, " +
        "read it afterwards with get-upload-result. Valid 15 minutes, usable once.",
      inputSchema: {
        filename: z
          .string()
          .optional()
          .describe(
            "The file's real name, e.g. \"Rechnung Müller.pdf\". Baked into the curl command and used as the " +
              "fallback if the upload itself carries none. Without it the receipt is named upload.bin.",
          ),
        mimeType: z
          .string()
          .optional()
          .describe(
            'Content type, e.g. "application/pdf" or "image/jpeg". Baked into the curl command and used as the ' +
              "fallback if the upload carries none. Without it the receipt is filed as application/octet-stream.",
          ),
        type: z.string().default("voucher").describe('Lexware file category. "voucher" for bookkeeping receipts.'),
      },
      annotations: WRITE,
    },
    async ({ filename, mimeType, type }: { filename?: string; mimeType?: string; type: string }) => {
      const state = store.create({ type, filename, mimeType });
      const out = buildTicketResponse(state, publicBaseUrl);
      return {
        structuredContent: out,
        content: text(
          `Upload ticket ready (valid until ${out.expiresAt}).\nBrowser: ${out.uploadUrl}\nLocal file: ${out.curlCommand}`,
        ),
      };
    },
  );

  server.registerTool(
    {
      name: "get-upload-result",
      description:
        "Read the Lexware file id produced by an upload ticket. Use after a browser drag-and-drop; the curl " +
        "path already prints the id itself. Returns pending=true while nothing has been uploaded yet.",
      inputSchema: { ticket: z.string().describe("The ticket from create-upload-ticket.") },
      annotations: WRITE,
    },
    async ({ ticket }: { ticket: string }) => {
      const state = store.peek(ticket);
      if (!state) {
        return {
          structuredContent: { pending: false, expired: true },
          content: text("Ticket is unknown or expired. Issue a new one with create-upload-ticket."),
        };
      }
      if (!state.result) {
        return {
          structuredContent: { pending: true },
          content: text("Nothing uploaded yet. The file has not arrived."),
        };
      }
      return {
        structuredContent: { pending: false, ...state.result },
        content: text(`Uploaded file ${state.result.fileId} (${state.result.filename}, ${state.result.byteLength} bytes).`),
      };
    },
  );
}
