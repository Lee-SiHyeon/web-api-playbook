# Dated Bitcoin market analysis contract

`market_analysis_article` is a separate noncommercial route for
`aicandoanything`, category **13 / 경제·투자**, and topic
`bitcoin-wanbro-20260921`. Category 13 was observed after the owner's requested
creation; it is not inferred from category order. Creation uses `headless_sdk`
inputs and the independent HTTP writer. A full-gate update is also supported for
the existing post **224419142479** only; it uses `inputProvider: independent_http`
and matching `target.logNo` / `document.logNo`. This does not extend the generic affiliate workflow
to financial promotion or relax its existing high-risk restrictions.

The implementation is
[`market-analysis-article-contract.mjs`](../apps/naver-blog-api/scripts/gates/market-analysis-article-contract.mjs).
[`informational-article-contract.mjs`](../apps/naver-blog-api/scripts/gates/informational-article-contract.mjs)
explicitly dispatches the original AI contract and this market contract. The AI
and commerce contracts retain their own scopes. A format name alone cannot make
a commercial payload pass.

## Scope and time

Keep `products: []`; omit `affiliate` and `commercialSnapshot`. Use the normal
complete document, claim ledger, collision record, independent editorial review,
native desktop/mobile receipts and authorization. Bind `job.researchSnapshot`
to `publicationBundle.research` exactly.

This route is a **dated snapshot**, not a continuously updated quote service.
`research.temporalBasis` is `dated_snapshot`. Research and source collection must
be within 24 hours of publication. An `observed_price` claim records `asOf`
equal to its actual source collection time and an `expiresAt` no later than 24
hours afterward. Copying or rechecking a local file never refreshes that time.
The body includes `marketAsOfLabel(asOf)` (for example `2026-09-21 21:36 KST`),
the exchange, exact market and currency. It explicitly says `실시간 시세가
아닙니다`. A later publication must obtain and review a new source-backed
snapshot rather than merely changing its timestamp.

The first block is a visible notice panel with its date, informational purpose
and a clear clause such as `투자 권유가 아닙니다`. The negative wording is checked
within that clause; a different sentence's negation cannot qualify an affirmative
investment recommendation.

## Research shape

```text
research: {
  schemaVersion: 1,
  topicKey: "bitcoin-wanbro-20260921",
  checkedAt, temporalBasis: "dated_snapshot",
  category: {id: 13, name: "경제·투자"},
  instrument: {asset: "BTC", exchange: "Coinbase Exchange",
               market: "BTC-USD", currency: "USD"},
  sources: [{id, url, publicUrl?, sourceKind, status, checkedAt,
             evidenceFile, sha256, ...observed acquisition metadata}],
  datasets: [{id, sourceId, intervalSeconds, recordPointer, fields,
              timeUnit: "seconds", rows}],
  charts: [{id, datasetId, kind, window, smaWindows, imageSha256,
            dataFile, dataSha256, rendererFile, rendererSha256}],
  claimBindings: [...],
  identityEvidence: {evidenceFile, sha256,
    evidenceMethod: "youtube_native_dom_observation",
    status: null, acquisitionStatus: "observed"}
}
```

Sources reuse the claim ledger's URL, observation time, evidence file and SHA-256
exactly. Reader links are labeled and point to those exact source URLs; this
adapter introduces no canonical-URL guessing, affiliate URLs or sales CTAs.

Supported exchange sources are the observed Coinbase Exchange BTC-USD `stats`
and `candles` endpoints and Upbit's `KRW-BTC` ticker. They require actual HTTP
200 receipts. Coinbase candle granularity must match the dataset interval.

Farside's exact `https://farside.co.uk/btc/` source can use
`sourceKind: primary_research`, `status: null`,
`evidenceMethod: web_primary_page_extract`, `acquisitionStatus: observed` when
the actual evidence is a successful primary-page text extraction. A separate
direct HTTP 403 is not successful evidence and must not be relabeled HTTP 200.

The scoped creator sources are the three actually inspected videos
`c-knzrrlmFs`, `l7a4_zqY-IY` and `QcOGxMzXZdE` from channel
`UCQlIPwduvaV6Tjt24IyDJbQ` (완브로). Official transcript exports use
`sourceKind: creator_original`, `status: null`, `acquisitionStatus: exported`
and `evidenceMethod: youtube_official_transcript_export`, plus the exact creator,
channel ID and observed `publishedAt`. The hashed identity receipt must match
each video's URL, publication date and observed collection time. Transcript
access is not proof that the video's motion/audio was reviewed or that a trade
was executed.

