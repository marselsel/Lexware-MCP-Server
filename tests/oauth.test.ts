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
});

describe("buildOAuthMetadata with discovery", () => {
  const discovered = {
    issuer: ISSUER,
    authorization_endpoint: "https://real/authorize",
    token_endpoint: "https://real/token",
    jwks_uri: "https://real/jwks",
    registration_endpoint: "https://real/register",
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["openid", "offline_access"],
  };

  it("prefers the discovered document over derived defaults", () => {
    const md = buildOAuthMetadata(settings(), discovered);
    expect(md.authorization_endpoint).toBe("https://real/authorize");
    expect(md.token_endpoint).toBe("https://real/token");
    expect(md.scopes_supported).toEqual(["openid", "offline_access"]);
  });

  it("an explicit env override still beats discovery", () => {
    const md = buildOAuthMetadata(
      settings({
        authorizationEndpoint: "https://pinned/authorize",
        explicitEndpoints: { authorization: true, token: false, registration: false, jwks: false },
      }),
      discovered,
    );
    expect(md.authorization_endpoint).toBe("https://pinned/authorize"); // override wins
    expect(md.token_endpoint).toBe("https://real/token"); // not pinned -> discovered
  });

  it("OAUTH_SCOPES_SUPPORTED beats discovery, so both documents agree", () => {
    const md = buildOAuthMetadata(settings({ scopesSupported: ["api://x/mcp"] }), discovered);
    expect(md.scopes_supported).toEqual(["api://x/mcp"]);
  });

  it("registration=none is honoured even if the issuer advertises one", () => {
    const md = buildOAuthMetadata(
      settings({
        registrationEndpoint: undefined,
        explicitEndpoints: { authorization: false, token: false, registration: true, jwks: false },
      }),
      discovered,
    );
    expect(Object.keys(md)).not.toContain("registration_endpoint");
  });

  it("issuer is never taken from the document", () => {
    const md = buildOAuthMetadata(settings(), { ...discovered, issuer: "https://other" });
    expect(md.issuer).toBe(ISSUER);
  });

  it("without a document, output is exactly the pre-discovery defaults", () => {
    const md = buildOAuthMetadata(settings());
    expect(md.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.scopes_supported).toEqual(["openid", "email", "profile"]);
  });
});
