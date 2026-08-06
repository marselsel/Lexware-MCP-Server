import express from "express";

/**
 * Case-insensitive prefix match on a URL path segment. Express's own routing
 * is case-insensitive by default (`app.set("case sensitive routing", ...)` is
 * off unless explicitly enabled, and this project never enables it) — so
 * `POST /UPLOAD/<ticket>` and `POST /Mcp` really do reach the same handlers as
 * their lowercase spellings. An earlier version of `isMcpPath`/`isUploadPath`
 * compared case-sensitively, which meant an uppercase path was routed to the
 * real handler but NOT recognized by the body-parsing swap below — for
 * `/UPLOAD`, that reopened the gzip-amplification path (Critical 2) up to the
 * ~100 KB global-parser limit, since the pre-check + raw-body defenses in
 * routes.ts never got a chance to run before the global JSON parser did.
 */
function matchesPathCaseInsensitive(p: string, exact: string, prefix: string): boolean {
  const lower = p.toLowerCase();
  return lower === exact || lower.startsWith(prefix);
}

/** MCP protocol traffic. Bodies are parsed by a raised-limit parser mounted AFTER the auth gate (see server.ts). */
export const isMcpPath = (p: string): boolean => matchesPathCaseInsensitive(p, "/mcp", "/mcp/");

/**
 * Ticket-gated upload endpoints (`registerUploadRoutes`). These read the request
 * body themselves via `express.raw()` and must never be pre-parsed by the global
 * JSON layer — if that layer ran first, `req.body` would already be a parsed
 * object (not a `Buffer`) for any `Content-Type: application/json` upload, and a
 * naive length guard would treat that as an empty-but-successful upload while
 * still consuming the ticket.
 */
export const isUploadPath = (p: string): boolean => matchesPathCaseInsensitive(p, "/upload", "/upload/");

/**
 * Reconfigure body parsing so large uploads (and the raw-body ticket routes) work
 * WITHOUT widening the pre-auth attack surface. Skybridge pre-applies a single
 * global `express.json()` (~100 KB default) at router-stack index 0 — before the
 * `/mcp` auth middleware AND before the `/upload` ticket routes' own
 * `express.raw()`. We swap that layer's handler, in place, so it keeps the
 * ~100 KB limit for ordinary routes (e.g. `/status`) but calls `next()`
 * immediately — without touching `req.body` at all — for any path `skipPath`
 * accepts.
 *
 * In-place handler swap (no stack reordering) so it can't mis-order routes.
 * Guarded: returns `false` if the internal layer can't be located, and the
 * caller must treat that as "the swap did not happen" (server.ts warns loudly;
 * routes.ts's own `Buffer.isBuffer` guard is the defense-in-depth backstop for
 * exactly this case).
 *
 * Exported (rather than kept private in server.ts) so the upload routes' tests
 * can exercise this exact function against a test app shaped like the real
 * stack, instead of a parallel reimplementation that could silently drift from
 * production — which is precisely how the original `/upload` JSON-body bug
 * stayed invisible: the test app never had a global JSON parser to begin with.
 */
export function deferBodyParsingFor(app: express.Express, skipPath: (path: string) => boolean): boolean {
  try {
    type Layer = { handle?: express.RequestHandler & { name?: string } };
    const router =
      (app as unknown as { router?: { stack: Layer[] }; _router?: { stack: Layer[] } }).router ??
      (app as unknown as { _router?: { stack: Layer[] } })._router;
    const stack = router?.stack;
    if (!Array.isArray(stack)) return false;
    const layer = stack.find((l) => l?.handle?.name === "jsonParser");
    if (!layer) return false;
    const smallJson = express.json(); // ~100 KB default — for /status and other ordinary routes
    layer.handle = (req, res, next) => (skipPath(req.path) ? next() : smallJson(req, res, next));
    return true;
  } catch {
    return false;
  }
}
