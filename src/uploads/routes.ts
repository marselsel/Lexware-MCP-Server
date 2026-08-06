import express from "express";
import { LexwareApiError } from "../lexware/errors.js";
import { sanitizeFilename } from "./fetch-url.js";
import { uploadPageHtml } from "./page.js";
import { TicketError, TicketStore, type TicketState } from "./tickets.js";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** Forwards bytes to storage; injected so the routes stay testable without network. */
export type UploadFn = (args: {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  type: string;
}) => Promise<{ id: string }>;

/**
 * Raised by the route handler itself (as opposed to `TicketError`, raised by
 * `store.claim()`) for a request that *did* successfully claim the ticket but is
 * otherwise unusable (e.g. an empty body). Thrown rather than handled inline so
 * every such failure runs through the single `catch` block below and its
 * `release()` call — a `return` from inside the `try` would skip that release and
 * strand the ticket `inFlight` for the rest of its TTL.
 */
class UploadRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "UploadRequestError";
  }
}

/**
 * Mirrors `claim()`'s reject conditions (unknown/expired, or already claimed/
 * completed) as a read-only check, for the two call sites that must NOT claim
 * the ticket themselves: `GET` (just renders the page or a 410) and the `POST`
 * pre-check below (must reject before the body is read, without taking the
 * lock — see `requireClaimableTicket`). `claim()` remains the only place that
 * actually sets `inFlight`.
 */
function ticketUsabilityError(state: TicketState | undefined): { status: number; message: string } | undefined {
  if (!state) return { status: 410, message: "Upload ticket is unknown or expired. Create a new one." };
  if (state.result || state.inFlight) return { status: 410, message: "Upload ticket was already used." };
  return undefined;
}

/**
 * `req.params.ticket` types as `string | string[]` in some middleware-chain
 * positions (Express's ParamsDictionary allows repeated-segment params to be
 * arrays) even though this route only ever declares a single `:ticket`
 * segment. Normalizes to the plain string in all four call sites below.
 */
function ticketParam(req: express.Request): string {
  const t = req.params.ticket;
  return Array.isArray(t) ? (t[0] ?? "") : t;
}

/**
 * Rejects a request for an unusable ticket BEFORE `express.raw()` runs, so an
 * invalid/expired/already-used ticket never causes the body to be read at all.
 * Without this, a request naming a bogus ticket could still make the server
 * buffer up to `maxBytes` of attacker-supplied data — worse, WITH gzip framing
 * decompressed (see `inflate: false` on the raw parser below) — purely to
 * discover the ticket doesn't exist. Uses `peek()`, not `claim()`: this check
 * must not itself take the lock, or an aborted/failed request for a valid
 * ticket would burn it before the real handler ever ran.
 */
function requireClaimableTicket(store: TicketStore): express.RequestHandler {
  return (req, res, next) => {
    const err = ticketUsabilityError(store.peek(ticketParam(req)));
    if (err) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next();
  };
}

/**
 * Ticket-gated upload endpoints. These sit OUTSIDE the OAuth gate on purpose —
 * the single-use, short-lived ticket is the credential, so a browser or a plain
 * curl can post bytes without holding a long-lived secret.
 */
