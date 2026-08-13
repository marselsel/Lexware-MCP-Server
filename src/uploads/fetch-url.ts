import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { sanitizeFilename } from "./filename.js";
import { createPinnedFetch, type FetchLike } from "./pinned-fetch.js";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Hosts a pre-authenticated download link is allowed to point at. The real use case is
 * OneDrive/SharePoint share links. Callers may override via `fetchRemoteFile`'s
 * `allowedHosts` option (`LEXWARE_UPLOAD_ALLOWED_HOSTS` in the environment).
 */
export const DEFAULT_ALLOWED_HOSTS = ["sharepoint.com", "onedrive.live.com", "1drv.ms", "graph.microsoft.com"];

/**
 * True when `hostname` is exactly one of `allowed`, or a subdomain of one of them
 * (matched on a dot boundary — "evilsharepoint.com" must NOT match "sharepoint.com").
 * Case-insensitive; a trailing dot on `hostname` (a valid DNS root-label terminator) is
 * stripped before comparison.
 */
export function isAllowedHost(hostname: string, allowed: string[]): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  for (const entry of allowed) {
    const suffix = entry.trim().toLowerCase();
    if (!suffix) continue;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/** Parses a dotted-decimal IPv4 string into its four octets. */
function parseIPv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

/**
 * Range checks shared between plain IPv4 addresses and IPv4 addresses embedded in an
 * IPv6 literal (mapped, compatible, or NAT64). Covers loopback, the RFC 1918 private
 * ranges, link-local (incl. the 169.254.169.254 cloud metadata endpoint), carrier-grade
 * NAT (100.64.0.0/10), IETF protocol assignments, benchmarking, multicast and the
 * reserved/broadcast block.
 */
function isBlockedIPv4Bytes(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224 && a <= 239) return true;
  if (a >= 240) return true; // 240.0.0.0/4 reserved, includes 255.255.255.255
  return false;
}

/**
 * Expands an IPv6 literal (RFC 4291 text form, including `::` compression and an
 * embedded trailing IPv4 dotted-quad group) into its 16 bytes. Returns null for
 * anything that doesn't parse as exactly 8 groups — callers must treat null as blocked,
 * not as "not an address".
 */
function parseIPv6ToBytes(ip: string): number[] | null {
  const percentIdx = ip.indexOf("%");
  const text = percentIdx === -1 ? ip : ip.slice(0, percentIdx);

  const dcIdx = text.indexOf("::");
  const hasDoubleColon = dcIdx !== -1;
  const leftPart = hasDoubleColon ? text.slice(0, dcIdx) : text;
  const rightPart = hasDoubleColon ? text.slice(dcIdx + 2) : "";

  const leftGroups = leftPart === "" ? [] : leftPart.split(":");
  const rightGroups = rightPart === "" ? [] : rightPart.split(":");

  // An embedded IPv4 dotted-quad, if present, is always the final group.
  const target = rightGroups.length > 0 ? rightGroups : leftGroups;
  if (target.length > 0 && target[target.length - 1].includes(".")) {
    const v4 = target.pop()!;
    const octets = parseIPv4Octets(v4);
    if (!octets) return null;
    const [o0, o1, o2, o3] = octets;
    target.push(((o0 << 8) | o1).toString(16), ((o2 << 8) | o3).toString(16));
  }

  let allGroups: string[];
  if (!hasDoubleColon) {
    if (leftGroups.length !== 8) return null;
    allGroups = leftGroups;
  } else {
    const known = leftGroups.length + rightGroups.length;
    if (known > 8) return null;
    allGroups = [...leftGroups, ...new Array(8 - known).fill("0"), ...rightGroups];
  }
  if (allGroups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of allGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/**
 * Range checks over the 16-byte form of an IPv6 address. Any address whose first 96 bits
 * (mapped: first 80 bits + ffff; compatible: first 96 bits) are zero-with-ffff-marker or
 * fully zero is really an IPv4 address in disguise and is delegated to the IPv4 check —
 * this is what makes `::ffff:127.0.0.1`, `::ffff:a9fe:a9fe`, `::127.0.0.1`, `::1` and `::`
 * (in any of their hex/dotted/expanded spellings) fold onto the same, already-correct
 * IPv4 logic instead of needing to be special-cased by string pattern.
 */
function isBlockedIPv6Bytes(bytes: number[]): boolean {
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIPv4Bytes(bytes[12], bytes[13], bytes[14], bytes[15]); // ::ffff:a.b.c.d
  }
  const first12Zero = bytes.slice(0, 12).every((b) => b === 0);
  if (first12Zero) {
    return isBlockedIPv4Bytes(bytes[12], bytes[13], bytes[14], bytes[15]); // ::a.b.c.d, ::1, ::
  }
  // 64:ff9b::/96 — well-known NAT64 prefix; block wholesale rather than trusting
  // whatever IPv4 address is embedded in the low 32 bits.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return true;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true; // 2002::/16 (6to4)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 deprecated site-local
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  return false;
}

/**
 * True for addresses a server-side fetch must never reach: loopback, private,
 * link-local (including the 169.254.169.254 cloud metadata endpoint), carrier-grade
 * NAT, multicast/reserved, and their IPv6 equivalents — including every IPv4-in-IPv6
 * spelling (mapped, compatible, NAT64) and non-canonical hex/expanded forms. Checked
 * for EVERY hop, not just the first — a public URL is free to redirect somewhere
 * internal.
 *
 * Fails closed: anything that is not a syntactically valid IPv4 or IPv6 address
 * (including the empty string) counts as blocked rather than as "not an address" —
 * an allow-by-default parser is exactly the kind of gap DNS rebinding and exotic
 * address spellings exploit.
 */
export function isBlockedAddress(rawIp: string): boolean {
  const trimmed = rawIp.trim();
  if (!trimmed) return true;
  if (isIPv4(trimmed)) {
    const octets = parseIPv4Octets(trimmed);
    if (!octets) return true;
    return isBlockedIPv4Bytes(...octets);
  }
  if (isIPv6(trimmed)) {
    const bytes = parseIPv6ToBytes(trimmed);
    if (!bytes) return true;
    return isBlockedIPv6Bytes(bytes);
  }
  return true;
}

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`URL scheme ${url.protocol} is not allowed — only https.`);
  }
  return url;
}

