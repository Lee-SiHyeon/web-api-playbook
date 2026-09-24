import {articleBlockText} from './article-block-text.mjs';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {text} from './publication-document.mjs';

export const MARKET_ANALYSIS_SCOPE = Object.freeze({
  format: 'market_analysis_article', blogId: 'aicandoanything', topicKey: 'bitcoin-wanbro-20260921',
  categoryId: 13, categoryName: '경제·투자', minCharts: 3,
  existingLogNo: '224419142479',
});
export const isMarketAnalysisArticle = job => job?.publicationBundle?.format === MARKET_ANALYSIS_SCOPE.format;
export const isMarketAnalysisUpdate = job => isMarketAnalysisArticle(job) && job?.target?.type === 'update';
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const recent = (value, now, minutes) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime() && now.getTime() - Date.parse(value) <= minutes * 60000;
const finish = checks => ({passed: Object.values(checks).every(value => value === true), checks, failedChecks: Object.keys(checks).filter(key => checks[key] !== true)});
const blocksOf = bundle => Array.isArray(bundle?.document?.blocks) ? bundle.document.blocks : [];
const sourcesOf = bundle => Array.isArray(bundle?.research?.sources) ? bundle.research.sources : [];
const fields = ['time', 'open', 'high', 'low', 'close', 'volume'];
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const transcriptVideos = new Set(['c-knzrrlmFs', 'l7a4_zqY-IY', 'QcOGxMzXZdE']);
export const marketAsOfLabel = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' KST';

function cleanUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      !/(?:^|\.)(?:coupang\.com|myrealtrip\.com|myrealt\.rip|bit\.ly|linktr\.ee)$/.test(url.hostname) &&
      ![...url.searchParams.keys()].some(key => /^(?:ref|referral|affiliate|aff|tag|lptag|partner|mylink)$/i.test(key));
  } catch { return false; }
}

function sourceContract(source, now) {
  if (!text(source?.id) || !cleanUrl(source.url) || !cleanUrl(source.publicUrl || source.url) || !text(source.evidenceFile) || !hash(source.sha256) || !recent(source.checkedAt, now, 1440)) return false;
  if (source.publicUrl != null && source.publicUrl !== source.url) return false;
  if (source.sourceKind === 'primary_research') return source.url === 'https://farside.co.uk/btc/' && source.status === null && source.evidenceMethod === 'web_primary_page_extract' && source.acquisitionStatus === 'observed';
  if (source.sourceKind === 'creator_original') {
    const url = new URL(source.publicUrl || source.url);
    return ['www.youtube.com', 'youtube.com'].includes(url.hostname) && url.pathname === '/watch' && transcriptVideos.has(url.searchParams.get('v')) &&
      source.channelId === 'UCQlIPwduvaV6Tjt24IyDJbQ' && source.creator === '완브로' && Number.isFinite(Date.parse(source.publishedAt)) &&
      (source.status === 200 || source.status === null && source.acquisitionStatus === 'exported' && source.evidenceMethod === 'youtube_official_transcript_export');
  }
  const url = new URL(source.url);
  return source.sourceKind === 'exchange_data' && source.status === 200 && (
    url.origin === 'https://api.exchange.coinbase.com' && /^\/products\/BTC-USD\/(?:stats|candles)$/.test(url.pathname) ||
    url.origin === 'https://api.upbit.com' && url.pathname === '/v1/ticker' && url.searchParams.get('markets') === 'KRW-BTC'
  );
}
const granularity = value => {try {return Number(new URL(value).searchParams.get('granularity'));} catch {return NaN;}};
const decimalsValid = value => Number.isInteger(value) && value >= 0 && value <= 8;
function bindingContract(binding) {
  if (binding.visualObservationId) return text(binding.visualObservationId).length > 0 && text(binding.excerpt).length >= 12;
  if (binding.datasetId) return ['last', 'sma', 'endpoint_change'].includes(binding.operation) && ['close', 'volume'].includes(binding.field) && numeric(binding.value) && decimalsValid(binding.decimals);
  if (binding.operation === 'sum_displayed_table_totals') return Array.isArray(binding.terms) && binding.terms.length > 1 && binding.terms.every(term => text(term.excerpt).length >= 12 && numeric(term.value)) && numeric(binding.value) && decimalsValid(binding.decimals);
  if (binding.operation === 'endpoint_change') return typeof binding.startPointer === 'string' && typeof binding.endPointer === 'string' && numeric(binding.value) && decimalsValid(binding.decimals);
  if (typeof binding.pointer === 'string') return numeric(binding.value) && [undefined, 1, 100].includes(binding.multiplier) && (binding.decimals == null || decimalsValid(binding.decimals));
  return text(binding.locator).length >= 3 && text(binding.excerpt).length >= 12;
}

