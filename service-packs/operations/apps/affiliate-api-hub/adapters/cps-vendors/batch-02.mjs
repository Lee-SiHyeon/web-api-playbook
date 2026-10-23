import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { readPublicPage, readPublicResource, extractPublicPage, safeUrl, textContent, isStrongPublicChallenge } from '../../lib/cps-public-reader.mjs';
import { collectNativeRecovery, nativeRecoveryMerchants as nativeMerchants } from './agy-native-recovery.mjs';

export const nativeRecoveryMerchants = Object.freeze(nativeMerchants.filter(id => id === 'ohouse'));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../../..');
const TAXONOMY_FILE = path.join(APP, 'affiliate-api-hub/references/linkprice-cps-vertical-taxonomy.v1.json');
const taxonomy = JSON.parse(readFileSync(TAXONOMY_FILE, 'utf8').replace(/^\uFEFF/, ''));

export const merchantIds = Object.freeze([
  'arket', 'ohouse', 'traveloka', 'nordvpn2', '072com', 'tstation', 'adidas',
  'soomgo', 'usimsa', 'gongyoung', 'ssglive', 'gmarket2', 'ypbooks', 'surfshark',
]);

const merchantById = new Map(taxonomy.merchants.filter(row => merchantIds.includes(row.merchantId)).map(row => [row.merchantId, row]));
const URLs = Object.freeze({
  arket: 'https://www.arket.com/ko-kr/c/new-arrivals.html',
  ohouse: 'https://ohou.se/search/index?query=%EC%B8%B5%EA%B0%84%EC%86%8C%EC%9D%8C%20%EC%8A%AC%EB%A6%AC%ED%8D%BC',
  traveloka: 'https://www.traveloka.com/ko-kr',
  nordvpn2: 'https://nordvpn.com/ko/',
  '072com': 'https://www.ttang.com/index.do',
  tstation: 'https://www.tstation.com/tire/product/HK_s_a_dynapro_hpx?goodsNo=G000000332840&sizeCd=2355519&carEncry=null',
  adidas: 'https://www.adidas.co.kr/',
  soomgo: 'https://soomgo.com/search/pro?from=main_service_feature',
  usimsa: 'https://www.usimsa.com/product/more',
  gongyoung: 'https://www.gongyoungshop.kr/main.do',
  ssglive: 'https://www.shinsegaetvshopping.com/broadcast/main',
  gmarket2: 'https://www.gmarket.co.kr/',
  ypbooks: 'https://www.ypbooks.co.kr/back_shop/base_shop/api/v1/product/listProductWithOutJson',
  surfshark: 'https://surfshark.com/pricing',
});

const CURRENT_BLOCKS = Object.freeze({
  arket: { id: '3e20323f-09b6-4e72-aad3-21c46a27e03c', observedAt: '2026-09-27T09:36:28.578Z', url: URLs.arket },
  ohouse: { id: '89bda408-ff9f-4c1d-a384-80e56377b0b9', observedAt: '2026-09-27T09:35:22.403Z', url: URLs.ohouse },
  soomgo: { id: '9c6038f0-d160-4543-a932-a1a7ec6c4409', observedAt: '2026-09-27T09:35:22.482Z', url: URLs.soomgo },
  nordvpn2: { id: 'b02-nordvpn2-prior-403', observedAt: null, url: URLs.nordvpn2, detail: 'Prior anonymous probe returned 403; response body metadata was not retained.' },
  adidas: { id: 'b02-adidas-prior-403', observedAt: null, url: URLs.adidas, detail: 'Prior anonymous probe returned 403; response body metadata was not retained.' },
  gmarket2: { id: 'b02-gmarket2-prior-403', observedAt: null, url: URLs.gmarket2, detail: 'Prior anonymous probe returned 403; response body metadata was not retained.' },
});

function rootsFor(merchant) {
  const host = new URL(merchant.siteUrl).hostname.toLowerCase().replace(/^www\./, '');
  return [host];
}
function attr(node, name) { return node?.attrs?.find(row => row.name.toLowerCase() === name.toLowerCase())?.value ?? null; }
function descendants(root, predicate, output = []) {
  if (!root || output.length >= 50_000) return output;
  if (predicate(root)) output.push(root);
  for (const child of root.childNodes ?? []) descendants(child, predicate, output);
  return output;
}
function anchorRows(html, baseUrl) {
  let root;
  try { root = parseFragment(html); } catch { return []; }
  return descendants(root, node => node.tagName === 'a' && attr(node, 'href') !== null).map(node => ({
    node, href: attr(node, 'href'), text: textContent(node, 1600) ?? '',
  }));
}
function cleanOfferingUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:contexts|inventoryRateKey|fpa)$/i.test(key)) url.searchParams.delete(key);
    }
    return safeUrl(url.href);
  } catch { return safeUrl(value, baseUrl); }
}
function moneyValues(text) {
  return [...String(text ?? '').matchAll(/(?:₩\s*)?([\d,]+)\s*원|₩\s*([\d,]+)(?:\s*\/(?:month|mo|month\.)|\s*\/월)?/gi)]
    .map(match => (match[1] ?? match[2] ?? '').replace(/,/g, ''))
    .filter(value => /^\d+$/.test(value));
}
function lastMoneyText(text) {
  const hits = [...String(text ?? '').matchAll(/(?:₩\s*[\d,]+(?:\s*\/(?:month|mo|month\.)|\s*\/월)?|[\d,]+\s*원)/gi)];
  return hits.length ? hits.slice(-3).map(hit => hit[0]).join(' ') : null;
}
function evidence(receiptId, locator, fields) { return [{ receiptId, locator, fields }]; }
function emptyRating() { return { value: null, best: null, worst: null, reviewCount: null, ratingCount: null }; }
function operation(state, receiptIds = [], note = null) { return { state, evidenceReceiptIds: receiptIds, ...(note ? { note } : {}) }; }
function setOps(report, { search = 'not_observed', catalog = 'not_observed', detail = 'not_observed', price = 'not_observed', rating = 'not_observed', reviews = 'not_observed', variants = 'not_observed', receiptId = null, notes = {} } = {}) {
  const ids = receiptId ? [receiptId] : [];
  report.operations = {
    product_search: operation(search, ids, notes.product_search ?? null),
    catalog_listing: operation(catalog, ids, notes.catalog_listing ?? null),
    product_detail: operation(detail, ids, notes.product_detail ?? null),
    price: operation(price, ids, notes.price ?? null),
    rating_summary: operation(rating, ids, notes.rating_summary ?? null),
    reviews_list: operation(reviews, ids, notes.reviews_list ?? null),
    variants: operation(variants, ids, notes.variants ?? null),
  };
}

function boundedReceipt(requestMethod, requestUrl, status, contentType, bytes, responseSha256, observedAt = new Date().toISOString()) {
  return {
    id: randomUUID(), requestMethod, requestUrl: safeUrl(requestUrl), responseStatus: Number.isInteger(status) ? status : null,
    contentType: contentType ?? null, bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
    responseSha256: responseSha256 ?? null, observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false,
  };
}

/** Replay only an observed same-origin public jQuery form read. No cookies, auth, or CSRF value. */
async function readObservedFormPost(requestUrl, formData, { allowedOrigin, referer, accept, maxBytes = 4 * 1024 * 1024, timeoutMs = 20_000 } = {}) {
  let url;
  try { url = new URL(requestUrl); } catch { return { ok: false, status: null, blocked: false, stopReason: 'URL_INVALID', receipt: null, body: null, location: null }; }
  if (url.origin !== allowedOrigin || url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { ok: false, status: null, blocked: false, stopReason: 'OBSERVED_FORM_ORIGIN_REJECTED', receipt: null, body: null, location: null };
  }
  const observedAt = new Date().toISOString();
  const encoded = new URLSearchParams(Object.entries(formData ?? {}).map(([key, value]) => [key, String(value ?? '')])).toString();
  let response;
  try {
    response = await fetch(url.href, {
      method: 'POST', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: accept ?? 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest', origin: allowedOrigin, referer: safeUrl(referer),
      },
      body: encoded,
    });
  } catch {
    return { ok: false, status: null, blocked: false, stopReason: 'PUBLIC_HTTP_TRANSPORT_FAILED', receipt: boundedReceipt('POST', url.href, null, null, 0, null, observedAt), body: null, location: null };
  }
  const status = response.status;
  const contentType = response.headers.get('content-type');
  const locationHeader = response.headers.get('location');
  if ([401, 403, 418, 429].includes(status)) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status, blocked: true, stopReason: 'HTTP_ACCESS_BLOCKED', receipt: boundedReceipt('POST', url.href, status, contentType, 0, null, observedAt), body: null, location: null };
  }
  if (status >= 300 && status < 400) {
    await response.body?.cancel().catch(() => {});
    let location = null;
    try {
      const target = new URL(locationHeader, url);
      if (target.origin === allowedOrigin && target.protocol === 'https:' && !target.username && !target.password && !target.port) location = safeUrl(target.href);
    } catch { /* Unusable redirect remains a frontier item. */ }
    return { ok: false, status, blocked: false, stopReason: location ? 'SAME_ORIGIN_REDIRECT' : 'REDIRECT_REJECTED', receipt: boundedReceipt('POST', url.href, status, contentType, 0, null, observedAt), body: null, location };
  }
  if (status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status, blocked: false, stopReason: 'HTTP_STATUS_REJECTED', receipt: boundedReceipt('POST', url.href, status, contentType, 0, null, observedAt), body: null, location: null };
  }
  let raw;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks, size);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status, blocked: false, stopReason: error?.message === 'RESPONSE_TOO_LARGE' ? 'RESPONSE_TOO_LARGE' : 'PUBLIC_HTTP_BODY_FAILED', receipt: boundedReceipt('POST', url.href, status, contentType, 0, null, observedAt), body: null, location: null };
  }
  const body = raw.toString('utf8');
  const receipt = boundedReceipt('POST', url.href, status, contentType, raw.length, createHash('sha256').update(raw).digest('hex'), observedAt);
  const mime = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  const challenge = mime === 'text/html' && isStrongPublicChallenge(Object.fromEntries(response.headers), body);
  if (challenge) return { ok: false, status, blocked: true, stopReason: 'VISIBLE_CHALLENGE', receipt, body: null, location: null };
  return { ok: true, status, blocked: false, stopReason: null, receipt, body, location: null };
}

