---
name: xhr-to-api-only
description: Convert observed browser and XHR workflows into reusable direct HTTP clients. Use for API-only migration, session and token reuse, login and renewal analysis, recursive API discovery, browser dependency reduction, and independent replay with write reconciliation.
---

# XHR → API-only

Carry an observed workflow from discovery to an independently executable HTTP client. Preserve accumulated contracts, working authentication providers, and the user's authorized cookie/token storage and reuse. This skill includes portable core tools and pinned service implementations; it does not ship credentials or assume a particular browser, broker, host, or other skill is installed.

## Start from the existing evidence

The workflow name does not restrict capture to XMLHttpRequest. Observe the full
HTTP exchange, including Document navigation, Fetch, XHR, redirects and the
resources that carry the requested data. Record each resource type accurately.
When a click sends no new request, trace the initial Document or earlier response;
parse embedded JSON or HTML through an independent HTTP client when it contains
the needed data. Do not stop at a responsive tab or report absence of XHR as
absence of a usable HTTP contract. With bounded CDP buffers, drain events during
navigation and check truncation before claiming complete request/response pairs.

The default scope for a new service includes a capability checklist, not only login.
Read `checklists/template.json`, register the applicable functions in
`checklists/services/<service>.json`, and run `npm run checklist` before delivery.
Track profile, categorization, content/link CRUD, visibility/order, media, source
integration and authenticated/public readback when applicable. Continue missing
in-scope implementation without requiring the user to request each function again.
Record real constraints or missing essential input explicitly; do not invent N/A
or an authenticated success to make the checklist green. Use `checklist:strict`
for required completion checks. Auditing performs no login or external mutation.
Source candidates and no-op calls do not count as live save evidence; report
historical proof and current implementation-hash freshness separately.

1. Read the project contract, runner and latest relevant receipt. Identify the actual host, account scope, requested operations, and allowed side effects. Prefer a working service pack or project adapter over rediscovery.
2. For a service that needs login, pin down the login flow first with [login-flow-first](references/login-flow-first.md). Read [login phases and recovery](references/browserless-login-flow.md) and [credential propagation](references/runtime-credential-propagation.md) before opening a browser or requesting another login.
3. Distinguish provider readiness from authentication. Use the same protected owner read through the same runner that will perform the business operation. Repair the first failed boundary: provider → consumer → transport → authentication → entitlement → schema.
4. Preserve the user's earlier authorization. Do not require renewed approval merely because a generic example contains an execution flag. Still obey actual tool/service requirements. For uncertain writes, use the same journal and independent readback before any new attempt.

For commands and installation, start with [README](README.md). For service-specific code and limits, open [service-packs](service-packs/README.md). Historical success is scoped to its date, account, operation and revision; it is not a current session check.

Before cloning a provider repository, inspect `npm run clients` and the
[consolidation map](references/repository-consolidation.md). Gemini, Grok,
ChatGPT, both Flow implementations, Whisk, social actions, Adpick and additional
shopping/travel readers are bundled with their native contracts and tests.
Use `scripts/client-packs.mjs run --service=... -- ...` or the named npm command
to preserve original stdin/provider and write guards. `list`/`describe` read
metadata only; the generic read registry does not replace native writers.
Run `test:client-packs` and `audit:consolidation` for packaging checks.
`check:ai` defaults to the bundled Gemini/Grok audits and checks stored receipts.
Flow's bridge, optional UI backend and creator browser helpers retain their
declared browser phase. Current authentication and live replay stay separate.

For a shared typed CLI/MCP interface, use [the operation runtime](references/operation-runtime.md).
Extend a v2 profile or bind an existing adapter rather than replacing working packs.
Offline `prepare` produces candidates, `check` replays declared reads, and `flow`/`collect`
resume executable checkpoints; the discovery frontier is not an executable checkpoint.
Use `npm run test:operations` for the common runtime's synthetic regression tests.

For existing Vercel/Supabase native CLI credentials, follow
[native cloud operations](references/native-cloud-operations.md). Preserve provider
storage and unrelated user-wide settings. CLI identity, MCP OAuth, team/project
entitlement and deployment/domain readback are independent. Resume only the current
pending OAuth callback after exact endpoint/state validation; never archive codes
or replace native credentials with repository files. This package does not ship
cloud login/deployment adapters.

