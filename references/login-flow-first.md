# Login flow first

Pin down the login/auth flow of a service **before** feature discovery. Every
later operation depends on it, and a careless login attempt can lock the
account or trigger the site's bot defences for the whole host. This document is
a procedure and capture template; it does not install a credential provider or
prove that any site's login is automated.

## 1. When this applies

- Any new service whose target operations need an authenticated account.
- Before opening a browser to capture feature XHRs, and before asking the user
  for another login.
- Read together with [browserless-login-flow.md](browserless-login-flow.md)
  (login phases and recovery) and
  [runtime-credential-propagation.md](runtime-credential-propagation.md).

Output of this step: a filled capture sheet (§2), a session/renewal contract
(§3–§4), declared hand-off points (§5), a re-login and pacing policy (§6–§7),
one verification receipt (§8) and the checklist entries (§9).

## Reference sources

Naver code paths below refer to the current app in
`Lee-SiHyeon/affiliate-content-operations` at `apps/naver-blog-api` (the copy
under `service-packs/naver/apps/naver-blog-api` is older and lacks some files,
e.g. the per-account lock and re-login cooldown). Naver is the reference for
session reuse, cooldown, lock and the account-protection stop. Its
`--challenge-codex` mode, which is enabled in `login:auto`, answers the image
challenge automatically. That mode is **not** part of this pattern. Use the
manual hand-off (`--challenge-stdin`, or stop at the challenge) as §5 requires.

## 2. Capture sheet

Record metadata only — field names, endpoints, types, order — never values.

| Item | Record |
|---|---|
| Login page | Method, URL, redirect parameters, final form action |
| Form fields | Visible and hidden field names; which are dynamic per page load |
| Password handling | Plain, RSA, ECDH/AES or other; where the key/session key is fetched from; which form field carries the result and which plain fields must stay empty |
| Client tokens | SDK- or script-issued tokens the form requires, and which process produces them |
| Issuance | Endpoint(s) that set session cookies or return access/refresh tokens; cookie names and domains |
| Redirect chain | Every hop after the login POST, including protocol changes |
| Logged-in signal | A protected, read-only endpoint whose response identifies the owner |
| Challenge signals | How 2FA/OTP, captcha, account-protection and bot-check pages are recognised |

Reject unexpected extra/duplicate form fields or a changed action URL instead of
guessing. Naver reference: `GET nidlogin.login` (form, dynamic key, hidden
fields) → `GET /login/dynamicEcKey/{key}` (P-256 public key) → `POST
nidlogin.login` with `eccpw` and a fresh `wtoken`, plain `id`/`pw` empty. See
[naver-login-xhr-2026-09-23.md](../service-packs/naver/apps/naver-blog-api/docs/naver-login-xhr-2026-09-23.md).

## 3. Session persistence

- Store login identity and session separately (Naver: `naver-login-identity`,
  `naver-blog-session`). Save the session only after a protected owner read
  succeeds.
- Store the User-Agent with the session and keep it on cookie rotation.
- Accept cookie rotation only from observed first-party origins.
- Protected store per runtime: Windows DPAPI locally; Vercel environment
  variables / encrypted DB row for hosted runners; stdin/memory for children.
  Never plaintext files, command arguments, logs or Git.
- Use a per-account session lock (Naver: `scripts/naver-session-lock.mjs`) so
  two processes never log in at the same time.

## 4. Expiry and refresh detection

1. Reuse first: check the saved session with a protected read (Naver
   `naver-login-cli.mjs --reuse-session` → `sessionReused: true`,
   `loginPostCount: 0`).
2. Only an explicit provider rejection (401, login redirect for the protected
   resource, documented error code) means `reauth_required`.
3. Network errors, 403 with unknown cause, bot-check pages and wrong-owner
   responses are **not** expiry. Record them as such and do not log in again.
4. Try a verified refresh path once, then a single password login if allowed.
5. Health checks (`session:health`) read only; they never start a login.

