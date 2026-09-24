import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {marketAnalysisFixture} from './support/market-analysis-fixture.mjs';
import {NOW, bind, publicationFixture, publicHtml} from './support/publication-fixture.mjs';
import {evaluateMarketAnalysisArticle, normalizeMarketRows, marketChartData, calculateMarketMetric, marketNoticeValid, MARKET_ANALYSIS_SCOPE} from '../scripts/gates/market-analysis-article-contract.mjs';
import {sha256} from '../scripts/gates/publication-document.mjs';
import {evaluatePublisherJobGate, publisherContentFingerprint} from '../scripts/gates/publisher-gates.mjs';
import {verifyPublicationArtifacts} from '../scripts/gates/publication-artifacts.mjs';
import {evaluateExactReadback} from '../scripts/gates/publication-review-gates.mjs';
import {parsePublicDocument} from '../scripts/api/public-document.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'market-article-contract-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return {directory, job: await marketAnalysisFixture(directory)};
}

test('dated market article passes full source, calculation, charts, editorial, native and authorization gates without commerce payload', async t => {
  const {directory, job} = await fixture(t);
  const gate = await evaluatePublisherJobGate(job, {baseDir: directory, now: NOW});
  assert.deepEqual(gate.failedChecks, [], JSON.stringify(gate.details));
  assert.equal(gate.details.researchGate.passed, true);
  assert.equal(Object.hasOwn(gate.checks, 'monetizedAffiliateVerified'), false);
});

for (const [name, mutate, expected] of [
  ['wrong blog', j => j.blogId = 'otherblog', 'marketPublicationScope'],
  ['update target', j => j.target = {type: 'update', logNo: '123456789'}, 'marketPublicationScope'],
  ['wrong category', j => j.publishSettings.categoryId = 12, 'marketCategory'],
  ['unscoped subject', j => j.publicationBundle.research.topicKey = 'other', 'marketTopic'],
  ['affiliate payload', j => j.affiliate = {url: 'https://buy.example.com/'}, 'marketNoCommerce'],
  ['dummy product', j => j.publicationBundle.products = [{productId: 'dummy'}], 'marketNoCommerce'],
  ['wrong instrument currency', j => j.publicationBundle.research.instrument.currency = 'KRW', 'marketInstrument'],
  ['live-price relabel', j => j.publicationBundle.research.temporalBasis = 'live', 'marketFresh'],
  ['invented HTTP status for exported transcript', j => {j.publicationBundle.research.sources[2].status = 403;}, 'marketSources'],
  ['third-party creator', j => j.publicationBundle.research.sources[2].channelId = 'someone-else', 'marketSources'],
  ['unobserved exchange', j => j.publicationBundle.research.sources[0].url = 'https://example.com/candles?granularity=86400', 'marketSources'],
  ['stale observation', j => j.publicationBundle.claimLedger.claims[0].asOf = '2026-09-18T10:00:00Z', 'marketObservedPriceFresh'],
  ['false refreshed observation', j => j.publicationBundle.claimLedger.claims[0].asOf = '2026-09-20T09:59:00Z', 'marketObservedPriceFresh'],
  ['hypothesis stated as proven cause', j => j.publicationBundle.document.blocks.find(b => b.claimIds?.includes('hypothesis')).text = '확실한 원인이다.', 'marketHypothesesLabeled'],
  ['unattributed creator', j => j.publicationBundle.claimLedger.claims.find(c => c.claimId === 'method').attribution.creator = 'other', 'marketCreatorAttribution'],
  ['performance guarantee', j => j.publicationBundle.document.blocks.push({type: 'paragraph', claimClass: 'guidance', text: '원금 보장 상품입니다.'}), 'marketNoPromisesOrOrders'],
  ['trade instruction', j => j.publicationBundle.document.blocks.push({type: 'paragraph', claimClass: 'guidance', text: '지금 매수하세요.'}), 'marketNoPromisesOrOrders'],
  ['arbitrary CTA', j => j.publicationBundle.document.blocks.push({type: 'link', display: 'label', label: '가입해서 시작하기', url: 'https://signup.example.com/'}), 'marketLinks'],
  ['missing chart semantic review', j => delete j.publicationBundle.qualityReview.checks.chartsMatchData, 'marketEditorialChecks'],
]) test(`market article rejects ${name}`, async t => {
  const {job} = await fixture(t); mutate(job); bind(job);
  const gate = evaluateMarketAnalysisArticle(job, {now: NOW});
  assert.equal(gate.passed, false); assert.ok(gate.failedChecks.includes(expected), gate.failedChecks.join(','));
});