When deployment or collectors time out, compare per-service database health with
project status before changing credentials or parsers. Do not skip schema gates,
call a deployment ACK collection success, or count a different successful source
as proof for the failed operation. Preserve invocation, persistence and catalog
readback as separate evidence.

For official creator tools and guides, use
[source capabilities](references/official-source-capabilities.md). Keep public
documents, protected workspaces, documented APIs, legacy replacements and real
account metrics separate. A login redirect does not verify owner access; a guide
does not supply traffic or monetization data. Do not bypass access gates.

For creator public data, reuse [the existing native clients and observed read
contracts](references/creator-public-data.md) before rediscovery. Google RSS is XML,
Threads profile GraphQL uses a fresh anonymous bootstrap, and TikTok/Meta web
collectors are external implementations, not native Playbook clients. Register the
`creator-*` checklists and preserve market, source kind, original publication time,
metric period, partial coverage and provider errors. Keep five readiness states,
browser XHR capture, dated replay hashes and deployment proof separate. Do not
promote undocumented feeds or anonymous cookies to incompatible live validators.

For source-native Studio inspiration and popular-content discovery, read the
[dated target contracts](references/creator-studio-inspiration-2026-10-11.md).
Official news/profile feeds are separate scopes; preserve target-specific period,
content language, sort, unknown country, source AI and current provider boundaries.

For MyRealTrip link creation, use
[link reconciliation](references/myrealtrip-link-reconciliation.md) and the existing
owner-bound flow. Web partner sessions and official API keys/response fields differ;
public health is not key validity. Preserve original repeated options and reject
unknown added tracking. A failed verification resumes read-only, never reissues the
link. Its observed anonymous no-follow short-link read is service-specific and
does not prove conversions or current commission.

For Inpock password login and the protected owner probe, reuse
[the HTTP login adapter](references/inpock-login.md) before starting discovery.
Its Linux/macOS stdin mode is process-memory only; Windows uses the existing DPAPI store.
Link/content editing and live expired-session recovery remain outside its verified scope.

For Inpock block/profile/stat reads and offline affiliate card preparation,
use [the feature inventory](references/inpock-features.md). A prepared candidate
is not a published card; caller-supplied source receipts need current validation.
The named `publish` operation supports explicit, actor-bound public simple cards.
Reserve its owner/source journal before sending, never resend an uncertain intent,
and require full owner plus cookie-free public readback. Reuse the observed
`{block:{id,...}}` ACK contract; separate actual POST evidence, readback-derived IDs,
and anonymous web rendering. Update/hide/upload operations remain unverified.
For Google/Grok/ChatGPT/Flow gates, consult
[the dated diagnostics](references/provider-login-diagnostics.md). Capture actual
blocker screenshots when requested, record whether a password was submitted,
and do not treat public-page UA compatibility as protected login proof.

For Gabia domain and DNS work, use `scripts/gabia.mjs` for local record-plan
preparation and public recursive-DNS/HTTPS checks, and the
[Gabia read adapter](references/gabia-login-dns.md) for authenticated
owner/domain/record reads. Google sign-in is a normal visible UI bootstrap in the
current Linux Chrome profile (`browser_automation`); the authenticated reads
then run as Node HTTP (`pure_http_node_fetch`) after a current-origin,
process-memory stdin handoff. Do not call the whole login flow engine-free.
The read routes are first-party UI-observed application contracts, not a
published Gabia API. No DNS writer or automatic session renewal is implemented.
The owner response has no email field, so pin the protected `user_id` in memory
and keep cross-service email equality unverified. Full domain-inventory
pagination and the record-write candidate remain explicit gaps. See
[`references/gabia-login-dns.md`](references/gabia-login-dns.md) and
[`checklists/services/gabia.json`](checklists/services/gabia.json).

For overseas marketplace crawling, read
[official API first](references/overseas-official-api-first.md),
[anti-bot detection](references/anti-bot-boundaries.md),
[geo/locale/currency](references/geo-locale-currency.md),
[region egress](references/region-egress-proxy.md),
[rate-limit backoff](references/rate-limit-backoff.md),
[pagination patterns](references/pagination-patterns.md),
[sanctioned session refresh](references/session-refresh-sanctioned.md), and
[legal/ToS notes](references/legal-tos-overseas.md).
Prefer Creators API / AliExpress Affiliate / network feeds; keep Temu, SHEIN,
iHerb and AliExpress Portals link-generate gaps in their checklists until live receipts exist.
Reuse `lib/commerce/backoff.mjs` for classification and bounded read retries.

