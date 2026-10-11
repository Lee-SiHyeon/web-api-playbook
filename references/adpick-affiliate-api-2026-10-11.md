# Adpick ShoppingMate API — reviewed 2026-10-11

This is a documented affiliate-shopping contract, not a live authenticated client.
Source: [official API guide](https://biz.adpick.co.kr/?ac=api&sub=guide), including its hidden API/FAQ tabs.
See [the dated provenance](../provenance/adpick-affiliate-api-2026-10-11.json).

An anonymous native browser read returned 200 and captured public DOM text. A separate native
HTTP GET returned generic 403; its cause is unknown and it is not a documented API-quota error.
Google login stopped after the known identity was submitted once because Google rejected the
working browser. No password/MFA, authenticated owner, account approval, API key or business
API response was obtained. Do not reuse unrelated service credentials or label this login successful.

## Data and permission boundary

The guide supplies shopping-affiliate reference data and links. It supplies no general Adpick
CPA/CPI/CPC campaign catalogue, complete product options, stock, shipping or sales-status feed.
Prices are reference values; they do not prove current sale prices, delivered-price comparisons
or discounts. The guide does not grant product/image storage, processing or reuse rights; those
belong to the merchant/seller. Bulk data and expanded usage need separate agreement.
An API key, free API access or successful login does not resolve those rights.

Use existing independently authorized product content and exact source URLs for the first
integration. Do not populate the public hub with copied search/best product or image datasets
until the relevant reuse scope is established. Merchant commission summaries are not a promise
that every product, channel, customer or transaction qualifies. Reward eligibility is separate:
`malls` with `rewardmalls=true` excludes non-reward merchants such as Coupang.

## Documented requests and schemas

All requests use GET at `https://biz.adpick.co.kr/api/{apikey}/{function}`. UTF-8 query encoding
is required. The key is in the URL path; CORS support does not make that key public.
JSON operations use an outer `success`, `message`, `data` envelope; documentation is not
confirmation that a real account receives every field. Empty example `commissionlink` values
must not become approved affiliate links.

| Function | Query fields and bounds | Data projection | Per-key documented limit |
|---|---|---|---|
| `link` | `url` required; `linkonly` defaults true; optional `p_data` | `status`, `commissionlink`; full mode adds `cp_name`, `cp_code`, `cp_icon`, `commission_per`, `product_name`, `product_price`, `product_price_org`, `product_img` | 60/min link-only; 10/min full |
| `directlink` | `url`; optional `p_data`, `forceredirect` default false | 302 redirect; failures can be HTML/alert rather than JSON | Documented no limit; not live verified |
| `malls` | `rewardmalls` default false; `order=new|popular|commission`; optional `p_data` | Array: `cp_code`, `name`, `icon`, `title`, `commissionlink`, `commission_per` | 60/min |
| `search` | `q`; `limit` default 10, 1–20; optional `p_data` | Array: `title`, `price`, `photo`, `cp_code`, `cp_name`, `cp_icon`, `commissionlink` | 10/min |
| `best` | `area=today|commission|pick|popular`; `limit` default 5, 1–10; optional `p_data` | `area`, `area_name`, `count`, `list`; list fields include `title`, numeric `price`, `photo`, `cp_code`, `cp_name`, `cp_icon`, numeric `commission_per`, `commissionlink` | 10/min |
| `conversion` | Optional dates `sdate`, `edate`, `cdate` (YYYYMMDD); `order=api|reg|confirm`; page starts1; limit default 50/max 200; `p_data`, `o_cd`, `status`, `link_id`, `cp_code` filters | Private paginated conversion records and summaries | 60/min; IP whitelist required |

`search.price` is formatted text while `best.list[].price` is numeric KRW; preserve that distinction.
`best` is a random bounded selection from its area, not a verified rank or exhaustive snapshot.
Neither search nor best documents the original product URL or an exact option/seller identity.
Do not merge these rows into existing SKUs by title, image or price. Both already return commission
links; requesting `link` again would create unnecessary issuance.

`conversion` accepts request status filters `정상|확정|취소`; returned records also mention `확인중`.
Its range is at most 365 days, or 366 for a leap-year interval; `cdate` overrides `sdate`/`edate`.
The API timezone is not documented. Pagination fields are
`total_count`, `total_pages`, `page`, `limit`, `order`, `list_count`. Summary fields include
quantity, sales, commission and normal/cancel/pending/confirmed aggregates. Record fields include
`idx`, `cp_code`, `o_cd`, `trlog_id`, `p_cd`, `regdate`, `confirm_date`, `p_nm`, `qty`, `sales`,
`commission`, `commission_rate`, `status`, `trans_comment`, `p_data`, `link_id`, `api_date`.
These are owner/account purchase data, not public traffic, market demand or creator trend metrics.
Do not commit orders, transaction identifiers or raw account exports; public pages must not read them.

## Bounded implementation plan — not implemented

1. Verify the intended native owner and actual API entitlement. The documented
   [API KEY page](https://biz.adpick.co.kr/?ac=api&sub=key) is an authenticated management surface;
   this review did not open it or create a key. Protect a service-bound key in memory/native
   secret storage and validate it through the eventual business runner, not a login badge.
2. Start with `linkonly=true` enrichment for one reviewed, supported original product URL.
   Retain its product, option and seller identifiers and meaningful URL parameters unchanged.
   Deduplicate by owner/provider, exact target and pseudonymous `p_data` purpose. GET `link` and
   GET `directlink` perform issuance; do not call them as harmless health probes or auto-retry
   an ambiguous write. Journal intent/result and reconcile the actual returned link first.
3. Store only the provider-returned commission link and bounded verification provenance needed
   for the existing authorized item. Validate the returned HTTPS host and exact destination;
   source success, owner binding, destination readback and commission eligibility are separate.
   Do not synthesize a link, overwrite another approved provider's link, or call link generation
   from public page/click handlers. Those handlers should use the stored approved link.
4. Use `p_data` as an opaque content/campaign identifier of at most 50 characters. Do not put
   email, customer/order data or natural account identifiers in it. Keep any private mapping
   owner-scoped. Leave `forceredirect=false`; forced redirects can bypass promotion eligibility
   and must not be described as guaranteed commission.
5. If conversion reporting is needed, first establish authorized account scope and a whitelisted
   egress IP. Ordinary Vercel dynamic egress is not proof of IP eligibility. This review authorizes
   no paid static-egress purchase or network change. Keep reporting private and use bounded
   date/page replay with corrections/cancellations, not public order exports.

Log only normalized paths such as `/api/{redacted}/link`, query field names, HTTP status,
bounded schema metadata and implementation/receipt hashes. Never log the full request URL,
key-bearing exception string, cookies or owner records. Validate redirects before following;
do not expose the guide's key-bearing `directlink` example as a public href.

Errors are documented as 400 input/unsupported merchant, 401 invalid key, 403 quota, 404 unknown
function and 501 server error, with failure fields `status`, `code`, `error`. Plain 403 HTML outside an API
request does not establish quota, owner rejection or a platform bypass requirement. Budget
per endpoint/key and pause on an actual documented limit; do not exhaust another service's key.

## Conflicts and outstanding proof

The same guide gives 10 keys in quick-start/key help and 5 in another FAQ; the real account limit
is unverified. It says inactive links can be deleted after 180 days, while another FAQ says links
do not expire. Preserve both statements; do not promise perpetual availability or invent a TTL.
The generic error table says 60 requests/min, while endpoint limits and another FAQ differ;
use the endpoint contract and eventual actual quota response, conservatively.

The existing native pack contains only
`service-packs/affiliate/apps/affiliate-api-hub/tools/research/adpick-affiliate-catalog.mjs`.
Its anonymous `www.adpick.co.kr/apis/shopping.php?md=mall_list...` replay observed 43 merchants
on 2026-09-20 UTC (2026-09-21 KST). That historical frontend JSON contract is separate from this
credentialed Biz API and does not prove current access, participation, link issuance or payment.
It has no protected key provider, conversion reader or current Biz API client.

Before implementation, register an Adpick capability checklist for owner/key access, read/link
scope, exact identity, safe public readback, rights/eligibility, rate limits and private reporting.
For the Biz API now: documented contract present; browser XHR captured=false; client_exists=false;
credential_propagated=not_verified; remnant_free=null; live_replay=false. A docs capture and an
old mall-list client cannot make those states green. This documentation review made no authenticated business call, key-management or issuance
action. No Adpick credentialed client is shipped by this reference.
