# API contracts and limits

These clients preserve the donor's observed request shapes. Packaging and offline tests used injected responses only; no live service call or credential was used. A successful unit replay does not establish that a current account can authenticate or that a provider still serves the same schema.

## Coupang category navigation

The category root request is `GET https://www.coupang.com/n-api/web-adapter/category-list?_=<timestamp>` with `cookie` and `accept: application/json`. Its decoder accepts the observed `data.gnb` component groups and records menu edges separately from category nodes. Coverage is the navigation tree returned by that endpoint, not all site inventory.

Lazy expansion is `GET https://www.coupang.com/n-api/first-sub-category` with numeric `linkcodes` and `component`, plus `channel=user`, `isPriceRange=false`, `rocketAll=false`, and `isGoogleLanding=false`. The response is accepted only as JSON with a `children` array matching the observed schema. A missing `hasChild` flag is recorded as an omitted UI expansion hint; nonempty inline `children` arrays are rejected until a traversal contract is added. Traversal checkpoints keep component IDs distinct from category IDs, preserve shared edges and stop after a failed branch rather than fanning a failure out to siblings.

`decodeCategoryListing` handles the observed RSC row/reference shape and validates exact product, item, vendor-item and page identity. It is a parser only: it does not fetch a listing. The final-page representation and independent page replay remain unverified, so the result keeps `terminationVerified:false` and `independentReplayVerified:false`.

## Coupang Partners

The client supports these observed operations on `https://partners.coupang.com`:

| Operation | Method and path | Body |
| --- | --- | --- |
| `dashboard` | `GET /api/v1/dashboard` | none |
| `search` | `POST /api/v1/search` | captured `filter`, `page`, and `deliveryTypes` |
| `productLink` | `POST /api/v1/banner/iframe/url` | `{ "product": <observed product object> }` |
| daily report | `POST /api/v1/report/daily` | two date filters for `startDate` and `endDate` |

Partner requests use `cookie`, `x-token`, `lang: ko`, and JSON accept/content-type headers. The first three operations also send the observed Partners referer; the daily-report operation does not. Search limits page size to 36 and validates product/total fields. Product-link responses must return HTTPS from `link.coupang.com` or `coupa.ng`; this host check is not a destination readback.

Daily report rows are constrained to the requested date range, duplicate days are rejected, and all five numeric metrics are required. The report is the default account channel and explicitly sets `articleAttributionVerified:false` and `settlementVerified:false`.

## Product reviews

Review sampling uses `GET https://www.coupang.com/next-api/review` with product ID, page, size 10, sort, rating filter, `ratingSummary=true`, and an empty market selector. Supported samples are `best`, `latest`, and one-star `critical`. Only page 2 of `best` is enabled by the donor's observed boundary. This is a bounded, nonrepresentative sample; variants may differ. Evidence mode stores review text hashes, while synthesis-input mode returns source text in memory/output for caller use.

## Measurement snapshots

The snapshot reads Partners `/api/v1/dashboard`, Tistory `/manage/v2/statistics/blog/count`, and, when post IDs are supplied, Tistory `/manage/statistics/dashboard/topEntry.json`. Set `TISTORY_BLOG_ORIGIN` to the HTTPS origin of the account's own `*.tistory.com` blog; the client rejects other hosts and paths before attaching the cookie. A missing post from the top list is represented with `count:null` and `not-in-top-list`; it is not converted to zero. Blog metrics are whole-blog values. Commission is reported commission, not net settlement, and article attribution and organic traffic remain unverified.

## Tistory comment intake

The sanitized intake poll uses `GET /manage/comments.json` and `GET /manage/comments.json?page=N` with `cookie` and JSON accept headers. It accepts a bounded page budget of 50, checks stable reported totals and unique IDs, and records when offset pagination stops without claiming a transactional snapshot. Only comments whose post IDs were supplied become intake candidates. Persisted records contain comment/post/parent IDs, body hashes, status and timestamps; they do not contain comment text, author, IP or other source fields. Raw comment text is inspected only in memory by `matchReviewRevision` and must be treated as untrusted customer input.

## Local observations and persistence

Price maintenance reuses the Partners first-page search contract with `pageNumber:0`, `size:36`, and empty `deliveryTypes`. It caches identical query results within one run, stops remaining offers after a shared search failure, and records exact three-part option identity. Its receipt is a local observation only; it does not alter a post or create a publish task.

Affiliate link issuance writes a local `intent` record with the option key and payload hash before the Partners POST. On success it records `generated`, response hash and `destinationVerified:false`. An existing `intent` is never retried automatically. The donor's separate scheduling adapter is omitted because it binds to that repository's `OPERATIONS.json`, `knowledge-index.json`, fixed blog origin and executor.

## Public post health

`checkPublication` sends an unauthenticated `GET` to an exact numeric post path on the configured Tistory blog origin. It checks title, disclosure, and affiliate-link string markers and stores the response hash, status and marker result, not the HTML body. A verification request may affect view counts; marker presence does not establish layout, working affiliate destinations, current price, stock, or conversion.

## Tistory overlap and remaining donor surfaces

The donor's autosave, publication-context, publish, content-update, and private owner-comment workflows overlap the Tistory service pack. The available Tistory consolidation ref `153e5e127f1e3d683cf085b9f9fa27c881f917b3` already ports these source modules under `service-packs/tistory/lib/workflows`; they are not duplicated here.

The donor's hourly intake, intake-review queue, and publication-health scheduling adapters remain outside this pack because they depend on its private `OPERATIONS.json`, case ledger, and executor. Autosave, publication-context, publish, content-update, and private owner-comment workflows are already in the Tistory service pack from the reviewed consolidation ref. Standalone article layout checks use Playwright and remain outside this HTTP pack. Tistory account/post statistics, sanitized intake, and public health checks remain here as read-only automation workflows; they have not been copied into the Tistory service pack by this migration.
