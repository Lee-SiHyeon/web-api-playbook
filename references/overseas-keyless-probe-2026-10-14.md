# Overseas keyless probe (2026-10-14, plain HTTP, no cookies, ~5 s pacing, stop on 403/challenge)

| Source | robots.txt | Sitemap index | Product page | Keyless result |
|---|---|---|---|---|
| AliExpress | 200 | 200, item shards `.xml.gz` (id + lastmod) | ko.aliexpress.com 200 but client shell only; price via MTop (reCAPTCHA, see aliexpress.json) | **IDs via sitemap** + existing `getProductSeo` (title/desc). No price keyless. |
| iHerb | 200 (302 to kr.) | 200, `products-*.xml` (slug + pid + lastmod) | 403 Cloudflare "Just a moment" -> stopped | **IDs/slugs via sitemap only.** No price keyless. |
| Temu | 200 | 403 -> stopped | not tried | **Blocked.** |
| SHEIN | 200 | 403 bot page -> stopped | not tried | **Blocked.** |

Client: `lib/retail/overseas-sitemaps.mjs` (`createOverseasSitemapClient('aliexpress'|'iherb')`), tests `tests/retail-overseas-sitemaps.test.mjs`.
Prices/currency need the official routes: AliExpress Portals API (app key/secret + tracking id), iHerb via Awin/CJ/Impact/Partnerize feed, SHEIN via Awin, Temu affiliate dashboard.

## AliExpress header / KR home+PDP follow-up (2026-10-15 ~00:03 KST)

Plain `curl`, Chrome UA, **one GET at a time**, ≥5 s apart, stop on bot-check/CAPTCHA/403. No login, no proxy, no challenge solve. Max 3 GETs this hop.

### Header variants (www → KR gateway)

| Headers | Status | Body |
|---|---|---|
| no UA / UA only | 200 | bot-check / challenge HTML (looks like success by status alone) |
| UA + `Accept: text/html,...` + `Accept-Language: en-US,ko` | 302 | to `ko.aliexpress.com` (normal locale hop) |
| same + `Referer` | same | no extra effect |

### KR home (`GET https://ko.aliexpress.com/?gatewayAdapt=glo2kor`)

- **200**, `content-type: text/html;charset=UTF-8`, `x-rule-name: AE_GLOBAL_UNLOGIN`
- Title: normal store (`알리익스프레스 … | AliExpress Korea`)
- No recaptcha / punish / x5sec / access-denied markers
- Set-Cookie from this hop only: `xman_us_f`, `acs_usuc_t`, `aep_usuc_f` (site=kor, c_tp=KRW, region=KR), `xman_t`, `xman_f`, …
- Embedded `/item/<id>.html` links present (sample used below)

### PDP (`GET https://ko.aliexpress.com/item/1005012477719675.html`, Cookie = Set-Cookie from home hop)

- **200**, `x-rule-name: AE_GLOBAL_UNLOGIN`, ~75 KB HTML, 21 script tags
- **No** captcha/punish/403 body
- `og:title` has real product name; `window.runParams = { };` **empty**
- No inline `skuPrice` / `formattedPrice` / price JSON; client loaders (`pdp-pc`, `cosmos`, `LWSC-G`) imply MTop/XHR for price
- Conclusion unchanged: **title/SEO shell reachable keyless with proper browser-like Accept headers; price still not available without authenticated/official API (or browser challenge path we do not automate)**

## Browser netcap follow-up (2026-10-15 ~00:14 KST)

Source: `/workspace/captures/2026-10-14T15-14-10-750Z` (real Chrome session on `ko.aliexpress.com` PDP + search). Contracts: `verification/retail-aliexpress-browser-capture-firstparty-2026-10-15.json` (14 first-party; full HAR had 477 inventory rows, mostly CDN/tracker).

