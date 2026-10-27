# Kmong and Soomgo public read verification — 2026-10-27

The Windows 140.228 native CLI made **23 successful public-read cases**: 15 Kmong and Soomgo catalogue cases plus eight public profile, form, and address cases. Each proof records its exact successful GET request or bounded request sequence. A separate local request preparation ran in prepared-only mode. The common CLI had **5 of 5** successful cases; its sanitized per-case summary is in common-cli-validation.json.

| Source | Verified scope |
| --- | --- |
| Kmong | 12 homepage cards, 35 linked categories, a 40-item search page, two exact service details, single and resumed review-page reads, and bounded search/review collection calls |
| Soomgo | 11 top categories, 6 subcategories, 5 public provider summaries, a 5-row bounded provider collection, profile/contents/review/portfolio reads, a request form, and address options |
| Public portfolios | **20 of 20** reported portfolio rows across 3 pages for the selected profile |
| Public reviews | **6 review metadata rows over 2 pages**; source total was unavailable and a continuation remained, so this is partial |
| Request preparation | **13 form questions** and **6,045 area-3 address options** used for local blank-answer preparation; 8 required fields remained unanswered |

Public review text, profile introduction prose, portfolio titles, and request-form prose are represented by hashes. Reviewer identities, raw address rows, media URLs, and opaque continuation values are not stored in these projections. The address catalogue is summarized by its row count and a hash of the returned source rows.

The local request result is prepared-only: no request was sent, no provider was contacted, and no quote, reservation, payment, or booking was created. This local preparation does not establish the prerequisites for a real request submission. Account login, required consent, owner checks, and encrypted session reuse are recorded separately in the [authenticated run](../soomgo-auth-2026-10-27/README.md); phone/name verification and actual submission remain unverified. Public provider/profile reads do not verify an authenticated account owner or private candidate status.

manifest.json binds each projection and receipt to its native result hash, implementation hashes, request path, timestamp, and bounded coverage. The offline verifier passed with 23 public HTTP executions. The original raw run ledger remains in private scratch. The unmodified Oct 23 offline validation is carried forward with its original timestamp; no Oct 23 or Oct 26 evidence files are replaced.

Selected evidence: soomgo-profile-profile-summary-proof.json, soomgo-profile-portfolios-collect-profile-portfolios-collect-proof.json, soomgo-profile-reviews-collect-profile-reviews-collect-proof.json, soomgo-request-prepare-local-validation.json.