export function marketNoticeValid(value) {
  const notice = text(value);
  const datedRiskRecord = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+KST/.test(notice) && /당시\s*시장\s*기록/.test(notice) && /투자\s*판단은\s*자신의\s*위험\s*기준에\s*따라/.test(notice);
  return (datedRiskRecord || /기준|확인/.test(notice) && /\d{4}[.\-/년]/.test(notice) && /정보|교육/.test(notice) && /투자\s*(?:권유|조언)(?:가|이)?\s*아(?:니|닙)/.test(notice)) && !/제휴|수수료|파트너스|협찬|실시간\s*현재가|지금\s*현재\s*가격/.test(notice);
}

export function marketAnalysisLayoutChecks(bundle) {
  const blocks = blocksOf(bundle), images = blocks.filter(block => block.type === 'image');
  const charts = bundle?.research?.charts || [], headings = blocks.filter(block => block.type === 'heading');
  return {
    marketLayoutProfile: bundle?.layoutReference?.id === 'naver-market-analysis-v1',
    marketNoticeFirst: blocks[0]?.type === 'notice' && blocks[0].presentation === 'panel' && marketNoticeValid(blocks[0].text),
    marketChartFloor: images.length >= MARKET_ANALYSIS_SCOPE.minCharts && charts.length === images.length,
    marketChartsOwned: images.every(image => image.role === 'market_chart' && image.rights?.basis === 'owned' && !image.href && charts.some(chart => chart.id === image.chartId && chart.imageSha256 === image.sha256)),
    marketLeadChart: blocks[1]?.type === 'image',
    marketChartCaptions: images.every(image => {const index = blocks.indexOf(image); return blocks[index + 1]?.type === 'paragraph' && blocks[index + 1].claimClass === 'factual' && /출처|자료/.test(text(blocks[index + 1].text));}),
    marketQuotationSections: headings.length >= 3 && headings.every(heading => heading.presentation === 'quotation'),
    marketNoImageStrips: blocks.every(block => block.type !== 'imageStrip'),
  };
}

