---
name: xhr-to-api-only
description: Convert observed browser and XHR workflows into reusable direct HTTP clients. Use for API-only migration, session and token reuse, login and renewal analysis, recursive API discovery, browser dependency reduction, and independent replay with write reconciliation.
---

# XHR → API-only

Carry an observed workflow from discovery to an independently executable HTTP client. Preserve accumulated contracts, working authentication providers, and the user's authorized cookie/token storage and reuse. This skill includes portable core tools and pinned service implementations; it does not ship credentials or assume a particular browser, broker, host, or other skill is installed.

## Start from the existing evidence

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
2. Read [login phases and recovery](references/browserless-login-flow.md) and [credential propagation](references/runtime-credential-propagation.md) before opening a browser or requesting another login.
3. Distinguish provider readiness from authentication. Use the same protected owner read through the same runner that will perform the business operation. Repair the first failed boundary: provider → consumer → transport → authentication → entitlement → schema.
4. Preserve the user's earlier authorization. Do not require renewed approval merely because a generic example contains an execution flag. Still obey actual tool/service requirements. For uncertain writes, use the same journal and independent readback before any new attempt.

For commands and installation, start with [README](README.md). For service-specific code and limits, open [service-packs](service-packs/README.md). Historical success is scoped to its date, account, operation and revision; it is not a current session check.

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

For anonymous foreign storefront reads, reuse
[the public retail clients and exact limits](references/retail-public-apis.md).
No login is needed for their supported operations. Keep SEO metadata,
suggestions/category hints, actual product offers and full catalog search as
separate capabilities. Use `scripts/retail.mjs` and each service checklist;
unsupported operations must remain explicit gaps. Never relabel SSR documents
as XHR or an immediate replay of captured opaque browser inputs as a durable
engine-free workflow. Official API documentation, first-party shipped JS
contracts and UI-observed XHR have distinct provenance fields.

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