Selected visual inspections supplement transcripts through optional
`research.creatorVisualEvidence: {evidenceFile, sha256}`. Its original JSON has
`schemaVersion: 1`, `evidenceMethod: youtube_paused_frame_review`, `checkedAt`,
`frames: [{id, sourceId, timeSeconds, paused: true, readyState: 4, imageFile,
imageSha256}]`, and `observations: [{id, sourceId, frameIds, observed,
inferred?, limitations?}]`. Each source must be one of the scoped creator
sources, each frame must exist as a hash-matching PNG or JPEG (sniffing actual
bytes rather than trusting a filename suffix), and observations must
reference frames of that same source. A visual claim binding is
`{claimId, sourceId, visualObservationId, excerpt}`; its excerpt must occur in the
observation's `observed` text, never merely in an inference or caption supplement.
These are reviewer observations of selected frames, not original transcript
quotes. Hashes verify integrity, not the semantic accuracy of the observation;
the independent reviewer still inspects the images. This does not establish
full video/audio coverage, an exact indicator implementation, or performance.

## Data, calculations and charts

Coinbase's raw candle rows are `[time, low, high, open, close, volume]`. A dataset
can therefore use `recordPointer: ""` and `fields: {time:0, low:1, high:2,
open:3, close:4, volume:5}`. JSON-pointer field strings are also supported.
`normalizeMarketRows(raw, dataset, sourceCheckedAt)` returns numeric OHLCV rows,
sorted by Unix-second candle start time, and excludes every candle not closed at
that original observation time. Null values are not coerced to zero. Dataset
rows must exactly equal this result; prices and OHLC ordering must be valid and
the hourly/daily time intervals must be continuous.

`marketChartData(dataset, chart)` generates the canonical chart input:

```text
{datasetId, kind: "close" | "volume", window, smaWindows,
 points: [{time, value, sma20?, sma50?}]}
```

Moving averages use the complete available closed history **before** slicing the
visible window, with eight-decimal output precision. Insufficient warm-up values
are null. The actual pilot uses daily close/90 bars with SMA20/50, hourly
close/168 bars, and daily volume/30 bars with SMA20. Renderer code must read the
verified chart input. Record the input JSON, renderer file and final PNG hashes.

For `kind: candlestick`, points instead contain
`{time, open, high, low, close, volume, sma20?, sma50?}`. All OHLCV values are
copied from the completed dataset and SMA uses close. Invalid OHLC, negative
volume, nonnumeric values or nonascending times are rejected. Independently
reconstructed canonical data must match the entire saved input, including wick
and volume values; changing a file and updating its declared hash cannot pass.
An optional renderer-only `volumePanel` flag does not change the canonical data.

At least three distinct charts are required. Their image blocks use
`role: market_chart`, `chartId`, `rights.basis: owned` and an immediately adjacent
factual source caption. The lead chart follows the notice; section headings use
at least three native quotations. Generated or invented price curves cannot
satisfy the chart contract. Images remain subject to the shared file/hash/rights,
distinctness, loaded-image, native preview and public download checks.

Supported claim bindings are:

- Literal evidence: `{claimId, sourceId, locator, excerpt}`. Excerpts must occur
  in the original bytes or decoded JSON strings.
- Raw numeric value: `{claimId, sourceId, pointer, value, multiplier?, decimals?}`.
  Multipliers are limited to 1 or 100 (for ratio-to-percent conversion).
- Source endpoint change: `{claimId, sourceId, operation: "endpoint_change",
  startPointer: "/open", endPointer: "/last", value, decimals}`.
- Closed-series metric: `{claimId, datasetId, operation: "last" | "sma" |
  "endpoint_change", field: "close" | "volume", window?, value, decimals}`.
- Farside displayed-total sum: `{claimId, sourceId,
  operation: "sum_displayed_table_totals", terms: [{excerpt, value}], value,
  decimals}`. Each original table row must match literally; the final Total
  column is reparsed, including accounting parentheses for negative numbers,
  before the rounded sum is compared. These are displayed rounded values, not
  independently obtained unrounded fund totals.

