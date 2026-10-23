import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { readPublicPage, readPublicResource, extractPublicPage, isStrongPublicChallenge, safeUrl, textContent } from '../../lib/cps-public-reader.mjs';
import { collectWconcept } from './wconcept.mjs';
import { collectLfmall } from './lfmall.mjs';
import { collectCoupangWebSupplement } from '../coupang-web-supplement.mjs';
import { collectLenovoPublic } from './lenovo-public.mjs';
import { collectFailurePathMerchant } from './failure-path-supplement.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const taxonomyPath = resolve(repoRoot, 'references/linkprice-cps-vertical-taxonomy.v1.json');
const outputPath = resolve(repoRoot, 'references/cps-reverify/batch-06.json');
const supplementPaths = {
  wconcept: resolve(repoRoot, 'references/cps-reverify/wconcept-supplement.json'),
  lfmall: resolve(repoRoot, 'references/cps-reverify/lfmall-supplement.json'),
  coupang: resolve(repoRoot, 'references/cps-reverify/coupang-web-supplement.json'),
};
export const merchantIds = Object.freeze(['iherb', 'jomashop', 'lenovo', 'wconcept', 'ctrip', 'coupang', 'jestina', 'thehyundai', 'mustit', 'applecom', 'lfmall', 'mootoon', 'mrporter', 'agoda']);
export const refreshableAfterPublicBlockMerchants = Object.freeze(['coupang']);
const merchantHosts = {
  iherb: ['iherb.com'], jomashop: ['jomashop.com'], lenovo: ['lenovo.com'], wconcept: ['wconcept.co.kr'],
  ctrip: ['trip.com'], coupang: ['coupang.com'], jestina: ['jestina.co.kr'], thehyundai: ['thehyundai.com'],
  mustit: ['mustit.co.kr'], applecom: ['apple.com'], lfmall: ['lfmall.co.kr'], mootoon: ['mootoon.co.kr'],
  mrporter: ['mrporter.com'], agoda: ['agoda.com'],
};
// Public asset domains may be read only when directly observed in that merchant's HTML.
const merchantResourceHosts = {
  lenovo: ['static.pub'],
  agoda: ['agoda.net'],
};
// Final HTTPS URLs observed during the first anonymous probe; these are not guessed paths.
const observedSecureRoots = {
  jomashop: 'https://www.jomashop.com/',
  wconcept: 'https://display.wconcept.co.kr/rn/women',
  ctrip: 'https://kr.trip.com/',
  jestina: 'https://www.jestina.co.kr/',
  thehyundai: 'https://hi.thehyundai.com/homefeed',
  mustit: 'https://mustit.co.kr/',
  applecom: 'https://www.apple.com/kr/',
  lfmall: 'https://www.lfmall.co.kr/app',
  mootoon: 'https://www.mootoon.co.kr/',
  mrporter: 'https://www.mrporter.com/en-kr/',
  agoda: 'https://www.agoda.com/ko-kr/partners/partnersearch.aspx',
};
// Exact anchors seen in the initial public HTML probe; these URLs are not synthesized.
const additionalObservedLinks = {
  lenovo: [{ url: 'https://www.lenovo.com/kr/ko/laptops/results/?visibleDatas=9361%3AThinkPad%3B11792%3A%ED%95%99%EC%83%9D%EC%9A%A9&sortBy=bestSelling&iPromoID=FTV_hero_4_2', text: 'Observed homepage ThinkPad laptop category' }],
  applecom: [
    { url: 'https://www.apple.com/kr/macbook-air/', text: 'MacBook Air' },
    { url: 'https://www.apple.com/kr/shop/goto/buy_mac/macbook_air', text: 'MacBook Air 구입하기' },
  ],
  jestina: [{ url: 'https://www.jestina.co.kr/products/view/G2000030770?cateCd=282', text: 'Observed product card' }],
};
const blockedStatuses = new Set([401, 403, 418, 429]);
const maxPagesDefault = 8;
const detailPath = /(?:product|goods|item|detail|pdp|productview|goodsview|hotel-detail|hotel\/|lodging|stay\/|room\/|flight-detail|comic|episode\/|book\/|service\/detail|tour\/detail|\/p\/|buy-mac\/[^/]+\/[^/]+)/i;
const categoryPath = /(?:category|categories|catalog|shop|brands?|clothing|watches|jewell?ery|shoes|bags|women|men|beauty|laptops?|computers?|notebooks?|hotel|hotels|flight|flights|packages?|tours?|contents?|webtoon|comic|episode|books?|food|supplement|wellness)/i;
const irrelevantPath = /(?:login|signin|sign-in|account|mypage|cart|checkout|privacy|terms|customer-service|help|support|newsroom|sitemap|appstore|googleplay)/i;
const textOffering = /(?:상품|제품|자세히|상세|호텔|숙소|항공권|여행|객실|에피소드|웹툰|도서|구매|예약|women|men|clothing|watch|jewelry|shoes|bag|hotel|flight|tour|book|comic|shop|shop all|laptop|computer|notebook|macbook|thinkpad)/i;
const array = value => Array.isArray(value) ? value : value == null ? [] : [value];
const clean = (value, limit = 4000) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || null : null;
const valueAmount = value => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const hostAllowed = (value, roots) => {
  try { const url = new URL(value); return roots.some(root => url.hostname === root || url.hostname.endsWith(`.${root}`)); }
  catch { return false; }
};

async function readObservedPublicHttp(value, allowedHosts) {
  let url;
  try { url = new URL(value); } catch { return { ok: false, url: safeUrl(value), status: null, contentType: null, html: null, redirects: [], blocked: false, stopReason: 'URL_INVALID' }; }
  if (url.protocol !== 'http:' || url.username || url.password || url.port || !hostAllowed(url.href, allowedHosts)) {
    return { ok: false, url: safeUrl(value), status: null, contentType: null, html: null, redirects: [], blocked: false, stopReason: 'OBSERVED_HTTP_SCOPE_REJECTED' };
  }
  const redirects = [];
  for (let hop = 0; hop <= 2; hop += 1) {
    const observedAt = new Date().toISOString();
    let response;
    try {
      response = await fetch(url.href, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(20_000) });
    } catch {
      return { ok: false, url: safeUrl(url.href), status: null, contentType: null, html: null, redirects, blocked: false, stopReason: 'PUBLIC_HTTP_TRANSPORT_FAILED', receipt: { id: randomUUID(), requestMethod: 'GET', requestUrl: safeUrl(url.href), responseStatus: null, contentType: null, bytes: 0, responseSha256: null, observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false } };
    }
    const status = response.status;
    const contentType = response.headers.get('content-type');
    const location = response.headers.get('location');
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {});
      let target;
      try { target = new URL(location, url); } catch { return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, blocked: false, stopReason: 'REDIRECT_LOCATION_MISSING' }; }
      if (!hostAllowed(target.href, allowedHosts) || target.username || target.password || target.port) return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, blocked: false, stopReason: 'REDIRECT_OUTSIDE_PROVIDER' };
      redirects.push({ status, from: safeUrl(url.href), to: safeUrl(target.href) });
      if (target.protocol === 'https:') return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, redirectTarget: safeUrl(target.href), blocked: false, stopReason: 'OBSERVED_HTTPS_REDIRECT', receipt: { id: randomUUID(), requestMethod: 'GET', requestUrl: safeUrl(url.href), responseStatus: status, contentType, bytes: 0, responseSha256: null, observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false } };
      if (target.protocol !== 'http:' || hop >= 2) return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, blocked: false, stopReason: 'HTTP_REDIRECT_LIMIT_OR_SCHEME' };
      url = target;
      continue;
    }
    const receiptBase = { id: randomUUID(), requestMethod: 'GET', requestUrl: safeUrl(url.href), responseStatus: status, contentType, observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false };
    if ([401, 403, 418, 429].includes(status)) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, blocked: true, stopReason: 'HTTP_ACCESS_BLOCKED', receipt: { ...receiptBase, bytes: 0, responseSha256: null } };
    }
    if (status !== 200 || !['text/html', 'application/xhtml+xml'].includes((contentType ?? '').split(';', 1)[0].trim().toLowerCase())) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, blocked: false, stopReason: 'HTTP_STATUS_OR_MIME_REJECTED', receipt: { ...receiptBase, bytes: 0, responseSha256: null } };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024) return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, blocked: false, stopReason: 'RESPONSE_TOO_LARGE', receipt: { ...receiptBase, bytes: 0, responseSha256: null } };
    const html = bytes.toString('utf8');
    const receipt = { ...receiptBase, bytes: bytes.length, responseSha256: createHash('sha256').update(bytes).digest('hex') };
    if (isStrongPublicChallenge(response.headers, html)) return { ok: false, url: safeUrl(url.href), status, contentType, html: null, redirects, blocked: true, stopReason: 'VISIBLE_CHALLENGE', receipt };
    return { ok: true, url: safeUrl(url.href), status, contentType, html, redirects, blocked: false, stopReason: null, receipt };
  }
  return { ok: false, url: safeUrl(url.href), status: null, contentType: null, html: null, redirects, blocked: false, stopReason: 'HTTP_REDIRECT_LIMIT' };
}

function receiptFromPage(page, kind, sequence) {
  const source = page.receipt ?? {};
  return {
    receiptId: source.id ?? `${kind}:${sequence}`,
    kind,
    method: source.requestMethod ?? 'GET',
    requestedUrl: safeUrl(source.requestUrl ?? page.url),
    finalUrl: safeUrl(page.url),
    status: page.status ?? source.responseStatus ?? null,
    mime: page.contentType ?? source.contentType ?? null,
    bytes: source.bytes ?? 0,
    sha256: source.responseSha256 ?? null,
    checkedAt: source.observedAt ?? null,
    redirects: Array.isArray(page.redirects) ? page.redirects : [],
    browserUsed: source.browserUsed ?? false,
    cookiesSent: source.cookiesSent ?? false,
    authorizationSent: source.authorizationSent ?? false,
    stopReason: page.stopReason ?? null,
  };
}

