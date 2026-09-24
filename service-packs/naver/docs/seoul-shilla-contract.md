# Seoul Shilla September coupon article

`seoul_shilla_202609` is a local editorial scope key, not a MyRealtrip promotion
code. It dispatches through the existing five `hotel_promotion` entry points to
[`seoul-shilla-contract.mjs`](../apps/naver-blog-api/scripts/gates/seoul-shilla-contract.mjs).
Monogram and iclub remain separate and unchanged. This adapter supports only
`aicandoanything`, one new post, `create` with `headless_sdk` input. It does not
enable updates, coupon issuance or booking. Common claim, artifact, independent
editorial, native desktop/mobile, authorization and exact readback gates remain
required; a successful contract test is not evidence of publication.

## Exact property and source scope

The property is Seoul Shilla Hotel, GID `2680667`, queried for September 28–29,
2026, two adults, no children, one room and one night. Its exact canonical
affiliate destination is
`https://accommodation.myrealtrip.com/union/products/2680667?checkIn=2026-09-28&checkOut=2026-09-29&adultCount=2&childCount=0`.
Primary and deferred responses carry those query parameters; the raw primary
also echoes them in `staySearchParam` and the deferred room section echoes the
date and guest count. The coupon source is the observed public GET
`/coupon/traveler/templates/publishable-by-gids` with `upsIds=2680667`,
`tripStartDate=2026-09-28`, `tripEndDate=2026-09-29`.

Every raw source is bound to its original URL, bytes, SHA-256, successful fetch
receipt and retrieval time. Maximum age is 60 minutes. Valid hashes alone do
not prove claims: the adapter parses exact IDs, date/person echoes, room/rate,
price units, NORMAL/DISCOUNT/TOTAL and tax labels, cancellation and original
coupon fields. It does not accept arbitrary caller-supplied JSON paths as proof.

## Four coupons and four distinct example options

| Coupon | Amount | Minimum purchase as observed | Selected room ID / rate suffix |
| --- | ---: | --- | --- |
| 36284 | 30,000 KRW | 550,000 KRW in both fields | 418226312 / `47583:-:173946:-:173946` |
| 36286 | 50,000 KRW | Card condition **600,000 KRW**; description **55 KRW** | 225979239 / `16928:-:60825:-:60825` |
| 36287 | 70,000 KRW | 700,000 KRW in both fields | 225979239 / `16928:-:159510:-:159510` |
| 36288 | 120,000 KRW | 1,000,000 KRW in both fields | 225939562 / `16908:-:60646:-:60646` |

The 50,000 KRW coupon retains `minimumSpendStatus:'conflicting_source_text'`.
Never silently change 55 KRW to 550,000 KRW or call its minimum verified. Public
wording must identify the card's 600,000 KRW, conflicting description and need to
check application in the payment screen. The article is not an assertion that
the user has issued or redeemed any coupon.

All four raw coupon templates show activation `2026-09-18T09:00:00Z`, activation
end `2026-09-30T14:59:59Z`, and expiry `2026-09-30T14:59:51Z`. Their displayed use
deadline is September 30 at 23:59 Korean time, at **minute precision**. Preserve
the distinct original second values; do not replace expiry with activation end.
Each coupon is limited to one issuance per ID, with duplicate issuance disabled.
This is per template, not one coupon for the entire campaign. First-come use,
designated products, early budget exhaustion, and no reissue after cancellation
once the issue/use period ends are source-backed. Stacking different coupons
and the general stay window remain unverified.

For the initial September 21 09:05Z deferred response, four exact selected rates
displayed these one-night, tax-inclusive figures:

| Selected option | Normal total | Coupon | Already-discounted TOTAL |
| --- | ---: | ---: | ---: |
| TA SEP URBAN ISLAND deluxe double | 595,980 | 30,000 | 565,980 |
| Deluxe double Room Only | 693,000 | 50,000 | 643,000 |
| Deluxe double breakfast for two | 817,000 | 70,000 | 747,000 |
| Executive business deluxe double Room Only | 1,056,000 | 120,000 | 936,000 |

These are different room/rate examples, not a cheapest-price comparison. The
coupon has already been subtracted from TOTAL. `salePrice` is the normal total
in this observed response, unlike the iclub contract. The exact room charge,
tax, negative coupon sub-row, arithmetic, final total and pretax nightly display
are independently checked. Do not subtract the coupon again. Prices remain
fresh raw observations rather than hardcoded evergreen figures.

