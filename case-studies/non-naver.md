# Non-Naver API-only case studies

This file summarizes observed work in the source workspaces. It preserves each
case's boundary: a public read is not an authenticated read, a captured request
is not a replay, and one replay does not establish broad coverage. Source IDs
resolve to hashes and revision metadata in
[`provenance/non-naver-sources.json`](../provenance/non-naver-sources.json).
No account identifiers, credentials, signed URLs, post titles, or raw response
bodies are copied here.

## At a glance

| Case | Observation | What was demonstrated | What remains unproved |
|---|---|---|---|
| Adpick | 2026-09-20–21 | Browserless public catalog read; 43 catalog entries recorded | Authenticated affiliate link generation; Naver-social signup stopped at phone verification |
| MyRealTrip | 2026-09-20–21 | Protected account check and 10 business API operations over independent Node HTTP | Automatic login renewal; non-empty reservation/sales row schemas |
| Brand Connect | 2026-09-20 | Protected account check over independent Node HTTP | Partner entitlement; automatic login renewal |
| Olive Young Curator | 2026-09-21 | Adapter and synthetic tests; anonymous and handed-off session requests both returned 403 | Protected account read, authenticated link issue, or successful credential propagation |
| X | 2026-09-22 | Direct GraphQL reads and one authorized direct post with readback | Browserless transaction-ID generation, automatic session renewal, protected account-to-token binding |
| Threads | Source snapshot reviewed 2026-09-24 | Read-only GraphQL client implementation and synthetic tests | Live replay, account session, broad feed/thread coverage |
| Reddit | 2026-09-22 | OAuth-reader shape and fail-closed behavior documented | Authorized OAuth replay, token issuance/renewal, stored credential provider |
| Tistory | 2026-09-24 | Stored Kakao-session HTTP renewal for the configured account; 5 public writes reconciled and read back; media path verified | Fresh password/MFA login; generalizing to other accounts/blogs; native video upload |

## C01 — Adpick: separate public discovery from account work

The public catalog collector used direct HTTP with no browser and no account
credential. The recorded replay contains 43 public merchant/catalog entries;
this proves the public read only. A separate account-onboarding attempt reached
a phone-verification step after the Naver social-login handoff and did not
complete registration. Neither outcome proves that an affiliate account can
issue a link. [P07] [P08] [M02]

**Reuse:** keep public catalog collection as a credential-free operation; keep
OAuth consent, social signup, phone verification, account entitlement, and
affiliate-link creation as distinct states. Only mark link creation verified
after an authenticated create request and a returned-link/readback check.

**Counterexample:** public HTTP 200 and a populated catalog are not evidence of
an authenticated publisher or an account's link-generation permission.

## C02 — MyRealTrip: refresh at the observed boundary, then reconcile writes

An initial protected account query rejected the current session. The supported
site UI refreshed it, after which a new in-memory handoff passed a protected
identity check. The separate Node client then verified 10 API operations,
including product/flight link creation, search, reservations, and sales
summaries. Normal operations did not use the browser. Automatic HTTP login
renewal was explicitly unverified. [P01] [P02] [P03] [P04] [P05] [P06] [P09]

An uncertain POST was not blindly repeated. A failed flight-link input was
retained as unknown, the numeric contract was corrected from observed evidence,
and a distinct itinerary was used for the later successful verification. The
multi-step flight flow reports its completed step and resumes at the short-link
step instead of redoing the first write. Empty reservation/sales responses
verified count and summary envelopes, not individual non-empty row schemas.

**Reuse:** make a protected owner/account read a prerequisite to each run; do
not confuse browser-assisted renewal with an HTTP refresh implementation; never
retry an uncertain create; use a stable operation journal and resume only the
unfinished step.

**Counterexample:** a five-minute local handoff-age rule is a client safeguard,
not evidence that the provider's server session expires after five minutes.

## C03 — Brand Connect: authentication and entitlement are separate

The protected account endpoint returned HTTP 200 and matched the intended
login identity. The account had creator access but the partner entitlement flag
was false. The browser supplied the initial session; the account read itself
ran through direct HTTP. No automatic renewal was tested. [P01] [P02] [P03]

**Reuse:** confirm the exact account and operation entitlement before exposing
business actions. Do not treat a valid login as proof that a specific partner
feature is enabled.

**Counterexample:** HTTP 200 from `/me` means the session is authenticated only
after identity fields are checked; it does not establish every account role.

## C04 — Olive Young Curator: 403 did not prove an expired session

The adapter and 18 local tests were implemented from public first-party
JavaScript and observed request shapes. The anonymous request and the forwarded
current session both received HTTP 403; the login-refresh response contained an
empty linkage value, and the protected link flow was not reached. The source
snapshot had no authenticated link-creation replay. [O01] [O02] [O03] [O04]
[O05] [M03]

The client distinguishes `AUTH_REQUIRED` (including a missing linkage value)
from `ACCESS_BLOCKED` (403), and it does not claim a token refresh can cure the
latter. Link creation stops if prior activity history could not be completely
checked; POST has no automatic retry, and an uncertain outcome requires checking
the generated-items list before another create.

**Reuse:** keep 401, 403, entitlement failures, redirects, and login HTML
distinct according to the observed service contract. Treat the current case as
`access_blocked`, not `session_expired`.

**Counterexample:** a 403 from one service is not a universal session-expiry
signal. A different service may document 403 as one of its authentication
rejection signals, but the next step still needs its own observed renewal path
and protected read.

