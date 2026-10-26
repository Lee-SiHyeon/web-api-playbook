# Kmong verification — 2026-10-26

The final implementation was exercised on the Windows host identified as `140.228`, using Node 24.22.1 and anonymous direct HTTP. No browser, account session, order, quote, message, or payment was used. Source-file hashes were checked before and after both runs and matched the local implementation when these projections were created.

| Actual read | Observed result |
| --- | --- |
| Homepage / category links | 12 sampled gigs / 35 categories |
| Keyword `번역` | 40 gigs on page 1 |
| Exact service `466087` | Single-price card; aggregate offer range KRW 5,000–5,000, delivery 1 day, 2 revisions |
| Exact service `705123` | Existing three-package table still parsed |
| Reviews for both services | 5 rows each on page 1 |
| Native search checkpoint resume | Page 1 → page 2; 40 → 80 unique gigs |
| Native review checkpoint resume | Page 1 → page 2; 5 → 10 review rows |
| Common CLI search resume | Native page-2 checkpoint → page 3; 120 gigs total |
| Common CLI review resume | Native page-2 checkpoint → page 3; 15 reviews total |
| Common tool metadata | 14 operations, all marked read-only |
| Soomgo shared-CLI regression | 11 categories, 6 subcategories, 5 search results and 5 collected provider summaries |

All collected Kmong results still have `status=partial`; later pages exist. This verifies bounded collection and a file-based continuation through separate processes, not the complete catalogue or complete review history. The single-card numeric SSR price is a placeholder, so its price range is explicitly attributed to Product JSON-LD `AggregateOffer`. It is not a verified checkout amount, and `offerCount` is not a package count.

The 15 native result projections and corresponding receipts bind HTTP status, MIME, response hashes, source result hashes, selected IDs, and implementation hashes. Collection projections contain only the newly fetched page; previously imported rows are not presented as fresh network observations. Review prose, seller reply text, reviewer identities, order identifiers, raw HTML, and credentials are absent from the committed evidence. Review fingerprints are local content hashes, not provider-issued review IDs.

`common-cli-verification.json` separately records the actual common CLI runs and the native-to-common continuation. It is supplemental execution evidence, not an XHR capture or a replacement for the native HTTP receipts. Provider-error checkpoint preservation and the common registry's 30-search-page / 100-review-page limit were verified offline. Explicit cancellation or process termination does not guarantee an in-flight checkpoint; keep the previous completed output file.

`local-validation.json` is an unchanged copy of the **2026-10-23 offline** TokyoDev/snapshot/tool checks, retaining its original timestamp and hash. It is identified as carried-forward evidence in the manifest. This Kmong-focused run did not recheck job providers, TokyoDev access, Reed credentials, or Upwork credentials. The original Oct23 directory remains unchanged.

```sh
npm run verify:jobs-freelance
node scripts/verify-jobs-freelance.mjs --manifest=verification/jobs-freelance-2026-10-26/manifest.json
```

These commands verify recorded evidence and current file hashes **offline**. They do not make a new provider request. Selecting an older manifest can legitimately fail when the current runtime no longer matches that historical implementation.

Local validation of the final runtime: 1,452 root tests, all 17 client-pack suites, doctor, consolidation audit, and MyRealTrip compatibility checks passed. Live runs occurred at 05:04 UTC on 2026-10-26. GitHub CI and merge state are recorded separately by GitHub.
