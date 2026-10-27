# Soomgo capability frontier

This page separates working public reads, source-only route candidates, local request preparation, and external business actions. A source route is not a replayed API contract. The [2026-10-27 run record](../verification/jobs-freelance-2026-10-27/README.md) is the latest native/common CLI verification. The Oct 23 and Oct 26 evidence directories remain historical and immutable.

## Current capability map

| Area | Current state | Evidence boundary |
|---|---|---|
| Top and subcategory reads | Implemented; 2026-10-27 anonymous replay recorded | Category list and exact child-category reads; this does not prove every service form is available. |
| Provider search and bounded collection | Implemented; 2026-10-27 anonymous replay recorded | Search summaries only. A bounded cursor walk is not a complete provider directory or an availability guarantee. |
| Public provider profile summary, portfolio metadata, profile contents, and review metadata | Implemented and recorded in the 2026-10-27 public manifest | Exact `userId` path binding and optional expected provider-ID comparison are not Soomgo-account ownership checks. Normalized review text is redacted and media URLs are omitted; committed evidence stores review hashes and lengths rather than full text. |
| Bounded portfolio and review collection | Portfolio walk returned 20 of 20 rows over 3 pages and is complete for that profile. Review walk returned 6 rows over 2 pages and remains partial. | These results describe only the selected profile and observed window; they do not establish complete Soomgo-wide coverage. Both collection capability IDs are recorded in the dated manifest. |
| Service questionnaire schema and area-3 address options | The 2026-10-27 native CLI returned 13 form questions and 6,045 address options; both are recorded in the public manifest | Address coverage stays incomplete because the response has no total or continuation token. Conditional form coverage can also stay incomplete. |
| Local request draft | Local-only preparation exists | `request-prepare` consumes a saved form and caller inputs; it reports missing/unsupported answers and unverified gates. It makes no network request and sends no Soomgo request. |
| Login, current account, and owner-bound account reads | Naver login, owner pinning, persistent Windows DPAPI storage, and fresh-process reuse passed | Anonymous owner access returned 401; the Token-authenticated `/api2/users/me/` read returned 200 and matched the SSR owner. Optional marketing, select-information, and newsletter consent fields were false; `is_certify_name` was false. No owner identifiers or token values are recorded here. |
| Owner request lists and chats | Authenticated CLI receipts record 200 for opened requests, closed/expired requests, and customer chats; all three returned empty first pages | Requests used `Bearer` with `status=opened` and `status=closed,expired`, each `limit=15`. Chats used `Token` with `role=customer`. See the [auth run record](../verification/soomgo-auth-2026-10-27/README.md). Empty lists are valid observations, not proof of future absence. |
| Provider sent-quote detail and individual chat/message reads | Current Next bundles expose source routes; no authenticated replay of these detail/message routes is recorded | Do not infer message schemas from an empty chat-list result. No chat recipient or genuine lead exists for a write. |
| Request submission, quote submission, messaging, reservation, payment | Not implemented | The older bundle exposes a request-submit path, but no action is sent here. An actual quote/message/request needs the user's real target and payload, required authentication/contact steps, explicit consent, and a separately verified read-back. Never manufacture a lead or use fixture answers to submit one. No quote-send/message-send route has been established in this work. |

## Source-observed login and protected routes

