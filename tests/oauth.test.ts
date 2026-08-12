import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import * as jose from "jose";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, describe, expect, it } from "vitest";
import {
  advertisedScopes,
  buildOAuthMetadata,
  discoverAuthorizationServerMetadata,
  discoveryUrls,
  createAccessTokenVerifier,
  resolveOAuthEndpoints,
  safeDiscoveredUrl,
  isEmailDomainAllowed,
  isEmailVerified,
  type OAuthSettings,
} from "../src/oauth.js";

const ISSUER = "https://auth.example.com";
const RESOURCE = "https://mcp.example.com";

function settings(overrides: Partial<OAuthSettings> = {}): OAuthSettings {
  return {
    issuer: ISSUER,
    jwksUrl: `${ISSUER}/oauth2/jwks`,
    resource: RESOURCE,
    verifyAudience: true,
    allowedEmailDomains: [],
    userinfoUrl: `${ISSUER}/oauth2/userinfo`,
    authorizationEndpoint: `${ISSUER}/oauth2/authorize`,
    tokenEndpoint: `${ISSUER}/oauth2/token`,
    registrationEndpoint: `${ISSUER}/oauth2/register`,
    ...overrides,
  };
}

let jwks: ReturnType<typeof jose.createLocalJWKSet>;
let sign: (claims: jose.JWTPayload, opts?: { iss?: string; aud?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwks = jose.createLocalJWKSet({ keys: [jwk] });
  sign = (claims, opts = {}) =>
    new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? RESOURCE)
      .setExpirationTime("1h")
      .setIssuedAt()
      .sign(privateKey);
});

const okFetch = (email: string): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ email, email_verified: true }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("isEmailDomainAllowed", () => {
  it("matches case-insensitively", () => {
    expect(isEmailDomainAllowed("a@Example.com", ["example.com"])).toBe(true);
    expect(isEmailDomainAllowed("a@evil.com", ["example.com"])).toBe(false);
    expect(isEmailDomainAllowed(undefined, ["example.com"])).toBe(false);
    expect(isEmailDomainAllowed("noatsign", ["example.com"])).toBe(false);
  });

  it("uses the domain after the LAST @ (resists a@allowed.com@evil.com)", () => {
    expect(isEmailDomainAllowed("a@allowed.com@evil.com", ["allowed.com"])).toBe(false);
    expect(isEmailDomainAllowed("a@allowed.com@evil.com", ["evil.com"])).toBe(true);
  });
});

describe("isEmailVerified", () => {
  it("accepts only an explicit true (boolean or string); fails closed otherwise", () => {
    expect(isEmailVerified(true)).toBe(true);
    expect(isEmailVerified("true")).toBe(true);
    expect(isEmailVerified(false)).toBe(false);
    expect(isEmailVerified("false")).toBe(false);
    expect(isEmailVerified(undefined)).toBe(false);
    expect(isEmailVerified(1)).toBe(false);
  });
});

