# Remaining provider readiness recheck — 2026-10-16 KST

Read-only provider audit for Adpick, Amazon Creators, Awin, Banggood, CJdropshipping, eBay Browse, Impact, Printful API, Rakuten Advertising, Shopee Affiliate ID, LinkPrice, and MyRealTrip. No partner catalog call was sent without a named protected credential provider. No account setting, merchant application, affiliate link, purchase, or publication write was made. AliExpress was excluded by user direction.

## Current runtime findings

| Provider | Protected readiness | Actual HTTP result in this run | External prerequisite / remaining blocker |
|---|---|---|---|
| Adpick ShoppingMate | No named DPAPI provider or status method. Its reader takes an API key from stdin; `status` reports `credentialPropagated: not_verified` without network access. | No live call. | Registered ShoppingMate API key and owner/account eligibility; key is not safely available through a named provider. Product/image reuse rights also remain unverified. |
| Amazon Creators API | No named DPAPI provider. Commerce runner accepts a matching provider credential packet on stdin. | No authenticated call. | Approved Credential ID, Secret, version, and a caller-owned marketplace PartnerTag. Creators API eligibility is account-specific. |
| Awin | No named DPAPI provider. | No authenticated feed call. | Publisher ID, Bearer token, and feed entitlement. Separately, current primary documentation still leaves the JSONL row envelope ambiguous; the parser intentionally accepts only the observed flat-row candidate. |
| Banggood | No named DPAPI provider. | No authenticated call. | Partner API key and secret. Pagination request semantics remain undocumented, so full-catalog exhaustion is not claimed. |
| CJdropshipping | No named DPAPI provider. | No authenticated call in this run. | CJ Access Token. Earlier anonymous 401 evidence is a control response, not an authenticated replay. |
| eBay Browse partner API | No named DPAPI provider. | No credentialed production call. | Client ID and Secret, plus production Buy API approval. The older anonymous 403 HTML does not establish which gate caused it. Affiliate campaign/reference IDs are additional only for attribution fields. |
| Impact | No named DPAPI provider. | No authenticated call. | Authorized Account SID and Auth Token with Catalog read scope, and at least one catalog visible to that account. |
| Printful API | No named DPAPI provider for the credentialed API. The separate anonymous regional-feed provider is implemented. | No current feed/API request in this audit. | Printful API OAuth token for API search, product/variants, prices, and categories. Public regional feed remains a separate previously verified path; its older proof is not asserted as a current replay. |
| Rakuten Advertising | No named DPAPI provider. | No authenticated call. | Publisher access token and catalog audience. The older anonymous 401 is a control response only. |
| Shopee Affiliate ID | No named DPAPI provider. | No authenticated call. | Valid App ID/Secret and Affiliate API entitlement. Existing storefront access-gate observations do not substitute for affiliate API credentials. |
| LinkPrice | Named DPAPI login and session stores are present. Session initially failed the owner read; the maintained `ensure` path renewed it through the observed refresh route. | Initial owner check: `PUT https://api.linkprice.com/svc/query`, HTTP 200 `text/html`, application error 106, mapped to `REAUTH_REQUIRED` at 2026-10-15T16:09:26Z. Refresh: `PUT /svc/token/refresh`, HTTP 200 `text/html` at 16:10:38Z. Independent owner read: `PUT /svc/query`, HTTP 200 `text/html`, account ID matched at 16:10:40Z. Sites read: HTTP 200, 6 rows at 16:11:11Z. CPS merchant read: HTTP 200, 112 rows at 16:12:14Z. All requests used pure HTTP with no browser. | No prerequisite for current owner/sites/CPS list reads. Account writes, merchant applications, and tracking-link generation were outside this audit. |
| MyRealTrip | Named DPAPI login, session, and pending stores are present. The login is accepted, but the current owner session is not verified. | `GET https://api3-backoffice.myrealtrip.com/partner/v1/partners`, HTTP 200 `application/json`, client outcome `REAUTH_REQUIRED`. The client maps this outcome to its application-level 401 response. `ensure` then accepted the stored login and returned `next: otp-send`; no OTP was sent, and no owner/list read completed afterward. | Human OTP send and verification are required to finish first-party sign-in and establish a fresh owner read. |

## Provider handoff diagnosis

`lib/commerce/providers.mjs` and `scripts/commerce.mjs` accept partner credentials as per-invocation objects. The CLI obtains them only from a stdin packet whose `provider` must match the requested provider; it does not load a named `ProtectedStore` entry or report secret availability. `scripts/adpick-read.mjs` similarly accepts its key only from stdin. In contrast, LinkPrice and MyRealTrip explicitly instantiate the Windows DPAPI `ProtectedStore` under named service stores and expose redacted status methods. No configured protected credential provider was found to hand partner API keys into those commerce readers, so there is no ready provider-to-runner handoff to repair for those APIs.

## Verification boundaries

- Named DPAPI status checks returned only availability/provider metadata; all five known LinkPrice/MyRealTrip entries are persistent under Windows DPAPI CurrentUser. No credential values were read into the report.
- The successful LinkPrice token refresh, owner match, site list, and merchant list are fresh live HTTP evidence from this run. Site URLs and merchant names/IDs are intentionally omitted.
- MyRealTrip login stopped at the explicit OTP-send step. Sending the OTP would contact the account owner; this audit left that step pending.
- For the remaining partner APIs, no current partner-key HTTP result is claimed. Their older anonymous-control responses and fixture evidence remain separate from authenticated readiness.
