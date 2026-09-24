# Naver HTTP publisher and final-document gates

> Current standalone usage: [README](../README.md) and [publishing guide](publishing-usage.md). This document retains dated implementation notes; older session-handoff, unsupported-video and account-renewal descriptions are historical. Use the current DPAPI launcher and media commands documented in the README.

For existing-article republication, use the unified `npm run republish --` workflow.
See [Naver republication](naver-republish.md) for the manifest, session handoff,
media upload, native preview, review assembly, authorization and exact readback.
Keep content and receipts in revision data folders; do not add per-post runtime,
handoff, authorization or verification scripts. The workflow calls the same
maintained HTTP client and full gates described below.

The default publishing implementation is `scripts/api/publisher-cli.mjs`. Its
dependency graph has no browser runtime. The legacy extension server returns 410
for every publish job, including a job falsely labelled `independent_http`.
Discovery and visual review are separate from the HTTP writer.

On 2026-09-21 the reviewed Comet hanger article was publicly created through the
normal headless-input → separate HTTP writer path. Owner visibility, category 6,
39 ordered body units, clickable top affiliate link and duplicate audit passed.
Unauthenticated desktop/mobile rendering also passed. See the
[affiliate gate and live receipt](naver-affiliate-publication-2026-09-21.md).
The browser engine still supplies fresh SDK inputs; this is not engine-free creation.

On 2026-09-20 the normal
CLI on home Windows verified owner-only editor reads, draft lists/reads, a private
post update with four exact paragraphs, an existing draft update with a newly
uploaded PNG, and an independent byte-for-byte PNG download. The credential
handoff to the actual child process is now verified. Generic **private** creation
now accepts fresh headless SDK inputs and enforces the full business gates. The
shared input provider and compiler passed a live private technical probe; the
public commercial job path was subsequently verified as described above.
New blank draft creation remains blocked. See the operation-by-operation
[contract register](../apps/naver-blog-api/references/editor-api-contracts.json).

The [latest hybrid commands, duplicate audit and verification boundaries](naver-duplicate-audit-and-hybrid-publisher-2026-09-20.md)
also cover runtime cookie rotation, `session-status`, `audit-post`, and creation
reconciliation. The HTTP dependency graph remains free of browser imports;
`scripts/hybrid/publisher-cli.mjs` explicitly supplies the browser-dependent inputs.

## Supported boundary

All supported commerce formats now require images with purposes/rights and exact
loaded-image counts in both native preview receipts. Comparison has a nonzero
baseline; tested-single-product retains its eight-image reference policy. Optional
job minimums cannot disable these checks. Generated images require visible
adjacent AI-generation captions. The separate `travel_itinerary` adapter below
adds a scoped MyRealtrip planning contract. Completed fixed repair writers are retired; use the normal full
bundle for subsequent commercial updates. See the discoverable
[Naver publishing skill](../skills/naver-blog-publishing/SKILL.md).

The separate [`single_offer_hotdeal` contract](single-offer-hotdeal-contract.md)
supports one verified Coupang promotion as a new `aicandoanything` listing guide.
It requires raw discount proof, separately scoped shipping eligibility, an own
clickable image banner after disclosure, at least three useful images and three
native quotation headings. Shared freshness, ownership, independent review,
native previews and exact readback gates remain required; neither comparison nor
tested-single-product requirements are relaxed.

The separately scoped [`market_analysis_article` contract](market-analysis-article-contract.md)
supports the requested dated Bitcoin informational article in `aicandoanything`
category 13 / 경제·투자. It binds exact exchange/period/currency observations,
raw candle data and calculations to three original factual charts, distinguishes
dated creator methods from market facts and causal hypotheses, and retains all
independent review, native preview, authorization and readback requirements.
The generic affiliate workflow's financial restrictions remain unchanged.

The separate [`hotel_promotion` contract](hotel-promotion-contract.md) supports
the requested 202609_MONOGRAM campaign as a new post with headless SDK inputs,
and full-gate updates to its verified existing post `aicandoanything/224418752424`.
It binds four distinct packages, coupon conditions, fresh dated listings, the
own-link creation journal and the exact promotion redirect. It retains all
shared claim, image, independent review, native preview and public readback gates.
Public creation defaults to `searchAllowed: true`; existing updates preserve
the observed search setting unless explicitly changed. The writer and read-only
reconciliation verify expected configuration through protected owner readback.