test('closed-candle normalization excludes the unfinished bar and preserves OHLCV values', () => {
  const dataset = {recordPointer: '', fields: {time: 0, low: 1, high: 2, open: 3, close: 4, volume: 5}, intervalSeconds: 3600, timeUnit: 'seconds'};
  const rows = normalizeMarketRows([[3600, 8, 13, 10, 12, 4], [0, 8, 12, 9, 10, 3]], dataset, '1970-01-01T01:30:00Z');
  assert.deepEqual(rows, [{time: 0, open: 9, high: 12, low: 8, close: 10, volume: 3}]);
  assert.throws(() => normalizeMarketRows([[0, null, 12, 9, 10, 3]], dataset, '1970-01-01T01:30:00Z'), /MARKET_NUMBER_REQUIRED/);
});

test('Korean negative notice accepts 아니 and 아닙 but does not borrow a different sentence negation', () => {
  for (const ending of ['투자 권유가 아닙니다.', '투자 조언이 아니며 교육용입니다.']) assert.equal(marketNoticeValid(`2026-09-21 기준 정보입니다. ${ending}`), true);
  assert.equal(marketNoticeValid('2026-09-21 기준 투자 권유입니다. 실시간 시세가 아닙니다. 정보입니다.'), false);
});

test('dated observations remain dated within 24 hours and cannot have their clock silently refreshed', async t => {
  const {job} = await fixture(t);
  assert.equal(evaluateMarketAnalysisArticle(job, {now: new Date(NOW.getTime() + 12 * 3600000)}).passed, true);
  const expired = evaluateMarketAnalysisArticle(job, {now: new Date(NOW.getTime() + 25 * 3600000)});
  assert.equal(expired.checks.marketFresh, false);
  assert.equal(expired.checks.marketObservedPriceFresh, false);
});

test('previous-close and rolling-24h returns may be correctly compared in one paragraph', async t => {
  const {job} = await fixture(t), bundle = job.publicationBundle;
  const source = {...bundle.research.sources[1], id: 'upbit-ticker', url: 'https://api.upbit.com/v1/ticker?markets=KRW-BTC'};
  bundle.research.sources.push(source); bundle.claimLedger.evidence[source.id] = source;
  const claim = {claimId: 'krw-change', claimType: 'market_observation', sources: [source.id], support: 'supports', publishable: true, interval: 'previous_close', text: 'Upbit의 전일 종가 대비 3.78%는 위 Coinbase 24시간 변동률과 구간이 달라 직접 비교할 수 없습니다.'};
  bundle.claimLedger.claims.push(claim);
  bundle.research.claimBindings.push({claimId: claim.claimId, sourceId: source.id, pointer: '/0/signed_change_rate', multiplier: 100, decimals: 2, value: 3.78});
  const paragraph = {type: 'paragraph', claimClass: 'factual', claimIds: [claim.claimId], text: claim.text};
  bundle.document.blocks.push(paragraph);
  job.researchSnapshot = structuredClone(bundle.research); bind(job);
  assert.equal(evaluateMarketAnalysisArticle(job, {now: NOW}).checks.marketReturnPeriodsVisible, true);
  claim.interval = 'rolling_24h';
  assert.equal(evaluateMarketAnalysisArticle(job, {now: NOW}).checks.marketReturnPeriodsVisible, false);
  claim.interval = 'previous_close'; paragraph.text = 'Upbit의 24시간 변동률은 3.78%입니다.';
  assert.equal(evaluateMarketAnalysisArticle(job, {now: NOW}).checks.marketReturnPeriodsVisible, false);
});

test('chart SMA uses the full closed history before slicing its visible window', () => {
  const dataset = {id: 'test', rows: [10, 20, 30, 40].map((close, time) => ({time, close, volume: close / 2}))};
  const data = marketChartData(dataset, {kind: 'close', window: 2, smaWindows: [3]});
  assert.deepEqual(data.points, [{time: 2, value: 30, sma3: 20}, {time: 3, value: 40, sma3: 30}]);
  assert.equal(calculateMarketMetric(dataset, {operation: 'endpoint_change', field: 'close', window: 3, decimals: 2}), 100);
  assert.equal(calculateMarketMetric(dataset, {operation: 'sma', field: 'volume', window: 3, decimals: 2}), 15);
});

