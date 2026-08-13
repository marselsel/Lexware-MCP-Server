import type { IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIPv6 } from "node:net";
import { Readable } from "node:stream";

/**
 * The subset of `fetch` this module needs and provides. `typeof fetch` is assignable
 * to it (a function taking a wider input type satisfies a narrower one), so a caller
 * can still inject the global fetch or a test double.
 */
export type FetchLike = (
  url: URL,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

/**
 * Statuses the `Response` constructor refuses to pair with a body (WHATWG "null body
 * status"). 1xx is absent on purpose: Node reports informational responses through the
 * `information` event, never as `statusCode`, and the `Response` constructor rejects any
 * status below 200 outright — so a 1xx here would be a RangeError, not a null body.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * The shape `net.connect` expects of a custom `lookup`. `family` is typed as Node types
 * it — the numeric form is what the connect path passes, but `dns.lookup` also accepts
 * the string spellings, and a lookup that only understood numbers would silently treat
 * `"IPv6"` as "no preference".
 */
export type PinnedLookup = (
  hostname: string,
  options: { family?: number | "IPv4" | "IPv6"; all?: boolean },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void;

/** Normalizes a hostname for comparison: case-folded, trailing root-label dot removed. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The pin itself: a `lookup` for `net.connect` that never consults DNS and only ever
 * yields `addresses` — the ones the caller already vetted.
 *
 * Exported separately from {@link createPinnedFetch} because this is the whole security
 * property in one pure function, and it is worth testing on its own: every path out of
 * here either hands back a vetted address or an error. There is no path that resolves
 * anything.
 */
export function createPinnedLookup(hostname: string, addresses: string[]): PinnedLookup {
  const pinnedHost = normalizeHost(hostname);
  const pinned = addresses.map((address) => ({ address, family: isIPv6(address) ? 6 : 4 }));

  return (lookupHost, options, callback) => {
    // Fails closed rather than falling back to a real lookup: being asked for a
    // different host means the connection is not the one that was vetted.
    if (normalizeHost(lookupHost) !== pinnedHost) {
      callback(new Error(`Refusing to resolve ${lookupHost}: only ${pinnedHost} was vetted.`), "", 0);
      return;
    }
    // `family` is 0 (or absent) when either family is acceptable. Filtering rather than
    // ignoring it keeps Node's happy-eyeballs retries inside the vetted set.
    const requested = options.family;
    const wanted =
      requested === 4 || requested === "IPv4" ? 4 : requested === 6 || requested === "IPv6" ? 6 : 0;
    const matching = wanted === 0 ? pinned : pinned.filter((a) => a.family === wanted);
    if (matching.length === 0) {
      const what = wanted === 0 ? "address" : `IPv${wanted} address`;
      callback(new Error(`No vetted ${what} for ${pinnedHost}.`), "", 0);
      return;
    }
    if (options.all) callback(null, matching);
    else callback(null, matching[0].address, matching[0].family);
  };
}

/**
 * Builds a `fetch`-shaped function that connects ONLY to `addresses` — the addresses
 * the caller already vetted — instead of resolving `hostname` again at connect time.
 *
 * ## Why this exists
 *
 * The SSRF guard in `fetch-url.ts` resolves the host, checks every returned address
 * against the blocked ranges, and then calls `fetch`. `fetch` does its own DNS
 * resolution when it opens the socket, so the address that was *checked* and the
 * address that is *connected to* come from two separate lookups. A DNS server that
 * answers differently between them — a short TTL and two records, or a deliberate
 * rebinding attack — makes the check describe a different host than the one the bytes
 * come from. That is the classic TOCTOU in every check-then-fetch SSRF filter, and no
 * amount of care in the checking half closes it.
 *
 * Pinning closes it structurally: the check and the connection consume the SAME lookup
 * result, so there is no second resolution to disagree with the first.
 *
 * ## Why `node:https` and not an undici dispatcher
 *
 * An undici `Agent` with a custom `connect` is the other way to do this, but `undici`
 * is not a dependency of this project — `fetch` is Node's built-in copy, which cannot
 * be reached as a module. Taking the npm package on would add a network stack to the
 * dependency set of a server that fronts accounting data, and would leave two copies
 * of undici in the process. `node:https` already exposes the exact hook needed
 * (`lookup`, passed down to `net.connect`), so the guarantee is the same and the
 * dependency count is unchanged.
 *
 * ## What is NOT weakened
 *
 * TLS still validates the certificate against the **hostname**, not the pinned address:
 * `https.request` derives SNI and `checkServerIdentity` from the URL's host, and only
 * the address the socket dials comes from here. Pinning therefore cannot be used to
 * accept a certificate that plain `fetch` would have rejected.
 *
 * Connections are never pooled: a fresh agent with `keepAlive: false` per request, so a
 * socket opened for an earlier (differently vetted) request can never be reused here.
 */
export function createPinnedFetch(hostname: string, addresses: string[]): FetchLike {
  const pinnedHost = normalizeHost(hostname);
  const lookup = createPinnedLookup(hostname, addresses);

  return async function pinnedFetch(url, init) {
    if (addresses.length === 0) {
      throw new Error(`No vetted address to connect to for ${pinnedHost}.`);
    }

    const agent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });

    try {
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpsRequest(
          url,
          {
            method: "GET",
            agent,
            signal: init.signal,
            headers: {
              accept: "*/*",
              // Deliberately no accept-encoding: without it the peer sends identity, so
              // the byte count the size cap is enforced on is the byte count that ends up
              // in memory. With transparent decompression a small compressed body can
              // expand past the cap after the check.
              "user-agent": "lexware-mcp",
            },
            // The whole point. Node hands this to net.connect, so the socket dials an
            // address from the list that was already checked — no second resolution.
            lookup,
          },
          resolve,
        );
        req.on("error", reject);
        req.end();
      });

      // Destroy the agent once the response is done with the socket. Doing it earlier
      // would tear down the connection the body is still arriving on. The `closed` check
      // covers the response that finished during the await above, whose `close` event has
      // already been emitted and would never reach a listener attached now.
      if (res.closed) agent.destroy();
      else res.once("close", () => agent.destroy());

      return responseFromIncoming(res);
    } catch (err) {
      agent.destroy();
      throw err;
    }
  };
}

/**
 * Translates Node's `IncomingMessage` into the `Response` the rest of the upload path
 * already speaks, so swapping the transport did not force the caller to change.
 *
 * Exported for tests: this is the one part of the transport a unit test can exercise
 * end-to-end without a TLS peer, and getting a header or a null-body status wrong here
 * would fail as a puzzling download error far away from the cause.
 */
export function responseFromIncoming(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    // set-cookie is the array case; appending keeps each value its own header line.
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }

  const status = res.statusCode ?? 502;
  // `Response` accepts 200–599 only, and throws a bare RangeError outside it. Say what
  // actually happened instead of letting that surface as the download's error.
  if (status < 200 || status > 599) {
    res.resume();
    throw new Error(`Unexpected HTTP status ${status}.`);
  }
  if (NULL_BODY_STATUSES.has(status)) {
    res.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers });
}