function historicalBlockedReport(merchantId) {
  const merchant = merchantById.get(merchantId);
  const block = CURRENT_BLOCKS[merchantId];
  const receipt = {
    id: block.id, requestMethod: 'GET', requestUrl: block.url, responseStatus: 403,
    contentType: 'text/html', bytes: 0, responseSha256: null, observedAt: block.observedAt,
    browserUsed: false, cookiesSent: false, authorizationSent: false,
    ...(block.detail ? { observationNote: block.detail } : {}),
  };
  const report = { merchantId, siteUrl: merchant.siteUrl, receipts: [receipt], records: [], contracts: [], operations: {}, frontier: [], status: 'http_403_blocked', checkedAt: block.observedAt };
  setOps(report, {
    search: 'blocked_http_403', catalog: 'blocked_http_403', detail: 'blocked_http_403', price: 'blocked_http_403', rating: 'blocked_http_403', reviews: 'blocked_http_403', variants: 'blocked_http_403', receiptId: receipt.id,
    notes: { product_search: 'Host stop after observed 403; no additional requests.', product_detail: 'Host stop after observed 403; no additional requests.', price: 'Host stop after observed 403; no additional requests.', rating_summary: 'Host stop after observed 403; no additional requests.', reviews_list: 'Host stop after observed 403; no additional requests.' },
  });
  report.frontier.push({ url: block.url, state: 'blocked', stopReason: 'HTTP_ACCESS_BLOCKED', receiptId: receipt.id });

  if (merchantId === 'ohouse') {
    report.frontier.push({ state: 'historical_unverified_records', observedAt: null, receiptId: null, exclusion: 'prior HTML response had no retained observation timestamp; excluded from verified ontology graph', records: [
      { title: '라벨라코 [오늘의집 단독] 엔비 타올 스트라이프 포인트! 워셔블 층간소음 논슬립 실내화 룸슈즈 특별인증가', priceText: '23% 9,900원', ratingText: '4.9', reviewCount: 25028 },
      { title: '홈비 발안아픈 고밀도 쿠션! 스트리벨 층간소음 방지 슬리퍼 실내화 거실화 4color 2size', priceText: '38% 9,800원', ratingText: '4.8', reviewCount: 2582 },
      { title: '살림하는집 푹신한 층간소음 방지 실내화 거실 실내 슬리퍼 구름 거실화', priceText: '24% 7,500원', ratingText: '4.8', reviewCount: 3215 },
      { title: '바나코 1+1 비비드 테리 룸슬리퍼 층간소음 사계절 컬러 쿠션 거실화 논슬립 푹신한 실내화', priceText: '36% 38,000원', ratingText: '4.8', reviewCount: 6612 },
    ] });
  }
  if (merchantId === 'soomgo') {
    report.frontier.push({ state: 'historical_unverified_records', observedAt: null, receiptId: null, exclusion: 'prior HTML response had no retained observation timestamp and first card text was clipped; excluded from verified ontology graph', records: [
      { title: '숨고 바퀴벌레 개미 해충방역업체', reviewCount: 7701, hireCount: 20472, rating: null },
      { title: '[숨고] 대한민국 자동차분야 고용,리뷰 1위', reviewCount: 6761, hireCount: 16958, rating: null },
    ] });
  }
  return report;
}

function recordBase({ type = 'RetailProduct', sourceLocalId = null, title, url = null, sourcePageUrl = null, identityScope = null, description = null, brand = null, price = null, rating = null, variants = [], reviewSamples = [], receiptId, locator, fields = ['title', 'url'] }) {
  return {
    type, sourceLocalId, title, url, description, brand,
    ...(sourcePageUrl ? { sourcePageUrl } : {}), ...(identityScope ? { identityScope } : {}),
    price: price ?? { amount: null, currency: null, priceText: null },
    rating: rating ?? emptyRating(), variants, reviewSamples,
    evidence: evidence(receiptId, locator, fields),
  };
}

function travelokaRecords(page, receiptId) {
  const rows = anchorRows(page.html, page.url);
  const found = [];
  const seen = new Set();
  for (const row of rows) {
    const url = cleanOfferingUrl(row.href, page.url);
    if (!url || !/\b\d[\d,]*\s*원/.test(row.text)) continue;
    let parsed;
    try { parsed = new URL(row.href, page.url); } catch { continue; }
    const hotel = /\/hotel\/detail/i.test(parsed.pathname);
    const flight = /\/flight\//i.test(parsed.pathname);
    if (!hotel && !flight) continue;
    const key = `${hotel ? 'hotel' : 'flight'}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = row.text.replace(/\s+/g, ' ').trim();
    const prices = lastMoneyText(text);
    const localSpec = parsed.searchParams.get('spec');
    const localId = hotel ? localSpec?.match(/(?:^|\.)HOTEL\.(\d+)(?:\.|$)/)?.[1] ?? null : null;
    const nameEnd = text.search(/\b\d+(?:\.\d+)?\s*\/\s*10\b|\d[\d,]*\s*원/);
    const title = (nameEnd > 0 ? text.slice(0, nameEnd) : text).replace(/\b\d+%\s*할인\b/g, '').replace(/\s+/g, ' ').trim() || text.slice(0, 240);
    const queryFields = {};
    for (const [keyName, value] of parsed.searchParams.entries()) {
      if (/^(?:spec|checkInDate|checkOutDate|departureDate|returnDate|startDate|endDate|origin|destination|from|to|tripType|roundTrip|adults|children|infants|cabinClass|ap|dt|ps|sc|mch|st)$/i.test(keyName)) queryFields[keyName] = value.slice(0, 500);
    }
    const score = text.match(/(?:^|\s)(\d{1,2}(?:\.\d+)?)\s*\/\s*10\b/);
    const reviewText = text.match(/리뷰\s*([\d.]+\s*[kK]?)\s*개/);
    const qualifiers = {
      ...(localSpec ? { observedSpec: localSpec } : {}),
      ...(Object.keys(queryFields).length ? { observedQuery: queryFields } : {}),
      priceBasis: 'not_stated_in_listing_card',
    };
    const condition = [
      localSpec ? `Observed link spec=${localSpec}` : null,
      Object.keys(queryFields).some(field => /departureDate|returnDate|startDate|endDate|origin|destination|tripType|roundTrip/i.test(field)) ? `Observed route/date query fields: ${JSON.stringify(queryFields)}` : null,
      flight && /왕복/.test(text) ? 'Visible card title labels the itinerary 왕복; the card does not separately state the displayed fare basis.' : 'Listing card does not state whether this displayed amount is per-night, stay-total, one-way, or round-trip pricing.',
    ].filter(Boolean).join('; ');
    const amountValues = moneyValues(text);
    const price = {
      amount: amountValues.length === 1 ? Number(amountValues[0]) : null,
      currency: 'KRW', priceText: prices,
      priceKind: 'displayed_listing_price', condition, qualifiers,
    };
    const rating = {
      value: score ? Number(score[1]) : null, best: score ? 10 : null, worst: null,
      reviewCount: null, ratingCount: null,
      ...(reviewText ? { reviewCountDisplay: `${reviewText[1]}개` } : {}),
    };
    const fields = [...(localId ? ['sourceLocalId'] : []), 'title', 'url', ...(prices ? ['price'] : []), ...(score || reviewText ? ['rating'] : [])];
    found.push(recordBase({
      type: hotel ? 'TravelOffering' : 'TravelOffering', sourceLocalId: localId, title,
      url, description: text, brand: null, price, rating, receiptId,
      locator: hotel ? `a[href*="/hotel/detail"]:${localId ?? 'observed-card'}` : 'a[href*="/flight/"]:observed-card', fields,
    }));
  }
  return found;
}

function ttangRecords(page, receiptId) {
  const rows = anchorRows(page.html, page.url);
  const found = [];
  const seen = new Set();
  for (const row of rows) {
    const text = row.text.replace(/\s+/g, ' ').trim();
    if (text.length < 20 || !/\d[\d,]*\s*원/.test(text)) continue;
    if (!/(?:여행|출발|항공|호텔|패키지|\[[^\]]+\])/.test(text)) continue;
    const url = cleanOfferingUrl(row.href, page.url);
    if (!url) continue;
    const prices = [...text.matchAll(/[\d,]+\s*원~?/g)].map(match => match[0]);
    if (!prices.length) continue;
    const key = `${url}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const idMatch = new URL(url).searchParams.get('goodsNo') ?? new URL(url).searchParams.get('itemNo') ?? null;
    const startPrice = prices.find(value => /~$/.test(value)) ?? null;
    const exactPrice = prices.length === 1 && !startPrice ? prices[0] : null;
    const amount = exactPrice ? Number(exactPrice.replace(/[^\d]/g, '')) : null;
    const cardIndex = found.length;
    const departure = text.match(/(?:출발|출국)\s*[:：]?\s*(\d{1,2}[./-]\d{1,2})/);
    found.push(recordBase({
      type: 'TravelOffering', sourceLocalId: idMatch,
      title: text.slice(0, 1000), url: idMatch ? url : null, sourcePageUrl: page.url,
      ...(!idMatch ? { identityScope: 'observation' } : {}), description: text,
      price: {
        amount, ...(startPrice ? { lowPrice: Number(startPrice.replace(/[^\d]/g, '')) } : {}), currency: 'KRW', priceText: prices.join(' / '),
        priceKind: startPrice ? 'starting_price' : 'displayed_fare',
        condition: [startPrice ? 'Visible amount carries a trailing ~, so the page labels it as a starting price.' : null, departure ? `Visible departure text: ${departure[0]}` : null].filter(Boolean).join('; ') || null,
        qualifiers: { displayText: text.slice(0, 800) },
      },
      receiptId, locator: `document.anchor_text:travel-listing-card[${cardIndex}]`, fields: ['title', ...(idMatch ? ['url'] : []), 'price'],
    }));
  }
  return found;
}

function tstationRecords(page, parsed, receiptId) {
  const products = parsed.jsonLd.filter(row => {
    const types = Array.isArray(row?.['@type']) ? row['@type'] : [row?.['@type']];
    return types.some(type => String(type).toLowerCase() === 'product');
  });
  const product = products[0];
  if (!product) return [];
  const url = cleanOfferingUrl(page.url, page.url);
  const sku = new URL(page.url).searchParams.get('goodsNo') ?? product.sku ?? null;
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers ?? {};
  const ratingRaw = product.aggregateRating ?? {};
  const rawReviews = Array.isArray(product.review) ? product.review : product.review ? [product.review] : [];
  const reviewSamples = rawReviews.slice(0, 8).map(row => {
    const scoreValue = row?.reviewRating?.ratingValue ?? row?.ratingValue ?? null;
    const score = Number(scoreValue);
    return {
      rating: Number.isFinite(score) ? score : null,
      publishedAt: typeof row?.datePublished === 'string' ? row.datePublished : null,
      title: null, body: null, reviewer: null, reviewerIdentity: null,
      optionText: null, helpfulCount: null, hasMedia: null, completeness: 'partial',
    };
  });
  const visible = textContent(page.html, 100_000) ?? '';
  const amount = Number(String(offer.price ?? '').replace(/[^\d.]/g, ''));
  const priceDisplay = visible.match(/쿠폰할인가\s*[\d,]+\s*원\s*\d+%\s*[\d,]+\s*원[^.。]{0,240}/);
  const listPrice = priceDisplay?.[0].match(/\d+%\s*([\d,]+)\s*원/)?.[1]
    ?? visible.match(/(?:정가|판매가)\s*([\d,]+)\s*원/)?.[1]
    ?? visible.match(/([\d,]+)\s*원[^\n]{0,30}(?:정가|판매가)/)?.[1]
    ?? null;
  const couponRule = visible.match(/스마트페이는[^.。]{0,150}(?:적용 불가|구매 시 적용 가능)/)?.[0] ?? null;
  const monthlyRule = visible.match(/스마트페이\s*월\s*[\d,]+\s*원[^\n]{0,80}/)?.[0] ?? null;
  const discountRule = visible.match(/쿠폰(?:할인가| 적용)[^\n]{0,50}/)?.[0] ?? null;
  const title = product.name ?? parsed.title;
  const rating = {
    value: Number.isFinite(Number(ratingRaw.ratingValue)) ? Number(ratingRaw.ratingValue) : null,
    best: Number.isFinite(Number(ratingRaw.bestRating)) ? Number(ratingRaw.bestRating) : null,
    worst: Number.isFinite(Number(ratingRaw.worstRating)) ? Number(ratingRaw.worstRating) : null,
    reviewCount: Number.isSafeInteger(Number(ratingRaw.reviewCount)) ? Number(ratingRaw.reviewCount) : null,
    ratingCount: null,
  };
  const brand = typeof product.brand === 'string' ? product.brand : product.brand?.name ?? null;
  const price = {
    amount: Number.isFinite(amount) && amount > 0 ? amount : null, currency: String(offer.priceCurrency ?? 'KRW').toUpperCase(),
    priceText: priceDisplay?.[0] ?? (amount ? `${Number(amount).toLocaleString('en-US')}원` : null),
    listPrice: listPrice ? Number(listPrice.replace(/,/g, '')) : null,
    discountCondition: [discountRule, couponRule, monthlyRule].filter(Boolean).join('; ') || null,
    validUntil: offer.priceValidUntil ?? null,
    priceKind: 'coupon_or_displayed_product_offer',
  };
  const fields = [...(sku ? ['sourceLocalId'] : []), 'title', 'url', 'brand', ...(price.amount != null ? ['price'] : []), ...(rating.value != null || rating.reviewCount != null ? ['rating'] : []), ...(reviewSamples.length ? ['reviewSamples'] : [])];
  return [recordBase({ type: 'RetailProduct', sourceLocalId: sku, title, url, description: product.description ?? parsed.description, brand, price, rating, reviewSamples,
    receiptId, locator: `script[type="application/ld+json"]:Product;sku=${sku};document.visible_text:product_price`, fields })];
}