describe("createAccessTokenVerifier", () => {
  it("accepts a valid token (no domain restriction) and returns sub", async () => {
    const verify = createAccessTokenVerifier(settings(), { jwks });
    const token = await sign({ sub: "user-1", scope: "openid email" });
    const info = await verify(token);
    expect(info.extra?.sub).toBe("user-1");
    expect(info.scopes).toContain("email");
  });

  it("accepts the audience with a trailing slash (Resource Indicator serialization)", async () => {
    const verify = createAccessTokenVerifier(settings(), { jwks });
    const token = await sign({ sub: "u" }, { aud: `${RESOURCE}/` });
    await expect(verify(token)).resolves.toMatchObject({ extra: { sub: "u" } });
  });

  it("rejects a token from the wrong issuer", async () => {
    const verify = createAccessTokenVerifier(settings(), { jwks });
    const token = await sign({ sub: "u" }, { iss: "https://evil.example.com" });
    await expect(verify(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const verify = createAccessTokenVerifier(settings(), { jwks });
    const token = await sign({ sub: "u" }, { aud: "https://someone-else.example.com" });
    await expect(verify(token)).rejects.toThrow();
  });

  it("ignores the audience when verifyAudience is false", async () => {
    const verify = createAccessTokenVerifier(settings({ verifyAudience: false }), { jwks });
    const token = await sign({ sub: "u" }, { aud: "https://someone-else.example.com" });
    await expect(verify(token)).resolves.toMatchObject({ extra: { sub: "u" } });
  });

  it("accepts an extra audience (Entra puts the API's client ID in aud, not the resource)", async () => {
    const clientId = "11111111-2222-3333-4444-555555555555";
    const verify = createAccessTokenVerifier(settings({ extraAudiences: [clientId] }), { jwks });
    const token = await sign({ sub: "u" }, { aud: clientId });
    await expect(verify(token)).resolves.toMatchObject({ extra: { sub: "u" } });
  });

  it("still accepts the resource audience when extra audiences are configured", async () => {
    const verify = createAccessTokenVerifier(settings({ extraAudiences: ["some-client-id"] }), { jwks });
    const token = await sign({ sub: "u" });
    await expect(verify(token)).resolves.toMatchObject({ extra: { sub: "u" } });
  });

  it("still rejects an audience that is neither the resource nor an extra one", async () => {
    // The point of OAUTH_AUDIENCE over OAUTH_VERIFY_AUDIENCE=false: a token minted
    // for a different app on the same tenant must not be accepted (confused deputy).
    const token = await sign({ sub: "u" }, { aud: "another-app-client-id" });

    const verify = createAccessTokenVerifier(settings({ extraAudiences: ["our-client-id"] }), { jwks });
    await expect(verify(token)).rejects.toThrow(/Invalid or expired access token/);

    // Positive control: the same token, same signature, same issuer, is accepted once
    // its audience is configured. That is what pins the rejection above to the audience
    // check rather than to an unrelated verification failure.
    const permissive = createAccessTokenVerifier(
      settings({ extraAudiences: ["another-app-client-id"] }),
      { jwks },
    );
    await expect(permissive(token)).resolves.toMatchObject({ extra: { sub: "u" } });
  });

  it("allows an email-claim domain that is permitted", async () => {
    const verify = createAccessTokenVerifier(settings({ allowedEmailDomains: ["example.com"] }), { jwks });
    const token = await sign({ sub: "u", email: "user@example.com", email_verified: true });
    await expect(verify(token)).resolves.toMatchObject({ extra: { email: "user@example.com" } });
  });

  it("rejects an email-claim domain that is not permitted", async () => {
    const verify = createAccessTokenVerifier(settings({ allowedEmailDomains: ["example.com"] }), { jwks });
    const token = await sign({ sub: "u", email: "attacker@evil.com", email_verified: true });
    await expect(verify(token)).rejects.toThrow(/domain is not permitted/);
  });

  it("falls back to userinfo for the email when not a claim", async () => {
    const verify = createAccessTokenVerifier(settings({ allowedEmailDomains: ["example.com"] }), {
      jwks,
      fetchFn: okFetch("user@example.com"),
    });
    const token = await sign({ sub: "u" });
    await expect(verify(token)).resolves.toMatchObject({ extra: { sub: "u" } });
  });

  it("rejects an unverified email claim even when its domain is allowed", async () => {
    const verify = createAccessTokenVerifier(settings({ allowedEmailDomains: ["example.com"] }), {
      jwks,
      // userinfo can't rescue it either:
      fetchFn: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
    });
    const token = await sign({ sub: "u", email: "user@example.com", email_verified: false });
    await expect(verify(token)).rejects.toThrow(/domain is not permitted/);
  });

  it("rejects an unverified userinfo email", async () => {
    const verify = createAccessTokenVerifier(settings({ allowedEmailDomains: ["example.com"] }), {
      jwks,
      fetchFn: (async () =>
        new Response(JSON.stringify({ email: "user@example.com", email_verified: false }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const token = await sign({ sub: "u" });
    await expect(verify(token)).rejects.toThrow(/domain is not permitted/);
  });

  it("does not cache userinfo misses — a valid user isn't locked out after a transient outage", async () => {
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      return call === 1
        ? new Response("down", { status: 503 })
        : new Response(JSON.stringify({ email: "user@example.com", email_verified: true }), {
            headers: { "content-type": "application/json" },
          });
    }) as unknown as typeof fetch;
    const verify = createAccessTokenVerifier(settings({ allowedEmailDomains: ["example.com"] }), { jwks, fetchFn });
    const token = await sign({ sub: "u" });
    await expect(verify(token)).rejects.toThrow(); // userinfo down → rejected
    await expect(verify(token)).resolves.toMatchObject({ extra: { sub: "u" } }); // recovered → allowed
  });

  it("fails closed when the email cannot be established", async () => {
    const verify = createAccessTokenVerifier(settings({ allowedEmailDomains: ["example.com"] }), {
      jwks,
      fetchFn: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    const token = await sign({ sub: "u" });
    await expect(verify(token)).rejects.toThrow(/domain is not permitted/);
  });
});

describe("advertisedScopes", () => {
  it("is undefined when no scopes are configured", () => {
    expect(advertisedScopes(settings())).toBeUndefined();
    expect(advertisedScopes(settings({ scopesSupported: [] }))).toBeUndefined();
  });

  it("returns the configured scopes", () => {
    expect(advertisedScopes(settings({ scopesSupported: ["openid", "email"] }))).toEqual([
      "openid",
      "email",
    ]);
  });
});

/** Serve the protected-resource metadata the way server.ts mounts it, and read it back. */
async function protectedResourceDoc(oauth: OAuthSettings): Promise<Record<string, unknown>> {
  const app = express();
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: buildOAuthMetadata(oauth),
      resourceServerUrl: new URL(oauth.resource),
      scopesSupported: advertisedScopes(oauth),
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("protected-resource metadata (RFC 9728)", () => {
  it("omits scopes_supported entirely when nothing is configured", async () => {
    const doc = await protectedResourceDoc(settings());
    // Not just falsy — the key must be absent, i.e. the document is unchanged from
    // before OAUTH_SCOPES_SUPPORTED existed.
    expect(Object.keys(doc)).not.toContain("scopes_supported");
    expect(doc).toMatchObject({
      resource: "https://mcp.example.com/",
      authorization_servers: [ISSUER],
    });
  });

  it("advertises the configured scopes so clients know what to request", async () => {
    const doc = await protectedResourceDoc(settings({ scopesSupported: ["openid", "email", "api://x/mcp.access"] }));
    expect(doc.scopes_supported).toEqual(["openid", "email", "api://x/mcp.access"]);
  });
});

describe("buildOAuthMetadata scopes_supported", () => {
  it("keeps the historic default when OAUTH_SCOPES_SUPPORTED is unset", () => {
    expect(buildOAuthMetadata(settings()).scopes_supported).toEqual(["openid", "email", "profile"]);
    expect(buildOAuthMetadata(settings({ scopesSupported: [] })).scopes_supported).toEqual([
      "openid",
      "email",
      "profile",
    ]);
  });

  it("uses the configured scopes so the AS and protected-resource docs cannot contradict", () => {
    const oauth = settings({ scopesSupported: ["api://x/mcp.access"] });
    // Both documents must name the same scopes; an operator on a non-WorkOS IdP would
    // otherwise still see `openid email profile` advertised in the AS metadata.
    expect(buildOAuthMetadata(oauth).scopes_supported).toEqual(["api://x/mcp.access"]);
    expect(advertisedScopes(oauth)).toEqual(["api://x/mcp.access"]);
  });
});

describe("buildOAuthMetadata registration_endpoint", () => {
  it("advertises it when configured", () => {
    expect(buildOAuthMetadata(settings()).registration_endpoint).toBe(
      `${ISSUER}/oauth2/register`,
    );
  });

  it("omits the KEY entirely when the issuer has no DCR", () => {
    const md = buildOAuthMetadata(settings({ registrationEndpoint: undefined }));
    // Key absence, not just a falsy value: a client must see no registration_endpoint
    // at all rather than attempt DCR against an endpoint that rejects every request.
    expect(Object.keys(md)).not.toContain("registration_endpoint");
  });
});

describe("served authorization-server document", () => {
  it("drops registration_endpoint from the real HTTP response", async () => {
    const oauth = settings({ registrationEndpoint: undefined });
    const app = express();
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata: buildOAuthMetadata(oauth),
        resourceServerUrl: new URL(oauth.resource),
        scopesSupported: advertisedScopes(oauth),
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
      );
      const doc = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(doc)).not.toContain("registration_endpoint");
      expect(doc.issuer).toBe(ISSUER);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const jsonFetch = (byUrl: Record<string, unknown>): typeof fetch =>
  (async (url: string | URL) => {
    const body = byUrl[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

describe("discoveryUrls", () => {
  it("puts the RFC 8414 layout first for a path-less issuer", () => {
    expect(discoveryUrls("https://auth.example.com")[0]).toBe(
      "https://auth.example.com/.well-known/oauth-authorization-server",
    );
  });

  it("handles a path-bearing issuer both ways (Entra-style)", () => {
    const urls = discoveryUrls("https://login.microsoftonline.com/tid/v2.0");
    // RFC 8414 inserts the well-known segment BEFORE the path; OIDC appends it.
    expect(urls).toContain(
      "https://login.microsoftonline.com/.well-known/oauth-authorization-server/tid/v2.0",
    );
    expect(urls).toContain(
      "https://login.microsoftonline.com/tid/v2.0/.well-known/openid-configuration",
    );
  });

  it("de-duplicates the two identical layouts for a path-less issuer", () => {
    // Finding #3: for a path-less issuer layouts (1) and (3) are byte-identical; without
    // dedupe an unreachable issuer would burn a timeout on the same URL twice.
    const urls = discoveryUrls("https://auth.example.com");
    expect(urls.length).toBe(2);
    expect(new Set(urls).size).toBe(2);
  });
});

describe("discoverAuthorizationServerMetadata", () => {
  it("returns the issuer's document", async () => {
    const doc = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/real/authorize` };
    const got = await discoverAuthorizationServerMetadata(ISSUER, {
      fetchFn: jsonFetch({ [`${ISSUER}/.well-known/oauth-authorization-server`]: doc }),
    });
    expect(got?.authorization_endpoint).toBe(`${ISSUER}/real/authorize`);
  });

  it("falls through to the OIDC layout when RFC 8414 404s", async () => {
    const iss = "https://login.microsoftonline.com/tid/v2.0";
    const doc = { issuer: iss, token_endpoint: "https://login.microsoftonline.com/tid/oauth2/v2.0/token" };
    const got = await discoverAuthorizationServerMetadata(iss, {
      fetchFn: jsonFetch({ [`${iss}/.well-known/openid-configuration`]: doc }),
    });
    expect(got?.token_endpoint).toBe("https://login.microsoftonline.com/tid/oauth2/v2.0/token");
  });

  it("accepts a document whose issuer differs only by a trailing slash", async () => {
    // Finding #5 (issuer-slash): some issuers' canonical form ends in "/". This must
    // match, while a genuinely different issuer (tested below) must not.
    const got = await discoverAuthorizationServerMetadata(ISSUER, {
      fetchFn: jsonFetch({
        [`${ISSUER}/.well-known/oauth-authorization-server`]: {
          issuer: `${ISSUER}/`,
          token_endpoint: `${ISSUER}/real/token`,
        },
      }),
    });
    expect(got?.token_endpoint).toBe(`${ISSUER}/real/token`);
  });

  it("REJECTS a document whose issuer does not match", async () => {
    // Security control: this document decides where users are sent to authenticate,
    // so one claiming to speak for another issuer must be discarded, not merged.
    const got = await discoverAuthorizationServerMetadata(ISSUER, {
      fetchFn: jsonFetch({
        [`${ISSUER}/.well-known/oauth-authorization-server`]: {
          issuer: "https://evil.example.com",
          authorization_endpoint: "https://evil.example.com/authorize",
        },
      }),
    });
    expect(got).toBeUndefined();
  });

  it("returns undefined when the issuer is unreachable (never throws)", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(discoverAuthorizationServerMetadata(ISSUER, { fetchFn: boom })).resolves.toBeUndefined();
  });

  it("bounds TOTAL time across candidate URLs, not per-URL (finding #3)", async () => {
    // A path-bearing issuer yields three distinct URLs. With a 5s TOTAL budget and each
    // attempt 'consuming' 3s of a fake clock, only the first two can be tried — the third
    // is past the deadline. This pins the worst case at ~5s, not 3 x 5s.
    let clock = 1_000;
    const tried: string[] = [];
    const slowBoom = (async (url: string | URL) => {
      tried.push(String(url));
      clock += 3_000;
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const got = await discoverAuthorizationServerMetadata("https://p.example/tid", {
      fetchFn: slowBoom,
      now: () => clock,
    });
    expect(got).toBeUndefined();
    expect(tried.length).toBe(2); // third URL is past the deadline -> not attempted
  });
});

/** All-false explicit-override set with the given fields flipped on. */
const EXPLICIT = (
  on: Partial<Record<"authorization" | "token" | "registration" | "jwks" | "userinfo", boolean>> = {},
) => ({ authorization: false, token: false, registration: false, jwks: false, userinfo: false, ...on });

const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";

describe("safeDiscoveredUrl", () => {
  it("accepts https and http-on-loopback, rejects everything else", () => {
    expect(safeDiscoveredUrl("https://issuer.example/jwks")).toBe("https://issuer.example/jwks");
    expect(safeDiscoveredUrl("http://127.0.0.1:8080/jwks")).toBe("http://127.0.0.1:8080/jwks");
    expect(safeDiscoveredUrl("http://localhost/jwks")).toBe("http://localhost/jwks");
    expect(safeDiscoveredUrl("http://evil.example/jwks")).toBeUndefined(); // downgrade
    expect(safeDiscoveredUrl("data:text/plain,x")).toBeUndefined();
    expect(safeDiscoveredUrl("file:///etc/passwd")).toBeUndefined();
    expect(safeDiscoveredUrl("not a url")).toBeUndefined();
    expect(safeDiscoveredUrl("")).toBeUndefined();
    expect(safeDiscoveredUrl(undefined)).toBeUndefined();
    expect(safeDiscoveredUrl(42)).toBeUndefined();
  });
});

describe("resolveOAuthEndpoints", () => {
  const discovered = {
    issuer: ISSUER,
    authorization_endpoint: "https://real.example/authorize",
    token_endpoint: "https://real.example/token",
    jwks_uri: "https://real.example/jwks",
    userinfo_endpoint: "https://real.example/userinfo",
    registration_endpoint: "https://real.example/register",
  };

  it("prefers discovered endpoints over derived defaults — including jwks and userinfo", () => {
    const eff = resolveOAuthEndpoints(settings(), discovered);
    expect(eff.authorizationEndpoint).toBe("https://real.example/authorize");
    expect(eff.tokenEndpoint).toBe("https://real.example/token");
    // These two now flow into the verifier, not just the advertised document:
    expect(eff.jwksUrl).toBe("https://real.example/jwks");
    expect(eff.userinfoUrl).toBe("https://real.example/userinfo");
    expect(eff.registrationEndpoint).toBe("https://real.example/register");
  });

  it("an explicit override still beats discovery, per field", () => {
    const eff = resolveOAuthEndpoints(
      settings({
        authorizationEndpoint: "https://pinned/authorize",
        explicitEndpoints: EXPLICIT({ authorization: true }),
      }),
      discovered,
    );
    expect(eff.authorizationEndpoint).toBe("https://pinned/authorize"); // pinned wins
    expect(eff.tokenEndpoint).toBe("https://real.example/token"); // not pinned -> discovered
  });

  // Finding #1 — the #36 regression. A successful discovery is authoritative about DCR.
  it("omits registration when discovery SUCCEEDS but the issuer advertises none", () => {
    const eff = resolveOAuthEndpoints(settings(), { issuer: ISSUER }); // no registration_endpoint
    expect(eff.registrationEndpoint).toBeUndefined(); // NOT the derived guess
  });

  it("keeps the derived registration guess only when discovery did NOT run", () => {
    const eff = resolveOAuthEndpoints(settings(), undefined);
    expect(eff.registrationEndpoint).toBe(`${ISSUER}/oauth2/register`);
    expect(eff.authorizationEndpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(eff.jwksUrl).toBe(`${ISSUER}/oauth2/jwks`);
  });

  it("registration=none is honoured even if the issuer advertises one", () => {
    const eff = resolveOAuthEndpoints(
      settings({ registrationEndpoint: undefined, explicitEndpoints: EXPLICIT({ registration: true }) }),
      discovered,
    );
    expect(eff.registrationEndpoint).toBeUndefined();
  });

  // Finding #4 — discovered URLs are validated before use.
  it("ignores an unsafe discovered URL and keeps the derived default", () => {
    const eff = resolveOAuthEndpoints(settings(), {
      issuer: ISSUER,
      authorization_endpoint: "http://evil.example/authorize", // downgrade -> rejected
      jwks_uri: "not a url", // malformed -> rejected
      token_endpoint: "https://ok.example/token", // valid -> used
    });
    expect(eff.authorizationEndpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(eff.jwksUrl).toBe(`${ISSUER}/oauth2/jwks`);
    expect(eff.tokenEndpoint).toBe("https://ok.example/token");
  });
});

// Finding #2 — the verifier consumes the resolved userinfo endpoint, not a derived guess.
describe("discovery feeds the verifier (no advertised-vs-verified divergence)", () => {
  it("fetches email from the DISCOVERED userinfo endpoint", async () => {
    const eff = resolveOAuthEndpoints(settings({ allowedEmailDomains: ["example.com"] }), {
      issuer: ISSUER,
      userinfo_endpoint: "https://real.example/userinfo",
    });
    let calledUrl: string | undefined;
    const capturingFetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ email: "u@example.com", email_verified: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const verify = createAccessTokenVerifier(eff, { jwks, fetchFn: capturingFetch });
    const token = await sign({ sub: "u" }); // no email claim -> forces the userinfo fallback
    await expect(verify(token)).resolves.toMatchObject({ extra: { email: "u@example.com" } });
    expect(calledUrl).toBe("https://real.example/userinfo"); // the discovered one, not the derived
  });
});

describe("buildOAuthMetadata", () => {
  it("reflects the already-resolved endpoints verbatim and passes through capability arrays", () => {
    const eff = resolveOAuthEndpoints(settings(), {
      issuer: ISSUER,
      authorization_endpoint: "https://real.example/authorize",
    });
    const md = buildOAuthMetadata(eff, {
      grant_types_supported: ["authorization_code", "refresh_token", DEVICE_CODE],
      scopes_supported: ["openid", "offline_access"],
    });
    expect(md.authorization_endpoint).toBe("https://real.example/authorize");
    expect(md.grant_types_supported).toContain(DEVICE_CODE);
    expect(md.scopes_supported).toEqual(["openid", "offline_access"]);
  });

  it("OAUTH_SCOPES_SUPPORTED beats discovery, so both documents agree", () => {
    const md = buildOAuthMetadata(settings({ scopesSupported: ["api://x/mcp"] }), {
      scopes_supported: ["openid", "offline_access"],
    });
    expect(md.scopes_supported).toEqual(["api://x/mcp"]);
  });

  it("issuer is never taken from the document", () => {
    const md = buildOAuthMetadata(settings(), { issuer: "https://other" });
    expect(md.issuer).toBe(ISSUER);
  });

  it("without a document, output is exactly the pre-discovery defaults", () => {
    const md = buildOAuthMetadata(settings());
    expect(md.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(md.scopes_supported).toEqual(["openid", "email", "profile"]);
  });
});
