# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9]

Dependency maintenance only — no functional or behavioural change to the server.

### Changed
- **Dependencies bumped** ([#35]): TypeScript `^6.0.2` → `^7.0.2`, `skybridge` `^1.2.4` → `^1.3.3`,
  `@skybridge/devtools` `^1.0.0` → `^1.3.3`, `vite` `^8.1.3` → `^8.2.0`, `jose` `^6.2.3` → `^6.2.8`,
  plus `tsx`, `@types/node` and `vitest` patches. `npm audit` now reports **0 vulnerabilities**: the
  remaining low-severity `esbuild` advisory was reached through `skybridge` and is cleared by 1.3.3.
- **CI**: `actions/setup-node` `v6` → `v7` ([#30]).

Two upgrades here carry non-obvious risk and were verified explicitly rather than assumed. TypeScript 7
is a major bump, and compiles the 0.1.8 OAuth additions without error. More importantly, `skybridge`
1.3.3 could have broken `deferMcpBodyParsing`, which locates a layer named `jsonParser` inside
Express's private router stack in order to raise the `/mcp` body limit — a failure there is *silent*,
guarded by a fallback that only surfaces as a startup warning, and no test would catch it. Confirmed
intact both by the startup line (`bodyLimit=12mb (/mcp, post-auth)`) and functionally: a 488 KB
authenticated `POST /mcp` returns 200, while the same body unauthenticated returns 401 — rejected
before it is ever parsed.

[#30]: https://github.com/marselsel/lexware-mcp/pull/30
[#35]: https://github.com/marselsel/lexware-mcp/pull/35

## [0.1.8]

Interoperability with IdPs that do not honour the OAuth Resource Indicator (Microsoft Entra in
particular). Both options are unset by default and change nothing for existing deployments.
Thanks to [@gutencoder](https://github.com/gutencoder) for both features.

### Added
- **`OAUTH_AUDIENCE`: accept additional `aud` values.** ([#32]) Comma-separated, additive to the audience
  derived from `OAUTH_RESOURCE`. Some IdPs ignore the Resource Indicator and mint a token whose `aud`
  is not the resource URL at all — Microsoft Entra always puts the API's client ID (a GUID) in the `aud`
  of a v2.0 access token, never the Application ID URI. Previously the expected audience was derived
  from `OAUTH_RESOURCE` alone, and `OAUTH_RESOURCE` is forced through a URL/HTTPS validation, so a bare
  GUID could not be expressed at all: the audience check could never match and every token was rejected
  with 401 even though sign-in, scope and assignment were correct. The only escape was
  `OAUTH_VERIFY_AUDIENCE=false`, which accepts *any* token from the issuer (confused-deputy risk).
  `OAUTH_VERIFY_AUDIENCE` stays `true` with this option — the check is still enforced, just against a
  value the IdP actually issues. Unset by default; no change for existing deployments.
- **`OAUTH_SCOPES_SUPPORTED`: advertise scopes in the protected-resource metadata.** ([#33]) Comma-separated;
  passed through to `mcpAuthMetadataRouter` as `scopesSupported`, which publishes it as
  `scopes_supported` (RFC 9728). The SDK has always supported the option, but the server never passed
  it and there was no way to configure it, so the protected-resource document named no scopes at all.
  A client that discovers the server through that document therefore has nothing to put in the
  authorization request's `scope` parameter and may omit it — which some IdPs reject outright
  (Microsoft Entra: `AADSTS900144: The request body must contain the following parameter: 'scope'`),
  breaking sign-in before it starts. Unset by default: no scopes are advertised and the document is
  unchanged, so existing deployments are unaffected.

  The value drives **both** well-known documents. `buildOAuthMetadata` previously hardcoded
  `scopes_supported: ["openid","email","profile"]` on the authorization-server document, so
  configuring scopes for a non-WorkOS IdP would have left the two documents contradicting each other
  — the protected-resource doc naming (say) `api://<id>/mcp.access` while the authorization-server doc
  still claimed `openid email profile`. When `OAUTH_SCOPES_SUPPORTED` is unset the authorization-server
  document keeps that historic default, so existing deployments see no change.

  Scopes may be separated by commas **or** whitespace. A scope value can never contain a space
  (RFC 6749 §3.3), so `OAUTH_SCOPES_SUPPORTED="openid email profile"` — the form scopes take
  everywhere else in OAuth — is unambiguous, and previously became a single invalid scope.

### Security
- **Dependency advisories cleared.** `npm audit fix` (lockfile only — no declared dependency range
  changed) resolved 9 advisories, 4 of them high: `fast-uri` host confusion, `ip-address` SSRF and
  trust-boundary bypass, `postcss` source-map path traversal, and a `hono` CORS ReDoS. One low
  advisory remains (`esbuild`, reached via `skybridge`), a Windows dev-server issue that does not
  affect the Linux container. This also restores CI's `npm audit --omit=dev --audit-level=high` gate,
  which had been failing on `main`.

[#32]: https://github.com/marselsel/lexware-mcp/pull/32
[#33]: https://github.com/marselsel/lexware-mcp/pull/33

## [0.1.7]

### Added
- **Line items expose `optional` and `alternative`** on every document create tool (invoice, quotation,
  credit-note, order-confirmation, delivery-note — shared `lineItemSchema`). `optional` marks an optional
  position (shown with its price but not counted in the total); `alternative` marks an alternative position.
  Both are string-coercible and forwarded to the Lexware API. Previously these lexoffice fields weren't
  modelled, so the model had no way to know it could set them.

## [0.1.6]

### Fixed
- **Removed the non-functional `archived` param from create-contact / update-contact.** `archived` is
  **read-only** on the Lexware contacts API (confirmed against the docs and live: a `PUT` with
  `archived:true` is accepted and bumps the version but leaves the contact active). The param silently did
  nothing and misled the model into thinking it could archive/hide contacts. Archiving a contact is a
  web-app-only action; there is no contact delete via the API.

## [0.1.5]

Hardening pass from a code review of 0.1.4.

### Fixed
- **Error-body reads are now classified too.** A failure while reading a non-2xx response body
  (connection reset / timeout mid-stream) previously threw a raw `TypeError`; it now yields a
  `LexwareApiError` carrying the real HTTP status, so a 404 stays a 404 and idempotent-delete handling
  keeps working.
- **`create-draft-*` fails loudly on a stale `finalize=true`.** After finalization moved to the
  dedicated `create-finalized-*` tools, a client still sending `finalize:true` had it silently stripped
  and got a draft + success. The draft tools now reject `finalize`/`confirm_finalize` with a clear
  pointer to `create-finalized-*`.
- **One-off voucher `contactName`** now also sets `useCollectiveContact:true` (lexoffice pairs a custom
  contact name with the collective contact), so switching a referenced voucher to a one-off name doesn't 406.
- **Base64 validation** no longer rejects non-canonical (but universally decodable) padding, and validates
  via a charset+length check instead of re-encoding the whole payload (cheaper for multi-MB uploads).
- **Delete tools** return an `alreadyAbsent` flag so callers can tell "deleted it" from "it never existed".

### Changed
- **The raised upload body limit no longer widens the pre-auth surface.** The 12 MB JSON parser is mounted
  on `/mcp` *after* the auth gate; other routes keep the ~100 KB default. An unauthenticated request can no
  longer force a multi-MB parse. The limit is applied via an in-place handler swap (robust to Express
  internals), and if it can't be applied the server now logs a loud WARNING instead of a quiet token.
- **Webhook event subscriptions moved to the finalize tier** (create + delete, gated together, off by
  default): a webhook streams financial events to an arbitrary external URL, so it's now opt-in rather than
  available by default.
- **`additionalFields` is now on every create tool** (contacts, articles, vouchers, documents), not just
  documents, closing the same silent top-level-strip data loss everywhere. Reserved control keys
  (`finalize`, `version`, `id`, …) are stripped from it so they can't be smuggled into a request body.
- Finalize force-enabling drafts, and a failure to raise the body limit, now emit explicit startup WARNINGs.

## [0.1.4]

### Fixed
- **Large file uploads no longer fail.** `upload-file` / `upload-voucher-file` bodies over ~75 KB were
  rejected before reaching the tool, because Skybridge pre-applies `express.json()` at body-parser's
  ~100 KB default. The JSON body limit is now raised to 12 MB, so multi-MB receipts upload as documented.
- **`get-document`** dispatches `voucherType: "recurringtemplate"` (a value the voucherlist returns) to
  `/v1/recurring-templates/{id}` instead of throwing "Unknown voucherType".
- **`update-voucher`**: passing a one-off `contactName` now clears the `contactId` carried over from the
  current voucher (they can't coexist — lexoffice 406 `custom_contact_name_for_referenced_contact_not_allowed`).
  Its `version` param now also accepts a string-serialized number, like the other update tools.
- **Base64 uploads are validated** — a malformed payload (e.g. a leftover `data:…;base64,` prefix) is
  rejected with a clear error instead of silently uploading corrupt bytes.
- **`confirm_finalize`** accepts the string `"true"` from clients that serialize booleans as strings
  (finalization was previously unreachable for them).
- **`summarize-vouchers`** reports the correct `pagesScanned` when the `maxPages` cap is hit (was off by one).
- **HTTP client**: a failure while reading a response body (timeout/reset mid-stream) is mapped to a
  classified `LexwareApiError` instead of leaking a raw `DOMException`/`TypeError`; abandoned response
  bodies are drained before a retry so keep-alive sockets are reused; a long plain-text error body is
  truncated (not dropped); the HTTP-date `Retry-After` path uses the injectable clock.
- **Idempotent deletes**: `delete-article` / `delete-event-subscription` treat a 404 as already-gone
  instead of reporting a false failure when a retried delete's first attempt already succeeded.
- Empty list results render `page 1/1` instead of the impossible `page 1/0`.
- Static-bearer `401` responses include a `WWW-Authenticate` challenge (RFC 9110).

### Changed
- **Finalization is now only via the dedicated `create-finalized-*` tools.** The `finalize` /
  `confirm_finalize` flags were removed from `create-draft-*` (a legally-binding write must never be a flag
  on a draft tool). One-step issuing still works — call `create-finalized-<type>` (finalize tier).
- **Enabling the finalize tier now also enables drafts**, so a deployment can never expose only the
  irreversible `create-finalized-*` tools with no safe draft path.
- **`delete-event-subscription` moved to the drafts tier**, symmetric with `create-event-subscription`:
  unsubscribing just stops a webhook and is trivially recreatable.
- OAuth authorization/token/registration endpoints in the AS metadata are now **overridable**
  (`OAUTH_AUTHORIZATION_ENDPOINT`, `OAUTH_TOKEN_ENDPOINT`, `OAUTH_REGISTRATION_ENDPOINT`); WorkOS-layout
  defaults are unchanged, so non-WorkOS issuers (Auth0, Keycloak) can advertise correct endpoints.
- An OAuth request from a disallowed email domain returns **403** (valid token, not authorized) instead of
  401, which made some clients loop re-authenticating.
- Advertised MCP server version bumped to **0.1.4**.

### Added
- **`additionalFields`** escape hatch on document create tools: valid Lexware body fields not modeled by the
  schema (e.g. `xRechnung`) can be passed and are merged into the request, rather than being silently
  stripped by the SDK's strip-mode top-level object.
- Startup warning when `/mcp` is unauthenticated.

### Security
- `create-event-subscription` requires an `https://` `callbackUrl` (matches Lexware's Grade-A HTTPS
  requirement), and `delete-event-subscription` is available whenever create is — so a webhook opened by,
  e.g., prompt-injected content can always be removed.

## [0.1.3]

### Added
- `summarize-vouchers` (read tier) — server-side aggregation over the voucherlist for a date range:
  paginates all matches and returns counts plus summed **gross** (`totalAmount`) and **open**
  (`openAmount`) amounts, grouped by `voucherType` / `voucherStatus` / `month` / `contact` / `currency` /
  `none`. Avoids blowing the token limit on large ranges (no per-row dump). The net/VAT split is not in the
  voucherlist, so this reports gross only. A `maxPages` cap (default 40 × 250) flags `truncated` if hit.

### Changed
- Advertised MCP server version bumped to **0.1.3** so clients pick up the new `summarize-vouchers` tool.

## [0.1.2]

### Changed
- Advertised MCP server version bumped to **0.1.2** — the tool surface shrank (65 → 59) after
  removing the non-functional `update-draft-*` tools; the version change also nudges MCP clients to
  drop the stale tools from a cached tool list.

### Added
- `paymentConditions` on every `create-draft-*` / `create-finalized-*` document body
  (`paymentTermLabel` + `paymentTermDuration` in days). The payment term can now be set at
  creation; previously the field was silently dropped (it was not in the input schema), so
  invoices fell back to the account default ("Zahlbar sofort, rein netto").

### Removed
- `update-draft-<type>` for invoices/quotations/credit-notes/order-confirmations/delivery-notes/
  dunnings. These always failed with **404 Not Found**: the Lexware Office REST API exposes only
  GET and POST for those document types — there is no PUT/update endpoint (unlike
  contacts/articles/vouchers, whose update tools remain). A draft document cannot be patched after
  creation; set all fields at creation via `create-draft-*`, or recreate the draft and delete the
  old one in the web app.

## [0.1.1]

### Added
- Advertised MCP server version bumped to **0.1.1** — reflects the expanded tool surface
  (41 → 65 tools) and the read-modify-write update tools; the version change also nudges MCP
  clients to refresh a stale cached tool list (e.g. so `update-contact`/`create-contact`
  pick up the `addresses` and `company.vatRegistrationId`/`taxNumber`/`allowTaxFreeInvoices` fields).
- **Files & PDF (binary) support** — the client now speaks binary, not just JSON:
  - `download-file` (GET a stored file) and document `render-<type>-pdf`
    (invoice/quotation/credit-note/delivery-note: render via `/document`, then download)
    return the bytes inline as MCP embedded resources.
  - `upload-file` and `upload-voucher-file` send `multipart/form-data` (file as base64 in).
- **Bookkeeping vouchers** — `create-voucher`, `update-voucher`, and `upload-voucher-file`
  (attach a receipt) for manually-booked sales/purchase transactions.
- **Document draft-updates** — `update-draft-<type>` for the six writable document types
  (optimistic locking via `version`).
- `list-recurring-templates` (read) and `delete-article` (finalize tier, destructive).
- Two new `LexwareClient` methods — `getBinary` and `postMultipart` — sharing the existing
  rate-limit/retry transport; multipart deliberately omits `Content-Type` (fetch derives the boundary).

### Added — initial release
- Initial open-source release of the Lexware Office MCP server (Skybridge MCP App) —
  a remote/hosted, OAuth-capable connector for the Claude app, claude.ai web, and ChatGPT.
- **Tiered tools** across read / draft / finalize:
  - **Read** (always on): profile; contacts & articles (list/get); voucherlist; full
    documents (invoices, quotations, credit notes, order confirmations, delivery notes,
    dunnings, down-payment invoices, vouchers); payments; reference data (countries,
    payment conditions, posting categories, print layouts); recurring templates; event
    subscriptions; document deeplinks.
  - **Drafts/writes** (`LEXWARE_ENABLE_DRAFTS`, on): create draft invoices/quotations/
    credit-notes/order-confirmations/delivery-notes/dunnings; create & update contacts and
    articles (optimistic locking); create event subscriptions.
  - **Finalize** (`LEXWARE_ENABLE_FINALIZE`, off): issue legally-binding finalized
    documents (confirmation-gated); irreversible deletes (e.g. delete event subscriptions).
- Authentication on `/mcp`, fail-closed, in two modes:
  - **Static bearer token** (`MCP_AUTH_TOKEN`) for Claude Code/Desktop.
  - **OAuth 2.1** (`OAUTH_ISSUER`, …) via any provider (e.g. WorkOS AuthKit) — exposes
    `/.well-known/oauth-protected-resource`, validates JWT access tokens against the
    provider's JWKS, and optionally restricts `OAUTH_ALLOWED_EMAIL_DOMAINS` (enforced
    server-side). Enables use as a custom connector in the Claude app and on claude.ai web.
- `~2 req/s` rate limiting with 429/`Retry-After` backoff, and capability tiers via env flags.
- Docker image, `docker-compose.yml`, Cloud Run guide, CI, and tests.

### Known limitations
- A few write shapes are typed leniently and carry `VERIFY` notes pending confirmation
  against live data: bookkeeping-voucher fields, the file-upload `type` field, and whether
  document draft-updates use optimistic-locking `version`. Wrong guesses surface as a clean
  4xx (`LexwareApiError`), never silent data loss.
- `render-<type>-pdf` is wired for invoice/quotation/credit-note/delivery-note; dunning,
  order-confirmation, and down-payment rendering await a read-only live check of `/document`.
