/**
 * Configuration for the Lexware MCP server.
 *
 * Parsed and validated once at startup from environment variables. Kept free of
 * any Skybridge/Express imports so it can be unit-tested in isolation.
 */

/** Minimum length for `MCP_AUTH_TOKEN`. A 32-hex-char token is 32 chars. */
export const MIN_TOKEN_LENGTH = 16;

/** Thrown when the environment is misconfigured. Message is safe to print. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Which tiers of tools should be registered, after applying READ_ONLY. */
export interface Capabilities {
  /** Read tools are always available. */
  read: true;
  /** Create-draft tools (invoices/quotations/contacts). */
  drafts: boolean;
  /** Finalize / legally-binding write tools. */
  finalize: boolean;
}

/**
 * How `/mcp` is protected. Three modes, resolved in this precedence:
 * OAuth (if `OAUTH_ISSUER` set) → static bearer (if `MCP_AUTH_TOKEN` set) →
 * none (only if `MCP_ALLOW_UNAUTHENTICATED=true`). Otherwise startup fails closed.
 */
export type AuthConfig =
  | {
      mode: "oauth";
      /** Authorization server issuer (e.g. the WorkOS AuthKit domain URL). */
      issuer: string;
      /** JWKS endpoint used to verify access-token signatures. */
      jwksUrl: string;
      /** Expected `aud` claim / Resource Indicator — this server's public URL. */
      resource: string;
      /** Verify the token `aud` matches `resource`. Disable if the provider has no Resource Indicator configured. */
      verifyAudience: boolean;
      /**
       * Additional accepted `aud` values, beyond the ones derived from `resource`.
       * Needed for IdPs that do not honour the Resource Indicator: Microsoft Entra
       * always puts the API's client ID (a GUID) in `aud` of a v2.0 token, never the
       * Application ID URI. Without this the audience check can never match, and every
       * token is rejected with 401. Keeps `verifyAudience` on — the GUID is unique to
       * this app, so a token minted for a different app on the same tenant is still
       * rejected. Comma-separated via OAUTH_AUDIENCE.
       */
      extraAudiences: string[];
      /**
       * Scopes advertised in the protected-resource metadata (RFC 9728
       * `scopes_supported`), so a client knows what to request. Empty means "advertise
       * nothing", which leaves the document exactly as it was before this option existed.
       * Needed for IdPs that reject an authorization request without a `scope` parameter
       * (Microsoft Entra: AADSTS900144). Comma-separated via OAUTH_SCOPES_SUPPORTED.
       */
      scopesSupported: string[];
      /** If non-empty, the user's email domain must be one of these (hard backstop). */
      allowedEmailDomains: string[];
      /** OIDC userinfo endpoint, used to fetch email when it isn't a token claim. */
      userinfoUrl: string;
      /** Authorization endpoint advertised in AS metadata (overridable for non-WorkOS IdPs). */
      authorizationEndpoint: string;
      /** Token endpoint advertised in AS metadata (overridable for non-WorkOS IdPs). */
      tokenEndpoint: string;
      /**
       * Dynamic client registration endpoint advertised in AS metadata, or `undefined`
       * to advertise none. Set `OAUTH_REGISTRATION_ENDPOINT=none` when the issuer does
       * not support DCR: advertising an endpoint that rejects every request is worse
       * than omitting the (optional, per RFC 8414) field, because a client will attempt
       * registration and fail instead of falling back to a pre-registered client.
       */
      registrationEndpoint: string | undefined;
    }
  | { mode: "static"; token: string }
  | { mode: "none" };

export interface Config {
  lexwareApiKey: string;
  /** Base URL without a trailing slash, e.g. `https://api.lexware.io`. */
  lexwareApiBaseUrl: string;
  /** Web-app base for building document deeplinks, e.g. `https://app.lexware.de`. */
  lexwareAppBaseUrl: string;
  auth: AuthConfig;
  /**
   * This server's public base URL, used to build the `/upload/:ticket` links that
   * `create-upload-ticket` hands to a browser and bakes into its curl command.
   *
   * Deliberately NOT part of {@link AuthConfig}: where this server is reachable is a
   * deployment fact, not an auth one. Deriving it from the auth mode — OAuth resource
   * or else loopback — meant a static-token deployment behind a real domain (a
   * supported mode, see README) handed out `http://127.0.0.1:8080/upload/…`, a link
   * that resolves nowhere but inside the container.
   */
  publicBaseUrl: string;
  port: number;
  debugLogging: boolean;
  capabilities: Capabilities;
  /** Non-fatal configuration notices to log at startup (e.g. a flag that was overridden). */
  warnings: string[];
}

const DEFAULT_BASE_URL = "https://api.lexware.io";
const DEFAULT_APP_BASE_URL = "https://app.lexware.de";
const DEFAULT_PORT = 8080;

/** Parse a boolean env value. Accepts true/1/yes/on (case-insensitive). */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new ConfigError(`Invalid boolean value "${raw}" (expected true/false).`);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`Invalid PORT "${raw}" (expected an integer 1-65535).`);
  }
  return n;
}