export function registerUploadRoutes(
  app: express.Express,
  store: TicketStore,
  upload: UploadFn,
  maxBytes: number = DEFAULT_MAX_BYTES,
): void {
  app.get("/upload/:ticket", (req, res) => {
    const err = ticketUsabilityError(store.peek(ticketParam(req)));
    if (err) {
      res.status(err.status).type("text/plain").send(err.message);
      return;
    }
    res.type("text/html").send(uploadPageHtml(ticketParam(req)));
  });

  app.post(
    "/upload/:ticket",
    // Cheap, non-claiming rejection for a bad ticket — must run before the body
    // is ever touched. See requireClaimableTicket's doc comment.
    requireClaimableTicket(store),
    // `inflate: false`: refuse to transparently gunzip the body. Without this, a
    // `Content-Encoding: gzip` request lets an attacker trade a small wire-size
    // body for a much larger buffered one (measured amplification: ~1000x) before
    // any limit or ticket check can stop it. `type: () => true` is intentional —
    // the endpoint accepts arbitrary declared content-types as opaque bytes; only
    // the OUTER json-vs-raw ordering (server-body-parsing.ts) determines whether
    // this middleware sees the real bytes or an already-parsed object.
    express.raw({ type: () => true, limit: maxBytes, inflate: false }),
    async (req, res) => {
      // Tracks whether this request actually took the ticket, so only a failure
      // AFTER the claim releases it again — a TicketError from claim() itself
      // never held it, and releasing then would hand it back to a racing request.
      let claimed: string | undefined;
      try {
        const state = store.claim(ticketParam(req));
        claimed = state.ticket;

        const bytes = req.body;
        // Defense in depth, not just a length check: if the global JSON parser
        // ever ran before this middleware again (see server-body-parsing.ts),
        // `req.body` would be a parsed OBJECT, not a Buffer — `!bytes ||
        // bytes.length === 0` does not catch that (an object has no `.length`),
        // and the upload silently "succeeded" with zero bytes while still
        // burning the ticket. Thrown, not returned, so `release()` below runs.
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          throw new UploadRequestError("Empty body.", 400);
        }

        const filename = resolveFilename(req, state);
        const contentType = resolveContentType(req, state);
        const created = await upload({
          bytes: new Uint8Array(bytes),
          filename,
          contentType,
          type: state.type,
        });
        const result = { fileId: created.id, filename, byteLength: bytes.length };
        store.complete(state.ticket, result);
        res.json(result);
      } catch (err) {
        if (claimed) store.release(claimed);
        if (err instanceof TicketError || err instanceof UploadRequestError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        // A rejection BY Lexware is not a failure OF this server. Forwarding its
        // status verbatim keeps a refused file type (406) or a rejected size (413)
        // out of the 502 bucket, which the operator's runbook reads as "container
        // is down" — sending them hunting for an outage that never happened. The
        // message already carries Lexware's own wording (see describeErrorBody).
        // `status === 0` means a network/transport failure reaching Lexware — that
        // IS an upstream-gateway problem and correctly stays 502, as does anything
        // outside the valid HTTP error range (res.status would otherwise throw).
        if (err instanceof LexwareApiError && err.status >= 400 && err.status < 600) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Catches every failure raised by the middleware above (currently: express.raw's
  // own size/encoding errors) and closes it off with a fixed JSON shape. NEVER
  // forward to `next(err)` here: that would hand off to Express' default error
  // handler, which — outside NODE_ENV=production — renders a full stack trace
  // (absolute file paths included) to a caller these routes deliberately leave
  // unauthenticated.
  app.use("/upload", (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    if (status === 413) {
      // Deliberately does not name maxBytes: after the global JSON parser is
      // deferred for /upload (server-body-parsing.ts), a 413 here always comes
      // from THIS limit — but if that deferral ever fails (it's guarded, not
      // guaranteed), the ~100 KB global parser could trip first instead, and a
      // message naming the 20 MB limit would be actively wrong about what just
      // happened.
      res.status(413).json({ error: "Uploaded file is too large." });
      return;
    }
    const safeStatus = typeof status === "number" && status >= 400 && status < 600 ? status : 400;
    res.status(safeStatus).json({ error: "Upload failed." });
  });
}

/**
 * Extracts a single string from an Express/Node header value. `IncomingHttpHeaders`
 * types every ordinary header as `string | string[] | undefined` even though, in
 * practice, only a handful of special headers (`Set-Cookie` being the main one)
 * are ever actually delivered as an array — this just takes the first element for
 * those, per Node's own API contract.
 *
 * Deliberately does NOT split on commas. An earlier version treated a comma as
 * "this is Node's folding of a duplicated header, take the first part" — but
 * Node folds a genuinely REPEATED header into one comma-joined string at the
 * HTTP layer, and a comma is a completely legal character IN a filename
 * (`Rechnung, Mai 2026.pdf`) that the browser page sends verbatim via
 * `file.name`. Splitting on "," silently truncated real filenames sent by the
 * page itself — a worse outcome than the doubled-header case it was meant to
 * guard against. A doubled `X-Filename` is a client bug, not an attack: the
 * result still goes through `sanitizeFilename` in {@link resolveFilename}
 * either way, and an odd combined name is far less harmful than a silently
 * truncated one.
 */
export function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Decodes the `X-Filename-B64` header: base64url of the filename's UTF-8 bytes.
 *
 * Exists because an HTTP header field value is bytes, and `fetch()` in a browser
 * throws a TypeError for any header character above U+00FF — so the drag-and-drop
 * page could not send perfectly ordinary German filenames containing an en dash
 * (`Beleg – Januar 2026.pdf`) or typographic quotes (`Rechnung „Mai“.pdf`). The
 * request never left the browser at all.
 *
 * A SEPARATE header, not a guess: sniffing whether `X-Filename` "looks encoded"
 * is ambiguous — `Rechnung 100%20 Rabatt.pdf` and a genuinely base64-looking name
 * are both real filenames. The header's presence is the signal; nothing about the
 * value is interpreted as one.
 *
 * Returns `undefined` (never throws) for anything that is not exactly a base64url
 * encoding of valid UTF-8, so the caller falls back to `X-Filename`:
 *  - `Buffer.from(…, "base64url")` is deliberately lenient — it silently DROPS
 *    characters outside the alphabet and tolerates a truncated final group — so
 *    the alphabet regex and the re-encode round-trip below are what actually
 *    reject a malformed value instead of accepting a mangled name.
 *  - U+FFFD in the decoded string means the bytes were not valid UTF-8 (Node
 *    substitutes rather than throwing).
 *  - C0/C7F control characters cannot occur in a legitimate filename and are the
 *    one thing base64 could smuggle in that a plain header cannot; rejected here
 *    rather than sanitized, so the fallback chain produces a sane name instead.
 */
export function decodeFilenameB64(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) return undefined;
  const unpadded = trimmed.replace(/=+$/, "");
  const bytes = Buffer.from(unpadded, "base64url");
  if (bytes.length === 0) return undefined;
  if (bytes.toString("base64url") !== unpadded) return undefined;
  const decoded = bytes.toString("utf8");
  if (decoded.includes("\uFFFD")) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  return decoded;
}

/**
 * Filename precedence, decided at exactly this line: sanitized `X-Filename-B64`
 * (see {@link decodeFilenameB64}) if it decodes, then sanitized `X-Filename`,
 * then the ticket's own fallback, then a fixed default. `sanitizeFilename`
 * (from fetch-url.ts, the same trust-boundary helper used for download links)
 * reduces to a basename — so a header like `../../../../etc/cron.d/evil.sh`
 * cannot escape the upload's own scope — and, importantly here, its return type
 * is `string | undefined`: it NEVER returns `""` (an empty or unsanitizable name
 * comes back as `undefined`). That makes `??` exactly right for this chain —
 * unlike {@link resolveContentType}, where the RAW declared value genuinely can
 * be `""` after stripping parameters, `fromHeader`/`fromTicket` here can only
 * ever be a non-empty string or `undefined`, so there is no empty-string case
 * for `||` to catch that `??` would miss.
 *
 * `X-Filename-B64` wins over a simultaneously sent `X-Filename` because only the
 * encoded form can carry the full name — a client that sends both is either the
 * page (which sends only the encoded one) or a client that deliberately added it.
 * An undecodable `X-Filename-B64` yields `undefined`, so the chain simply moves
 * on to `X-Filename`: a bad encoding degrades, it never fails the upload.
 */
function resolveFilename(req: express.Request, state: TicketState): string {
  const b64 = headerString(req.headers["x-filename-b64"]);
  const decoded = b64 !== undefined ? decodeFilenameB64(b64) : undefined;
  const fromB64 = decoded !== undefined ? sanitizeFilename(decoded) : undefined;
  const header = headerString(req.headers["x-filename"]);
  const fromHeader = header !== undefined ? sanitizeFilename(header) : undefined;
  const fromTicket = state.filename !== undefined ? sanitizeFilename(state.filename) : undefined;
  return fromB64 ?? fromHeader ?? fromTicket ?? "upload.bin";
}

/**
 * Content-type precedence: the request's own `Content-Type` (parameters
 * stripped and the result TRIMMED before the emptiness check — `; charset=utf-8`
 * alone must count as empty, not as a value), then the ticket's fallback, then a
 * fixed default. `||`, not `??`, for the same reason as {@link resolveFilename}.
 */
function resolveContentType(req: express.Request, state: TicketState): string {
  const declared = req.headers["content-type"]?.split(";")[0]?.trim();
  return declared || state.mimeType || "application/octet-stream";
}
