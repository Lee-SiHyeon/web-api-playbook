import { createHash } from 'node:crypto';

const storeHosts = new Set(['brand.naver.com']);
const feedSections = new Set(['newshopping', 'newmens', 'newbrandshop', 'promotion']);
const maxBytes = 8 * 1024 * 1024;

export class NaverShoppingError extends Error {
  constructor(code, message, receipt = null) {
    super(message);
    this.name = 'NaverShoppingError';
    this.code = code;
    this.receipt = receipt;
  }
}

function input(message) { throw new NaverShoppingError('INPUT', message); }
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) input(name + ' is out of range');
  return value;
}
function identifier(value, name) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) input(name + ' must be a positive safe integer');
  return text;
}
export function validateShoppingQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) input('query must contain 1-200 printable characters');
  return value.trim();
}

export function parseStoreUrl(value) {
  let url;
  try { url = new URL(value); } catch { input('storeUrl must be a Naver store HTTPS URL'); }
  if (url.protocol !== 'https:' || !storeHosts.has(url.hostname) || url.port || url.username || url.password
    || url.search || url.hash || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) input('storeUrl must identify one observed brand.naver.com store');
  return { origin: url.origin, slug: url.pathname.split('/')[1], url: url.origin + '/' + url.pathname.split('/')[1] };
}

export function parseProductUrl(value) {
  let url;
  try { url = new URL(value); } catch { input('productUrl must be a Naver product HTTPS URL'); }
  const match = url.pathname.match(/^\/([A-Za-z0-9_-]+)\/products\/([1-9][0-9]{0,15})\/?$/);
  if (!match || url.search || url.hash || url.port || url.username || url.password) input('productUrl must be a canonical Naver product URL');
  const store = parseStoreUrl(url.origin + '/' + match[1]);
  return { storeUrl: store.url, productId: identifier(match[2], 'productId') };
}

// Parse only JSON plus the observed undefined value. Never evaluate site code.
function structuredValue(text, start) {
  while (start < text.length && /\s/.test(text[start])) start++;
  if (!['{', '['].includes(text[start])) return null;
  let depth = 0, quoted = false, escaped = false, normalized = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      normalized += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (text.startsWith('undefined', i) && !/[\w$]/.test(text[i - 1] ?? '') && !/[\w$]/.test(text[i + 9] ?? '')) {
      normalized += 'null'; i += 8; continue;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    normalized += c;
    if (depth === 0) {
      try { return JSON.parse(normalized); } catch { return null; }
    }
  }
  return null;
}

export function extractPreloadedState(html) {
  const match = /(?:window\.)?__PRELOADED_STATE__\s*=\s*/.exec(html);
  const state = match ? structuredValue(html, match.index + match[0].length) : null;
  if (!state || Array.isArray(state) || typeof state !== 'object') throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver store state was missing or not supported');
  return state;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function firstNumber(...values) { return values.map(numeric).find(x => x !== null) ?? null; }
function text(value, limit = 5000) {
  if (typeof value !== 'string') return '';
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[x]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function publicUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || ['ader.naver.com', 'adcr.shopping.naver.com'].includes(u.hostname)) return null;
    return u.origin + u.pathname;
  } catch { return null; }
}

export function normalizeProduct(raw, { storeUrl, checkedAt = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.id || !text(raw.name ?? raw.dispName)) throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver product identity or title was missing');
  const store = parseStoreUrl(storeUrl);
  const productId = identifier(raw.id, 'upstream product id');
  const review = raw.reviewAmount ?? {};
  return {
    provider: 'naver-shopping', productId, originProductId: raw.productNo == null ? null : identifier(raw.productNo, 'upstream origin product id'),
    title: text(raw.name ?? raw.dispName, 1000), checkedAt, sourceKind: 'listing_claim',
    url: store.url + '/products/' + productId, seller: text(raw.channel?.channelName ?? raw.channel?.representName, 200) || null,
    currency: 'KRW', listingPriceKrw: firstNumber(raw.benefitsView?.dispDiscountedSalePrice, raw.benefitsView?.discountedSalePrice, raw.dispSalePrice, raw.salePrice),
    basePriceKrw: numeric(raw.salePrice), payablePriceVerified: false, optionsVerified: false,
    shipping: { baseFeeKrw: numeric(raw.productDeliveryInfo?.baseFee), freeConditionalAmountKrw: numeric(raw.productDeliveryInfo?.freeConditionalAmount), feeType: raw.productDeliveryInfo?.deliveryFeeType ?? null, checkoutVerified: false },
    reviewCount: numeric(review.totalReviewCount), averageRating: numeric(review.averageReviewScore),
    productStatus: raw.productStatusType ?? null, stockQuantity: numeric(raw.stockQuantity),
    imageUrl: publicUrl(raw.representativeImageUrl ?? raw.representImage?.url),
    contentTrust: 'untrusted_external_text',
  };
}

