# Kmong browser sign-in and protected owner read

This helper begins after the account owner has signed in through Kmong's normal UI. Google sign-in is supported by Kmong, but this repository does not automate Google's OAuth or 2FA flow. The owner read and later reads use direct HTTP after a one-cookie session import.

## Evidence boundaries

Keep these phases separate:

1. **Browser sign-in:** complete Kmong's normal Google flow in the approved browser, with account-owner assistance for any required challenge. This phase is `browser_automation` and is separate from the reusable HTTP client.
2. **Session handoff:** `scripts/kmong-account.mjs session-import --persist` accepts a bounded JSON object on hidden stdin. It accepts only the `x-kmong-authorization` cookie scoped to `.kmong.com`, path `/`, `Secure`, and `HttpOnly`; it does not accept passwords, refresh tokens, other cookies, or extra fields.
3. **Protected owner read:** the helper uses `ScopedSession` to issue one GET to `https://kmong.com/api/user/v3/me`, with redirects disabled and only the Kmong origin allowed. It requires JSON and an exact match to the expected email plus the pinned `USERID` on subsequent checks.
4. **Session reuse:** a later Node process reloads the DPAPI-protected store and repeats the same owner read. It does not rerun Google login or import a new cookie.

The owner response contains account fields including `USERID`, email, username, `is_mobile_auth`, and `social_provider`. The client returns only non-secret status and receipt fields; it does not put the email, user ID, or cookie value in evidence. A successful HTTP status by itself is not owner proof.

A browser owner probe may be used during login discovery to identify the route and confirm the intended owner before the CLI flow. Record that as a separate `browser_owner_probe` bootstrap phase. The `auth.owner` and `auth.reuse` receipts are only the later CLI GETs: they set `browserUsed:false` and truthfully record `credentialsUsed:true` and `cookiesSent:true`, without storing cookie names or values.

## Public source observations

Kmong's [login update](https://kmong.com/article/2606) states that Google accounts are supported for sign-in. The current public recovery page bundle contains a client-side navigation to `/?open=login_modal&next_page=...` after account recovery. That is a UI route candidate, not an API login contract. The login modal is client-rendered; an anonymous SSR GET to that URL does not expose its controls.

The observed first-party bundle `/_next-market-desktop/_next/static/chunks/15abyka9hdvve.js` (SHA-256 `2ec4c860b450fd007193300a5065656d174649fa6ecf4d593cca0c6cc7bc87fc`) defines:

- `getAuth()` → GET `/api/user/v3/me`; it treats HTTP 204 as unauthenticated.
- `getMSAAuth()` → GET `/api/msa/user-app/user/v1/users/me` and returns the response data.
- `getSNSLoginUrl(provider, params)` → PATCH `/api/kid/api/authentication/v1/oauth2/web/{provider}`.
- `loginWithOAuthProvider(provider, data)` → POST to that same provider path with `requiredAuth: true`.

The provider-route helpers are source candidates only. The current CLI does not call them. Do not infer that the POST is a Google sign-in request or use the dynamic provider route outside the normal UI flow.

The first-party `dynamic-env.js` response (SHA-256 `bc93828a4462af4d5250c01eec751c58225a85912211a6e93983238534665a55`) maps `/api/msa` calls to `https://api.kmong.com` and `/api/kid` calls to `https://kid.kmong.com`. The owner helper currently uses the separately observed `https://kmong.com/api/user/v3/me` route. The bundle defines these authorization cookie names: `x-kmong-authorization`, `x-kmong-authorization-exp`, `x-kmong-authorization-refreshment-exp`, and `x-kmong-oauth2-csrf-state`. The helper imports only `x-kmong-authorization` for the owner check.

## Commands

`status` reads only local store metadata and always reports `currentAuthentication: "not_checked"`.

```text
node scripts/kmong-account.mjs session-import --persist --store-dir=<protected Windows store>
node scripts/kmong-account.mjs owner --store-dir=<protected Windows store>
node scripts/kmong-account.mjs verify --store-dir=<protected Windows store>
```

`session-import` reads its JSON on hidden stdin, clears the parsed cookie and expected-email values after use, performs the owner GET before saving, and persists through `ProtectedStore`. On Windows the provider is `Windows DPAPI CurrentUser`. Reuse from a different Windows identity or host is not established. `--memory` is process-local and cannot establish persistent reuse.

The input shape below uses placeholders. Supply the current, authorized Kmong session through hidden stdin; `expiresAt` is the observed cookie expiry in ISO 8601, or `null` for a session cookie.

```json
{
  "schemaVersion": 1,
  "service": "kmong",
  "expectedEmail": "you@example.com",
  "cookies": [{
    "name": "x-kmong-authorization",
    "value": "<current Kmong cookie supplied in memory>",
    "domain": ".kmong.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "expiresAt": null
  }]
}
```

Do not put the cookie in a command argument, file, environment variable, evidence, or Git. Use the hidden stdin path directly. The protected store contains the expected owner email, pinned user ID, and scoped session under DPAPI; verification artifacts contain only booleans, timestamps, request metadata, and code hashes.

## Re-authentication and limits

The helper does not implement automated OAuth, password login, token refresh, cookie rotation recovery, or unattended renewal. HTTP 204/401 and cookie deletion require a normal UI sign-in followed by a new explicit import. A 403 is `KMONG_AUTH_FORBIDDEN`; a challenge HTML page, redirect, throttle, schema failure, owner mismatch, and transport failure remain distinct outcomes.

`auth.owner` proves one authenticated owner-bound GET. `auth.reuse` requires at least two successful owner reads in distinct fresh processes from the same persistent provider, with the pinned owner matched each time and no login/import in the reuse processes. `auth.browser_bootstrap` is recorded as a manual browser phase only; it is not a `pure_http` login capability.

Only the current-user owner endpoint is implemented here. Messages, orders, seller information, and other protected data routes remain source candidates until separately reviewed and executed through the same owner-bound session.