test('candlestick canonical input retains actual OHLCV and computes close SMA before slicing', () => {
  const dataset = {id: 'candles', rows: [10, 20, 30, 40].map((close, time) => ({time, open: close - 1, high: close + 2, low: close - 3, close, volume: 100 + close}))};
  assert.deepEqual(marketChartData(dataset, {kind: 'candlestick', window: 2, smaWindows: [3]}), {
    datasetId: 'candles', kind: 'candlestick', window: 2, smaWindows: [3], points: [
      {time: 2, open: 29, high: 32, low: 27, close: 30, volume: 130, sma3: 20},
      {time: 3, open: 39, high: 42, low: 37, close: 40, volume: 140, sma3: 30},
    ],
  });
  dataset.rows[0].high = 1;
  assert.throws(() => marketChartData(dataset, {kind: 'candlestick', window: 2, smaWindows: []}), /MARKET_CANDLE_INVALID/);
});

test('the observed market post update retains full gates; another post or create SDK provider cannot enter it', async t => {
  const {directory, job} = await fixture(t);
  job.target = {type: 'update', logNo: MARKET_ANALYSIS_SCOPE.existingLogNo};
  job.inputProvider = 'independent_http';
  job.publicationBundle.document.logNo = job.target.logNo; bind(job);
  assert.deepEqual((await evaluatePublisherJobGate(job, {baseDir: directory, now: NOW})).failedChecks, []);
  job.inputProvider = 'headless_sdk';
  assert.equal(evaluateMarketAnalysisArticle(job, {now: NOW}).checks.marketPublicationScope, false);
  job.inputProvider = 'independent_http'; job.target.logNo = '224419142480';
  assert.equal(evaluateMarketAnalysisArticle(job, {now: NOW}).checks.marketPublicationScope, false);
});

test('candlestick evidence rejects tampered wick or volume despite a freshly matching chart-file hash', async t => {
  const {directory, job} = await fixture(t), bundle = job.publicationBundle;
  const chart = bundle.research.charts[0]; chart.kind = 'candlestick';
  const data = marketChartData(bundle.research.datasets[0], chart);
  const save = async value => {const bytes = Buffer.from(JSON.stringify(value)); chart.dataSha256 = sha256(bytes); await writeFile(path.join(directory, chart.dataFile), bytes);};
  await save(data);
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks['marketChart_chart-0'], true);
  for (const field of ['high', 'volume']) {
    const altered = structuredClone(data); altered.points[0][field] += 10; await save(altered);
    assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks['marketChart_chart-0'], false);
  }
});

test('selected video frames have their own hashed visual observations without pretending transcript evidence is video review', async t => {
  const {directory, job} = await fixture(t), bundle = job.publicationBundle, image = bundle.document.blocks.find(block => block.type === 'image');
  const observed = 'Synthetic reviewer observation: two lines and an upward drawn path are visible in this selected frame.';
  const manifest = {schemaVersion: 1, evidenceMethod: 'youtube_paused_frame_review', checkedAt: NOW.toISOString(),
    frames: [{id: 'frame-1', sourceId: 'creator-method', timeSeconds: 192.5, paused: true, readyState: 4, imageFile: image.file, imageSha256: image.sha256}],
    observations: [{id: 'visible-lines', sourceId: 'creator-method', frameIds: ['frame-1'], observed, limitations: 'Synthetic fixture; no actual video inspected.'}]};
  const save = async () => {const bytes = Buffer.from(JSON.stringify(manifest)); await writeFile(path.join(directory, 'frames.json'), bytes); bundle.research.creatorVisualEvidence = {evidenceFile: 'frames.json', sha256: sha256(bytes)};};
  bundle.research.claimBindings[3] = {claimId: 'method', sourceId: 'creator-method', visualObservationId: 'visible-lines', excerpt: observed};
  await save(); job.researchSnapshot = structuredClone(bundle.research); bind(job);
  assert.equal((await evaluatePublisherJobGate(job, {baseDir: directory, now: NOW})).passed, true);
  for (const mutate of [() => manifest.frames[0].paused = false, () => manifest.frames[0].sourceId = 'coinbase-stats', () => manifest.observations[0].frameIds = ['missing-frame']]) {
    manifest.frames[0].paused = true; manifest.frames[0].sourceId = 'creator-method'; manifest.observations[0].frameIds = ['frame-1']; mutate(); await save();
    const result = await verifyPublicationArtifacts(bundle, {baseDir: directory});
    assert.equal(result.checks.marketCreatorVisualEvidenceVerified, false); assert.equal(result.checks.marketBinding_3, false);
  }
  manifest.frames[0].paused = true; manifest.frames[0].sourceId = 'creator-method'; manifest.observations[0].frameIds = ['frame-1']; await save();
  bundle.research.claimBindings[3].excerpt = 'Invented visual claim not contained in the actual observed text.';
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks.marketBinding_3, false);
  await writeFile(path.join(directory, image.file), 'tampered screenshot');
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks.marketCreatorVisualEvidenceVerified, false);
});

