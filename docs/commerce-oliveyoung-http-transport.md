# Olive Young public HTTP transport

The Korean Olive Young adapter can use `createOliveyoungHttpFetch()` from
`lib/commerce/oliveyoung-http-transport.mjs` as its `fetchImpl`. It launches one
Python helper process per request and returns a normal Web `Response` with the
response body, status, `content-type`, and computed `content-length` only.

The helper uses the pinned `curl_cffi==0.16.3` Chrome TLS profile. Certificate
verification stays enabled, redirects are not followed, environment proxies are
ignored, and each request runs in a cookie-discarding session. The Node adapter
and Python helper both reject unknown origins, paths, methods, query fields,
headers, content types, and credential-like body fields. Cookies, account
credentials, caller-supplied User-Agent values, response `Set-Cookie`, remote
error text, and raw headers never enter receipts or logs. A blocked route
produces a fixed error code; the adapter does not launch a browser, install a
dependency at runtime, or fall back to another transport.

The allowed routes are listed in
`references/commerce-oliveyoung-http-transport-contracts.json`. The current
rankings route is the public page `GET /store/main/getBestList.do`; its page
contains server-rendered ranked product cards. It is a direct HTTP document
read, not an XHR endpoint. The other entries are captured public read routes.
The product detail API route remains blocked because a live response has not
been captured.

Install the pinned dependency once in the repository-local Python environment:

```sh
python3 -m venv .venv-oliveyoung
.venv-oliveyoung/bin/python -m pip install -r requirements/oliveyoung-http.txt
```

On Windows, use `.venv-oliveyoung/Scripts/python.exe`. The factory selects an
explicit `pythonPath` first, then `WEB_API_OLIVEYOUNG_PYTHON`, then the
repository-local environment when present, and finally `python3`. Set the
environment variable when calling the API from outside this repository. A
missing package fails closed with a dependency error; it is never installed
automatically.

Example:

```js
import { createOliveyoungHttpFetch } from './lib/commerce/oliveyoung-http-transport.mjs';

const fetchImpl = createOliveyoungHttpFetch({ timeoutMs: 30_000, maxResponseBytes: 8 * 1024 * 1024 });
const response = await fetchImpl('https://www.oliveyoung.co.kr/store/main/getBestList.do', {
  method: 'GET',
  redirect: 'manual',
  credentials: 'omit',
});
```

`verification/commerce-oliveyoung-http-transport-live-2026-10-05.json` records
the bounded, cookie-free HTTP replay and hashes of the transport inputs. It
contains normalized status, MIME type, page title and rank-card count only.
