# Overseas keyless probe (2026-10-14, plain HTTP, no cookies, ~5 s pacing, stop on 403/challenge)

| Source | robots.txt | Sitemap index | Product page | Keyless result |
|---|---|---|---|---|
| AliExpress | 200 | 200, item shards `.xml.gz` (id + lastmod) | ko.aliexpress.com 200 but client shell only; price via MTop (reCAPTCHA, see aliexpress.json) | **IDs via sitemap** + existing `getProductSeo` (title/desc). No price keyless. |
| iHerb | 200 (302 to kr.) | 200, `products-*.xml` (slug + pid + lastmod) | 403 Cloudflare "Just a moment" -> stopped | **IDs/slugs via sitemap only.** No price keyless. |
| Temu | 200 | 403 -> stopped | not tried | **Blocked.** |
| SHEIN | 200 | 403 bot page -> stopped | not tried | **Blocked.** |

Client: `lib/retail/overseas-sitemaps.mjs` (`createOverseasSitemapClient('aliexpress'|'iherb')`), tests `tests/retail-overseas-sitemaps.test.mjs`.
Prices/currency need the official routes: AliExpress Portals API (app key/secret + tracking id), iHerb via Awin/CJ/Impact/Partnerize feed, SHEIN via Awin, Temu affiliate dashboard.
