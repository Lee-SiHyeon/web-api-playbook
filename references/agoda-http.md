# Agoda public hotel reads

This reader replays two observed, anonymous consumer-site requests: hotel rates for a fixed set of 16 previously observed Vietnam properties, and the public campaign-card section. It is not an Agoda partner API and does not cover affiliate attribution, checkout, booking, coupon activation, or a complete property catalog.

## Run

Node.js 24+ and the repository dependencies are required. From the repository root:

```powershell
node scripts/agoda.mjs --help
'{"checkIn":"2026-10-13","checkOut":"2026-10-14"}' | node scripts/agoda.mjs rates
node scripts/agoda.mjs campaigns
```

`rates` accepts JSON on stdin up to 32 KiB. Optional `propertyIds` must be unique members of the 16-ID public snapshot in `lib/travel/contracts/agoda/public-request-template.json`. Dates must be valid, check-in must be today in Korea or later, and the stay must be 1–30 nights. Occupancy is fixed to the observed request: two adults, no children, one room, KRW. Unobserved fields and IDs fail before a request is sent. `campaigns` takes no input.

Successful output contains request metadata and a field-limited result. Failure output contains a stable error code and safe request metadata only; response bodies and raw server messages are not copied to stdout. The client has bounded response sizes and timeouts, waits between requests to the same host, and does not automatically retry.

## Observed requests

The rate flow first sends `GET https://www.agoda.com/ko-kr/`. The client parses the returned HTML as a static tree with `parse5`; it does not execute scripts. It accepts only one literal `window.agBootstrap = new Promise(resolve => resolve(<JSON>))` value and reads `core.userId` for the next request. That fresh public issuer value stays in memory and is never returned or persisted. The client generates a fresh UUID for `searchId` locally.

Rates use `POST https://www.agoda.com/graphql/search` with `operationName: "propertySummarySearch"` and the reduced query in `lib/travel/contracts/agoda/property-summary-query.graphql`. The caller supplies stay dates; the remaining structure comes from the checked-in public request template. Observed headers are `content-type: application/json`, `ag-language-locale: ko-kr`, and `ag-page-type-id: 90000`.

The template includes `PricingSummaryRequest.context.sessionInfo.isLogin: false`, `memberId: 0`, and `sessionId: 1`. Here `sessionId: 1` is a static value in the observed anonymous request contract. It is not the opaque browser session cookie or a reusable login token. The requests send no browser cookies, authorization header, or user-agent override. The template channel `cid: 1901817` came from Agoda's own `/deals` campaign navigation and the captured rate request; no outside affiliate ID was substituted.

Rates are quoted only when the returned property says both `isAvailable` and `isReady` are true and a positive KRW amount is present. The result preserves the source's per-room-per-night exclusive and inclusive prices and per-book inclusive values. It does not calculate a checkout total or claim the displayed amount is the final payable price. Identity coverage and price coverage are reported separately; a missing property or unpriced result makes price coverage partial or empty.

The campaign flow uses the same fresh public-page bootstrap, then sends `POST https://www.agoda.com/api/card/campaigns` for the observed `entire_page` section. Its observed public headers are `content-type: application/json`, `ag-language-id: 1`, `ag-language-locale: en-us`, `cr-currency-code: KRW`, `cr-currency-id: 26`, and `x-client-id: 2000`. Omitting the static client header produced HTTP 400 in discovery; the corrected observed request returned HTTP 200. This value is a public web-client constant, not an account credential. It returns a sanitized card projection and strips query strings and fragments from Agoda URLs. The observed response had nine cards: seven carried the Hotels & Homes category and two carried a coupon category. Categories can overlap; a card is not necessarily a hotel price or an eligible coupon. No coupon was claimed or activated.

## Coverage and limits

- The checked-in property IDs are a finite snapshot, not a search or full-catalog discovery mechanism. Arbitrary IDs are rejected, and the GraphQL client does not paginate.
- The recorded anonymous replay returned 16 of 16 selected property identities and positive KRW quotes for 14; two properties had no usable quote. This is a dated observation, not a guarantee of current availability.
- The campaign read covers only the observed `entire_page` section. It does not validate coupon eligibility, expiry dates beyond source text, or a booking discount.
- No CAPTCHA, bot challenge, access denial, or schema change is bypassed. Unexpected status, MIME, JSON shape, property IDs, or price types fail closed.
- No partner account, key, browser profile, cookie, or reusable user/session identifier is needed or stored.

The canonical parse5 client itself was also run against both public routes on 2026-10-05: HTTP 200, 16 selected property identities, 14 positive KRW quotes, and 9 campaign cards. See [the canonical live verification](../verification/agoda-http-2026-10-05.json); fixture tests remain separate from that live result.

The exact safe fixture lineage and file hashes are in [the Agoda provenance record](../provenance/agoda-2026-10-05.json). The sanitized response examples are under `tests/fixtures/agoda/`; the request template and reduced query are under `lib/travel/contracts/agoda/`.

Run the offline regression with:

```powershell
node --test tests/agoda.test.mjs
```
