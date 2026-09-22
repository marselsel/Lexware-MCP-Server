# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- `npm start` now sets `NODE_ENV=production`. Without it Skybridge also mounted its devtools and a
  Vite dev server — unauthenticated, CORS-open, on every interface — so the README's "Without
  Docker" path ran a dev server in production. `/mcp` stayed gated; the Docker image was never
  affected (it sets `NODE_ENV` itself). `npm start` is now POSIX-shell only, like the README.
- The Lexware client refuses a `.`/`..` path segment (and its `%2e` spellings). `encodeURIComponent`
  leaves those intact and `new URL` resolves them, so an id of `..` retargeted a call one level up
  (`upload-voucher-file` with `id: ".."` posted to `/v1/files`). Nothing reachable that way crossed
  a capability tier, but the path is no longer the caller's to choose.
- The URL-upload SSRF blocklist also covers IPv6 multicast (`ff00::/8`), local-use NAT64
  (`64:ff9b:1::/48`), Teredo (`2001::/32`) and discard-only (`100::/64`). Defense in depth: hosts
  must already be on the allowlist.
- CI runs with a read-only `GITHUB_TOKEN` and pins actions to commit SHAs (Dependabot keeps them
  current). `.npmrc` is gitignored so an npm auth token can't be committed.
- `create-finalized-*` and the three update tools (`update-contact`, `update-article`,
  `update-voucher`) are now annotated `destructiveHint: true`. They were `false`, so a client had no
  reason to ask a human before the model issued a legally binding document — `confirm_finalize` is
  a value the model sets itself. The updates qualify because each one is a full-resource PUT that
  overwrites the record. Claude's connector review requires this annotation for tools that modify
  or delete data.

### Added
- Every tool has a human-readable `title` (e.g. "Issue invoice (finalize, irreversible)"), which
  clients show instead of the tool name. It is set both as the top-level `title` and as
  `annotations.title`: the spec reads the first, Anthropic's directory checklist asks for the second.
  A test pins titles, and which tools are read-only and destructive, for every tier.
- Server `instructions` (in the initialize result, or `server/discover` on the 2026-07-28 protocol): how the tools fit together, which no single tool
  description can say — the ~2 req/s limit and the tools that page server-side, finding a document
  by number, voucherlist row → document/PDF, the two date formats, why drafts cannot be fixed after
  creation, the upload-ticket flow. Built from the enabled tiers, and a test checks that every tool
  it names is actually registered for that tier. `serverInfo` also gains a `title`, `description`
  and `websiteUrl`.
- Every tool result now also carries its `structuredContent` as a compact JSON text block, after the
  one-line summary. The spec says a tool returning structured content SHOULD do this, and it matters
  here: each tool's text was only a summary ("Invoice X retrieved."), so a client that shows the model
  just `content` — Anthropic's own tool-design reference warns "not all hosts read
  `structuredContent` yet" — never saw the document itself. Applied once, in `registerTools`, to every
  handler; error results and non-object `structuredContent` (which the SDK already serializes) are
  left alone.