export function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || typeof raw.reviewContent !== 'string') throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver review identity or content was missing');
  if (!Number.isInteger(numeric(raw.reviewScore)) || Number(raw.reviewScore) < 1 || Number(raw.reviewScore) > 5) throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver review rating was invalid');
  if (raw.originProductNo != null && !/^[1-9][0-9]{0,15}$/.test(String(raw.originProductNo))) throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver review product identity was invalid');
  const sanitize = value => text(value).replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email removed]')
    .replace(/\b(?:\+82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}\b/g, '[phone removed]');
  return {
    reviewId: String(raw.id), rating: numeric(raw.reviewScore), text: sanitize(raw.reviewContent),
    originProductId: raw.originProductNo == null ? null : String(raw.originProductNo), productTitle: text(raw.productName, 1000) || null,
    createdAt: typeof raw.createDate === 'string' && Number.isFinite(Date.parse(raw.createDate)) ? raw.createDate.slice(0, 40) : null,
    productOption: sanitize(raw.productOptionContent), repurchase: typeof raw.repurchase === 'boolean' ? raw.repurchase : null,
    freeTrial: typeof raw.freeTrial === 'boolean' ? raw.freeTrial : null, contentTrust: 'untrusted_external_text',
  };
}

export function parseShoppingFeed(document, { section = 'promotion', checkedAt = new Date().toISOString(), flightResponse = false } = {}) {
  let flight = flightResponse ? document : '';
  for (const match of document.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)\s*<\/script>/g)) {
    try { const frame = JSON.parse(match[1]); if (typeof frame[1] === 'string') flight += frame[1]; } catch { /* incomplete frames are rejected below */ }
  }
  if (!flight) throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver shopping feed did not contain observed React flight data');
  const rows = [];
  let observed = false;
  for (const key of ['shoppingData', 'mallNameLinkData', 'brandShopData', 'items', 'products']) {
    const re = new RegExp('"' + key + '":', 'g');
    for (const match of flight.matchAll(re)) {
      const value = structuredValue(flight, match.index + match[0].length);
      if (!Array.isArray(value)) continue;
      observed = true;
      if (key === 'shoppingData' || key === 'mallNameLinkData') {
        for (const page of value) for (const block of Array.isArray(page) ? page : [page]) {
          if (!block || typeof block !== 'object') continue;
          for (const content of block.contentsList ?? [block]) rows.push({ ...content, mallNm: block.mallNm ?? content.mallNm, creative: true });
        }
      } else rows.push(...value.filter(x => x && typeof x === 'object' && !Array.isArray(x)));
    }
  }
  if (!observed) throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver shopping feed product fields changed');
  const items = [], seen = new Set();
  for (const raw of rows) {
    const title = text(raw.title ?? raw.name ?? raw.adCntsDesc1, 1000);
    if (!title) continue;
    const sourceUrl = publicUrl(raw.linkUrl ?? raw.link ?? raw.adCntsUrl1);
    const mid = String(raw.nvMid ?? '');
    const id = /^[1-9][0-9]{0,15}$/.test(mid) ? mid : 'promotion:' + createHash('sha256').update(title + '|' + (raw.mallNm ?? '') + '|' + (sourceUrl ?? '')).digest('hex').slice(0, 20);
    const price = [numeric(raw.discountPrice), numeric(raw.price)].find(x => x !== null && x > 0) ?? null;
    const duplicateKey = id + '|' + title + '|' + (raw.mallNm ?? '') + '|' + price;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    items.push({ provider: 'naver-shopping', productId: id, idKind: id.startsWith('promotion:') ? 'derived_promotion_key' : 'upstream',
      recordType: raw.creative || id.startsWith('promotion:') ? 'promotion' : 'offer', title, seller: text(raw.mallNm, 200) || null,
      listingPriceKrw: price, basePriceKrw: numeric(raw.listPrice), currency: 'KRW',
      reviewCount: numeric(raw.reviewCount), averageRating: null, url: sourceUrl,
      checkedAt, sourceKind: 'public_promotion_feed', sourceUrl: 'https://shopsquare.naver.com/' + section,
      payablePriceVerified: false, optionsVerified: false, contentTrust: 'untrusted_external_text' });
  }
  return items;
}

