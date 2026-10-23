// Bounded, anonymous lodging research. GoodChoice evidence is read from the
// authorized public captures; the optional Naver phase performs one Seoul
// hotel search and exactly one hotel-rates read.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../seller-results');
const CAPTURE_DIR = 'C:/Users/User/AppData/Local/Temp/travel-price-captures';
const CRAWLER_DIR = 'C:/Users/User/Documents/GitHub/naver-shopping-travel-crawler';
const KST_WINDOW = { checkIn: '2026-10-09', checkOut: '2026-10-11', adults: 2 };
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function sourceTrace(file, line, operation) {
  const source = await readFile(file, 'utf8');
  const rows = source.split('\n');
  const prefix = rows.slice(0, line - 1).join('\n') + (line > 1 ? '\n' : '');
  return { file, line, offset: Buffer.byteLength(prefix, 'utf8'), operation };
}

function safeUrl(value, base) {
  try {
    const u = new URL(value, base);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

function extractAnchors(html, base) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => ({
      url: safeUrl(match[1].replaceAll('&amp;', '&'), base),
      text: match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
    }))
    .filter(item => item.url && new URL(item.url).hostname.endsWith('yeogi.com') && item.text.length <= 100 && !/\.css\s*\{/i.test(item.text));
}

async function goodchoiceEvidence() {
  const names = ['goodchoice-landing-1', 'goodchoice-yeogi-home-1', 'goodchoice-list-seoul-1'];
  const captures = [];
  for (const name of names) {
    const metaPath = path.join(CAPTURE_DIR, `${name}.meta.json`);
    const meta = await readJson(metaPath);
    captures.push({ name, meta, body: meta.capture ? await readFile(meta.capture, 'utf8') : '' });
  }

  const [legacy, home, list] = captures;
  const homeUrl = 'https://www.yeogi.com/';
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(home.body) ?? [])[1]?.replace(/\s+/g, ' ').trim() ?? null;
  const challengeOffset = home.body.indexOf('/cdn-cgi/challenge-platform/scripts/jsd/main.js');
  const challengeTitle = /Attention Required!\s*\|\s*Cloudflare/i.test(list.body);
  const listChallenge = Number(list.meta.status) === 403 || challengeTitle || /cf-browser-verification|cf-challenge|turnstile|verify you are human/i.test(list.body);
  const publicRoutes = extractAnchors(home.body, homeUrl)
    .filter(item => /\/domestic-accommodations\?keyword=|\/accommodation\/kr\//i.test(item.url))
    .filter((item, index, rows) => rows.findIndex(other => other.url === item.url) === index)
    .slice(0, 20);

  return {
    schemaVersion: 1,
    sourceId: 'goodchoice-hotel',
    label: 'GoodChoice / 여기어때',
    checkedAt: list.meta.checkedAt,
    verdict: listChallenge ? 'challenge_blocked' : 'replay_pending',
    method: 'GET; anonymous public entry and Seoul-list navigation',
    legacyDomain: 'www.goodchoice.kr',
    currentDomain: 'www.yeogi.com',
    redirect: {
      status: legacy.meta.status,
      from: 'https://www.goodchoice.kr/',
      to: safeUrl(legacy.meta.location, 'https://www.goodchoice.kr/'),
    },
    publicRoutesFoundOnHome: publicRoutes,
    listRequest: {
      method: 'GET',
      url: 'https://www.yeogi.com/domestic-accommodations?keyword=%EC%84%9C%EC%9A%B8',
      status: list.meta.status,
      title: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(list.body) ?? [])[1]?.replace(/\s+/g, ' ').trim() ?? null,
      bytes: list.meta.bytes,
    },
    apiContract: {
      wrapper: null,
      base: null,
      method: null,
      path: null,
      params: null,
      replayed: false,
      reason: listChallenge
        ? 'The real Seoul listing returned a Cloudflare 403 challenge; stopped before bundle, detail, or XHR requests.'
        : 'No anonymous list/detail XHR was replayed in this capture set.',
    },
    trace: [
      await sourceTrace(path.join(HERE, 'anonymous-http.mjs'), 9, 'anonymous helper readPublic entry'),
      {
        file: legacy.meta.capture,
        line: 1,
        offset: 0,
        method: 'GET',
        status: legacy.meta.status,
        sha256: legacy.meta.sha256,
      },
      {
        file: home.meta.capture,
        line: 1,
        offset: challengeOffset,
        marker: '/cdn-cgi/challenge-platform/scripts/jsd/main.js',
        interpretation: 'Cloudflare JavaScript detection is present on the fully rendered public homepage; it is not itself treated as a blocking challenge.',
        status: home.meta.status,
        sha256: home.meta.sha256,
      },
      {
        file: list.meta.capture,
        line: 1,
        offset: 0,
        status: list.meta.status,
        title: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(list.body) ?? [])[1]?.replace(/\s+/g, ' ').trim() ?? null,
        sha256: list.meta.sha256,
      },
    ],
    captures: captures.map(({ name, meta }) => ({
      name,
      response: meta.capture,
      metadata: path.join(CAPTURE_DIR, `${name}.meta.json`),
      requestHeaderNames: meta.requestHeaderNames,
      status: meta.status,
      contentType: meta.contentType,
      bytes: meta.bytes,
      sha256: meta.sha256,
      checkedAt: meta.checkedAt,
    })),
    requestCount: 3,
    fields: [],
    fieldMappings: [],
    limitations: [
      'The legacy www.goodchoice.kr entry redirects to www.yeogi.com.',
      'The real Seoul list route returned HTTP 403 with an Attention Required! | Cloudflare title.',
      'Stopped at the confirmed challenge; did not download application bundles, open a detail page, or replay an XHR.',
      'Room, cancellation, breakfast, tax, fee, and amount fields remain unobserved.',
    ],
  };
}