test('market update authorization also binds the observed configuration and metadata fingerprints', async t => {
  const {job} = await fixture(t); job.target = {type: 'update', logNo: MARKET_ANALYSIS_SCOPE.existingLogNo};
  const first = publisherContentFingerprint(job);
  job.preflight.sourceConfigurationFingerprint = 'a'.repeat(64); assert.notEqual(publisherContentFingerprint(job), first);
  const second = publisherContentFingerprint(job);
  job.preflight.sourcePopulationMetaFingerprint = 'b'.repeat(64); assert.notEqual(publisherContentFingerprint(job), second);
});

test('tampered source, normalized rows, calculation and chart input fail independent artifact checks', async t => {
  const {directory, job} = await fixture(t), bundle = job.publicationBundle;
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).passed, true);
  bundle.research.claimBindings[0].value = 9999;
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks.marketBinding_0, false);
  bundle.research.claimBindings[0].value = 1100;
  bundle.research.claimBindings[4].terms[0].value = 160;
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks.marketBinding_4, false);
  bundle.research.datasets[0].rows[0].close += 1;
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks.marketDataset_daily, false);
  await writeFile(path.join(directory, bundle.research.charts[0].dataFile), '{}');
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks['marketChart_chart-0'], false);
  await writeFile(path.join(directory, bundle.research.sources[1].evidenceFile), 'altered raw bytes');
  assert.equal((await verifyPublicationArtifacts(bundle, {baseDir: directory})).checks['marketSource_coinbase-stats'], false);
});

for (const [name, mutate, expected] of [
  ['missing chart', b => b.document.blocks.splice(1, 1), 'marketChartFloor'],
  ['generated price curve', b => b.document.blocks[1].rights.basis = 'generated', 'marketChartsOwned'],
  ['collapsed headings', b => b.document.blocks.find(x => x.type === 'heading').presentation = 'plain', 'marketQuotationSections'],
  ['missing mobile render', b => delete b.renderReviews.mobile, 'mobileRenderMatches'],
  ['self review execution', b => b.qualityReview.provenance.reviewerExecutionId = b.authorExecutionId, 'independentReviewProvenance'],
]) test(`market article preserves ${name} rejection`, async t => {
  const {directory, job} = await fixture(t); mutate(job.publicationBundle); bind(job);
  const gate = await evaluatePublisherJobGate(job, {baseDir: directory, now: NOW});
  assert.equal(gate.passed, false); assert.ok(gate.details.publicationReview.failedChecks.includes(expected));
});

test('research and chart specification changes invalidate authorization; commerce cannot be relabeled to escape its gates', async t => {
  const {directory, job} = await fixture(t), before = publisherContentFingerprint(job);
  job.researchSnapshot.charts[0].window = 2;
  assert.notEqual(publisherContentFingerprint(job), before);
  assert.equal(evaluateMarketAnalysisArticle(job, {now: NOW}).checks.marketSnapshotBound, false);
  const commerce = await publicationFixture(directory); commerce.publicationBundle.format = 'market_analysis_article'; bind(commerce);
  assert.equal((await evaluatePublisherJobGate(commerce, {baseDir: directory, now: NOW})).passed, false);
});

test('market readback binds exact source URLs, all ordered text and unlinked charts', async t => {
  const {job} = await fixture(t), logNo = '987654321';
  const observation = parsePublicDocument(publicHtml({...job.publicationBundle.document, logNo}), {url: `https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${logNo}`, checkedAt: NOW.toISOString()});
  assert.equal(evaluateExactReadback(job, observation, {now: NOW, createdLogNo: logNo}).passed, true);
  observation.links[0] = 'https://evil.example.com/';
  assert.equal(evaluateExactReadback(job, observation, {now: NOW, createdLogNo: logNo}).passed, false);
});