function ssgRecords(page, receiptId) {
  let root;
  try { root = parseFragment(page.html); } catch { return []; }
  const itemNodes = descendants(root, node => attr(node, 'data-gtm-item-id') && attr(node, 'data-gtm-item-name'));
  const found = [];
  const seen = new Set();
  for (const node of itemNodes) {
    const id = attr(node, 'data-gtm-item-id');
    const title = attr(node, 'data-gtm-item-name');
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const brand = attr(node, 'data-gtm-item-brand');
    const rawList = attr(node, 'data-gtm-item-price');
    const rawSale = attr(node, 'data-gtm-item-discount');
    // GTM attribute names do not prove the displayed price role. Preserve raw metrics only.
    let url = null;
    for (let current = node; current && current !== root; current = current.parentNode) {
      const link = descendants(current, child => child.tagName === 'a' && attr(child, 'href'))[0];
      if (link) { url = cleanOfferingUrl(attr(link, 'href'), page.url); break; }
    }
    const priceText = [rawList ? `data-gtm-item-price=${rawList}` : null, rawSale ? `data-gtm-item-discount=${rawSale}` : null].filter(Boolean).join('; ') || null;
    const cardText = textContent(node.parentNode ?? node, 1400);
    found.push(recordBase({
      type: 'RetailProduct', sourceLocalId: id, title, url, description: cardText, brand,
      price: {
        amount: null, currency: (rawList || rawSale) ? 'KRW' : null, priceText, listAmount: null,
        priceKind: 'source_secondary_metric',
        condition: 'Raw data-gtm-item-price/data-gtm-item-discount values are preserved; their selling-price versus reference-price roles are not established by retained evidence.',
        qualifiers: { sourceAttributes: { dataGtmItemPrice: rawList, dataGtmItemDiscount: rawSale }, semanticRole: 'unresolved' },
      },
      receiptId, locator: `[data-gtm-item-id="${id}"]`, fields: ['sourceLocalId', 'title', ...(url ? ['url'] : []), ...(brand ? ['brand'] : []), ...(priceText ? ['price'] : []), ...(cardText ? ['description'] : [])],
    }));
  }
  return found;
}

function surfsharkRecords(page, receiptId) {
  const visible = textContent(page.html, 220_000) ?? '';
  const plans = [
    { name: 'Starter', title: 'Surfshark Starter' },
    { name: 'One', title: 'Surfshark One' },
    { name: 'One+', title: 'Surfshark One+' },
  ];
  const records = [];
  for (const plan of plans) {
    const patternFor = name => name === 'One+'
      ? /Surfshark One\+\s+₩/i
      : name === 'One' ? /Surfshark One\s+₩/i : /Surfshark Starter\s+₩/i;
    const start = patternFor(plan.name).exec(visible);
    if (!start) continue;
    const at = start.index;
    const nextStarts = plans.filter(other => other.name !== plan.name).map(other => {
      const match = patternFor(other.name).exec(visible.slice(at + start[0].length));
      return match ? at + start[0].length + match.index : Number.POSITIVE_INFINITY;
    });
    const nextAt = Math.min(...nextStarts);
    const fullSnippet = visible.slice(at, Number.isFinite(nextAt) ? nextAt : Math.min(visible.length, at + 1200)).trim();
    const cardEnd = fullSnippet.indexOf('(VAT may apply).');
    const snippet = cardEnd >= 0 ? fullSnippet.slice(0, cardEnd + '(VAT may apply).'.length) : fullSnippet.slice(0, 1000);
    const monthly = snippet.match(/₩\s*([\d,]+)\s*\/(?:month|mo|month\.)/i) ?? snippet.match(/₩\s*([\d,]+)\s*\/월/);
    const total = snippet.match(/sale price\s*₩\s*([\d,]+)\s*for the first\s*(\d+)\s*months/i) ?? snippet.match(/첫\s*기간\s*판매가\s*₩\s*([\d,]+)\s*(\d+)\s*개월/i);
    const period = snippet.match(/(?:first|for the first|첫\s*)\s*(\d+)\s*months?/i) ?? snippet.match(/첫\s*(\d+)\s*개월/);
    const extra = snippet.match(/\+\s*(\d+)\s*extra\s*months?/i) ?? snippet.match(/추가\s*(\d+)\s*개월/);
    const vat = snippet.match(/VAT may apply|부가세[^.]{0,40}/i);
    if (!monthly) continue;
    const monthlyAmount = Number(monthly[1].replace(/,/g, ''));
    const qualifiers = {
      ...(period ? { firstTermMonthsDisplay: period[1] } : {}),
      ...(total ? { firstTermTotalDisplay: total[0].trim(), firstTermTotalAmount: Number(total[1].replace(/,/g, '')) } : {}),
      ...(extra ? { extraMonthsDisplay: extra[0].trim() } : {}),
      ...(vat ? { taxDisplay: vat[0].trim() } : {}),
      planTextExcerpt: snippet.slice(0, 1000),
    };
    const condition = [total?.[0]?.trim(), extra?.[0]?.trim(), vat?.[0]?.trim(), 'Renewal price not stated in the captured plan-card excerpt.'].filter(Boolean).join('; ') || null;
    records.push(recordBase({
      type: 'ServiceOffering', sourceLocalId: null, identityScope: 'observation', sourcePageUrl: page.url,
      title: plan.title, url: null, description: snippet.slice(0, 1000),
      price: { amount: monthlyAmount, currency: 'KRW', priceText: monthly[0], billingPeriod: 'month', priceKind: 'advertised_monthly_rate', condition, qualifiers },
      receiptId, locator: `document.visible_text:plan-card:${plan.title}`, fields: ['title', 'description', 'price'],
    }));
  }
  return records;
}