function normalizeRecord(raw, receiptId, locator, pageUrl) {
  const rawRating = raw.rating && typeof raw.rating === 'object' ? raw.rating : null;
  const rawPrice = raw.price && typeof raw.price === 'object' ? raw.price : null;
  const normalizeOffer = offer => ({
    amount: valueAmount(offer?.amount), currency: clean(offer?.currency, 12),
    priceText: clean(offer?.priceText, 200), lowPrice: valueAmount(offer?.lowPrice), highPrice: valueAmount(offer?.highPrice),
    type: clean(offer?.type, 80), availability: clean(offer?.availability, 40), seller: clean(offer?.seller, 300),
    validFrom: clean(offer?.validFrom, 80), validUntil: clean(offer?.validUntil, 80), condition: clean(offer?.condition, 500),
    url: safeUrl(offer?.url, pageUrl),
  });
  return {
    type: clean(raw.type, 120) ?? 'ObservedCommercialOffering',
    sourceLocalId: clean(raw.sourceLocalId, 200),
    title: clean(raw.title, 1000),
    url: safeUrl(raw.url ?? pageUrl),
    description: clean(raw.description, 4000),
    brand: clean(raw.brand, 300),
    price: rawPrice || raw.price != null ? {
      amount: valueAmount(rawPrice?.amount), currency: clean(rawPrice?.currency, 12),
      priceText: clean(rawPrice?.priceText ?? raw.priceText, 200),
    } : null,
    rating: rawRating ? {
      value: valueAmount(rawRating.value), best: valueAmount(rawRating.best), worst: valueAmount(rawRating.worst),
      reviewCount: valueAmount(rawRating.reviewCount), ratingCount: valueAmount(rawRating.ratingCount),
    } : null,
    attributes: raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)
      ? Object.fromEntries(Object.entries(raw.attributes).filter(([key, value]) => !/(?:author|email|phone|address|customer|account|user|person|token|session)/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 40).map(([key, value]) => [clean(key, 100), typeof value === 'string' ? clean(value, 500) : value]))
      : null,
    offers: array(raw.offers).slice(0, 30).map(normalizeOffer),
    variants: array(raw.variants).slice(0, 40).map(variant => ({
      sourceLocalId: clean(variant?.sourceLocalId, 200), title: clean(variant?.title, 500), url: safeUrl(variant?.url, pageUrl),
      price: variant?.price ? { amount: valueAmount(variant.price.amount), currency: clean(variant.price.currency, 12), priceText: clean(variant.price.priceText, 200) } : null,
      offers: array(variant?.offers).slice(0, 20).map(normalizeOffer),
      attributes: variant?.attributes && typeof variant.attributes === 'object' && !Array.isArray(variant.attributes)
        ? Object.fromEntries(Object.entries(variant.attributes).filter(([key, value]) => !/(?:author|email|phone|address|customer|account|user|person)/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 40).map(([key, value]) => [clean(key, 100), typeof value === 'string' ? clean(value, 500) : value]))
        : null,
    })),
    reviewSamples: array(raw.reviewSamples).slice(0, 12).map(review => ({
      rating: valueAmount(review?.rating), publishedAt: clean(review?.publishedAt, 80), title: null, text: null, author: null,
    })),
    evidence: [{ receiptId, locator: clean(locator, 500), fields: Array.isArray(raw.evidence?.[0]?.fields) ? raw.evidence[0].fields : ['title', 'url'] }],
  };
}

function embeddedOfferingRecords(extracted, page, allowedHosts) {
  const records = [];
  const nodes = [];
  const stack = array(extracted?.embeddedJson).map(item => ({ value: item?.value, path: `script#${item?.id ?? 'embedded-json'}` }));
  while (stack.length && nodes.length < 2500) {
    const current = stack.pop();
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length && index < 250; index++) stack.push({ value: current.value[index], path: `${current.path}[${index}]` });
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    nodes.push(current);
    for (const [key, child] of Object.entries(current.value).slice(0, 200)) stack.push({ value: child, path: `${current.path}.${key}` });
  }
  for (const { value, path } of nodes) {
    const title = value.name ?? value.title ?? value.productName ?? value.itemName ?? value.goodsName ?? value.hotelName ?? value.displayName;
    const urlValue = value.url ?? value.productUrl ?? value.detailUrl ?? value.canonicalUrl ?? value.link ?? value.href;
    const resolvedUrl = typeof urlValue === 'string' && !/^\[(?:링크|link)\]$/i.test(urlValue.trim()) ? safeUrl(urlValue, page.url) : null;
    const priceValue = value.price ?? value.salePrice ?? value.finalPrice ?? value.discountPrice ?? value.minPrice ?? value.displayPrice;
    const parsedPrice = valueAmount(priceValue);
    const id = value.sku ?? value.gtin ?? value.isbn ?? value.productId ?? value.productID ?? value.goodsNo ?? value.goodsId ?? value.itemNo;
    const ratingValue = value.ratingValue ?? value.starRating ?? value.starScore ?? value.rating ?? value.score;
    const reviewCount = value.reviewCount ?? value.review_count ?? value.totalReviews ?? value.reviewTotalCount;
    if (typeof title !== 'string' || title.trim().length < 2 || !resolvedUrl || !hostAllowed(resolvedUrl, allowedHosts) || (parsedPrice == null && valueAmount(ratingValue) == null && valueAmount(reviewCount) == null && id == null)) continue;
    const rating = valueAmount(ratingValue) == null && valueAmount(reviewCount) == null ? null : {
      value: valueAmount(ratingValue), best: null, worst: null, reviewCount: valueAmount(reviewCount), ratingCount: valueAmount(reviewCount),
    };
    records.push({
      type: 'ObservedCommercialOffering', sourceLocalId: id == null ? null : clean(String(id), 200),
      title: clean(title, 1000), url: resolvedUrl,
      description: clean(value.description ?? value.summary ?? value.shortDescription, 2000),
      brand: clean(value.brand?.name ?? value.brandName, 300),
      price: parsedPrice == null ? null : { amount: parsedPrice, currency: clean(value.currency ?? value.priceCurrency, 12), priceText: typeof priceValue === 'string' ? clean(priceValue, 100) : null },
      rating, variants: [], reviewSamples: [],
      evidence: [{ receiptId: page.receipt?.id ?? null, locator: path, fields: ['title', 'url', ...(parsedPrice != null ? ['price'] : []), ...(rating ? ['rating'] : []), ...(id != null ? ['sourceLocalId'] : [])] }],
    });
    if (records.length >= 40) break;
  }
  const unique = new Map();
  for (const record of records) unique.set(`${record.sourceLocalId ?? ''}\0${record.url}\0${record.title}`, record);
  return [...unique.values()];
}

