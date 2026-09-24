# Browser discovery and API-only conversion

This workflow treats the browser as a scoped observation and login-bootstrap
tool when needed, then moves routine requests into a direct HTTP client only
after their contracts and credential path have been independently verified.
Use these steps for the owned account and service, and re-observe when the host,
account, operation, or client build changes. The related service cases are in
[`case-studies/non-naver.md`](../case-studies/non-naver.md); source revisions
and hashes are in [`provenance/non-naver-sources.json`](../provenance/non-naver-sources.json).

## Phase model

| Phase | Browser needed? | Evidence to retain |
|---|---|---|
| Runtime/profile selection | Often | Execution host, browser identity/profile chosen, attach result, visible tab origin, connection error class |
| Login/session bootstrap | Provider-dependent | User-authorized flow, origin scope, successful protected read, safe readiness metadata |
| Request discovery | Often for undocumented first-party behavior | Method, origin, normalized path, content type, field names/types, status, response shape, timestamp, sanitized hash |
| Contract review | No | Read/write meaning, required headers and fields, bounds, identity/entitlement check, pagination and expiry semantics |
| Direct client implementation | No | Named allowlisted operation, parser/decoder, bounded transport, secret-safe errors, deterministic tests |
| Credential handoff | Provider-dependent | Actual runner, origin scope, memory/DPAPI provider, propagation success, safe cleanup status |
| Live replay | No for the request itself | Exact operation/account scope, request mode, response status/schema, protected identity, readback |
| Write reconciliation | No for HTTP reads; browser may be needed for visual QA | Intent journal, stable ID, uncertainty state, owner readback, duplicate prevention |

Use phase-specific execution labels such as `pure_http`,
`headless_assisted_http`, `browser_automation`, or `blocked_runtime`. If a
browser is used to acquire a token or transaction ID, that is a browser-dependent
phase even when the following HTTP request is direct. Report both the phase
label and whether the whole operation still depends on the browser. [S01]
[S02] [S03]

## 1. Prove the runtime before diagnosing auth

1. Identify the host and enumerate enabled browsers/tabs. A label such as
   “Chrome” may resolve to a different install or profile than expected.
2. Select the already-authorized browser/profile from the current environment;
   verify the target tab is on the exact HTTPS service origin.
3. Attach using the supported integration and confirm a real event or page
   response. Do not assume a port is open or that the tab is attached because a
   launcher exists.
4. If CDP attach times out, a permission prompt is missing, or the tool cannot
   observe a target, record `blocked_runtime`. Do not infer logout or expire a
   credential based on a browser-control error. Recover the runtime first.

This distinction mattered in the Tistory and partner-service work: browser
connection failures were runtime boundaries, while explicit HTTP account-query
rejections were credential/service boundaries. [P01] [P03] [S04] [S06]

## 2. Capture one operation, not the whole account

Before triggering a browser action, install the supported response/event
listener and verify it is attached. Keep it alive through the action and record
whether it saw the event. Old network-list polling can miss fast request bodies;
collector startup without an event is not a capture. Stop after the smallest
reproducible user-authorized operation. [S01] [S03]

For each request, preserve only:

- method, exact allowed origin, normalized path and route family;
- query/body field names and types, encoding, and stable operation selector
  **names** (not values);
- request/response MIME, status, response byte count, safe JSON key/type shape,
  observed time, and a hash of sanitized evidence;
- pagination kind, cursor-present boolean and page ordinal, never the cursor;
- whether the action reads or writes and what evidence supports that label.

Never put raw authorization headers, cookies, access/refresh or CSRF values,
OAuth codes, passwords, account-selector values, full query strings, request or
response bodies, or signed media URLs in HAR exports, logs, source control, or
reports. Normalize dynamic path segments and omit URL query values. Treat saved
HAR/HTML as evidence input only; a POST in a capture is not automatically safe
to replay. [S01] [S03]

## 3. Turn observations into an allowlisted contract

Build a named operation around each intended action rather than exposing a
generic host-scoped request primitive. For each operation:

1. Enumerate required path/query/body fields, types, accepted ranges, and
   required headers from first-party network evidence or source.
2. Check HTTP status, redirect policy, response MIME, JSON schema, and
   service-level error fields. Reject login HTML, consent pages, anonymous
   shells, empty fallback identities, and malformed responses.
3. Check exact account identity and per-operation entitlement before returning
   success or executing a write. Do not expose a whole private account response
   if a few booleans and a safe identity match are enough.
4. Establish pagination terminal behavior separately. A page of results or an
   empty result does not prove all records or all row fields.
5. Keep `candidate → request_observed → client_exists → live_replay` states
   distinct. Add credential propagation and browser-remnant status as separate
   fields rather than folding everything into one “API-only” boolean.

The X case required a session plus transaction/header/feature inputs; because
they were captured together, their individual necessity remained unresolved.
Threads had implementation and synthetic-test evidence without a live replay.
Both demonstrate why a route string or passing fixtures do not promote a
contract to production evidence. [X02] [X04] [T01] [T03]

## 4. Separate login, session storage, and routine requests