The Urban Island rate is nonrefundable. The other three selected examples show
free cancellation until September 27 at 18:00 Korean time. Urban Island's
separate package sells September 18–29, stays September 21–30, excludes
September 24–26, and prohibits date changes. Those dates are not generalized to
all coupons or rooms. Only its exact option supports Urban Island All Day; only
the breakfast rate supports The Parkview breakfast for two. A Room Only label
does not establish lounge or breakfast benefits. Confirmation timing is unknown.

## Presentation and ownership

The top sequence is disclosure notice, one generated image banner with
`role:'affiliate_banner'`, `propertyId:'2680667'` and the user's verified href,
an adjacent AI caption, then introduction. At least four distinct useful
generated images are required, with exactly one each of `affiliate_banner`,
`coupon_comparison`, `booking_dates`, `booking_conditions`. Every image has an
adjacent AI caption. The date graphic explains coupon dates or the queried stay;
a gratuitous price graphic is not required.

The article has no ordinary external link blocks, OG cards, naked source URLs
or additional linked images. Source names and verification dates are plain
text. The only linked image is the top own-account banner. Its verified creation
journal must match account, target, ID and shortlink before any public GET. The
live check accepts only the observed 301 to the first-party marketing bridge,
200 HTML bridge response, and exact destination with the matching `mylink_id`,
`utm_source=mktpartner`, `t_scope=604800`. Duplicate or extra query keys,
different dates/guests, foreign hosts and aliases fail.

Independent review must inspect actual artwork and native desktop/mobile
rendering, not just numeric image counts. Exact public readback binds all text
and images in order and the banner href. Business writes remain independent
HTTP after the input browser closes; `headless_sdk` input means
`browserEngineFree:false`.

## Read-only builder and tests

[`seoul-shilla-research-builder.mjs`](../apps/naver-blog-api/scripts/gates/seoul-shilla-research-builder.mjs)
reads original `research-snapshot.json`, `claim-ledger.json`,
`generated-links.json:{shilla:<creationReceipt>}` and verified `journal/`.
The task wrapper is `seoul-shilla-hotdeal/build-commercial-snapshot.mjs` beside
the checkout. It never mutates research or claim wording, creates links, issues
coupons, books or publishes. It emits separate `commercial-snapshot.json`,
`publication-claim-ledger.json`, `verified-affiliates.json`,
`commercial-build-verification.json`, and
`sources/seoul-shilla-publication-receipts.json`. The five claim IDs are
`coupons`, `dates`, `dated_prices`, `cancellation`, `booking_conditions`; only
their product and variant association is normalized. Original expiry is kept.

The dedicated ten test groups cover full-gate dispatch, source mutations with
new valid hashes, discount/tax arithmetic, coupon conflict preservation,
issuance/stacking/stay unknowns, cancellation and package bounds, ownership
before HTTP, strict redirects, all four images and captions, independent/native
reviews, external-link exclusion, source preservation and exact readback.
Fixtures are explicitly synthetic and cannot serve as live receipts.

Live source normalization succeeded on September 21 using four original source
files and five claims. The article was subsequently published once at
[aicandoanything/224418980453](https://blog.naver.com/aicandoanything/224418980453).
`seoul-shilla-hotdeal/publish-receipt.json` records accepted, readback-verified
success at `2026-09-21T09:36:58.409Z`: exact 32/32 units, four distinct downloaded
and verified images, and the clickable own top banner `https://myrealt.rip/rHXb05`.
`final-verification.json` at `09:37:09.700Z` additionally verifies four native
quotation components, public visibility, search permission, category 10 and no
ordinary sales links. The business write was independent HTTP after input
browser closure; `headless_sdk` input keeps `browserEngineFree:false`. These
receipts establish this exact create, not an update adapter or evergreen prices.

Before that create, exact seed validation blocked a 27-of-28-unit capture caused
by repeated keyboard insertion of a link-free article. The maintained helper
now pastes one complete escaped HTML seed for all articles, preserving existing
labeled links without generating text links from banner hrefs. The exact gate
and browser-write cancellation remain unchanged. The actual rerun passed at
`09:35:29.903Z`; three regression cases cover input completeness, escaping/link
preservation and fail-closed mismatch diagnostics without article text or
secrets. Final complete Naver regression: **432/432 passed**, zero failures or
skips, recorded in `publisher-regression-tests-after-seed.txt`. See the task's
`input-recovery.md` for the observed failure and recovery evidence.