export function evaluateMarketAnalysisArticle(job, {now = new Date()} = {}) {
  const bundle = job?.publicationBundle, research = bundle?.research, sources = sourcesOf(bundle), blocks = blocksOf(bundle);
  const claims = bundle?.claimLedger?.claims || [], bindings = research?.claimBindings || [], datasets = research?.datasets || [], charts = research?.charts || [];
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const datasetMap = new Map(datasets.map(dataset => [dataset.id, dataset]));
  const sourceUrls = new Set(sources.flatMap(source => [source.url, source.publicUrl || source.url]));
  const links = blocks.filter(block => ['link', 'oglink'].includes(block.type));
  const facts = blocks.filter(block => block.claimClass === 'factual');
  const body = [bundle?.document?.title, ...blocks.map(block => articleBlockText(block))].join('\n');
  const instrument = research?.instrument;
  const used = claim => facts.filter(block => block.claimIds?.includes(claim.claimId));
  return finish({
    marketFormat: isMarketAnalysisArticle(job),
    marketPublicationScope: job?.blogId === MARKET_ANALYSIS_SCOPE.blogId && bundle?.document?.blogId === job.blogId && (
      job?.target?.type === 'create' && !job.target.logNo && !bundle?.document?.logNo && job.inputProvider === 'headless_sdk' ||
      job?.target?.type === 'update' && String(job.target.logNo) === MARKET_ANALYSIS_SCOPE.existingLogNo && String(bundle?.document?.logNo) === MARKET_ANALYSIS_SCOPE.existingLogNo && job.inputProvider === 'independent_http'
    ) && job.executionMode === 'independent_http' && job?.publishSettings?.visibility === 'public' && job.publishSettings.timing === 'current' && job.publishSettings.searchAllowed === true,
    marketTopic: research?.schemaVersion === 1 && research.topicKey === MARKET_ANALYSIS_SCOPE.topicKey,
    marketCategory: Number.isInteger(MARKET_ANALYSIS_SCOPE.categoryId) && research?.category?.id === MARKET_ANALYSIS_SCOPE.categoryId && research.category.name === MARKET_ANALYSIS_SCOPE.categoryName && job?.publishSettings?.categoryId === research.category.id && job.publishSettings.categoryName === research.category.name,
    marketSnapshotBound: fingerprint(job?.researchSnapshot ?? null) === fingerprint(research ?? null),
    marketNoCommerce: job?.affiliate == null && job?.commercialSnapshot == null && Array.isArray(bundle?.products) && bundle.products.length === 0 && !/제휴.*수수료|쿠팡\s*파트너스|가입\s*코드|추천인\s*코드/.test(body),
    marketInstrument: instrument?.asset === 'BTC' && instrument.exchange === 'Coinbase Exchange' && instrument.market === 'BTC-USD' && instrument.currency === 'USD',
    marketFresh: research?.temporalBasis === 'dated_snapshot' && recent(research?.checkedAt, now, 1440) && (/실시간\s*시세(?:가|는)?\s*아(?:니|닙)/.test(body) || blocks.some(block => /당시\s*시장\s*기록|시점의?\s*(?:시장\s*)?스냅샷|관측\s*시점의\s*기록/.test(articleBlockText(block)) && claims.some(claim => claim.claimType === 'observed_price') && claims.filter(claim => claim.claimType === 'observed_price').every(claim => Number.isFinite(Date.parse(claim.asOf)) && body.includes(marketAsOfLabel(claim.asOf))))) && !/실시간\s*현재가|지금\s*현재\s*가격/.test(body),
    marketSources: sources.length >= 2 && new Set(sources.map(source => source.id)).size === sources.length && sources.every(source => sourceContract(source, now)) && sources.some(source => source.sourceKind === 'exchange_data'),
    marketSourceLedgerBound: sources.every(source => {const evidence = bundle?.claimLedger?.evidence?.[source.id]; return evidence && ['url', 'checkedAt', 'evidenceFile', 'sha256'].every(key => evidence[key] === source[key]);}) && Object.keys(bundle?.claimLedger?.evidence || {}).every(id => sourceMap.has(id)),
    marketDatasetSchema: datasets.length > 0 && new Set(datasets.map(dataset => dataset.id)).size === datasets.length && datasets.every(dataset => text(dataset.id) && sourceMap.get(dataset.sourceId)?.sourceKind === 'exchange_data' &&
      [3600, 86400].includes(dataset.intervalSeconds) && typeof dataset.recordPointer === 'string' && dataset.timeUnit === 'seconds' && fields.every(field => Number.isInteger(dataset.fields?.[field]) || typeof dataset.fields?.[field] === 'string') &&
      granularity(sourceMap.get(dataset.sourceId).url) === dataset.intervalSeconds &&
      Array.isArray(dataset.rows) && dataset.rows.length >= 2 && dataset.rows.every((row, index) => Number.isInteger(row.time) && fields.slice(1).every(field => numeric(row[field])) && row.low > 0 && row.volume >= 0 && row.low <= Math.min(row.open, row.close) && row.high >= Math.max(row.open, row.close) &&
        row.time + dataset.intervalSeconds <= Date.parse(sourceMap.get(dataset.sourceId).checkedAt) / 1000 && (!index || row.time - dataset.rows[index - 1].time === dataset.intervalSeconds))),
    marketChartSchema: charts.length >= MARKET_ANALYSIS_SCOPE.minCharts && new Set(charts.map(chart => chart.id)).size === charts.length && new Set(charts.map(chart => `${chart.datasetId}:${chart.kind}:${chart.window}`)).size === charts.length && charts.every(chart => text(chart.id) && datasetMap.has(chart.datasetId) && ['close', 'volume', 'candlestick'].includes(chart.kind) && Number.isInteger(chart.window) && chart.window > 1 && chart.window <= datasetMap.get(chart.datasetId).rows.length && Array.isArray(chart.smaWindows) && chart.smaWindows.every(window => Number.isInteger(window) && window > 1 && window <= datasetMap.get(chart.datasetId).rows.length) && hash(chart.imageSha256) && text(chart.dataFile) && hash(chart.dataSha256) && text(chart.rendererFile) && hash(chart.rendererSha256)),
    marketClaimTypes: claims.length > 0 && claims.every(claim => ['observed_price', 'market_observation', 'causal_hypothesis', 'creator_method', 'uncertainty'].includes(claim.claimType)),
    marketClaimsBound: claims.filter(claim => claim.publishable === true).every(claim => claim.sources?.length > 0 && used(claim).length > 0 && claim.sources.every(sourceId => bindings.some(binding => binding.claimId === claim.claimId && (binding.sourceId === sourceId || datasetMap.get(binding.datasetId)?.sourceId === sourceId)))),
    marketBindingsResolve: bindings.length > 0 && bindings.every(binding => bindingContract(binding) && claims.some(claim => claim.claimId === binding.claimId && claim.sources?.includes(binding.sourceId || datasetMap.get(binding.datasetId)?.sourceId)) && (sourceMap.has(binding.sourceId) || datasetMap.has(binding.datasetId))),
    marketObservedPriceFresh: claims.some(claim => claim.claimType === 'observed_price') && claims.filter(claim => claim.claimType === 'observed_price').every(claim => recent(claim.asOf, now, 1440) && Number.isFinite(Date.parse(claim.expiresAt)) && Date.parse(claim.expiresAt) >= now.getTime() && Date.parse(claim.expiresAt) <= Date.parse(claim.asOf) + 1440 * 60000 &&
      bindings.some(binding => binding.claimId === claim.claimId && typeof binding.pointer === 'string' && numeric(binding.value) && binding.value > 0 && sourceMap.get(binding.sourceId)?.sourceKind === 'exchange_data' && sourceMap.get(binding.sourceId)?.checkedAt === claim.asOf)),
    marketContextVisible: [instrument?.exchange, instrument?.market, instrument?.currency].every(value => text(value) && body.includes(value)) && claims.filter(claim => claim.claimType === 'observed_price').every(claim => recent(claim.asOf, now, 1440) && body.includes(marketAsOfLabel(claim.asOf))),
    marketHypothesesLabeled: claims.filter(claim => claim.claimType === 'causal_hypothesis').every(claim => used(claim).every(block => /가설|가능성|추정|해석/.test(articleBlockText(block)) && !/때문이다|원인이다|확실하다|입증됐다/.test(articleBlockText(block)))),
    marketReturnPeriodsVisible: bindings.filter(binding => sourceMap.get(binding.sourceId)?.url === 'https://api.exchange.coinbase.com/products/BTC-USD/stats' && binding.operation === 'endpoint_change').every(binding =>
      binding.startPointer === '/open' && binding.endPointer === '/last' && claims.find(claim => claim.claimId === binding.claimId)?.interval === 'rolling_24h' && facts.some(block => block.claimIds?.includes(binding.claimId) && /24\s*시간/.test(articleBlockText(block)))) &&
      bindings.filter(binding => /signed_change_rate$/.test(binding.pointer || '')).every(binding => claims.find(claim => claim.claimId === binding.claimId)?.interval === 'previous_close' && facts.some(block => block.claimIds?.includes(binding.claimId) && /전일/.test(articleBlockText(block)))),
    marketCreatorIdentityDeclared: !sources.some(source => source.sourceKind === 'creator_original') || text(research?.identityEvidence?.evidenceFile) && hash(research?.identityEvidence?.sha256) && research.identityEvidence.evidenceMethod === 'youtube_native_dom_observation' && research.identityEvidence.status === null && research.identityEvidence.acquisitionStatus === 'observed',
    marketCreatorVisualEvidenceDeclared: !research?.creatorVisualEvidence && !bindings.some(binding => binding.visualObservationId) ||
      !!text(research?.creatorVisualEvidence?.evidenceFile) && hash(research?.creatorVisualEvidence?.sha256) && bindings.filter(binding => binding.visualObservationId).every(binding => sourceMap.get(binding.sourceId)?.sourceKind === 'creator_original'),
    marketCreatorAttribution: claims.filter(claim => claim.claimType === 'creator_method').every(claim => {const attribution = claim.attribution, source = sourceMap.get(attribution?.sourceId); return source?.sourceKind === 'creator_original' && attribution.creator === source.creator && attribution.publishedAt === source.publishedAt && claim.sources?.includes(source.id) && used(claim).every(block => articleBlockText(block).includes(source.creator) && /과거|원문|방법|당시/.test(articleBlockText(block)));}),
    marketNoPromisesOrOrders: !/수익\s*보장|원금\s*보장|반드시\s*(?:상승|수익)|무조건\s*(?:오른|상승|매수)|지금\s*(?:매수|매도)\s*(?:하세|하라)|레버리지.{0,15}진입\s*(?:하세|하라)|완브로.{0,12}(?:오늘|지금|현재).{0,12}(?:추천|매수|매도)/.test(body),
    marketLinks: links.length >= 2 && [...blocks, ...(job?.bodyBlocks || job?.blocks || [])].every(block => !block.href && (!['link', 'oglink'].includes(block.type) || block.type === 'link' && block.display === 'label' && text(block.label).length >= 4 && sourceUrls.has(block.url))),
    marketNoRawUrls: blocks.filter(block => ['paragraph', 'notice', 'heading', 'quote', 'list', 'numbered', 'table'].includes(block.type)).every(block => !/https?:\/\//i.test(articleBlockText(block))),
    marketIndependentReview: bundle?.qualityReview?.reviewerRole === 'independent_verifier' && ['separate_agent', 'human'].includes(bundle?.qualityReview?.provenance?.method),
    marketEditorialChecks: ['marketDataAccuracy', 'chartsMatchData', 'factsVsHypotheses', 'creatorAttribution', 'noPersonalizedTradeInstructions'].every(key => bundle?.qualityReview?.checks?.[key] === true),
  });
}

function pointer(value, location) {
  if (Number.isInteger(location)) location = `/${location}`;
  if (location === '') return value;
  if (typeof location !== 'string' || !location.startsWith('/')) throw Error('MARKET_POINTER_INVALID');
  for (const part of location.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('MARKET_POINTER_UNRESOLVED');
    value = value[key];
  }
  return value;
}
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
function sourceNumber(value) {
  if (!(typeof value === 'number' || typeof value === 'string' && value.trim()) || !Number.isFinite(Number(value))) throw Error('MARKET_NUMBER_REQUIRED');
  return Number(value);
}

export function normalizeMarketRows(original, dataset, checkedAt) {
  const records = pointer(original, dataset.recordPointer);
  if (!Array.isArray(records)) throw Error('MARKET_ROWS_REQUIRED');
  return records.map(record => {
    const time = pointer(record, dataset.fields.time);
    return {time: sourceNumber(time), ...Object.fromEntries(fields.slice(1).map(field => [field, sourceNumber(pointer(record, dataset.fields[field]))]))};
  }).filter(row => (row.time + dataset.intervalSeconds) * 1000 <= Date.parse(checkedAt)).sort((a, b) => a.time - b.time);
}

export function marketChartData(dataset, chart) {
  if (!['close', 'volume', 'candlestick'].includes(chart.kind) || !Number.isInteger(chart.window) || chart.window < 2 || chart.window > dataset.rows.length || !Array.isArray(chart.smaWindows) || chart.smaWindows.some(window => !Number.isInteger(window) || window < 2 || window > dataset.rows.length)) throw Error('MARKET_CHART_OPTIONS');
  if (chart.kind === 'candlestick' && dataset.rows.some((row, index) => !Number.isInteger(row.time) || fields.slice(1).some(field => !numeric(row[field])) ||
    row.low <= 0 || row.volume < 0 || row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) || index > 0 && row.time <= dataset.rows[index - 1].time)) throw Error('MARKET_CANDLE_INVALID');
  const valueField = chart.kind === 'candlestick' ? 'close' : chart.kind;
  const points = dataset.rows.map((row, index) => ({time: row.time,
    ...(chart.kind === 'candlestick' ? Object.fromEntries(fields.slice(1).map(field => [field, row[field]])) : {value: row[valueField]}),
    ...Object.fromEntries(chart.smaWindows.map(window => [`sma${window}`, index + 1 < window ? null : Number((dataset.rows.slice(index + 1 - window, index + 1).reduce((sum, entry) => sum + entry[valueField], 0) / window).toFixed(8))]))})).slice(-chart.window);
  return {datasetId: dataset.id, kind: chart.kind, window: chart.window, smaWindows: chart.smaWindows, points};
}

