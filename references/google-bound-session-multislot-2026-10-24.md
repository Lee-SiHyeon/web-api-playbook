# Google device-bound session and multi-slot Flow refresh (2026-10-24)

Observed on the owner's Windows runner with the automation Chrome (Chrome 158, loopback CDP 9333) and four Flow slots
(`FLOW_AUTHUSER` 0–3, one Flow project each). Maintained code: affiliate-content-operations/apps/google-flow-api
(`src/cdp-session.mjs`, `src/session-sync.mjs`, `src/start-with-recovery.mjs`); consumer: shorts-anatomy aihost
(`lib/flow-accounts.mjs`). Related: [Flow HTTP boundary](google-flow-http.md), [sanctioned refresh](session-refresh-sanctioned.md).

## Symptom

All four slots failed a credits read at once. Slot 0 returned `FLOW_DOCUMENT_REQUEST_TOKEN_MISSING`; its Google SSO recovery
stopped at `ServiceLogin` with `FLOW_SSO_RECOVERY_LOGIN_REQUIRED`. Slots 1–3 returned `FLOW_DOCUMENT_REDIRECT` with category
`flow_project`: `/u/N/project/<id>` was redirected to `/project/<id>` (Flow dropped a slot it no longer recognised). That category
was not classified as recoverable, so no recovery ran for slots 1–3.

## Observations (values never logged; hashes are 8-hex sha256 prefixes)

| # | Observation | Method |
|---|---|---|
| 1 | The five stored bundles (four Flow slots + Google broker) carry the **same** `SID`, `__Secure-1PSID`, `OSID`, `__Secure-OSID`. Only `__Secure-1PSIDTS`/`3PSIDTS` and `SIDCC` differ. One Google multi-login session serves every slot. | hash comparison of DPAPI bundles |
| 2 | All cookie expiries are ~1 year out. Session death is server-side invalidation, not client expiry. | bundle metadata |
| 3 | The Google broker was captured 2026-10-22 and never refreshed: the account doctor re-handed only Flow cookies (`--only flow`). Its 1.5-day-old `__Secure-1PSIDTS` was rejected. | bundle metadata + recovery hops |
| 4 | In the browser `__Secure-1PSIDTS` changed about every 8 minutes (02:53→02:58→03:06→03:14Z). Over 25 minutes no page-visible response set it. `POST /RotateCookies`, `gen204` and `RotateCookiesPage` set only `SIDCC`/`__Secure-1PSIDCC`/`__Secure-3PSIDCC`; `POST /ExpireGapsSession` set `__Host-GAPSTS`. | passive CDP (all page/iframe/worker targets) |
| 5 | The profile's `Preferences` has `bound_session_credentials_bound_session_params` for `https://google.com/` with `sidts_session` and `gapsts_session`. The generic `Network/Device Bound Sessions` table had 0 rows. | key names only |
| 6 | A stored copy kept working for every slot for at least 44 minutes after capture while the browser rotated `PSIDTS` several times (probe stopped by host memory pressure at 44 min, so the grace window upper bound is unmeasured; 1.5 days is beyond it). | read-only document GET every 10 min on an in-memory copy |

Conclusion: Chrome's built-in Google bound-session credentials refresh `__Secure-1PSIDTS` (and `__Host-GAPSTS`) from the browser
process with a device key. No HTTP-only renewal exists for that cookie without the key. **Do not extract, export or emulate
the bound-session key**; it is the protection against cookie theft. `RotateCookiesPage`/`RotateCookies` replays are SIDCC
maintenance, not session renewal.

## Pattern adopted (option A: keep the browser, remove the human step)

1. **One sync for all slots.** Read the cookies once from the signed-in automation browser over loopback CDP and hand them,
   encrypted per receiver, to every slot's DPAPI store and to the Google broker (broker stays bound to slot 0's project, which
   the SSO recovery checks). `node src/session-sync.mjs [--verify] [--watch 1800]`. Measured: 27 s for 4 slots + broker, then 4/4
   credits reads OK.
2. **Recovery order at start-up.** On a recoverable document failure: browser sync first (skipped when CDP is down) → protected
   Google SSO recovery (slot 0 only; a secondary slot would hit `PROJECT_CONFLICT`) → otherwise keep the original error.
   A secondary slot's `flow_project` redirect is now recoverable. One retry only; never after a create.
3. **Refresh inside the grace window.** Run the sync on a schedule shorter than the measured window (30 min chosen against the
   ≥44 min observation). With a fresh broker the SSO fallback was verified live (owner, project and protected read verified,
   925 media).
4. Consumers call one helper (`syncFlowSessions`) instead of per-account `cdp-handoff --only flow`; one sync per check run.

The browser process must stay running and signed in. If it is down, the sync logs `CDP_UNAVAILABLE` and the SSO fallback can
cover slot 0 only while the broker is still inside its own window. Expired Google authentication still needs a normal
first-party sign-in by the owner.

## Option B (not adopted)

Disabling Chrome's Google bound-session feature for the automation profile and signing in again would produce an unbound
session that plain HTTP rotation might refresh. Not verified here, and it removes the account's cookie-theft protection;
it is an owner decision, not a default.

## Reproduce the observation safely

- Compare stored bundles by sha256 prefix of selected cookie values; never print values or owner addresses.
- Observe the browser passively (`Target.setAutoAttach` flatten, `Network.*ExtraInfo`) and log only paths, methods, statuses
  and Set-Cookie names; poll `Storage.getCookies` for the hash of `__Secure-1PSIDTS`.
- Probe lifetime on an in-memory copy with `redirect: 'manual'`; do not let the probe write rotated cookies back to the store.
- Read `Preferences` key names only; copy the `Device Bound Sessions` SQLite file before reading row counts; never read key material.
