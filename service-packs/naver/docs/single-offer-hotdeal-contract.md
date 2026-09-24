# Verified single-offer hotdeal contract

`single_offer_hotdeal` supports one new, public, searchable Coupang listing guide
on `aicandoanything`, with headless SDK inputs and the independent HTTP writer.
It does not extend `comparison` or `tested_single_product`, claim personal use,
or waive any shared commercial publication gates. The implementation is
[`single-offer-hotdeal-contract.mjs`](../apps/naver-blog-api/scripts/gates/single-offer-hotdeal-contract.mjs).

## Required bundle

Use `publicationBundle.format: single_offer_hotdeal`,
`contentBasis: listing_review_only`, and
`layoutReference.id: naver-single-offer-hotdeal-v1`. `products` contains exactly
one record, identical to `job.commercialSnapshot`. All ordinary commercial fields,
current source artifacts, claim evidence, author/reviewer separation, native
desktop/mobile previews, disclosure visibility, image rights and exact ordered
public readback remain required. Production review records must come from actual
inspection; the fixtures are synthetic test data only.

The snapshot requires provider `coupang`, exact numeric product/item/vendor-item
IDs, quantity 1, and an HTTPS `www.coupang.com/vp/products/{productId}` URL with
one matching `itemId` and `vendorItemId`. Do not represent a single low displayed
price as a verified promotion. A positive, source-backed discount is mandatory.

## Promotion proof

The snapshot has a `promotion` object:

```json
{
  "kind": "instant_discount",
  "checkedAt": "ACTUAL_SOURCE_TIME",
  "referenceBasis": "seller_displayed_reference_price",
  "referencePriceKrw": 15000,
  "payablePriceKrw": 12980,
  "discountAmountKrw": 2020,
  "eligibility": "none",
  "validUntil": null,
  "proof": {
    "source": "independent_http",
    "status": 200,
    "format": "json_pointer",
    "url": "https://partners.coupang.com/api/v1/search",
    "checkedAt": "ACTUAL_SOURCE_TIME",
    "evidenceFile": "sources/partners-search.json",
    "sha256": "EXACT_ORIGINAL_SHA256",
    "recordPointer": "/data/products/2",
    "fields": {
      "productId": "/productId",
      "itemId": "/itemId",
      "vendorItemId": "/vendorItemId",
      "referencePriceKrw": "/originPrice",
      "payablePriceKrw": "/salesPrice"
    }
  }
}
```

The numbers and pointer above illustrate the shape; no SKU or API row is
hardcoded. Both timestamps must be identical, not future-dated, and within 60
minutes. Rechecking a local file does not refresh its observation timestamp.
The source must be a successful independent HTTPS request to a supported Coupang
host. Preserve the original artifact and hash. The verifier reads the exact JSON
record and matches the option IDs and both prices. A `productUrl` field pointer
can replace the three ID pointers when the original source exposes the exact URL.

`referencePriceKrw - payablePriceKrw` must equal the positive discount amount,
and the current price must equal the snapshot price. The body identifies the
reference as a seller/displayed reference price, for example `판매 페이지 표시
기준가`. This scope rejects lowest-price superlatives and purported firsthand-use
language. A genuine independent use study requires another supported format.

Allowed kind/price-basis/eligibility combinations are:

| kind | snapshot priceBasis and promotion eligibility |
| --- | --- |
| instant_discount | none |
| coupon | coupon |
| member_discount | member |
| member_coupon | member_coupon |

Conditional item prices require an original `conditions` pointer matching the
snapshot conditions and an explicit factual body statement. Do not subtract an
unverified coupon from the source price. If the promotion deadline is unknown,
record `validUntil: null`. A known deadline must be current and also bound to a
`fields.validUntil` source pointer. A supported, publishable `promotion` claim
must identify the exact product/variant, appear in a factual block, and bind the
same original proof file, hash, URL and observation time in the claim ledger.

## Shipping eligibility is separate

Member-only delivery does not turn an ordinary item price into a member price.
The snapshot separately requires:

```json
{
  "shippingKrw": 0,
  "shippingQuote": {
    "eligibility": "wow_member",
    "amountKrw": 0,
    "conditions": "무조건 무료배송",
    "otherBuyerShipping": "not_verified",
    "checkedAt": "ACTUAL_SHIPPING_OBSERVATION_TIME",
    "evidence": {
      "source": "native_dom",
      "url": "https://www.coupang.com/vp/products/PRODUCT_ID?itemId=ITEM_ID&vendorItemId=VENDOR_ITEM_ID",
      "evidenceFile": "sources/product-native-observation.json",
      "sha256": "EXACT_ORIGINAL_SHA256",
      "excerpt": "고객님은\n와우회원\n으로\n무조건 무료배송"
    }
  }
}
```

Eligibility is `all_buyers`, `wow_member`, or `order_threshold`. The amount must
equal `shippingKrw`; the observation is at most 60 minutes old. `otherBuyerShipping`
is `same` for all buyers and `not_verified` for conditional delivery. Evidence
can be independent HTTP or an honestly labeled native DOM observation. Its
literal excerpt must contain the conditions; WOW evidence must say 와우회원.
The artifact verifier checks original bytes/hash and the excerpt in the raw text
or decoded JSON strings, preserving escaped newlines in JSON artifacts.

The conditions must appear in a factual block, with 와우회원 in the same block
when applicable. Conditional delivery also requires a visible instruction that
other buyers must check shipping separately. A corresponding supported shipping
claim must bind the same evidence file/hash/URL/time. Native shipping evidence
does not establish a successful independent consumer product-page HTTP fetch.

## Clickable image banner and review

The first blocks are the disclosure panel and one image with role
`affiliate_banner`. Its `href` is the publisher's own Coupang shortlink. There is
exactly one clickable sales link, expressed through that image; text links,
OG links, image strips and raw URLs in prose do not satisfy this format.

At least three useful, distinct images are required, with roles
`affiliate_banner`, `price_breakdown` and `purchase_checklist`. Generated images
retain adjacent AI captions. At least three section headings use native
quotation presentation. Supporting images follow section headings, and long
unbroken prose remains bounded by the shared visual policy.

The new structural branch does not weaken the live Coupang verifier. Immediately
before publication it still independently follows the public first-party 302,
matches the selected product/item/vendor-item and checks the configured publisher
account `lptag`. The image URL and clickable `href` remain part of exact public
readback. A redirect confirms destination and tag, not a completed purchase or
earned commission.

Independent editorial review, actual native PC/mobile image loading and layout
inspection, current authorization, journaled single creation, duplicate handling,
protected configuration readback and full public readback remain mandatory.
Passing the source proof alone is not publication approval.

## Validation

On 2026-09-21 the maintained app's `node --test` suite passed **516/516** tests.
The 34 new tests cover ordinary and conditional prices, discount arithmetic,
source bytes/SKU tampering, unknown deadlines, separate WOW shipping scope,
native JSON excerpts, banner ownership and redirect checks, image/review
requirements, unchanged comparison scope, and one synthetic journaled create
with exact image-link readback. No live publication is asserted by these tests.
