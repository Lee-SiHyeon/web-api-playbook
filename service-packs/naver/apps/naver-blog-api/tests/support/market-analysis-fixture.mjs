import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {aiResearchFixture} from './ai-research-fixture.mjs';
import {NOW, bind} from './publication-fixture.mjs';
import {sha256} from '../../scripts/gates/publication-document.mjs';
import {MARKET_ANALYSIS_SCOPE, normalizeMarketRows, marketChartData, marketAsOfLabel} from '../../scripts/gates/market-analysis-article-contract.mjs';

export async function marketAnalysisFixture(directory, now = NOW) {
  const job = await aiResearchFixture(directory, now), bundle = job.publicationBundle, checkedAt = now.toISOString();
  const source = async (id, url, original, extras = {}) => {
    const evidenceFile = `${id}.json`, bytes = Buffer.from(JSON.stringify(original));
    await writeFile(path.join(directory, evidenceFile), bytes);
    return {id, url, checkedAt, evidenceFile, sha256: sha256(bytes), sourceKind: 'exchange_data', status: 200, ...extras};
  };
  const day = Math.floor(now.getTime() / 86400000) * 86400;
  const candles = Array.from({length: 11}, (_, i) => [day - (10 - i) * 86400, 990 + i * 10, 1030 + i * 10, 1000 + i * 10, 1010 + i * 10, 30 + i]).reverse();
  const candleSource = await source('coinbase-days', 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400', candles);
  const statsSource = await source('coinbase-stats', 'https://api.exchange.coinbase.com/products/BTC-USD/stats', {last: '1100', open: '1000'});
  const excerpt = 'Synthetic dated creator-method passage about recording uncertainty before interpreting a chart.';
  const creator = await source('creator-method', 'https://www.youtube.com/watch?v=QcOGxMzXZdE', {synthetic: true, excerpt}, {
    sourceKind: 'creator_original', status: null, acquisitionStatus: 'exported', evidenceMethod: 'youtube_official_transcript_export',
    creator: '완브로', channelId: 'UCQlIPwduvaV6Tjt24IyDJbQ', publishedAt: '2026-09-18T08:54:37Z',
  });
  const etfRows = ['14 Sep 2026 | 100.0 | 159.9', '15 Sep 2026 | (100.0) | (450.4)', '16 Sep 2026 | 0.0 | (295.9)', '17 Sep 2026 | 0.0 | 159.5', '18 Sep 2026 | 0.0 | 433.0'];
  const etf = await source('farside-btc-web', 'https://farside.co.uk/btc/', {synthetic: true, result: etfRows.join('\n')}, {sourceKind: 'primary_research', status: null, evidenceMethod: 'web_primary_page_extract', acquisitionStatus: 'observed'});
  const sources = [candleSource, statsSource, creator, etf];
  const evidence = Object.fromEntries(sources.map(value => [value.id, value]));
  const identityFile = 'creator-identity.json', identityBytes = Buffer.from(JSON.stringify({channel: {channelId: creator.channelId}, videos: [{url: creator.url, checkedAt, publishedAt: creator.publishedAt}]}));
  await writeFile(path.join(directory, identityFile), identityBytes);
  const identityEvidence = {evidenceFile: identityFile, sha256: sha256(identityBytes), evidenceMethod: 'youtube_native_dom_observation', status: null, acquisitionStatus: 'observed'};
  const dataset = {id: 'daily', sourceId: candleSource.id, intervalSeconds: 86400, recordPointer: '', fields: {time: 0, low: 1, high: 2, open: 3, close: 4, volume: 5}, timeUnit: 'seconds'};
  dataset.rows = normalizeMarketRows(candles, dataset, checkedAt);
  const claim = (claimId, claimType, value, sourceId, extra = {}) => ({claimId, claimType, text: value, sources: [sourceId], support: 'supports', publishable: true, ...extra});
  const claims = [
    claim('price', 'observed_price', `${marketAsOfLabel(checkedAt)} Coinbase Exchange BTC-USD USD 관측 시세는 1,100입니다.`, statsSource.id, {asOf: checkedAt, expiresAt: new Date(now.getTime() + 86400000).toISOString()}),
    claim('change', 'market_observation', '별도의 거래소 통계에서 24시간 변동률은 10%로 관찰됐습니다.', statsSource.id, {interval: 'rolling_24h'}),
    claim('daily', 'market_observation', '완료된 일봉의 마지막 종가는 해당 관측 구간을 설명하는 자료입니다.', candleSource.id),
    claim('method', 'creator_method', '완브로의 2026년 9월 18일 과거 원문은 불확실성을 먼저 기록하는 방법으로 소개합니다.', creator.id, {attribution: {creator: '완브로', sourceId: creator.id, publishedAt: creator.publishedAt}}),
    claim('etf', 'market_observation', '표시된 ETF 일별 합계의 주간 합은 6.1 US$m입니다.', etf.id),
    claim('hypothesis', 'causal_hypothesis', '이 수요 자료가 가격 해석에 도움이 될 가능성은 있지만 인과관계는 확인되지 않았습니다.', etf.id),
  ];
  const claimBindings = [
    {claimId: 'price', sourceId: statsSource.id, pointer: '/last', value: 1100},
    {claimId: 'change', sourceId: statsSource.id, operation: 'endpoint_change', startPointer: '/open', endPointer: '/last', value: 10, decimals: 2},
    {claimId: 'daily', datasetId: dataset.id, operation: 'last', field: 'close', value: dataset.rows.at(-1).close, decimals: 2},
    {claimId: 'method', sourceId: creator.id, locator: 'Synthetic transcript excerpt', excerpt},
    {claimId: 'etf', sourceId: etf.id, operation: 'sum_displayed_table_totals', terms: etfRows.map((value, index) => ({excerpt: value, value: [159.9, -450.4, -295.9, 159.5, 433][index]})), value: 6.1, decimals: 1},
    {claimId: 'hypothesis', sourceId: etf.id, locator: 'Synthetic displayed table row', excerpt: etfRows[4]},
  ];
  const images = bundle.document.blocks.filter(block => block.type === 'image');
  const rendererFile = 'synthetic-chart-renderer.txt', rendererBytes = Buffer.from('Synthetic regression fixture only; these PNG bytes are not factual charts.');
  await writeFile(path.join(directory, rendererFile), rendererBytes);
  const charts = [];
  for (const [i, spec] of [{kind: 'close', window: 7, smaWindows: [3]}, {kind: 'close', window: 3, smaWindows: []}, {kind: 'volume', window: 5, smaWindows: [3]}].entries()) {
    const id = `chart-${i}`, dataFile = `${id}.json`, data = Buffer.from(JSON.stringify(marketChartData(dataset, spec)));
    await writeFile(path.join(directory, dataFile), data);
    charts.push({id, datasetId: dataset.id, ...spec, imageSha256: images[i].sha256, dataFile, dataSha256: sha256(data), rendererFile, rendererSha256: sha256(rendererBytes)});
    Object.assign(images[i], {role: 'market_chart', chartId: id, purpose: `Synthetic chart fixture ${i}`, rights: {basis: 'owned', source: 'Synthetic test fixture'}});
  }
  bundle.format = MARKET_ANALYSIS_SCOPE.format;
  bundle.layoutReference = {id: 'naver-market-analysis-v1'};
  job.publishSettings.categoryId = MARKET_ANALYSIS_SCOPE.categoryId;
  job.publishSettings.categoryName = MARKET_ANALYSIS_SCOPE.categoryName;
  bundle.claimLedger = {schemaVersion: 1, evidence, claims};
  bundle.research = {schemaVersion: 1, topicKey: MARKET_ANALYSIS_SCOPE.topicKey, checkedAt, temporalBasis: 'dated_snapshot', category: {id: MARKET_ANALYSIS_SCOPE.categoryId, name: MARKET_ANALYSIS_SCOPE.categoryName}, instrument: {asset: 'BTC', exchange: 'Coinbase Exchange', market: 'BTC-USD', currency: 'USD'}, sources, datasets: [dataset], charts, claimBindings, identityEvidence};
  job.researchSnapshot = structuredClone(bundle.research);
  for (const key of ['marketDataAccuracy', 'chartsMatchData', 'factsVsHypotheses', 'creatorAttribution', 'noPersonalizedTradeInstructions']) bundle.qualityReview.checks[key] = true;
  for (const review of Object.values(bundle.renderReviews)) Object.assign(review.presentationChecks, {disclosureStyled: true, disclosurePanel: true});
  const paragraph = claimId => ({type: 'paragraph', claimClass: 'factual', claimIds: [claimId], text: claims.find(claim => claim.claimId === claimId).text});
  const heading = value => ({type: 'heading', presentation: 'quotation', claimClass: 'guidance', text: value});
  const caption = (value, i) => ({type: 'paragraph', claimClass: 'factual', claimIds: ['daily'], text: `출처: Coinbase Exchange 완료봉 자료로 구성한 ${value} 그림 ${i}입니다.`});
  job.title = bundle.document.title = '비트코인 관측 자료와 과거 방법을 구분해서 읽기';
  bundle.document.blocks = [
    {type: 'notice', presentation: 'panel', text: '2026-09-20 관측 기준의 교육 정보이며 투자 권유가 아닙니다. 실시간 시세가 아닙니다.'},
    images[0], caption('일봉', 0), paragraph('price'), paragraph('change'),
    heading('완료봉으로 관찰한 흐름'), images[1], caption('단기 종가', 1), paragraph('daily'),
    heading('가격과 거래량의 관계'), images[2], caption('거래량', 2), paragraph('etf'), paragraph('hypothesis'),
    heading('과거 원문에서 확인한 방법'), paragraph('method'),
    ...sources.map(value => ({type: 'link', display: 'label', label: `원문 자료 ${value.id}`, url: value.url})),
  ];
  return bind(job);
}