Coinbase's endpoint-change claim has `interval: rolling_24h`; Upbit's
`signed_change_rate` claim has `interval: previous_close`. The factual paragraph
must show the corresponding `24시간` or `전일` basis. A correctly labeled
comparison may mention both in one paragraph; it must not relabel either period.

## Interpretive and publication boundaries

Claim types are `observed_price`, `market_observation`, `causal_hypothesis`,
`creator_method` and `uncertainty`. Every publishable claim is used by a factual
block and tied to its actual source or reproducible calculation. A causal
hypothesis is visibly labeled as a possibility or interpretation and cannot be
stated as proved causation. A creator method carries
`attribution: {creator, sourceId, publishedAt}` and is presented as that dated
source's method. Do not invent the creator's current opinion, personal trading
results, performance guarantees or trade instructions.

The independent review adds explicit checks for `marketDataAccuracy`,
`chartsMatchData`, `factsVsHypotheses`, `creatorAttribution` and
`noPersonalizedTradeInstructions`. Source/code/image hashes establish integrity
and bindings; they do **not** prove that plotted pixels have correct axes or
that a causal interpretation is true. The reviewer must inspect the actual
charts and final article. No reviewer receipt is synthesized by the contract.

Full native PC/mobile previews, content-bound authorization, the supported
headless create envelope, one journaled HTTP write, protected owner/category
readback, exact ordered public text and image checks, clickable source hrefs and
read-only uncertain-write reconciliation remain mandatory. This adapter adds no
trade execution, financial affiliate, or general market-post update endpoint.

## Existing-post update

Only `aicandoanything/224419142479` is supported. The current protected owner
state must already be public (`openType: 2`), searchable (`searchYn: true`) and
category 13. `prepareUpdate` records the existing document fingerprint plus
`sourceConfigurationFingerprint` and `sourcePopulationMetaFingerprint` from the
observed configuration and the metadata fields supported by the existing wire
contract. Authorization also binds these fingerprints. A change before submit
requires fresh preparation and review binding; the updater never silently
repairs settings. It passes through the original supported configuration and
metadata, including tags, comment settings and location information.

After the one journaled update, protected owner readback compares every sent
configuration value and the full metadata object. Category or unrelated-setting
changes leave the write uncertain even if public text matches. `reconcileUpdate`
uses the original journal expectations and reads only; there is no automatic
POST retry. Informational source/link/image auditing runs on both update and
reconciliation, with the same independent editorial and native preview gates as
creation. The generic commerce redirect requirement remains unchanged.

The task-local `bitcoin-candlestick-review/runtime.mjs` exposes `owner-baseline`,
`upload`, `preview`, `prepare-update`, `update`, `reconcile` and `read-final`.
It is restricted to this exact post and three reviewed chart files. Prepare the
document and evidence, collect the protected owner baseline, upload verified
images, obtain the real native PC/mobile previews and independent review, then
build the final bundle and call `prepare-update`. Merge its complete result into
preflight before content-bound authorization. Submit through `update` once;
reconcile an uncertain outcome without resubmitting. It receives the existing
session via stdin, keeps cookies in memory and never creates a new article.

## Regression evidence

The maintained Naver app's full `node --test` run on 2026-09-21 passed
**565/565** tests (the prior 551 plus 14 update/candlestick/visual-evidence tests).
The run log is `bitcoin-candlestick-review/publisher-regression-tests.txt`.
Coverage includes
raw/source and calculation tampering, completed-candle/SMA behavior, dated-price
expiry, honest transcript/page-extract provenance, Korean notice grammar,
mixed-period comparisons, missing chart/native/independent review rejection,
unchanged generic financial-affiliate routing, and a synthetic single HTTP create
followed by exact readback and read-only reconciliation. Tests do not establish a
live article's independent review or publication.

Update-specific tests cover preserving original configuration and nested
metadata, rejecting pre-write changes, read-only reconciliation of post-write
mismatches or a lost response, and keeping source URLs exact. Candlestick tests
bind full OHLCV, reject a changed wick/volume despite a new input hash, and verify
close-based moving-average warm-up. Visual evidence tests reject unpaused or
wrong-source frames, missing frame references, invented observations and changed
screenshot bytes. They use clearly synthetic fixtures and do not claim to have
reviewed the actual user's video frames.
