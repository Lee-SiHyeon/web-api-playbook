# Olive Young anonymous ranking transport

The Korean public ranking page is an HTML read at `GET https://www.oliveyoung.co.kr/store/main/getBestList.do`. It is not an XHR endpoint. The ranking parser consumes the returned document and checks the page's explicit rank markers and category form state.

## Observed anonymous refresh

On 2026-10-05, a cookie-free `curl_cffi==0.16.3` request to the official homepage returned HTTP 200 and issued `__cf_bm` and `_cfuvid` alongside other site cookies. A second request to the public ranking page, using the same process after a five-second gap and retaining only those two Cloudflare cookie names, returned HTTP 200. No account login, caller cookie, or browser was used in that probe.

This is one successful replay. It demonstrates that an anonymous server-issued session can change the observed response from the worker's cookie-free HTTP 429 to HTTP 200. It does not establish a universal quota or promise that later requests will avoid rate limiting.

## Client behavior

`createOliveyoungAnonymousRankingFetch()` starts one persistent Python worker for the lifetime of the fetch adapter. Before its first ranking read, the worker GETs `/store/main/main.do`, prunes all cookies except the observed Cloudflare names, waits at least five seconds, then GETs the ranking URL in that same in-memory session. Later ranking reads reuse that session and are serialized with the same minimum interval. Category filters use only the four observed query fields: `dispCatNo`, `fltDispCatNo`, `pageIdx`, and `rowsPerPage`.

The helper pins the `chrome150` TLS profile, keeps certificate verification enabled, disables environment proxy inheritance, and disables redirects. Caller cookies, authorization values, arbitrary headers, other origins, and other paths are rejected or ignored before transport. The curl callback reads the actual outbound `Cookie` header and retains only cookie names for receipts; it never prints or returns header values. The server may refresh the value of an already approved cookie through normal cookie-jar handling, while unapproved cookies are pruned after every response.

The session and cookie values stay in the worker's memory. The private JSON-line pipe carries the public response body and bounded metadata; receipts contain cookie names and hashes only. `fetch.close()` ends the worker, clears the jar, and closes the session. Call it from the ranking client's `close()` path or the operation's `finally` block.

The transport returns HTTP 429 immediately, keeps the safe `Retry-After` value, and blocks further reads until `close()`. It does not retry, rotate cookies, re-bootstrap, or switch identities in response to a limit. A non-429 bootstrap denial is returned to the ranking caller and stops that read; the adapter does not silently start another session.

## Verification boundaries

The live probe above confirms the bootstrap and same-session ranking response once. Unit tests use an injected fake HTTP session only inside the Python worker class; this injection is not accepted by the JSON-line protocol or the commerce CLI. A fresh read from the connected runtime is still required to claim that the deployed client currently returns the ranking page.