Use a supported login/session provider for bootstrap, then pass only the
minimum service-scoped credential envelope to the HTTP runner. On Windows,
store persistent session material with DPAPI or Windows Credential Manager;
rehydrate it only in memory for requests to the approved origins. Never read a
browser cookie database or copy a browser profile as an extraction method.
Accept cookie/token rotation only from observed first-party response origins.
[S02] [S04] [S05] [S06]

Treat these as separate capabilities:

- capture: the request/session field was observed;
- client: a bounded implementation exists;
- propagation: the actual child process received the intended value;
- authentication: a protected read matched the intended account;
- renewal: a rejected/expired session was refreshed by a verified first-party
  flow and then passed a fresh protected read;
- remnant-free: the request phase did not depend on browser APIs or state;
- replay: the specific live operation passed the response and account checks.

The MyRealTrip case required a browser refresh after an explicit protected-read
rejection; automatic HTTP login renewal was not implemented. Tistory later
verified a narrow saved-Kakao-session HTTP renewal for one configured account
and blog. Neither proves a generic OAuth broker or renewal for other services.
[P03] [P06] [S06]

## 5. Classify failures by the evidence that failed

| Evidence | Record | Do not infer |
|---|---|---|
| Browser attach/extension/CUA timeout | `blocked_runtime` | Service logout, expired cookie, or bad password |
| Explicit protected endpoint 401 with provider meaning | `auth_rejected` / `reauth_required` | A refresh mechanism exists |
| 403 without a provider-specific contract | `access_blocked` or `blocked_auth` pending review | Expiration; successful renewal will cure it |
| Login/consent HTML, redirect, empty identity | `auth_unverified` / `auth_required` | HTTP 200 means authenticated |
| Protected identity matches but feature is disabled | `blocked_entitlement` | Account is authorized for the requested action |
| Child starts but credential is absent/malformed | `propagation_failed` | The browser session itself is expired |
| POST transport loss after send | `write_outcome_unknown` | Safe to send the POST again |

Status mapping belongs to the service adapter. Olive Young's observed 403 was
`ACCESS_BLOCKED`; Reddit's anonymous 403 was not an authorized OAuth replay;
X's client maps its own observed rejection statuses to an auth error but still
has no verified automatic renewal. A 403 must not acquire a universal
“expired” meaning. [O01] [X03] [X05] [X06]

## 6. Make writes resumable before sending them

Before an externally visible POST, persist a minimal nonsecret journal entry
with a stable operation/job key, target scope, intended operation, sanitized
payload hash, and pending state. Do not journal raw post bodies or credentials.

- Do not automatically retry create/publish/payment POSTs after transport loss.
- Reconcile by the returned stable ID or an owner-side list/inventory before
  deciding to resume.
- If a workflow has stages, record each completed stage and resume only the
  stage not yet confirmed.
- If the request was observed through a browser, verify the browser write was
  canceled before sending the equivalent HTTP write. A caller-supplied
  `browserAborted: true` flag alone is not proof.
- Read back owner, target, visibility, ordered content, attachments, and public
  rendering as appropriate. A successful HTTP status alone is not publication
  proof.

MyRealTrip used a `completedStep`/resume target for a multi-request link flow;
X kept an uncertain job from automatic resubmission; Tistory reconciled a
complete management inventory after a lost write response before continuing.
[P06] [X02] [X04] [TR02] [TR05]

## 7. Portable module boundaries

Keep shared primitives and provider-specific behavior separate:

```text
lib/
  runtime-profile       host/browser inventory and attach result metadata
  capture-events        bounded event listener lifecycle, no durable raw HAR
  sanitize             URL/path normalization, field names/types, safe schema
  contracts             observed operation states and evidence references
  scoped-session        origin-limited in-memory cookies/headers and rotation
  protected-store       OS-backed persistence adapter; no secret values in logs
  transport             redirect/timeout/body limits and typed transport errors
  write-journal         intent, unknown outcome, reconciliation and resume
  frontier              resumable discovery graph with an unknown denominator
service-packs/<service>/
  operations            named allowlisted reads/writes and decoders
  auth-provider         verified service-specific handoff and renewal
  evidence              sanitized receipts and source hashes
```

Keep browser drivers behind `runtime-profile` and `capture-events`; ordinary
API clients must not import them. A provider may still be `headless_assisted`
when it obtains a fresh transaction token, even if the actual request uses
`fetch`. Use exact-origin allowlists, bounded response sizes/timeouts,
no-auto-redirect where auth could cross origins, no hidden retries for mutation,
and redacted typed errors. The source patterns most reusable for this split are
the partner session handoff, Tistory scoped transport/DPAPI state, X write
journal, and the read-only Threads client; the complete mixed Naver/X/Threads
session vault is not a portable service boundary. [P09] [S05] [X04] [T01]

## 8. Completion receipt

For each operation, record a safe receipt with:

```text
scope: service, normalized operation, target-account match boolean, code revision
time: observed/captured/replayed timestamps
execution: phase mode; browser involvement by phase; actual request runner
session: provider type, protected-read result, propagation and renewal states
contract: source IDs, request shape, response status/schema, pagination state
write: journal key hash, sent/canceled result, stable ID presence, reconciliation/readback
coverage: operation/page counts, terminal evidence, remaining/unknown scope
```

Do not include the secret values or full target URL. Use `unknown` for unrun
checks. A historic `true` does not prove the current login, and a source hash
does not prove that the remote service contract is still current. [S01] [S03]
