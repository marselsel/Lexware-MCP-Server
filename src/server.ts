import express, { type Request, type Response } from "express";
import { mcpAuthMetadataRouter, McpServer, requireBearerAuth } from "skybridge/server";
import { bearerAuthMiddleware } from "./auth.js";
import { ConfigError, describeCapabilities, loadConfig } from "./config.js";
import { LexwareClient } from "./lexware/client.js";
import { advertisedScopes, buildOAuthMetadata, createAccessTokenVerifier } from "./oauth.js";
import { registerTools } from "./tools/index.js";

/** Base64 file uploads (upload-file / upload-voucher-file) travel inline in the JSON-RPC body. */
const JSON_BODY_LIMIT = "12mb";
const isMcpPath = (p: string): boolean => p === "/mcp" || p.startsWith("/mcp/");

/**
 * Reconfigure body parsing so large uploads work WITHOUT widening the pre-auth
 * attack surface. Skybridge pre-applies a single global `express.json()` (~100 KB
 * default) at router-stack index 0 — before the /mcp auth middleware. We swap that
 * layer's handler, in place, so it keeps the ~100 KB limit for non-/mcp routes (e.g.
 * /status) but DEFERS /mcp bodies to a {@link JSON_BODY_LIMIT} parser mounted AFTER
 * the auth gate (see below). Net effect: an unauthenticated request can never trigger
 * a multi-MB parse, and authenticated uploads still get the raised limit.
 *
 * In-place handler swap (no stack reordering) so it can't mis-order routes. Guarded:
 * returns false if the internal layer can't be located, and the caller warns loudly.
 */
function deferMcpBodyParsing(app: express.Express): boolean {
  try {
    type Layer = { handle?: express.RequestHandler & { name?: string } };
    const router =
      (app as unknown as { router?: { stack: Layer[] }; _router?: { stack: Layer[] } }).router ??
      (app as unknown as { _router?: { stack: Layer[] } })._router;
    const stack = router?.stack;
    if (!Array.isArray(stack)) return false;
    const layer = stack.find((l) => l?.handle?.name === "jsonParser");
    if (!layer) return false;
    const smallJson = express.json(); // ~100 KB default — for /status and other non-/mcp routes
    layer.handle = (req, res, next) => (isMcpPath(req.path) ? next() : smallJson(req, res, next));
    return true;
  } catch {
    return false;
  }
}

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
    version: "0.1.9",
  },
  { capabilities: {} },
);

// Defer /mcp bodies from the pre-applied ~100 KB global parser (they get the raised
// limit post-auth, below); other routes keep the small limit.
const bodyParsingConfigured = deferMcpBodyParsing(server.express);

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

registerTools(server, client, config);

console.error(
  `[lexware-mcp] starting — ${describeCapabilities(config)} bodyLimit=${bodyParsingConfigured ? `${JSON_BODY_LIMIT} (/mcp, post-auth)` : "default(~100kb)"}`,
);
for (const warning of config.warnings) {
  console.error(`[lexware-mcp] WARNING: ${warning}`);
}
if (!bodyParsingConfigured) {
  console.error(
    "[lexware-mcp] WARNING: could not raise the JSON body limit (Skybridge/Express internals changed) — " +
      "uploads over ~100 KB will be rejected. upload-file/upload-voucher-file may fail until this is fixed.",
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
