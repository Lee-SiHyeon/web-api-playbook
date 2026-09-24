# MyRealtrip hotel promotion publication contract

`hotel_promotion` is a separate format for the requested **202609_MONOGRAM**
campaign. It describes conditional advertised starting prices and a dated room
listing; it does not assert a booking, available inventory or a redeemed coupon.
The existing `travel_itinerary` adapter remains an existing-post tour update.

The separately dispatched [iclub two-property contract](iclub-hotel-contract.md)
uses the explicit local key `iclub_202609` for the requested November comparison.
It has its own room, price, benefit and two-banner ownership checks; none of the
Monogram campaign requirements below are relaxed or reused as false facts.

The implementation is
[`hotel-promotion-contract.mjs`](../apps/naver-blog-api/scripts/gates/hotel-promotion-contract.mjs).
It plugs into the normal commercial snapshot, affiliate, artifact and reference
layout gates. There is no additional publisher, write endpoint or bypass.

## Supported operation and evidence

- `publicationBundle.format` must be `hotel_promotion` and contain one campaign
  product. `commercialSnapshot` must be that same product under the existing
  fingerprint checks.
- `target` must be `{ "type": "create" }` with no `logNo`, and `inputProvider`
  must be `headless_sdk`. Fresh SDK inputs precede the separate HTTP writer.
  This adapter does not establish browser-engine-free creation.
- The existing campaign post `aicandoanything/224418752424` also supports the
  normal full-gate update path. The job and document must name that same blog
  and post, with a fresh `independent_http_update_preflight` and source-document
  fingerprint. This is not a general hotel-post update adapter. All current
  claim, ownership, image, editorial, native-render and exact-readback gates
  remain required.
- The only campaign is `202609_MONOGRAM`. The public promotion payload uses
  `https://www.myrealtrip.com/promotions/202609_MONOGRAM` as its canonical URL.
  The observed affiliate creation target can use that exact URL or the exact
  bare-host URL `https://myrealtrip.com/promotions/202609_MONOGRAM`. Once chosen,
  snapshot, proof, owner creation journal and live redirect must agree exactly.
  Host aliases are not normalized to excuse a journal mismatch.
- Source files must be inside the publication artifact directory and have their
  exact SHA-256 recorded. The shared confined reader validates real paths, size
  and bytes. Credentials, browser storage and authenticated response dumps are
  not source artifacts.

The scalar snapshot contract is below. Timestamps are current ISO instants,
calendar dates are valid `YYYY-MM-DD` dates, and KRW values are positive integers.
The ordinary freshness bound is 60 minutes; a saved earlier research report is
not a fresh snapshot merely because a caller changes its timestamp.

| Field | Required value or meaning |
| --- | --- |
| `schemaVersion`, `provider`, `snapshotType` | `1`, `myrealtrip`, `hotel_promotion` |
| `productId`, `variantId` | `202609_MONOGRAM`, `hotel_promotion` |
| `productUrl`, `productTitle` | Exact scoped target URL; exact raw promotion title |
| `seller`, `quantity`, `variant` | `마이리얼트립`, `2` adults, readable scope description |
| `checkedAt` | Fresh source observation time, never a future instant |
| `quoteType`, `bookingStatus`, `availability` | `promotion_advertised_from`, `not_booked`, `not_verified` |
| `payablePriceKrw`, `totalQuoteKrw`, `stockState` | Absent or null; no checkout or inventory assertion |
| `sales.startsAt`, `sales.endsAt` | Actual selling window containing the current time |
| `stay.checkInStart`, `stay.checkInEnd` | Campaign check-in window |
| `evidenceFile`, `evidenceSha256` | Raw extracted public promotion data object and hash |
| `periodEvidence` | `{url, evidenceFile, sha256}` for the official period image |
| `conditions` | Readable package, coupon and price limitations |
| `priceAvailabilityStatement` | `advertised_from_not_guaranteed_for_every_date` |
| `affiliateUrl` | Issued own MyRealtrip shortlink |
| `linkVerification` | `{passed:true, targetMatches:true, checkedAt}`; not a substitute for live/journal verification |
| `credentialsPersisted` | `false` |