For anonymous foreign storefront reads, reuse
[the public retail clients and exact limits](references/retail-public-apis.md).
No login is needed for their supported operations. Keep SEO metadata,
suggestions/category hints, actual product offers and full catalog search as
separate capabilities. Use `scripts/retail.mjs` and each service checklist;
unsupported operations must remain explicit gaps. Never relabel SSR documents
as XHR or an immediate replay of captured opaque browser inputs as a durable
engine-free workflow. Official API documentation, first-party shipped JS
contracts and UI-observed XHR have distinct provenance fields.

For foreign affiliate/dropshipping product and price collection, use
[the commerce collector](references/commerce-collection.md), its fixed provider
registry and the official-source matrix. Classify browser XHR, documented REST
APIs and static HTTP feeds distinctly. Preserve price kind, variant, destination,
marketplace, currency, production technique and unknown currency; do not infer
landed cost or stock from aggregate/virtual counts. Read credentials from a
service-bound memory/stdin provider, never reuse unrelated passwords. Keep
credentialed clients pending live until the real runner returns validated
business data. Unknown feed envelopes, partial pages and source limits stay
explicit; support price snapshot/CSV readback and same-context comparisons.

For Olive Young, Shopee Indonesia, Sephora/Ulta and Rakuten, reuse
[the program adapters](references/affiliate-program-adapters.md).
Keep Rakuten Japan and global Rakuten Advertising separate. Validate an approved
brand catalog/MID from the caller's account rather than guessing it. Preserve
API-returned affiliate URLs apart from retailer URLs, do not click tracking links
to verify them, and do not claim attribution or current commission from a public
estimated range. Reuse the existing Curator adapter; a membership flag alone is
not a matched member identity for link creation. Country/price-basis differences,
reported sale windows and unverified Shopee currency stay explicit.

For non-affiliate product detail and full review reads, use
[the catalog reader](references/catalog-read-apis.md) and `scripts/catalog.mjs`.
Keep price snapshots separate from full descriptions, images and options.
Review summaries/positive-rating percentages are not review bodies or photos.
Run `npm run catalog:check` for this read scope; retain missing required reads
and access gates. An account cannot supply an unimplemented or officially
unexposed operation. Acquire public frontend keys through current HTTP bootstrap
and keep their values only in memory. Preserve safe bounded continuations;
a partial collection or resumed tail is not complete review coverage.

For Adpick ShoppingMate affiliate links, read
[the dated API contract and data-rights boundary](references/adpick-affiliate-api-2026-10-11.md).
Use `scripts/adpick-read.mjs` for the credential-injected `malls`, `search` and `best` GET
reader; [its checklist](checklists/services/adpick.json) remains pending live account/key proof.
The key provider is caller-owned memory/stdin, not browser scraping or a shipped credential.
No login, key management, link issuer or conversion reader is implemented.
Keep the older anonymous mall-list reader separate. Preserve exact original product/option
URLs, use provider-returned stored commission links, and keep path-based API keys private.
Do not copy product/image datasets without independently established reuse scope, expose
key-bearing direct links, relabel reference prices as verified offers, or publish private
conversion records. Google owner/API approval and IP-whitelisted reporting remain unverified.

For domestic Olive Young sales rankings, use `commerce oliveyoung-public ranking`
and [the ranking contract](references/commerce-oliveyoung-korea-ranking.md).
Preserve the site's displayed rank and category; do not assign ranks from array
positions, omit sold-out ranked products, or replace a missing rank with rank 11.
The current sales ranking is served as an HTML document. Its direct HTTP reader
must declare that source format and must not be reported as a JSON/XHR endpoint.
The default ranking flow first gets the observed homepage to issue an anonymous
session, keeps only approved server-issued CF cookies in memory, reuses the same
HTTP context with a five-second minimum request interval, and closes it after the
CLI job. Record the bootstrap and actual sent-cookie names separately. Do not
rebootstrap or retry a rate-limited job. Use the explicit Python HTTP transport
dependency, with no browser fallback, and
keep search/detail/review readiness separate from a successful ranking request.

