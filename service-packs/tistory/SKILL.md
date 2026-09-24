---
name: tistory-api-only
description: Operate i-never-stop-study.tistory.com through observed HTTP contracts, including management reads, post publishing/editing/deletion, settings, scoped XHR discovery, DPAPI-backed Kakao renewal, and media upload. Other blogs require fresh contract and authorization verification.
---

# Tistory API-only

Target: `https://i-never-stop-study.tistory.com/` (아네스의 공부일지).

Use independent HTTP for known operations. Do not rediscover the site through browser navigation for every request. Read [references/operations.md](references/operations.md) for verified routes and safeguards. Search [references/api-catalog.json](references/api-catalog.json) by path for observed request/response fields; avoid loading the full catalog by default.

## Authentication and client

The repository includes the maintained Node.js 24 client. It stores the scoped cookie jar and account/blog binding in the current Windows user's DPAPI credential store. Run `npm run login:auto` before asking for a browser login: the client verifies stored auth, then renews a rejected Tistory session using the observed Kakao saved-account HTTP flow if that saved login still works. See [references/authentication.md](references/authentication.md) for the exact boundary and encrypted bootstrap procedure.

The saved-account renewal is not password, MFA, CAPTCHA, or consent automation. If Kakao requests further authentication, report reauthentication required and use an authorized one-time browser bootstrap. Never print, persist in plaintext, or commit cookie/token values, account selectors, raw HARs, session bundles, or private keys.

`scripts/client.mjs` supplies six statistics reads. `scripts/request.mjs` accepts explicit requests for this blog's `/manage/` routes on stdin. Both use the DPAPI provider when `TISTORY_COOKIE` is unset; that explicit environment override remains runtime-only for compatibility. Validate status, MIME, application result, and expected response shape. A successful helper exit alone is insufficient.

## Mutations and media

Distinguish post creation (`POST /manage/post.json`) from modification (`PUT /manage/post/{id}.json`). Do not infer complete update payloads from type-only schemas: retrieve current state or capture the relevant UI action, preserve unrelated fields, and verify the owner and public readback. For uncertain writes, reconcile the same journal before any retry. Authentication recovery never retries a business operation.

Image upload and ordinary MP4 file attachment use observed multipart `POST /manage/post/attach.json`; run `scripts/media-cli.mjs` and read [references/media.md](references/media.md) before transferring files. Native image captions are stored in the image shortcode. The MP4 File shortcode is a download card; distinguish this from inline playback. Upload, playback, and published content readback are separate evidence states.

## Discovery

Use the event logger only for an authorized new contract discovery. It is a foreground helper, not a login/session provider or background service. It retains sanitized metadata and body schema instead of raw request/response bodies. Browser/CDP discovery does not replace HTTP replay or operation-specific readback.
