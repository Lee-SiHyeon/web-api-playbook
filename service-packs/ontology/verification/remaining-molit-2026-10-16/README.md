# MOLIT notices: browser observation and direct HTTP replay

## Observed browser navigation

The browser agent navigated from the MOLIT homepage to the public `보도자료` list and opened page 2. Its Document GET used:

`https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp?search_section=&search=&search_gubun=1&search_gubun1=all&srch_usr_titl=Y&srch_usr_ctnt=&psize=10&search_regdate_s=2025-10-16&search_regdate_e=2026-10-16&srch_cate=&srch_dept_nm=&search_kind=&search_gbn=&lst_gbn=T&lcmspage=2`

The browser observation returned `200 text/html`, showed 832 total notices, and rendered 10 rows on that page. No sign-in step was observed. The HTML was not saved.

## Direct HTTP replay

The initial worker launch received no stdin and made no network request. The corrected launch below made the single request whose receipt is preserved in `observed-cookie-replay-one-get.json`.

The reviewed one-shot worker sent exactly one `GET` to that observed URL, with a 20-second timeout and redirects disabled. Its non-secret request headers matched the observed browser profile:

- `User-Agent`: Chrome 158 on Windows 10
- `Accept`: `text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7`
- `Accept-Language`: `ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7,ja;q=0.6,zh-CN;q=0.5,zh;q=0.4`
- `Referer`: `https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp`
- `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`
- No `Origin` or `Authorization` header

The worker selected and sent all 12 observed cookie instances whose names, domains, and paths matched the request. There were 11 unique cookie names; `ACEUCI` appeared twice under distinct observed path scopes. Cookie values were supplied only at runtime and were not written to evidence or logs.

That direct request returned `307`, no MIME type, zero response-body bytes, no parseable list count, and a `Location` resolving to the same URL. The direct client therefore remains unresolved for this request: it did not obtain a usable response body, and this replay is not a successful live read. The cookie-bearing replay did not change the result from the prior cookie-free redirect. No redirect was followed and no further attempts are planned in this evidence run.

## Evidence files

- [`observed-cookie-replay-one-get.json`](observed-cookie-replay-one-get.json) is the named copy of the corrected single-GET receipt. It contains response metadata and cookie names only; its SHA-256 is `ab8969ad2d0e10fdc7c0072f55a7136d31e73cfcce4a58240c5e0e8071d155b6`.
- [`observed-header-replay.json`](observed-header-replay.json) records the earlier exact-URL/header replay without cookies.
- [`direct-http-probe.json`](direct-http-probe.json) records the earlier seed, apex-alias, and homepage probes.
- [`replay-observed-molit-with-scoped-cookies.mjs`](replay-observed-molit-with-scoped-cookies.mjs) is the reviewed, scope-limited worker. It accepts cookie input from stdin and does not persist cookie values or response HTML.

These observations establish a difference between the browser-rendered page and this direct HTTP transport for the observed request. They do not establish a site-wide outage, a 403 response, or a reusable direct-reader success.