For Ably (에이블리) fashion rankings, search, product detail, outfits and influencer
(셀럽) shops, use `scripts/ably.mjs` and [the Ably contract](references/commerce-ably.md).
It bootstraps a server-issued anonymous token in memory, sends no cookies or login and
keeps a 3 s request interval. Creator reward enrollment and reward-link creation need a
logged-in account and stay blocked in [its checklist](checklists/services/ably.json).

## Establish the execution mode by phase

Record **login acquisition**, **request-input preparation**, **business request**, and **readback** separately.

| Mode | What executes recurring work |
|---|---|
| `pure_http` | HTTP clients only; any initial interactive bootstrap is separately declared |
| `headless_assisted_http` | A browser engine prepares required inputs; an HTTP client sends the operation |
| `browser_automation` | The browser executes the business workflow |

A hidden browser or hosted Browserless service still uses an engine. A direct HTTP writer is not enough to call the whole workflow engine-free. Preserve an explicit engine-free requirement; name the unconverted phase instead of silently replacing it.

## Discover once, keep the contract

- Reuse observed contracts first. For an unknown request, use an available, authorized browser/network capability. Follow that tool's own instructions; do not invent debugging ports, inaccessible APIs, or browser profile access.
- Capture **metadata**: method, origin, normalized path, encoding, request field names, response types, HTTP/application result and evidence source. Keep actual session material in memory or a protected credential store, separate from capture artifacts and Git.
- HAR import here extracts metadata; it cannot prove the request happened if its input is fabricated. HTML/source links are candidates, not observed XHR. The supplied examples are synthetic.
- Record operation semantics separately from HTTP method: a GraphQL POST may be read-only; an apparently harmless GET may mutate state.
- For recursive work, read [recursive discovery](references/recursive-discovery.md). Preserve the requested root, stage coverage, incoming edges, pagination termination evidence and resumable frontier. A menu inventory or saved queue is not completed traversal or a running background task.

Tool interfaces: [discovery tools](references/discovery-tools.md). Connection failures and capture boundaries: [browser discovery](references/browser-discovery.md).

## Build the reusable client

- Keep discovery code separate from routine transport. Implement exact observed paths, methods, encodings, origin allowlists and response validation. Do not guess refresh endpoints, opaque IDs, write payloads or token lifetimes.
- Scope cookies and bearer headers to exact approved origins, recheck every redirect and preserve cookie path/domain/expiry/deletion behavior. A CDN URL is not authority to forward application credentials.
- Use [runtime modules](references/runtime-modules.md) for protected storage, transport, session locks and journals. Authorized persistence is supported: Windows DPAPI CurrentUser locally; explicit memory/stdin integration elsewhere. Copying this repository does not copy a login.
- Treat server cookie rotation, action-token reissuance, expired-session renewal, password login and process restart as separate capabilities. Never downgrade an existing protected credential provider to plaintext for convenience.
- Use bounded size/time limits and distinct authentication, permission, throttling, transport and schema errors. A 200 login page is a failure. A 403 with unknown cause stays unknown.
- A MIME mismatch is not an empty result. Inspect bounded HTML for DOM candidates, embedded JSON/Flight and explicit login/denial evidence without executing scripts. Record `parseAttempted`, `parseStatus`, and nullable `productCount`; only validated data can supply a measured count. Never initialize an unmeasured count to zero. Preserve a bounded failed response in authorized encrypted storage when needed for offline diagnosis; keep raw bodies out of Git, stdout and ordinary evidence. See [the Coupang counterexample](references/coupang-retail-vercel-2026-10-17.md).
- Distinguish all URL-applicable cookies from a historical cookie-name subset, pre-request wire cookies from the post-response jar, and exact cookie propagation from successful business data. Preserve observed request inputs separately from locally derived inputs. A new response or an aged session cannot retroactively classify a discarded earlier body.
- Read [client reliability](references/client-reliability.md) and [write reconciliation](references/write-and-reconcile.md) before mutations. Reserve output and record intent before sending. A timeout leaves the outcome unknown; no automatic retry of writes.

## Check and report the actual boundary

Check new code and packaging at the scope authorized by the current task. Run/add tests or live service calls only when requested or otherwise allowed by higher-priority task instructions. Never turn local validation into a live-success claim.

Report these five states independently, with evidence or `unknown`/`not_applicable`:

| State | Evidence needed |
|---|---|
| `captured` | Actual observed request/response contract |
| `client_exists` | Implemented runnable client and dependencies |
| `credential_propagated` | Intended authentication reached the actual consumer and protected owner read passed |
| `remnant_free` | Operation graph has no browser dependency in the named scope |
| `live_replay` | Current independent HTTP execution validated the expected application result; writes also need readback |

