# iclub two-property November comparison

This is a separate, narrowly observed contract within `hotel_promotion`.
`iclub_202609` is a **local editorial comparison key**, not a MyRealtrip promotion
code or a shared promotion landing page. The existing Monogram contract is
unchanged. Its five public entry points dispatch only this exact local key to
[`iclub-hotel-contract.mjs`](../apps/naver-blog-api/scripts/gates/iclub-hotel-contract.mjs).
All common claim, source-byte, own-account, independent editorial, image,
desktop/mobile native preview, authorization and exact public readback gates stay
in force. The adapter supports `aicandoanything` create with `headless_sdk` only;
it does not allow an existing-post update or another HTTP write route.

## Exact scope

Both quotations use **2026-11-03 through 2026-11-05, adults 5, children 0,
one room, two nights**. The ordered `propertyOffers` are:

| Position | Property | Selected room and rate | Promotion scope |
| --- | --- | --- | --- |
| Primary | AMTD, GID 4819071 | roomId 223158121; `iResidence Elite [특가] 룸 온리`; rate `ACM_OPT_MRT:-:STAYNET:-:2483:-:16886:-:115895:-:115895` | primary promotionId 28041; selected rate promoted; ends September 30 |
| Secondary | Sheung Wan, GID 4818069 | roomId 222857246; `i Residence [특가] 룸 온리`; rate `ACM_OPT_MRT:-:STAYNET:-:2471:-:16879:-:115892:-:115892` | primary promotionId 27780 ends September 23, but selected rate is **not promoted** and has no promotion timer |

The exact destination is
`https://accommodation.myrealtrip.com/union/products/<gid>?checkIn=2026-11-03&checkOut=2026-11-05&adultCount=5&childCount=0`.
The GID, dates, guests, every query key and own tracking values must agree with
the creation journal and live 301 bridge. A related property, missing query,
duplicate query parameter, short-link swap or host alias is not accepted.

Each property binds a current primary response and the selected deferred
response with URL, original file, SHA-256 and actual retrieval time. The maximum
source age is 60 minutes. The parser matches the response room-section date and
guest header, card roomId, option GID/roomId/rateOptionId/room name, check-in/out,
one-room/two-night price unit, salePrice, TOTAL, tax label and displayed nightly
price. Positive numbers or file hashes alone do not establish a matching quote.
Prices are compared with fresh raw values, not hardcoded as evergreen prices.

For the initial 2026-09-21T07:16Z observations, AMTD displayed 436,688 KRW per
night before tax and 960,712 KRW for two nights with tax; Sheung Wan displayed
387,437 and 852,361 KRW respectively. These are date-scoped listing observations,
not completed bookings, held inventory or checkout receipts.

Both selected options show minimum bookable stay **one night** and confirmation
within **four business days**. Two nights is the late-checkout benefit threshold.
Both require a booking request and room availability. Only AMTD specifies
13:00; Sheung Wan leaves the late-checkout time unspecified. Morning refreshments
07:30–10:30 and 24-hour coffee/tea are not a full breakfast package. The selected
free-cancellation wording and explicit Korean-time deadline bind to the exact
raw option. The promotion timer omits an offset; do not invent its UTC/KST
closing instant. Maximum occupancy, instant confirmation, a guaranteed 14:00
checkout, iSuite at 304,700 KRW, or a shared September 30 expiry are not supported.

## Snapshot and affiliate fields

The snapshot has `schemaVersion:1`, `provider:'myrealtrip'`,
`snapshotType:'hotel_promotion'`, `productId:'iclub_202609'`,
`variantId:'iclub_two_property_comparison'`, `campaignKeyType:'local'`, and null
`promotionCode`. It has no shared `sales` or `coupon` object. `productUrl` and
`affiliateUrl` alias the primary offer; `quantity:2` counts compared properties.
`quoteType:'dated_listing_comparison'`, `bookingStatus:'not_booked'`,
`availability:'listing_observed_not_guaranteed'`, and
`priceAvailabilityStatement:'dated_quote_not_booking_confirmation'` prevent a
comparison from masquerading as a booking. Scalar checkout prices and stock are
null. Each offer records:

