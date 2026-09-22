import type { LexwareClient } from "../lexware/client.js";
import { isNotFound } from "../lexware/errors.js";
import type { Paged } from "../lexware/types.js";

/** Default page size for list tools. */
export const DEFAULT_PAGE_SIZE = 25;

/** Tool annotations, shared so semantics can't drift across tool files. */
export const RO = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;
/** Additive: creates something new and overwrites nothing. */
export const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false } as const;
/**
 * Overwrites or deletes existing data (every update is a full-resource PUT), or cannot be
 * undone (finalizing issues a legally binding document). Clients ask a human before
 * running these, and for finalize that prompt is the real gate: `confirm_finalize` is a
 * value the model sets itself.
 */
export const DESTRUCTIVE = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;
/** Read-only and purely local (no external reach), e.g. building a deeplink string. */
export const LOCAL_RO = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;

/** Wrap a string as MCP text content. */
export function text(message: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text: message }];
}

/**
 * Append `structuredContent`, serialized, as a final text block.
 *
 * The spec: "a tool that returns structured content SHOULD also return the serialized JSON
 * in a TextContent block". Not a formality here — every tool's text is a one-line summary
 * ("Invoice X retrieved."), and a client that shows the model only `content` would otherwise
 * never see the document. Anthropic's own tool-design reference: "not all hosts read
 * `structuredContent` yet". Compact JSON, since it is there for the model, not for a reader.
 *
 * The SDK already does this for a non-object `structuredContent`, so only objects are
 * handled; results without one, and error results, pass through untouched.
 */
export function withJsonText<T>(result: T): T {
  if (typeof result !== "object" || result === null) return result;
  const r = result as { structuredContent?: unknown; content?: unknown; isError?: boolean };
  if (r.isError || typeof r.structuredContent !== "object" || r.structuredContent === null) return result;
  const json = { type: "text" as const, text: JSON.stringify(r.structuredContent) };
  const content =
    r.content === undefined
      ? []
      : Array.isArray(r.content)
        ? r.content
        : [typeof r.content === "string" ? { type: "text" as const, text: r.content } : r.content];
  return { ...result, content: [...content, json] };
}

/** Standard result for a paged list tool: the Paged envelope + a one-line summary. */
export function pagedResult<T>(result: Paged<T>, noun: string) {
  // An empty result set has totalPages 0; render "page 1/1" rather than the
  // self-contradictory "page 1/0".
  const totalPages = Math.max(result.totalPages, 1);
  return {
    structuredContent: result,
    content: text(
      `Found ${result.totalElements} ${noun}; showing page ${result.number + 1}/${totalPages}.`,
    ),
  };
}

/**
 * MCP embedded-resource content block for a binary payload. Inlined (rather than
 * importing Skybridge's `embeddedResource`) so the tools layer stays independent
 * of the Skybridge runtime, per AGENTS.md.
 */
function embeddedResourceBlock(uri: string, mimeType: string, data: Buffer) {
  return {
    type: "resource" as const,
    resource: { uri, mimeType, blob: data.toString("base64") },
  };
}

/**
 * Standard result for a binary-download tool: structured metadata, a one-line
 * summary, and the file inline as an embedded resource. Shared by every
 * PDF/file download tool so the envelope shape can't drift across them.
 */
export function binaryResult(opts: {
  uri: string;
  data: Buffer;
  contentType: string;
  structuredContent: Record<string, unknown>;
  message: string;
}) {
  return {
    structuredContent: opts.structuredContent,
    content: [...text(opts.message), embeddedResourceBlock(opts.uri, opts.contentType, opts.data)],
  };
}

/**
 * Decode a base64 string to bytes, rejecting malformed input instead of silently
 * producing garbage. `Buffer.from(s, "base64")` skips invalid characters, so a
 * value like a leftover `data:...;base64,` prefix or a truncated payload would
 * otherwise upload corrupt bytes and report success. Accepts standard and
 * URL-safe alphabets and tolerates a data-URI prefix / embedded whitespace.
 */
export function decodeBase64Strict(input: string, field = "file"): Buffer {
  let s = input.trim();
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma >= 0) s = s.slice(comma + 1);
  }
  s = s.replace(/\s+/g, "");
  if (!s) throw new Error(`${field}: base64 content is empty.`);
  // Validate the alphabet (standard or URL-safe) and length up front — Buffer.from
  // silently drops invalid characters, so a value like a leftover data-URI prefix or
  // a truncated payload would otherwise decode to garbage. A charset+length check
  // rejects that without re-encoding the whole (multi-MB) payload, and unlike a
  // decode/re-encode round-trip it does not reject non-canonical padding that every
  // standard decoder accepts. Base64 length is never ≡ 1 (mod 4).
  const body = s.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/_-]*$/.test(body) || body.length % 4 === 1) {
    throw new Error(
      `${field}: invalid base64 (non-base64 characters or wrong length). Pass the raw base64 without a data-URI prefix.`,
    );
  }
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * DELETE a resource idempotently. A 404 — the resource is already gone, e.g. a
 * retried DELETE whose first attempt already succeeded, or an id that never
 * existed — is treated as success rather than a false failure. Returns whether the
 * resource was actually found, so callers can distinguish "deleted it" from
 * "it was already absent".
 */
export async function deleteIdempotent(
  client: LexwareClient,
  path: string,
): Promise<{ deleted: true; alreadyAbsent: boolean }> {
  try {
    await client.request<unknown>("DELETE", path, { idempotent: true });
    return { deleted: true, alreadyAbsent: false };
  } catch (e) {
    if (isNotFound(e)) return { deleted: true, alreadyAbsent: true };
    throw e;
  }
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-modify-write merge: overlay `patch` onto `base`, recursing into nested
 * objects so a partial sub-object (e.g. `{ company: { vatRegistrationId } }`)
 * updates one field without wiping its siblings (`company.name`). Arrays and
 * scalars replace wholesale; an `undefined` patch value leaves the base untouched
 * (callers preserve a field by simply omitting it); an explicit `null` clears it.
 *
 * Lexware/lexoffice `PUT` replaces the WHOLE resource, so update tools must GET the
 * current object and merge the caller's fields over it — otherwise omitted fields
 * (attached files, addresses, voucherNumber, …) would be silently wiped and
 * required fields would 406.
 */
export function deepMergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(existing) ? deepMergePatch(existing, value) : value;
  }
  return out;
}

/**
 * Merge a contact's address collection (`{ billing: [...], shipping: [...] }`) by
 * INDEX, deep-merging each address object — unlike {@link deepMergePatch}, which
 * replaces arrays wholesale. This lets a partial patch (e.g. just `countryCode`)
 * update the matching existing address instead of wiping its street/zip/city.
 * lexoffice requires `countryCode` in every address object, so element-wise merge
 * keeps the existing address valid. Existing entries the patch doesn't reach are
 * preserved.
 */
export function mergeAddresses(current: unknown, patch: unknown): Record<string, unknown> {
  const cur = isPlainObject(current) ? current : {};
  const pat = isPlainObject(patch) ? patch : {};
  const out: Record<string, unknown> = { ...cur };
  for (const [key, value] of Object.entries(pat)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const base = Array.isArray(cur[key]) ? (cur[key] as unknown[]) : [];
      const merged = value.map((entry, i) =>
        isPlainObject(entry) && isPlainObject(base[i]) ? deepMergePatch(base[i], entry) : entry,
      );
      // Keep existing addresses beyond the patch length (e.g. a second billing address).
      out[key] = base.length > value.length ? merged.concat(base.slice(value.length)) : merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}
