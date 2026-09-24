# Jev research article publication contract

This is a noncommercial `ai_research_article` adapter for the requested Jev article on `aicandoanything`, scoped by `topicKey: 'jev-judgment-workflow-20260921'`. It supports one complete public create with `headless_sdk`, `independent_http`, current publication, search allowed, and the observed category `12`, named `AI`. It does not authorize category creation, another topic/blog, updates, account registration, model execution, or product advertising.

The separately requested follow-up has its own [`jev-applications-20260921` case-study branch](jev-applications-contract.md). Its exact creator/project source allowlist and observation/financial limits do not extend this introduction's source scope.

The adapter is explicit because the existing commerce formats require real product prices, affiliate ownership and a commission disclosure. Inventing those fields for an informational article would misrepresent the article. Existing commerce paths retain their original checks. The AI path instead requires official primary sources, literal source bindings, noncommercial links, an informational notice and exact source-link readback. Relabeling a commerce bundle fails.

## Bundle and job

Use the normal document, claim ledger, collision evidence, quality review and desktop/mobile native render receipts. Additional fields are:

```js
publicationBundle: {
  schemaVersion: 1,
  format: 'ai_research_article',
  layoutReference: {id: 'naver-ai-research-v1'},
  products: [],
  research: {
    schemaVersion: 1,
    topicKey: 'jev-judgment-workflow-20260921',
    checkedAt: '<actual capture timestamp>',
    category: {id: 12, name: 'AI'},
    sources: [{
      id: 'official-primitives',
      url: 'https://docs.typesafe.ai/primitives.md',
      publicUrl: 'https://docs.typesafe.ai/primitives',
      sourceKind: 'official_documentation',
      checkedAt: '<actual capture timestamp>',
      evidenceFile: 'sources/official-primitives.md',
      sha256: '<original bytes SHA-256>',
      status: 200,
    }],
    claimBindings: [{claimId: '<ledger id>', sourceId: '<source id>', locator: '<section>', excerpt: '<literal original excerpt>'}],
    trendAssessment: {basis: 'curated_primary_sources', checkedAt: '<actual timestamp>', limitations: '<explicit sampling and ranking limits>'},
  },
}
```

The job's `researchSnapshot` must exactly match `publicationBundle.research` and is included in the authorization fingerprint. `publishSettings.categoryId` and `categoryName` must match the research scope. Neither `job.affiliate` nor `job.commercialSnapshot` may be supplied, and `products` must be an empty array. No fake price, affiliate or disclosure fields are needed.

Sources must be actual HTTP-200 captures within 24 hours, include at least two official document/repository sources, and match ledger evidence file/hash/URL/date exactly. Supported source owners are TypeSafe's official site/docs, the two observed `typesafe-ai` Python SDK/adapter README paths, the official `typesafeai` X post via X's oEmbed, and the explicit GitHub daily trending page. Canonical reader links are derived from these observed paths; article-supplied arbitrary redirects are not accepted.

Every publishable claim/source pair needs a literal excerpt of at least 12 characters with a locator. Artifact verification hashes the original files and checks excerpts against normalized raw text or decoded JSON strings. This does not replace independent semantic review. Never fabricate a successful fetch or refresh timestamps without fetching again. Popularity/ranking claims require a fresh actual trending source; ordinary curated-source selection cannot support rank or viral-growth assertions. Volatile star/fork/release/rank claims require an unexpired short lifetime.

## Presentation and editorial requirements

Start with an informational `notice` stating the official-source basis and actual dated check. Follow immediately with an unlinked cover image. Require three distinct useful images with `role` values `cover`, `workflow`, and `decision_checklist`; an optional fourth may be `concept_comparison`. Every generated image needs a visible adjacent AI-generation caption, file/hash, rights record and unique purpose. Do not invent product experience or imply an AI concept image is an actual interface screenshot.

Use at least three native quotation headings and put explanatory images within the relevant sections. Links must be labeled `link` blocks pointing to the verified sources or derived canonical reader URLs, with at least two official document/repository links. Images are not links, raw URLs are not body prose, and promotional calls to action are not allowed.

The existing independent review provenance, source-backed factual block classification, duplicate-content check, real screenshot artifacts, exact document fingerprints, native PC/mobile image loading and presentation checks, fresh publish-once authorization, complete write and exact seed equality remain mandatory. The user has authorized separate reviewing agents and requested publication without repeated approval; that does not waive these checks. The native renderer's legacy `disclosureRect` field identifies the first notice in either format. For this informational adapter it records the research notice, not an affiliate disclosure.

## Create and readback

The maintained seed collector still pastes one complete escaped HTML seed and cancels the one SDK publication request. It must close the browser engine before the independent HTTP writer runs. This is API publication with browser-assisted preparation, not browser-engine-free operation.

Only the scoped AI create branch replaces the commerce redirect probe with the research contract. A single journaled HTTP write must be followed by protected owner/configuration/category readback and independent public readback. Full ordered text, all source hrefs, the research notice, unlinked images, and downloaded distinct image bytes must verify. An uncertain response is reconciled by reads without another create. The resulting receipt reports research-source links, not an affiliate conversion or commission.

Regression coverage includes missing images/captions, editorial self-review, source-file tampering, fabricated excerpts, stale sources, invented trend rank, foreign links, commerce relabeling, exact category mismatch, one-write transport, missing public href and read-only reconciliation. These synthetic tests establish implementation behavior; they are not live publication or visual-review evidence.