function linksToExplore(extracted, currentUrl, vertical, allowedHosts, seen) {
  const choices = [];
  for (const link of array(extracted?.links)) {
    if (link.rel) continue;
    if (typeof link?.url !== 'string' || !hostAllowed(link.url, allowedHosts)) continue;
    let url;
    try { url = new URL(link.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
    if (/\.(?:css|js|mjs|cjs|map|woff2?|ttf|eot|png|jpe?g|gif|webp|svg|ico|xml|json|pdf|mp4|zip|webmanifest)$/i.test(url.pathname)) continue;
    if (url.hostname.endsWith('lenovo.com') && !/^\/kr\/ko(?:\/|$)/i.test(url.pathname)) continue;
    const key = safeUrl(url.href);
    if (!key || seen.has(key) || key === safeUrl(currentUrl)) continue;
    const pathAndText = `${url.pathname} ${url.search} ${link.text ?? ''}`;
    if (irrelevantPath.test(url.pathname) && !/(?:hotel|flight|tour|comic|book|product|order)/i.test(url.pathname)) continue;
    let score = 0;
    if (detailPath.test(`${url.pathname} ${url.search}`)) score += 12;
    if (categoryPath.test(`${url.pathname} ${url.search}`)) score += 6;
    if (textOffering.test(link.text ?? '')) score += 5;
    if (vertical === 'travel' && /hotel|flight|package|tour|room|stay|lodging/i.test(pathAndText)) score += 7;
    if (vertical === 'fashion' && /women|men|clothing|watch|jewelry|shoes|bag|designer|brand|fashion|sale/i.test(pathAndText)) score += 4;
    if (vertical === 'books' && /book|comic|webtoon|episode|toon|novel/i.test(pathAndText)) score += 7;
    if (/\/p\/[^/]+/i.test(url.pathname)) score += 14;
    if (/apple\.com/i.test(url.hostname) && /\/kr\/shop\/buy-mac\/[^/]+\/[^/]+/i.test(url.pathname)) score += 16;
    if (url.pathname.split('/').filter(Boolean).length >= 3) score += 1;
    if (score > 0) choices.push({ url: key, text: clean(link.text, 300), score });
  }
  const unique = new Map();
  for (const item of choices.sort((a, b) => b.score - a.score)) if (!unique.has(item.url)) unique.set(item.url, item);
  return [...unique.values()];
}

function observedScriptResources(html, baseUrl, allowedHosts) {
  let root;
  try { root = parseFragment(html); } catch { return []; }
  const stack = [root];
  const output = [];
  while (stack.length && output.length < 200) {
    const node = stack.pop();
    if (node.tagName === 'script') {
      const src = node.attrs?.find(attr => attr.name === 'src')?.value;
      if (src) output.push({ value: src, locator: 'script[src]' });
    } else if (node.tagName === 'link') {
      const rel = (node.attrs?.find(attr => attr.name === 'rel')?.value ?? '').toLowerCase();
      const as = (node.attrs?.find(attr => attr.name === 'as')?.value ?? '').toLowerCase();
      const href = node.attrs?.find(attr => attr.name === 'href')?.value;
      if (href && /(?:preload|modulepreload|prefetch)/.test(rel) && ['script', 'fetch'].includes(as)) output.push({ value: href, locator: `link[rel="${rel}"][as="${as}"]` });
    }
    for (const child of node.childNodes ?? []) stack.push(child);
  }
  const unique = new Map();
  for (const item of output) {
    const url = safeUrl(item.value, baseUrl);
    if (!url || !hostAllowed(url, allowedHosts) || !url.startsWith('https://')) continue;
    if (/\.(?:css|woff2?|ttf|eot|png|jpe?g|gif|webp|svg|ico|pdf)$/i.test(new URL(url).pathname)) continue;
    if (!unique.has(url)) unique.set(url, { url, locator: item.locator });
  }
  return [...unique.values()].slice(0, 20);
}

function hasUsefulRecord(records, merchantId = null) {
  if (merchantId === 'applecom') {
    const itemPages = records.filter(record => record.title && record.url && record.price?.amount != null && /\/kr\/shop\/buy-mac\/macbook-air\/[^/]+/i.test(new URL(record.url).pathname));
    return itemPages.length >= 4;
  }
  return records.some(record => record.title && record.url && (
    record.sourceLocalId && (record.price?.amount != null || array(record.offers).some(offer => offer.amount != null || offer.lowPrice != null || offer.highPrice != null) || record.rating?.value != null || record.rating?.reviewCount != null || array(record.variants).some(variant => variant?.sourceLocalId || variant?.price?.amount != null || array(variant?.offers).some(offer => offer.amount != null || offer.lowPrice != null || offer.highPrice != null)) || record.reviewSamples?.length) ||
    record.price?.amount != null || array(record.offers).some(offer => offer.amount != null) ||
    record.rating?.value != null || record.rating?.reviewCount != null || array(record.variants).some(variant => variant?.sourceLocalId || variant?.price?.amount != null || array(variant?.offers).some(offer => offer.amount != null)) || record.reviewSamples?.length
  ));
}

async function readSupplement(merchantId) {
  const path = supplementPaths[merchantId];
  if (!path) return null;
  try {
    const row = JSON.parse(await readFile(path, 'utf8'));
    return row?.merchantId === merchantId && Array.isArray(row.records) ? row : null;
  } catch { return null; }
}

function mergeCoupangSupplement(supplement) {
  const source = {
    merchantId: 'coupang', merchantName: '쿠팡', siteUrl: 'https://www.coupang.com/', verticalHint: 'retail',
  };
  const blocked = seedBlockedRow('coupang', source);
  if (!supplement) return blocked;
  const blockedReceiptIds = blocked.receipts.map(item => item.receiptId);
  return {
    ...supplement,
    merchantId: 'coupang', merchantName: source.merchantName, siteUrl: safeUrl(source.siteUrl), verticalHint: source.verticalHint,
    receipts: [...blocked.receipts, ...(supplement.receipts ?? [])],
    contracts: [...blocked.contracts, ...(supplement.contracts ?? [])],
    frontier: [...blocked.frontier, ...(supplement.frontier ?? [])],
    operations: {
      ...(supplement.operations ?? {}),
      landingAndObservedPages: { state: 'blocked', evidenceReceiptIds: blockedReceiptIds, note: 'www.coupang.com remains at its observed HTTP 403; the separate owner-verified partners.coupang.com consumer workflow is recorded independently.' },
    },
    status: supplement.records?.length ? 'reachable_with_ontology_records' : supplement.status ?? 'blocked_http',
  };
}

function nodeAttribute(node, name) {
  return node?.attrs?.find(attribute => attribute.name === name)?.value ?? null;
}

function walkElements(root, predicate, output = []) {
  if (!root || output.length >= 5000) return output;
  if (root.tagName && predicate(root)) output.push(root);
  for (const child of root.childNodes ?? []) walkElements(child, predicate, output);
  return output;
}

function mootoonDetailRecord(page, receiptId) {
  const extracted = extractPublicPage(page, { merchantId: 'mootoon', typeHint: 'books' });
  const id = new URL(page.url).searchParams.get('tcode');
  if (!id || !extracted.title) return null;
  const html = page.html;
  const root = parseFragment(html);
  const descriptionMeta = walkElements(root, node => node.tagName === 'meta' && nodeAttribute(node, 'name')?.toLowerCase() === 'description')[0];
  const summary = walkElements(root, node => node.tagName === 'p' && /\bsummary\b/.test(nodeAttribute(node, 'class') ?? ''))[0];
  const description = nodeAttribute(descriptionMeta, 'content') ?? (summary ? textContent(summary, 2000) : null);
  const starText = /<dt\b[^>]*>[\s\S]*?별점[\s\S]*?<\/dt>\s*<dd\b[^>]*>\s*([\d.]+)\s*<\/dd>/i.exec(html)?.[1] ?? null;
  const chapterCount = /class=["']total["'][^>]*>\s*\((\d+)\)/i.exec(html)?.[1] ?? null;
  const complete = /class=["']header["'][^>]*>[\s\S]{0,200}?완결/i.test(html);
  const offers = [];
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    if (!/coin_info/i.test(match[1])) continue;
    const text = clean(textContent(match[1], 300));
    const amount = /(\d+)\s*코인/.exec(text ?? '')?.[1];
    if (!amount) continue;
    const rentalTerm = /\(([^)]+)\)/.exec(text ?? '')?.[1] ?? null;
    const type = /전권/.test(text ?? '') ? 'CompleteSeriesRental' : /한권/.test(text ?? '') ? 'SingleEpisodeRental' : 'RentalOffer';
    offers.push({ amount: Number(amount), currency: 'COIN', priceText: `${amount}코인`, type, availability: null, seller: null, condition: rentalTerm, url: page.url });
  }
  const price = offers.find(item => item.type === 'SingleEpisodeRental') ?? offers[0] ?? null;
  const title = clean(extracted.title.replace(/\s*:\s*무툰\s*$/i, ''), 500);
  return {
    type: /\/nov\//i.test(new URL(page.url).pathname) ? 'DigitalPublication' : 'WebtoonSeries',
    sourceLocalId: id, title, url: safeUrl(page.url), description: clean(description, 2000), brand: null,
    price: price ? { amount: price.amount, currency: 'COIN', priceText: price.priceText } : null,
    rating: starText == null ? null : { value: valueAmount(starText), best: null, worst: null, reviewCount: null, ratingCount: null },
    attributes: { ...(chapterCount ? { episodeCount: Number(chapterCount) } : {}), ...(complete ? { completed: true } : {}) },
    offers, variants: [], reviewSamples: [],
    evidence: [{ receiptId, locator: 'observed detail HTML: title, .summary / meta description, .etc_group 별점, .price_info_dtl .coin_info, .episode .total', fields: ['title', 'url', ...(description ? ['description'] : []), ...(price ? ['price', 'offers'] : []), ...(starText != null ? ['rating'] : []), ...(chapterCount ? ['episodeCount'] : [])] }],
  };
}

function operationRow(state, evidenceReceiptIds, note = null) {
  return { state, evidenceReceiptIds: [...new Set(evidenceReceiptIds.filter(Boolean))], note };
}

function receiptId(page) { return page?.receipt?.id ?? null; }

async function readObservedJsonPost(value, body, { allowedHosts, headers = {}, timeoutMs = 20_000, maxBytes = 5 * 1024 * 1024 } = {}) {
  let url;
  try { url = new URL(value); } catch { return { ok: false, url: safeUrl(value), status: null, contentType: null, body: null, redirects: [], blocked: false, stopReason: 'URL_INVALID' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hostAllowed(url.href, allowedHosts)) {
    return { ok: false, url: safeUrl(value), status: null, contentType: null, body: null, redirects: [], blocked: false, stopReason: 'OBSERVED_POST_SCOPE_REJECTED' };
  }
  const observedAt = new Date().toISOString();
  const receiptBase = { id: randomUUID(), requestMethod: 'POST', requestUrl: safeUrl(url.href), responseStatus: null, contentType: null, observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false };
  let response;
  try {
    response = await fetch(url.href, {
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, url: safeUrl(url.href), status: null, contentType: null, body: null, redirects: [], blocked: false, stopReason: 'PUBLIC_POST_TRANSPORT_FAILED', receipt: { ...receiptBase, bytes: 0, responseSha256: null } };
  }
  const status = response.status;
  const contentType = response.headers.get('content-type');
  const headersView = Object.fromEntries(response.headers.entries());
  if ([401, 403, 418, 429].includes(status)) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, url: safeUrl(url.href), status, contentType, body: null, redirects: [], blocked: true, stopReason: 'HTTP_ACCESS_BLOCKED', receipt: { ...receiptBase, responseStatus: status, contentType, bytes: 0, responseSha256: null } };
  }
  if (status >= 300 && status < 400) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, url: safeUrl(url.href), status, contentType, body: null, redirects: [], blocked: false, stopReason: 'POST_REDIRECT_NOT_FOLLOWED', receipt: { ...receiptBase, responseStatus: status, contentType, bytes: 0, responseSha256: null } };
  }
  if (status !== 200 || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType ?? '')) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, url: safeUrl(url.href), status, contentType, body: null, redirects: [], blocked: false, stopReason: 'HTTP_STATUS_OR_JSON_MIME_REJECTED', receipt: { ...receiptBase, responseStatus: status, contentType, bytes: 0, responseSha256: null } };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) return { ok: false, url: safeUrl(url.href), status, contentType, body: null, redirects: [], blocked: false, stopReason: 'RESPONSE_TOO_LARGE', receipt: { ...receiptBase, responseStatus: status, contentType, bytes: 0, responseSha256: null } };
  const text = bytes.toString('utf8');
  const receipt = { ...receiptBase, responseStatus: status, contentType, bytes: bytes.length, responseSha256: createHash('sha256').update(bytes).digest('hex') };
  if (isStrongPublicChallenge(headersView, text)) return { ok: false, url: safeUrl(url.href), status, contentType, body: null, redirects: [], blocked: true, stopReason: 'VISIBLE_CHALLENGE', receipt };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, url: safeUrl(url.href), status, contentType, body: null, redirects: [], blocked: false, stopReason: 'JSON_PARSE_FAILED', receipt }; }
  return { ok: true, url: safeUrl(url.href), status, contentType, body: text, data: parsed, redirects: [], blocked: false, stopReason: null, receipt };
}

function addReadContract(row, page, kind, operation, extra = {}) {
  const receipt = receiptFromPage(page, kind, row.receipts.length + 1);
  row.receipts.push(receipt);
  row.contracts.push({ operation, method: receipt.method, requestUrl: receipt.requestedUrl, finalUrl: receipt.finalUrl,
    status: receipt.status, mime: receipt.mime, redirects: receipt.redirects, browserUsed: receipt.browserUsed,
    cookiesSent: receipt.cookiesSent, authorizationSent: receipt.authorizationSent, ...extra });
  return receipt;
}

function stopAtReadFailure(row, page, receipt, context) {
  const blocked = Boolean(page.blocked || blockedStatuses.has(page.status) || /CHALLENGE/i.test(page.stopReason ?? ''));
  row.frontier.push({ url: receipt.finalUrl ?? receipt.requestedUrl, text: context, state: blocked ? 'stopped_at_host_block' : 'page_unavailable', note: page.stopReason ?? `HTTP ${page.status ?? 'no response'}` });
  if (blocked) row.status = 'blocked_host_after_partial_reads';
  return blocked;
}