export function calculateMarketMetric(dataset, binding) {
  const rows = binding.window == null ? dataset.rows : dataset.rows.slice(-binding.window);
  if (!rows.length || binding.window != null && (!Number.isInteger(binding.window) || binding.window < 1 || binding.window > dataset.rows.length)) throw Error('MARKET_METRIC_WINDOW');
  if (!['close', 'volume'].includes(binding.field)) throw Error('MARKET_METRIC_FIELD');
  const close = rows.map(row => row[binding.field]);
  const values = {
    last: () => close.at(-1), endpoint_change: () => (close.at(-1) / close[0] - 1) * 100,
    sma: () => close.reduce((sum, value) => sum + value, 0) / close.length,
  };
  if (!Object.hasOwn(values, binding.operation) || !Number.isInteger(binding.decimals) || binding.decimals < 0 || binding.decimals > 8) throw Error('MARKET_METRIC_OPERATION');
  return Number(values[binding.operation]().toFixed(binding.decimals));
}

export async function verifyMarketAnalysisEvidence(bundle, {read} = {}) {
  const research = bundle?.research, checks = {}, raw = new Map(), parsed = new Map(), datasets = new Map();
  let visualEvidence;
  for (const source of sourcesOf(bundle)) {
    try {
      const original = (await read(source.evidenceFile, source.sha256)).toString('utf8');
      raw.set(source.id, [original]);
      try {const json = JSON.parse(original); parsed.set(source.id, json); raw.get(source.id).push(...strings(json));} catch {}
      checks[`marketSource_${source.id}`] = true;
    } catch { checks[`marketSource_${source.id}`] = false; }
  }
  for (const dataset of research?.datasets || []) {
    try {
      const source = sourcesOf(bundle).find(item => item.id === dataset.sourceId);
      const rows = normalizeMarketRows(parsed.get(dataset.sourceId), dataset, source.checkedAt);
      checks[`marketDataset_${dataset.id}`] = fingerprint(rows) === fingerprint(dataset.rows);
      if (checks[`marketDataset_${dataset.id}`]) datasets.set(dataset.id, dataset);
    } catch { checks[`marketDataset_${dataset.id}`] = false; }
  }
  if (research?.creatorVisualEvidence || research?.claimBindings?.some(binding => binding.visualObservationId)) {
    try {
      const reference = research.creatorVisualEvidence;
      const manifest = JSON.parse((await read(reference.evidenceFile, reference.sha256)).toString('utf8'));
      const frames = manifest.frames, observations = manifest.observations;
      if (manifest.schemaVersion !== 1 || manifest.evidenceMethod !== 'youtube_paused_frame_review' || !Number.isFinite(Date.parse(manifest.checkedAt)) ||
        !Array.isArray(frames) || !frames.length || new Set(frames.map(frame => frame.id)).size !== frames.length ||
        !Array.isArray(observations) || !observations.length || new Set(observations.map(observation => observation.id)).size !== observations.length)
        throw Error('MARKET_VISUAL_MANIFEST_INVALID');
      for (const frame of frames) {
        if (!text(frame.id) || !sourcesOf(bundle).some(source => source.id === frame.sourceId && source.sourceKind === 'creator_original') ||
          !numeric(frame.timeSeconds) || frame.timeSeconds < 0 || frame.paused !== true || frame.readyState !== 4 || !text(frame.imageFile) || !hash(frame.imageSha256))
          throw Error('MARKET_VISUAL_FRAME_INVALID');
        const bytes = await read(frame.imageFile, frame.imageSha256);
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
        if (!png && !jpeg) throw Error('MARKET_VISUAL_IMAGE_REQUIRED');
      }
      if (!observations.every(observation => text(observation.id) && text(observation.observed).length >= 12 && Array.isArray(observation.frameIds) && observation.frameIds.length > 0 &&
        observation.frameIds.every(id => frames.some(frame => frame.id === id && frame.sourceId === observation.sourceId)))) throw Error('MARKET_VISUAL_OBSERVATION_INVALID');
      visualEvidence = manifest;
      checks.marketCreatorVisualEvidenceVerified = true;
    } catch { checks.marketCreatorVisualEvidenceVerified = false; }
  }
  for (const [index, binding] of (research?.claimBindings || []).entries()) {
    try {
      checks[`marketBinding_${index}`] = binding.visualObservationId
        ? visualEvidence?.observations.some(observation => observation.id === binding.visualObservationId && observation.sourceId === binding.sourceId && text(binding.excerpt).length >= 12 && text(observation.observed).includes(text(binding.excerpt))) === true
        : binding.datasetId
        ? calculateMarketMetric(datasets.get(binding.datasetId), binding) === binding.value
        : binding.operation === 'sum_displayed_table_totals'
          ? sourcesOf(bundle).find(source => source.id === binding.sourceId)?.url === 'https://farside.co.uk/btc/' && binding.terms.every(term => raw.get(binding.sourceId)?.some(value => text(value).includes(text(term.excerpt))) &&
              Number(text(term.excerpt).split('|').at(-1).trim().replace(/^\((.+)\)$/, '-$1').replaceAll(',', '')) === term.value) && Number(binding.terms.reduce((sum, term) => sum + term.value, 0).toFixed(binding.decimals)) === binding.value
        : binding.operation === 'endpoint_change'
          ? Number(((sourceNumber(pointer(parsed.get(binding.sourceId), binding.endPointer)) / sourceNumber(pointer(parsed.get(binding.sourceId), binding.startPointer)) - 1) * 100).toFixed(binding.decimals)) === binding.value
        : typeof binding.pointer === 'string'
          ? (binding.decimals == null ? sourceNumber(pointer(parsed.get(binding.sourceId), binding.pointer)) * (binding.multiplier ?? 1) : Number((sourceNumber(pointer(parsed.get(binding.sourceId), binding.pointer)) * (binding.multiplier ?? 1)).toFixed(binding.decimals))) === binding.value
          : text(binding.locator).length >= 3 && text(binding.excerpt).length >= 12 && raw.get(binding.sourceId)?.some(value => text(value).includes(text(binding.excerpt))) === true;
    } catch { checks[`marketBinding_${index}`] = false; }
  }
  const creatorSources = sourcesOf(bundle).filter(source => source.sourceKind === 'creator_original');
  if (creatorSources.length) {
    try {
      const identity = research.identityEvidence;
      const original = JSON.parse((await read(identity.evidenceFile, identity.sha256)).toString('utf8'));
      checks.marketCreatorIdentityVerified = original.channel?.channelId === 'UCQlIPwduvaV6Tjt24IyDJbQ' && creatorSources.every(source => original.videos?.some(video => video.url === source.url && video.publishedAt === source.publishedAt && video.checkedAt === source.checkedAt));
    } catch { checks.marketCreatorIdentityVerified = false; }
  }
  for (const chart of research?.charts || []) {
    try {
      const bytes = await read(chart.dataFile, chart.dataSha256);
      await read(chart.rendererFile, chart.rendererSha256);
      const image = blocksOf(bundle).find(block => block.type === 'image' && block.chartId === chart.id);
      await read(image.file, chart.imageSha256);
      checks[`marketChart_${chart.id}`] = fingerprint(JSON.parse(bytes.toString('utf8'))) === fingerprint(marketChartData(datasets.get(chart.datasetId), chart));
    } catch { checks[`marketChart_${chart.id}`] = false; }
  }
  checks.marketEvidencePresent = raw.size >= 2 && datasets.size > 0 && (research?.charts?.length || 0) >= MARKET_ANALYSIS_SCOPE.minCharts;
  return finish(checks);
}

export function marketAnalysisReadbackChecks(job, observation) {
  const blocks = blocksOf(job?.publicationBundle), links = blocks.filter(block => block.type === 'link').map(block => block.url);
  return {
    marketNoticeFirst: marketNoticeValid(blocks[0]?.text) && text(observation?.units?.[0]?.value) === text(blocks[0].text),
    marketSourceLinksClickable: links.length >= 2 && links.every(url => observation?.links?.includes(url)),
    marketNoUnplannedLinks: (observation?.links || []).every(url => links.includes(url)),
    marketChartsUnlinked: (observation?.units || []).filter(unit => unit.type === 'image').every(unit => !unit.href),
  };
}
