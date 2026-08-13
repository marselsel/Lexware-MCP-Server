# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.13]

Robustness fixes surfaced by a full security audit and code-review pass of the server. No
behaviour changes for valid input; no security vulnerabilities were found.

### Fixed
- **`upload-file-from-url`: an empty-string `mimeType` override no longer files the receipt with a
  blank content type.** It now falls through to the response-derived type (`||`, not `??`), matching
  the ticket flow's guard and the filename handling in the same tool.
- **A present-but-unusable `Content-Disposition` `filename*` no longer discards a valid plain
  `filename=` beside it.** An empty or control-character-only extended value degrades to the plain
  form; RFC 6266 precedence is preserved (`filename*` still wins whenever it decodes to a usable name).
- **`get-document` rejects an unknown `voucherType` cleanly** (`Object.hasOwn`), instead of letting a
  prototype key such as `toString` resolve to an inherited function that stringified into the request
  path (which reached Lexware only as a same-host 404 — no host escape, no key exposure).
- **`postMultipart` classifies a mid-read failure after a 2xx as a network error**, like the other
  client methods, rather than surfacing a raw transport error.
- **The default upload host allow-list is returned as a copy**, not the shared module array by
  reference — pre-empting any future in-place mutation corrupting the process-wide default.

## [0.1.12]