The separate [`ai_research_article` contract](ai-research-article-contract.md)
supports the requested Jev information article as one public create in
`aicandoanything` category 12 (`AI`). It uses official-source files and literal
claim bindings instead of fictitious products, affiliate links or commission
disclosures. Three useful images, adjacent AI captions, quotation headings,
independent editorial review and exact native PC/mobile renders remain required.
The public reader links must match the original sources, and final readback
verifies those hrefs plus every ordered unit and downloaded image. This adds no
general informational update adapter and does not relax existing commerce gates.
The separately scoped [Jev application case-study branch](jev-applications-contract.md)
adds verified creator/project sources for the requested follow-up, with explicit
distinctions between repository descriptions, public demos, creator assertions
and independently unverified financial outcomes. It preserves the first article's
official-source scope and all shared publication checks.

- Read a public article and extract its exact title, ordered paragraphs, quotations,
  image URLs, dividers and link cards. Verify the response's own blog/post identity.
- Read protected editor options, draft lists and individual drafts with a runtime
  session. Verify ownership and target IDs, status, MIME and application schema.
- Prepare and update an **existing** post using its fresh document model. Preserve
  its public/private visibility and current publishing time. Unknown components,
  new signed link cards and unsupported image-strip construction fail before a
  mutation. Existing images may be reused. New PNGs require a verified upload
  receipt in the same journal and a fresh matching download; a pasted asset URL
  alone cannot introduce a new image.
- Existing draft edits use `/RabbitTempPostUpdate.naver`, not the new-draft
  `/RabbitTempPostWrite.naver`. Obtain `modiDate` from the current draft list,
  recheck it against preflight, and submit `forceUpdate=false`. Manual save does
  not need an autosave ID; no old `autoSaveNo` is copied. A lost response is
  reconciled against the stable draft ID and is never automatically resubmitted.
- PNG upload uses current owner-verified editor options, the observed platform
  session-key request, and the photo upload endpoint. Only the platform receives
  `SE-Authorization`; no browser cookie goes to the upload or asset hosts. Verify
  downloaded bytes, dimensions and SHA-256. Initial support is non-animated PNG,
  at most 10 MiB and 4096 pixels per side, with a simple ASCII filename. JPEG,
  video and files were not live-tested and are not accepted by this adapter.
- New posts still require a fresh observed nCaptcha/document envelope. The
  maintained `headless_sdk` provider starts isolated Chromium, lets Naver's
  first-party SDK issue the envelope, aborts the browser's `/RabbitWrite.naver`
  request, closes the browser, and hands the envelope to the independent HTTP
  writer in process memory. The provider is verified for this runtime but does
  not make creation browser-engine-free. Tokens are never synthesized or replayed.
- After the exact native preview, `prepare-create-http` now performs the create
  preflight with protected HTTP reads and the verified upload journal. It binds
  the seed, compiled document, and native presentation fingerprints without
  launching Chromium. The later `create` still requires a fresh SDK envelope and
  checks all three fingerprints against it before one HTTP write. This removes
  the former separate browser launch for `prepare-create`; the older command
  remains available for diagnostic comparison.

## Run on the intended host

Use Node 24 and `npm ci`. The credential provider passes only the current user's
`NAVER_COOKIE` to the runner; inject it through the existing secret environment or
credential manager. Do not paste it into chat, put it in command arguments, commit
it, or export browser state. There is no automatic Chrome fallback.

For a user-authorized bootstrap, `tools/discovery/publisher-session-handoff.mjs`
accepts cookies already obtained through the supported origin-scoped browser
capability. `runAuthorizedPublisher` sends only `NID_AUT`/`NID_SES` in the child
environment plus `SystemRoot`; it fixes the executable script, disables shell
execution, bounds lifetime/output and redacts credential echoes. It never opens
a browser or stores cookies. The normal writer imports none of this helper.
This supported handoff replaced the failed standalone debugging-port connection.
The present evidence establishes a run-scoped handoff, not unattended renewal
or a credential store surviving a runner/kernel restart. A separate headless
probe now verifies browser restart using the same in-memory login session.

### Headless creation discovery

`tools/discovery/headless-create-probe-cli.mjs` accepts scoped current login
cookies through stdin, starts two fresh local Chrome headless processes, and
uses the normal editor UI/SDK to prepare one fixed private technical document.
Both browser writes are cancelled, and both browsers close before the second
fresh form is passed to the separate Node HTTP probe. Exact owner, private
visibility, title and ordered four-paragraph readback passed on 2026-09-20.
The runtime had extensions disabled and automation explicitly enabled.