`coupon` contains `program: "2026salefesta_fall_alarm"`, `sourceUrl` equal to
`https://www.myrealtrip.com/promotions/2026salefesta_fall_alarm`, `opensAt`,
`checkInStart`, `checkInEnd`, `amountKrw`, `minimumPaymentKrw`, `minimumNights: 1`,
`redemptionVerified: false`, `stacking: "not_assumed"`, and
`evidence: {url, evidenceFile, sha256}` for that raw coupon promotion data.
The coupon check-in end cannot exceed the campaign check-in end. Separate
campaign coupons are not silently stacked with the accommodation-festival offer.

`packages` contains exactly these four distinct entries:

| `packageId` | `propertyId` | Exact `benefits` |
| --- | --- | --- |
| `residence_pool` | `5569868` | `["pool_2"]` |
| `residence_breakfast` | `5569868` | `["breakfast_2", "drinks_2"]` |
| `hotel_pool` | `5602483` | `["pool_2"]` |
| `hotel_breakfast` | `5602483` | `["breakfast_2", "drinks_2"]` |

Each entry also has `nights: 1`, `adults: 2`,
`priceType: "advertised_starting_price"`, `advertisedBaseKrw`,
`advertisedAfterCouponKrw`, `couponKrw`, and
`evidence: {url, evidenceFile, sha256}`. All four subtraction calculations and
the coupon threshold are checked. The source image URL must occur in the actual
campaign data, and the file hash must match its saved bytes.

`datedQuotes` has one entry for each of those four package IDs. Each includes
`packageId`, `propertyId`, the exact source `roomName`, `checkIn`, `checkOut`,
`adults: 2`, `children: 0`, `rooms: 1`, fresh `checkedAt`,
`priceType: "dated_listing_before_coupon"`, `displayedTotalKrw`,
`couponApplied: false`, `taxIncluded: true`, `currency: "KRW"`, `sourceUrl`,
`evidenceFile` and `evidenceSha256`. It is a one-night listing inside the campaign
window. `sourceUrl` must be the observed public endpoint
`https://api3.myrealtrip.com/unionstay/v4/properties/deferred` with exactly these
query parameters: `gid`, `checkIn`, `checkOut`, `adultCount`, `childCount`.
Their values must match the quote. Extra or duplicate query keys fail.

The saved JSON must retain `result.status`, `data.sections[].header` and the
relevant `sections[].gridCards[].bestOptions/options[]`. The actual deferred
response leaves `staticArea.staySearchParam` null. Its room-section header echoes
`startDate`, `endDate` and `persons.adultCount/childCount`; each option carries
`gid`, `startDateTime`, `endDateTime`, `checkInStartTime`, `checkOutEndTime`.
Verification binds both the section and option dates, property, guests, exact
room name, one-room/one-night price units, package title, single `TOTAL` price
and the tax-inclusive display. Primary-page SEO `lowestPrice` is not a
dated listing. An empty response is not proof of sold-out inventory.

## Own affiliate proof

`affiliate` uses `provider: "myrealtrip"`, `url`, `mylinkId`,
`accountFingerprint`, `creationJournalKey`, and a `verification` object:

```text
source: independent_http_redirect
checkedAt: fresh ISO instant
status: 301
bridgeStatus: 200
url: exactly affiliate.url
promotionCode: 202609_MONOGRAM
targetUrl: exactly commercialSnapshot.productUrl
mylinkId: exactly affiliate.mylinkId
accountFingerprint: exactly affiliate.accountFingerprint
```

