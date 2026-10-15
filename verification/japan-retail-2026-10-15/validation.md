# Japanese shopping HTTP playbook validation — 2026-10-15

Delivered API contracts, direct HTTP clients, CLI instructions, service checklists and sanitized execution receipts in `web-api-playbook`.

## Fresh local checks

- 51/51 tests passed: `japan-retail`, `public-read-checklist`, `capability-checklist`, `commerce-rakuten-ichiba`, `commerce-rakuten-ichiba-public`.
- 2/2 existing Amazon session checklist tests passed after the shared evidence validator gained Japanese Document support. The Amazon reader and its recorded network results were not changed.
- `node scripts/verify-japan-retail.mjs` passes: code/artifact hashes; 15 separate saved CLI outputs; identity/JPY/option checks; three connected search pages; product readbacks; two resumed frontiers; eleven new recorded-live capabilities.
- Service checklist runs with `--run-tests` confirm six new Rakuten and five Yahoo capabilities as `recorded_live`. Existing Rakuten official credentials remain pending. Yahoo public search is blocked, official search is pending live credentials, affiliate link generation is unimplemented. Whole-service strict success is not claimed.

## Live coverage

- Rakuten: home product-genre inventory 10 groups / 40 links; four category Documents; search pages 1-3, 150 rows / 148 distinct shop:item IDs; two product Documents, M220 3 SKU rows and a second identity with no SKU rows. A fresh M220 readback matched identity and option IDs.
- Existing Rakuten review reader: exact M220 identity `386625:10000275`, 60 reviews / 60 bodies / 7 image-bearing reviews over two pages. Total reported 1,840, next cursor 3, complete false. Full review bodies are omitted from committed evidence; sanitized receipts, IDs, count and result hash are retained.
- Yahoo: 448 home category nodes, category recommendation and observed same-origin 301 routing, separate YA-MAN / Braun / Yogibo product reads. YA-MAN has six priced options; Yogibo has 27 SKU stock rows with null prices, preserved without inheriting the representative price. A fresh YA-MAN readback matched identity and option IDs.
- Resumed frontiers retain 948 pending Rakuten URLs and 928 pending Yahoo URLs. Yahoo also retains five unimplemented public search routes. Final resumed snapshots have zero HTTP/schema failures in their bounded reads. Earlier parser failures informed the null-price and missing-keyword tests.
- Fresh direct Yahoo `/search?p=マウス` still returned HTTP 500. The cause remains unknown. The result does not prove login failure or any named anti-bot vendor.

## Evidence boundaries

New Document readers used direct HTTP and no browser cookies, login, JavaScript execution or account credentials. CDP capture was unavailable due to a paused-document-response runtime error, so `captured:false` is preserved. Existing public-review XHR provenance remains separate.

Only normalized public fields and hashes are stored. Full Yahoo page state, crumb/IP fields, user profiles, raw HTML and runtime frontend key values are excluded. Secret-like field checks run over every JSON evidence artifact. Credential readiness checks inspected matching filenames and environment variable names only and found no registered-app provider for these Japanese services.

Official Yahoo API tests use synthetic app credentials; they are not a live registered-app check. Affiliate links generated: zero. Cart/account writes: zero. Full catalog, checkout price and complete review pagination remain outside the verified sample.