Publish/update claims require target-specific owner and public readback where relevant. Media upload acknowledgement, file-card rendering, inline playback and final public content are separate outcomes. See [media recipes](references/media-and-publishing.md).

Finish by recording sanitized evidence, first failure, successful change, counterexample, revision and next resume point. Consult [Naver experience](case-studies/naver.md), [other services](case-studies/non-naver.md), and [provenance](provenance/README.md). Generalize only what the evidence supports; keep unverified alternatives explicit.

## When a site still needs its own web UI: browser-assisted publishing

Some first-party publishing (YouTube Studio, Facebook Pages, Naver blog/Clip, Instagram, TikTok Studio, X, Threads, Blogger,
Tistory) is driven through the site's own UI in a logged-in browser instead of a reconstructed HTTP client. The setup is one
unattended Windows PC with a **dedicated, non-default Chrome Canary profile** on `--remote-debugging-port=9333` (scripts attach
over CDP, open their own tab, close only that tab) plus a **Windows desktop MCP** ([Windows-MCP](https://github.com/CursorTouch/Windows-MCP), one shared HTTP server on localhost, started by a logon task) for what CDP cannot reach. That includes OS-level
real mouse/keyboard when a site ignores synthetic input, native dialogs, and full-desktop screenshots. A desktop MCP yields when it sees
input that isn't its own (`USER_CONTROL`), which on an unattended PC is often another agent; wait and retry. Read
[the setup and the rules learned](references/windows-canary-automation-setup-2026-10-23.md) before writing a new one:
- bring the tab to the front before clicking;
- choose the right upload method (file input, chooser interception, or drag-and-drop for cross-origin pickers);
- Shift+Enter for newlines;
- success only by readback;
- check the active account before posting.

One episode, every channel (all browser-assisted, each resumable and verified by readback):

| Step | Script |
|---|---|
| Long video upload, A/B, schedule | `youtube-studio.mjs upload` |
| Original captions + localized title/description/SRT, resumable | `youtube-studio.mjs captions`, many videos: `youtube-captions-batch.mjs` |
| Which videos still lack languages | `youtube-studio-languages.mjs <channelId> --min=9` |
| Shorts SRTs from the long video's SRTs, or from on-screen captions | `srt-slice.mjs cut` / `srt-slice.mjs captions` |
| Shorts cut, render kit | `longform-to-shorts.mjs` |
| Shorts to YouTube (+thumbnail, related video, pin), Naver Clip, TikTok, Instagram | `shorts-distribute.mjs` |
| Pinned comment; long link lists as replies (one 41-link comment was silently dropped) | `youtube-pin-comment.mjs`, `youtube-reply-comment.mjs` |
| Facebook Page: login with checkpoint, post/reel with AI label | `facebook-web.mjs` |
| Facebook Page: SRT caption tracks on a published video/Reel, one per language (`name.en_US.srt`) | `facebook-captions.mjs` |
| Owner's own footage from Google Photos (phone backups are there, not in Drive): list videos, search, shot date/place/file, download originals one by one or in bulk by date range/search (resumable). Read-only; ask before publishing personal media | `google-photos-web.mjs` |
| Threads / X with media | `sns-web-post.mjs` |
| Blogs: tables as images, lab site, Naver, Tistory/Blogger HTML, Blogger with hosted uploads | `blog-md.mjs tables`, `blog-md.mjs lab-run`/`se-html`, `blog-tistory-html.mjs`, `naver-se-paste.mjs`, `blogger-post.mjs` |

Caption tracks beyond YouTube (checked 2026-10-23). Burn the original-language captions into the picture, because only some platforms take caption files:

| Platform | Uploaded caption files |
|---|---|
| YouTube | Yes, one track per language, after publishing |
| Facebook | Yes, one `.srt` per language, after publishing. Every Page video is now a Reel, and Reels take them too. The file name sets the language (`name.ll_CC.srt`) |
| X | One `.srt` per video, only while composing ("Upload caption file" under the video) |
| Instagram, TikTok | No; only the platform's own auto captions and translations |

Keep a per-episode distribution record (channel → url/id + re-check time) and gate "done" on it. A channel that is missing
from the record is a channel that was forgotten.