| Call | Status | Bytes | Notes |
|---|---|---|---|
| `GET acs.aliexpress.com/h5/mtop.aliexpress.pdp.pc.query/1.0/` | 200 | ~195 KB | **Succeeded** in browser (signed `appKey`+`sign`+`t`+`data`). Earlier 2026-10-05 anonymous Playwright saw `/_____tmd_____/punish` for the same API. |
| `GET .../mtop.aliexpress.review.pc.list/1.0/` | 200 | ~15 KB | Reviews list; same signed MTop shape. |
| `GET ko.aliexpress.com/aeglodetailweb/api/seo/seodata` | 200 | ~7 KB | Matches existing keyless `productSeo` contract. |
| `GET pdp.aliexpress-media.com/product/{id}/pc/v2/ko_KR/desc.htm` | 200 | ~32 KB | Description HTML; query has `productId`, `sellerId`, `token`, `v`. |
| recommend / cart.count / cookie.render / poplayer | 200 | small | Session/UI; not catalog price. |

Conclusion update: **PDP business payload is reachable as `headless_assisted_http` / browser-session MTop** (signed query), not as anonymous keyless pure HTTP. Keyless path remains sitemap IDs + `getProductSeo` only. Next step when wanted: replay `pdp.pc.query` with captured sign fields from a sanctioned session store (no CAPTCHA solve), or use Portals official API for price.

## Browser-free MTop replay test (2026-10-15 ~10:50 KST)

- Offline check on the 00:14 KST HAR: `sign == md5(_m_h5_tk token & t & appKey & data)` for every `pdp.pc.query` / `review.pc.list` call that carried `_m_h5_tk` (appKey `12574478`, jsv 2.5.1). Signing itself is reproducible; the successful browser session also carried `x5sec` + `cna`.
- PDP payload in the browser capture has KRW price fields (`formatedAmount`, `salePriceString`), so this is the price source.
- Pure HTTP (`requests`, Chrome UA, home hop for cookies, then one signed MTop GET 6 s later): home **200 ok**, MTop **200 but `FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR::SM`** (anti-bot challenge), no `_m_h5_tk` issued. Stopped after 1 MTop call (no retry, no challenge solve).
- Conclusion: AliExpress price is **not** reachable keyless browser-free from this egress. Options: (a) browser-session assisted (real browser obtains `_m_h5_tk`/`x5sec`/`cna`, store in DB, HTTP client replays until expiry), or (b) official AliExpress Portals/Affiliate API (needs app key).

## Status vs. main readers (2026-10-16 ~09:20 KST recheck)

The sitemap client above is now wrapped by `scripts/overseas-retail.mjs` (`npm run retail:overseas`): `aliexpress|iherb sitemap-index` and `sitemap-products --shard-index --offset --limit [--snapshot-sha]` (resumable, `completeCatalog:false`). `listProducts()` still exists and now delegates to `productsPage()`. See [overseas-retail-expansion-2026-10-15](overseas-retail-expansion-2026-10-15.md) for the full CLI and ontology flow.

The table at the top was about sitemaps only. Later main commits changed two rows:

- **SHEIN:** the sitemap is still blocked, but `shein home` parses `gbRawData` from the KR home Document over plain HTTP: 10 cards with KRW sale and retail display prices, plus 15 menu links. Category Documents redirect to `/risk/challenge`.
- **Temu:** the observed `/kr/channel/best-sellers.html` GET returns 200 but has no verified product list. There is still no supported CLI operation for Temu.

Light live recheck from this box (cookieless, one CLI at a time, ≥6 s apart, no retries):

| Command | Result |
|---|---|
| `iherb sitemap-index` | 200, 3 product shards |
| `aliexpress sitemap-index` | 200, 604 item shards |
| `aliexpress sitemap-products --shard-index=0 --limit=20` | 200, 31,999 unique IDs in shard 0, IDs + lastmod only |
| `retail.mjs aliexpress product-seo` | 200. The description is present, but `title` came back as the bare `" - AliExpress "` suffix and price stays null |
| `shein home` | 200, 10 priced cards |

AliExpress price is still unavailable without the official Portals API. See the browser-free MTop section above.