Required arguments are `--blog-id`, `--journal`, `--output` (sanitized evidence)
and `--write-output` (HTTP receipt). The existing journal must be reused across
attempts; changing an output filename does not authorize another write. The
`headless` probe profile accepts only its fixed title/paragraphs and private,
immediate creation. It cannot accept an arbitrary commercial article.

This removes the visible browser and extension from input preparation after
the initial authorized session handoff, but retains the browser engine. It
does not implement password login, session persistence, login-session renewal
or long-term unattended operation. See
[headless evidence](../apps/naver-blog-api/references/ncaptcha-headless-verification-2026-09-20.json).

```powershell
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=read-post --blog-id=YOUR_BLOG --log-no=POST_ID --output=PUBLIC_READBACK.json
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=inspect-editor --blog-id=YOUR_BLOG --log-no=POST_ID --output=EDITOR_OBSERVATION.json
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=prepare-update --job=DRY_JOB.json --output=API_PREFLIGHT.json
npm run publisher:authorize-api -w @affiliate-content-operations/naver-blog-api -- --job=DRY_JOB.json --preflight=API_PREFLIGHT.json --approved-by=user --output=APPROVED_JOB.json
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=update --job=APPROVED_JOB.json --journal=JOURNAL_DIRECTORY --output=RECEIPT.json
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=upload-image --blog-id=YOUR_BLOG --file=IMAGE.png --journal=JOURNAL_DIRECTORY --output=UPLOAD.json
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=prepare-draft --document=FULL_DRAFT_DOCUMENT.json --journal=JOURNAL_DIRECTORY --output=DRAFT_PREFLIGHT.json
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=save-draft --job=DRAFT_PREFLIGHT.json --journal=JOURNAL_DIRECTORY --output=DRAFT_RECEIPT.json
npm run publisher:api -w @affiliate-content-operations/naver-blog-api -- --command=reconcile-draft --job=DRAFT_PREFLIGHT.json --journal=JOURNAL_DIRECTORY --output=DRAFT_READBACK.json
```

Resolve input/output paths relative to the app working directory when using
`npm -w`, or use absolute paths. Keep run files under ignored `.runtime/` or
`workflow-runs/`. Store a run bundle and its job in the same directory because
artifact paths are relative to the job. Output files use exclusive creation.
The output destination is reserved before network operations; an existing receipt
cannot cause a mutation followed by an output-file failure. The draft document
must name its existing `logNo`. For a new image block, include `publishedUrl`,
`sha256`, and the complete `uploadReceipt` from `UPLOAD.json`; preserve the same
journal. Normal publication also requires its local image file and rights evidence.
The authorization command records **already obtained** user authorization; it
does not obtain consent, create a review, or fabricate evidence.

For a lost response, retain the same journal and use `--command=reconcile` with
the approved job. This command only reads. Never blindly resubmit. A journal key
binds the operation, target, exact content and visibility, surviving a process
restart or a renamed job. Successful state reconciliation does not prove that a
particular HTTP response was delivered.

## Bundle and checks

`publicationBundle.schemaVersion` is 1. A bundle contains `authorId`, `format`,
`document`, `products`, `claimLedger`, `comparisonCriteria`, `collision`,
`qualityReview`, and `renderReviews.desktop/mobile`. See the explicitly synthetic
[fixture producer](../apps/naver-blog-api/tests/support/publication-fixture.mjs)
for the schema; its generated reviews/images are test data, never production evidence.

1. `document` binds `blogId`, `logNo`, title and the **entire final block array**.
   The first non-spacer block must be the affiliate disclosure. Image SHA-256 values,
   local file bytes and rights metadata are required; duplicate bytes and duplicate
   image URLs are rejected. Partial append jobs cannot be published.
2. Every factual paragraph, heading, quote or list has `claimClass: factual` and
   `claimIds`. Commercial numeric statements cannot be classified as guidance.
   Every referenced claim must be supported, publishable and current. Price/stock/
   shipping/rating/review-count claims require expiry. Evidence references must
   resolve to HTTPS sources and verified local artifact hashes.
3. A comparison has at least four distinct product/variant identities and at least
   three named criteria with units and known attribute values for each product.
   Check **all** prices, quantities, sellers, variant names, shipping, stock and
   redirects within 60 minutes. A selected product refresh cannot refresh its
   competitors. Member/coupon conditions must be aligned or explicitly reviewed.
4. `qualityReview` binds this exact document and claim ledger. It requires a
   distinct reviewer ID, a recent independent-verifier decision, no hard blocks,
   and explicit semantic checks. A numerical score is not a publication permit.
