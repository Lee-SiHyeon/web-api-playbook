# Windows authentication provider

## Normal operation

The provider uses a credential named `tistory-auth-state-v1` in the current Windows user's DPAPI store. It contains the origin-scoped cookie jar, the verified owner/blog binding, user-agent metadata, and a saved-account selector. Cookie values, account selectors, and IDs remain inside DPAPI or process memory; CLI output is limited to status and safe metadata.

```powershell
npm run login:auto
npm run session:health
```

`login:auto` verifies stored authentication with two independent protected reads: Tistory's authenticated account endpoint and the configured blog's management settings. If a Tistory request is rejected as unauthenticated, it obtains fresh login HTML and Kakao account-selection data, submits the observed saved-account action, follows the bounded OAuth redirects, verifies the same account and blog, then stores cookie rotations. A business request is not retried as part of that recovery.

`session:health` only checks existing authentication. `node scripts/cli.mjs login --renew` deliberately removes Tistory cookies from an in-memory session copy to check the renewal path; it is diagnostic, not a routine command, and is not needed after successful verification.

## Renewal boundary

Renewal is available only while Kakao accepts its saved login. Fresh CSRF, `sessionKey`, and OAuth code are read or issued during each exchange and are not persisted as replay templates. If Kakao rejects the saved login or requires a password, MFA, CAPTCHA, or consent, the client returns a reauthentication code. Those interactive challenges are not automated.

## Authorized browser bootstrap

If an authorized browser login is needed, `tools/session-handoff.mjs` starts a single-use localhost form with a five-minute lifetime. A supported browser tool may read only the relevant Tistory/Kakao cookies and encrypt the scoped bundle in memory using the helper's ephemeral RSA-OAEP public key and AES-256-GCM. Submit only ciphertext. The helper validates the target account and blog over HTTP, then stores the verified bundle in DPAPI under the session lock. Its private key and decrypted values remain in memory.

Do not read Chrome profile databases, write plaintext cookie exports, copy credentials through chat or clipboard, or place them in arguments, environment dumps, logs, evidence, or Git. The helper does not create a tunnel and is not a background service.

## Credential-store implementation

`scripts/secure-credential-store.mjs` calls `scripts/secure-credential-store.ps1`; the PowerShell helper uses Windows DPAPI CurrentUser and a user-only ACL. The Tistory library references this local copy so the repository works independently of the original monorepo. Media response bundles use separate `tistory-media-*` credential names and are loaded only in memory by `lib/media.mjs`.