## C05 — X: a direct write worked, while request inputs still depended on capture

On 2026-09-22, GraphQL profile/timeline reads succeeded over direct HTTP after
the current signed-in browser session was handed off. A cookie-only Node
request had returned 404. The successful request included the observed session,
transaction ID, client headers, and feature inputs together; the evidence did
not isolate which additional input was necessary. One user-authorized post was
sent once from Node after the corresponding browser write was observed and
canceled, then its identity and text were read back independently. [X01] [X02]
[X03] [X04] [X07]

The one-time capture path does not establish a browserless transaction-ID
generator, durable credential provider, automatic session refresh, or protected
account-to-token binding. The CLI asks its session provider to validate the
expected public profile before execution, but that check is not a protected
identity endpoint. It journals job IDs, blocks duplicate jobs, and leaves a
lost POST response in a review-needed state rather than retrying.

**Reuse:** observe the whole request envelope for a specific operation, then
independently replay it and verify the returned resource. Report the HTTP
transport as direct only for the request phase when an upstream capture helper
is still involved.

**Counterexample:** successful X authentication inputs or a transaction ID
cannot be transplanted to Reddit or another X operation. X's own 401/403
handling does not show which credential expired without a verified renewal and
owner readback.

## C06 — Threads: implementation evidence is not live evidence

The source snapshot contains a read-only GraphQL client for profile and view
count reads, an anonymous/public-session bootstrap helper, and synthetic tests.
The helper caches a short-lived public session and refreshes after a bounded set
of rejected status codes. No sanitized live-replay receipt was located for this
snapshot, so `captured`/`client_exists` may be discussed from source, but
`live_replay` remains unverified. The implementation does not establish
authenticated account access, complete feed traversal, or broad conversation
coverage. [T01] [T02] [T03]

**Reuse:** label the source and tests accurately, preserve the limited read
scope, and require a safe live receipt before moving the operation to
`replay_verified`.

**Counterexample:** a locally passing fixture and a page-bootstrap response do
not prove a current API response or that a 403 means an expired public session.

## C07 — Reddit: OAuth reader shape, no authorized replay

The client supports Reddit OAuth search and comment-tree reads when an already
authorized access token and descriptive user-agent are injected by its caller.
It does not issue, refresh, or persist the token. In the documented live check,
anonymous JSON reads returned 403 and the normal site showed a humanity check;
no authorized OAuth API replay is claimed. The reader fails closed on 401/403,
429, redirects, and non-JSON. [X02] [X05]

**Reuse:** keep token acquisition/refresh in a separately verified provider;
keep search distinct from global comment search; retain unresolved `more`
counts instead of calling the comment tree complete.

**Counterexample:** public-reader excerpts are not OAuth API evidence, and
anonymous 403 is neither an authorized read nor proof that a legitimate OAuth
token has expired.

## C08 — Tistory: a scoped HTTP login path and journaled publication

The configured Windows session used the saved Kakao account session for a
first-party HTTP renewal path, stored the resulting scoped session in the
current user's DPAPI store, and verified the intended blog through protected
reads. This case supports that specific saved-session flow; password entry,
MFA/CAPTCHA solving, and other accounts were not automated by this contract.
The earlier Chrome/CDP timeout was a browser-runtime handoff failure, not proof
that the Tistory session had expired. [S05] [S06] [S07]

On 2026-09-24, a POST transport failure was journaled as uncertain. A complete
management inventory was checked before continuing; it had no matching post,
so the operation was reconciled as not created and then safely continued. The
final report records two creates and three updates. All five public entries and
their owner content were read back and verified. The report also confirms
18 images and 21 captions; the separate media report verifies image bytes and
source hashes. [TR01] [TR02] [TR05] [TR06]

The media boundary is specific: six MP4 file attachments were accepted as
downloadable file cards, but native Tistory video upload was unavailable. A
separate inline HTML5 player implementation resolved media from those native
file cards, and six rendered players were verified with playback controls.
That playback evidence does not turn file attachment into native video upload.
Routine upload and HTTP readback were pure HTTP; browser use was confined to
discovery and visual/playback verification. [S08] [TR03] [TR04]

**Reuse:** persist a write intent before sending, mark transport loss as
unknown, reconcile the full managed inventory before retrying, and only then
publish/update with exact public and owner readback. Keep session renewal, post
payload, media upload, and rendered playback as separate capabilities.

**Counterexample:** one saved Kakao session and one blog's successful flow do
not prove generic browserless Kakao login, support for other blogs, or a native
video upload API. A public feed limited to its latest ten entries is also not
proof that the full archive contains no duplicate.

## Cross-case rules

1. Record separate evidence for request capture, client implementation,
   credential propagation, browser-free routine execution, and live replay.
2. Validate identity and entitlement with a protected read before business
   writes. HTTP 200 alone is insufficient.
3. Classify 401, 403, login redirects, runtime timeouts, wrong accounts, and
   missing entitlements using each provider's observed behavior. Never relabel
   a browser/CDP failure as an expired service session.
4. Keep raw cookies, access/refresh tokens, CSRF values, request bodies, signed
   media URLs, and account selectors in memory or a service-scoped protected
   store. Persist safe metadata only.
5. Do not automatically retry create/publish POSTs. Journal the intent and
   reconcile by stable ID or a complete owner-side inventory before resuming.
6. A successful read of a bounded page or a single operation does not establish
   full-site, full-thread, or full-history coverage.