5. Desktop and mobile review records bind the exact ordered content. Verify actual
   PNG bytes/hash/dimensions, a mobile width of 320–480, and a disclosure rectangle
   inside the initial viewport. Old or missing screenshots cannot count as a pass.
6. API preflight binds the current source document and final bundle. Authorization
   binds those hashes and the requested target/visibility. Recheck all publication
   gates immediately before POST. If the source changed, stop for a fresh review.
7. After POST, independently fetch the article and compare the full ordered
   contents. Marker presence and image counts alone never establish success.
8. Every article publication requires an explicit monetized affiliate URL directly
   after the disclosure, the exact provider-specific offer, and fresh redirect
   evidence. Coupang requires product/item/vendor option and the first-party 302;
   MyRealtrip requires the authenticated creation journal and marketing bridge.
   The HTTP writer independently checks the destination and publisher-owned
   account policy immediately before both create and update.
   Missing links, wrong attribution, stale/mismatched evidence, unsupported
   accounts/providers and verification outages block publication. Clickable
   hyperlinks use the observed native URL schema and are checked on readback.
   Draft preparation remains available; fixed private transport probes are not
   commercial publishing endpoints.

### MyRealtrip itinerary and image banners (2026-09-21)

`scripts/gates/travel-planning-contract.mjs` defines `travel_itinerary` for existing-post updates: one tour
candidate, the original trip evidence and calculated day/night counts, an original
map with visible OpenStreetMap attribution, and an affiliate image directly after
the disclosure. A listing guide fee is not a dated payable total: date availability
and booking remain explicitly unconfirmed. Unknown checkout totals must stay null;
do not insert Coupang stock, shipping or vendor-item fields to make travel pass.

Own attribution uses a verified `/partner/v2/mylink` creation journal bound to the
publisher's independently checked account fingerprint. The live checker follows
only the observed 301 metadata to `www.myrealtrip.com/main/bridge/marketing` and
validates its single `return_url`, exact product, `mylink_id`, and `utm_source` before
reading that first-party bridge. No account cookies accompany these public reads.

The first-party SmartEditor 1.78.1 SDK's ImageStore stores `link` as a URL string;
textNode uses `urlLink.url`. The compiler binds an image block's `href`, native PC
and mobile previews read the actual image-link input without applying it, and
exact public units include the clickable href alongside the image identity.
The SDK source was fetched from
`https://editor-static.pstatic.net/e/basic.desktop/1.78.1/se-app-context.js?t=1786079488144`.
The first public top-banner update completed independent editorial review and was published and verified at 2026-09-21T05:44:21.430Z: [Vatican itinerary post](https://blog.naver.com/aicandoanything/224418405166). Exact public readback matched 33/33 units, five distinct downloaded images, and the clickable own affiliate banner. Existing authorization to publish
does not itself create that review or waive it.

Artifacts prevent stale or missing evidence from passing; they do not authenticate
the human identity of a reviewer or automatically judge whether a source truly
supports a sentence. The semantic verifier must actually read the material and
inspect the rendered output. No server-side conditional-write contract was
observed, so a small concurrency window remains between source read and mutation;
do not run two writers against the same post.

## Remaining live rollout work

Ordinary create/update jobs now require canonical `publishSettings.tags` and
verify the selected tags against protected owner metadata and the independent
public tag GET, even when all body/image checks already pass. Read
[the tag contract](naver-publication-tags.md) for the observed API, input bounds,
source evidence and the separate `prepare-tags` / `update-tags` /
`reconcile-tags` operation. That operation can only fill an existing public
post's missing tags while preserving its complete original model, content,
configuration and other metadata; it cannot accept replacement article content.

1. Reduce the remaining final SDK envelope issuance to direct HTTP only if its
   complete observed contract can be independently replayed. No tokenless retry,
   challenge emulation or historical token replay is implemented.
2. Verify a browser-free blank draft producer without fabricating editor metadata.
3. The Comet hanger commercial bundle has passed the full path. Other articles
   still require their own evidence, price, disclosure and visual-review gates. The bounded
   `prepare-private-probe` / `verify-private-update` commands verify transport
   only: they require an existing private technical test title/body, accept only
   four fixed test paragraphs, reject public/ordinary articles and explicitly
   return `publicationQualityVerified:false`. They cannot publish commercial text.
4. Verify the intended unattended credential renewal/restart lifecycle. The
   current Windows runtime loads a user-scoped protected session; renewal has not
   been independently demonstrated.