async function defaultLookup(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * Parses a Content-Disposition header for a filename. Per RFC 6266, `filename*`
 * (percent-encoded, RFC 5987 extended value syntax) takes precedence over plain
 * `filename` when both are present. Only the `filename*` form is percent-decoded —
 * applying `decodeURIComponent` to the plain form as well was the bug: a completely
 * ordinary name like `100% Rabatt.pdf` would throw a URIError on the lone `%` and fail
 * the whole download *after* it had already succeeded. Decoding is wrapped in try/catch
 * so a malformed extended value degrades to the raw string instead of failing the call.
 *
 * The extended value's full grammar is `charset'language'percent-encoded-value`
 * (RFC 5987 §3.2.1) and the language part is OPTIONAL BUT COMMONLY SET — German
 * servers routinely send `filename*=UTF-8'de'Rechnung.pdf`. Matching only the
 * literal `UTF-8''` prefix, as this did, left `UTF-8'de'` glued to the front and
 * filed the receipt as `UTF-8'de'Rechnung.pdf`. Both delimiters are therefore
 * split off generically; a value with no apostrophes at all (malformed, but seen
 * in the wild) is still taken verbatim rather than dropped. Percent-decoding
 * always assumes UTF-8: a non-UTF-8 charset label is rare enough that the
 * try/catch fallback to the raw string is the better trade against carrying a
 * transcoder.
 */
function filenameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;

  const extMatch = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (extMatch) {
    let raw = extMatch[1].trim().replace(/^"|"$/g, "");
    const parts = /^([^']*)'([^']*)'([\s\S]*)$/.exec(raw);
    if (parts) raw = parts[3];
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding: keep the raw value rather than failing the download.
    }
    return sanitizeFilename(raw);
  }

  const plainMatch = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  if (plainMatch) return sanitizeFilename(plainMatch[1].trim());

  return undefined;
}

/** Discards a response body we're not going to use so the socket can be released promptly. */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort: a body already errored/closed is fine to ignore.
  }
}

/**
 * Fetch a remote file with SSRF guards. Redirects are followed manually so every
 * hop's host and address can be re-validated before the request is made.
 *
 * Three layers, applied at EVERY hop:
 *
 *  1. **Host allowlist** (`allowedHosts`, default: Microsoft file-sharing domains) —
 *     the primary control. Nothing off the list is ever contacted.
 *  2. **Resolved-address check** (`isBlockedAddress`) — rejects a host that resolves
 *     into loopback, private, link-local or other non-routable space.
 *  3. **Connection pinning** (`createPinnedFetch`) — the connection is made to an
 *     address from the very lookup that layer 2 just approved, instead of letting the
 *     HTTP client resolve the name a second time. Without this, layers 1 and 2 describe
 *     a lookup that the socket is free to disagree with (DNS rebinding); with it there
 *     is only one lookup, so there is nothing to disagree about.
 *
 * `fetchImpl` bypasses layer 3 and exists for tests. Production passes nothing.
 */
export async function fetchRemoteFile(
  rawUrl: string,
  opts: {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    lookup?: (host: string) => Promise<string[]>;
    fetchImpl?: FetchLike;
    allowedHosts?: string[];
  } = {},
): Promise<{ bytes: Uint8Array; contentType: string; filename?: string }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookup = opts.lookup ?? defaultLookup;
  const allowedHosts = opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;

  let url = assertFetchableUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (!isAllowedHost(url.hostname, allowedHosts)) {
        throw new Error(`Host ${url.hostname} is not allowed — not on the configured allowlist.`);
      }

      const addresses = await lookup(url.hostname);
      if (addresses.length === 0) throw new Error(`Host ${url.hostname} did not resolve.`);
      // Deliberately no detail about which address: do not leak internal topology.
      if (addresses.some(isBlockedAddress)) {
        throw new Error(`Target address is not allowed (private, loopback or link-local).`);
      }

      // The addresses just checked are the addresses the socket dials — see layer 3 above.
      const doFetch = opts.fetchImpl ?? createPinnedFetch(url.hostname, addresses);
      const res = await doFetch(url, { redirect: "manual", signal: controller.signal });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`Redirect without a location header.`);
        await drain(res);
        url = assertFetchableUrl(new URL(location, url).toString());
        continue;
      }

      if (!res.ok) {
        await drain(res);
        throw new Error(`Download failed with HTTP ${res.status}.`);
      }

      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await drain(res);
        throw new Error(`File is too large (${declared} bytes, limit ${maxBytes}).`);
      }

      // Stream the body and cut it off as soon as maxBytes is exceeded, instead of
      // buffering the whole thing via res.arrayBuffer() first — a lying (or absent)
      // content-length must not be able to force an unbounded read into memory.
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > maxBytes) {
              controller.abort();
              throw new Error(`File is too large (limit ${maxBytes} bytes).`);
            }
            chunks.push(value);
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            // Best-effort.
          }
        }
      }

      const buf = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return {
        bytes: buf,
        contentType: res.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream",
        filename: filenameFromDisposition(res.headers.get("content-disposition")),
      };
    }
    throw new Error(`Too many redirects (limit ${maxRedirects}).`);
  } finally {
    clearTimeout(timer);
  }
}
