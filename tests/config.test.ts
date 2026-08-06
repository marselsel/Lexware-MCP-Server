import { describe, expect, it } from "vitest";
import { ConfigError, describeCapabilities, loadConfig } from "../src/config.js";

const TOKEN = "a".repeat(40);
const base = () => ({ LEXWARE_API_KEY: "key", MCP_AUTH_TOKEN: TOKEN }) as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("loads a valid config with defaults", () => {
    const c = loadConfig(base());
    expect(c.lexwareApiKey).toBe("key");
    expect(c.lexwareApiBaseUrl).toBe("https://api.lexware.io");
    expect(c.lexwareAppBaseUrl).toBe("https://app.lexware.de");
    expect(c.port).toBe(8080);
    expect(c.capabilities).toEqual({ read: true, drafts: true, finalize: false });
  });

  it("requires LEXWARE_API_KEY", () => {
    expect(() => loadConfig({ MCP_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("fails closed when no auth is configured and no opt-out", () => {
    expect(() => loadConfig({ LEXWARE_API_KEY: "k" } as NodeJS.ProcessEnv)).toThrow(/No auth configured/);
  });

  it("uses static auth when MCP_AUTH_TOKEN is set", () => {
    const c = loadConfig(base());
    expect(c.auth).toEqual({ mode: "static", token: TOKEN });
  });

  it("allows no auth only with MCP_ALLOW_UNAUTHENTICATED=true", () => {
    const c = loadConfig({ LEXWARE_API_KEY: "k", MCP_ALLOW_UNAUTHENTICATED: "true" } as NodeJS.ProcessEnv);
    expect(c.auth.mode).toBe("none");
  });

  it("uses OAuth when OAUTH_ISSUER is set, deriving JWKS/userinfo/resource", () => {
    const c = loadConfig({
      LEXWARE_API_KEY: "k",
      OAUTH_ISSUER: "https://auth.example.com",
      SERVER_URL: "https://mcp.example.com",
      OAUTH_ALLOWED_EMAIL_DOMAINS: "example.com, example.org",
    } as NodeJS.ProcessEnv);
    expect(c.auth).toEqual({
      mode: "oauth",
      issuer: "https://auth.example.com",
      jwksUrl: "https://auth.example.com/oauth2/jwks",
      userinfoUrl: "https://auth.example.com/oauth2/userinfo",
      resource: "https://mcp.example.com",
      verifyAudience: true,
      extraAudiences: [],
      allowedEmailDomains: ["example.com", "example.org"],
      authorizationEndpoint: "https://auth.example.com/oauth2/authorize",
      tokenEndpoint: "https://auth.example.com/oauth2/token",
      registrationEndpoint: "https://auth.example.com/oauth2/register",
    });
  });

  it("allows overriding the OAuth endpoints for non-WorkOS IdPs (e.g. Auth0)", () => {
    const c = loadConfig({
      LEXWARE_API_KEY: "k",
      OAUTH_ISSUER: "https://tenant.auth0.com/",
      SERVER_URL: "https://mcp.example.com",
      OAUTH_AUTHORIZATION_ENDPOINT: "https://tenant.auth0.com/authorize",
      OAUTH_TOKEN_ENDPOINT: "https://tenant.auth0.com/oauth/token",
    } as NodeJS.ProcessEnv);
    expect(c.auth).toMatchObject({
      authorizationEndpoint: "https://tenant.auth0.com/authorize",
      tokenEndpoint: "https://tenant.auth0.com/oauth/token",
      // registration endpoint keeps the derived default when not overridden
      registrationEndpoint: "https://tenant.auth0.com/oauth2/register",
    });
  });

  it("preserves a trailing-slash issuer exactly (for iss match) but cleans derived URLs", () => {
    const c = loadConfig({
      LEXWARE_API_KEY: "k",
      OAUTH_ISSUER: "https://tenant.auth0.com/",
      SERVER_URL: "https://mcp.example.com",
    } as NodeJS.ProcessEnv);
    expect(c.auth).toMatchObject({
      mode: "oauth",
      issuer: "https://tenant.auth0.com/",
      jwksUrl: "https://tenant.auth0.com/oauth2/jwks",
      userinfoUrl: "https://tenant.auth0.com/oauth2/userinfo",
    });
  });

  it("OAuth mode requires a resource/SERVER_URL", () => {
    expect(() =>
      loadConfig({ LEXWARE_API_KEY: "k", OAUTH_ISSUER: "https://auth.example.com" } as NodeJS.ProcessEnv),
    ).toThrow(/OAUTH_RESOURCE/);
  });

  it("parses OAUTH_AUDIENCE into extra accepted audiences (trimmed, blanks dropped)", () => {
    const c = loadConfig({
      LEXWARE_API_KEY: "k",
      OAUTH_ISSUER: "https://auth.example.com",
      SERVER_URL: "https://mcp.example.com",
      // Bare GUIDs, not URLs — these must not be run through normalizeUrl.
      OAUTH_AUDIENCE: "11111111-2222-3333-4444-555555555555, api://other , ",
    } as NodeJS.ProcessEnv);
    expect(c.auth).toMatchObject({
      extraAudiences: ["11111111-2222-3333-4444-555555555555", "api://other"],
      // The extra audiences are additive: the check stays on.
      verifyAudience: true,
    });
  });

  it("OAuth takes precedence over a static token", () => {
    const c = loadConfig({ ...base(), OAUTH_ISSUER: "https://auth.example.com", SERVER_URL: "https://x.example.com" } as NodeJS.ProcessEnv);
    expect(c.auth.mode).toBe("oauth");
  });

  it("rejects a weak token", () => {
    expect(() => loadConfig({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: "short" } as NodeJS.ProcessEnv)).toThrow(/too weak/);
  });

  it("READ_ONLY hard-overrides the enable flags", () => {
    const c = loadConfig({
      ...base(),
      LEXWARE_READ_ONLY: "true",
      LEXWARE_ENABLE_DRAFTS: "true",
      LEXWARE_ENABLE_FINALIZE: "true",
    } as NodeJS.ProcessEnv);
    expect(c.capabilities).toEqual({ read: true, drafts: false, finalize: false });
  });

  it("enables finalize when requested", () => {
    const c = loadConfig({ ...base(), LEXWARE_ENABLE_FINALIZE: "true" } as NodeJS.ProcessEnv);
    expect(c.capabilities.finalize).toBe(true);
  });

  it("can disable drafts", () => {
    const c = loadConfig({ ...base(), LEXWARE_ENABLE_DRAFTS: "false" } as NodeJS.ProcessEnv);
    expect(c.capabilities.drafts).toBe(false);
  });

  it("finalize force-enables drafts and records a warning when drafts was explicitly off", () => {
    const c = loadConfig({
      ...base(),
      LEXWARE_ENABLE_DRAFTS: "false",
      LEXWARE_ENABLE_FINALIZE: "true",
    } as NodeJS.ProcessEnv);
    expect(c.capabilities).toMatchObject({ drafts: true, finalize: true });
    expect(c.warnings.join(" ")).toMatch(/overridden to true because LEXWARE_ENABLE_FINALIZE/);
  });

  it("records no override warning when drafts is left at its default", () => {
    const c = loadConfig({ ...base(), LEXWARE_ENABLE_FINALIZE: "true" } as NodeJS.ProcessEnv);
    expect(c.warnings).toEqual([]);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ ...base(), PORT: "0" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base(), PORT: "nope" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("rejects an invalid boolean", () => {
    expect(() => loadConfig({ ...base(), LEXWARE_READ_ONLY: "maybe" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("normalizes and validates base URLs", () => {
    const c = loadConfig({ ...base(), LEXWARE_API_BASE_URL: "https://example.test/" } as NodeJS.ProcessEnv);
    expect(c.lexwareApiBaseUrl).toBe("https://example.test");
    expect(() => loadConfig({ ...base(), LEXWARE_API_BASE_URL: "ftp://x" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("requires HTTPS for config URLs (http allowed only for localhost)", () => {
    expect(() =>
      loadConfig({ ...base(), OAUTH_ISSUER: "http://auth.example.com", SERVER_URL: "https://x.example.com" } as NodeJS.ProcessEnv),
    ).toThrow(/https/);
    expect(() => loadConfig({ ...base(), LEXWARE_API_BASE_URL: "http://evil.example.com" } as NodeJS.ProcessEnv)).toThrow(/https/);
    // http on localhost is allowed (local mocks / testing).
    const c = loadConfig({ ...base(), LEXWARE_API_BASE_URL: "http://localhost:9000" } as NodeJS.ProcessEnv);
    expect(c.lexwareApiBaseUrl).toBe("http://localhost:9000");
  });

  it("describeCapabilities is secret-free and informative", () => {
    const c = loadConfig(base());
    const s = describeCapabilities(c);
    expect(s).toContain("read");
    expect(s).toContain("drafts");
    expect(s).toContain("token-protected");
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain("key");
  });
});
