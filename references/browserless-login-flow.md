# Browserless execution and login flow

Read before opening a portal for API conversion or requesting a new login. The
intended outcome is a working, independently verified HTTP operation with the
smallest required authentication/input dependency. This reference is a procedure,
not an installed credential provider or proof that a site's login is automated.

## Choose the mode from the complete operation

| Mode | Recurring work | Claim boundary |
|---|---|---|
| `pure_http` | HTTP inputs, requests, and readback | Engine-free after any separately declared bootstrap; engine-free login needs its own evidence |
| `headless_assisted_http` | A headless engine prepares required SDK inputs; a separate HTTP client performs the operation | No visible window or extension is needed only if verified; a browser engine remains required |
| `browser_automation` | The browser performs the business request or UI workflow | Browser execution, even if hidden or controlled through a cloud service |

Record login acquisition, input preparation, business request, and readback as
separate phases. Do not infer full conversion from the writer's import graph.
Reuse the user's previously accepted mode. When the user requires no engine,
preserve that boundary and report the unresolved input; do not silently fall back.
Failure to find an HTTP issuer proves only that it remains unverified. When
headless execution is within the authorized scope, test the normal SDK flow
before concluding that a visible Chrome window or extension is necessary.

Browserless hosting still runs a browser. Prefer the current authorized local or
configured provider; do not send existing cookies to a new hosted service or
install a service merely because the user says "browserless".

## Establish login before feature discovery

1. **Restore context and host.** Read the existing operation contracts, runner,
   login helper, and recent receipts. Label local Windows, company PC, remote
   worker, and hosted browser separately. An earlier result is scoped to its
   host, account, operation, code revision, and observation time.
2. **Check the provider without exposing values.** Inspect configured provider
   names, readiness, required credential names, and the consumer's interface.
   An empty shell variable does not prove a connected broker has no session.
   Conversely, a browser connection does not grant arbitrary cookie/profile
   access. Use the supported current-origin acquisition mechanism when needed;
   do not invent a debugging port or read an old browser dump.
3. **Run the existing protected probe.** Through the same runner used for normal
   work, call a named, bounded, read-only operation. Verify HTTP status, expected
   MIME and service result, and the intended account/owner/space. A public about
   page, login HTML, SPA shell, dormant login markup, or HTTP 200 alone cannot
   establish an authenticated owner. Keep public reachability distinct from
   protected authorization.
4. **Repair the first failing boundary.** Ready provider plus missing consumer
   credentials means a propagation defect. A tool approval, attachment, focus,
   or result-filter failure means `blocked_runtime`, not expired website login.
   An authenticated account with missing partner/space entitlement needs that
   entitlement resolved; repeating login does not grant it. Unknown 403 causes
   remain unknown. Reuse the documented browser recovery path rather than
   spawning repeated sessions or switching to an unapproved control mechanism.
5. **Acquire only when required.** If the provider is missing or the protected
   result requires reauthentication, try an existing verified refresh flow once
   for a safe read. Otherwise use normal sign-in on the intended site, request
   only the necessary user action, and retain the resume point. Do not ask again
   for authorization already given. An interactive challenge follows the actual
   tool/service requirements; token renewal is not authority to bypass it.
6. **Verify the handoff and continue HTTP.** Pass only the service-scoped current
   credentials to the real child process through an in-memory broker, stdin,
   protected store, or environment interface already appropriate to the project.
   Re-run the protected probe in that process. Reuse the verified contracts and
   saved frontier without returning to the UI for every item.

Service adapters own exact cookie/header names, account selectors, allowed HTTPS
origins, response schemas, and refresh contracts. A Naver cookie is not a generic
partner credential. Do not forward login material to an asset/CDN or another
service merely because a response mentions it. Keep credentials out of command
arguments, logs, evidence, Git, and plaintext handoff files, including ignored
runtime files. Inspect values in memory only as needed; status exposes names,
booleans, types and nonsecret scope, not secrets or their fingerprints.

## Separate renewal capabilities

