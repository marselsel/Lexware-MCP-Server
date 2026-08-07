import { InsufficientScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createHash } from "node:crypto";
import * as jose from "jose";

/** Upper bound on the userinfo email cache to prevent unbounded growth. */
const MAX_EMAIL_CACHE_ENTRIES = 5000;

/** The OAuth slice of {@link import("./config.js").AuthConfig} (mode === "oauth"). */
export interface OAuthSettings {
  issuer: string;
  jwksUrl: string;
  resource: string;
  verifyAudience: boolean;
  /** Extra accepted `aud` values (see AuthConfig.extraAudiences). */
  extraAudiences?: string[];
  /** Scopes to advertise in the protected-resource metadata (see AuthConfig.scopesSupported). */
  scopesSupported?: string[];
  allowedEmailDomains: string[];
  userinfoUrl: string;
  /** Authorization endpoint advertised in AS metadata. Defaults to `${issuer}/oauth2/authorize`. */
  authorizationEndpoint: string;
  /** Token endpoint advertised in AS metadata. Defaults to `${issuer}/oauth2/token`. */
  tokenEndpoint: string;
  /**
   * Dynamic client registration endpoint advertised in AS metadata. Defaults to
   * `${issuer}/oauth2/register`; `undefined` omits the field (see AuthConfig).
   */
  registrationEndpoint?: string;
  /** Endpoints pinned via env; these beat discovery (see AuthConfig). */
  explicitEndpoints?: {
    authorization: boolean;
    token: boolean;
    registration: boolean;
    jwks: boolean;
  };
}

/** True when `email`'s domain is in `allowed` (case-insensitive). Pure; unit-tested. */
export function isEmailDomainAllowed(email: string | undefined, allowed: string[]): boolean {
  if (!email) return false;
  // Split on the LAST "@" so an address like `a@allowed.com@evil.com` resolves to
  // `evil.com`, not the attacker-chosen middle segment `split("@")[1]` would return.
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return false;
  return allowed.map((d) => d.toLowerCase()).includes(domain);
}

/**
 * Scopes advertised when `OAUTH_SCOPES_SUPPORTED` is unset. Historic default, kept so
 * an existing deployment's authorization-server metadata is unchanged.
 */
const DEFAULT_ADVERTISED_SCOPES = ["openid", "email", "profile"];

/** Bound the discovery fetch so an unreachable issuer can't stall startup. */
const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Candidate well-known URLs for an issuer's authorization-server metadata, in
 * preference order. Providers disagree on the layout, so try each:
 *
 * 1. RFC 8414 — well-known segment inserted *before* the issuer path.
 * 2. OIDC Discovery — well-known segment *appended* (what Entra and Auth0 serve).
 * 3. RFC 8414 spelling of the OIDC document, for providers that only publish that.
 *
 * For a path-less issuer (1) and (3) collapse to the same URL; the duplicate is
 * harmless because the first hit wins.
 */
export function discoveryUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const base = u.origin;
  return [
    `${base}/.well-known/oauth-authorization-server${path}`,
    `${base}${path}/.well-known/openid-configuration`,
    `${base}/.well-known/openid-configuration${path}`,
  ];
}

/**
 * Fetch the issuer's real authorization-server metadata.
 *
 * Returns `undefined` on any failure — unreachable issuer, non-JSON body, timeout,
 * or an `issuer` claim that doesn't match. The caller then keeps the derived
 * defaults, so discovery can only ever *improve* the advertised document, never
 * prevent startup.
 *
 * The issuer check is a security control, not a sanity check: this document decides
 * where clients send users to authenticate, so a document claiming to speak for a
 * different issuer must be discarded rather than merged.
 */
export async function discoverAuthorizationServerMetadata(
  issuer: string,
  deps: VerifierDeps = {},
): Promise<Partial<OAuthMetadata> | undefined> {
  const fetchFn = deps.fetchFn ?? fetch;
  for (const url of discoveryUrls(issuer)) {
    try {
      const res = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const doc = (await res.json()) as Partial<OAuthMetadata>;
      // Trailing-slash-insensitive: some providers' canonical issuer ends in "/".
      const norm = (s: string) => s.replace(/\/+$/, "");
      if (typeof doc.issuer !== "string" || norm(doc.issuer) !== norm(issuer)) continue;
      return doc;
    } catch {
      // Try the next layout; a total failure just means we keep the defaults.
    }
  }
  return undefined;
}

