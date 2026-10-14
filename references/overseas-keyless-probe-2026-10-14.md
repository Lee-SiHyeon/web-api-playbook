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

