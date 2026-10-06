# Toss Sharelink HTTP authentication

## Scope

The maintained client uses the consumer Sharelink web service at `https://sharelink.toss.im` and the observed Toss Business sign-in flow. It stores only the Sharelink cookie bundle and the existing owner/read-contract baseline in the current Windows user's `toss-sharelink-state` DPAPI entry. It does not use Toss Partner OpenAPI credentials.

The implementation is a fixed local copy under `lib/web-auth/toss/`; it imports the shared `ProtectedStore` from this checkout. It has no runtime dependency on `affiliate-content-operations` or its environment variable. This auth pack exposes only session status and GET operations; it does not include Sharelink link issuance.

## Protected owner and health reads

Before using a stored session, the client calls the recorded member GET at `/api-public/v3/shopping-growth/sharelink/member` and compares each supported owner field present in the protected baseline (`publisherId`, `userNo`, and `bizUserNo`). Optional fields are checked only when saved; a mismatch fails closed. Health then calls the recorded `shopping-curation-sections` GET and returns only section, item, and deal-entry counts; it makes no stock availability claim from raw flags, and member/profile fields never leave the process.

`status` checks only protected-store availability. `health` and `ensure` perform named reads; `ensure` does not log in or renew. A rejected session returns `TOSS_REAUTH_REQUIRED`.

## Observed login contract

The local HTTP login follows the current observed first-party path: GET `business.toss.im/account/sign-in`, one form POST to `business-accounts.toss.im/v1/sign-in`, then only the observed allowlisted Toss redirects. The request is scoped to `business.toss.im`, `business-accounts.toss.im`, and `sharelink.toss.im`; redirects outside those HTTPS origins are rejected before a request is sent.

The user/password pair is accepted only from JSON on stdin. TTY input is raw with echo disabled; piped input stays in process memory. The password is cleared from the parsed input object after the attempt and is never saved. The login POST is sent at most once per command. Redirects that require a second factor, consent, account conversion, a password change, or another user action stop without inventing or replaying a request.

The HTTP path requires a previously stored protected owner baseline. Both local login clients validate the complete baseline before making any fetch; a missing or incomplete baseline stops without a network request. After the login redirect, the client performs an independent member read and compares all owner fields present in that baseline before persistence. It stores only service-scoped `TBIZAUTH`/`TGSID` cookies accepted by the cookie jar, then confirms the saved session and reads curation. Rejected login, malformed member response, owner mismatch, or out-of-scope cookie state never replaces the existing DPAPI entry.

## Evidence boundary

The source implementation completed one live login on 2026-10-06, matched the protected owner, stored DPAPI state, and read seven curation sections. The sanitized [login receipt](../verification/toss-web-login-live-2026-10-07.json) records that source checkout revision. On 2026-10-07 KST, a fresh `web-login toss ensure` against the final playbook implementation reused the protected session, matched the owner, returned HTTP 200, and read seven sections, 84 items, and nine deal entries without sending a login POST. The final health projection makes no stock availability claim. See the separate [playbook ensure receipt](../verification/toss-web-login-cli-live-2026-10-07.json), which records the exact source hashes checked.
