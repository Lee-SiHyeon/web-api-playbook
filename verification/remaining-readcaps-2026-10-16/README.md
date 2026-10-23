# Direct read verification, 2026-10-16 KST

The `*-proof.json`, `*-live.json`, and bounded `*-sample.json` files record the
observed operation, current implementation hashes, HTTP/MIME validation, output
counts, and independent JSON/CSV comparison. They do not establish unrelated
login or write capabilities.

- Printful USA public feed: 11,524 priced rows, feed exhausted for that region.
- ColourPop storefront: product and bounded search reads, with JSON/CSV readback.
- Allbirds: product and predictive suggestions; not a full search crawl.
- eBay: suggestions only; consumer result/detail pages still failed separately.
- Ulta: 3 pages, 218 source rows and 212 normalized offers, provider-limited and
  incomplete. The first 20 offers include valid price ranges and are retained
  without selecting only scalar-price products.
- Inpock: protected owner/reuse, profile, cards, and stats reads. No login POST,
  creation, publication, or rendering verification was performed.

The full JSON/CSV collector outputs referenced in `fullOutputs` are local,
ignored runtime artifacts. Their hashes and row comparisons remain in the proof;
Git retains the bounded sample rather than the bulk catalog. Run the recorded
`actualRunner.arguments` to generate a new output; a later network run is not
expected to reproduce the same time-dependent feed hash. Reproduction should use
a fresh output directory and preserve these recorded receipts.
