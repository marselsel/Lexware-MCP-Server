import * as jose from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
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