async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new NaverShoppingError('SIZE_LIMIT', 'Naver response exceeded the byte limit'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new NaverShoppingError('SIZE_LIMIT', 'Naver response exceeded the byte limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

// Normal search result pages embed an `"ncaptcha":{"hostname":"https://ncpt.naver.com",...}` widget config
// (place/map blocks), so a bare ncpt.naver.com substring is NOT a challenge. Treat it as a challenge only when the
// page is not a regular result document and the marker remains after removing that config.
export function isVerificationChallenge(body) {
  if (/<title[^>]*>[^<]*:\s*네이버\s*검색\s*<\/title>/.test(body)) return false;
  const stripped = body.replace(/"ncaptcha"\s*:\s*\{\s*"hostname"\s*:\s*"https:\/\/ncpt\.naver\.com"/g, '');
  return /ncpt\.naver\.com|wtm_captcha/.test(stripped);
}

export class NaverShoppingClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000, responseByteLimit = maxBytes } = {}) {
    if (typeof fetchImpl !== 'function') input('fetchImpl must be a function');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = integer(timeoutMs, 'timeoutMs', 100, 30000);
    this.responseByteLimit = integer(responseByteLimit, 'responseByteLimit', 1, maxBytes);
  }

  async request(url, { payload, json = false, flight = false } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.port || target.username || target.password || target.hash || !new Set([...storeHosts, 'shopsquare.naver.com', 'search.naver.com']).has(target.hostname)) input('request target is outside the Naver shopping allowlist');
    const keys = [...target.searchParams.keys()];
    if (target.hostname === 'search.naver.com') {
      if (target.pathname !== '/search.naver' || payload !== undefined || flight || json || keys.length !== 2 || !keys.includes('where') || !keys.includes('query') || target.searchParams.get('where') !== 'nexearch') input('Only the observed integrated search document read is allowed');
      validateShoppingQuery(target.searchParams.get('query'));
    } else if (target.hostname === 'shopsquare.naver.com') {
      if (!feedSections.has(target.pathname.slice(1)) || keys.length || payload !== undefined || !flight || json) input('Only observed shopping feed reads are allowed');
    } else if (/^\/[A-Za-z0-9_-]+\/search$/.test(target.pathname)) {
      if (payload !== undefined || flight || json || keys.length !== 1 || keys[0] !== 'q') input('Only the observed store search document is allowed');
      validateShoppingQuery(target.searchParams.get('q'));
    } else if (/^\/[A-Za-z0-9_-]+\/products\/[1-9][0-9]{0,15}$/.test(target.pathname)) {
      if (payload !== undefined || keys.length || json || flight) input('Only canonical product documents are allowed');
    } else if (/^\/n\/v2\/channels\/[A-Za-z0-9_-]{1,80}\/products\/[1-9][0-9]{0,15}$/.test(target.pathname)) {
      if (payload !== undefined || flight || !json || keys.length !== 1 || keys[0] !== 'withWindow' || target.searchParams.get('withWindow') !== 'false') input('Only the observed product JSON read is allowed');
    } else if (target.pathname === '/n/v1/contents/reviews/query-pages') {
      const required = ['checkoutMerchantNo', 'originProductNo', 'page', 'pageSize', 'reviewSearchSortType'];
      if (!json || flight || keys.length || !payload || Array.isArray(payload) || typeof payload !== 'object' || Object.keys(payload).length !== required.length || required.some(k => !Object.hasOwn(payload, k))) input('Only the observed review read payload is allowed');
      integer(payload.checkoutMerchantNo, 'checkoutMerchantNo', 1, Number.MAX_SAFE_INTEGER);
      integer(payload.originProductNo, 'originProductNo', 1, Number.MAX_SAFE_INTEGER);
      integer(payload.page, 'page', 1, 100); integer(payload.pageSize, 'pageSize', 1, 20);
      if (payload.reviewSearchSortType !== 'REVIEW_RANKING') input('Review sort was not observed');
    } else input('Request path is not an observed read contract');
    const method = payload === undefined ? 'GET' : 'POST';
    let response;
    try { response = await this.fetchImpl(target, { method, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: flight ? '*/*' : json ? 'application/json' : 'text/html', ...(flight ? { RSC: '1', 'Next-Url': target.pathname } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }); }
    catch { throw new NaverShoppingError('TRANSPORT', 'Naver shopping HTTP request failed'); }
    let bytes;
    try { bytes = await boundedBody(response, this.responseByteLimit); }
    catch (error) { if (error instanceof NaverShoppingError) throw error; throw new NaverShoppingError('TRANSPORT', 'Naver shopping response could not be read'); }
    const body = bytes.toString('utf8');
    const receipt = { method, origin: target.origin, path: target.pathname, queryFields: [...target.searchParams.keys()], bodyFields: payload ? Object.keys(payload) : [],
      httpStatus: response.status, responseContentType: response.headers.get('content-type') ?? '', responseDate: response.headers.get('date') ?? null, responseBytes: bytes.length,
      responseSha256: createHash('sha256').update(bytes).digest('hex'), retryAfter: response.headers.get('retry-after') ?? null,
      checkedAt: new Date().toISOString(), browserUsed: false,
      credentialsUsed: this.fetchImpl === globalThis.fetch ? false : null, transport: this.fetchImpl === globalThis.fetch ? 'anonymous_native_fetch' : 'caller_supplied_http' };
    const fail = (code, message) => { throw new NaverShoppingError(code, message, receipt); };
    if (response.status === 429) fail('RATE_LIMITED', 'Naver returned HTTP 429; no automatic retry was made');
    if (response.status === 418 || /쇼핑 서비스 접속이 일시적으로 제한/.test(body)) fail('WAF_BLOCKED', 'Naver shopping restricted this request');
    if (isVerificationChallenge(body)) fail('CAPTCHA_REQUIRED', 'Naver returned a verification challenge');
    const location = response.headers.get('location') ?? '';
    if (response.status === 401 || /nid\.naver\.com|nidlogin\.login/.test(location) || /<title[^>]*>\s*네이버\s*로그인/.test(body)) fail('AUTH_REQUIRED', 'Naver requires an authorized session');
    if (response.status >= 300 && response.status < 400) fail('REDIRECT_REJECTED', 'Naver returned a redirect; it was not followed');
    if (response.status !== 200) fail('HTTP_STATUS', 'Naver returned an unexpected HTTP status');
    if (json && !/^application\/json\b/i.test(receipt.responseContentType)) fail('CONTENT_TYPE', 'Naver returned a non-JSON API response');
    if (flight && !/^text\/x-component\b/i.test(receipt.responseContentType)) fail('CONTENT_TYPE', 'Naver returned a non-flight shopping feed');
    if (!json && !flight && !/^text\/html\b/i.test(receipt.responseContentType)) fail('CONTENT_TYPE', 'Naver returned a non-HTML document');
    if (!json) return { data: body, receipt };
    try { return { data: JSON.parse(body), receipt }; } catch { fail('SCHEMA_CHANGED', 'Naver returned malformed JSON'); }
  }

  async feed({ section = 'promotion', query = null, limit = 40 } = {}) {
    if (!feedSections.has(section)) input('section is not an observed shopping feed');
    integer(limit, 'limit', 1, 100);
    const filter = query === null ? null : validateShoppingQuery(query);
    const response = await this.request('https://shopsquare.naver.com/' + section, { flight: true });
    let items = parseShoppingFeed(response.data, { section, checkedAt: response.receipt.checkedAt, flightResponse: true });
    if (filter) items = items.filter(x => (x.title + ' ' + (x.seller ?? '')).toLocaleLowerCase('ko').includes(filter.toLocaleLowerCase('ko')));
    return { scope: 'public_promotion_feed', query: filter, filtering: filter ? 'local_filter_of_current_feed' : 'none', matchedCount: items.length,
      items: items.slice(0, limit), globalSearch: false, reviewBodiesIncluded: false, receipt: response.receipt };
  }

  async search({ storeUrl, query, limit = 40 }) {
    const store = parseStoreUrl(storeUrl), q = validateShoppingQuery(query); integer(limit, 'limit', 1, 100);
    const url = new URL(store.url + '/search'); url.searchParams.set('q', q);
    const response = await this.request(url), state = extractPreloadedState(response.data);
    if (!Array.isArray(state.keywordSearch?.simpleProducts) || !Number.isSafeInteger(state.keywordSearch.totalCount)
      || state.keywordSearch.totalCount < state.keywordSearch.simpleProducts.length || state.keywordSearch.page !== 1) throw new NaverShoppingError('SCHEMA_CHANGED', 'Store keyword-search product list or pagination was missing', response.receipt);
    if (state.keywordSearch.keyword !== q) throw new NaverShoppingError('SCHEMA_CHANGED', 'Store search response did not match the requested keyword', response.receipt);
    return { scope: 'single_naver_store', storeUrl: store.url, query: q, page: 1, paginationVerified: false,
      totalCount: numeric(state.keywordSearch.totalCount), items: state.keywordSearch.simpleProducts.slice(0, limit).map(x => normalizeProduct(x, { storeUrl: store.url, checkedAt: response.receipt.checkedAt })), receipt: response.receipt };
  }

  async product({ storeUrl, productId }) {
    const store = parseStoreUrl(storeUrl), id = identifier(productId, 'productId');
    const document = await this.request(store.url + '/products/' + id), state = extractPreloadedState(document.data);
    const uid = state.channel?.channelUid;
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(uid)) throw new NaverShoppingError('SCHEMA_CHANGED', 'Store channel identity was missing', document.receipt);
    const response = await this.request(store.origin + '/n/v2/channels/' + uid + '/products/' + id + '?withWindow=false', { json: true });
    if (String(response.data?.id) !== id || response.data?.channel?.channelUid !== uid) throw new NaverShoppingError('SCHEMA_CHANGED', 'Product response did not match the requested product and store', response.receipt);
    const merchant = response.data.channel.naverPaySellerNo;
    if (!/^[1-9][0-9]{0,15}$/.test(String(merchant ?? '')) || !/^[1-9][0-9]{0,15}$/.test(String(response.data.productNo ?? ''))) throw new NaverShoppingError('SCHEMA_CHANGED', 'Product review context was missing', response.receipt);
    return { product: normalizeProduct(response.data, { storeUrl: store.url, checkedAt: response.receipt.checkedAt }),
      reviewContext: { originProductNo: identifier(response.data.productNo, 'originProductNo'), checkoutMerchantNo: identifier(merchant, 'checkoutMerchantNo') }, receipts: [document.receipt, response.receipt] };
  }

  async reviews({ storeUrl, productId, page = 1, pageSize = 20 }) {
    parseStoreUrl(storeUrl); identifier(productId, 'productId'); integer(page, 'page', 1, 100); integer(pageSize, 'pageSize', 1, 20);
    const detail = await this.product({ storeUrl, productId }), store = parseStoreUrl(storeUrl);
    const payload = { checkoutMerchantNo: Number(detail.reviewContext.checkoutMerchantNo), originProductNo: Number(detail.reviewContext.originProductNo), page, pageSize, reviewSearchSortType: 'REVIEW_RANKING' };
    const response = await this.request(store.origin + '/n/v1/contents/reviews/query-pages', { payload, json: true });
    const data = response.data;
    if (!data || !Array.isArray(data.contents) || !Number.isSafeInteger(data.totalElements) || data.totalElements < 0
      || data.page !== page || data.size !== pageSize || data.contents.length > pageSize || (data.totalElements === 0 && data.contents.length)) throw new NaverShoppingError('SCHEMA_CHANGED', 'Naver review pagination contract changed', response.receipt);
    return { productId: String(productId), originProductId: detail.reviewContext.originProductNo, selection: 'all_reviews', sort: 'REVIEW_RANKING', page, pageSize,
      totalCount: data.totalElements, totalPages: data.totalPages ?? null, reviews: data.contents.map(normalizeReview), receipts: [...detail.receipts, response.receipt] };
  }
}
