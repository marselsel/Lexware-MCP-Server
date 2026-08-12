import express, { type Request, type Response } from "express";
import { mcpAuthMetadataRouter, McpServer, requireBearerAuth } from "skybridge/server";
import { bearerAuthMiddleware } from "./auth.js";
import { ConfigError, describeCapabilities, loadConfig } from "./config.js";
import { LexwareClient } from "./lexware/client.js";
import { advertisedScopes, buildOAuthMetadata, createAccessTokenVerifier } from "./oauth.js";
import { registerTools } from "./tools/index.js";
import { deferBodyParsingFor, isMcpPath, isUploadPath } from "./server-body-parsing.js";
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

const server = new McpServer(
  {
    name: "lexware-office",
    version: "0.1.11",
  },
  { capabilities: {} },
);

// Defer /mcp bodies from the pre-applied ~100 KB global parser (they get the raised
// limit post-auth, below). Also defer /upload bodies — those are read raw by
// registerUploadRoutes' own express.raw(); letting the global JSON parser touch them
// first silently turned a JSON-content-typed upload into an empty file (see
// server-body-parsing.ts and routes.ts for the full story). Other routes keep the
// small limit.
const bodyParsingConfigured = deferBodyParsingFor(server.express, (p) => isMcpPath(p) || isUploadPath(p));

// Unauthenticated health check. Use `/status`, not `/healthz`: Google Front End
// intercepts `/healthz` on Cloud Run (it never reaches the container).
server.express.get("/status", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Gate the MCP endpoint according to the configured auth mode.
if (config.auth.mode === "oauth") {
  const oauth = config.auth;
  // Advertise the authorization server so MCP clients can discover and sign in.
  server.use(
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
  server.use(
    "/mcp",
    requireBearerAuth({
      verifier: { verifyAccessToken: createAccessTokenVerifier(oauth) },
      resourceMetadataUrl: `${resUrl.origin}/.well-known/oauth-protected-resource${resPath}`,
    }),
  );
} else if (config.auth.mode === "static") {
  server.use("/mcp", bearerAuthMiddleware(config.auth.token));
}
// mode "none": no gate (operator explicitly opted into unauthenticated).

// Parse /mcp bodies at the raised limit — mounted AFTER the auth gate above, so an
// unauthenticated request is rejected before any multi-MB body is buffered/parsed.
// (Only effective when the global parser was successfully told to defer /mcp.)
if (bodyParsingConfigured) {
  server.use("/mcp", express.json({ limit: JSON_BODY_LIMIT }));
}

// Ticket-gated upload path: bytes go browser/curl -> server -> Lexware, never
// through the model context. Shared store so the MCP tools can issue and read
// tickets that these routes consume.
//
// NOTE: `server` (McpServer) has no get/post/use-as-router surface of its own —
// only a `use()` for middleware. The real Express app lives at `server.express`
// (see node_modules/skybridge/dist/server/server.d.ts: "readonly express: Express"
// with the doc example `server.express.get(...)`), which is also what's already
// used above for /status. A cast of `server` itself to `express.Express` would
// type-check (via `as unknown as`) but fail at runtime — McpServer has no `get`/
// `post` methods to call.
export const uploadTickets = new TicketStore();
// The ticket-gated upload routes are a drafts-tier WRITE path (they push a file into the
// Lexware file store), so mount them only when the drafts capability is enabled. Without
// this, a read-only deployment (LEXWARE_READ_ONLY, or drafts explicitly off) would still
// expose the unauthenticated POST /upload/:ticket route wired to Lexware's write API —
// unreachable, since no ticket can be issued without the drafts-only create-upload-ticket
// tool, but a write route has no business existing on a server configured not to write.
if (config.capabilities.drafts) {
  registerUploadRoutes(server.express, uploadTickets, async ({ bytes, filename, contentType, type }) =>
    client.postMultipart<{ id: string }>("/v1/files", { bytes, filename, contentType }, { type }),
  );
}

// publicBaseUrl is resolved in config.ts from OAUTH_RESOURCE/SERVER_URL, independently
// of the auth mode — deriving it here from `config.auth` handed a static-token
// deployment behind a real domain upload links pointing at its own loopback.
registerTools(server, client, config, uploadTickets, config.publicBaseUrl);

console.error(
  `[lexware-mcp] starting — ${describeCapabilities(config)} bodyLimit=${bodyParsingConfigured ? `${JSON_BODY_LIMIT} (/mcp, post-auth)` : "default(~100kb)"}`,
);
for (const warning of config.warnings) {
  console.error(`[lexware-mcp] WARNING: ${warning}`);
}
if (!bodyParsingConfigured) {
  console.error(
    "[lexware-mcp] WARNING: could not raise the JSON body limit (Skybridge/Express internals changed) — " +
      "uploads over ~100 KB will be rejected. upload-file/upload-voucher-file may fail until this is fixed. " +
      "The /upload/:ticket endpoints are ALSO affected: the global ~100 KB JSON parser stays in front of " +
      "them instead of being skipped, so a ticket-gated upload over ~100 KB fails there too (routes.ts's " +
      "own Buffer.isBuffer guard still prevents a silent empty upload, but the request itself will 400/413).",
  );
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

export default await server.run();

export type AppType = typeof server;