| Observation | What it establishes | What remains unproved |
|---|---|---|
| Current browser session reaches an HTTP child | Run-scoped credential propagation | Password login, persistence, expiry recovery |
| Trusted `Set-Cookie` changes the next HTTP request | Server-directed cookie rotation | Recovery after the login session has expired |
| Normal SDK issues another action token | SDK input reissuance | Login renewal, token TTL, safe token reuse |
| Two fresh headless processes succeed with the same initial session | Headless restart with that session | A new login or survival of the credential provider's restart |
| Verified refresh exchange and protected read after rejection/expiry | That observed renewal path | Indefinite unattended access, other accounts or hosts |

Do not derive a refresh endpoint, token TTL, refresh token, or opaque document ID
from a sample or local timeout. Preserve observed blank or opaque fields when
valid for the captured contract. Enforce a conservative local handoff-age limit
as a client rule, explicitly distinguished from server expiry semantics.

Accept credential rotation only from approved response origins, using the
project's bounded cookie/session implementation. Test domain/path matching,
expiry and deletion, and avoid duplicate ambiguous credential entries. Recheck
the required credentials after a response: a deleting response cannot leave the
session marked usable. Reject invalidation clearly and preserve the pending job
for resume. A new token or job ID must not permit another uncertain write.

Use statuses that preserve the failure boundary, such as `provider_missing`,
`provider_ready`, `propagation_failed`, `auth_unverified`, `authenticated`,
`reauth_required`, `blocked_entitlement`, and `blocked_runtime`. These describe
evidence; no naming convention itself proves authentication.

## When a headless SDK is required

Use the existing authorized normal SDK/provider when the target requires it.
Keep the helper explicit and separate from HTTP transport. Do not use fabricated
tokens, old captured hidden forms, stealth patches, or disabled access controls.
Prefer event/element readiness over arbitrary delays. If a tool result is empty
or filtered, inspect a bounded safe schema/type/status result before concluding
that the website failed; never dump raw credentials to diagnose the filter.

If an input can only be observed by intercepting a business submission, first
install a fail-closed block for that exact write and any associated save path.
Abort the browser request before accepting its in-memory envelope. If that block
cannot be enforced and verified, do not trigger the submission. Check the
authorized target, payload, method, encoding, field uniqueness, fresh token and
document provenance. Bind the intended final document/job to the envelope; a
fixed diagnostic seed is not authorization for a different commercial payload.

For the separated headless-to-HTTP pattern, close the helper before the HTTP
child starts, reject any uncancelled browser write, and record the two outcomes
independently. Validate the final payload and applicable gates immediately before
the write. Treat a network timeout as unknown success: journal a returned stable
resource ID before readback and reconcile by read, without resubmitting. Journal
identity must not depend only on an SDK token or a replaceable job ID.

Readback checks the complete intended outcome, including owner, target,
visibility and full ordered content where applicable. A successful private
technical post verifies its transport/input flow; it does not verify public or
commercial publication gates. Browser rendering requirements remain separate
from HTTP success. Clear handoff secrets and terminate owned helpers on success
or failure; never stop an unrelated browser or another session's worker.

## Completion receipt and useful checks

Keep the existing five operation states and add only needed phase metadata:

```text
scope: host, account/space, operation, code revision, checked time
execution: mode; browser engine/window/extension use by phase
session: provider, actual runner, protected probe result, reauth state
renewal: cookie rotation, SDK reissuance, login renewal, provider-restart recovery
write: cancelled browser request, HTTP submission, reconciliation, readback
continuation: pending work and the first unresolved boundary
```

Store unknown or unrun states explicitly. Maintain per-phase and whole-operation
`remnant_free` separately when they differ. Do not reuse a historical `true` as a
current login check. A dry run, mock, private fixture, and real production job
must retain their different validation scopes.

Use meaningful existing runner tests before adding new infrastructure: required
credentials reach only the intended child; malformed/expired/cross-origin values
fail; cookie deletion invalidates auth; wrong account or login HTML fails; an
open helper or uncancelled request prevents HTTP submission; expired envelopes
fail before writing; a lost write response reconciles or needs review without
automatic resubmission. Tests establish those invariants, not fresh live login.
