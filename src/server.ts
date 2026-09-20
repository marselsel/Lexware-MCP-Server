import express, { type Request, type Response } from "express";
import { mcpAuthMetadataRouter, requireBearerAuth, Skybridge } from "skybridge/server";
import { bearerAuthMiddleware } from "./auth.js";
import { ConfigError, describeCapabilities, loadConfig } from "./config.js";
import { LexwareClient } from "./lexware/client.js";
import { advertisedScopes, buildOAuthMetadata, createAccessTokenVerifier } from "./oauth.js";
import { registerTools } from "./tools/index.js";
import { INERT_APP_JSON } from "./server-body-parsing.js";
import { registerUploadRoutes } from "./uploads/routes.js";
import { TicketStore } from "./uploads/tickets.js";

/** Base64 file uploads (upload-file / upload-voucher-file) travel inline in the JSON-RPC body. */
const JSON_BODY_LIMIT = "12mb";

// Fail fast with a clear, secret-free message on any misconfiguration.
let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Skybridge's `run()` binds `process.env.__PORT` (default 3000). When running the
// built server directly (`node dist/server.js`) there's no `skybridge start` to
// bridge ports, so make our validated `config.port` (which reads `PORT`, default
// 8080) authoritative. `skybridge dev` sets `__PORT` itself, so only set it when
// it isn't already provided.
if (!process.env.__PORT) {
  process.env.__PORT = String(config.port);
}

const client = new LexwareClient({
  baseUrl: config.lexwareApiBaseUrl,
  apiKey: config.lexwareApiKey,
  debug: config.debugLogging,
});

// Ticket-gated upload path: bytes go browser/curl -> server -> Lexware, never through
// the model context. Shared store so the MCP tools can issue and read tickets that the
// upload routes consume.
//
// Module scope, NOT inside the handler: Skybridge runs `handler` on EVERY request. A
// per-request store would mean a ticket issued by one request is unknown to the request
// that redeems it, so every upload would fail. The same goes for `client` above — it
// holds the token-bucket rate limiter, and one bucket per request is no limiter at all
// (which is also why the deployment runs --max-instances=1).
export const uploadTickets = new TicketStore();

const app = new Skybridge({
  name: "lexware-office",
  version: "0.2.0",
  capabilities: {},
  // Skybridge's own app-level express.json() runs ahead of everything below, including
  // the auth gate. Kept inert; this file mounts what it needs, where it needs it.
  // See server-body-parsing.ts for why that ordering is load-bearing.
  json: INERT_APP_JSON,
  // Per request, and must be synchronous — so it does registration and nothing else.
  //
  // It costs ~23ms of blocking CPU per request (53 tools at the read+drafts tier), which
  // is most of the server's own time. Measured over HTTP against the built image:
  //
  //   /status        2.1ms      <- no registration
  //   initialize    29.5ms      <- pays for all 53 tool schemas and uses none of them
  //   tools/list    41.3ms
  //
  // Do NOT take Skybridge's own boot warning ("The Skybridge handler took 68ms — it runs
  // on every request") as the recurring figure. It prints once, from the cold first build
  // during `ready()`, so it carries the JIT warm-up: steady state is ~2.5x cheaper than
  // that line suggests. Cheaper, and still the dominant cost of a request.
  //
  // Where it goes, measured by running the real registerTools twice against a server whose
  // registerTool drops `inputSchema` in one pass and keeps it in the other:
  //
  //   registration, as it runs today            22.9ms
  //   the same, minus the SDK's zod -> JSON     4.7ms   <- all the rest is ours
  //   Schema conversion
  //
  // So ~79% is `_createRegisteredTool` calling `standardSchemaToJsonSchema` on every
  // registration, and that part cannot be hoisted away from here:
  //
  //   - zod does NOT memoize `~standard.jsonSchema.input()`. Converting ONE hoisted
  //     instance 300 times costs a median 0.84ms every time and returns a fresh object on
  //     each call; a per-registration `z.object(shape)` costs 1.03ms. Hoisting buys 18%,
  //     not the ~100% a memo would.
  //   - skybridge's `registerTool` constrains its input to `Record<string,
  //     StandardSchemaWithJSON>` — a raw field shape. A pre-built schema carrying a cached
  //     JSON Schema is a compile error ("Index signature for type 'string' is missing"),
  //     and forcing it through types every handler argument `unknown`.
  //   - the server genuinely has to be per-request, so `setup` cannot hold a warmed-up
  //     one: skybridge builds a fresh instance deliberately, because sharing one would
  //     pin concurrent callers to a single negotiated protocol version.
  //
  // The remaining 4.7ms is ours and is hoistable, at the price of lifting every
  // `inputSchema` literal in src/tools/ to module scope. Not taken: a fifth of a cost
  // whose other four fifths are upstream.
  //
  // Registration still fails at BOOT, not per request, even though it lives here now:
  // `run()` awaits `ready()`, which builds one sample server (it needs the per-tool
  // security schemes to wire OAuth) before the port is bound. So a duplicate tool name or
  // a schema the SDK refuses to convert aborts module evaluation exactly as it did when
  // this ran at module scope, instead of leaving a revision that answers /status with 200
  // and every /mcp call with a 500. That ordering is undocumented, so a test pins it:
  // tests/server-boot-registration.test.ts.
  handler: (server) => {
    registerTools(server, client, config, uploadTickets);
    return server;
  },
});

