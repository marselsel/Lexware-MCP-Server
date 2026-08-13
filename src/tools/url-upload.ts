import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { fetchRemoteFile } from "../uploads/fetch-url.js";
import { sanitizeFilename } from "../uploads/filename.js";
import { text, WRITE } from "./shared.js";

/**
 * Last path segment of a URL, percent-decoded. Total by contract: a malformed URL or a
 * lone `%` yields `""` (which `sanitizeFilename` then maps to `undefined`) rather than
 * throwing — the caller relies on this to fall through to the fixed default.
 */
function urlBasename(rawUrl: string): string {
  let last: string;
  try {
    last = new URL(rawUrl).pathname.split("/").pop() ?? "";
  } catch {
    return "";
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The filename to store the download under, decided the same way as the ticket flow
 * (see `resolveFilename` in routes.ts): a sanitized model override, then the sanitized
 * `Content-Disposition` name the fetch already resolved, then the URL's own basename
 * (percent-decoded, sanitized), then a fixed default. EVERY candidate goes through
 * `sanitizeFilename` — the same trust-boundary helper the ticket flow uses — so a name
 * like `../../etc/passwd`, an embedded CRLF, or an over-long string never reaches the
 * multipart field, the logs, or the tool result. Because `sanitizeFilename` never returns
 * `""` (an empty/unusable name comes back `undefined`), each candidate is either a real
 * name or falls through — so a trailing-slash URL (`.../x/` → basename `""`) lands on
 * `download.bin`, never an empty filename.
 *
 * The URL basename is the LAST resort, so it is only parsed when the override and the
 * response name both came back empty — no `new URL()`/decode on the common path.
 * `resolveDownloadName` never throws: `urlBasename` is total (see above).
 */
export function resolveDownloadName(override: string | undefined, fromResponse: string | undefined, url: string): string {
  const fromOverride = override !== undefined ? sanitizeFilename(override) : undefined;
  if (fromOverride) return fromOverride;
  // fromResponse (fetched.filename) was already sanitized in filenameFromDisposition and
  // is never `""`, so it wins here without a second sanitize pass.
  if (fromResponse) return fromResponse;
  return sanitizeFilename(urlBasename(url)) ?? "download.bin";
}

/**
 * `upload-file-from-url` — the server-side URL fetcher.
 *
 * Deliberately its own file and its own capability gate (`LEXWARE_ENABLE_URL_UPLOAD`,
 * off by default) rather than part of the ticket flow in `uploads.ts`. The ticket flow
 * only ever *receives* bytes; this tool makes the server *originate* an outbound request
 * to a location the model picked, which is a different risk class (SSRF) and deserves a
 * switch of its own. Keeping the two apart means an operator can read the file tree and
 * see which one is which.
 *
 * The guards live in `fetch-url.ts`: allow-list, per-hop address checks, and pinning the
 * connection to the address that was checked.
 */
export function registerUrlUploadTool(
  server: McpServer,
  client: LexwareClient,
  allowedHosts: string[],
): void {
  server.registerTool(
    {
      name: "upload-file-from-url",
      description:
        "Download a file from a pre-authenticated share link and store it in Lexware, without the bytes " +
        "passing through the model context — e.g. an email attachment saved to OneDrive/SharePoint via the " +
        "Microsoft 365 tools. Only https URLs on an allow-listed host are accepted, re-checked after every " +
        `redirect; arbitrary URLs are refused by design. Allow-listed here: ${allowedHosts.join(", ") || "(none — every URL is refused)"}. ` +
        "Limit 20 MB. If the file is on this machine rather than behind a link, use create-upload-ticket.",
      inputSchema: {
        url: z.string().describe("Public https URL of the file (allow-listed hosts only)."),
        filename: z.string().optional().describe("Overrides the name derived from the response."),
        mimeType: z.string().optional().describe("Overrides the content type from the response."),
        type: z.string().default("voucher").describe('Lexware file category. "voucher" for bookkeeping receipts.'),
      },
      annotations: WRITE,
    },
    async ({ url, filename, mimeType, type }: { url: string; filename?: string; mimeType?: string; type: string }) => {
      const fetched = await fetchRemoteFile(url, { allowedHosts });
      const name = resolveDownloadName(filename, fetched.filename, url);
      const created = await client.postMultipart<{ id: string }>(
        "/v1/files",
        { bytes: fetched.bytes, filename: name, contentType: mimeType ?? fetched.contentType },
        { type },
      );
      return {
        structuredContent: { fileId: created.id, filename: name, byteLength: fetched.bytes.byteLength },
        content: text(`Uploaded file ${created.id} (${name}, ${fetched.bytes.byteLength} bytes) from ${url}.`),
      };
    },
  );
}