function findBookRows(value, output = [], depth = 0) {
  if (!value || depth > 8 || output.length > 1) return output;
  if (Array.isArray(value)) {
    if (value.length && value.some(row => row && typeof row === 'object' && (row.productCd || row.productCode) && (row.productNm || row.productName || row.title))) {
      output.push(value); return output;
    }
    for (const child of value.slice(0, 100)) findBookRows(child, output, depth + 1);
  } else if (typeof value === 'object') {
    for (const child of Object.values(value).slice(0, 100)) findBookRows(child, output, depth + 1);
  }
  return output;
}
function firstValue(row, patterns) {
  for (const pattern of patterns) {
    const key = Object.keys(row).find(candidate => pattern.test(candidate));
    if (key && row[key] != null && row[key] !== '') return { key, value: row[key] };
  }
  return { key: null, value: null };
}
function ypbooksRecords(payload, receiptId, url) {
  const rows = findBookRows(payload)[0] ?? [];
  return rows.map(row => {
    const id = String(row.productCd ?? row.productCode);
    const title = row.productNm ?? row.productName ?? row.title;
    const sale = firstValue(row, [/^salePrice$/i, /sale.*price/i, /sell.*price/i, /discount.*price/i, /final.*price/i]);
    const original = firstValue(row, [/^productPrice$/i, /original.*price/i, /normal.*price/i, /list.*price/i, /retail.*price/i, /org.*price/i]);
    const numberOf = input => {
      if (typeof input !== 'string' && typeof input !== 'number') return null;
      const n = Number(String(input).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const amount = numberOf(sale.value) ?? numberOf(original.value);
    const price = {
      amount, currency: amount == null ? null : 'KRW',
      priceText: [original.value != null ? `original=${original.value}` : null, sale.value != null ? `sale=${sale.value}` : null].filter(Boolean).join('; ') || null,
      listAmount: numberOf(original.value), priceKind: sale.value != null ? 'catalog_sale_price' : 'catalog_displayed_price',
    };
    const rawRating = row.avgValuation ?? row.valuation;
    const ratingValue = Number(rawRating);
    const rawReviewCount = row.reviewCount ?? row.reviewCnt;
    const reviewCount = Number(rawReviewCount);
    const rating = { value: Number.isFinite(ratingValue) && ratingValue > 0 ? ratingValue : null, best: null, worst: null,
      reviewCount: Number.isSafeInteger(reviewCount) && reviewCount >= 0 ? reviewCount : null, ratingCount: null };
    return recordBase({ type: 'RetailProduct', sourceLocalId: id, title, url: `https://www.ypbooks.co.kr/books/${encodeURIComponent(id)}`,
      description: row.simpleIntro ?? row.productDesc ?? row.description ?? null, brand: null, price, rating, receiptId,
      locator: `JSON.data.productCd=${id}`, fields: [...new Set(['sourceLocalId', 'title', 'url', ...(price.amount != null || price.priceText ? ['price'] : []), ...((rating.value != null || rating.reviewCount != null) ? ['rating'] : [])])] });
  }).filter(row => row.title && row.sourceLocalId);
}

function findReviewRows(value, output = [], depth = 0) {
  if (!value || depth > 8 || output.length > 1) return output;
  if (Array.isArray(value)) {
    if (value.length && value.some(row => row && typeof row === 'object' && (row.reviewRating || row.reviewScore || row.reviewNo || row.reviewId))) {
      output.push(value); return output;
    }
    for (const child of value.slice(0, 100)) findReviewRows(child, output, depth + 1);
  } else if (typeof value === 'object') {
    for (const child of Object.values(value).slice(0, 100)) findReviewRows(child, output, depth + 1);
  }
  return output;
}

function pendingLinks(parsed, receiptId) {
  const output = [];
  for (const link of parsed.links ?? []) {
    const text = String(link.text ?? '').trim();
    const pathName = (() => { try { return new URL(link.url).pathname; } catch { return ''; } })();
    if (!/(?:product|goods|item|detail|hotel|flight|booking|tour|travel|package|상품|예약|상세|항공|호텔)/i.test(`${pathName} ${text}`)) continue;
    output.push({ url: cleanOfferingUrl(link.url, parsed.page?.url ?? link.url), label: text || null, state: 'pending', sourceReceiptId: receiptId });
    if (output.length >= 80) break;
  }
  return output;
}

function reportBase(merchant) {
  return { merchantId: merchant.merchantId, siteUrl: merchant.siteUrl, receipts: [], records: [], contracts: [], operations: {}, frontier: [], status: 'not_started' };
}

function htmlAttributeNodes(html, tagName, attributeName) {
  let root;
  try { root = parseFragment(html); } catch { return []; }
  return descendants(root, node => node.tagName === tagName && attr(node, attributeName) !== null);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function blockedOutcome(response) {
  return response?.blocked || [401, 403, 418, 429].includes(response?.status);
}

function collectUsimDetailVariants(page) {
  let root;
  try { root = parseFragment(page.html); } catch { return { variants: [], selectedUsagePeriod: null, hasOptionCards: false }; }
  const selectedPeriodNode = descendants(root, node => attr(node, 'data-testid') === 'usage-period' && attr(node, 'aria-pressed') === 'true')[0]
    ?? descendants(root, node => attr(node, 'data-testid') === 'usage-period' && /bg-usdg-color-button-primary-bg-blue|text-white/.test(attr(node, 'class') ?? '')).at(0)
    ?? descendants(root, node => attr(node, 'data-testid') === 'usage-period' && /(?:selected|active)/i.test(attr(node, 'class') ?? '')).at(0);
  const periodFallback = descendants(root, node => attr(node, 'data-testid') === 'usage-period')[0];
  const selectedUsagePeriod = textContent(selectedPeriodNode ?? periodFallback, 80);
  const cards = descendants(root, node => attr(node, 'data-testid') === 'data-option');
  const variants = cards.map((node, index) => {
    const text = textContent(node, 1400) ?? '';
    const priceText = text.match(/[\d,]+\s*원/)?.[0] ?? null;
    const amount = priceText ? Number(priceText.replace(/[^\d]/g, '')) : null;
    const condition = selectedUsagePeriod ? `페이지 초기 선택 사용 기간: ${selectedUsagePeriod}` : null;
    const name = priceText ? text.slice(0, text.indexOf(priceText)).trim().slice(0, 220) : text.slice(0, 220) || `data-option-${index + 1}`;
    return { name, text: text.slice(0, 1400) || null, price: { amount: Number.isFinite(amount) && amount > 0 ? amount : null, currency: priceText ? 'KRW' : null, priceText, condition } };
  }).filter(row => row.name || row.price.amount != null);
  return { variants, selectedUsagePeriod, hasOptionCards: cards.length > 0 };
}

async function collectUsimsa(merchant) {
  const report = reportBase(merchant);
  const url = URLs.usimsa;
  const page = await readPublicPage(url, { allowedHosts: ['usimsa.com'], maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
  if (page.receipt) report.receipts.push(page.receipt);
  const pageReceiptId = page.receipt?.id ?? null;
  if (!page.ok) {
    const blocked = blockedOutcome(page);
    report.status = page.status ? `http_${page.status}_${blocked ? 'blocked' : 'rejected'}` : page.stopReason ?? 'read_failed';
    report.frontier.push({ url: page.url ?? url, state: blocked ? 'blocked' : 'failed', stopReason: page.stopReason, receiptId: pageReceiptId });
    setOps(report, { search: blocked ? `blocked_http_${page.status}` : 'read_failed', catalog: blocked ? `blocked_http_${page.status}` : 'read_failed', detail: blocked ? `blocked_http_${page.status}` : 'not_observed', price: blocked ? `blocked_http_${page.status}` : 'not_observed', rating: blocked ? `blocked_http_${page.status}` : 'not_observed', reviews: blocked ? `blocked_http_${page.status}` : 'not_observed', variants: blocked ? `blocked_http_${page.status}` : 'not_observed', receiptId: pageReceiptId });
    return report;
  }

  const apiMatch = page.html.match(/apiUrl\s*:\s*"(https:\/\/[^"/]+)"/);
  const productMatch = page.html.match(/productUrl\s*:\s*"(https:\/\/[^"/]+)"/);
  const assetRefs = [...page.html.matchAll(/(?:href|src)="([^"#?]*\/(?:index|more)\.[^"/]+\.js)(?:\?[^"#]*)?"/g)].map(match => new URL(match[1], page.url).href);
  const detailAssetUrl = assetRefs.find(value => /\/more\.[^/]+\.js$/.test(value)) ?? null;
  const assetReceipts = [];
  let storeBundleBody = null;
  let detailBundleBody = null;
  let storeAssetUrl = null;
  for (const assetUrl of assetRefs.filter(value => /\/index\.[^/]+\.js$/.test(value))) {
    const asset = await readPublicResource(assetUrl, { allowedHosts: ['usimsa.com'], maxRedirects: 2, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
    if (asset.receipt) { report.receipts.push(asset.receipt); assetReceipts.push(asset.receipt.id); }
    if (blockedOutcome(asset)) {
      report.status = `http_${asset.status}_blocked`;
      report.frontier.push({ url: asset.url ?? assetUrl, state: 'blocked', operation: 'public_catalog_caller_bundle', stopReason: asset.stopReason, receiptId: asset.receipt?.id ?? null });
      setOps(report, { search: 'blocked_after_public_shell', catalog: 'blocked_after_public_shell', receiptId: asset.receipt?.id ?? pageReceiptId });
      return report;
    }
    if (asset.ok && /i\("products",\{method:"GET",baseURL:[^}]+apiUrl\+"\/esim\/v1\/"/.test(asset.body)) {
      storeBundleBody = asset.body;
      storeAssetUrl = assetUrl;
      break;
    }
  }
  for (const [assetUrl, label] of [[detailAssetUrl, 'public_product_detail_route_bundle']]) {
    if (!assetUrl) continue;
    const asset = await readPublicResource(assetUrl, { allowedHosts: ['usimsa.com'], maxRedirects: 2, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
    if (asset.receipt) { report.receipts.push(asset.receipt); assetReceipts.push(asset.receipt.id); }
    if (asset.ok && label === 'public_catalog_caller_bundle') storeBundleBody = asset.body;
    if (asset.ok && label === 'public_product_detail_route_bundle') detailBundleBody = asset.body;
    if (blockedOutcome(asset)) {
      report.status = `http_${asset.status}_blocked`;
      report.frontier.push({ url: asset.url ?? assetUrl, state: 'blocked', operation: label, stopReason: asset.stopReason, receiptId: asset.receipt?.id ?? null });
      setOps(report, { search: 'blocked_after_public_shell', catalog: 'blocked_after_public_shell', receiptId: asset.receipt?.id ?? pageReceiptId });
      return report;
    }
  }

  const apiUrl = apiMatch?.[1] ? `${apiMatch[1].replace(/\/$/, '')}/esim/v1/products` : null;
  const shopOrigin = productMatch?.[1] ?? null;
  const catalogCallerVerified = typeof storeBundleBody === 'string' && /i\("products",\{method:"GET",baseURL:[^}]+apiUrl\+"\/esim\/v1\/"/.test(storeBundleBody);
  const detailRouteVerified = typeof detailBundleBody === 'string' && /productUrl/.test(detailBundleBody) && /\/sim\//.test(detailBundleBody);
  if (!apiUrl || !shopOrigin || new URL(shopOrigin).hostname !== 'shop.usimsa.com' || !catalogCallerVerified || !detailRouteVerified || !/apps-usimsa-prod-webapi-01\.azurewebsites\.net$/.test(new URL(apiUrl).hostname)) {
    report.status = 'public_contract_incomplete';
    report.contracts.push({ operation: 'public_catalog_list', state: 'contract_not_rederived', callerReceiptIds: assetReceipts, pageReceiptId, apiUrl: apiUrl ? safeUrl(apiUrl) : null });
    report.frontier.push({ url: page.url, state: 'pending', operation: 'catalog_list', note: 'The anonymous catalog call path or its public API origin was not fully derived from the current page and caller bundle.' });
    setOps(report, { catalog: 'not_captured', receiptId: pageReceiptId });
    return report;
  }

  const catalog = await readPublicResource(apiUrl, { allowedHosts: ['apps-usimsa-prod-webapi-01.azurewebsites.net'], maxRedirects: 2, maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000 });
  if (catalog.receipt) report.receipts.push(catalog.receipt);
  const catalogReceiptId = catalog.receipt?.id ?? null;
  if (!catalog.ok) {
    const blocked = blockedOutcome(catalog);
    report.status = catalog.status ? `http_${catalog.status}_${blocked ? 'blocked' : 'rejected'}` : catalog.stopReason ?? 'catalog_read_failed';
    report.frontier.push({ url: catalog.url ?? apiUrl, state: blocked ? 'blocked' : 'failed', stopReason: catalog.stopReason, receiptId: catalogReceiptId });
    setOps(report, { search: blocked ? `blocked_http_${catalog.status}` : 'read_failed', catalog: blocked ? `blocked_http_${catalog.status}` : 'read_failed', receiptId: catalogReceiptId });
    return report;
  }
  let payload;
  try { payload = JSON.parse(catalog.body); } catch { payload = null; }
  const sourceRows = Array.isArray(payload?.data) ? payload.data : null;
  if (!sourceRows || payload?.success !== true) {
    report.status = 'application_schema_rejected';
    report.contracts.push({ operation: 'public_catalog_list', state: 'schema_rejected', method: 'GET', requestUrl: safeUrl(apiUrl), receiptId: catalogReceiptId, status: catalog.status, contentType: catalog.contentType });
    setOps(report, { catalog: 'schema_rejected', receiptId: catalogReceiptId });
    return report;
  }

  const initialDetailOrigin = new URL(shopOrigin).origin;
  const recordsById = new Map();
  for (const [index, row] of sourceRows.entries()) {
    const id = typeof row?.productId === 'string' ? row.productId : null;
    const title = typeof row?.name === 'string' ? row.name.trim() : null;
    if (!id || !title) continue;
    const coverage = typeof row.keyword === 'string' && row.keyword.trim() ? `지원 지역/키워드: ${row.keyword.trim()}` : null;
    const benefit = typeof row.benefitText === 'string' && row.benefitText.trim() ? `혜택: ${row.benefitText.trim()}` : null;
    const description = [coverage, benefit].filter(Boolean).join('\n') || null;
    const detailUrl = safeUrl(`${initialDetailOrigin}/sim/${encodeURIComponent(id)}`);
    const record = recordBase({ type: 'ServiceOffering', sourceLocalId: id, title, url: detailUrl, description, brand: null,
      price: { amount: null, currency: null, priceText: null },
      receiptId: catalogReceiptId, locator: `JSON.data[${index}].productId=${id}`, fields: ['sourceLocalId', 'title', 'url', ...(description ? ['description'] : []), 'attributes'] });
    record.attributes = { catalogLevel: row.level ?? null, isCheaperThanRoaming: typeof row.isCheaperThanRoaming === 'boolean' ? row.isCheaperThanRoaming : null, hasLimitedOption: typeof row.hasLimitedOption === 'boolean' ? row.hasLimitedOption : null };
    recordsById.set(id, record);
  }
  report.records = [...recordsById.values()];
  report.contracts.push({ operation: 'public_catalog_list', state: 'live_replay_verified', method: 'GET', requestUrl: safeUrl(apiUrl), finalUrl: catalog.url, receiptId: catalogReceiptId, status: catalog.status, contentType: catalog.contentType, rowCount: report.records.length, callerEvidence: 'index module invokes useFetch("products", {method:"GET", baseURL: runtimeConfig.public.apiUrl + "/esim/v1/"}) with no Authorization or credentials option', callerReceiptIds: assetReceipts, pageReceiptId, requestContract: { credentials: 'omit', authorization: 'none' } });

  let detailOrigin = initialDetailOrigin;
  let detailsRead = 0;
  let variantRecords = 0;
  let hostStopped = false;
  const detailReceiptIds = [];
  for (const record of report.records) {
    if (hostStopped) break;
    const detailUrl = `${detailOrigin}/sim/${encodeURIComponent(record.sourceLocalId)}`;
    const detail = await readPublicPage(detailUrl, { allowedHosts: ['shop.usimsa.com'], maxRedirects: 2, maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000 });
    if (detail.receipt) { report.receipts.push(detail.receipt); detailReceiptIds.push(detail.receipt.id); }
    if (blockedOutcome(detail)) {
      hostStopped = true;
      report.status = `http_${detail.status}_blocked_after_catalog`;
      report.frontier.push({ url: detail.url ?? detailUrl, state: 'blocked', operation: 'product_detail', stopReason: detail.stopReason, receiptId: detail.receipt?.id ?? null });
      break;
    }
    if (!detail.ok) {
      report.frontier.push({ url: detail.url ?? detailUrl, state: 'pending', operation: 'product_detail', stopReason: detail.stopReason, receiptId: detail.receipt?.id ?? null });
    } else {
      detailsRead += 1;
      const parsed = extractPublicPage(detail, { merchantId: 'usimsa', typeHint: 'ServiceOffering' });
      const actualTitle = parsed.title && !/유심사.*구매하기/.test(parsed.title) ? parsed.title : null;
      if (actualTitle && actualTitle.includes(record.title)) {
        record.title = actualTitle.replace(/\s*\|\s*유심사.*$/,'').trim() || record.title;
        record.evidence.push({ receiptId: detail.receipt?.id, locator: 'document.title', fields: ['title'] });
      }
      const options = collectUsimDetailVariants(detail);
      if (options.variants.length) {
        variantRecords += 1;
        record.variants = options.variants;
        record.price = { amount: null, currency: 'KRW', priceText: null,
          condition: options.selectedUsagePeriod ? `초기 선택 사용 기간: ${options.selectedUsagePeriod}` : null,
          qualifiers: options.selectedUsagePeriod ? { selectedUsagePeriod: options.selectedUsagePeriod } : null,
          priceKind: 'variant_prices_only' };
        const fields = ['variants', ...(options.selectedUsagePeriod ? ['price'] : [])];
        record.evidence.push({ receiptId: detail.receipt?.id, locator: 'button[data-testid="usage-period"].bg-usdg-color-button-primary-bg-blue + div[data-testid="data-option"]', fields });
      } else {
        report.frontier.push({ url: detail.url, state: 'no_option_data_in_page', operation: 'variants', receiptId: detail.receipt?.id ?? null });
      }
      if (!record.evidence.some(row => row.receiptId === detail.receipt?.id && row.fields.includes('title'))) {
        // The list JSON is the title authority; page evidence only supports any matching detail-page title.
      }
    }
    await delay(250);
  }
  report.contracts.push({ operation: 'product_detail_and_variants', state: detailsRead ? 'live_replay_verified' : hostStopped ? 'blocked_after_catalog' : 'not_observed', method: 'GET', routeTemplate: `${detailOrigin}/sim/{productId}`, receiptIds: detailReceiptIds, rowCount: detailsRead, variantsRowCount: variantRecords, sequential: true, delayMs: 250, blockedAfterFirstError: hostStopped });
  report.operations = {
    product_search: operation('not_captured', [catalogReceiptId], 'The caller exposed a public full-list operation; no search term was submitted.'),
    catalog_listing: operation('live_replay_verified', [catalogReceiptId]),
    product_detail: operation(hostStopped ? 'blocked_after_catalog' : detailsRead ? 'live_replay_verified' : 'not_observed', detailReceiptIds),
    price: operation(variantRecords ? 'variant_prices_only' : 'not_observed', detailReceiptIds, variantRecords ? 'Exact options and the initially selected usage-period text are retained at the option level; product-level price is left null.' : 'No verified price fields.'),
    rating_summary: operation('not_observed', detailReceiptIds, 'No rating aggregate field was present in the public list or detail page parsed.'),
    reviews_list: operation('not_observed', detailReceiptIds, 'No anonymous review-list response was observed or replayed.'),
    variants: operation(variantRecords ? 'live_replay_verified' : 'not_observed', detailReceiptIds),
  };
  if (hostStopped) report.status = report.status ?? 'partial_catalog_blocked_on_detail';
  else report.status = report.records.length ? (detailsRead === report.records.length ? 'public_catalog_and_details_verified' : 'partial_records_available') : 'reachable_no_normalized_records';
  return report;
}

async function collectGongyoung(merchant, options = {}) {
  const report = reportBase(merchant);
  const allowed = ['gongyoungshop.kr'];
  const baseOrigin = 'https://www.gongyoungshop.kr';
  const page = await readPublicPage(URLs.gongyoung, { allowedHosts: allowed, maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
  if (page.receipt) report.receipts.push(page.receipt);
  const pageReceiptId = page.receipt?.id ?? null;
  if (!page.ok) {
    const blocked = blockedOutcome(page);
    report.status = page.status ? `http_${page.status}_${blocked ? 'blocked' : 'rejected'}` : page.stopReason ?? 'read_failed';
    report.frontier.push({ url: page.url ?? URLs.gongyoung, state: blocked ? 'blocked' : 'failed', stopReason: page.stopReason, receiptId: pageReceiptId });
    setOps(report, { catalog: blocked ? `blocked_http_${page.status}` : 'read_failed', receiptId: pageReceiptId });
    return report;
  }
  const groups = descendants(parseFragment(page.html), node => attr(node, 'class')?.split(/\s+/).includes('dv-cnr-group-list')).map(node => ({
    tplNo: attr(node, 'tplNo'), cnrContsLnkSeqNo: attr(node, 'cnrContsLnkSeqNo'), showAreaSctCd: attr(node, 'showAreaSctCd'), cnrNo: attr(node, 'cnrNo'),
    tplTpCd: attr(node, 'tplTpCd'), conts1MaxDispCnt: attr(node, 'conts1MaxDispCnt'), conts2MaxDispCnt: attr(node, 'conts2MaxDispCnt'), dispCatNo: attr(node, 'dispCatNo'),
  })).filter(row => row.tplNo && row.cnrContsLnkSeqNo && row.cnrNo);
  const scriptRefs = htmlAttributeNodes(page.html, 'script', 'src').map(node => new URL(attr(node, 'src'), page.url).href);
  const templateAsset = scriptRefs.find(value => /\/header\/dispTemplateTool\.js(?:\?|$)/.test(value)) ?? [...page.html.matchAll(/(?:href|src)="([^"#?]*\/header\/dispTemplateTool\.js)(?:\?[^"#]*)?"/g)].map(match => new URL(match[1], page.url).href)[0] ?? null;
  const asset = templateAsset ? await readPublicResource(templateAsset, { allowedHosts: allowed, maxRedirects: 2, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 }) : null;
  if (asset?.receipt) report.receipts.push(asset.receipt);
  if (asset && blockedOutcome(asset)) {
    report.status = `http_${asset.status}_blocked`;
    report.frontier.push({ url: asset.url ?? templateAsset, state: 'blocked', operation: 'observed_template_caller', stopReason: asset.stopReason, receiptId: asset.receipt?.id ?? null });
    setOps(report, { catalog: 'blocked_after_public_shell', receiptId: asset.receipt?.id ?? pageReceiptId });
    return report;
  }
  const scriptReceiptId = asset?.receipt?.id ?? null;
  const templateCallerVerified = asset?.ok && asset.body.includes('/module/display/AjaxCnrTemplate.do') && ['tplNo', 'cnrContsLnkSeqNo', 'showAreaSctCd', 'cnrNo', 'tplTpCd', 'conts1MaxDispCnt', 'conts2MaxDispCnt', 'dispCatNo'].every(key => asset.body.includes(key));
  const csrfMeta = htmlAttributeNodes(page.html, 'meta', 'name').find(node => attr(node, 'name') === '_csrf');
  const csrfContent = attr(csrfMeta, 'content');
  if (!templateCallerVerified || (csrfContent && csrfContent.trim())) {
    report.status = templateCallerVerified ? 'csrf_provider_present_not_used' : 'observed_caller_incomplete';
    report.frontier.push({ url: templateAsset, state: 'pending', operation: 'homepage_template_fragment', note: csrfContent?.trim() ? 'A nonempty CSRF value was present; no mutation/read POST was sent.' : 'The exact form caller was not established from the current first-party bundle.' });
    report.contracts.push({ operation: 'home_template_configuration', state: groups.length ? 'live_replay_verified' : 'no_group_markers', method: 'GET', requestUrl: URLs.gongyoung, receiptId: pageReceiptId, groupCount: groups.length });
    report.contracts.push({ operation: 'observed_template_caller', state: templateCallerVerified ? 'live_replay_verified' : 'caller_contract_incomplete', method: 'GET', requestUrl: templateAsset, receiptId: scriptReceiptId });
    setOps(report, { catalog: 'not_replayed', receiptId: pageReceiptId });
    return report;
  }
  report.contracts.push({ operation: 'home_template_configuration', state: groups.length ? 'live_replay_verified' : 'no_group_markers', method: 'GET', requestUrl: URLs.gongyoung, receiptId: pageReceiptId, groupCount: groups.length });
  report.contracts.push({ operation: 'observed_template_caller', state: 'live_replay_verified', method: 'GET', requestUrl: templateAsset, receiptId: scriptReceiptId, notes: 'The exact homepage data attributes feed the observed form POST; current page _csrf content is empty and no CSRF header/value is sent.' });
  const productIdsSeen = new Set();
  let blocked = false;
  for (const group of groups) {
    if (blocked) break;
    const endpoint = `${baseOrigin}/module/display/AjaxCnrTemplate.do`;
    const post = await readObservedFormPost(endpoint, group, { allowedOrigin: baseOrigin, referer: page.url, accept: 'text/html, */*; q=0.01' });
    if (post.receipt) report.receipts.push(post.receipt);
    const postReceiptId = post.receipt?.id ?? null;
    report.contracts.push({ operation: 'homepage_template_fragment', state: post.ok || post.location ? 'live_replay_verified' : post.stopReason, method: 'POST', requestUrl: safeUrl(endpoint), requestBody: group, receiptId: postReceiptId, status: post.status, contentType: post.receipt?.contentType ?? null, group: { tplNo: group.tplNo, cnrNo: group.cnrNo } });
    if (post.blocked) {
      blocked = true;
      report.status = `http_${post.status}_blocked`;
      report.frontier.push({ url: safeUrl(endpoint), state: 'blocked', operation: 'homepage_template_fragment', stopReason: post.stopReason, receiptId: postReceiptId });
      break;
    }
    let fragmentHtml = post.body ?? '';
    let fragmentReceiptId = postReceiptId;
    if (post.location) {
      const redirectPage = await readPublicPage(post.location, { allowedHosts: allowed, maxRedirects: 0, maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000 });
      if (redirectPage.receipt) report.receipts.push(redirectPage.receipt);
      fragmentReceiptId = redirectPage.receipt?.id ?? postReceiptId;
      if (blockedOutcome(redirectPage)) {
        blocked = true;
        report.status = `http_${redirectPage.status}_blocked`;
        report.frontier.push({ url: redirectPage.url ?? post.location, state: 'blocked', operation: 'redirected_template_fragment', stopReason: redirectPage.stopReason, receiptId: fragmentReceiptId });
        break;
      }
      if (!redirectPage.ok) {
        report.frontier.push({ url: redirectPage.url ?? post.location, state: 'pending', operation: 'redirected_template_fragment', stopReason: redirectPage.stopReason, receiptId: fragmentReceiptId });
        continue;
      }
      fragmentHtml = redirectPage.html;
    }
    let root;
    try { root = parseFragment(fragmentHtml); } catch { root = null; }
    const links = root ? descendants(root, node => node.tagName === 'a' && attr(node, 'href')).map(node => ({ url: safeUrl(attr(node, 'href'), baseOrigin), text: textContent(node, 1000) })) : [];
    for (const link of links) {
      let detailUrl;
      try { detailUrl = new URL(link.url); } catch { continue; }
      if (detailUrl.origin !== baseOrigin || detailUrl.pathname !== '/goods/selectGoodsDetail.do') continue;
      const productId = detailUrl.searchParams.get('prdId');
      if (!productId || productIdsSeen.has(productId)) continue;
      productIdsSeen.add(productId);
      const detail = await readPublicPage(detailUrl.href, { allowedHosts: allowed, maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
      if (detail.receipt) report.receipts.push(detail.receipt);
      const detailReceiptId = detail.receipt?.id ?? null;
      if (blockedOutcome(detail)) {
        blocked = true;
        report.status = `http_${detail.status}_blocked`;
        report.frontier.push({ url: detail.url ?? detailUrl.href, state: 'blocked', operation: 'product_detail', stopReason: detail.stopReason, receiptId: detailReceiptId });
        break;
      }
      if (!detail.ok) {
        report.frontier.push({ url: detail.url ?? detailUrl.href, state: 'pending', operation: 'product_detail', stopReason: detail.stopReason, receiptId: detailReceiptId });
        continue;
      }
      const text = textContent(detail.html, 140_000) ?? '';
      let detailRoot;
      try { detailRoot = parseFragment(detail.html); } catch { detailRoot = null; }
      const ogTitle = detailRoot ? attr(descendants(detailRoot, node => node.tagName === 'meta' && attr(node, 'property') === 'og:title')[0], 'content') : null;
      const headingTitle = detailRoot ? descendants(detailRoot, node => node.tagName === 'h2').map(node => textContent(node, 1200)).find(value => value && value.trim()) : null;
      const detailTitle = ogTitle || headingTitle;
      const title = detailTitle?.replace(/^공영홈쇼핑\s*\|\s*/, '').trim() || link.text?.trim() || null;
      if (!title) continue;
      const startingPrice = `${link.text ?? ''} ${text.slice(0, 6000)}`.match(/([\d,]+\s*원부터)/)?.[1] ?? null;
      const ratingText = text.match(/고객리뷰\s*평점\s*([\d.]+)점\s*만점\s*중\s*([\d.]+)/);
      const reviewText = text.match(/상품평수\s*\(\s*([\d,]+)\s*\)/);
      const consultationText = text.match(/해피콜을 통해 판매조건이 안내됩니다\.?/)?.[0] ?? null;
      const record = recordBase({ type: 'TravelOffering', sourceLocalId: productId, title, url: safeUrl(detailUrl.href), description: consultationText,
        price: { amount: null, lowPrice: startingPrice ? Number(startingPrice.replace(/[^\d]/g, '')) : null, currency: startingPrice ? 'KRW' : null, priceText: startingPrice, priceKind: startingPrice ? 'starting_price' : null,
          condition: consultationText ?? null, qualifiers: consultationText ? { salesTerms: consultationText } : null },
      rating: { value: ratingText ? Number(ratingText[2]) : null, best: ratingText ? Number(ratingText[1]) : null, worst: null, reviewCount: reviewText ? Number(reviewText[1].replace(/,/g, '')) : null, ratingCount: null },
        receiptId: detailReceiptId, locator: `document.visible_text:product-detail:${productId}`, fields: [...new Set(['sourceLocalId', 'title', 'url', ...(consultationText ? ['description', 'price'] : []), ...(startingPrice ? ['price'] : []), ...(ratingText ? ['rating'] : []), ...(reviewText ? ['rating'] : [])])] });
      report.records.push(record);
      record.evidence.push({ receiptId: fragmentReceiptId, locator: `a[href*="prdId=${productId}"]`, fields: ['title', 'price'] });
      report.contracts.push({ operation: 'product_detail', state: 'live_replay_verified', method: 'GET', requestUrl: safeUrl(detailUrl.href), receiptId: detailReceiptId, status: detail.status, contentType: detail.contentType });
      await delay(150);
    }
    report.frontier.push(...links.filter(link => !link.url || !link.url.includes('/goods/selectGoodsDetail.do')).slice(0, 15).map(link => ({ url: link.url, label: link.text || null, state: 'observed_non_product_or_unresolved', sourceReceiptId: fragmentReceiptId })));
  }
  report.operations = {
    product_search: operation('not_captured', [pageReceiptId], 'Observed homepage fragments were replayed; no keyword search request was submitted.'),
    catalog_listing: operation(report.records.length ? 'partial_replay_verified' : blocked ? 'blocked' : 'no_product_cards_found', report.contracts.filter(row => row.operation === 'homepage_template_fragment').map(row => row.receiptId).filter(Boolean)),
    product_detail: operation(report.records.length ? 'live_replay_verified' : blocked ? 'blocked' : 'not_observed', report.contracts.filter(row => row.operation === 'product_detail').map(row => row.receiptId).filter(Boolean)),
    price: operation(report.records.some(row => row.price?.lowPrice != null || row.price?.amount != null) ? 'starting_prices_only' : 'not_observed', report.contracts.filter(row => row.operation === 'product_detail').map(row => row.receiptId).filter(Boolean), 'The offer is consultation-led; its detail page shows a starting price and says final conditions arrive by callback. The displayed 0원 placeholder is excluded.'),
    rating_summary: operation(report.records.some(row => row.rating?.best != null || row.rating?.reviewCount != null) ? 'live_replay_verified' : 'not_observed', report.contracts.filter(row => row.operation === 'product_detail').map(row => row.receiptId).filter(Boolean)),
    reviews_list: operation('not_observed', [], 'The detail page visibly reports zero product reviews; a review-list route was not needed or replayed.'),
    variants: operation('not_observed', [], 'No actual option/variant list was exposed for the consultation product.'),
  };
  if (!blocked) await collectGongyoungSearch(report, options);
  if (!blocked && report.status !== 'http_403_blocked_after_search' && !/^http_\d+_blocked/.test(report.status)) report.status = report.records.length ? 'partial_records_available' : 'reachable_no_normalized_records';
  return report;
}

async function collectGongyoungSearch(report, options = {}) {
  const allowed = ['gongyoungshop.kr'];
  const baseOrigin = 'https://www.gongyoungshop.kr';
  const searchTerms = Array.isArray(options.searchTerms) && options.searchTerms.length
    ? options.searchTerms.map(value => String(value).trim()).filter(value => value && value.length <= 50).slice(0, 5)
    : ['사과'];
  const searchReceipts = [];
  const detailReceipts = [];
  let blocked = false;
  let searchCallerReceiptId = null;
  let helperReceiptId = null;
  const visited = new Set(report.records.map(row => String(row.sourceLocalId ?? '')));
  const knownFormFields = new Set(['kwd', 'reSrchFlag', 'pageNum', 'pageSize', 'sort', 'kwdType', 'categoryL', 'categoryM', 'categoryS', 'categoryD', 'brndNm', 'benefit', 'minPrice', 'maxPrice', 'searchMinPrice', 'searchMaxPrice', 'reSrchMode', 'reSrchWord', 'brandSort', 'logFlag']);
  const allSearchContracts = [];
  for (const term of searchTerms) {
    if (blocked) break;
    const searchUrl = `${baseOrigin}/search/goodsSearch.do?kwd=${encodeURIComponent(term)}`;
    const searchPage = await readPublicPage(searchUrl, { allowedHosts: allowed, maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
    if (searchPage.receipt) { report.receipts.push(searchPage.receipt); searchReceipts.push(searchPage.receipt.id); }
    if (blockedOutcome(searchPage)) {
      blocked = true;
      report.status = `http_${searchPage.status}_blocked`;
      report.frontier.push({ url: searchPage.url ?? searchUrl, state: 'blocked', operation: 'product_search', stopReason: searchPage.stopReason, receiptId: searchPage.receipt?.id ?? null });
      break;
    }
    if (!searchPage.ok) {
      report.frontier.push({ url: searchPage.url ?? searchUrl, state: 'pending', operation: 'product_search', stopReason: searchPage.stopReason, receiptId: searchPage.receipt?.id ?? null });
      continue;
    }
    const scriptRefs = htmlAttributeNodes(searchPage.html, 'script', 'src').map(node => new URL(attr(node, 'src'), searchPage.url).href);
    const callerUrl = scriptRefs.find(value => /\/search\/fo\/ecindex\.js(?:\?|$)/.test(value)) ?? null;
    const helperUrl = scriptRefs.find(value => /\/search\/common\/searchCommon\.js(?:\?|$)/.test(value)) ?? null;
    const caller = callerUrl ? await readPublicResource(callerUrl, { allowedHosts: allowed, maxRedirects: 2, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 }) : null;
    if (caller?.receipt) report.receipts.push(caller.receipt);
    searchCallerReceiptId = caller?.receipt?.id ?? searchCallerReceiptId;
    if (blockedOutcome(caller)) {
      blocked = true;
      report.status = `http_${caller.status}_blocked`;
      report.frontier.push({ url: caller.url ?? callerUrl, state: 'blocked', operation: 'search_xhr_caller', stopReason: caller.stopReason, receiptId: caller?.receipt?.id ?? null });
      break;
    }
    const helper = helperUrl ? await readPublicResource(helperUrl, { allowedHosts: allowed, maxRedirects: 2, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 }) : null;
    if (helper?.receipt) report.receipts.push(helper.receipt);
    helperReceiptId = helper?.receipt?.id ?? helperReceiptId;
    if (blockedOutcome(helper)) {
      blocked = true;
      report.status = `http_${helper.status}_blocked`;
      report.frontier.push({ url: helper.url ?? helperUrl, state: 'blocked', operation: 'search_xhr_helper', stopReason: helper.stopReason, receiptId: helper?.receipt?.id ?? null });
      break;
    }
    const callerVerified = caller?.ok && caller.body.includes('/search/ajaxSearchGoodsList.do') && caller.body.includes('searchAjaxTool.get({url: url_, data: formData}')
      && helper?.ok && /get:\s*function\(option_,\s*callback_\)[\s\S]*?method:\s*'POST'[\s\S]*?dataType:\s*'json'/.test(helper.body);
    const root = parseFragment(searchPage.html);
    const form = descendants(root, node => node.tagName === 'form' && attr(node, 'id') === 'historyForm')[0] ?? null;
    const formFields = {};
    for (const input of descendants(form, node => node.tagName === 'input' && attr(node, 'name'))) {
      const name = attr(input, 'name');
      if (knownFormFields.has(name)) formFields[name] = attr(input, 'value') ?? '';
      else {
        report.frontier.push({ url: searchUrl, state: 'pending', operation: 'search_form_contract', note: `Unexpected form field name omitted: ${name}` });
      }
    }
    const csrfMeta = htmlAttributeNodes(searchPage.html, 'meta', 'name').find(node => attr(node, 'name') === '_csrf');
    const csrfContent = attr(csrfMeta, 'content');
    if (!callerVerified || !form || formFields.kwd !== term || (csrfContent && csrfContent.trim())) {
      report.frontier.push({ url: searchUrl, state: 'pending', operation: 'search_xhr_replay', note: !callerVerified ? 'The current observed POST caller or JSON helper could not be revalidated.' : csrfContent?.trim() ? 'A nonempty CSRF value was present; no POST was sent.' : 'The current page did not expose the expected anonymous historyForm fields.' });
      allSearchContracts.push({ operation: 'product_search', state: 'caller_or_form_incomplete', method: 'GET', requestUrl: safeUrl(searchUrl), receiptId: searchPage.receipt?.id ?? null, callerReceiptId: searchCallerReceiptId, helperReceiptId, term });
      continue;
    }
    formFields.pageNum = '1'; // ecindex increments the rendered initial pageNum=0 immediately before this XHR.
    const endpoint = `${baseOrigin}/search/ajaxSearchGoodsList.do`;
    const post = await readObservedFormPost(endpoint, formFields, { allowedOrigin: baseOrigin, referer: searchPage.url, accept: 'application/json, text/javascript, */*; q=0.01', maxBytes: 4 * 1024 * 1024 });
    if (post.receipt) { report.receipts.push(post.receipt); searchReceipts.push(post.receipt.id); }
    if (post.blocked) {
      blocked = true;
      report.status = `http_${post.status}_blocked`;
      report.frontier.push({ url: safeUrl(endpoint), state: 'blocked', operation: 'product_search', stopReason: post.stopReason, receiptId: post.receipt?.id ?? null });
      break;
    }
    let payload = null;
    try { if (post.ok) payload = JSON.parse(post.body); } catch { payload = null; }
    const rows = Array.isArray(payload?.list) ? payload.list : [];
    const reportedCount = Number(payload?.cnt);
    const pageSize = Number(formFields.pageSize);
    allSearchContracts.push({ operation: 'product_search', state: rows.some(row => row?.prdId != null && row?.prdNm) ? 'live_replay_verified' : 'no_product_rows', method: 'POST', requestUrl: safeUrl(endpoint), requestBody: { ...formFields }, requestContract: { credentials: 'omit', authorization: 'none', callerReceiptIds: [searchPage.receipt?.id, searchCallerReceiptId, helperReceiptId].filter(Boolean), xhrHeader: 'X-Requested-With: XMLHttpRequest' }, receiptId: post.receipt?.id ?? null, status: post.status, contentType: post.receipt?.contentType ?? null, count: Number.isSafeInteger(reportedCount) ? reportedCount : null, returnedRows: rows.length, term });
    if (!post.ok || !Array.isArray(payload?.list)) {
      report.frontier.push({ url: safeUrl(endpoint), state: 'pending', operation: 'product_search', stopReason: post.stopReason ?? 'response_schema_unrecognized', receiptId: post.receipt?.id ?? null });
      continue;
    }
    for (const [index, item] of rows.entries()) {
      const id = item?.prdId != null ? String(item.prdId) : null;
      const title = typeof item?.prdNm === 'string' ? item.prdNm.trim() : null;
      if (!id || !title || visited.has(id)) continue;
      visited.add(id);
      const record = recordBase({ type: 'RetailProduct', sourceLocalId: id, title, url: null, description: null, brand: null,
        receiptId: post.receipt?.id ?? null, locator: `JSON.list[${index}].prdId=${id}`, fields: ['sourceLocalId', 'title'] });
      record.sourcePageUrl = safeUrl(searchPage.url);
      record.variants = [];
      report.records.push(record);
    }
    const detailRows = rows.filter(item => item?.prdId != null && typeof item?.prdNm === 'string');
    let detailCount = 0;
    let pricedCount = 0;
    let ratedCount = 0;
    let reviewedCount = 0;
    for (const item of detailRows) {
      if (blocked) break;
      const id = String(item.prdId);
      const record = report.records.find(row => String(row.sourceLocalId) === id);
      if (!record) continue;
      const detailUrl = `${baseOrigin}/goods/selectGoodsDetail.do?prdId=${encodeURIComponent(id)}`;
      const detail = await readPublicPage(detailUrl, { allowedHosts: allowed, maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
      if (detail.receipt) { report.receipts.push(detail.receipt); detailReceipts.push(detail.receipt.id); }
      if (blockedOutcome(detail)) {
        blocked = true;
        report.status = `http_${detail.status}_blocked_after_search`;
        report.frontier.push({ url: detail.url ?? detailUrl, state: 'blocked', operation: 'product_detail', stopReason: detail.stopReason, receiptId: detail.receipt?.id ?? null });
        break;
      }
      if (!detail.ok) {
        report.frontier.push({ url: detail.url ?? detailUrl, state: 'pending', operation: 'product_detail', stopReason: detail.stopReason, receiptId: detail.receipt?.id ?? null });
        continue;
      }
      detailCount += 1;
      record.url = safeUrl(detail.url ?? detailUrl);
      const detailRoot = parseFragment(detail.html);
      const ogTitle = attr(descendants(detailRoot, node => node.tagName === 'meta' && attr(node, 'property') === 'og:title')[0], 'content');
      if (ogTitle) {
        record.title = ogTitle.replace(/^공영홈쇼핑\s*\|\s*/, '').trim() || record.title;
        record.evidence.push({ receiptId: detail.receipt?.id, locator: 'meta[property="og:title"]', fields: ['title', 'url'] });
      } else record.evidence.push({ receiptId: detail.receipt?.id, locator: `document.requestUrl:prdId=${id}`, fields: ['url'] });
      const visible = textContent(detail.html, 220_000) ?? '';
      const titleAt = visible.indexOf(record.title);
      const codeAt = visible.indexOf(`상품코드 ${id}`);
      const contentStart = titleAt >= 0 ? titleAt : codeAt >= 0 ? codeAt : 0;
      const near = visible.slice(contentStart, Math.min(visible.length, contentStart + 16_000));
      const expectedPrice = near.match(/예상구매가\s*([\d,]+\s*원)/);
      const displayedPrice = near.match(/판매가\s*([\d,]+\s*원)/);
      const listPrice = near.match(/할인전 가격\s*([\d,]+)\s*원/);
      const saleAmountText = expectedPrice?.[1] ?? displayedPrice?.[1] ?? null;
      const discountBlock = near.match(/판매가\s*[\d,]+\s*원.{0,200}?예상구매가\s*[\d,]+\s*원/)?.[0] ?? null;
      const couponStart = near.indexOf('쿠폰할인항목');
      const couponCandidate = couponStart >= 0 ? near.slice(couponStart, couponStart + 420) : '';
      const couponBlock = couponCandidate.match(/쿠폰할인항목\s+.*?최대\s*[\d,]+\s*원(?:\s*할인쿠폰\s*받기)?/)?.[0]
        ?? near.match(/추가할인가 안내\s+.{0,150}?총 할인금액\s*-[\d,]+\s*원/)?.[0] ?? null;
      const ratingMatch = near.match(/고객리뷰\s*평점\s*([\d.]+)점\s*만점\s*중\s*([\d.]+)/);
      const reviewCountExact = near.match(/상품평\s*\(([\d,]+)\)/);
      const reviewCountDisplay = near.match(/상품평수\s*\(\s*([\d,]+\+?)\s*\)/);
      const reviewCount = reviewCountExact ? Number(reviewCountExact[1].replace(/,/g, ''))
        : reviewCountDisplay && !reviewCountDisplay[1].includes('+') ? Number(reviewCountDisplay[1].replace(/,/g, '')) : null;
      if (saleAmountText) {
        const amount = Number(saleAmountText.replace(/[^\d]/g, ''));
        record.price = { amount: Number.isFinite(amount) ? amount : null, currency: 'KRW', priceText: expectedPrice?.[0] ?? displayedPrice?.[0] ?? saleAmountText,
          listAmount: listPrice ? Number(listPrice[1].replace(/,/g, '')) : null,
          priceKind: expectedPrice ? 'displayed_estimated_purchase_price' : 'displayed_sale_price',
          discountCondition: discountBlock,
          qualifiers: couponBlock ? { separatelyDisplayedCouponOrAdditionalDiscount: couponBlock } : undefined };
        record.evidence.push({ receiptId: detail.receipt?.id, locator: 'document.visible_text:product_price_breakdown', fields: ['price'] });
        pricedCount += 1;
      }
      if (ratingMatch || reviewCount != null || reviewCountDisplay) {
        record.rating = { value: ratingMatch ? Number(ratingMatch[2]) : null, best: ratingMatch ? Number(ratingMatch[1]) : null, worst: null, reviewCount, ratingCount: null,
          ...(reviewCountDisplay ? { reviewCountDisplay: reviewCountDisplay[1] } : {}) };
        record.evidence.push({ receiptId: detail.receipt?.id, locator: 'document.visible_text:customer_rating_and_product_review_tab', fields: ['rating'] });
        ratedCount += ratingMatch ? 1 : 0;
        reviewedCount += reviewCount != null || reviewCountDisplay ? 1 : 0;
      }
      await delay(160);
    }
    const totalPages = Number.isSafeInteger(reportedCount) && pageSize > 0 ? Math.ceil(reportedCount / pageSize) : null;
    if (totalPages > 1) report.frontier.push({ url: safeUrl(searchUrl), operation: 'catalog_listing', state: 'pending_pagination', term, firstPage: 1, completedPages: 1, remainingPages: totalPages - 1, reportedCount: reportedCount, pageSize, note: 'Only the first observed consumer search page was replayed in this pass.' });
    report.contracts.push({ operation: 'consumer_search_page', state: detailCount ? 'partial_first_page_live_replay_verified' : 'live_replay_verified', method: 'POST', requestUrl: safeUrl(endpoint), receiptId: post.receipt?.id ?? null, searchPageReceiptId: searchPage.receipt?.id ?? null, callerReceiptId: searchCallerReceiptId, helperReceiptId, term, resultCount: Number.isSafeInteger(reportedCount) ? reportedCount : null, returnedRows: rows.length, completedDetails: detailCount, pricedRows: pricedCount, ratedRows: ratedCount, reviewCountRows: reviewedCount, page: 1, pageSize });
  }
  report.contracts.push(...allSearchContracts);
  report.operations.product_search = operation(allSearchContracts.some(row => row.state === 'live_replay_verified') ? 'live_replay_verified' : blocked ? 'blocked' : 'not_captured', searchReceipts, 'Anonymous observed search XHR; queries come from options.searchTerms or the site homepage-linked 사과 promotion example.');
  report.operations.catalog_listing = operation(report.records.length ? 'partial_first_page_replay_verified' : blocked ? 'blocked' : 'no_product_records', [...searchReceipts, ...report.contracts.filter(row => row.operation === 'homepage_template_fragment').map(row => row.receiptId).filter(Boolean)], 'Homepage fragments plus only the first page per search term are included. Pagination frontier records the remaining result pages.');
  report.operations.product_detail = operation(detailReceipts.length ? 'live_replay_verified' : blocked ? 'blocked' : report.operations.product_detail?.state ?? 'not_observed', detailReceipts);
  report.operations.price = operation(report.records.some(row => row.price?.amount != null) ? 'live_replay_verified' : report.operations.price?.state ?? 'not_observed', detailReceipts, 'Details retain the displayed estimated purchase or sale price separately from list price and visible coupon conditions.');
  report.operations.rating_summary = operation(report.records.some(row => row.rating?.value != null || row.rating?.reviewCount != null || row.rating?.reviewCountDisplay) ? 'live_replay_verified' : report.operations.rating_summary?.state ?? 'not_observed', detailReceipts);
  report.operations.reviews_list = operation('not_captured', [], 'Product detail pages provide review aggregates; no review body list was replayed or persisted.');
  report.operations.variants = operation('not_observed', [], 'No product option list was collected in this pass.');
  return { blocked, searchReceipts, detailReceipts };
}

async function collectPageMerchant(merchantId, merchant) {
  const report = reportBase(merchant);
  const requestUrl = URLs[merchantId];
  const page = await readPublicPage(requestUrl, { allowedHosts: rootsFor(merchant), maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
  if (page.receipt) report.receipts.push(page.receipt);
  const receiptId = page.receipt?.id ?? null;
  if (!page.ok) {
    const blocked = page.blocked || [401, 403, 418, 429].includes(page.status);
    report.status = page.status ? `http_${page.status}_${blocked ? 'blocked' : 'rejected'}` : page.stopReason ?? 'read_failed';
    report.frontier.push({ url: page.url ?? requestUrl, state: blocked ? 'blocked' : 'failed', stopReason: page.stopReason, receiptId });
    setOps(report, { search: blocked ? `blocked_http_${page.status}` : 'read_failed', catalog: blocked ? `blocked_http_${page.status}` : 'read_failed', detail: blocked ? `blocked_http_${page.status}` : 'not_observed', price: blocked ? `blocked_http_${page.status}` : 'not_observed', rating: blocked ? `blocked_http_${page.status}` : 'not_observed', reviews: blocked ? `blocked_http_${page.status}` : 'not_observed', receiptId });
    return report;
  }

  const parsed = extractPublicPage(page, { merchantId, typeHint: merchant.verticalHint === 'travel' ? 'TravelOffering' : null });
  parsed.links = (parsed.links ?? []).filter(link => {
    try { const h = new URL(link.url).hostname.toLowerCase(); return rootsFor(merchant).some(root => h === root || h.endsWith(`.${root}`)); } catch { return false; }
  });
  parsed.page = { url: page.url };
  report.contracts.push({ operation: 'public_catalog_or_detail_document', state: 'live_replay_verified', method: 'GET', requestUrl, finalUrl: page.url, receiptId, contentType: page.contentType, status: page.status, parsedRecords: parsed.records.length, jsonLdTypes: parsed.jsonLd.map(row => row?.['@type'] ?? null) });

  if (merchantId === 'traveloka') report.records = travelokaRecords(page, receiptId);
  else if (merchantId === '072com') report.records = ttangRecords(page, receiptId);
  else if (merchantId === 'tstation') report.records = tstationRecords(page, parsed, receiptId);
  else if (merchantId === 'ssglive') report.records = ssgRecords(page, receiptId);
  else if (merchantId === 'surfshark') report.records = surfsharkRecords(page, receiptId);
  else report.records = parsed.records;

  report.frontier.push(...pendingLinks(parsed, receiptId));
  const hasRecords = report.records.length > 0;
  report.status = hasRecords ? 'partial_records_available' : 'reachable_no_normalized_records';
  const detailPath = merchantId === 'tstation';
  const hasPrices = report.records.some(row => row.price?.amount != null || row.price?.priceText != null);
  const hasRatings = report.records.some(row => row.rating?.value != null || row.rating?.reviewCount != null);
  setOps(report, {
    search: 'not_captured', catalog: hasRecords && !detailPath ? 'live_replay_verified' : 'not_captured',
    detail: detailPath ? 'live_replay_verified' : 'not_captured',
    price: hasPrices ? 'live_replay_verified' : 'not_observed',
    rating: hasRatings ? 'live_replay_verified' : 'not_observed',
    reviews: report.records.some(row => row.reviewSamples?.length) ? 'partial_embedded_jsonld_samples' : 'not_captured', variants: 'not_captured', receiptId,
    notes: {
      product_search: hasRecords ? null : 'Page was reachable, but no public offering records were present in this response.',
      product_detail: detailPath ? null : 'A page-linked detail operation was not replayed for this merchant.',
      reviews_list: report.records.some(row => row.reviewSamples?.length) ? 'Product JSON-LD includes rating-only review sample objects; full bodies and a paged review list were not captured.' : 'No public review-list response was captured; aggregates on a product page do not establish sample-list access.',
      variants: 'No option/variant listing was captured.',
    },
  });
  if (merchantId === 'traveloka') {
    report.operations.reviews_list = operation('not_captured', [receiptId], 'Cards display rating/review summaries only; no review bodies/list endpoint were replayed.');
  }
  if (merchantId === 'surfshark') {
    report.operations.product_search = operation('not_applicable', [receiptId], 'Pricing page presents service-plan offers, not retail product search.');
    report.operations.product_detail = operation('not_exposed', [receiptId], 'Pricing cards are the observed offering records; no separate plan-detail page was followed.');
  }
  return report;
}

async function collectYpbooks(merchant) {
  const report = reportBase(merchant);
  const url = URLs.ypbooks;
  const response = await readPublicResource(url, { allowedHosts: rootsFor(merchant), maxRedirects: 2, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
  if (response.receipt) report.receipts.push(response.receipt);
  const receiptId = response.receipt?.id ?? null;
  if (!response.ok) {
    const blocked = response.blocked || [401, 403, 418, 429].includes(response.status);
    report.status = response.status ? `http_${response.status}_${blocked ? 'blocked' : 'rejected'}` : response.stopReason ?? 'read_failed';
    report.frontier.push({ url: response.url ?? url, state: blocked ? 'blocked' : 'failed', stopReason: response.stopReason, receiptId });
    setOps(report, { search: blocked ? `blocked_http_${response.status}` : 'read_failed', catalog: blocked ? `blocked_http_${response.status}` : 'read_failed', detail: blocked ? `blocked_http_${response.status}` : 'not_observed', price: blocked ? `blocked_http_${response.status}` : 'not_observed', rating: blocked ? `blocked_http_${response.status}` : 'not_observed', reviews: blocked ? `blocked_http_${response.status}` : 'not_observed', receiptId });
    return report;
  }
  let payload;
  try { payload = JSON.parse(response.body); } catch {
    report.status = 'application_json_invalid';
    setOps(report, { search: 'schema_rejected', catalog: 'schema_rejected', receiptId });
    report.contracts.push({ operation: 'catalog_list_json', state: 'schema_rejected', receiptId, status: response.status, contentType: response.contentType });
    return report;
  }
  const appState = String(payload.state ?? '').toUpperCase();
  if (appState === 'FAIL' || payload.stateCode && Number(payload.stateCode) >= 400) {
    report.status = 'application_error';
    report.contracts.push({ operation: 'catalog_list_json', state: 'application_error', receiptId, status: response.status, contentType: response.contentType, applicationState: payload.state ?? null, applicationStateCode: payload.stateCode ?? null });
    setOps(report, { search: 'application_error', catalog: 'application_error', detail: 'not_captured', price: 'not_captured', rating: 'not_captured', reviews: 'not_captured', receiptId });
    return report;
  }
  report.records = ypbooksRecords(payload, receiptId, url);
  report.contracts.push({ operation: 'catalog_list_json', state: report.records.length ? 'live_replay_verified' : 'schema_no_product_rows', method: 'GET', requestUrl: url, finalUrl: response.url, receiptId, contentType: response.contentType, status: response.status, rowCount: report.records.length, applicationState: payload.state ?? null, applicationStateCode: payload.stateCode ?? null });
  report.status = report.records.length ? 'partial_records_available' : 'reachable_no_normalized_records';
  setOps(report, { search: 'not_captured', catalog: report.records.length ? 'live_replay_verified' : 'not_captured', detail: 'not_captured', price: report.records.some(row => row.price?.amount != null) ? 'live_replay_verified' : 'not_observed', rating: report.records.some(row => row.rating?.value != null || row.rating?.reviewCount != null) ? 'live_replay_verified' : 'not_observed', reviews: 'not_captured', variants: 'not_captured', receiptId,
    notes: { product_detail: 'A prior observed detail route returned an application system error; not re-probed in this batch.', reviews_list: 'A prior mapped review-list route returned an empty body; no review data claimed.' } });
  const productId = report.records[0]?.sourceLocalId;
  if (!productId) return report;
  const productPath = `https://www.ypbooks.co.kr/back_shop/base_shop/api/v1/product/productView/${encodeURIComponent(productId)}`;
  const detail = await readPublicResource(productPath, { allowedHosts: rootsFor(merchant), maxRedirects: 2, maxBytes: 512 * 1024, timeoutMs: 20_000 });
  if (detail.receipt) report.receipts.push(detail.receipt);
  if (detail.blocked || [401, 403, 418, 429].includes(detail.status)) {
    const detailId = detail.receipt?.id ?? null;
    report.status = `http_${detail.status}_blocked_after_catalog`;
    report.frontier.push({ url: detail.url ?? productPath, state: 'blocked', stopReason: detail.stopReason, receiptId: detailId });
    report.operations.product_detail = operation(`blocked_http_${detail.status}`, detailId ? [detailId] : []);
    return report;
  }
  let detailPayload = null;
  if (detail.ok) { try { detailPayload = JSON.parse(detail.body); } catch { detailPayload = null; } }
  const detailIsApplicationError = detailPayload && (String(detailPayload.state ?? '').toUpperCase() === 'FAIL' || Number(detailPayload.stateCode) >= 400);
  report.contracts.push({ operation: 'product_detail_json', state: detailIsApplicationError ? 'application_error' : detailPayload ? 'live_replay_verified' : detail.ok ? 'schema_rejected' : 'response_unusable', method: 'GET', requestUrl: productPath, finalUrl: detail.url, receiptId: detail.receipt?.id ?? null, status: detail.status, contentType: detail.contentType, applicationState: detailPayload?.state ?? null, applicationStateCode: detailPayload?.stateCode ?? null });
  report.operations.product_detail = operation(detailIsApplicationError ? 'application_error' : detailPayload ? 'live_replay_verified' : 'not_captured', detail.receipt?.id ? [detail.receipt.id] : [], detailIsApplicationError ? `HTTP ${detail.status} JSON returned application state ${detailPayload.state} / ${detailPayload.stateCode}; no product detail fields.` : null);
  if (detailIsApplicationError) report.frontier.push({ url: productPath, operation: 'product_detail', state: 'application_error', httpStatus: detail.status, applicationState: detailPayload.state, applicationStateCode: detailPayload.stateCode, receiptId: detail.receipt?.id ?? null });

  const reviewPath = `https://www.ypbooks.co.kr/back_shop/base_shop/api/v1/product_reviews/list_for_product/${encodeURIComponent(productId)}/`;
  const reviews = await readPublicResource(reviewPath, { allowedHosts: rootsFor(merchant), maxRedirects: 2, maxBytes: 1024 * 1024, timeoutMs: 20_000 });
  if (reviews.receipt) report.receipts.push(reviews.receipt);
  if (reviews.blocked || [401, 403, 418, 429].includes(reviews.status)) {
    const reviewId = reviews.receipt?.id ?? null;
    report.status = `http_${reviews.status}_blocked_after_catalog`;
    report.frontier.push({ url: reviews.url ?? reviewPath, state: 'blocked', stopReason: reviews.stopReason, receiptId: reviewId });
    report.operations.reviews_list = operation(`blocked_http_${reviews.status}`, reviewId ? [reviewId] : []);
    return report;
  }
  let reviewPayload = null;
  if (reviews.ok) { try { reviewPayload = JSON.parse(reviews.body); } catch { reviewPayload = null; } }
  const reviewRows = reviewPayload ? (findReviewRows(reviewPayload)[0] ?? []) : [];
  const reviewReceiptId = reviews.receipt?.id ?? null;
  if (reviewRows.length) {
    const target = report.records.find(row => row.sourceLocalId === productId);
    const samples = reviewRows.slice(0, 8).map(row => {
      const ratingValue = Number(row.reviewRating?.ratingValue ?? row.reviewScore ?? row.rating ?? NaN);
      return { rating: Number.isFinite(ratingValue) ? ratingValue : null, publishedAt: typeof (row.datePublished ?? row.createdAt) === 'string' ? (row.datePublished ?? row.createdAt) : null,
        title: null, body: null, reviewer: null, reviewerIdentity: null, optionText: null, helpfulCount: null, hasMedia: null, completeness: 'partial' };
    });
    target.reviewSamples = samples;
    for (const item of target.evidence) { if (!item.fields.includes('reviewSamples')) item.fields.push('reviewSamples'); }
    target.evidence.push({ receiptId: reviewReceiptId, locator: `JSON.productCd=${productId}.reviews`, fields: ['reviewSamples'] });
  }
  const emptyReviewBody = !reviews.ok && reviews.status === 200 && reviews.receipt?.bytes === 0;
  report.contracts.push({ operation: 'product_reviews_json', state: reviewRows.length ? 'partial_review_samples' : emptyReviewBody ? 'empty_untyped_response' : reviewPayload ? 'replay_verified_no_review_rows' : 'response_unusable', method: 'GET', requestUrl: reviewPath, finalUrl: reviews.url, receiptId: reviewReceiptId, status: reviews.status, contentType: reviews.contentType, bytes: reviews.receipt?.bytes ?? null, rowCount: reviewRows.length });
  report.operations.reviews_list = operation(reviewRows.length ? 'partial_review_samples' : emptyReviewBody ? 'empty_untyped_response' : reviewPayload ? 'verified_no_rows' : 'not_captured', reviewReceiptId ? [reviewReceiptId] : [], 'This is one product review resource; pagination, bodies and identities are not persisted.');
  if (!reviewRows.length) report.frontier.push({ url: reviewPath, operation: 'reviews_list', state: emptyReviewBody ? 'empty_untyped_response' : 'pending_review_schema', receiptId: reviewReceiptId });
  return report;
}

/** Direct anonymous HTTP refresh for this assigned roster. A prior rejected host is never probed again. */
export async function collectMerchant(merchantId, options = {}) {
  const merchant = merchantById.get(merchantId);
  if (!merchant) throw Object.assign(new Error('MERCHANT_NOT_IN_BATCH_02'), { code: 'MERCHANT_NOT_IN_BATCH_02' });
  if (merchantId === 'ohouse') return await collectNativeRecovery('ohouse', options);
  if (CURRENT_BLOCKS[merchantId]) return historicalBlockedReport(merchantId);
  const report = merchantId === 'ypbooks' ? await collectYpbooks(merchant)
    : merchantId === 'usimsa' ? await collectUsimsa(merchant)
      : merchantId === 'gongyoung' ? await collectGongyoung(merchant, options)
        : await collectPageMerchant(merchantId, merchant);
  report.checkedAt = report.receipts.map(row => row.observedAt).filter(Boolean).sort().at(-1) ?? new Date().toISOString();
  return report;
}
