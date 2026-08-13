# Lexware Office MCP Server

[![CI](https://github.com/marselsel/Lexware-MCP-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/marselsel/Lexware-MCP-Server/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/marselsel/Lexware-MCP-Server)](https://github.com/marselsel/Lexware-MCP-Server/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

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

62 tools across three tiers you enable via environment variables, plus one opt-in tool
outside them (`upload-file-from-url`, see below):

| Tier | Default | What it covers |
|------|---------|----------------|
| **Read** | always on | Profile; contacts & articles (list/get); the voucherlist (plus `summarize-vouchers` for server-side totals); full documents (invoices, quotations, credit notes, order confirmations, delivery notes, dunnings, down-payment invoices, vouchers); **render any document type to PDF** and **download files/receipts** (returned inline as embedded resources); batch & type-dispatched reads (get-vouchers, get-document, get-voucher-file, get-document-file); payments; reference data (countries, payment conditions, posting categories, print layouts); recurring templates (get & list); event subscriptions; document deeplinks |
| **Drafts/writes** (`LEXWARE_ENABLE_DRAFTS`) | on | Create **draft** invoices/quotations/credit-notes/order-confirmations/delivery-notes/dunnings (the Lexware API has no update endpoint for these — set every field, including payment terms, at creation); create & update contacts, articles, and **bookkeeping vouchers**; **upload files** and **attach receipts** to vouchers — inline as base64, or **without base64** via a short-lived upload ticket (`create-upload-ticket` → browser drag-and-drop or a `curl` one-liner → `get-upload-result`); create documents as **follow-ups** (`precedingSalesVoucherId`) |
| **Finalize** (`LEXWARE_ENABLE_FINALIZE`) | off | Issue **legally binding** finalized documents in one step via the dedicated `create-finalized-*` tools (confirmation-gated); irreversible article deletes; **manage webhook event subscriptions** (create + delete — a webhook streams financial events to an external URL, so it's opt-in). Enabling this tier also enables Drafts. |

Set `LEXWARE_READ_ONLY=true` to force read-only (overrides the flags above).

#### `upload-file-from-url` — outside the tiers, off by default

One tool sits outside this table: `upload-file-from-url` fetches a file from a share link
**server-side** and stores it in Lexware, which is how a receipt already sitting in
OneDrive/SharePoint gets into the books without a round trip through the model. It is
enabled with `LEXWARE_ENABLE_URL_UPLOAD=true` and needs the drafts tier (it will not turn
that tier on for you).

It has its own switch because it has its own risk: it is the only tool that makes this
server originate an outbound request to a destination the model chose — server-side
request forgery, in the general case. Three things bound it, applied at **every** redirect
hop:

1. **A host allow-list**, matched on a dot boundary so `evilsharepoint.com` cannot pass as
   `sharepoint.com`. Configure with `LEXWARE_UPLOAD_ALLOWED_HOSTS`; unset means the
   Microsoft file-sharing defaults, a set value replaces them, an empty value blocks
   everything.
2. **A resolved-address check** rejecting loopback, private, link-local (including the
   `169.254.169.254` metadata endpoint), CGNAT, multicast and reserved space, in every
   IPv4, IPv6 and IPv4-in-IPv6 spelling.
3. **Connection pinning.** The socket connects to an address from the very lookup that
   step 2 approved, rather than letting the HTTP client resolve the name again. Without
   this, steps 1 and 2 describe one lookup and the connection uses another, and a DNS
   answer that changes in between (rebinding) slips past a check that looked correct.
   TLS is unaffected: the certificate is still validated against the hostname.

Only `https` is accepted, the download is capped at 20 MB and 30 s, and redirects are
followed manually — at most three — so no hop skips the checks.

### What that looks like in practice

> *"Summarize my open invoices for this quarter — who still owes what?"*
>
> *"Draft an invoice to Müller GmbH for 12 consulting hours at 140 €, due in 14 days."*
>
> *"Here's the Hetzner receipt for June — file it in the bookkeeping."* → see
> [Uploading receipts](#uploading-receipts-no-base64-through-the-model)
>
> *"Render invoice RE-2026-0042 as a PDF and give me the deeplink to it."*

## Uploading receipts (no base64 through the model)

Attaching a file through a chat has an awkward default: `upload-file` needs the bytes as
base64 **inside the model's tool call**, so the whole receipt travels through the
conversation — every byte billed as tokens (base64 adds ~33% on top), the file's contents
sitting in the transcript, and a ~8 MB practical ceiling. The model never needed the bytes;
it only needs the **file id** that comes back.

The ticket flow routes the bytes *around* the model:

1. You ask Claude to file a receipt. It calls **`create-upload-ticket`** and hands you a
   link like `https://your-server…/upload/<ticket>`.
2. You open the link and **drag the file onto the page** — or run the ready-made `curl`
   one-liner next to a local file (replace only the `FILE=` path; nothing else needs to be
   installed or edited). The bytes go client → server → Lexware directly.
3. Claude reads the resulting file id with **`get-upload-result`** (the `curl` variant
   prints it directly) and carries on with the actual bookkeeping — e.g. `create-voucher`
   with `files: [fileId]`, or linking the receipt to an existing voucher.

**The ticket is the credential.** It is minted only through the authenticated `/mcp`
endpoint (drafts tier), is 24 random bytes (192-bit) rendered base64url, valid for
15 minutes, single-use, and write-only — it authorizes exactly one file drop and grants no
read access. The `/upload/:ticket` endpoint sits outside the OAuth gate *by design* (a
plain browser or `curl` holds no MCP token); this is the same trust model as a pre-signed
upload URL. Filenames travel as `X-Filename-B64` (base64url of the UTF-8 bytes), so
umlauts, dashes, typographic quotes and emoji arrive in the books intact.

The ticket store is in-memory: run a single instance (see [Deploy](#deploy)), and note
that a restart voids open tickets — they answer `410`, and you simply issue a new one.

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
git clone https://github.com/marselsel/Lexware-MCP-Server && cd Lexware-MCP-Server
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
| `OAUTH_RESOURCE` / `SERVER_URL` | `http://127.0.0.1:$PORT` | This server's public URL. **Required in OAuth mode** (token audience / Resource Indicator), and used in *every* mode to build the upload links `create-upload-ticket` hands out (browser URL and `curl` command). Set it whenever the server is reachable under a real domain — without it those links point at the loopback fallback, which only works on the server itself |
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
| `LEXWARE_ENABLE_URL_UPLOAD` | `false` | Enable `upload-file-from-url` (server-side fetch). Requires the Drafts tier; does not enable it |
| `LEXWARE_UPLOAD_ALLOWED_HOSTS` | Microsoft file-sharing hosts | Hosts `upload-file-from-url` may fetch from, comma-separated. Replaces the defaults; empty blocks everything |
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
- **Run a single instance** (or cap autoscaling to 1), for two reasons: the ~2 req/s rate
  limiter is per-process, so multiple instances would aggregate beyond Lexware's limit —
  and upload tickets live in process memory, so behind a load balancer without sticky
  sessions an upload can land on an instance that never issued its ticket.
- Health check: `GET /status` (returns `200`).

**Google Cloud Run:** a step-by-step recipe (Secret Manager + `gcloud run deploy` + custom
domain) is in [docs/cloud-run.md](docs/cloud-run.md).

## How it works

- `src/config.ts` — env parsing/validation, fail-closed auth, capability tiers.
- `src/auth.ts` — constant-time static-bearer middleware on `/mcp`.
- `src/lexware/` — rate-limited (~2 req/s, token bucket), retry-aware client with safe error
  mapping; never retries non-idempotent POSTs on ambiguous failures (no duplicate documents).
- `src/tools/` — tools registered conditionally by tier.
- `src/uploads/` — the single-use ticket store and the raw-body `/upload/:ticket` routes
  (mounted only with the drafts tier; the ticket is the credential).
- `src/server.ts` — wires it together on the Skybridge Express server.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run dev` starts the Skybridge dev server +
DevTools at `http://localhost:3000`.

## License

[MIT](LICENSE) © marselsel.