The server-side URL fetcher held back in 0.1.11 — now with its DNS-rebinding TOCTOU closed by
connection-level IP pinning. Based on the contribution by
[@gutencoder](https://github.com/gutencoder) ([#39]); a review pass on top tightened the filename
handling and a few edges (see **Fixed** below).

### Added
- **`upload-file-from-url`, with the DNS-rebinding TOCTOU closed** — the tool held back from
  [#34] in 0.1.11, returning with the connection-level IP pinning that release asked for. It fetches a
  file from a share link server-side and stores it in Lexware, so a receipt already sitting in
  OneDrive/SharePoint reaches the books without its bytes passing through the model context.
  **Off by default** (`LEXWARE_ENABLE_URL_UPLOAD=false`) and gated separately from the drafts tier it
  writes through: it is the only tool that makes this server originate an outbound request to a
  destination the model chose, and that is not something to acquire as a side effect of enabling
  drafts. Setting it without the drafts tier warns rather than silently doing nothing.
- **`LEXWARE_UPLOAD_ALLOWED_HOSTS`** — the hosts that tool may fetch from, comma-separated, matched on
  a dot boundary (`evilsharepoint.com` never passes as `sharepoint.com`). Unset means the built-in
  Microsoft file-sharing list; a configured value **replaces** it rather than extending, so those
  domains can be opted out of; an **empty** value blocks every host, which is how the fetcher is
  switched off without unregistering it (and warns, so a typo is not mistaken for an open door).

### Security
- **The connection is pinned to the address that was checked.** The 0.1.11 note recorded why the
  fetcher was withheld: its guards resolved the host, validated every returned address, and then let
  `fetch` resolve the name a second time when it opened the socket — so the address that was
  *approved* and the address that was *connected to* came from two different lookups, and a DNS
  answer that changed in between (short TTL, or deliberate rebinding) walked past a check that
  looked correct. `src/uploads/pinned-fetch.ts` removes the second lookup: the socket is given the
  addresses the check just approved and never resolves anything. There is no longer a window between
  the two, because there is no longer a second lookup to disagree with the first.
  - Implemented on `node:https`'s `lookup` hook rather than an undici dispatcher, so **no runtime
    dependency is added** to a server that fronts accounting data — and no second copy of undici
    enters the process beside the one backing `fetch`.
  - **TLS is untouched.** SNI and certificate validation still bind to the hostname; only the address
    dialled comes from the pin. A test reads the SNI out of the raw ClientHello on the wire to hold
    that property, rather than trusting the client to report on itself.
  - Sockets are never pooled across requests (`keepAlive: false`, a fresh agent per request), so a
    connection opened for a differently vetted request cannot be reused.
- The allow-list and per-hop address checks from #34 are unchanged and still apply first; pinning is a
  third layer, not a replacement for either.

### Fixed
- **The stored filename now goes through the same sanitizer the ticket flow uses.** The model-supplied
  `filename` override and the URL's own basename previously reached Lexware and the logs unsanitized —
  only the `Content-Disposition` name was cleaned. A trailing-slash URL (`…/x/`) with no other name
  produced an **empty** filename (`"" ?? "download.bin"` keeps the empty string); a `filename` of
  `../../etc/passwd`, an embedded CRLF, or a 300-character string passed straight through. All three
  candidates now run through `sanitizeFilename` — empty degrades to `download.bin`, and the URL
  basename is percent-decoded first.
- **URLs carrying embedded credentials are refused** (`https://user:pass@host/…`), on the first URL and
  every redirect hop. The `node:https` transport would otherwise turn userinfo into an
  `Authorization: Basic` header on the wire; the `fetch` it replaced refused such URLs, and that
  refusal is restored.
- **A leading dot on an allow-list entry (`.sharepoint.com`) no longer silently blocks everything** —
  it is stripped, since subdomain matching is already on a dot boundary.

[#39]: https://github.com/marselsel/lexware-mcp/pull/39

## [0.1.11]

Upload a receipt without pushing its bytes through the model context. Based on the
contribution by [@gutencoder](https://github.com/gutencoder) ([#34]); the server-side
URL-fetch tool from that PR was intentionally held back (see **Security** below).

### Added
- **`create-upload-ticket` / `get-upload-result` (drafts tier).** The existing `upload-file` /
  `upload-voucher-file` tools take the file as base64 inline in the JSON-RPC body, so every byte is
  billed as tokens, sits in the conversation transcript, and a ~8 MB receipt runs into the 12 MB body
  limit — the file travels through the model even though the model only needs the resulting file id.
  `create-upload-ticket` issues a short-lived (15 min), single-use ticket and returns a browser URL for
  drag-and-drop plus a ready-to-run `curl` command; the bytes go client → server → Lexware and the
  model only ever sees the file id. `get-upload-result` reads that id back after a browser upload (the
  `curl` path prints it directly). `filename` / `mimeType` travel as `X-Filename-B64` (base64url of the
  UTF-8 bytes), so names with an en dash, typographic quotes or an emoji survive a header layer that is
  Latin-1 on the wire.
- **`SERVER_URL` (or `OAUTH_RESOURCE`) now applies in every auth mode**, not only OAuth. It is the
  server's public URL, and `create-upload-ticket` builds its browser link and `curl` command from it;
  a static-token deployment behind a real domain previously had it ignored and handed out loopback
  links. Unset, the loopback fallback still applies, on the port actually bound (`__PORT` under
  `skybridge dev`, else `PORT`).

### Changed
- The existing base64 upload tools are unchanged and remain available — the ticket route is additive.
- **Body parsing now also defers `/upload` paths** from the pre-applied global JSON parser, alongside
  `/mcp`: the upload route reads the raw body itself, and letting the JSON parser run first turned a
  JSON-content-typed upload into an empty file. The route additionally rejects gzip framing
  (`inflate: false`), rejects an invalid/expired/used ticket before reading any body, buffers at most
  one request body per ticket at a time, and holds a synchronous single-use lock across the upload so
  **concurrent or duplicated requests** cannot file a second voucher while an attempt is in flight.
  One case is deliberately weaker: after a transport failure whose outcome is unknown (the upload may
  or may not have reached Lexware), the ticket is released so a retry stays possible, and the error
  says to check for the file before re-uploading — blind retries after such a failure can still
  duplicate a receipt, which no client-side lock can prevent without upstream idempotency support.

A post-integration review pass hardened the details: the upload result stays readable via
`get-upload-result` for a full 15 minutes **after the upload completed** (previously it expired on the
ticket's creation-time clock, so a minute-14 upload left a sub-minute read window and invited a
duplicate); the generated `curl` command pins `Content-Type` explicitly (curl's `--data-binary`
otherwise silently declared `application/x-www-form-urlencoded` and bypassed the documented fallback
chain); a 401/403 from Lexware — the operator's API key being rejected — is answered as a generic 502
instead of forwarding the upstream status and wording to the unauthenticated uploader;
`get-upload-result` is annotated read-only so polling it doesn't trigger write-tool confirmations; the
loopback link fallback follows `__PORT` under `skybridge dev`; and `OAUTH_RESOURCE` outside OAuth
mode still takes precedence over `SERVER_URL` for upload links, but now announces itself with a
startup warning instead of doing so silently.

The ticket store is **in-process**, so this is a single-instance feature: a restart drops open tickets
(they answer `410`, they do not hang), and behind a load balancer without sticky sessions an upload can
reach a different instance than the one that issued the ticket. The 15-minute lifetime bounds the
window. The upload route is mounted **only when the drafts capability is enabled** — a read-only
deployment never exposes it — and the ticket page is served `Cache-Control: no-store`.

### Security
- **The server-side URL-fetch tool (`upload-file-from-url`) from #34 was deliberately NOT included.**
  A server-side fetcher is SSRF surface by construction; the version in #34 is guarded by a host
  allow-list and per-hop private-address checks but carries a DNS-rebinding TOCTOU — the resolved
  address is validated, then the connection re-resolves independently — which is moot for the built-in
  Microsoft defaults but live for any custom allow-list. It will be reconsidered separately, with
  connection-level IP pinning and disabled by default. The ticket flow above carries no such surface.

[#34]: https://github.com/marselsel/lexware-mcp/pull/34

## [0.1.10]

### Fixed
- **`registration_endpoint` is no longer advertised unconditionally.** `buildOAuthMetadata`
  hardcoded `{issuer}/oauth2/register` into the authorization-server metadata whether or not the
  issuer actually supports Dynamic Client Registration. Disabling DCR on the issuer therefore left
  this server advertising an endpoint that answers `400 dynamic_client_registration_disabled`,
  while the issuer's own metadata correctly omitted it — so a client discovering us would attempt
  registration and fail, instead of concluding DCR is unavailable and using a pre-registered
  client. `registration_endpoint` is optional in RFC 8414; omitting it is the correct signal.

  Set `OAUTH_REGISTRATION_ENDPOINT=none` to omit the field. Unset keeps the derived default, so
  existing deployments are unchanged.

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