/**
 * Authorization-server metadata advertised at `/.well-known/oauth-authorization-server`
 * (a convenience proxy; modern clients discover the AS via the protected-resource doc).
 *
 * Precedence for every field: an explicit env override wins, then whatever the issuer's
 * own document says, then the derived WorkOS-layout default. Overrides beat discovery
 * because they exist precisely to correct a document that is wrong or absent.
 */
export function buildOAuthMetadata(
  oauth: OAuthSettings,
  discovered?: Partial<OAuthMetadata>,
): OAuthMetadata {
  const ex = oauth.explicitEndpoints;
  const pick = <K extends keyof OAuthMetadata>(
    explicit: boolean,
    ours: OAuthMetadata[K],
    key: K,
  ): OAuthMetadata[K] => (explicit ? ours : ((discovered?.[key] ?? ours) as OAuthMetadata[K]));

  // `issuer` is never taken from the document — it is the operator's configured value
  // and must match the `iss` claim byte-for-byte.
  const registration = ex?.registration
    ? oauth.registrationEndpoint
    : (discovered?.registration_endpoint ?? oauth.registrationEndpoint);

  return {
    issuer: oauth.issuer,
    authorization_endpoint: pick(
      Boolean(ex?.authorization),
      oauth.authorizationEndpoint,
      "authorization_endpoint",
    ),
    token_endpoint: pick(Boolean(ex?.token), oauth.tokenEndpoint, "token_endpoint"),
    // Omitted entirely when neither configured nor discovered: `registration_endpoint`
    // is optional in RFC 8414, and advertising one the issuer will reject is worse than
    // saying nothing.
    ...(registration ? { registration_endpoint: registration } : {}),
    jwks_uri: pick(Boolean(ex?.jwks), oauth.jwksUrl, "jwks_uri"),
    response_types_supported: discovered?.response_types_supported ?? ["code"],
    grant_types_supported: discovered?.grant_types_supported ?? [
      "authorization_code",
      "refresh_token",
    ],
    code_challenge_methods_supported: discovered?.code_challenge_methods_supported ?? ["S256"],
    // OAUTH_SCOPES_SUPPORTED wins so this document and the protected-resource document
    // can't contradict each other; then the issuer's real list; then the historic default.
    scopes_supported:
      advertisedScopes(oauth) ?? discovered?.scopes_supported ?? DEFAULT_ADVERTISED_SCOPES,
  };
}

/**
 * Scopes to advertise as `scopes_supported` in the protected-resource metadata
 * (RFC 9728), or `undefined` when none are configured.
 *
 * `undefined` rather than `[]` is deliberate: `mcpAuthMetadataRouter` copies the value
 * straight into the metadata object, and `JSON.stringify` drops an undefined property —
 * so with nothing configured the document is byte-for-byte what it was before this
 * option existed. An empty array would instead advertise `"scopes_supported": []`,
 * which is a different (and misleading) statement.
 *
 * Why advertise at all: without `scopes_supported` a client has no way to know what to
 * ask for and may omit `scope` from the authorization request entirely, which some IdPs
 * reject outright (Microsoft Entra: `AADSTS900144: The request body must contain the
 * following parameter: 'scope'`).
 */
export function advertisedScopes(oauth: OAuthSettings): string[] | undefined {
  return oauth.scopesSupported?.length ? oauth.scopesSupported : undefined;
}

/** Network timeout for the userinfo lookup so a hung IdP can't block a request indefinitely. */
const USERINFO_TIMEOUT_MS = 10_000;

/**
 * OIDC `email_verified` is a boolean; some providers serialize it as the string
 * "true". Treat only an explicit true as verified and fail closed otherwise: an
 * absent or false value must NOT satisfy the email-domain allow-list, or a user who
 * self-asserts an unverified address in an allowed domain could slip through.
 */
export function isEmailVerified(claim: unknown): boolean {
  return claim === true || claim === "true";
}

/**
 * Fetch the user's email from the OIDC userinfo endpoint — but only return it when
 * the provider reports it as verified. Returns undefined on any failure/timeout or
 * when the email is unverified.
 */
