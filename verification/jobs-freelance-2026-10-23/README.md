# Jobs and freelance readers: recorded verification

These are dated, anonymous HTTP executions through the repository's native CLI
or common `playbook run` entrypoint. No application, quote, order, message, or
account mutation was submitted. The full source descriptions and review prose
remain outside Git; committed projections retain source IDs, public metadata,
description hashes, response hashes and bounded coverage.

| Source | Recorded scope |
| --- | --- |
| Greenhouse | `greenhouse` board: 19 jobs; exact selected-job detail through the common runner; a separate complete readback |
| Lever | `spotify`: 79 jobs in two offset pages during the recorded bounded collection; selected-job detail through the common runner |
| Ashby | `Ashby`: 69 listed jobs with provider compensation conditions; selected-job readback through the common runner |
| Remotive | 9 public records; original salary text, location, link-back and provider freshness notice retained |
| Kmong | 11 curated homepage cards, 35 linked categories, one 40-result keyword-search page, a three-package service detail, and five reviews from selected page 2 of 47 |
| Soomgo | 11 top categories, six subcategories, and ten provider summaries over two cursor pages; broader collection remains incomplete |

Counts describe the selected boards/pages at the recorded time. A later absence
is not proof a position closed. A selected final page does not prove earlier
pages were collected. `manifest.json` binds each projection and request to its
implementation; `implementationUnchangedDuringRun` was checked while capturing
the source outputs. Independent selected-job reads are matched by exact IDs.

`local-validation.json` records a real offline snapshot roundtrip and comparison,
the common tool inventory, and parsing of 142 unique TokyoDev job cards from an
earlier source-saved HTML document. Its adapter hash is recorded separately from
the implementations replayed over HTTP. TokyoDev's current Node HTTP and fresh
browser requests return a Cloudflare challenge; normal-session handoff is not
verified. Reed and Upwork have fixture-tested readers but no live credentials.

```sh
npm run verify:jobs-freelance
node scripts/checklist.mjs --service=jobs-public --run-tests
node scripts/checklist.mjs --service=kmong --run-tests --strict
node scripts/checklist.mjs --service=soomgo --run-tests --strict
```

The verifier is offline. A successful result revalidates these historical
receipts and current code hashes; it makes no fresh external request. The jobs
and Upwork strict checklists intentionally retain unverified API/session gaps.
