import { describe, expect, it } from "vitest";
import { ConfigError, describeCapabilities, loadConfig } from "../src/config.js";
import { DEFAULT_ALLOWED_HOSTS, isAllowedHost } from "../src/uploads/fetch-url.js";

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

  it("defaults the upload host allow-list to the built-in list", () => {
    expect(loadConfig(base()).uploadAllowedHosts).toEqual(DEFAULT_ALLOWED_HOSTS);
  });

  it("LEXWARE_UPLOAD_ALLOWED_HOSTS replaces the defaults rather than extending them", () => {
    const c = loadConfig({
      ...base(),
      LEXWARE_UPLOAD_ALLOWED_HOSTS: "files.example.com, Cdn.Example.Org , ",
    } as NodeJS.ProcessEnv);
    // Lower-cased, trimmed, blanks dropped — and the Microsoft defaults are GONE, which
    // is the point: an operator must be able to opt out of them.
    expect(c.uploadAllowedHosts).toEqual(["files.example.com", "cdn.example.org"]);
    expect(c.uploadAllowedHosts).not.toContain("sharepoint.com");
  });

  it("an explicitly empty LEXWARE_UPLOAD_ALLOWED_HOSTS blocks every host (fail closed)", () => {
    const c = loadConfig({ ...base(), LEXWARE_UPLOAD_ALLOWED_HOSTS: "" } as NodeJS.ProcessEnv);
    expect(c.uploadAllowedHosts).toEqual([]);
    // Empty must mean "nothing allowed", never "everything allowed".
    expect(isAllowedHost("sharepoint.com", c.uploadAllowedHosts)).toBe(false);
    expect(isAllowedHost("files.example.com", c.uploadAllowedHosts)).toBe(false);
  });

  it("resolves the public base URL from SERVER_URL in EVERY auth mode, not just OAuth", () => {
    // The bug this pins down: publicBaseUrl used to be derived from the auth mode —
    // the OAuth resource, else loopback — so a static-token (or unauthenticated)
    // deployment behind a real domain set SERVER_URL, had it ignored, and handed out
    // upload links pointing at its own container.
    const staticMode = loadConfig({ ...base(), SERVER_URL: "https://mcp.example.com/lexware" } as NodeJS.ProcessEnv);
    expect(staticMode.auth.mode).toBe("static");
    expect(staticMode.publicBaseUrl).toBe("https://mcp.example.com/lexware");

    const noAuth = loadConfig({
      LEXWARE_API_KEY: "k",
      MCP_ALLOW_UNAUTHENTICATED: "true",
      SERVER_URL: "https://mcp.example.com",
    } as NodeJS.ProcessEnv);
    expect(noAuth.auth.mode).toBe("none");
    expect(noAuth.publicBaseUrl).toBe("https://mcp.example.com");
  });

  it("prefers OAUTH_RESOURCE over SERVER_URL and matches the OAuth resource exactly", () => {
    const c = loadConfig({
      LEXWARE_API_KEY: "k",
      OAUTH_ISSUER: "https://auth.example.com",
      OAUTH_RESOURCE: "https://mcp.example.com/",
      SERVER_URL: "https://other.example.com",
    } as NodeJS.ProcessEnv);
    // Normalized the same way (trailing slash stripped) and never drifting from the
    // value the token audience is checked against.
    expect(c.publicBaseUrl).toBe("https://mcp.example.com");
    expect(c.publicBaseUrl).toBe((c.auth as { resource: string }).resource);
  });

  it("falls back to loopback on the CONFIGURED port when no public URL is set", () => {
    expect(loadConfig(base()).publicBaseUrl).toBe("http://127.0.0.1:8080");
    expect(loadConfig({ ...base(), PORT: "9443" } as NodeJS.ProcessEnv).publicBaseUrl).toBe("http://127.0.0.1:9443");
  });

  it("validates SERVER_URL like every other configured URL", () => {
    // A typo must fail at startup, not end up in a curl command an operator runs.
    expect(() => loadConfig({ ...base(), SERVER_URL: "not a url" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base(), SERVER_URL: "http://mcp.example.com" } as NodeJS.ProcessEnv)).toThrow(/https/);
    // http on loopback stays allowed (local runs).
    expect(loadConfig({ ...base(), SERVER_URL: "http://localhost:8080" } as NodeJS.ProcessEnv).publicBaseUrl).toBe(
      "http://localhost:8080",
    );
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