## 5. Hand-off points (stop and hand to the user)

Stop automation and hand off to the user when any of these appear:

- 2FA / OTP / device confirmation;
- captcha or any interactive challenge;
- account-protection or "unusual activity" pages (Naver
  `/user2/help/idSafetyRelease` → `ACCOUNT_PROTECTION_REQUIRED`);
- bot-check / access-denied pages (e.g. Akamai).

At a hand-off: persist the resume point, send no further login POSTs, tell the
user exactly what to do, and resume only after they confirm. Do not try to
solve challenges automatically or get around bot checks. After the user
finishes, verify with one protected read before continuing.

## 6. Re-login policy

- Automatic re-login cooldown per account (Naver:
  `AUTOMATIC_RELOGIN_COOLDOWN_MS = 6h` in `scripts/naver-login-state.mjs`,
  tested by `tests/naver-login-relogin-cooldown.test.mjs`).
- Lockout state: once account protection is recorded, every later login stops
  with 0 POSTs until the user recovers the account and clears it explicitly
  (Naver: `login:http -- --account-recovered`).
- A login POST with an unclear result is never retried automatically.
- Never retry authentication errors in a loop.
- Note: Naver's HTTP login allows one follow-up POST after a challenge is
  cleared. Under this policy that follow-up happens only after the user has
  completed the hand-off (§5).

## 7. Login attempt pacing

- At most **one** automatic login attempt per account per run.
- If a second attempt is justified, wait minutes, not seconds, and re-check the
  saved session first.
- Stop immediately on 403, a bot-check page, captcha or "request failed" dialog;
  these are hand-off points (§5), not retry signals.
- After a block, wait it out and check later with a **single** read-only
  request; do not probe repeatedly.
- Apply the same pacing to UI-driven logins in a browser.

Failure case — Coupang, 2026-10-14: three rapid automated login attempts
(~19:28 KST) were refused with 403 ("데이터 요청에 실패 하였습니다"). Akamai then
blocked the whole browser/IP: home and login pages returned Access Denied, and the
user's own manual login on the same browser was blocked too, so no comparison
could be captured. One attempt followed by a hand-off would have kept the host
usable. Coupang API/debug notes: [coupang-debugging.md](coupang-debugging.md).

## 8. Verification receipt

Record without secrets: service, account scope, host, time (with zone), code
revision, `protectedOwnerRead`, `actorMatched`, `sessionReused`,
`loginPostCount`, attempt timestamps, hand-off reason if any, and resulting
state (`ok`, `reauth_required`, `handoff_required`, `blocked_unknown`).

## 9. Checklist entries

Every service checklist whose operations need login includes these
capabilities. They are `conditional` in the template; mark them `required` and
`applicable` when the service needs login (see
[template](../checklists/template.json)):

| id | Meaning |
|---|---|
| `auth.login_flow_captured` | Capture sheet (§2) filled and stored |
| `auth.session_persist` | Session saved after owner read and reused across processes (§3) |
| `auth.reauth_policy` | Expiry detection, cooldown, lockout and hand-off states implemented (§4–§6) |
| `auth.attempt_pacing` | Single-attempt limit and stop-on-block enforced and tested (§7) |

## 10. Examples

- Naver (reference implementation): `service-packs/naver/README.md` §2,
  and in affiliate-content-operations `apps/naver-blog-api`:
  `scripts/naver-login-cli.mjs`, `naver-login-http.mjs`, `naver-login-state.mjs`,
  `naver-session-lock.mjs`, `session-vault.mjs` (excluding the automatic
  challenge answerer `naver-login-vision.mjs`).
- Tistory (Kakao session): `service-packs/tistory/references/authentication.md`.
- Inpock / LinkPrice (password + token): [inpock-login.md](inpock-login.md),
  [linkprice-login.md](linkprice-login.md).
- OTP flows: [web-login-observed-contracts.md](web-login-observed-contracts.md).
- Coupang (pacing failure): §7.