The account fingerprint must match the publisher-owned account policy. The
existing journal entry must have operation `myrealtripCreateLink`, state
`verified`, and a receipt with `source: "independent_http"`, `status: 200`,
`ownerVerified: true`, the same `accountFingerprint` and `targetUrl`, plus
`data.mylink` and `data.id` matching the issued link. A copied external shortlink
or an unverified creation entry fails before any HTTP request.

Immediately before publishing, a credential-free manual-redirect GET must return
301 to `https://www.myrealtrip.com/main/bridge/marketing` with only one
`return_url`. The nested URL must have exactly `utm_source=mktpartner`, the own
`mylink_id`, and `t_scope=604800`; after removing those keys its URL must exactly
equal the recorded creation target. The bridge GET must return 200 HTML.
Foreign domains, credentials, fragments, duplicate keys, unknown redirect
parameters and additional redirects fail. No arbitrary redirect is followed.

## Document and review requirements

Both the submitted body and reviewed document start with the affiliate notice,
then the `affiliate_banner` image itself linked through `href` to the verified
shortlink. Only spacers can intervene. Exactly one affiliate banner/link is
allowed, with no pasted shortlink in prose. At least three purposeful images are
required: one each of `affiliate_banner`, `package_comparison`, `coupon_calendar`.
Normal image file, rights, upload receipt, native loading and exact count checks
remain active. Reading an official promotional image does not grant reuse rights.

The visible prose must identify the advertised starting-price basis, separate
breakfast/drinks from the pool package, distinguish the campaign and coupon
check-in deadlines, and explain that final prices vary by date. Every current
dated price that differs from its advertised base must also appear in the text.
If a selected quote differs, display every such amount. The fresh 2026-11-03
residence deluxe double ocean-view quotes are 160,760/220,760 KRW before coupon;
the deluxe family ocean-view quotes are 171,100/231,100 KRW. These are different
rooms, not proof that the campaign starting price is unavailable. Name the
selected room and refresh values before use.

An actual independent reviewer, claim ledger, bound review artifact, current
document/ledger fingerprints, desktop and mobile native review, collision
decision, and ordinary publish authorization are still required. An author
self-review waiver cannot pass this format. A reviewer must inspect the actual
campaign and coupon evidence: image hash/source binding and arithmetic are
mechanical checks, not OCR verification of every date, amount or benefit.
Sales-page publication time and displayed sale start can differ; record the
displayed sale terms. Do not infer heating, universal lowest price, coupon
stacking, remaining quota or personal stay experience from the announcement.

The existing create writer journals submission and checks the returned post ID.
Success still requires independent public HTTP readback of the exact title and
ordered body units, including image link destinations. A readback failure after
acceptance is reconciled read-only rather than blindly submitted again.

`publishSettings.searchAllowed` is an optional boolean mapped to the observed
`populationParams.configuration.searchYn` field. Public creation defaults to
`true`; private creation defaults to `false`, so a private SDK seed cannot
silently exclude a new public article from search. An explicit `true` is
rejected for non-public publication. Existing-post updates preserve the current
search setting unless this boolean is supplied. Other observed configuration
fields remain unchanged. Submission journals retain the expected configuration;
update/create completion and read-only reconciliation compare those fields to
a fresh protected owner read. A matching public body alone cannot verify a
search-setting correction. Search permission does not prove search indexing.

## Read-only native preview for a new post

`scripts/hybrid/editor-preview.mjs` accepts an explicit `previewSourceLogNo` for
an existing protected post in the same blog. This post is only a render
container; the final create document must still omit `logNo`. Compile with an
isolated copy carrying the source ID, then pass the untouched final document to
the preview:

```js
const model = await client.compilePreview(previewSourceLogNo, {
  ...document, logNo: previewSourceLogNo,
});
const preview = await previewEditorModel({
  model, document, previewSourceLogNo, cookieHeader, baseDir,
});
```

The helper verifies the blog/post scope and compiled title plus ordered units
before opening the editor. Only the exact protected GET receives the compiled
model. Every non-read browser request is blocked. Native receipts bind the
untouched final document and compiled presentation fingerprints and record the
render container separately. Existing-post previews cannot select a different
source post.