// Everything below is registered BEFORE app.run(). Skybridge appends its own /assets,
// /mcp and error middleware inside run(), so anything added afterwards would land behind
// the default error handler.

// Unauthenticated health check. Use `/status`, not `/healthz`: Google Front End
// intercepts `/healthz` on Cloud Run (it never reaches the container).
app.express.get("/status", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Gate the MCP endpoint according to the configured auth mode.
if (config.auth.mode === "oauth") {
  const oauth = config.auth;
  // Advertise the authorization server so MCP clients can discover and sign in.
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: buildOAuthMetadata(oauth),
      resourceServerUrl: new URL(oauth.resource),
      // Undefined unless OAUTH_SCOPES_SUPPORTED is set, which keeps `scopes_supported`
      // out of the protected-resource document exactly as before (see advertisedScopes).
      scopesSupported: advertisedScopes(oauth),
    }),
  );
  // RFC 9728: the protected-resource metadata path is the well-known segment
  // followed by the resource's path (so a path-bearing resource resolves correctly).
  const resUrl = new URL(oauth.resource);
  const resPath = resUrl.pathname === "/" ? "" : resUrl.pathname.replace(/\/$/, "");
  app.use(
    "/mcp",
    requireBearerAuth({
      verifier: { verifyAccessToken: createAccessTokenVerifier(oauth) },
      resourceMetadataUrl: `${resUrl.origin}/.well-known/oauth-protected-resource${resPath}`,
    }),
  );
} else if (config.auth.mode === "static") {
  app.use("/mcp", bearerAuthMiddleware(config.auth.token));
}
// mode "none": no gate (operator explicitly opted into unauthenticated).

// Parse /mcp bodies at the raised limit — mounted AFTER the auth gate above, so an
// unauthenticated request is rejected before any multi-MB body is buffered or parsed.
// Not optional: Skybridge's /mcp handler is called with `req.body`, so with the app-level
// parser inert this mount is what produces it.
app.use("/mcp", express.json({ limit: JSON_BODY_LIMIT }));

// The ticket-gated upload routes are a drafts-tier WRITE path (they push a file into the
// Lexware file store), so mount them only when the drafts capability is enabled. Without
// this, a read-only deployment (LEXWARE_READ_ONLY, or drafts explicitly off) would still
// expose the unauthenticated POST /upload/:ticket route wired to Lexware's write API —
// unreachable, since no ticket can be issued without the drafts-only create-upload-ticket
// tool, but a write route has no business existing on a server configured not to write.
//
// They read the body themselves with express.raw(); with the app-level parser inert,
// that raw parser is the first thing to touch an upload body.
if (config.capabilities.drafts) {
  registerUploadRoutes(app.express, uploadTickets, async ({ bytes, filename, contentType, type }) =>
    client.postMultipart<{ id: string }>("/v1/files", { bytes, filename, contentType }, { type }),
  );
}

console.error(
  `[lexware-mcp] starting — ${describeCapabilities(config)} bodyLimit=${JSON_BODY_LIMIT} (/mcp, post-auth)`,
);
for (const warning of config.warnings) {
  console.error(`[lexware-mcp] WARNING: ${warning}`);
}
if (config.auth.mode === "oauth" && config.auth.allowedEmailDomains.length === 0) {
  console.error(
    "[lexware-mcp] WARNING: OAuth mode with no OAUTH_ALLOWED_EMAIL_DOMAINS — ANY user who can " +
      "authenticate with your issuer can reach this server. Set OAUTH_ALLOWED_EMAIL_DOMAINS to restrict access.",
  );
}
if (config.auth.mode === "none") {
  console.error(
    "[lexware-mcp] WARNING: /mcp is UNAUTHENTICATED (MCP_ALLOW_UNAUTHENTICATED=true). Anyone who can reach " +
      "this port can use every enabled tool. Bind to localhost / a private network only, and prefer a browser " +
      "that blocks DNS-rebinding; configure OAUTH_ISSUER or MCP_AUTH_TOKEN for any shared or public deployment.",
  );
}

export default await app.run();

// No `AppType` export. Skybridge's contract is that the handler returns the CHAINED
// server, so `typeof app` carries the registered tool types for `createClient<AppType>()`
// and for views. This server cannot honour it: `registerTools` returns void, and even
// threading the chain through would not help, because the tools are registered in loops
// over runtime arrays behind capability-tier `if`s — the set is not statically known, by
// design. So `typeof app` would infer `Record<never, ToolDef>` and quietly hand any
// future consumer an empty tool surface. Better to have no type than a type that lies;
// there are no views and no generated client here to want one.