async function fetchVerifiedUserinfoEmail(
  token: string,
  userinfoUrl: string,
  fetchFn: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    const email = typeof data.email === "string" ? data.email : undefined;
    if (!email) return undefined;
    return isEmailVerified(data.email_verified) ? email : undefined;
  } catch {
    return undefined;
  }
}

export interface VerifierDeps {
  /** JWKS resolver; injectable for tests. Defaults to a remote JWKS set. */
  jwks?: ReturnType<typeof jose.createRemoteJWKSet>;
  fetchFn?: typeof fetch;
}

/**
 * Build a `verifyAccessToken` for `requireBearerAuth`. It verifies the JWT
 * signature/issuer/audience via JWKS, then — if `allowedEmailDomains` is set —
 * enforces the user's email domain (reading the `email` claim, falling back to
 * the userinfo endpoint), failing closed if the email can't be established.
 */
export function createAccessTokenVerifier(oauth: OAuthSettings, deps: VerifierDeps = {}) {
  const jwks = deps.jwks ?? jose.createRemoteJWKSet(new URL(oauth.jwksUrl));
  const fetchFn = deps.fetchFn ?? fetch;
  // Caches only successful userinfo lookups (token -> email) to avoid re-hitting
  // userinfo on every request. Misses are never cached (see below).
  const emailCache = new Map<string, { email: string; exp: number }>();

  // Accept the audience with or without a trailing slash: the advertised
  // Resource Indicator (`new URL(resource)`) serializes a bare origin with a
  // trailing slash, but `resource` is stored normalized without one.
  const audiences = [
    ...(oauth.resource.endsWith("/")
      ? [oauth.resource, oauth.resource.slice(0, -1)]
      : [oauth.resource, `${oauth.resource}/`]),
    // Entra puts the API's client ID (GUID) in `aud`, never the Application ID URI.
    ...(oauth.extraAudiences ?? []),
  ];

  return async function verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, jwks, {
        issuer: oauth.issuer,
        ...(oauth.verifyAudience ? { audience: audiences } : {}),
      }));
    } catch {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) throw new InvalidTokenError("Token is missing the sub claim");

    // Trust the email for authorization only when the IdP marked it verified; an
    // unverified token email falls through to the (also verification-checked) userinfo lookup.
    let email =
      typeof payload.email === "string" && isEmailVerified(payload.email_verified)
        ? payload.email
        : undefined;

    if (oauth.allowedEmailDomains.length > 0) {
      if (!email) {
        const nowSec = Math.floor(Date.now() / 1000);
        // Key the cache by a hash of the token, not the raw bearer (smaller blast radius).
        const cacheKey = createHash("sha256").update(token).digest("base64url");
        const cached = emailCache.get(cacheKey);
        if (cached && cached.exp > nowSec) {
          email = cached.email;
        } else {
          email = await fetchVerifiedUserinfoEmail(token, oauth.userinfoUrl, fetchFn);
          // Cache only positive (verified) results: caching a transient miss would
          // lock out a valid user until their token expires.
          if (email) {
            const exp = typeof payload.exp === "number" ? payload.exp : nowSec + 300;
            if (emailCache.size >= MAX_EMAIL_CACHE_ENTRIES) {
              // Evict expired entries; if still full, drop everything (it's just a cache).
              for (const [k, v] of emailCache) if (v.exp <= nowSec) emailCache.delete(k);
              if (emailCache.size >= MAX_EMAIL_CACHE_ENTRIES) emailCache.clear();
            }
            emailCache.set(cacheKey, { email, exp });
          }
        }
      }
      if (!isEmailDomainAllowed(email, oauth.allowedEmailDomains)) {
        // 403, not 401: the token is valid, the user is simply not authorized. A 401
        // (InvalidTokenError) would make clients discard the token and re-authenticate
        // in a loop; InsufficientScopeError maps to 403 and terminates cleanly.
        throw new InsufficientScopeError("Your email domain is not permitted to use this server");
      }
    }

    return {
      token,
      clientId: (payload.client_id ?? payload.azp ?? "") as string,
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      extra: { sub, ...(email ? { email } : {}) },
    };
  };
}
