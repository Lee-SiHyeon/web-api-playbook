# Shopee Indonesia Affiliate product reads

The `shopee-id` provider targets only Shopee Indonesia's official Affiliate Open API. It uses the first-party `productOfferV2` GraphQL query for keyword search and item-ID lookup. It can return product price/range fields and item-specific commission rates when Shopee returns a valid signed business response.

The client factory is `createShopeeAffiliateClient({ appId, appSecret })` from `lib/commerce/shopee-affiliate.mjs`. It signs each JSON request in memory using the Explorer's SHA-256 formula and sends it to `https://open-api.affiliate.shopee.co.id/graphql`. It does not open a browser or send shopper cookies. Supply App ID and App Secret through the caller's runtime secret channel; never add them to source files, command arguments, checklists, or receipts.

```js
const client = createShopeeAffiliateClient({
  appId: process.env.SHOPEE_AFFILIATE_APP_ID,
  appSecret: process.env.SHOPEE_AFFILIATE_APP_SECRET,
});

const page = await client.searchProducts({ keyword: 'lip tint', page: 1, limit: 20, sortType: 1 });
const item = await client.getProductById({ itemId: '44310514031' });
```

The API requires the Shopee Affiliate App ID and Secret even though no shopper login flow is used. No such credentials or API entitlement were available during implementation, so source schema and local request tests are verified while catalog search, item lookup, price units, and cookie-free live access remain unverified. The anonymous storefront product page also stopped at Shopee's traffic-verification/login-required screen; its product XHR returned no product data and its direct cookie-free replay returned HTTP 403.

Price and commission amounts remain exact decimal strings. The API schema says those amounts use local currency but does not provide a currency code or unit-scale example. Output therefore keeps `currency: null`, records `currencyCandidate: 'IDR'` as a country-based inference, and sets `currencyVerified: false`. No conversion or discount reconstruction is applied. Commission rates come from each product offer response; no single platform-wide percentage is assumed.

The API returns item-level offer records and page metadata. The client enforces returned `itemId` matching, bounds pages to 20 results, rejects redirects and non-JSON responses, and drops raw bodies and credentials from receipts/errors. It does not call seller Open Platform endpoints, create affiliate links, read reports, or perform account/cart/order writes.

Every normalized `productLink` must use one of Shopee's documented Indonesia product paths (`/{slug}-i.{shopId}.{itemId}` or `/product/{shopId}/{itemId}`), with both path IDs matching the response node. The client strips query/fragment tracking and rejects affiliate redirect wrappers or unbound links; it does not substitute `offerLink` for the canonical product URL.

## Detailed item and review reads

The expanded read scope includes full descriptions and product media, option/variation values, per-SKU prices and stock, review text and pages, and review-attached photos. These are separate from affiliate listing metadata. The `productOfferV2` schema exposes a title, one image URL, product-level price/ranges, category, rating summary, and commission fields; it has no description, gallery, SKU, inventory, review body, review photo, or review-page fields.

Playwright observed the product-page request `GET /api/v4/pdp/get_pc` for the Shopee-ID source listing `shopId=33594331`, `itemId=44310514031`; the request exposed the `shop_id` and `item_id` query fields. Shopee returned an error-only 119-byte JSON envelope (`error=90309999`, no product data). A no-cookie direct replay of that observed URL returned HTTP 403 with the same error and `is_login=false`. The UI fell back to a generic “login required” page, but the API flag does not prove normal account authentication is the cause. Treat this as a traffic/access gate with an unresolved cause. The browser stopped before option, SKU, or review widgets and emitted no review/photo/pagination request. There is no current contract from which to implement those reads, so their checklist entries remain open; the screenshot and replay evidence are in the verification record.

Contract details and live evidence are in [commerce-shopee-affiliate-contracts.json](commerce-shopee-affiliate-contracts.json) and [the 2026-10-05 verification record](../verification/commerce-shopee-affiliate-id-2026-10-05.json).
