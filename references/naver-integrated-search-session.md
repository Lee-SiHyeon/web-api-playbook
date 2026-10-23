# Naver integrated-search price lookup: anonymous session transport

Scope: reading the shopping cards that `search.naver.com/search.naver?where=nexearch` shows for a
product query (used for Coupang Gold Box vs Naver lowest-price comparison). The official Naver
shopping search Open API was shut down on 2026-07-31; `search.shopping.naver.com` returns 418 to
independent HTTP and is not used.

## Transport (same pattern as the Olive Young anonymous session)

`scripts/naver-search-session.py` is a persistent JSON-lines worker:

1. `curl_cffi==0.16.3`, `impersonate="chrome150"` (Chrome TLS/HTTP2 + Chrome UA/client hints),
   `trust_env=False`, redirects not followed, no retries.
2. Warm-up in one in-memory cookie jar: `GET https://www.naver.com/` (navigation headers), then the
   `lcs.naver.com/m?u=https://www.naver.com/` beacon, which issues the anonymous `NNB` cookie
   (same source as `bootstrapAnonymousNaverSession`). Observed 2026-10-16: home 200, beacon 200,
   cookie names `NNB`, `PM_CK_loc`.
3. Wait >= 5 s, then search with browser-shaped query fields (`where, sm=top_hty, fbm=0, ie=utf8,
   query`), `ko-KR` accept-language, `sec-fetch-*` navigation headers and a referer chain
   (home -> previous search).
4. Reuse the same session for a small batch (15 queries, >= 4 s apart), then close it. Allowlisted
   hosts only. Cookie values never leave the worker; only names are reported.

Callers inject it as `fetchImpl` into `searchIntegratedPrices` / `NaverShoppingClient`
(see `naver-session-fetch.mjs` pattern in the Gold Box comparison workspace).

## Challenge detection false positive (root cause of "CAPTCHA at rank 13")

Normal result pages that contain a place/map block embed
`"ncaptcha":{"hostname":"https://ncpt.naver.com",...}` widget config. The adapter's old check
`/ncpt\.naver\.com|wtm_captcha/.test(body)` flagged an 892 KB normal page titled
`효성팜 청도반시 : 네이버 검색` as `CAPTCHA_REQUIRED`, every time, for that query. Detect a challenge
only when the document is not a `... : 네이버 검색` result page and the marker remains after removing
that config. A real challenge still stops the run; it is never solved or bypassed automatically.

## Live check 2026-10-16 (KST)

Session transport + fixed detection, ranks 13-17 of the Gold Box list: 5/5 HTTP 200, 0 challenges.