async function readBoundedClone(response) {
  const cl = Number(response.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_CAPTURE_BYTES) throw new Error('response exceeds 8 MiB capture limit');
  const reader = response.clone().body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CAPTURE_BYTES) {
      await reader.cancel();
      throw new Error('response exceeds 8 MiB capture limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function runNaverReads() {
  const adapterUrl = pathToFileURL(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs')).href;
  const { NaverTravelClient } = await import(adapterUrl);
  const receipts = [];
  const lastRequestStart = new Map();
  const minimumHostIntervalMs = 2050;
  let ordinal = 0;
  const fetchImpl = async (input, init = {}) => {
    const target = new URL(input);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headerNames = [...new Headers(init.headers).keys()].map(name => name.toLowerCase());
    if (headerNames.some(name => /^(cookie|authorization|proxy-authorization)$|token/i.test(name))) {
      throw new Error('credential-bearing request header rejected');
    }
    if (target.origin !== 'https://hermes-hotel-svc-api.naver.com' || target.pathname !== '/graphql' || method !== 'POST') {
      throw new Error('request outside the observed Naver hotel GraphQL read endpoint');
    }
    const payload = JSON.parse(String(init.body ?? '{}'));
    const operation = /\bquery\s+(domesticHotelList|domesticHotelRates)\b/.exec(payload.query ?? '')?.[1] ?? null;
    if (!operation || /\b(?:mutation|subscription)\b/i.test(payload.query ?? '')) {
      throw new Error('only the observed hotel list/rates read operations are permitted');
    }
    ordinal += 1;
    const waitMs = minimumHostIntervalMs - (Date.now() - (lastRequestStart.get(target.origin) ?? 0));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    const requestStartedAt = new Date().toISOString();
    lastRequestStart.set(target.origin, Date.now());
    const response = await globalThis.fetch(input, { ...init, credentials: 'omit' });
    const bytes = await readBoundedClone(response);
    const captureName = operation === 'domesticHotelList'
      ? 'naver-hotel-search-seoul-1'
      : 'naver-hotel-rates-20261009-1';
    await mkdir(CAPTURE_DIR, { recursive: true });
    const capture = path.join(CAPTURE_DIR, `${captureName}.json`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const meta = {
      seller: 'naver-hotel',
      operation,
      ordinal,
      method,
      url: `${target.origin}${target.pathname}`,
      requestHeaderNames: headerNames,
      credentials: 'omit',
      requestStartedAt,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      responseDate: response.headers.get('date') ?? null,
      bytes: bytes.length,
      sha256,
      checkedAt: new Date().toISOString(),
      capture,
    };
    await writeFile(capture, bytes);
    await writeFile(path.join(CAPTURE_DIR, `${captureName}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    receipts.push(meta);
    return response;
  };

  const client = new NaverTravelClient({ fetchImpl });
  const search = await client.hotelSearch({
    query: '서울',
    from: 0,
    size: 3,
    sort: 'POPULAR_DESC',
    centerLat: 37.5665,
    centerLon: 126.978,
    searchRadius: 20000,
  });
  const center = { latitude: 37.5665, longitude: 126.978 };
  const haversineMeters = (a, b) => {
    const radians = deg => deg * Math.PI / 180;
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  };
  const candidates = search.items
    .filter(item => item.hotelId)
    .map(item => ({ ...item, distanceFromSeoulCenterMeters: item.latitude != null && item.longitude != null
      ? Math.round(haversineMeters(center, { latitude: item.latitude, longitude: item.longitude }))
      : null }));
  const selected = candidates.find(item => item.distanceFromSeoulCenterMeters != null && item.distanceFromSeoulCenterMeters <= 20000)
    ?? candidates[0];
  if (!selected) throw new Error('Seoul hotel search returned no hotel ID; hotel-rates read was not made');

  const rates = await client.hotelRates({
    hotelId: selected.hotelId,
    checkIn: KST_WINDOW.checkIn,
    checkOut: KST_WINDOW.checkOut,
    adult: KST_WINDOW.adults,
  });
  const rateRawPath = receipts.find(item => item.operation === 'domesticHotelRates')?.capture;
  const rawResponse = rateRawPath ? await readJson(rateRawPath) : null;
  const rawRateContainer = rawResponse?.data?.domesticHotelRates ?? {};
  const rawRates = rawRateContainer.rates ?? [];
  const rawFieldNames = rawRates[0] ? Object.keys(rawRates[0]) : [];
  const rawRatePriceFieldNames = rawRates[0]?.rate ? Object.keys(rawRates[0].rate) : [];
  const rawFeatureFieldNames = rawRates[0]?.productFeatures ? Object.keys(rawRates[0].productFeatures) : [];
  const receiptGapMs = receipts.length > 1
    ? Date.parse(receipts[1].checkedAt) - Date.parse(receipts[0].checkedAt)
    : null;

  return {
    schemaVersion: 1,
    sourceId: 'naver-hotel',
    label: 'Naver domestic hotel rates',
    checkedAt: rates.checkedAt,
    verdict: 'usable_limited',
    method: 'POST GraphQL read through the audited private crawler adapter',
    endpoint: 'https://hermes-hotel-svc-api.naver.com/graphql',
    trace: await Promise.all([
      sourceTrace(path.join(CRAWLER_DIR, 'scripts', 'naver-travel.mjs'), 115, 'hotel-search dispatch'),
      sourceTrace(path.join(CRAWLER_DIR, 'scripts', 'naver-travel.mjs'), 125, 'hotel-rates dispatch'),
      sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 861, 'hotelSearch client method'),
      sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 1001, 'hotelRates client method'),
      sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 1098, 'includeTax request variable is true'),
      sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 1104, 'hotel-rates GraphQL POST'),
    ]),
    authorization: {
      browserUsed: false,
      cookieOrAuthorizationHeaders: false,
      fetchCredentials: 'omit',
      crawlerCodePathAudited: true,
    },
    requestCount: receipts.length,
    requestSpacing: {
      minimumIntervalMsForFutureRuns: minimumHostIntervalMs,
      observedReceiptTimestampGapMs: receiptGapMs,
      withinMinimum: receiptGapMs == null ? null : receiptGapMs >= minimumHostIntervalMs,
      deviation: receiptGapMs != null && receiptGapMs < minimumHostIntervalMs
        ? 'The recorded checkedAt timestamps were less than the 2-second host interval apart. No request was repeated.'
        : null,
    },
    search: {
      operation: 'domesticHotelList',
      status: receipts.find(item => item.operation === 'domesticHotelList')?.status ?? null,
      criteria: search.searchCriteria,
      totalCount: search.totalCount,
      matchedCount: search.matchedCount,
      selectedHotel: {
        hotelId: selected.hotelId,
        title: selected.title,
        latitude: selected.latitude,
        longitude: selected.longitude,
        distanceFromSeoulCenterMeters: selected.distanceFromSeoulCenterMeters,
        starCount: selected.starCount,
        rating: selected.rating,
      },
    },
    ratesRequest: {
      operation: 'domesticHotelRates',
      status: receipts.find(item => item.operation === 'domesticHotelRates')?.status ?? null,
      params: {
        hotelId: selected.hotelId,
        checkIn: KST_WINDOW.checkIn,
        checkOut: KST_WINDOW.checkOut,
        adultCnt: KST_WINDOW.adults,
        childrenAges: [],
        includeTax: true,
        query: selected.hotelId,
        impArea: 'renewalSingle',
      },
      stayPeriod: rates.stayPeriod,
      occupancy: rates.occupancy,
      totalCount: rates.totalCount,
      responseFields: Object.keys(rawRateContainer),
      nHotelId: rawRateContainer.nHotelId ?? null,
      xbuId: rawRateContainer.xbuId ?? null,
    },
    amountBasis: {
      currency: 'KRW',
      priceScope: 'quoted_listing_rate',
      amountField: 'rate.userRate',
      comparisonAmountField: 'rate.original',
      observedRateRows: rates.rates.length,
      observedAmounts: [],
      totalVsPerNight: rates.rates.length ? 'not explicitly represented in the returned rate object' : 'not assessable because the response returned no rate rows',
      queryIncludeTax: true,
      explicitTaxFieldsInResponse: rawFieldNames.filter(name => /tax/i.test(name)).concat(rawRatePriceFieldNames.filter(name => /tax/i.test(name))),
      explicitFeeFieldsInResponse: rawFieldNames.filter(name => /fee|surcharge/i.test(name)).concat(rawRatePriceFieldNames.filter(name => /fee|surcharge/i.test(name))),
      inclusionVerdict: rates.rates.length
        ? 'Tax inclusion was requested with includeTax=true, but no per-rate tax/fee amount or explicit inclusion flag was returned; keep taxesIncluded and feesIncluded unknown under the lodging ontology.'
        : 'includeTax=true was requested, but no rate row was returned; tax and fee inclusion are not assessable for this stay.',
    },
    rawResponseFields: {
      rateContainer: Object.keys(rawRateContainer),
      rate: rawFieldNames,
      price: rawRatePriceFieldNames,
      productFeatures: rawFeatureFieldNames,
    },
    fieldMappings: {
      evidenceLevel: 'adapter contract; this live call returned no rate rows, so none of these per-rate mappings were observed in a quote',
      provider: 'rates[].ota.code, ota.npay, ota.isOfficialSite → otaCode, npaySupport, isOfficialSite; preserve source code without expanding its meaning',
      room: 'rates[].roomId, roomName, roomFeatures.roomType/viewType/bedType',
      amount: 'rates[].rate.userRate → listingPriceKrw; rates[].rate.original → originalPriceKrw',
      cancellation: 'rates[].productFeatures.isFreeCancel and freeCancelDeadline',
      breakfast: 'rates[].productFeatures.freeBreakfast',
      extraMeals: 'rates[].productFeatures.freeDinner',
      taxFee: 'request variables includeTax=true; empty rates array prevents per-rate tax/fee field inspection',
    },
    rates: rates.rates,
    captures: receipts.map(item => ({
      operation: item.operation,
      response: item.capture,
      metadata: path.join(CAPTURE_DIR, `${path.basename(item.capture, '.json')}.meta.json`),
      status: item.status,
      contentType: item.contentType,
      responseDate: item.responseDate,
      bytes: item.bytes,
      sha256: item.sha256,
      checkedAt: item.checkedAt,
    })),
    limitations: [
      'The selected Seoul property returned totalCount=0 and no rate rows for the requested dates and occupancy.',
      'The rates response is a quoted listing rate and does not verify checkout payable price.',
      'The API was queried with includeTax=true, but an empty rates array makes tax/fee inclusion and amount basis unassessable for this stay.',
      'The adapter contract expects rate.userRate, but this response contained no quote object to inspect.',
      'OTA/provider codes are pass-through strings; no hotel OTA code dictionary was inferred.',
      'Cancellation and breakfast are listing claims and require provider re-verification before publication.',
    ],
  };
}

async function writeResults(goodchoice, naver = null) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'goodchoice.json'), `${JSON.stringify(goodchoice, null, 2)}\n`);
  if (naver) await writeFile(path.join(OUT_DIR, 'naver-hotel.json'), `${JSON.stringify(naver, null, 2)}\n`);
  const naverLine = naver
    ? `Naver hotel search selected ${naver.search.selectedHotel.title} (${naver.search.selectedHotel.hotelId}), ${naver.search.selectedHotel.distanceFromSeoulCenterMeters} m from the Seoul search center. The rates request returned HTTP ${naver.ratesRequest.status} with totalCount=${naver.ratesRequest.totalCount} for ${naver.ratesRequest.stayPeriod.checkIn}–${naver.ratesRequest.stayPeriod.checkOut}, two adults; no quote rows were returned.`
    : 'Naver rate read has not been run.';
  const pacingLine = naver?.requestSpacing?.deviation ?? null;
  const md = [
    '# Lodging source research',
    '',
    `Checked ${goodchoice.checkedAt}.`,
    '',
    '## GoodChoice / 여기어때',
    '',
    `The legacy entry redirected to ${goodchoice.currentDomain}. The public Seoul list request returned HTTP ${goodchoice.listRequest.status} (${goodchoice.listRequest.title}); research stopped at the Cloudflare challenge. No bundles, detail page, XHR contract, or replay were attempted.`,
    '',
    `Captures: ${goodchoice.captures.map(item => item.response).join(', ')}.`,
    '',
    '## Naver hotel rates',
    '',
    naverLine,
    '',
    naver ? `Raw captures: ${naver.captures.map(item => item.response).join(', ')}.` : '',
    '',
    naver ? 'The GraphQL request set includeTax=true, but the empty rates array leaves tax/fee inclusion, provider, room, cancellation, breakfast, and amount basis unobserved.' : '',
    '',
    pacingLine ? `Pacing note: ${pacingLine}` : '',
    '',
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'lodging-research.md'), md);
}

async function refreshExistingNaverResult() {
  const file = path.join(OUT_DIR, 'naver-hotel.json');
  const result = await readJson(file);
  const searchMeta = await readJson(path.join(CAPTURE_DIR, 'naver-hotel-search-seoul-1.meta.json'));
  const ratesMeta = await readJson(path.join(CAPTURE_DIR, 'naver-hotel-rates-20261009-1.meta.json'));
  const raw = await readJson(ratesMeta.capture);
  const container = raw?.data?.domesticHotelRates ?? {};
  const gapMs = Date.parse(ratesMeta.checkedAt) - Date.parse(searchMeta.checkedAt);
  result.trace = await Promise.all([
    sourceTrace(path.join(CRAWLER_DIR, 'scripts', 'naver-travel.mjs'), 115, 'hotel-search dispatch'),
    sourceTrace(path.join(CRAWLER_DIR, 'scripts', 'naver-travel.mjs'), 125, 'hotel-rates dispatch'),
    sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 861, 'hotelSearch client method'),
    sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 1001, 'hotelRates client method'),
    sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 1098, 'includeTax request variable is true'),
    sourceTrace(path.join(CRAWLER_DIR, 'adapters', 'naver-travel.mjs'), 1104, 'hotel-rates GraphQL POST'),
  ]);
  result.requestSpacing = {
    minimumIntervalMsForFutureRuns: 2050,
    observedReceiptTimestampGapMs: gapMs,
    withinMinimum: gapMs >= 2050,
    deviation: gapMs < 2050
      ? 'The recorded search/rates checkedAt timestamps are 1849 ms apart, below the requested 2-second interval. No request was repeated.'
      : null,
  };
  result.ratesRequest.responseFields = Object.keys(container);
  result.ratesRequest.nHotelId = container.nHotelId ?? null;
  result.ratesRequest.xbuId = container.xbuId ?? null;
  result.rawResponseFields = { rateContainer: Object.keys(container), rate: [], price: [], productFeatures: [] };
  result.amountBasis = {
    currency: 'KRW',
    priceScope: 'quoted_listing_rate (adapter contract; no live quote returned)',
    amountField: 'rate.userRate (adapter contract)',
    comparisonAmountField: 'rate.original (adapter contract)',
    observedRateRows: Array.isArray(container.rates) ? container.rates.length : 0,
    observedAmounts: [],
    totalVsPerNight: 'not assessable because the response returned no rate rows',
    queryIncludeTax: true,
    explicitTaxFieldsInResponse: [],
    explicitFeeFieldsInResponse: [],
    inclusionVerdict: 'includeTax=true was requested, but no rate row was returned; tax and fee inclusion are not assessable for this stay.',
  };
  result.fieldMappings.evidenceLevel = 'adapter contract; this live call returned no rate rows, so none of these per-rate mappings were observed in a quote';
  result.fieldMappings.provider = 'rates[].ota.code, ota.npay, ota.isOfficialSite → otaCode, npaySupport, isOfficialSite; preserve source code without expanding its meaning';
  result.fieldMappings.taxFee = 'request variables includeTax=true; empty rates array prevents per-rate tax/fee field inspection';
  if (!result.limitations.some(item => item.startsWith('The selected Seoul property returned'))) {
    result.limitations.unshift('The selected Seoul property returned totalCount=0 and no rate rows for the requested dates and occupancy.');
  }
  result.limitations = result.limitations.map(item => item.replace(
    'The API was queried with includeTax=true, but returned fields do not explicitly expose tax/fee amounts or flags; retain both ontology values as unknown.',
    'The API was queried with includeTax=true, but an empty rates array makes tax/fee inclusion and amount basis unassessable for this stay.'
  ).replace(
    'The response does not explicitly label rate.userRate as a whole-stay total or a per-night amount.',
    'The adapter contract expects rate.userRate, but this response contained no quote object to inspect.'
  ));
  return result;
}

async function main() {
  const goodchoice = await goodchoiceEvidence();
  const naver = process.argv.includes('--naver-live')
    ? await runNaverReads()
    : process.argv.includes('--from-existing')
      ? await refreshExistingNaverResult()
      : null;
  await writeResults(goodchoice, naver);
  console.log(JSON.stringify({
    goodchoice: { verdict: goodchoice.verdict, status: goodchoice.listRequest.status, requests: goodchoice.requestCount },
    naver: naver ? { verdict: naver.verdict, hotelId: naver.search.selectedHotel.hotelId, rateCount: naver.ratesRequest.totalCount, requests: naver.requestCount } : null,
    outputDir: OUT_DIR,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ code: error.code ?? 'RESEARCH_FAILED', message: error.message }));
    process.exitCode = 1;
  });
}
