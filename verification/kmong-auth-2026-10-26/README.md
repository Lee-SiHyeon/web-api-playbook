# Kmong authenticated owner read — 2026-10-26

Normal Google sign-in, owner-assisted Google 2FA, and the OAuth return completed in the authorized Chrome browser on host `140.228`. Kmong required a new buyer account. Registration was submitted once with mandatory age/terms consent; optional privacy and marketing consent were false. Kmong phone verification remains incomplete.

The browser owner probe at `GET https://kmong.com/api/user/v3/me` changed from HTTP 204 to HTTP 200 and matched the intended Google account. A separate native HTTP probe also returned 204 without credentials and 200 with only the current `x-kmong-authorization` cookie. No Google credentials or other browser cookies were handed to the account client.

The recorded production CLI then:

1. Imported the single service credential through process-memory stdin, verified the expected email and positive owner ID, and saved the scoped session with Windows DPAPI CurrentUser.
2. Read local status in another process; it reported `configured:true` and `currentAuthentication:not_checked`, with zero requests.
3. Ran `owner` in two further fresh Node processes (PIDs 22004 and 40516). Both made exactly one direct HTTP GET, restored the encrypted session, matched the pinned account, and returned 200 JSON. Neither process used a browser, reran login, or imported another credential.

The runtime file hashes were identical before and after all four CLI invocations and matched the repository files. Only sanitized receipts, boolean identity checks, process IDs, and hashes are committed. The cookie, Google password, raw email, user ID, and raw owner response are absent from evidence. The encrypted store remains on Windows under the requesting user's identity.

```sh
node scripts/verify-kmong-auth.mjs
```

This verifies the dated artifacts, runtime hashes, and capability checklist offline. It performs no authentication or network request. The original public-reader evidence remains unchanged.

The reusable CLI implements owner verification and stored-session reuse. Automatic Google OAuth, token refresh, unattended renewal, phone verification, messages, orders, quotes, and payments are not implemented. The browser discovery probes are recorded separately from the browser-free CLI reads.