For long articles, the helper scrolls each actual image into view and waits for
an observed HTTPS resource to load and decode. A successfully decoded SVG
placeholder does not pass. The source URL is never replaced with the submitted
URL, and the full ordered-content comparison still runs. Initial screenshots
return to the title; full screenshots include the lower sections. Actual
desktop and mobile visual inspection remains required.

## Regression evidence

`tests/hotel-promotion-contract.test.mjs` exercises the complete job gate plus
wrong scope, stale evidence, altered raw room/price evidence, missing images,
self-review, claim failures, changed fingerprints, bad ownership journals,
foreign/duplicate redirect targets and exact create readback. Its fixtures and
HTTP responses are explicitly synthetic and cannot serve as publication proof.

On 2026-09-21, after binding the actual live room-section dates and option fields
and adding native source-scope and lazy-image coverage, the Naver app's complete
`node --test` suite passed 396 tests. `tests/editor-preview-scope.test.mjs` checks
target isolation, exact final-document binding and blocked writes;
`tests/editor-preview-images.test.mjs` uses a local Chromium scroll viewport to
check below-fold loading and reject placeholders, insecure resources and failed
images. The saved run is `monogram-hotdeal/publisher-regression-tests.txt` next
to the production artifact directory. Test results establish regression
behavior; live publication proof comes from independent readback receipts.

After adding explicit search-setting intent, configuration preservation and
owner readback to creation/update/reconciliation, the complete suite passed
410/410 tests in the separate `monogram_fact_check` execution. This adds
coverage for a public article inheriting a private seed's search exclusion,
invalid non-boolean intent, private search exposure and settings that fail to
apply even when the public body matches.

## Live publication and settings evidence — 2026-09-21

The [Monogram article](https://blog.naver.com/aicandoanything/224418752424) was
created through the normal headless-input/separate-HTTP path and independently
verified at `2026-09-21T06:12:02.812Z`. Its exact public readback matched 36/36
ordered units and four distinct downloaded images, with the own affiliate
banner linked to `https://myrealt.rip/rFoS05`. Protected owner readback confirmed
public visibility and category 10. The create document fingerprint was
`0e36bd8771b78a44c1b7e69237358e28f859c4381c434b45c9d9f0516e265a5e`.

Post-publication inspection found `searchYn:false` inherited from the private
SDK seed. One normal full-gate HTTP update to the same post corrected only
`searchYn` to `true`. Fresh public/owner reads at `06:23:58.306Z` and
`06:23:58.482Z`, followed by the preservation check at `06:24:38.116Z`, verified
all 36 units and four images unchanged, all 19 metadata fields unchanged, and
only that one change among 11 configuration fields. Public visibility,
category 10 and the own linked banner were retained. This proves the search
permission setting, not search indexing.

Production artifacts are in
`C:\Users\User\Documents\Codex\2026-09-21\monogram-hotdeal`:

- `publish-receipt.json`, `final-public.json`, `final-owner.json`: original
  creation and its readback; keep these historical receipts separate.
- `settings-update/publish-receipt.json`, `settings-update/final-public.json`,
  `settings-update/final-owner.json`, `settings-update/final-settings-verification.json`: the correction and
  exact preservation evidence. The correction receipt SHA-256 is
  `cd0e37871ae902cc750392cc6bb60f796a31b09101f998549755d9f42dd9f336`.
- Each revision has its own independently inspected PC/mobile native renders
  and bound `editorial-review.json`. The update document differs only by its
  existing `logNo`; its fingerprint is
  `76ac86675b796100ea8b6aa911b8a9d3bc446599745b6fcbbe7f98fad6f62433`.

Do not run the completed create job again. Subsequent edits require fresh
commercial evidence and the normal full update bundle. The successful
Vatican itinerary update remains a separate, preserved publication receipt.