- Opt-in human confirmation before finalizing (`LEXWARE_FINALIZE_ELICITATION`, off by default).
  `create-finalized-*` answers its first call with a confirmation form (MCP elicitation, protocol
  2026-07-28) naming the recipient and date, and issues only when the client retries with a "yes"
  for the same arguments. The round-trip state is HMAC-signed and bound to the signed-in user
  (`LEXWARE_REQUEST_STATE_KEY`, random per process when unset), each approval issues one document,
  and changed arguments are asked about again rather than issued. `when-supported` falls back to
  today's behaviour on clients without form elicitation; `required` refuses there. Off by default
  because client support is uneven: claude.ai has none yet (anthropics/claude-ai-mcp#153) and Claude
  Cowork has been reported to hang on the request (#1046). Adds `@modelcontextprotocol/server` as a
  direct dependency, at the version Skybridge already runs on.

### Fixed
- A signed-in user whose email domain is not on `OAUTH_ALLOWED_EMAIL_DOMAINS` now gets a plain `403`
  with no `WWW-Authenticate` challenge. It was a `403` carrying `error="insufficient_scope"`, which
  is the MCP scope step-up signal: Claude answers it by sending the user back through sign-in, which
  cannot help, since no scope changes an email domain — so a refused user was looped instead of told.
  Claude treats only a challenge-free `403` as final. Authentication (the SDK's bearer gate: `401`
  plus a challenge for a missing or invalid token) and the domain decision are now separate steps,
  mounted together through `oauthGate` so neither can be wired up without the other.
- `OAUTH_RESOURCE` can now be the MCP endpoint (`https://host/mcp`), which is what it should be:
  Claude sends the URL users enter, path included, as the RFC 8707 `resource`, and requires the
  protected-resource metadata to name it exactly. Upload links are built from the same URL minus a
  trailing `/mcp` — before, following that advice produced `https://host/mcp/upload/…`, a route
  that does not exist. The metadata URL named in the 401 challenge moved into a tested helper.
- Startup warns when OAuth runs with `OAUTH_VERIFY_AUDIENCE=false`: the server then accepts any
  valid token from the issuer, including one minted for another app on it. WorkOS AuthKit supports
  Resource Indicators (RFC 8707) since May 2026, so the check can stay on there.

### Removed
- **Breaking:** the 14 per-type document tools — `get-invoice`, `get-quotation`, `get-credit-note`,
  `get-order-confirmation`, `get-delivery-note`, `get-dunning`, `get-down-payment-invoice` and the
  matching `render-<type>-pdf` tools. `get-document(id, voucherType)` and
  `get-document-file(resourceType, id, format)` already did the same for every type, so the default
  tier drops from 53 to 39 tools (about 14 fewer tool definitions in every conversation's context).
  Anthropic's tool guidance is that selection gets worse past 30–50 tools. `get-document`'s
  `voucherType` is now a published enum instead of a free string, and `get-document-file`'s
  description names the types that can return XML — the one thing the per-type render tools said
  in their schema. A saved prompt or client config that names a removed tool needs updating.

### Changed
- Nothing imports `@modelcontextprotocol/sdk` (the 1.x SDK) any more, and a test enforces it.
  skybridge 2 runs on the v2 packages but still *depends* on 1.x, so 1.x stays hoisted in
  `node_modules` and importing it resolves and typechecks while the running code is the v2 surface.
  That trap already cost one bug during the 2.0 migration — the 1.x `InvalidTokenError` is not an
  `instanceof` the v2 `OAuthError`, so a bad token would have answered 500 instead of 401. Four
  imports were left behind; the one that mattered pinned the RFC 9728 metadata tests against a
  router the server does not run. No behaviour change: the two implementations agree today.
- Removed the `AppType` export. It could never carry the tool types Skybridge's typed-client contract
  expects, because the tools are registered in loops over runtime arrays behind capability-tier
  checks, so it silently described an empty tool surface. Nothing consumed it.

### Documented
- Why no tool declares an `outputSchema`: the spec makes it binding, Lexware's payloads are
  open-ended, and Claude's clients still fail on declared output schemas (anthropics/claude-ai-mcp
  #673, #485, #1016). Recorded in `src/tools/shared.ts` and pinned by a test, so adding one is a
  deliberate choice.
- The README no longer says a static bearer token cannot work on claude.ai: an organization admin
  can add the connector with a static header (beta, limited organizations). OAuth stays the
  recommendation wherever users sign in individually.
- What the per-request tool registration costs, measured over HTTP against the built image: `/status`
  2.1ms, `initialize` 29.5ms, `tools/list` 41.3ms. ~79% of it is the SDK converting zod to JSON
  Schema on every registration — unreachable from here, since zod does not memoize the conversion
  (one hoisted instance converted 300 times costs the same every time) and `registerTool` only takes
  a raw field shape. Left as is, with the numbers next to the handler. Note that Skybridge's own
  "handler took 68ms" boot warning is the cold first build, not the recurring cost.
- That the inert app-level JSON parser also disarms the devtools "Deploy" button under
  `skybridge dev`. Dev-only, and that button targets a platform this server does not deploy to.

## [0.2.0]

Opens up the voucherlist — multi-value filters, created/updated date bounds, number lookup and
sorting — makes the e-invoice XML reachable rather than only its PDF preview, and fixes a contacts
search that silently matched nothing for any name containing `&`, `<` or `>`. Under that, the server
moves to skybridge 2.0.

Two of these are corrections to things the server previously advertised and should not have.
`get-voucherlist` offered three `voucherType`/`voucherStatus` values the API rejects outright, so a
model could only ever spend a request to get a 400; those are gone, and the two accepted values that
were missing (`unchecked`, `blank`) are in. And naming a `sortBy` without a direction returned the
*oldest* rows while the parameter's own description promised newest-first — a wrong answer that looks
entirely plausible. If you pass either of the removed filter values, or rely on the old bare-`sort`
behaviour, this release changes what you get back.

### Changed
- **Migrated to skybridge 2.0.** The HTTP surface moved off `McpServer` onto a new `Skybridge` app
  class, so `server.express` / `server.use` / `server.run` become `app.express` / `app.use` /
  `app.run`. `McpServer` keeps `registerTool` and is now the per-request registration object the
  `handler` receives, so none of the tool modules changed. Two consequences worth knowing:
  - **The body-parsing hack is gone.** Skybridge installs an app-level `express.json()` in its
    constructor, ahead of anything we can register — including the auth gate. 1.x dealt with that by
    finding the `jsonParser` layer inside `app._router.stack` and swapping its handler in place. 2.0
    has a public `json` config field, so that layer is made inert and `server.ts` mounts
    `express.json({limit:"12mb"})` on `/mcp` itself, *after* the auth gate. That removes the internals
    dependency and a whole bug class with it: the old approach needed path predicates of our own that
    had to agree with Express's routing, and a disagreement there had already reopened a
    gzip-amplification path once.
  - **A bad token still answers 401, not 500.** `src/oauth.ts` threw the 1.x SDK's
    `InvalidTokenError` / `InsufficientScopeError`. skybridge 2 classifies auth failures by
    `instanceof OAuthError`, and neither legacy class is one — so a bad token would have produced a
    bare 500 with no `WWW-Authenticate` header, leaving clients with no way to know they should
    re-authenticate, and the deliberate 403 for a disallowed email domain would have become a 500 too.
    The compiler cannot see this, because skybridge 2 still depends on the 1.x SDK and the imports
    still resolve. Now throws `OAuthError`, and a test asserts the error *code* rather than the
    message.

  The four security-relevant orderings in `server.ts` are asserted against a running container rather
  than read off the source: an oversized unauthenticated `POST /mcp` is rejected on the header (401,
  not 413), a JSON-content-typed upload still reaches `express.raw()` as a `Buffer`, `/upload` is not
  mounted at all under `LEXWARE_READ_ONLY`, and `/status` needs no credentials. A ticket issued
  through an MCP tool is redeemed on a separate HTTP request, which is what proves the shared
  `TicketStore` and the rate-limited `LexwareClient` survive the new per-request handler.

  Also: `skybridge/vite` no longer exists in 2.0. This server registers no views, so the plugin was
  inert here and `vite.config.ts` simply drops it; the dead `build:views` script goes with it.

### Added
- **`voucherType` and `voucherStatus` take several values at once.** Lexware accepts a
  comma-separated list; the tools only ever sent one value, so "open and paid invoices" meant two
  calls and a client-side merge. Both now accept a single value, an array, or the comma-separated
  string itself (the API's own wire format). Every element is still validated against the enum rather
  than passed through as a free string, which is load-bearing: an empty entry (`open,,paid`) makes
  Lexware answer **HTTP 500**, so it is rejected locally instead. The two combinations Lexware refuses
  — `any` with anything else, and `overdue`, which it derives from the due date rather than storing —
  are caught before a request is spent, with an error that says why.
- **`get-voucherlist` can now answer "what changed since ...?" and "which document is RE0069?".** The
  endpoint has always accepted `createdDateFrom/To`, `updatedDateFrom/To`, `voucherNumber` and `sort`;
  the tool exposed none of them. Without the created/updated bounds an incremental sync was
  impossible, because `voucherDate` is the document's own date, which the user sets and often
  backdates. Without `voucherNumber` the only way to find a document by its number was to page the
  whole list. `sortBy` + `sortDirection` compose into Lexware's single `sort` parameter, and a
  direction without a field is rejected rather than silently dropped (that would hand back the DESC
  default to a caller who asked for ASC). The direction is always written out, because a bare field
  sorts the OPPOSITE way from no sort at all — probed: no `sort` returns newest-first, `sort=voucherDate`
  returns oldest-first. `sortDirection` therefore defaults to `DESC`, so naming a field cannot silently
  flip the order. `summarize-vouchers` gets the same date bounds.
- **The e-invoice XML is reachable: `format: "xml"` on `render-*-pdf` and `get-document-file`.** Both
  tools hardcoded `Accept: application/pdf`, and for an XRechnung that is the wrong artifact — Lexware's
  own documentation says the PDF of an XRechnung "is not a valid e-invoice and should not be used as
  one". So the only thing the server could hand back for a public-sector invoice was the preview, with
  no way to reach the XML that is the actual legal document. `getBinary` already took an accept type;
  it is now threaded through as a two-value enum rather than a free header string. A 404 on an XML
  request is translated: it means "this document has no standalone XML" (a ZUGFeRD invoice embeds its
  XML in the PDF, a plain invoice has none), not "no such document", which is what the raw status
  reads as. The tool names keep their `-pdf` suffix, since renaming a registered tool breaks every
  saved prompt that refers to it.
- **`language` and `printLayoutId` are typed on the document create tools.** Both are long-documented
  Lexware fields — `language` is how an English invoice is produced, `printLayoutId` picks a layout
  from the ones `get-print-layouts` already lists. Neither was declared, so the SDK's strip-mode
  object dropped them and they were reachable only through the `additionalFields` escape hatch, which
  works but requires knowing the field name. Both need an Invoicing Pro plan, which the descriptions
  say. Typed fields keep winning over `additionalFields`, now covered by a test for these two.
- **The document and article text fields document Lexware's limits and formatting support.** `title`
  has an unusually short 25-character limit, `introduction` and `remark` allow 2000, and a line item's
  `name` 255 with `description` 2000. Since May 2026 Lexware also renders `**bold**`, `__italic__` and
  `- ` bullet lines in `introduction`, `remark`, a line item's `description` and an article's
  `description` (but not an article's `title`) — worth stating, because nobody would guess it. These
  are descriptions rather than `.max()` constraints on purpose: the numbers are vendor-documented and
  unverified against a live write, and a wrong number in a description cannot reject a valid document
  the way a wrong `.max()` would.

### Fixed
- **The voucherlist no longer advertises three filter values the API rejects, and can now reach the
  receipt inbox.** Probed every value individually against the live API: `voucherType` `dunning` and
  `recurringtemplate` and `voucherStatus` `paymentordered` all come back
  `400 Invalid value '…' received for request parameter '…'`, so the model was being offered choices
  that could only fail. They are gone. Conversely `unchecked` (the uncategorized Belege-Eingang) and
  `blank` (OCR still running on a fresh upload) are accepted but were missing, which meant the only
  way to find an uncategorized receipt was to page the whole voucherlist under `any` and filter
  client-side. Dunnings and recurring templates are unaffected — they were never voucherlist rows and
  are still reached via `get-dunning` / `get-document` and `list-recurring-templates`.
- **The voucherlist date filters are enforced as `yyyy-MM-dd`, which is all they accept.** The
  descriptions said "ISO date"; passing the full ISO datetime that the create tools use for
  `voucherDate` gets a 400, so the wording was inviting the error. All six bounds now reject the
  wrong shape locally instead of spending a request on it. Probed on all three families —
  `voucherDateFrom`, `createdDateFrom` and `updatedDateFrom` each answer 200 for `2025-01-01` and
  400 for `2025-01-01T00:00:00.000+01:00`.
- **`get-voucher-file` asks for `*/*` instead of `application/pdf`.** A voucher attachment is
  whatever the user filed, and the same endpoint already served `download-file` with `*/*`; the
  narrower header could only ever turn a non-PDF receipt into a 406. Not a reproduced failure —
  every attachment in the test account is a PDF — but the restriction had no upside, and the new
  voucherlist filters are precisely what opens up the receipt inbox. When a response carries no
  content-type at all, the fallback is now `application/octet-stream` rather than the `*/*` pattern,
  which is not a media type a client can render.
- **`taxConditions.taxType` no longer suggests a value the API rejects.** The description offered
  `thirdPartyCountry`, which does not exist; the real values are the separate
  `thirdPartyCountryService` and `thirdPartyCountryDelivery`. It now lists all nine accepted values
  (the four that were missing: `constructionService13b`, `externalService13b`,
  `thirdPartyCountryDelivery`, `photovoltaicEquipment`) and notes that an XRechnung requires `net`.
  The field stays a free string, since Lexware extends this set over time.
- **A contact whose name contains `&`, `<` or `>` can be found again.** Lexware requires those three
  characters to be HTML-encoded *on top of* the URL encoding in the contacts search filters, so
  `name=johnson & partner` has to go out as the value `johnson &amp; partner`. The client only
  URL-encoded, and Lexware then matched nothing at all. The failure was silent, which is the bad
  part: an empty result set reads as "no such contact" rather than as an encoding problem, so a
  perfectly real "Müller & Sohn" looked like it did not exist. Verified end to end against the live
  API through the client's own URL builder: the encoded form returns the contact, the old form
  returns zero. Applied only to `name` and `email` — Lexware documents that this encoding breaks
  other parameters, so ids, numbers, dates, enums and `sort` are deliberately left alone. The two
  descriptions also now mention the SQL-style `_` and `%` wildcards the filters accept.
- **A trailing root-label dot on an allow-list ENTRY no longer silently blocks everything.**
  `isAllowedHost` normalized the incoming hostname (trim, case-fold, strip the trailing dot) but
  only trimmed and case-folded the configured entries, so
  `LEXWARE_UPLOAD_ALLOWED_HOSTS=sharepoint.com.` matched nothing and blocked the very host it was
  meant to allow. Both sides now go through the same normalization, so they cannot drift again. This
  is the same failure mode as the leading dot fixed in 0.1.12, arriving from the other end of the
  name; raised by the review bot on [#39] and not carried over at the time. A double trailing dot is
  deliberately NOT folded — that is an empty DNS label, i.e. a malformed name rather than another
  spelling of the same one.

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
