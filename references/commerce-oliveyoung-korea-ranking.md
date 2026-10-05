# Domestic Olive Young sales rankings

Use the domestic storefront, not the Global USD store or Shopping Curator's
authenticated activity ranking. The official sales-ranking route is
`https://www.oliveyoung.co.kr/store/main/getBestList.do`.

The observed sales page and category changes return HTML documents. They do not
expose a product-ranking JSON XHR. This reader executes direct HTTP and declares
`sourceFormat: html_document` and `isXhr: false`. A browser is not used to prepare
request inputs or collect recurring results. The separate review-best Ajax
route and homepage RTS curation feed are not substitutes for sales rankings.

The default request preparation is a direct HTTP GET of the observed
`/store/main/main.do` homepage. Only its server-issued `__cf_bm`, `_cfuvid`, and
`cf_clearance` names may be kept in an in-memory cookie jar. The same HTTP session
sends the ranking GET; caller cookies, customer login and browser state are not
accepted. Requests are serialized at a configured minimum interval of five
seconds. This is an operating choice tested for this flow, not a published
Olive Young quota. The CLI closes the worker and clears the jar after the job.

Install the optional HTTP transport once (Python 3.10 or later):

```sh
python3 -m venv .venv-oliveyoung
.venv-oliveyoung/bin/python -m pip install -r requirements/oliveyoung-http.txt
export WEB_API_OLIVEYOUNG_PYTHON="$PWD/.venv-oliveyoung/bin/python"
```

On a host whose Python lacks `ensurepip`, install into the already created
environment using an existing pip:

```sh
python3 -m pip --python .venv-oliveyoung/bin/python install -r requirements/oliveyoung-http.txt
```

Run with Node 24 or later:

```sh
node scripts/commerce.mjs oliveyoung-public ranking --limit=10 \
  --output=ranking-top10.json --csv=ranking-top10.csv
```

Output paths are reserved exclusively; use a new filename for each snapshot.
Category IDs must come from the current page's observed category controls.
Pass an observed ID with `--category-id=<id>` to request that category. The client
validates the returned category before storing its products.

For the currently observed skincare category:

```sh
node scripts/commerce.mjs oliveyoung-public ranking --category-id=10000010001 \
  --limit=10 --output=ranking-skincare-top10.json --csv=ranking-skincare-top10.csv
```

JSON and CSV retain displayed rank, product ID, title, KRW amount, price basis,
availability, category and observation time. A `~` price is a displayed starting
price rather than an exact chosen option's price. Sold-out entries retain their
rank. Missing/duplicate rank markers fail validation or leave the requested
top-N explicitly incomplete; array positions never create a rank. `sourceAsOf`
stays unknown if the page does not provide a verifiable source timestamp.

`collection.topRanksVerified` verifies only the requested ranks, not complete
catalog coverage. Ranking success does not verify search, detail or review APIs.
The native default Node transport previously returned Cloudflare HTML 403;
the pinned `curl_cffi` HTTP transport returned a cookie-free ranking document
200 on this worker. No customer login was needed for that read. These are
observations, not a claim that TLS is the sole cause of every blocked endpoint.

A later cookie-free recheck returned429. In a fresh controlled flow, the
homepage issued approved anonymous cookies and the same-session ranking GET
returned200. The default reader now uses this anonymous bootstrap/reuse flow
with the fixed Chrome150 HTTP compatibility profile. Its receipt records actual
outbound cookie names observed privately by libcurl, with no values or raw
headers in logs, IPC metadata or evidence. Successful request fields remain
separate from any long-term availability claim.

The final control without cookies also returned200. The records therefore prove
that the new anonymous flow works, and that the earlier429 was no longer present
at the control time. They do not establish anonymous renewal as the sole cause;
the rate-limit window or other remote state may also have changed.

The page exposed 21 category controls; the skincare filter was independently
replayed. The broader per-category sweep stopped on HTTP 429 before its first
category-specific request, so the other filters are not replay-verified.
Subsequent reads may remain rate-limited. The CLI reports `COMMERCE_RATE_LIMITED`
and does not retry automatically. A429 stops that worker until close; it does
not trigger a new visitor context. A failed bootstrap is reported with its actual
homepage path and bootstrap phase. The other category filters remain separately
unverified; the new anonymous flow does not turn the earlier sweep into success.

See the accompanying ranking and transport contract/evidence files for current
source hashes, exact fields, transport version and independently replayed reads.