/**
 * Require HTTPS for configured URLs (OAuth issuer/JWKS/userinfo/resource, API/app bases), allowing
 * plain http only for loopback so local mocks/testing still work. HTTPS matters most for the
 * JWKS fetch — over http a network attacker could serve forged signing keys and bypass auth.
 */
function isAllowedUrlProtocol(url: URL): boolean {
  if (url.protocol === "https:") return true;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  return url.protocol === "http:" && loopback;
}

function normalizeUrl(raw: string | undefined, fallback: string, varName: string): string {
  const value = raw?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`Invalid ${varName} "${value}".`);
  }
  if (!isAllowedUrlProtocol(url)) {
    throw new ConfigError(`${varName} must be https:// (http:// is allowed only for localhost): "${value}".`);
  }
  // Strip a trailing slash so callers can join with `/v1/...`.
  return url.toString().replace(/\/+$/, "");
}

/**
 * Validate an OAuth issuer URL **without** altering it. The `iss` claim must
 * match byte-for-byte, and some providers' canonical issuers end in `/` (Auth0)
 * while others don't (WorkOS) — so we preserve the operator's exact string
 * rather than round-tripping through `URL` (which would add/strip a slash).
 */
function validateIssuerUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`Invalid OAUTH_ISSUER "${value}".`);
  }
  if (!isAllowedUrlProtocol(url)) {
    throw new ConfigError(`OAUTH_ISSUER must be https:// (http:// is allowed only for localhost): "${value}".`);
  }
  return value;
}

/**
 * Resolve this server's public base URL — in EVERY auth mode, not just OAuth.
 *
 * `OAUTH_RESOURCE` first, so an OAuth deployment can never drift from the value its
 * token audience is built from; then `SERVER_URL`, which the README already documents
 * as "this server's public URL" and which was previously read only inside the OAuth
 * branch (a static-token or unauthenticated deployment set it and it was ignored).
 * Only with neither set does the loopback fallback apply: correct for a local run,
 * and honest about being unusable anywhere else.
 *
 * Validated through {@link normalizeUrl} like every other configured URL, so a typo
 * or a plain-http public URL fails at startup rather than being pasted into a curl
 * command an operator then runs.
 */
function resolvePublicBaseUrl(env: NodeJS.ProcessEnv, port: number): string {
  const resource = env.OAUTH_RESOURCE?.trim();
  if (resource) return normalizeUrl(resource, resource, "OAUTH_RESOURCE");
  const serverUrl = env.SERVER_URL?.trim();
  if (serverUrl) return normalizeUrl(serverUrl, serverUrl, "SERVER_URL");
  return `http://127.0.0.1:${port}`;
}