The current public homepage manifest links the login page chunk at [`login-4390e6cb543b4ec6.js`](https://assets.cdn.soomgo.com/next/cf10966/_next/static/chunks/pages/login-4390e6cb543b4ec6.js). Its observed SHA-256 is `3a1eaf5d220ac39da15b9ac78612f5f04c22407a1fccb22f85a4f1480b902c9a`. It lists Email, Apple, Kakao, and Naver sign-in, and `GET /api2/users/me/` as the current-user read. The current [`_app` bundle](https://assets.cdn.soomgo.com/next/cf10966/_next/static/chunks/pages/_app-e0d1c064326ee297.js), SHA-256 `b4ee8f531f184afa29468f4c52616d75b4d5de40aaf6d0dc573b223e5b46c526`, defines two clients: `APICore` adds `Authorization: Token <authToken>`, while `APIBase` adds `Authorization: Bearer <authToken>`. The native auth run returned 401 without auth and 200 with Token, matching the SSR owner. Naver sign-in used required consent only; optional consent flags were false and `is_certify_name` was false. Sanitized CLI receipts and the bootstrap summary are in `verification/soomgo-auth-2026-10-27/`. Soomgo's [account help page](https://help.soomgo.com/hc/ko/articles/115007692808--%EA%B3%84%EC%A0%95-%EC%95%84%EC%9D%B4%EB%94%94-%EC%9D%B4%EB%A9%94%EC%9D%BC-%EC%A3%BC%EC%86%8C-%EB%B9%84%EB%B0%80%EB%B2%88%ED%98%B8%EA%B0%80-%EA%B8%B0%EC%96%B5%EB%82%98%EC%9A%94) names Email, Kakao, Naver, and Apple; Google's login option was not observed.

The current [`/received/quotes` page bundle](https://assets.cdn.soomgo.com/next/cf10966/_next/static/chunks/pages/received/quotes-5fe7a8b705268629.js), SHA-256 `7d18b2443a7a8436c29245b521a87ba0a29d16bbcf18001ad0673c7b323b50a`, reads `GET /v1/me/requests/sent` through `APIBase`. Its observed query uses comma-joined `status`, `limit=15`, and optional `after`; the page consumes an `items` array and `pagination.after`. This is the request list that feeds received-quote status/counts, not the standalone quote detail reader.

The current [provider quotes page bundle](https://assets.cdn.soomgo.com/next/cf10966/_next/static/chunks/pages/pro/quotes/[[...quoteId]]-c0a2445bc7d9c5e7.js), SHA-256 `9e0ca9861dcab1a171ab8d1b71f58fb43146ef024824e65c9eccc8b3676ded5c`, uses `APICore` for `GET /v1/chats/quotes-sent` and `GET /v1/chats/quotes-sent/{quoteId}`. The list query supports `service_id`, `start_date`, `end_date`, `quote_type`, `hire_status`, `is_read_quote`, `is_favorite`, and `cursor`; the page follows the returned `cursor` and reads a `results` array. It also uses `GET /v2/requests/received/{requestId}` for request detail. These paths have not been replayed with an authenticated client.

The current [received-quote detail bundle](https://assets.cdn.soomgo.com/next/cf10966/_next/static/chunks/pages/received/quotes/[requestId]-9ef319332c115c8d.js), SHA-256 `ff0a6a274a130f5f66582ff47dc06a2c28d05027b1c85151360e47dd0d6c9df4`, uses `APICore` for `GET /api/v2.4/chats/{chatId}/` and paginated `GET /api/v2.2/chats/{chatId}/messages/?next=...`. The page follows the response's `next` cursor. The exact chat-detail and message-item schemas still need a bounded authenticated read before implementing them.

An older first-party Vite client bundle, [`client-bundle.cqVbIhyw.js`](https://assets.cdn.soomgo.com/vite/ef0d619/assets/client-bundle.cqVbIhyw.js), SHA-256 `f104e06ba62e83b3ecaa5857dc8975f222b4232a6cf9c8b29b115c8e32227729`, also contains these route candidates:

- `GET /v3/requests/received` and `GET /v2/requests/received/{id}`
- `GET /v1/me/requests/sent` and `GET /v2/me/requests/sent/{id}`
- `GET /v1/me/quotes/sent`
- `GET /v1/campaigns`, `GET /v1/campaigns/{id}`, and `GET /v1/campaigns/{id}/quotes`
- `POST /v1/requests` and `POST /v1/requests/collection`

The routes from the older Vite bundle remain source candidates and do not prove they are active in the current Next deployment. The native CLI verification on 140.228 passed 24/24 commands, and the common CLI passed 5/5. The dated public manifest revalidated 23 execution entries and 20 capabilities, including 12 Soomgo capabilities. Provider sent-quote details and individual chat/message routes remain source candidates without authenticated replay. The empty chat list does not establish a recipient or justify a message write. The [2026-10-27 run record](../verification/jobs-freelance-2026-10-27/README.md) summarizes the sanitized execution evidence; the [auth record](../verification/soomgo-auth-2026-10-27/README.md) covers owner pinning and persisted-session reuse.

## Local request preparation

The current public/local CLI entrypoints are:

```bash
node scripts/freelance.mjs soomgo request-form --service-id=ID --service-slug=SLUG --service-name=NAME
node scripts/freelance.mjs soomgo address-options --depth=3
node scripts/freelance.mjs soomgo request-prepare --form=FORM.json --answers=ANSWERS.json --addresses=ADDRESSES.json
node scripts/freelance.mjs soomgo portfolio-collect --user-id=ID --size=8 --max-pages=3
node scripts/freelance.mjs soomgo profile-reviews-collect --user-id=ID --max-pages=2
```

Use a service ID, slug, and name returned by an actual Soomgo catalog read. `request-form` is a read; `address-options` currently accepts only the fixture-backed depth 3. `request-prepare` is offline and returns `prepared_only`, `networkUsed=false`, `writesSubmitted=0`, and `readOnly=true`. It does not confirm authentication, phone verification, account details, terms, or privacy consent. Conditional questions, image uploads, date ranges, and provider-specific validation can remain unresolved. Even a locally complete questionnaire is not a valid submission unless the service's full live flow has been verified.

An isolated normal hiring-UI capture observed answer mappings for one move request: question 4 uses answer ID 1, question 5's date field uses answer ID 1, and question 6's three address levels map to IDs 1/2/3 with empty `extraValue`. This records the local UI's answer shape only; it does not confirm the API accepts a submitted body. Conditional question inclusion and other field types remain open. No `/v1/requests` POST or read-back was performed.

## Authenticated account reads

`lib/web-auth/soomgo.mjs` implements an owner-pinned reader and a Windows `ProtectedStore` session. The normal Naver UI login is separate from the direct HTTP client. `session-import` reads the manually supplied auth token through hidden stdin; do not place it in command arguments, a URL, or evidence. The persistent Windows store uses DPAPI CurrentUser and stores only an origin-scoped `Token` header with no cookies. The client does not automate Naver OAuth or refresh credentials. The request-list operation switches to the observed `Bearer` scheme for `/v1/me/requests/sent`; customer chats use `Token` for `/api/v2.4/chats/?role=customer`.

```bash
node scripts/soomgo-account.mjs session-import --persist --store-dir=PATH
node scripts/soomgo-account.mjs owner --store-dir=PATH
node scripts/soomgo-account.mjs verify --store-dir=PATH
node scripts/soomgo-account.mjs requests --status=opened --store-dir=PATH
node scripts/soomgo-account.mjs requests --status=closed_expired --store-dir=PATH
node scripts/soomgo-account.mjs chats --store-dir=PATH
```

The [2026-10-27 authenticated-read record](../verification/soomgo-auth-2026-10-27/README.md) and [manifest](../verification/soomgo-auth-2026-10-27/manifest.json) record HTTP 200 for both request status filters and the customer chat list, with zero rows in each first page. The chat reader explicitly reports `complete=false`; it does not walk later pages. The records also bind the pinned owner, Windows DPAPI persistence, and separate-process reuse. An empty list does not mean there will be no future requests or chats.

The `is_certify_name=false` account flag means name certification was not established. No profile-save operation is part of this authenticated read client.

## Reverification policy

The default freelance verifier reads the new dated manifest offline. The explicitly selected Oct 23 and Oct 26 manifests retain their original evidence bytes and original execution dates. A fresh manifest must include only artifacts produced from its own runs, with exact response hashes and current implementation hashes; old proofs can only remain historical carry-forward evidence with their original timestamp. Public reads, account owner verification, persisted-session reuse, request/chat list reads, local request preparation, and external writes are separate capabilities and must not be inferred from one another.
