# Lexware Office MCP Server

An open-source, self-hostable **[MCP](https://modelcontextprotocol.io) server** for the
[Lexware Office](https://developers.lexware.io/docs/) accounting API. Run your own instance,
connect it to Claude, and let an agent read your invoices, vouchers, contacts and articles —
and (optionally) draft new ones.

Bring your own Lexware API key — the server is single-tenant per deployment and never stores
anyone else's credentials. It runs as a remote HTTP server on any container host, built with
the [Skybridge](https://docs.skybridge.tech) framework.

**Two authentication methods — choose one:**
- **OAuth 2.1** — required to use this as a **web MCP server / custom connector** in the
  Claude app, **claude.ai web**, or **ChatGPT** (those clients accept only OAuth).
- **Static bearer token** — simpler, but works only with **Claude Code / Claude Desktop**
  (which let you send a request header); the web custom-connector UI does not support it.

Setup for both is in the [Client support & authentication](#client-support--authentication)
section below.

Related projects — local (stdio) Lexware MCP servers:
[lazyants/lexware-mcp-server](https://github.com/lazyants/lexware-mcp-server),
[JannikWempe/mcp-lexware-office](https://github.com/JannikWempe/mcp-lexware-office).

> ⚠️ **This brokers real accounting data.** Read [SECURITY.md](SECURITY.md), protect your
> tokens, and note that **finalized invoices are legally binding** — you are responsible for
> their tax/legal correctness. No warranty (MIT).

## Capabilities

60 tools across three tiers you enable via environment variables:

| Tier | Default | What it covers |
|------|---------|----------------|
| **Read** | always on | Profile; contacts & articles (list/get); the voucherlist (plus `summarize-vouchers` for server-side totals); full documents (invoices, quotations, credit notes, order confirmations, delivery notes, dunnings, down-payment invoices, vouchers); **render any document type to PDF** and **download files/receipts** (returned inline as embedded resources); batch & type-dispatched reads (get-vouchers, get-document, get-voucher-file, get-document-file); payments; reference data (countries, payment conditions, posting categories, print layouts); recurring templates (get & list); event subscriptions; document deeplinks |
| **Drafts/writes** (`LEXWARE_ENABLE_DRAFTS`) | on | Create **draft** invoices/quotations/credit-notes/order-confirmations/delivery-notes/dunnings (the Lexware API has no update endpoint for these — set every field, including payment terms, at creation); create & update contacts, articles, and **bookkeeping vouchers**; **upload files** and **attach receipts** to vouchers; create documents as **follow-ups** (`precedingSalesVoucherId`) |
| **Finalize** (`LEXWARE_ENABLE_FINALIZE`) | off | Issue **legally binding** finalized documents in one step via the dedicated `create-finalized-*` tools (confirmation-gated); irreversible article deletes; **manage webhook event subscriptions** (create + delete — a webhook streams financial events to an external URL, so it's opt-in). Enabling this tier also enables Drafts. |

Set `LEXWARE_READ_ONLY=true` to force read-only (overrides the flags above).

## Client support & authentication

The server supports two ways to protect `/mcp`, chosen by environment:

- **OAuth 2.1** (`OAUTH_ISSUER`, …) — **the recommended path.** Use any OAuth provider (e.g.
  [WorkOS AuthKit](https://workos.com/docs/authkit/mcp), Stytch, Auth0, Clerk; or self-hosted
  Keycloak/Zitadel) as the authorization server. This makes the server work as a **custom
  connector** in the Claude app, on **claude.ai web**, and in **ChatGPT**, with a real
  sign-in. Optionally restrict access with `OAUTH_ALLOWED_EMAIL_DOMAINS` (enforced
  server-side via the token's email / the provider's userinfo endpoint).
- **Static bearer token** (`MCP_AUTH_TOKEN`) — the simpler fallback. Works with **Claude
  Code** and **Claude Desktop** (which let you set a request header), but **not** the custom
  connector UI / claude.ai web / ChatGPT (those require OAuth).

OAuth takes precedence when `OAUTH_ISSUER` is set; otherwise the static token is used. With
neither set, the server refuses to start unless `MCP_ALLOW_UNAUTHENTICATED=true`.

### Connecting as a custom connector (OAuth)

1. In your provider, create an app, enable Dynamic Client Registration (or pre-register
   Claude's redirect `https://claude.ai/api/mcp/auth_callback`), and set this server's URL as
   the **Resource Indicator** / audience.
2. Deploy with `OAUTH_ISSUER`, `OAUTH_RESOURCE` (= the public URL), and optionally
   `OAUTH_ALLOWED_EMAIL_DOMAINS`.
3. In the Claude app → **Connectors → Add custom connector**, enter the server URL
   (`https://…/mcp`). Claude discovers the authorization server via
   `/.well-known/oauth-protected-resource` and walks you through sign-in.

## Quick start (Docker)

```bash
git clone https://github.com/marselsel/lexware-mcp && cd lexware-mcp
cp .env.example .env          # set LEXWARE_API_KEY and MCP_AUTH_TOKEN
docker compose up --build     # serves on http://localhost:8080/mcp
```

Generate a strong auth token:

```bash
openssl rand -hex 32
```

Without Docker:

```bash
npm install
npm run build
LEXWARE_API_KEY=... MCP_AUTH_TOKEN=... npm start
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LEXWARE_API_KEY` | — (**required**) | Your Lexware API key ([create one](https://app.lexware.de/addons/public-api)) |
| `OAUTH_ISSUER` | — | OAuth authorization-server issuer URL. Setting it enables OAuth mode¹ |
| `OAUTH_RESOURCE` / `SERVER_URL` | — | This server's public URL (token audience / Resource Indicator). Required in OAuth mode |
| `OAUTH_ALLOWED_EMAIL_DOMAINS` | — | Comma-separated allow-list of email domains (e.g. `example.com`) |
| `OAUTH_VERIFY_AUDIENCE` | `true` | Verify the token `aud` matches `OAUTH_RESOURCE`. **Keep `true`.** Setting `false` accepts *any* valid token from the issuer — including one minted for a different app on the same issuer (a confused-deputy risk). Only disable for a dedicated, single-audience issuer that has no Resource Indicator |
| `OAUTH_AUDIENCE` | — | Comma-separated **additional** accepted `aud` values, on top of `OAUTH_RESOURCE`. For IdPs that ignore the Resource Indicator: Microsoft Entra always puts the API's client ID (a GUID) in `aud`, never the Application ID URI, so without this every token is rejected. Prefer this over `OAUTH_VERIFY_AUDIENCE=false` — the check stays on, just against a value your IdP actually issues. Values are matched **exactly**: they are opaque identifiers, so no normalisation is applied (unlike `OAUTH_RESOURCE`, which also accepts its trailing-slash form) |
| `OAUTH_SCOPES_SUPPORTED` | — | Scopes advertised as `scopes_supported`, telling clients what to request. Separate with commas **or** spaces (a scope value can never contain a space). Applies to **both** well-known documents, so they can't contradict each other. Unset: the protected-resource doc advertises nothing and the authorization-server doc keeps its `openid email profile` default — i.e. unchanged behaviour. Set it for IdPs that reject an authorization request with no `scope` parameter (Microsoft Entra: `AADSTS900144`) |
| `OAUTH_JWKS_URL` / `OAUTH_USERINFO_URL` | derived from issuer | Override the JWKS / OIDC userinfo endpoints (defaults use the WorkOS-AuthKit layout) |
| `OAUTH_AUTHORIZATION_ENDPOINT` / `OAUTH_TOKEN_ENDPOINT` / `OAUTH_REGISTRATION_ENDPOINT` | derived from issuer | Override the endpoints advertised in the authorization-server metadata. Defaults use the WorkOS layout (`{issuer}/oauth2/*`); set these for other IdPs (e.g. Auth0: `/authorize`, `/oauth/token`, Entra: `/oauth2/v2.0/authorize`). Set `OAUTH_REGISTRATION_ENDPOINT=none` if your issuer does **not** support Dynamic Client Registration — the field is optional in RFC 8414, and advertising an endpoint that rejects every request makes clients attempt DCR and fail rather than use a pre-registered client |
| `MCP_AUTH_TOKEN` | — (**required**¹) | Static bearer token clients send to reach `/mcp` (used when OAuth is off) |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | Opt out of auth (trusted local use only — bind to localhost/private network) |
| `LEXWARE_READ_ONLY` | `false` | Register only read tools (hard override) |
| `LEXWARE_ENABLE_DRAFTS` | `true` | Enable create-draft tools |
| `LEXWARE_ENABLE_FINALIZE` | `false` | Enable finalize / legally-binding tools (also enables Drafts) |
| `LEXWARE_API_BASE_URL` | `https://api.lexware.io` | API base URL |
| `LEXWARE_APP_BASE_URL` | `https://app.lexware.de` | Web-app base for document deeplinks |
| `PORT` | `8080` | Listen port (your platform may inject this) |
| `LEXWARE_DEBUG_LOGGING` | `false` | Verbose logs (never secrets/bodies) |

¹ The server needs **either** `OAUTH_ISSUER` (OAuth) **or** `MCP_AUTH_TOKEN` (static). It
**refuses to start** with neither, unless `MCP_ALLOW_UNAUTHENTICATED=true`.

## Connect to Claude (Code / Desktop)

Add to your MCP config (e.g. `~/.claude.json` or the Desktop config):

```json
{
  "mcpServers": {
    "lexware": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Deploy

The server is a standard Docker container ([Dockerfile](Dockerfile)) — run it on any host
that can serve HTTPS (a VPS, Fly.io, Render, Railway, Cloud Run, Kubernetes, …):

```bash
docker build -t lexware-mcp .
docker run -p 8080:8080 --env-file .env lexware-mcp
```

Production notes:
- Serve over **HTTPS** (terminate TLS at your platform or a reverse proxy).
- Set auth via env (`OAUTH_ISSUER…` or `MCP_AUTH_TOKEN`) — the server fails closed otherwise.
- **Run a single instance** (or cap autoscaling to 1): the ~2 req/s rate limiter is
  per-process, so multiple instances would aggregate beyond Lexware's limit.
- Health check: `GET /status` (returns `200`).

**Google Cloud Run:** a step-by-step recipe (Secret Manager + `gcloud run deploy` + custom
domain) is in [docs/cloud-run.md](docs/cloud-run.md).

## How it works

- `src/config.ts` — env parsing/validation, fail-closed auth, capability tiers.
- `src/auth.ts` — constant-time static-bearer middleware on `/mcp`.
- `src/lexware/` — rate-limited (~2 req/s, token bucket), retry-aware client with safe error
  mapping; never retries non-idempotent POSTs on ambiguous failures (no duplicate documents).
- `src/tools/` — tools registered conditionally by tier.
- `src/server.ts` — wires it together on the Skybridge Express server.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run dev` starts the Skybridge dev server +
DevTools at `http://localhost:3000`.

## License

[MIT](LICENSE) © marselsel.