/** Resolve how `/mcp` is authenticated, failing closed if nothing is configured. */
function resolveAuth(env: NodeJS.ProcessEnv): AuthConfig {
  const issuerRaw = env.OAUTH_ISSUER?.trim();
  const token = env.MCP_AUTH_TOKEN?.trim() || undefined;

  // 1) OAuth takes precedence when an issuer is configured.
  if (issuerRaw) {
    const issuer = validateIssuerUrl(issuerRaw);
    // Join derived endpoints onto a slash-free base so a trailing-slash issuer
    // (e.g. Auth0) doesn't produce `//oauth2/...`.
    const issuerBase = issuer.replace(/\/+$/, "");
    const resourceRaw = env.OAUTH_RESOURCE?.trim() || env.SERVER_URL?.trim();
    if (!resourceRaw) {
      throw new ConfigError(
        "OAUTH_RESOURCE (or SERVER_URL) is required in OAuth mode — set it to this server's public URL (the token audience / Resource Indicator).",
      );
    }
    const resource = normalizeUrl(resourceRaw, resourceRaw, "OAUTH_RESOURCE");
    const allowedEmailDomains = (env.OAUTH_ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const userinfoUrl = normalizeUrl(
      env.OAUTH_USERINFO_URL,
      `${issuerBase}/oauth2/userinfo`,
      "OAUTH_USERINFO_URL",
    );
    const jwksUrl = normalizeUrl(env.OAUTH_JWKS_URL, `${issuerBase}/oauth2/jwks`, "OAUTH_JWKS_URL");
    const verifyAudience = parseBool(env.OAUTH_VERIFY_AUDIENCE, true);
    // Not run through normalizeUrl: Entra audiences are bare GUIDs, not URLs.
    const extraAudiences = (env.OAUTH_AUDIENCE ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    // Not run through normalizeUrl: scopes are opaque strings, and IdPs use both bare
    // names ("openid") and URI-shaped ones ("api://<client-id>/mcp.access").
    // Split on commas AND whitespace: a scope value can never contain a space
    // (RFC 6749 §3.3), so `openid email` — the form scopes appear in everywhere else
    // in OAuth — is unambiguous and must not become one bogus scope named "openid email".
    const scopesSupported = (env.OAUTH_SCOPES_SUPPORTED ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Endpoints default to the WorkOS-AuthKit layout but are overridable so other
    // IdPs (Auth0: /authorize + /oauth/token; Keycloak; Clerk) advertise correctly
    // in the /.well-known/oauth-authorization-server metadata.
    const authorizationEndpoint = normalizeUrl(
      env.OAUTH_AUTHORIZATION_ENDPOINT,
      `${issuerBase}/oauth2/authorize`,
      "OAUTH_AUTHORIZATION_ENDPOINT",
    );
    const tokenEndpoint = normalizeUrl(
      env.OAUTH_TOKEN_ENDPOINT,
      `${issuerBase}/oauth2/token`,
      "OAUTH_TOKEN_ENDPOINT",
    );
    // `none` opts out of advertising DCR entirely. Checked before normalizeUrl, which
    // would reject it as an invalid URL. Any other value (or unset) keeps the derived
    // default, so existing deployments are unaffected.
    const registrationRaw = env.OAUTH_REGISTRATION_ENDPOINT?.trim();
    const registrationEndpoint =
      registrationRaw?.toLowerCase() === "none"
        ? undefined
        : normalizeUrl(
            env.OAUTH_REGISTRATION_ENDPOINT,
            `${issuerBase}/oauth2/register`,
            "OAUTH_REGISTRATION_ENDPOINT",
          );
    return {
      mode: "oauth",
      issuer,
      jwksUrl,
      resource,
      verifyAudience,
      extraAudiences,
      scopesSupported,
      allowedEmailDomains,
      userinfoUrl,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
    };
  }

  // 2) Static bearer token.
  if (token) {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError(
        `MCP_AUTH_TOKEN is too weak (min ${MIN_TOKEN_LENGTH} chars). Generate one with \`openssl rand -hex 32\`.`,
      );
    }
    return { mode: "static", token };
  }

  // 3) Explicitly unauthenticated, or fail closed. (Parsed here, not earlier, so a
  // malformed value can't abort startup when OAuth/static auth is configured.)
  if (parseBool(env.MCP_ALLOW_UNAUTHENTICATED, false)) {
    return { mode: "none" };
  }
  throw new ConfigError(
    "No auth configured for /mcp. Set OAUTH_ISSUER (OAuth) or MCP_AUTH_TOKEN (static bearer, " +
      "e.g. `openssl rand -hex 32`), or set MCP_ALLOW_UNAUTHENTICATED=true to run without auth (NOT recommended).",
  );
}

/**
 * Load and validate configuration. Throws {@link ConfigError} on any problem so
 * the process can exit with a clear, secret-free message.
 *
 * @param env - environment source (defaults to `process.env`); injectable for tests.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const lexwareApiKey = env.LEXWARE_API_KEY?.trim();
  if (!lexwareApiKey) {
    throw new ConfigError(
      "LEXWARE_API_KEY is required. Create one at https://app.lexware.de/addons/public-api",
    );
  }

  const auth = resolveAuth(env);
  const port = parsePort(env.PORT);

  const readOnly = parseBool(env.LEXWARE_READ_ONLY, false);
  // READ_ONLY is a hard override: it wins over the individual enable flags.
  const enableFinalize = readOnly ? false : parseBool(env.LEXWARE_ENABLE_FINALIZE, false);
  // Finalize implies drafts: the finalize tier issues legally-binding versions of
  // draft documents, so enabling it without drafts would expose ONLY the
  // irreversible create-finalized-* tools (no safe draft path). Never allow that.
  const draftsRequested = parseBool(env.LEXWARE_ENABLE_DRAFTS, true);
  const enableDrafts = readOnly ? false : draftsRequested || enableFinalize;

  const warnings: string[] = [];
  if (!readOnly && !draftsRequested && enableFinalize) {
    warnings.push(
      "LEXWARE_ENABLE_DRAFTS=false was overridden to true because LEXWARE_ENABLE_FINALIZE=true — the " +
        "finalize tier issues binding versions of draft documents and cannot run without the drafts tier.",
    );
  }

  return {
    lexwareApiKey,
    lexwareApiBaseUrl: normalizeUrl(env.LEXWARE_API_BASE_URL, DEFAULT_BASE_URL, "LEXWARE_API_BASE_URL"),
    lexwareAppBaseUrl: normalizeUrl(
      env.LEXWARE_APP_BASE_URL,
      DEFAULT_APP_BASE_URL,
      "LEXWARE_APP_BASE_URL",
    ),
    auth,
    publicBaseUrl: resolvePublicBaseUrl(env, port),
    port,
    debugLogging: parseBool(env.LEXWARE_DEBUG_LOGGING, false),
    capabilities: { read: true, drafts: enableDrafts, finalize: enableFinalize },
    warnings,
  };
}

/** One-line, secret-free summary of effective capabilities for startup logging. */
export function describeCapabilities(config: Config): string {
  const tiers = ["read"];
  if (config.capabilities.drafts) tiers.push("drafts");
  if (config.capabilities.finalize) tiers.push("finalize");
  const auth =
    config.auth.mode === "oauth"
      ? "oauth"
      : config.auth.mode === "static"
        ? "token-protected"
        : "UNAUTHENTICATED";
  return `tiers=[${tiers.join(", ")}] auth=${auth} base=${config.lexwareApiBaseUrl}`;
}