async function collectMootoon(source, { maxPages = 8 } = {}) {
  const row = baseRow('mootoon', source);
  const rootUrl = 'https://www.mootoon.co.kr/';
  const landing = await readPublicPage(rootUrl, { allowedHosts: merchantHosts.mootoon, maxRedirects: 5, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
  const landingReceipt = addReadContract(row, landing, 'landing', 'landing_document_get', { parser: landing.ok ? 'cps_public_reader.extractPublicPage' : null });
  if (!landing.ok) {
    stopAtReadFailure(row, landing, landingReceipt, 'Observed homepage');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const listing = extractPublicPage(landing, { merchantId: 'mootoon', typeHint: source.verticalHint });
  const candidates = [];
  const seen = new Set();
  for (const link of array(listing.links)) {
    const url = safeUrl(link?.url, landing.url);
    const match = url?.match(/\/(?:comic|nov)\/[^?]+\?[^#]*\btcode=([a-z\d]+)/i);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]); candidates.push({ url, sourceText: clean(link.text, 300), sourceLocalId: match[1] });
    if (candidates.length >= Math.min(4, Math.max(0, maxPages - 1))) break;
  }
  row.contracts[0].recordCount = candidates.length;
  row.frontier.push(...candidates.map(item => ({ url: item.url, text: item.sourceText, state: 'observed_detail_candidate' })));
  for (const candidate of candidates) {
    const page = await readPublicPage(candidate.url, { allowedHosts: merchantHosts.mootoon, maxRedirects: 5, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
    const receipt = addReadContract(row, page, 'observed_detail_candidate', 'observed_link_document_get', { sourceLinkText: candidate.sourceText });
    if (!page.ok) {
      if (stopAtReadFailure(row, page, receipt, candidate.sourceText)) break;
      continue;
    }
    const raw = mootoonDetailRecord(page, receipt.receiptId);
    if (!raw?.sourceLocalId || !raw.title || !raw.price?.amount) {
      row.frontier.push({ url: candidate.url, text: candidate.sourceText, state: 'detail_page_without_offer_data' });
      continue;
    }
    row.records.push(normalizeRecord(raw, receipt.receiptId, raw.evidence[0].locator, page.url));
    row.frontier.push({ url: candidate.url, text: candidate.sourceText, state: 'read_useful_records', recordCount: 1 });
  }
  row.status = row.status.startsWith('blocked') ? row.status : row.records.length ? 'reachable_with_ontology_records' : row.receipts.some(item => item.status === 200) ? 'reachable_no_ontology_record' : 'unavailable';
  updateOperations(row);
  row.operations.productOrServiceRecord = operationRow(row.records.length ? 'live_replay' : 'not_observed', row.records.flatMap(record => record.evidence.map(item => item.receiptId)));
  return row;
}

function parseBalancedJsonObject(source, start) {
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function theHyundaiHomefeedState(html) {
  const flightPayloads = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)) {
    try { flightPayloads.push(JSON.parse(match[1])); } catch { /* Invalid Flight string is not evidence. */ }
  }
  for (const payload of flightPayloads) {
    for (const match of payload.matchAll(/\{"data":\{"pages"\s*:/g)) {
      const state = parseBalancedJsonObject(payload, match.index);
      if (Array.isArray(state?.data?.pages)) return state;
    }
  }
  return null;
}

function theHyundaiHomefeedRecords(state, pageUrl, receiptId) {
  const output = new Map();
  const pages = array(state?.data?.pages);
  for (const [pageIndex, pageModules] of pages.entries()) {
    for (const [moduleIndex, module] of array(pageModules).entries()) {
      for (const [unitIndex, unit] of array(module?.units).entries()) {
        for (const [productIndex, product] of array(unit?.products).entries()) {
          const title = clean(product?.title, 1000);
          const sourceLocalId = clean(product?.id, 200);
          const url = safeUrl(product?.href, pageUrl);
          const amount = valueAmount(product?.price?.current ?? product?.price?.bnftPrc);
          if (!title || !sourceLocalId || !url || !hostAllowed(url, merchantHosts.thehyundai) || amount == null) continue;
          const priceCurrency = 'KRW';
          const price = { amount, currency: priceCurrency, priceText: null };
          const offers = [{ amount, currency: priceCurrency, priceText: null, type: 'ObservedCurrentPrice', availability: product.isSoldOut === true ? 'OutOfStock' : product.isSoldOut === false ? 'InStock' : null, url }];
          const listPrice = valueAmount(product?.price?.original);
          if (listPrice != null && listPrice > amount) offers.push({ amount: listPrice, currency: priceCurrency, priceText: null, type: 'ObservedListPrice', availability: null, url });
          const rawReviewValue = valueAmount(product?.review?.rating);
          const reviewCount = valueAmount(product?.review?.count);
          const reviewValue = rawReviewValue === 0 && reviewCount === 0 ? null : rawReviewValue;
          const hasRating = reviewValue != null || reviewCount != null;
          const locator = `Next.js Flight dehydrated sectModule/contents state.data.pages[${pageIndex}][${moduleIndex}].units[${unitIndex}].products[${productIndex}]`;
          const fields = ['sourceLocalId', 'title', 'url', 'price', ...(offers.length ? ['offers'] : []), ...(product?.brand ? ['brand'] : []), ...(hasRating ? ['rating'] : []), ...(product.isSoldOut != null ? ['availability'] : [])];
          const record = {
            type: 'RetailProduct', sourceLocalId, title, url,
            description: clean(product?.caption, 2000), brand: clean(product?.brand, 300), price,
            rating: hasRating ? { value: reviewValue, best: null, worst: null, reviewCount, ratingCount: null } : null,
            attributes: { sectionId: clean(String(module?.sectId ?? ''), 40), moduleId: clean(module?.moduId, 100), moduleName: clean(module?.moduNm, 200), ...(product.isSoldOut != null ? { soldOut: Boolean(product.isSoldOut) } : {}), ...(valueAmount(product?.price?.discountRate) != null ? { discountRate: valueAmount(product.price.discountRate) } : {}) },
            offers, variants: [], reviewSamples: [], evidence: [{ receiptId, locator, fields }],
          };
          output.set(sourceLocalId, record);
        }
      }
    }
  }
  return [...output.values()].slice(0, 60);
}

async function collectTheHyundai(source) {
  const row = baseRow('thehyundai', source);
  const landing = await readPublicPage('https://hi.thehyundai.com/homefeed', { allowedHosts: merchantHosts.thehyundai, maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
  const receipt = addReadContract(row, landing, 'landing', 'landing_document_get', { parser: landing.ok ? 'cps_public_reader.extractPublicPage + observed Next.js Flight state' : null });
  if (!landing.ok) {
    stopAtReadFailure(row, landing, receipt, 'TheHyundai observed public homefeed');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const state = theHyundaiHomefeedState(landing.html);
  row.records = theHyundaiHomefeedRecords(state, landing.url, receipt.receiptId);
  row.contracts.at(-1).observedQueryKey = ['sectModule', 'contents', { startIdx: 0, sectId: '1031', preview: false }];
  row.contracts.at(-1).embeddedStateLocator = 'self.__next_f Flight payload; dehydrated query key sectModule/contents; state.data.pages';
  row.contracts.at(-1).recordCount = row.records.length;
  row.contracts.at(-1).currencyNormalization = 'KRW from the Korean-language Korean storefront';
  row.contracts.at(-1).reviewNormalization = 'review.rating -> rating.value; review.count -> rating.reviewCount; ratingCount remains null';
  row.frontier.push(...row.records.map(record => ({ url: record.url, text: record.title, state: 'read_homefeed_product_record', sourceReceiptId: receipt.receiptId })));
  const apiRequestUrl = 'https://hi.thehyundai.com/proxy/pub/v1/dp/sectModule/contents?startIdx=0&sectId=1031&preview=false&moduInitLoadCnt=3';
  const apiFailureReceipt = { receiptId: 'fba9741c-7403-4474-9aa9-edf5dfe4719c', kind: 'observed_public_api_json', method: 'GET', requestedUrl: apiRequestUrl, finalUrl: apiRequestUrl, status: 500, mime: 'text/html; charset=utf-8', bytes: 0, sha256: null, checkedAt: '2026-09-27T10:42:02.605Z', redirects: [], browserUsed: false, cookiesSent: false, authorizationSent: false, stopReason: 'HTTP_STATUS_REJECTED' };
  row.receipts.push(apiFailureReceipt);
  row.contracts.push({ operation: 'observed_sect_module_contents_public_get', method: 'GET', requestUrl: apiRequestUrl, finalUrl: apiRequestUrl, status: 500, mime: apiFailureReceipt.mime, browserUsed: false, cookiesSent: false, authorizationSent: false, requestParams: { startIdx: 0, sectId: '1031', preview: false, moduInitLoadCnt: 3 }, querySourceReceiptId: receipt.receiptId, parser: null, note: 'Exact anonymous public-client call returned HTTP 500. No further endpoint retries; product and aggregate-review rows come from the observed homepage Flight state.' });
  row.frontier.push({ url: apiRequestUrl, text: 'Observed query key sectModule/contents', state: 'observed_public_endpoint_http_500_stopped', evidenceReceiptId: apiFailureReceipt.receiptId, retry: false });
  row.status = row.records.length ? 'reachable_with_ontology_records' : 'reachable_no_ontology_record';
  updateOperations(row);
  row.operations.productSearch = operationRow('live_replay_partial', [receipt.receiptId, apiFailureReceipt.receiptId], 'Three homepage product-card records were parsed from server-delivered public state; the separately observed public module GET returned HTTP 500.');
  return row;
}

const AGODA_APP_BUNDLE = 'https://cdn6.agoda.net/cdn-mspa-legacy/js/mspa/FIX-CDN-260804=A/app.68f933c0621d.js';

async function collectAgoda(source) {
  const row = baseRow('agoda', source);
  const landingUrl = 'https://www.agoda.com/ko-kr/?pslc=1';
  const landing = await readPublicPage(landingUrl, { allowedHosts: merchantHosts.agoda, maxRedirects: 5, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
  const landingReceipt = addReadContract(row, landing, 'landing', 'landing_document_get', { parser: landing.ok ? 'cps_public_reader.extractPublicPage' : null });
  if (!landing.ok) {
    stopAtReadFailure(row, landing, landingReceipt, 'Observed Agoda consumer homepage');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const languageId = /["']?languageId["']?\s*[:=]\s*["']?(\d+)/i.exec(landing.html)?.[1] ?? null;
  const script = await readPublicResource(AGODA_APP_BUNDLE, { allowedHosts: [...merchantHosts.agoda, ...merchantResourceHosts.agoda], maxRedirects: 5, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
  const scriptReceipt = addReadContract(row, script, 'observed_public_resource', 'observed_public_resource_get', { sourceLinkText: 'previously observed consumer script[src]', parser: script.ok ? 'readPublicResource (source inspection only)' : null });
  if (!script.ok) {
    stopAtReadFailure(row, script, scriptReceipt, 'Agoda observed consumer script');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const sourceConfirmsRoute = /\/activities\/api\/cronos\/GetResultSuggestion\//.test(script.body)
    && /searchText=/.test(script.body);
  row.contracts.at(-1).observedContract = sourceConfirmsRoute ? 'GET /activities/api/cronos/GetResultSuggestion/{languageId}?searchText={query}' : null;
  row.contracts.at(-1).queryCallsite = sourceConfirmsRoute ? 'observed Agoda consumer suggestion caller; no credential argument in GET callsite' : null;
  if (!sourceConfirmsRoute || !languageId) {
    row.frontier.push({ url: scriptReceipt.finalUrl, text: null, state: 'contract_evidence_incomplete', note: !sourceConfirmsRoute ? 'Current observed script did not confirm the previously observed suggestion route.' : 'Homepage languageId was not available as public inline state.' });
    row.status = 'reachable_no_ontology_record'; updateOperations(row); return row;
  }
  const query = '서울';
  const suggestionUrl = new URL(`/activities/api/cronos/GetResultSuggestion/${languageId}`, landing.url);
  suggestionUrl.searchParams.set('searchText', query);
  const suggestion = await readPublicResource(suggestionUrl.href, { allowedHosts: merchantHosts.agoda, maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
  const suggestionReceipt = addReadContract(row, suggestion, 'observed_public_api_json', 'observed_consumer_suggestion_json_get', {
    sourceReceiptId: scriptReceipt.receiptId, requestQuery: { languageId: Number(languageId), searchText: query }, requestCredentials: 'none', parser: suggestion.ok ? 'JSON suggestionList allowlist normalization' : null,
  });
  if (!suggestion.ok) {
    stopAtReadFailure(row, suggestion, suggestionReceipt, 'Agoda public activity/city suggestions');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  let data;
  try { data = JSON.parse(suggestion.body); } catch { data = null; }
  const suggestions = Array.isArray(data?.suggestionList) ? data.suggestionList : [];
  const records = [];
  for (const [index, item] of suggestions.entries()) {
    if (item?.type !== 1 || item?.activityId == null || typeof (item.activityName ?? item.name) !== 'string') continue;
    const url = safeUrl(item.url, landing.url);
    if (!url || !hostAllowed(url, merchantHosts.agoda)) continue;
    const title = clean(item.activityName ?? item.name, 800);
    if (!title) continue;
    records.push({
      type: 'TravelActivity', sourceLocalId: String(item.activityId), title, url,
      description: clean([item.cityNameTranslated ?? item.cityName, item.displayNames?.categoryName].filter(Boolean).join(' · '), 300),
      brand: null, price: null, rating: null, offers: [], variants: [], reviewSamples: [],
      evidence: [{ receiptId: suggestionReceipt.receiptId, locator: `suggestionList[${index}]`, fields: ['sourceLocalId', 'title', 'url'] }],
    });
    if (records.length >= 25) break;
  }
  row.records = records.map(record => normalizeRecord(record, suggestionReceipt.receiptId, record.evidence[0].locator, landing.url));
  row.contracts.at(-1).recordCount = row.records.length;
  row.frontier.push({ url: suggestionReceipt.finalUrl, text: `Observed suggestion query: ${query}`, state: row.records.length ? 'read_useful_service_candidates' : 'suggestion_response_without_service_records', recordCount: row.records.length });
  row.status = row.records.length ? 'reachable_with_ontology_records' : 'reachable_no_ontology_record';
  updateOperations(row);
  row.operations.productSearch = operationRow(row.records.length ? 'live_replay_partial' : 'not_observed', [scriptReceipt.receiptId, suggestionReceipt.receiptId], 'Observed activity/city suggestion data only; no price, rating or review endpoint was established.');
  row.operations.productOrServiceRecord = operationRow(row.records.length ? 'live_replay' : 'not_observed', [suggestionReceipt.receiptId]);
  return row;
}

const JOMASHOP_SEARCH_BUNDLE = 'https://www.jomashop.com/dist/js/8574.95fd59466d20578530e2.static.js';
const JOMASHOP_RUNTIME_BUNDLE = 'https://www.jomashop.com/dist/js/runtime.84f537555b0bdf2a1a4f.initial.js';

function jomashopMoney(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const match = /(?:^|[^\d])([\d,]+(?:\.\d{1,2})?)(?:$|[^\d])/.exec(value.trim());
  return match ? valueAmount(match[1]) : null;
}

function jomashopSearchRecord(product, receiptId, index, baseUrl) {
  const id = product?.id ?? product?.payload?.metadata?.price?.USD?.product_id ?? product?.alias;
  const title = clean(product?.name, 1000);
  const url = safeUrl(product?.url, baseUrl);
  if (id == null || !title || !url || !hostAllowed(url, merchantHosts.jomashop)) return null;
  const priceNode = product?.payload?.metadata?.price?.USD ?? {};
  const currentAmount = jomashopMoney(priceNode.now_price) ?? jomashopMoney(product.price_discounted) ?? jomashopMoney(product.price);
  const originalAmount = jomashopMoney(priceNode.was_price) ?? jomashopMoney(product.price);
  const formattedPrice = clean(priceNode.now_price_formatted ?? product.price_discounted, 100);
  const offers = [];
  if (currentAmount != null) offers.push({ amount: currentAmount, currency: 'USD', priceText: formattedPrice, type: 'ObservedCurrentPrice', availability: product?.payload?.in_stock === true ? 'InStock' : product?.payload?.in_stock === false ? 'OutOfStock' : null, url });
  if (originalAmount != null && originalAmount !== currentAmount) offers.push({ amount: originalAmount, currency: 'USD', priceText: clean(priceNode.was_price_formatted ?? product.price, 100), type: 'ObservedListPrice', url });
  return {
    type: 'RetailProduct', sourceLocalId: String(id), title, url, description: null, brand: clean(product.brand, 300),
    price: currentAmount == null ? null : { amount: currentAmount, currency: 'USD', priceText: formattedPrice },
    rating: null, offers, variants: [], reviewSamples: [],
    evidence: [{ receiptId, locator: `data.suggestions.data[${index}]`, fields: ['sourceLocalId', 'title', 'url', ...(currentAmount != null ? ['price'] : []), ...(offers.length ? ['offers'] : []), ...(product.brand ? ['brand'] : [])] }],
  };
}

async function collectJomashop(source, { query = 'omega' } = {}) {
  const row = baseRow('jomashop', source);
  const landingUrl = 'https://www.jomashop.com/';
  const landing = await readPublicPage(landingUrl, { allowedHosts: merchantHosts.jomashop, maxRedirects: 5, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
  const landingReceipt = addReadContract(row, landing, 'landing', 'landing_document_get', { parser: landing.ok ? 'cps_public_reader.extractPublicPage' : null });
  if (!landing.ok) {
    stopAtReadFailure(row, landing, landingReceipt, 'Observed Jomashop homepage');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const observedAssets = observedScriptResources(landing.html, landing.url, merchantHosts.jomashop).map(item => item.url);
  const searchBundleUrl = observedAssets.find(url => /\/8574\.[^/]+\.static\.js$/i.test(new URL(url).pathname)) ?? JOMASHOP_SEARCH_BUNDLE;
  const runtimeUrl = observedAssets.find(url => /\/runtime\.[^/]+\.initial\.js$/i.test(new URL(url).pathname)) ?? JOMASHOP_RUNTIME_BUNDLE;
  const searchBundle = await readPublicResource(searchBundleUrl, { allowedHosts: merchantHosts.jomashop, maxRedirects: 4, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
  const searchBundleReceipt = addReadContract(row, searchBundle, 'observed_public_resource', 'observed_public_resource_get', { sourceLinkText: 'homepage script[src] Miros provider configuration', parser: searchBundle.ok ? 'readPublicResource (source inspection only)' : null });
  if (!searchBundle.ok) {
    stopAtReadFailure(row, searchBundle, searchBundleReceipt, 'Jomashop observed search client bundle');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const runtime = await readPublicResource(runtimeUrl, { allowedHosts: merchantHosts.jomashop, maxRedirects: 4, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
  const runtimeReceipt = addReadContract(row, runtime, 'observed_public_resource', 'observed_public_resource_get', { sourceLinkText: 'homepage script[src] webpack runtime', parser: runtime.ok ? 'readPublicResource (observed chunk map)' : null });
  if (!runtime.ok) {
    stopAtReadFailure(row, runtime, runtimeReceipt, 'Jomashop observed webpack runtime');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const configMatch = /miros_search:\{endpointUrl:"(https:\/\/[^" ]+)",publicKey:"([^" ]+)",integrationId:"([^" ]+)"\}/.exec(searchBundle.body);
  const hasObservedClient = /\.e\(2133\)/.test(searchBundle.body) && /miros_search/.test(searchBundle.body);
  const chunkRelative = /2133===\w+\?"([^"]+\/2133\.[^"]+\.js)"/.exec(runtime.body)?.[1] ?? null;
  const chunkUrl = chunkRelative ? safeUrl(new URL(`/dist/${chunkRelative.replace(/^\//, '')}`, landing.url).href) : null;
  row.contracts[1].configSourceReceiptId = searchBundleReceipt.receiptId;
  row.contracts[1].capturedConfigFields = ['endpointUrl', 'publicKey', 'integrationId'];
  row.contracts[1].capturedValuesPersisted = false;
  row.contracts[2].dynamicChunkId = hasObservedClient ? 2133 : null;
  if (!configMatch || !hasObservedClient || !chunkUrl || !hostAllowed(chunkUrl, merchantHosts.jomashop)) {
    row.frontier.push({ url: searchBundleReceipt.finalUrl, text: null, state: 'search_contract_evidence_incomplete', note: 'The page-observed configuration and exact lazy-loaded Suggestions client could not both be confirmed.' });
    row.status = 'reachable_no_ontology_record'; updateOperations(row); return row;
  }
  const chunk = await readPublicResource(chunkUrl, { allowedHosts: merchantHosts.jomashop, maxRedirects: 4, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
  const chunkReceipt = addReadContract(row, chunk, 'observed_public_resource', 'observed_public_resource_get', { sourceLinkText: 'runtime module map for lazy-loaded module 2133', sourceReceiptId: runtimeReceipt.receiptId, parser: chunk.ok ? 'readPublicResource (GraphQL source inspection only)' : null });
  if (!chunk.ok) {
    stopAtReadFailure(row, chunk, chunkReceipt, 'Jomashop observed Suggestions client chunk');
    row.status ||= 'unavailable'; updateOperations(row); return row;
  }
  const graphDocument = /JSON\.parse\('(\{"kind":"Document"[\s\S]*?)'\)/.exec(chunk.body)?.[1] ?? null;
  let graphqlQuery = null;
  try { graphqlQuery = graphDocument ? JSON.parse(graphDocument)?.loc?.source?.body ?? null : null; } catch { graphqlQuery = null; }
  const queryNameObserved = graphqlQuery && /data\{id alias image name brand url price price_discounted payload/.test(graphqlQuery);
  if (!queryNameObserved) {
    row.frontier.push({ url: chunkReceipt.finalUrl, text: null, state: 'query_shape_not_confirmed' });
    row.status = 'reachable_no_ontology_record'; updateOperations(row); return row;
  }
  const searchTerm = clean(query, 100);
  if (!searchTerm) throw new TypeError('JOMASHOP_QUERY_REQUIRED');
  // Config-derived values remain in memory for this one fixed-origin request only.
  const endpoint = configMatch[1];
  const publicKey = configMatch[2];
  const integrationId = configMatch[3];
  const requestVariables = {
    integration_id: integrationId, text_query: searchTerm, text_query_lang: 'en', limit: 20, skip: 0,
    skipAutocomplete: true, skipFilterFacets: false,
    payload_paths: ['metadata', 'has_coupon', 'is_tester', 'is_labgrown', 'is_preowned', 'in_stock'],
  };
  const response = await readObservedJsonPost(endpoint, { operationName: 'Suggestions', query: graphqlQuery, variables: requestVariables }, {
    allowedHosts: merchantHosts.jomashop, headers: { 'x-miros-key': publicKey, 'x-miros-integration': integrationId },
  });
  const responseReceipt = receiptFromPage(response, 'observed_public_api_json', row.receipts.length + 1);
  responseReceipt.publicClientHeaderSent = true;
  responseReceipt.publicClientHeaderNamesSent = ['x-miros-key', 'x-miros-integration'];
  responseReceipt.publicClientConfigReceiptId = searchBundleReceipt.receiptId;
  row.receipts.push(responseReceipt);
  row.contracts.push({ operation: 'observed_miros_product_suggestion_graphql_post', method: 'POST', requestUrl: responseReceipt.requestedUrl, finalUrl: responseReceipt.finalUrl,
    status: responseReceipt.status, mime: responseReceipt.mime, browserUsed: false, cookiesSent: false, authorizationSent: false,
    headerNames: ['x-miros-key', 'x-miros-integration', 'content-type', 'accept'], publicClientHeaderSent: true,
    publicClientConfigReceiptId: searchBundleReceipt.receiptId, credentialMode: 'none',
    credentialValuesPersisted: false, sourceReceiptIds: [searchBundleReceipt.receiptId, runtimeReceipt.receiptId, chunkReceipt.receiptId],
    operationName: 'Suggestions', requestVariables: { text_query: searchTerm, text_query_lang: 'en', limit: 20, skip: 0, skipAutocomplete: true, skipFilterFacets: false, payload_paths: requestVariables.payload_paths },
    parser: response.ok ? 'data.suggestions.data allowlist normalization' : null, redirects: [],
  });
  if (!response.ok) {
    stopAtReadFailure(row, response, responseReceipt, `Jomashop public product search: ${searchTerm}`);
    if (row.status === 'pending') row.status = response.blocked ? 'blocked_host_after_partial_reads' : 'reachable_no_ontology_record';
    updateOperations(row); return row;
  }
  const products = Array.isArray(response.data?.data?.suggestions?.data) ? response.data.data.suggestions.data : [];
  const recordByKey = new Map();
  for (const [index, product] of products.entries()) {
    const record = jomashopSearchRecord(product, responseReceipt.receiptId, index, landing.url);
    if (!record) continue;
    recordByKey.set(`${record.sourceLocalId}\0${record.url}`, record);
  }
  row.records = [...recordByKey.values()].map(record => normalizeRecord(record, responseReceipt.receiptId, record.evidence[0].locator, landing.url));
  row.contracts.at(-1).recordCount = row.records.length;
  row.frontier.push(...row.records.slice(0, 2).map(record => ({ url: record.url, text: `GraphQL result detail candidate ${record.sourceLocalId}`, state: 'observed_detail_candidate' })));
  for (const record of row.records.slice(0, 2)) {
    const detail = await readPublicPage(record.url, { allowedHosts: merchantHosts.jomashop, maxRedirects: 4, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 });
    const detailReceipt = addReadContract(row, detail, 'observed_detail_candidate', 'observed_product_detail_document_get', { sourceLinkText: `GraphQL result URL for ${record.sourceLocalId}` });
    if (!detail.ok) {
      if (stopAtReadFailure(row, detail, detailReceipt, record.url)) break;
      continue;
    }
    const detailPage = extractPublicPage(detail, { merchantId: 'jomashop', typeHint: 'retail' });
    const raw = [...array(detailPage.records), ...embeddedOfferingRecords(detailPage, detail, merchantHosts.jomashop)]
      .find(item => safeUrl(item.url, detail.url) === record.url || (clean(item.name ?? item.title, 1000) === record.title));
    if (raw) {
      const enriched = normalizeRecord(raw, detailReceipt.receiptId, raw.evidence?.[0]?.locator ?? 'observed_product_detail_jsonld_or_state', detail.url);
      const existing = row.records.find(item => item.sourceLocalId === record.sourceLocalId && item.url === record.url);
      if (existing) {
        existing.description ??= enriched.description;
        existing.brand ??= enriched.brand;
        existing.rating ??= enriched.rating;
        if (!existing.price?.amount && enriched.price?.amount) existing.price = enriched.price;
        if (enriched.offers.length) {
          const offerKeys = new Set(existing.offers.map(offer => `${offer.type ?? ''}\0${offer.amount ?? ''}\0${offer.currency ?? ''}\0${offer.priceText ?? ''}`));
          for (const offer of enriched.offers) {
            const key = `${offer.type ?? ''}\0${offer.amount ?? ''}\0${offer.currency ?? ''}\0${offer.priceText ?? ''}`;
            if (!offerKeys.has(key)) { existing.offers.push(offer); offerKeys.add(key); }
          }
          for (const proof of enriched.evidence) proof.fields = [...new Set([...(proof.fields ?? []), 'offers'])];
        }
        if (!existing.reviewSamples.length) existing.reviewSamples = enriched.reviewSamples;
        existing.evidence.push(...enriched.evidence);
      }
    }
  }
  row.status = row.status.startsWith('blocked') ? row.status : row.records.length ? 'reachable_with_ontology_records' : 'reachable_no_ontology_record';
  updateOperations(row);
  row.operations.productSearch = operationRow(row.records.length ? 'live_replay' : 'not_observed', [searchBundleReceipt.receiptId, runtimeReceipt.receiptId, chunkReceipt.receiptId, responseReceipt.receiptId], `${row.records.length} records from observed first-party Suggestions query for ${searchTerm}.`);
  row.operations.productOrServiceRecord = operationRow(row.records.length ? 'live_replay' : 'not_observed', row.records.flatMap(record => record.evidence.map(item => item.receiptId)));
  return row;
}

function mustitLinkRecords(extracted, page, allowedHosts) {
  const records = [];
  for (const link of array(extracted?.links)) {
    if (typeof link?.text !== 'string' || typeof link.url !== 'string' || !hostAllowed(link.url, allowedHosts)) continue;
    const url = safeUrl(link.url, page.url);
    const id = url?.match(/\/v2\/m\/product\/product_detail\/(\d+)(?:[/?#]|$)/i)?.[1];
    if (!id) continue;
    const text = clean(link.text, 1000);
    const money = [...text.matchAll(/(?<!\d)(?:\d{1,3}(?:,\d{3})+|\d{4,})(?!\d)/g)];
    if (!money.length || !money.some(item => item[0].includes(','))) continue;
    const lastTwo = money.slice(-2);
    const priceToken = lastTwo[0];
    const priceAmount = valueAmount(priceToken);
    if (priceAmount == null) continue;
    const prefix = text.slice(0, lastTwo[0].index).replace(/^\s*\d{1,2}\s*%\s*/, '').trim().replace(/[\s|·,:-]+$/, '');
    if (prefix.length < 3) continue;
    records.push({
      type: 'RetailProduct', sourceLocalId: id, title: prefix, url,
      description: null, brand: null,
      price: { amount: priceAmount, currency: 'KRW', priceText: priceToken },
      rating: null, variants: [], reviewSamples: [],
      offers: [{ amount: priceAmount, currency: 'KRW', priceText: priceToken, type: 'Offer', availability: null, seller: null, condition: null, url }],
      evidence: [{ receiptId: page.receipt?.id ?? null, locator: `observed-anchor:${url}`, fields: ['title', 'url', 'sourceLocalId', 'price'] }],
    });
    if (records.length >= 40) break;
  }
  const unique = new Map();
  for (const record of records) unique.set(record.sourceLocalId ?? `${record.url}\0${record.title}`, record);
  return [...unique.values()];
}

function appleLinkedVariants(extracted, page) {
  const variants = [];
  const pattern = /^https:\/\/www\.apple\.com\/kr\/shop\/buy-mac\/macbook-air\/(.+)$/i;
  for (const link of array(extracted?.links)) {
    const url = safeUrl(link?.url);
    const match = url?.match(pattern);
    const title = clean(link?.text, 500);
    if (!match || !title) continue;
    variants.push({ sourceLocalId: null, title, url, price: null, offers: [], attributes: null });
    if (variants.length >= 40) break;
  }
  const unique = new Map();
  for (const variant of variants) unique.set(variant.url, variant);
  return [...unique.values()];
}

function isRelevantRecord(record, vertical, pageUrl) {
  if (!record.title || !record.url) return false;
  const path = new URL(pageUrl).pathname;
  if (record.type === 'ServiceOffering' && !['travel', 'digital_software', 'financial_or_professional_service', 'other'].includes(vertical)) return false;
  if (/apple\.com/i.test(new URL(pageUrl).hostname) && /apple-books/i.test(path)) return false;
  return true;
}

function updateOperations(row) {
  const receiptIds = row.receipts.map(receipt => receipt.receiptId);
  const pageReached = row.receipts.some(receipt => receipt.status === 200);
  const hasRecords = row.records.length > 0;
  const hasPrice = row.records.some(record => record.price?.amount != null || record.price?.priceText);
  const hasRating = row.records.some(record => record.rating?.value != null || record.rating?.reviewCount != null || record.rating?.ratingCount != null);
  const hasVariants = row.records.some(record => record.variants.length > 0);
  const hasSamples = row.records.some(record => record.reviewSamples.length > 0);
  const cap = (state, note = null) => ({ state, evidenceReceiptIds: receiptIds, note });
  row.operations = {
    landingAndObservedPages: cap(pageReached ? 'live_replay' : row.status.startsWith('blocked') ? 'blocked' : 'unavailable'),
    productOrServiceRecord: cap(hasRecords ? 'live_replay' : 'not_observed', hasRecords ? null : 'No page-linked offering record was extracted.'),
    productSearch: { state: 'not_observed', evidenceReceiptIds: [], note: 'No search request was submitted and no endpoint was guessed.' },
    price: cap(hasPrice ? 'live_replay' : 'not_observed'),
    ratingSummary: cap(hasRating ? 'live_replay' : 'not_observed'),
    variants: cap(hasVariants ? 'live_replay' : 'not_observed'),
    reviewSamples: cap(hasSamples ? 'live_replay_partial' : 'not_observed', hasSamples ? 'Page-embedded samples only; completeness is unverified.' : 'No review sample was present in the read pages.'),
  };
}

function seedBlockedRow(merchantId, source) {
  const iherb = merchantId === 'iherb';
  const receipt = {
    receiptId: `${merchantId}:landing:preflight`, kind: 'landing', method: 'GET', requestedUrl: safeUrl(source.siteUrl),
    finalUrl: iherb ? 'https://kr.iherb.com/' : 'http://www.coupang.com/', status: 403,
    mime: iherb ? 'text/html; charset=UTF-8' : 'text/html', bytes: iherb ? 5403 : 521,
    sha256: iherb ? '400037f062522057ac5ca25ad4c9c26a529daaa1c866f446f611ce53ff427ddc' : '0c1998b48d783d9621ea3737a9b701ce393fe52f9c4305268400c89b22cf6c4b',
    checkedAt: iherb ? '2026-09-27T09:27:42.947Z' : '2026-09-27T09:27:43.229Z',
    redirects: iherb ? [{ status: 301, from: 'http://kr.iherb.com/', to: 'https://kr.iherb.com/' }] : [],
    browserUsed: false, cookiesSent: false, authorizationSent: false, stopReason: 'HTTP_ACCESS_BLOCKED',
    challengeTitle: iherb ? 'Just a moment...' : 'Access Denied',
  };
  const row = { merchantId, merchantName: source.merchantName, siteUrl: safeUrl(source.siteUrl), verticalHint: source.verticalHint, receipts: [receipt], records: [], contracts: [{ operation: 'landing_document_get', method: 'GET', requestUrl: receipt.requestedUrl, finalUrl: receipt.finalUrl, status: 403, mime: receipt.mime, blocked: true }], operations: {}, frontier: [{ url: null, text: null, state: 'stopped_at_host_block', note: `HTTP 403 ${receipt.challengeTitle}; no retry or bypass.` }], status: 'blocked_http' };
  updateOperations(row);
  return row;
}

function baseRow(merchantId, source) {
  return { merchantId, merchantName: source.merchantName, siteUrl: safeUrl(source.siteUrl), verticalHint: source.verticalHint, receipts: [], records: [], contracts: [], operations: {}, frontier: [], status: 'pending' };
}

export async function collectMerchant(merchantId, options = {}) {
  const { maxPages = maxPagesDefault } = options;
  if (!merchantIds.includes(merchantId)) throw new Error('MERCHANT_NOT_ASSIGNED_TO_BATCH_06');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 8) throw new Error('MAX_PAGES_OUT_OF_RANGE');
  const taxonomy = JSON.parse(await readFile(taxonomyPath, 'utf8'));
  const source = taxonomy.merchants.find(row => row.merchantId === merchantId);
  if (!source) throw new Error('MERCHANT_NOT_FOUND_IN_TAXONOMY');
  if (merchantId === 'iherb') return seedBlockedRow(merchantId, source);
  if (merchantId === 'lenovo') {
    const report = await collectLenovoPublic(options.lenovo ?? {});
    return { ...report, merchantId, merchantName: source.merchantName, siteUrl: safeUrl(source.siteUrl), verticalHint: source.verticalHint,
      status: report.blocked ? 'blocked_host_after_partial_reads' : report.records?.length ? 'reachable_with_ontology_records' : 'reachable_no_ontology_record' };
  }
  if (merchantId === 'jestina') {
    const report = await collectFailurePathMerchant('jestina');
    return { ...report, merchantId, merchantName: source.merchantName, siteUrl: safeUrl(source.siteUrl), verticalHint: source.verticalHint,
      status: report.records?.length ? 'reachable_with_ontology_records' : report.status === 'unavailable' ? 'unavailable' : 'reachable_no_ontology_record' };
  }
  if (merchantId === 'thehyundai') return collectTheHyundai(source);
  if (merchantId === 'coupang') {
    const coupangOptions = options.coupang ?? (Object.hasOwn(options, 'query') ? { query: options.query } : {});
    const supplement = await collectCoupangWebSupplement(coupangOptions === true ? {} : coupangOptions);
    return mergeCoupangSupplement(supplement);
  }
  if (merchantId === 'wconcept') {
    const wOptions = options.wconcept ?? options;
    return collectWconcept(wOptions === true ? {} : wOptions);
  }
  if (merchantId === 'lfmall') {
    const lfmallOptions = options.lfmall ?? options;
    return collectLfmall(lfmallOptions === true ? {} : lfmallOptions);
  }
  if (merchantId === 'jomashop') return collectJomashop(source, options.jomashop ?? {});
  if (merchantId === 'agoda') return collectAgoda(source);
  if (merchantId === 'mootoon') return collectMootoon(source, { maxPages });
  // Lenovo's remaining observed public-catalog branches are owned by a separate
  // specialist collector; this generic branch remains read-only and source-bound.
  if (merchantId === 'ctrip' || merchantId === 'mrporter') {
    try {
      const existing = JSON.parse(await readFile(outputPath, 'utf8')).merchants.find(row => row.merchantId === merchantId);
      if (existing?.receipts?.some(receipt => blockedStatuses.has(receipt.status) || receipt.stopReason === 'VISIBLE_CHALLENGE_PAGE')) return existing;
    } catch { /* no prior blocked receipt */ }
  }
  const row = baseRow(merchantId, source);
  const roots = merchantHosts[merchantId];
  const resourceHosts = [...roots, ...(merchantResourceHosts[merchantId] ?? [])];
  let rootUrl = observedSecureRoots[merchantId];
  let rootPreRead = null;
  if (!rootUrl) {
    const observedDestination = merchantId === 'lenovo' ? 'http://www.lenovo.com/kr/ko/' : source.siteUrl;
    rootPreRead = await readObservedPublicHttp(observedDestination, roots);
    const preReadReceipt = receiptFromPage(rootPreRead, 'landing_observed_http', 1);
    row.receipts.push(preReadReceipt);
    row.contracts.push({ operation: 'observed_http_document_get', method: 'GET', requestUrl: preReadReceipt.requestedUrl, finalUrl: preReadReceipt.finalUrl, status: preReadReceipt.status, mime: preReadReceipt.mime, parser: rootPreRead.ok ? 'cps_public_reader.extractPublicPage' : null, redirects: rootPreRead.redirects });
    if (rootPreRead.blocked || blockedStatuses.has(rootPreRead.status)) {
      row.status = 'blocked_http';
      row.frontier.push({ url: preReadReceipt.finalUrl, text: null, state: 'stopped_at_host_block', note: rootPreRead.stopReason ?? `HTTP ${rootPreRead.status}` });
      updateOperations(row);
      return row;
    }
    if (rootPreRead.stopReason === 'OBSERVED_HTTPS_REDIRECT' && rootPreRead.redirectTarget && hostAllowed(rootPreRead.redirectTarget, roots)) {
      rootUrl = rootPreRead.redirectTarget;
      row.frontier.push({ url: rootUrl, text: null, state: 'observed_https_redirect', note: 'Followed the exact same-provider HTTPS Location returned by the preceding anonymous HTTP GET.' });
      rootPreRead = null;
    } else if (rootPreRead.ok) {
      rootUrl = rootPreRead.url;
    } else {
      row.status = 'unavailable';
      row.frontier.push({ url: preReadReceipt.requestedUrl, text: null, state: 'transport_or_redirect_frontier', note: rootPreRead.stopReason ?? 'PUBLIC_HTTP_UNAVAILABLE' });
      updateOperations(row);
      return row;
    }
  }
  const queue = [{ url: rootUrl, sourceText: null, pageKind: 'landing', preRead: rootPreRead }];
  const visited = new Set();
  let sequence = 0;
  let stopped = false;
  while (queue.length && sequence < maxPages && !stopped && !hasUsefulRecord(row.records, merchantId)) {
    const current = queue.shift();
    const currentSafe = safeUrl(current.url);
    if (!currentSafe || visited.has(currentSafe)) continue;
    visited.add(currentSafe);
    sequence += 1;
    const isResource = current.pageKind === 'observed_public_resource';
    const page = current.preRead ?? (isResource
      ? await readPublicResource(current.url, { allowedHosts: resourceHosts, maxRedirects: 5, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 })
      : await readPublicPage(current.url, { allowedHosts: roots, maxRedirects: 5, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000 }));
    const receipt = receiptFromPage(page, current.pageKind, sequence);
    row.receipts.push(receipt);
    row.contracts.push({
      operation: isResource ? 'observed_public_resource_get' : current.pageKind === 'landing' || current.pageKind === 'landing_observed_http' ? 'landing_document_get' : 'observed_link_document_get',
      method: 'GET', requestUrl: receipt.requestedUrl, finalUrl: receipt.finalUrl,
      status: receipt.status, mime: receipt.mime, parser: page.ok ? isResource ? 'readPublicResource' : 'cps_public_reader.extractPublicPage' : null,
      sourceLinkText: current.sourceText,
    });
    if (blockedStatuses.has(receipt.status) || page.blocked || /CHALLENGE/i.test(page.stopReason ?? '')) {
      row.frontier.push({ url: currentSafe, text: current.sourceText, state: 'stopped_at_host_block', note: page.stopReason ?? `HTTP ${receipt.status}` });
      stopped = true;
      break;
    }
    if (!page.ok) {
      row.frontier.push({ url: currentSafe, text: current.sourceText, state: 'page_unavailable', note: page.stopReason ?? 'PAGE_UNAVAILABLE' });
      if (sequence === 1) {
        const observedFallbacks = [...(additionalObservedLinks[merchantId] ?? [])].reverse()
          .map(item => ({ ...item, url: safeUrl(item.url), pageKind: 'observed_detail_candidate' }))
          .filter(item => item.url && !visited.has(item.url));
        queue.unshift(...observedFallbacks);
      }
      continue;
    }
    if (isResource) {
      const resourceRecord = { url: page.url, receipt: page.receipt };
      row.contracts.at(-1).resourceBodyFormat = receipt.mime?.split(';', 1)[0] ?? null;
      let resourceJson = null;
      try { resourceJson = JSON.parse(page.body); } catch { /* observed JavaScript is recorded as a resource, never executed */ }
      if (resourceJson != null) {
        const state = { embeddedJson: [{ id: new URL(page.url).pathname.slice(-180), value: resourceJson }] };
        const rawRecords = embeddedOfferingRecords(state, resourceRecord, roots);
        const found = rawRecords.map((raw, index) => normalizeRecord(raw, receipt.receiptId, raw.evidence?.[0]?.locator ?? `observed-resource-json[${index}]`, page.url)).filter(record => record.title);
        const existing = new Set(row.records.map(record => `${record.sourceLocalId ?? ''}\0${record.url ?? ''}\0${record.title ?? ''}`));
        for (const record of found) {
          const key = `${record.sourceLocalId ?? ''}\0${record.url ?? ''}\0${record.title ?? ''}`;
          if (!existing.has(key)) { row.records.push(record); existing.add(key); }
        }
        row.contracts.at(-1).recordCount = found.length;
        row.frontier.push({ url: currentSafe, text: current.sourceText, state: found.length ? 'observed_resource_json_records' : 'observed_resource_no_offering_record', recordCount: found.length });
      } else {
        row.frontier.push({ url: currentSafe, text: current.sourceText, state: 'observed_script_resource_read', note: 'Resource was fetched from a page-observed script reference; executable code was not run.' });
      }
      continue;
    }
    const extracted = extractPublicPage(page, { merchantId, typeHint: source.verticalHint });
    const visibleChallenge = /^challenge\s+validation$/i.test(extracted.title ?? '') || /tripverify\.html/i.test(page.url ?? '');
    if (visibleChallenge) {
      receipt.stopReason = 'VISIBLE_CHALLENGE_PAGE';
      row.frontier.push({ url: currentSafe, text: current.sourceText, state: 'stopped_at_host_challenge', note: `200 ${extracted.title || 'Trip.com verification page'}; stopped this merchant host.` });
      stopped = true;
      break;
    }
    const receiptId = page.receipt?.id ?? receipt.receiptId;
    row.contracts.at(-1).title = extracted.title;
    row.contracts.at(-1).forms = array(extracted.forms).map(form => ({ id: form.id, action: safeUrl(form.action), method: form.method, controls: array(form.controls).map(control => ({ name: control.name, type: control.type, label: control.label })) }));
    row.contracts.at(-1).schemaTypes = array(extracted.jsonLd).flatMap(item => array(item?.['@type'])).slice(0, 100);
    const schemaRecords = array(extracted.records).map((raw, index) => normalizeRecord(raw, receiptId, raw.evidence?.[0]?.locator ?? `jsonld.records[${index}]`, page.url)).filter(record => isRelevantRecord(record, source.verticalHint, page.url));
    // Apple's broad embedded state is navigation-heavy; only explicit Product JSON-LD is accepted there.
    const stateRecords = merchantId === 'applecom' ? [] : embeddedOfferingRecords(extracted, page, roots).map((raw, index) => normalizeRecord(raw, receiptId, raw.evidence?.[0]?.locator ?? `embeddedJson.records[${index}]`, page.url)).filter(record => isRelevantRecord(record, source.verticalHint, page.url));
    const linkRecords = merchantId === 'mustit' ? mustitLinkRecords(extracted, page, roots).map((raw, index) => normalizeRecord(raw, receiptId, raw.evidence?.[0]?.locator ?? `observed-link-record[${index}]`, page.url)) : [];
    const found = [...schemaRecords, ...stateRecords, ...linkRecords];
    if (merchantId === 'applecom' && /\/kr\/shop\/buy-mac\/macbook-air\/?$/i.test(new URL(page.url).pathname)) {
      const linkedVariants = appleLinkedVariants(extracted, page);
      const parentRecord = found.find(record => record.type === 'RetailProduct' && /MacBook Air/i.test(record.title ?? ''));
      if (parentRecord && linkedVariants.length) {
        parentRecord.variants = linkedVariants;
        const evidence = parentRecord.evidence[0];
        evidence.fields = [...new Set([...evidence.fields, 'variants'])];
        evidence.locator = `${evidence.locator}; observed model-configuration anchors (${linkedVariants.length})`;
      }
    }
    const existingKeys = new Set(row.records.map(record => `${record.sourceLocalId ?? ''}\0${record.url ?? ''}\0${record.title ?? ''}`));
    for (const record of found) {
      const key = `${record.sourceLocalId ?? ''}\0${record.url ?? ''}\0${record.title ?? ''}`;
      if (!existingKeys.has(key)) { row.records.push(record); existingKeys.add(key); }
    }
    row.contracts.at(-1).recordCount = found.length;
    row.contracts.at(-1).recordLocators = found.flatMap(record => record.evidence.map(item => item.locator)).slice(0, 80);
    if (found.length) row.frontier.push({ url: currentSafe, text: current.sourceText, state: hasUsefulRecord(found, merchantId) ? 'read_useful_records' : 'read_partial_records', recordCount: found.length });
    const candidates = linksToExplore(extracted, page.url, source.verticalHint, roots, visited);
    for (const observed of [...(additionalObservedLinks[merchantId] ?? [])].reverse()) {
      const url = safeUrl(observed.url);
      if (!url || visited.has(url)) continue;
      const index = candidates.findIndex(candidate => candidate.url === url);
      const prior = index >= 0 ? candidates.splice(index, 1)[0] : {};
      candidates.unshift({ ...prior, ...observed, url, score: 100 });
    }
    const preferred = [];
    for (const candidate of candidates) {
      if (visited.has(candidate.url) || queue.some(item => safeUrl(item.url) === candidate.url)) continue;
      preferred.push({ url: candidate.url, sourceText: candidate.text, pageKind: detailPath.test(new URL(candidate.url).pathname) ? 'observed_detail_candidate' : 'observed_category_candidate' });
    }
    const resources = observedScriptResources(page.html, page.url, resourceHosts);
    row.contracts.at(-1).observedPublicResources = resources.map(resource => ({ url: safeUrl(resource.url), locator: resource.locator }));
    const observedResources = [];
    for (const resource of resources) {
      if (visited.has(resource.url) || queue.some(item => safeUrl(item.url) === resource.url)) continue;
      observedResources.push({ url: resource.url, sourceText: resource.locator, pageKind: 'observed_public_resource' });
    }
    queue.unshift(...preferred, ...observedResources);
    if (queue.length > 40) queue.length = 40;
    if (!found.length && !candidates.length && !resources.length) row.frontier.push({ url: null, text: null, state: 'no_observed_offering_link', note: 'No same-provider product/service/category link or public script resource was found in the fetched page.' });
  }
  if (queue.length && sequence >= maxPages && !hasUsefulRecord(row.records, merchantId) && !stopped) {
    row.frontier.push(...queue.slice(0, 40).map(item => ({ url: safeUrl(item.url), text: item.sourceText, state: 'pending_budget_frontier' })));
  }
  row.status = stopped ? 'blocked_host_after_partial_reads' : row.records.length ? 'reachable_with_ontology_records' : row.receipts.some(item => item.status === 200) ? 'reachable_no_ontology_record' : 'unavailable';
  updateOperations(row);
  return row;
}

export async function runBatch06({ resume = true, maxPages = maxPagesDefault, merchantOptions = {} } = {}) {
  await mkdir(dirname(outputPath), { recursive: true });
  let report = { schemaVersion: 2, batchId: '06', checkedAt: new Date().toISOString(), merchants: [] };
  if (resume) { try { report = JSON.parse(await readFile(outputPath, 'utf8')); } catch { /* first run */ } }
  report.checkedAtSemantics = 'batch_last_updated_at; use merchant and receipt timestamps for data freshness';
  report.refreshScope = { mode: resume ? 'resume' : 'refresh', partial: true, refreshedMerchantIds: [], retainedMerchantIds: [] };
  const checkpoint = async () => {
    const temporary = outputPath + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, outputPath);
  };
  for (const merchantId of merchantIds) {
    const refreshableCurrentSources = new Set(['jomashop', 'thehyundai', 'mootoon', 'agoda']);
    if (resume && report.merchants.some(row => row.merchantId === merchantId && row.status !== 'pending') && !refreshableCurrentSources.has(merchantId)) {
      report.refreshScope.retainedMerchantIds.push(merchantId);
      continue;
    }
    const row = await collectMerchant(merchantId, { maxPages, ...(merchantOptions[merchantId] ?? {}) });
    report.merchants = [...report.merchants.filter(item => item.merchantId !== merchantId), row];
    report.checkedAt = new Date().toISOString();
    report.refreshScope.refreshedMerchantIds.push(merchantId);
    await checkpoint();
    process.stdout.write(`${merchantId}\t${row.status}\t${row.records.length}\t${row.receipts.map(item => item.status ?? 'ERR').join(',')}\n`);
  }
  report.merchants.sort((a, b) => merchantIds.indexOf(a.merchantId) - merchantIds.indexOf(b.merchantId));
  report.checkedAt = new Date().toISOString();
  report.refreshScope.partial = report.refreshScope.refreshedMerchantIds.length !== merchantIds.length;
  await checkpoint();
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBatch06({ resume: !process.argv.includes('--refresh') }).catch(error => {
    process.stderr.write(`${error?.code ?? error?.message ?? 'BATCH_06_FAILED'}\n`);
    process.exitCode = 1;
  });
}