- `propertyId`, `hotelTitle`, `productUrl`, `roomId`, `rateOptionId`, `roomName`,
  `rateName`, `checkIn`, `checkOut`, `adults`, `children`, `rooms`, `nights`, and
  `minimumBookableNights`.
- `priceType:'dated_listing'`, `currency:'KRW'`, `nightlyTaxIncluded:false`,
  `totalTaxIncluded:true`, `displayedNightlyPreTaxKrw`, `displayedTotalKrw`.
- Deferred `sourceUrl`, `evidenceFile`, `evidenceSha256`, `checkedAt`; primary
  `propertyEvidence:{url,evidenceFile,sha256,checkedAt}`.
- `promotion:{id,startsAtLocal,endsAtLocal,appliesToSelectedRate}`;
  `benefits:{breakfastIncluded:false,morningRefreshments:'07:30–10:30',
  coffeeTea24Hours:true,lateCheckout:{minimumNights:2,requestRequired:true,
  subjectToAvailability:true,time}}`, with AMTD time `13:00` and Sheung Wan null.
- `confirmationText:'영업일 기준 4일 이내 확정'`,
  `maximumOccupancyVerified:false`,
  `cancellation:{type:'free_until',originalText,freeUntilKst}`,
  `affiliateUrl`, and the fresh verified `linkVerification`.

The normal `job.affiliate` contains AMTD and its `secondary` property contains
Sheung Wan. Each has provider, propertyId, url, targetUrl, accountFingerprint,
mylinkId, creationJournalKey and independent redirect verification. Nesting the
second record binds it through the existing `publisherContentFingerprint`.
Both authenticated creation journals are checked **before any public GET**; the
actual write gate rechecks both redirects using no cookies or authorization.

The document starts with notice, AMTD image banner, adjacent AI caption, Sheung
Wan image banner, adjacent AI caption, then the introduction. Both images have
`role:'affiliate_banner'`, their exact propertyId and distinct hashes. At least
four useful distinct images are required, including exactly one
`role:'offer_comparison'` and one `role:'benefit_conditions'`. This does not replace
actual editorial image assessment. No text affiliate placement or third linked
image is accepted. Existing exact ordered readback includes each image href, so
losing only the secondary banner link still fails publication verification.

## Reusable read-only builder and validation

[`iclub-research-builder.mjs`](../apps/naver-blog-api/scripts/gates/iclub-research-builder.mjs)
normalizes actual research without changing its text, evidence, timestamps or
expiry. The task wrapper is
`hongkong-iclub-hotdeal/build-commercial-snapshot.mjs` beside the checkout. It
reads the immutable `research-snapshot.json`, original `claim-ledger.json`,
`generated-links.json:{amtd:<creationReceipt>,sheungwan:<creationReceipt>}` and
existing verified `journal/`. It checks all original bytes and the two owner
journals, then performs only public 301/bridge GETs. It does not issue OTPs,
create links, alter research or publish. Missing or invalid evidence fails
before new artifacts are written.

Outputs are `commercial-snapshot.json`, `publication-claim-ledger.json`,
`verified-affiliates.json`, `commercial-build-verification.json`, and the derived
`sources/iclub-publication-receipts.json`. The normalized ledger keeps the eight
IDs (`dated_prices`, `late_checkout`, `benefits`, `dates`, `room_layout`,
`location`, `cancellation`, `confirmation`), wording and source references; only
the local product/variant association changes. Unsupported findings stay in the
original rejected-claim records and do not become supported claims.

`iclub-hotel-contract.test.mjs` verifies full-gate success and mutations of raw
bytes with valid replacement hashes, room/date/guest scope, taxes and totals,
request-dependent benefits, original expiry differences, missing independent
review/native renders, both owner journals, exact secondary redirect scope,
top-banner ordering, changed secondary fingerprints and exact public readback.
Test fixtures are clearly synthetic; their successful receipts never establish
live editorial or publication success.
