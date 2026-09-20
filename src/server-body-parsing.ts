import type { JsonOptions } from "skybridge/server";

/**
 * Options for Skybridge's built-in, app-level `express.json()` — deliberately inert.
 *
 * Skybridge applies that parser in the `Skybridge` constructor, as router-stack layer 0.
 * That is ahead of every middleware this project can register, including the auth gate,
 * and ahead of the upload routes' own `express.raw()`. Both of those orderings matter:
 *
 * - Raising its `limit` (the documented use of `json`) would buffer and parse a multi-MB
 *   body for an UNAUTHENTICATED request. `server.ts` mounts the raised-limit parser on
 *   `/mcp` *after* the auth gate precisely so that cannot happen.
 * - Leaving it at the ~100 KB default would pre-parse `/upload/:ticket` bodies. For a
 *   `Content-Type: application/json` upload `req.body` would then be a parsed object
 *   rather than a `Buffer`, and a naive length guard reads that as an empty-but-successful
 *   upload while still consuming the ticket.
 *
 * `type: () => false` makes body-parser's content-type predicate never match, so it calls
 * `next()` without reading the stream at all. Nothing is parsed app-wide; `server.ts`
 * mounts the parsers it wants, where it wants them.
 *
 * This is a passthrough to Express's own `OptionsJson`, whose `type` accepts a predicate,
 * but it is NOT a documented Skybridge idiom — upstream documents `json` only for raising
 * the limit. `tests/server-body-parsing.test.ts` pins the behaviour, so a future version
 * that re-enables the parser fails in CI rather than silently in production.
 *
 * Known, accepted consequence: this is app-wide, so Skybridge's own dev routes lose the
 * parser too. Exactly one of them reads a body — `POST /__skybridge/deploy/project` in
 * `@skybridge/devtools`, which mounts no parser of its own, so under `skybridge dev` the
 * devtools "Deploy" button answers 400 "name and teamId are required." That button
 * deploys to Alpic Cloud; this server deploys to Cloud Run, and `NODE_ENV=production` in
 * the Dockerfile means devtools is never mounted there at all. Scoping the inertness with
 * a path predicate would buy back a button we do not use, at the cost of reintroducing
 * the exact predicate-vs-routing mismatch described below.
 *
 * Replaces the 1.x approach, which located the `jsonParser` layer inside
 * `app._router.stack` and swapped its handler in place. That worked, but it depended on
 * an internal shape and on path predicates of our own that had to agree with Express's
 * routing — a disagreement there had already reopened a gzip-amplification path once,
 * because Express routes case-insensitively and the predicates did not. With the parser
 * inert there are no predicates to disagree.
 */
export const INERT_APP_JSON: JsonOptions = { type: () => false };
