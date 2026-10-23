import { createHash } from 'node:crypto';
import { parseFragment } from 'parse5';
import { isStrongPublicChallenge, textContent } from '../lib/cps-public-reader.mjs';
import {
  ShoppingReadError, loadShoppingSession, headersForShoppingSession, withShoppingSessionLock,
  applyShoppingCookieRotation, rotateShoppingCookies, invalidateShoppingSession,
} from '../lib/shopping-session-store.mjs';
import {
  buildCoupangQuantityInfoRequest, buildCoupangOtherSellersRequest, buildCoupangOfferListRequest,
  parseCoupangQuantityInfo, parseCoupangOtherSellerOffers, parseCoupangOfferList,
} from './coupang-consumer-offers.mjs';
import {
  CoupangVisitorError, createCoupangVisitorContext, prepareCoupangVisitorRead, rotateCoupangVisitorCookies,
} from '../lib/coupang-visitor-context.mjs';

const ORIGIN = 'https://www.coupang.com';
const REVIEW_PATH = '/next-api/review';
const SORTS = new Set(['DATE_DESC', 'ORDER_SCORE_ASC']);
const TRACKING_KEYS = new Set(['q', 'searchId', 'sourceType', 'itemsCount', 'searchRank', 'rank', 'traceId']);
const id = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const count = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value)
  : Number.isSafeInteger(value) && value >= 0 ? value : null;
const decimal = value => (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
  && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const clean = (value, limit = 500) => typeof value === 'string' ? textContent(value, limit) : null;

export class CoupangConsumerError extends Error {
  constructor(code, receipt = null) { super(code); this.name = 'CoupangConsumerError'; this.code = code; this.receipt = receipt; }
}
const fail = (code, receipt) => { throw new CoupangConsumerError(code, receipt); };

// Only the observed consumer product route. Tracking values never enter receipts.
export function coupangConsumerProductUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('COUPANG_CONSUMER_URL_INVALID'); }
  const match = /^\/vp\/products\/([1-9]\d{0,19})$/.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || url.port || !match
    || url.hash && url.hash !== '#sdpReview'
    || [...url.searchParams.keys()].some(key => !['itemId', 'vendorItemId'].includes(key) && !TRACKING_KEYS.has(key))
    || ['itemId', 'vendorItemId'].some(key => url.searchParams.getAll(key).length !== 1 || !id(url.searchParams.get(key))))
    fail('COUPANG_CONSUMER_URL_SCOPE');
  const canonical = new URL(url.pathname, ORIGIN);
  for (const key of ['itemId', 'vendorItemId']) canonical.searchParams.set(key, url.searchParams.get(key));
  return { url: canonical.href, productId: match[1], itemId: canonical.searchParams.get('itemId'), vendorItemId: canonical.searchParams.get('vendorItemId') };
}

export function coupangConsumerReviewRequest({ url, page = 1, sort = 'DATE_DESC' } = {}) {
  const product = coupangConsumerProductUrl(url);
  // This is a local single-page input bound, not a claim about the server limit.
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !SORTS.has(sort))
    fail('COUPANG_CONSUMER_REVIEW_INPUT');
  const target = new URL(REVIEW_PATH, ORIGIN);
  const query = { productId: product.productId, page: String(page), size: '10', sortBy: sort, ratingSummary: 'true', ratings: '', market: '' };
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  return { ...product, target: target.href, page, sort, size: 10, query };
}

function walk(node, predicate, output = []) {
  if (predicate(node)) output.push(node);
  for (const child of node.childNodes ?? []) walk(child, predicate, output);
  return output;
}
function flatten(value, output = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12 || output.length >= 500) return output;
  if (Array.isArray(value)) { for (const child of value.slice(0, 500)) flatten(child, output, depth + 1); return output; }
  output.push(value);
  if (value['@graph']) flatten(value['@graph'], output, depth + 1);
  return output;
}

export function parseCoupangConsumerProduct(html, { url } = {}) {
  const product = coupangConsumerProductUrl(url);
  if (typeof html !== 'string' || Buffer.byteLength(html) > 8 * 1024 * 1024) fail('COUPANG_CONSUMER_PRODUCT_SCHEMA');
  const scripts = walk(parseFragment(html), node => node.tagName === 'script'
    && node.attrs?.some(a => a.name === 'type' && a.value.toLowerCase() === 'application/ld+json'));
  const candidates = [];
  for (const [index, script] of scripts.slice(0, 40).entries()) {
    const raw = (script.childNodes ?? []).map(node => node.value ?? '').join('');
    if (raw.length > 1024 * 1024) continue;
    let nodes;
    try { nodes = flatten(JSON.parse(raw)); } catch { continue; }
    for (const node of nodes) {
      if (!(Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).includes('Product')
        || node.sku !== `${product.productId}-${product.itemId}` || !node.offers || Array.isArray(node.offers)) continue;
      try { if (coupangConsumerProductUrl(node.offers.url).url !== product.url) continue; } catch { continue; }
      candidates.push({ node, index });
    }
  }
  if (candidates.length !== 1) fail('COUPANG_CONSUMER_PRODUCT_IDENTITY');
  const { node, index } = candidates[0];
  const price = decimal(node.offers.price), currency = node.offers.priceCurrency;
  if (!clean(node.name) || price === null || !/^[A-Z]{3}$/.test(currency ?? '')) fail('COUPANG_CONSUMER_PRODUCT_SCHEMA');
  const shipping = node.offers.shippingDetails?.shippingRate;
  return {
    source: 'coupang', sourceScope: 'consumer_product_document', type: 'RetailProduct',
    id: `coupang:${product.productId}:${product.itemId}:${product.vendorItemId}`, ...product,
    sku: node.sku, title: clean(node.name), brand: clean(node.brand?.name),
    price: { amount: price, currency, basis: 'jsonld_offer_price', shippingAmount: shipping?.currency === currency ? decimal(shipping.value) : null },
    availability: typeof node.offers.availability === 'string' && /^https?:\/\/schema\.org\/(InStock|OutOfStock|PreOrder|BackOrder)$/.test(node.offers.availability)
      ? node.offers.availability.split('/').at(-1) : null,
    rating: { value: decimal(node.aggregateRating?.ratingValue), ratingCount: count(node.aggregateRating?.ratingCount),
      reviewCount: count(node.aggregateRating?.reviewCount), bestRating: decimal(node.aggregateRating?.bestRating), source: 'product_jsonld_aggregateRating' },
    evidence: [{ locator: `script[type="application/ld+json"]:${index + 1}:Product`, fields: ['sku', 'name', 'brand', 'offers', 'aggregateRating'] }],
  };
}

export function parseCoupangConsumerReviews(payload, { url, page = 1, sort = 'DATE_DESC' } = {}) {
  const request = coupangConsumerReviewRequest({ url, page, sort });
  if (!payload || payload.rCode !== 'RET0000') fail('COUPANG_CONSUMER_REVIEW_APPLICATION');
  const data = payload.rData, paging = data?.paging;
  if (!paging || paging.currentPage !== page || paging.page !== page || paging.sizePerPage !== 10
    || count(paging.totalCount) === null || count(paging.totalPage) === null || typeof paging.isNext !== 'boolean'
    || !Array.isArray(paging.contents) || paging.contents.length > 10) fail('COUPANG_CONSUMER_REVIEW_SCHEMA');
  const reviews = paging.contents.map((row, index) => {
    if (!row || id(row.productId) !== request.productId || !id(row.reviewId)
      || !Number.isFinite(row.rating) || row.rating < 1 || row.rating > 5) fail('COUPANG_CONSUMER_REVIEW_IDENTITY');
    const mediaCount = Array.isArray(row.attachments) && Array.isArray(row.videoAttachments)
      ? row.attachments.length + row.videoAttachments.length : null;
    const reviewedAt = Number.isSafeInteger(row.reviewAt) && String(row.reviewAt).length === 13 && Number.isFinite(new Date(row.reviewAt).valueOf())
      ? new Date(row.reviewAt).toISOString() : null;
    return {
      id: `coupang:${request.productId}:review:${createHash('sha256').update(String(row.reviewId)).digest('hex').slice(0, 24)}`,
      productId: request.productId, itemId: id(row.itemId), vendorItemId: id(row.vendorItemId),
      position: index + 1, ratingValue: row.rating, reviewedAt, optionText: clean(row.itemName),
      helpfulCount: count(row.helpfulCount), commentCount: count(row.commentCount),
      bodyAvailable: typeof row.content === 'string' && row.content.trim().length > 0,
      titleAvailable: typeof row.title === 'string' && row.title.trim().length > 0,
      body: null, title: null, reviewerIdentity: null, mediaCount, hasMedia: mediaCount === null ? null : mediaCount > 0,
      evidence: { locator: `rData.paging.contents[${index}]` },
    };
  });
  const summary = data.ratingSummaryTotal;
  return {
    source: 'coupang', sourceScope: 'consumer_review_page', productId: request.productId,
    page, size: 10, sort, reviews, count: reviews.length, reviewScope: 'product_all_variants_and_sellers',
    paging: { totalCount: count(paging.totalCount), totalPages: count(paging.totalPage), hasNext: paging.isNext },
    aggregate: { ratingCount: count(summary?.ratingCount), ratingAverage: decimal(summary?.ratingAverage),
      reviewTotalCount: count(data.reviewTotalCount), source: 'review_api_ratingSummaryTotal',
      histogram: Array.isArray(summary?.ratingSummaries) ? summary.ratingSummaries.slice(0, 5).filter(row => row && typeof row === 'object').map(row => ({
        rating: decimal(row.rating), count: count(row.count), percentage: decimal(row.percentage),
      })) : null },
    coverage: 'One observed review page; totalCount, reviewTotalCount, and ratingCount retain their separate meanings.',
    privacy: { reviewerFieldsStored: false, reviewBodiesStored: false, rawResponseStored: false },
  };
}

async function boundedText(response, maxBytes) {
  const chunks = []; let bytes = 0, keptBytes = 0, complete = false, bodyError = null;
  if (!response.body) return { text: '', bytes: 0, bodyComplete: true, responseSha256: createHash('sha256').update('').digest('hex'), bodyError: null };
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      const kept = part.value.subarray(0, Math.max(0, maxBytes - keptBytes));
      chunks.push(Buffer.from(kept)); keptBytes += kept.byteLength;
      if (bytes > maxBytes) { bodyError = 'response_size'; break; }
    }
  } catch { bodyError = 'response_stream'; }
  finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  return { text: body.toString('utf8'), bytes, bodyComplete: complete, bodyError,
    responseSha256: complete ? createHash('sha256').update(body).digest('hex') : null };
}

const sessionRequests = new WeakSet();

function responseSetCookieMetadata(headers) {
  let available = false;
  try { available = typeof headers?.has === 'function' && headers.has('set-cookie'); } catch { /* unavailable */ }
  let values = null;
  if (typeof headers?.getSetCookie === 'function') {
    try {
      const observed = headers.getSetCookie();
      if (Array.isArray(observed)) values = observed;
    } catch { /* Preserve an unknown count without copying header data. */ }
  }
  const count = values === null ? available ? null : 0 : values.length <= 100 ? values.length : null;
  return { available, count, values: values ?? (available ? null : []) };
}

function parseRetryAfterSeconds(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const raw = value.trim();
  if (/^\d{1,8}$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : null;
  }
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  const seconds = Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
  return Number.isSafeInteger(seconds) && seconds <= 3600 ? seconds : null;
}

function safeDurationMs(startedAt) {
  const elapsed = performance.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 120_000 ? Math.round(elapsed) : null;
}

async function readOnce({ target, referer, operation, mime, authentication = 'protected', session: suppliedSession,
  visitorContext, resolveProtectedTarget, validateResponse, fetchImpl = globalThis.fetch }) {
  if (!['protected', 'anonymous', 'visitor'].includes(authentication) || authentication !== 'protected' && suppliedSession != null
    || authentication !== 'visitor' && visitorContext != null)
    fail('COUPANG_CONSUMER_AUTH_INPUT');
  let url = new URL(target);
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();
  const receipt = { checkedAt, operation, method: 'GET', origin: url.origin, path: url.pathname,
    query: Object.fromEntries(url.searchParams), status: null, contentType: null, bytes: null, bodyComplete: false,
    responseCookieHeadersAvailable: false, responseCookieCount: null, retryAfterSeconds: null, durationMs: null,
    execution: 'pure_http', browserUsed: false, authenticationMode: authentication,
    sessionProvider: authentication === 'anonymous' ? null : authentication === 'visitor' ? 'http_issued_memory_visitor'
      : suppliedSession ? 'in_memory' : 'windows_current_user_dpapi',
    credentialSent: false, credentialPropagated: false, authenticatedOwnerVerified: false,
    applicationAuthenticated: null, cookieRotationApplied: false, cookieRotationPersisted: false,
    transport: fetchImpl === globalThis.fetch ? 'native_fetch' : 'injected', retry: false, redirectsFollowed: false };
  let visitor = null;
  const execute = async () => {
  if (authentication === 'visitor') visitor = visitorContext ?? createCoupangVisitorContext({ fetchImpl });
  let session = null;
  const headers = { accept: mime === 'application/json' ? 'application/json, text/plain, */*' : 'text/html', ...(referer ? { referer } : {}) };
  if (operation === 'offer_list') headers['x-coupang-accept-language'] = 'ko-KR';
  if (authentication === 'protected') {
    session = suppliedSession ?? loadShoppingSession('coupang-consumer');
    if (session.service !== 'coupang-consumer') fail('COUPANG_CONSUMER_SESSION_SCOPE', receipt);
    if (resolveProtectedTarget) {
      let resolved;
      try { resolved = resolveProtectedTarget(session); }
      catch { fail('COUPANG_CONSUMER_SESSION_SCOPE', receipt); }
      try { url = new URL(resolved); }
      catch { fail('COUPANG_CONSUMER_SESSION_SCOPE', receipt); }
      if (url.origin !== ORIGIN || url.username || url.password || url.hash)
        fail('COUPANG_CONSUMER_SESSION_SCOPE', receipt);
      receipt.origin = url.origin;
      receipt.path = url.pathname;
      receipt.query = Object.fromEntries(url.searchParams);
    }
    Object.assign(headers, headersForShoppingSession(session, url.href, referer), { accept: headers.accept });
    receipt.credentialSent = !!headers.cookie;
    receipt.boundProofTransferred = false;
    receipt.browserAuthEquivalent = false;
  }
  if (visitor) {
    const inputs = await prepareCoupangVisitorRead({ context: visitor, target, operation, fetchImpl });
    headers.cookie = inputs.cookie;
    receipt.ownerCredentialUsed = false;
    receipt.visitorCookiesSent = true;
    receipt.visitorCookieNames = inputs.cookieNames;
    receipt.visitorBootstrap = inputs.bootstrapReceipt;
    receipt.visitorValuesPersisted = false;
  }
  let response;
  try { response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit',
    headers,
    signal: AbortSignal.timeout(20000) }); }
  catch { receipt.durationMs = safeDurationMs(startedAt); fail('COUPANG_CONSUMER_TRANSPORT', receipt); }
  if (!response?.headers?.get || !Number.isInteger(response.status)) {
    receipt.durationMs = safeDurationMs(startedAt);
    fail('COUPANG_CONSUMER_RESPONSE_SCHEMA', receipt);
  }
  const responseCookies = responseSetCookieMetadata(response.headers);
  receipt.responseCookieHeadersAvailable = responseCookies.available;
  receipt.responseCookieCount = responseCookies.count;
  try { receipt.retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after')); }
  catch { receipt.retryAfterSeconds = null; }
  receipt.status = response.status;
  receipt.credentialPropagated = receipt.credentialSent;
  const receivedMime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  receipt.contentType = receivedMime.length <= 128 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(receivedMime) ? receivedMime : null;
  receipt.server = /^(?:envoy|AkamaiGHost|cloudflare)$/i.test(response.headers.get('server') ?? '') ? response.headers.get('server') : null;
  receipt.dpopChallengePresent = /^\s*DPoP(?:\s|$)/i.test(response.headers.get('www-authenticate') ?? '');
  if (response.redirected || response.url && response.url !== url.href || response.status >= 300 && response.status < 400) {
    receipt.durationMs = safeDurationMs(startedAt);
    let loginRedirect = false;
    try {
      const location = new URL(response.headers.get('location'), url.href);
      loginRedirect = location.origin === url.origin && /(?:^|\/)(?:login|signin|sign-in)(?:[/.]|$)/i.test(location.pathname);
    } catch { /* The response remains a rejected redirect. */ }
    receipt.loginRedirect = loginRedirect;
    await response.body?.cancel().catch(() => {});
    if (loginRedirect && session) {
      invalidateShoppingSession(session, { persist: suppliedSession == null });
      fail('COUPANG_CONSUMER_REAUTH_REQUIRED', receipt);
    }
    fail('COUPANG_CONSUMER_REDIRECT', receipt);
  }
  let body;
  try { body = await boundedText(response, response.status === 200 ? 8 * 1024 * 1024 : 64 * 1024); }
  catch { body = { text: '', bytes: 0, responseSha256: null, bodyComplete: false, bodyError: 'response_stream' }; }
  receipt.durationMs = safeDurationMs(startedAt);
  Object.assign(receipt, { bytes: body.bytes, responseSha256: body.responseSha256, bodyComplete: body.bodyComplete, bodyError: body.bodyError });
  const html = /^(?:text\/html|application\/xhtml\+xml)$/.test(receipt.contentType) || /^\s*<(?:!doctype|html|head|title)\b/i.test(body.text);
  const challengeHeaders = Object.fromEntries(['cf-mitigated', 'x-captcha-required', 'x-sucuri-block'].map(key => [key, response.headers.get(key)]));
  receipt.challengeConfirmed = isStrongPublicChallenge(challengeHeaders, html ? body.text : '');
  receipt.accessDeniedTitle = html && /<title\b[^>]*>\s*Access Denied\s*<\/title>/i.test(body.text);
  const visible = html ? body.text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') : body.text;
  receipt.denialSignals = {
    requestBlocked: /request (?:was |has been )?blocked|요청이?\s*차단|접근이?\s*차단/i.test(visible),
    automatedAccess: /automated (?:access|requests)|unusual traffic|비정상(?:적인)?\s*(?:접근|트래픽)|자동화(?:된)?\s*(?:접근|요청)/i.test(visible),
    permissionDenied: /permission to access|access denied|접근\s*권한|사용\s*권한(?:이\s*)?(?:없습니다|제한된\s*페이지)/i.test(visible),
    loginPage: html && /<title\b[^>]*>[^<]*(?:로그인|sign in|log in)/i.test(body.text) && /<input\b[^>]*type=["']password["']/i.test(body.text),
  };
  if (response.status === 429) fail('COUPANG_CONSUMER_RATE_LIMITED', receipt);
  if (response.status === 401 && receipt.dpopChallengePresent) fail('COUPANG_CONSUMER_DPOP_REQUIRED', receipt);
  if (response.status === 401 && session) {
    invalidateShoppingSession(session, { persist: suppliedSession == null });
    fail('COUPANG_CONSUMER_REAUTH_REQUIRED', receipt);
  }
  if (receipt.denialSignals.loginPage && session) {
    invalidateShoppingSession(session, { persist: suppliedSession == null });
    fail('COUPANG_CONSUMER_REAUTH_REQUIRED', receipt);
  }
  if ([401, 403, 418].includes(response.status)) fail('COUPANG_CONSUMER_ACCESS_BLOCKED', receipt);
  if (receipt.challengeConfirmed) fail('COUPANG_CONSUMER_CHALLENGE', receipt);
  if (response.status !== 200) fail('COUPANG_CONSUMER_HTTP_REJECTED', receipt);
  if (!body.bodyComplete) fail(body.bodyError === 'response_size' ? 'COUPANG_CONSUMER_RESPONSE_SIZE' : 'COUPANG_CONSUMER_BODY_FAILED', receipt);
  if (receipt.contentType !== mime) fail('COUPANG_CONSUMER_CONTENT_TYPE', receipt);
  const parsed = validateResponse ? await validateResponse(body.text, receipt, session) : undefined;
  if (session) {
    const setCookies = responseCookies.values;
    if (receipt.responseCookieHeadersAvailable && setCookies === null)
      fail('COUPANG_CONSUMER_COOKIE_HEADERS_UNSUPPORTED', receipt);
    receipt.cookieRotationApplied = suppliedSession ? rotateShoppingCookies(session, setCookies, url.href)
      : applyShoppingCookieRotation(session, setCookies, url.href);
    receipt.cookieRotationPersisted = suppliedSession == null && receipt.cookieRotationApplied;
  }
  if (visitor) {
    const setCookies = responseCookies.values;
    if (receipt.responseCookieHeadersAvailable && setCookies === null)
      fail('COUPANG_VISITOR_COOKIE_HEADERS', receipt);
    receipt.visitorCookieRotationApplied = rotateCoupangVisitorCookies(visitor, setCookies ?? [], url.href, operation);
  }
  return { text: body.text, receipt, parsed };
  };
  try {
    if (authentication !== 'protected') return await execute();
    if (suppliedSession == null) return await withShoppingSessionLock('coupang-consumer', execute);
    if (typeof suppliedSession !== 'object' || Array.isArray(suppliedSession)) fail('COUPANG_CONSUMER_SESSION_SCHEMA', receipt);
    if (sessionRequests.has(suppliedSession)) fail('COUPANG_CONSUMER_SESSION_BUSY', receipt);
    sessionRequests.add(suppliedSession);
    try { return await execute(); } finally { sessionRequests.delete(suppliedSession); }
  } catch (error) {
    if (error instanceof ShoppingReadError) fail(error.code, receipt);
    if (error instanceof CoupangVisitorError) fail(error.code, { ...receipt, visitorBootstrap: error.receipt ?? receipt.visitorBootstrap ?? null });
    throw error;
  }
}

const states = (live, receipt) => ({ captured: true, client_exists: true, remnant_free: true,
  credential_propagated: receipt.credentialPropagated, live_replay: live });

export async function readCoupangConsumerProduct({ url, authentication, session, fetchImpl } = {}) {
  const target = coupangConsumerProductUrl(url);
  const result = await readOnce({ target: target.url, operation: 'product_document', mime: 'text/html', authentication, session, fetchImpl,
    validateResponse: (html, receipt) => {
      try { return parseCoupangConsumerProduct(html, target); }
      catch (error) { if (error instanceof CoupangConsumerError) error.receipt = receipt; throw error; }
    } });
  return { product: result.parsed, receipt: result.receipt,
    states: states(result.receipt.transport === 'native_fetch', result.receipt) };
}

export async function readCoupangConsumerReviews({ url, page = 1, sort = 'DATE_DESC', authentication, session, fetchImpl, visitorContext } = {}) {
  const request = coupangConsumerReviewRequest({ url, page, sort });
  const result = await readOnce({ target: request.target, referer: request.url, operation: 'review_page', mime: 'application/json', authentication, session, fetchImpl, visitorContext,
    validateResponse: (text, receipt, activeSession) => {
      let payload;
      try { payload = JSON.parse(text); } catch { fail('COUPANG_CONSUMER_REVIEW_JSON', receipt); }
      receipt.applicationAuthenticated = typeof payload?.rData?.isLogin === 'boolean' ? payload.rData.isLogin : null;
      if (receipt.authenticationMode === 'protected' && receipt.applicationAuthenticated === false) {
        if (activeSession) invalidateShoppingSession(activeSession, { persist: session == null });
        fail('COUPANG_CONSUMER_REAUTH_REQUIRED', receipt);
      }
      if (receipt.authenticationMode === 'protected' && receipt.applicationAuthenticated !== true)
        fail('COUPANG_CONSUMER_REVIEW_AUTH_UNVERIFIED', receipt);
      let parsed;
      try { parsed = parseCoupangConsumerReviews(payload, { url: request.url, page, sort }); }
      catch (error) { if (error instanceof CoupangConsumerError) error.receipt = receipt; throw error; }
      return parsed;
    } });
  return { ...result.parsed, receipt: result.receipt,
    states: states(result.receipt.transport === 'native_fetch' && result.parsed.reviews.length > 0, result.receipt) };
}

async function readConsumerOfferData({ url, authentication, session, fetchImpl, visitorContext }, operation) {
  const identity = coupangConsumerProductUrl(url);
  const quantity = operation === 'quantity_info';
  const target = (quantity ? buildCoupangQuantityInfoRequest : buildCoupangOtherSellersRequest)(identity);
  const resolveProtectedTarget = quantity ? activeSession => {
    const observed = activeSession?.inputs?.observedRequests;
    const matches = Array.isArray(observed) ? observed.filter(row => {
      if (row?.operation !== 'quantity_info' || typeof row.url !== 'string') return false;
      try {
        const candidate = new URL(row.url);
        return candidate.origin === ORIGIN && candidate.pathname === '/next-api/products/quantity-info' &&
          candidate.searchParams.get('productId') === identity.productId &&
          candidate.searchParams.get('vendorItemId') === identity.vendorItemId;
      } catch { return false; }
    }) : [];
    if (matches.length !== 1) throw new Error('quantity_info_observation_unavailable');
    return buildCoupangQuantityInfoRequest(identity, matches[0].url);
  } : undefined;
  const result = await readOnce({ target, referer: identity.url, operation, mime: 'application/json', authentication, session, fetchImpl,
    visitorContext, resolveProtectedTarget,
    validateResponse: (text, receipt) => {
      let payload;
      try { payload = JSON.parse(text); } catch { fail('COUPANG_CONSUMER_OFFER_JSON', receipt); }
      try { return (quantity ? parseCoupangQuantityInfo : parseCoupangOtherSellerOffers)(payload, identity); }
      catch (error) { fail(/^COUPANG_[A-Z_]+$/.test(error.code || '') ? error.code : 'COUPANG_CONSUMER_OFFER_SCHEMA', receipt); }
    } });
  return { ...(quantity ? { offer: result.parsed } : result.parsed), receipt: result.receipt,
    states: states(result.receipt.transport === 'native_fetch' && (quantity || result.parsed.count > 0), result.receipt) };
}

export function readCoupangConsumerOffer(options = {}) { return readConsumerOfferData(options, 'quantity_info'); }
export function readCoupangConsumerSellers(options = {}) { return readConsumerOfferData(options, 'other_sellers'); }

// Public offer-list prices are distinct from account-context quantity prices and other-seller prices.
// This operation only uses the anonymous or HTTP-issued visitor path; it never sends owner credentials.
export async function readCoupangConsumerOfferList({ url, authentication = 'visitor', session, fetchImpl, visitorContext } = {}) {
  if (authentication === 'protected' || session != null) fail('COUPANG_CONSUMER_OFFER_LIST_AUTH_SCOPE');
  const identity = coupangConsumerProductUrl(url);
  const target = buildCoupangOfferListRequest(identity);
  const result = await readOnce({ target, referer: identity.url, operation: 'offer_list', mime: 'application/json',
    authentication, fetchImpl, visitorContext,
    validateResponse: (text, receipt) => {
      let payload;
      try { payload = JSON.parse(text); } catch { fail('COUPANG_CONSUMER_OFFER_LIST_JSON', receipt); }
      try { return parseCoupangOfferList(payload, identity); }
      catch (error) { fail(/^COUPANG_[A-Z_]+$/.test(error.code || '') ? error.code : 'COUPANG_CONSUMER_OFFER_LIST_SCHEMA', receipt); }
    } });
  result.receipt.applicationAuthenticated = null;
  result.receipt.authenticatedOwnerVerified = false;
  result.receipt.ownerCredentialUsed = false;
  result.receipt.applicationStatus = 200;
  return { ...result.parsed, receipt: result.receipt,
    states: states(result.receipt.transport === 'native_fetch' && result.parsed.count > 0, result.receipt) };
}

// A bounded profile from the observed JSON contracts. No blocked HTML request or
// browser fallback occurs here. A reviewed option label is not a current catalog title.
export async function readCoupangConsumerProfile(options = {}) {
  const identity = coupangConsumerProductUrl(options.url);
  let shared = options;
  if (options.authentication === 'visitor') {
    try { shared = { ...options, visitorContext: options.visitorContext ?? createCoupangVisitorContext({ fetchImpl: options.fetchImpl }) }; }
    catch (error) { if (error instanceof CoupangVisitorError) fail(error.code); throw error; }
  }
  const reviews = await readCoupangConsumerReviews({ ...shared, url: identity.url, page: 1, sort: 'DATE_DESC' });
  let sellers = null, failure = null;
  try { sellers = await readCoupangConsumerSellers({ ...shared, url: identity.url }); }
  catch (error) {
    if (!(error instanceof CoupangConsumerError)) throw error;
    failure = { code: error.code, receipt: error.receipt };
  }
  const labels = [...new Set(reviews.reviews.filter(row => row.itemId === identity.itemId && row.vendorItemId === identity.vendorItemId)
    .map(row => row.optionText).filter(Boolean))];
  const receipts = [reviews.receipt, sellers?.receipt ?? failure.receipt].filter(Boolean);
  const receipt = { checkedAt: receipts[0].checkedAt, operation: 'product_profile', execution: 'pure_http', browserUsed: false,
    authenticationMode: receipts[0].authenticationMode, sessionProvider: receipts[0].sessionProvider,
    credentialPropagated: receipts.every(row => row.credentialPropagated), applicationAuthenticated: reviews.receipt.applicationAuthenticated,
    authenticatedOwnerVerified: false, requestCount: receipts.every(row => row.status !== null) ? receipts.length : null,
    operationAttemptCount: 2, retries: 0 };
  if (options.authentication === 'visitor') {
    receipt.visitorCookiesSent = receipts.every(row => row.visitorCookiesSent);
    receipt.ownerCredentialUsed = false;
    receipt.visitorValuesPersisted = false;
    receipt.visitorBootstraps = receipts.map(row => row.visitorBootstrap).filter(Boolean);
    receipt.visitorBootstrap = receipt.visitorBootstraps[0] ?? null;
    receipt.requestCount = receipt.requestCount === null ? null : receipt.requestCount + receipt.visitorBootstraps.length;
  }
  return { ok: failure === null, partial: failure !== null, ...(failure ? { code: failure.code, failure } : {}),
    source: 'coupang', sourceScope: 'consumer_product_json_profile',
    product: { ...identity, title: null, reviewedOptionLabel: labels.length === 1 ? labels[0] : null,
      labelEvidence: labels.length === 1 ? 'review_page.rows_matching_itemId_and_vendorItemId.optionText' : null,
      brand: null, description: null, availability: null },
    offer: sellers?.offers.find(row => row.selected) ?? null,
    sellers: sellers ? { offers: sellers.offers, count: sellers.count, totalCount: sellers.totalCount, coverage: sellers.coverage } : null,
    reviews: { rows: reviews.reviews, count: reviews.count, scope: reviews.reviewScope, paging: reviews.paging, aggregate: reviews.aggregate },
    coverage: { productFields: 'ids_and_reviewed_option_label', currentPrice: sellers ? 'selected_vendor_offer_listing' : 'unavailable',
      reviewPages: 1, sellerOffers: sellers ? 'one_observed_response' : 'unavailable',
      htmlDetails: 'blocked_403_not_requested_by_profile', quantityPricing: 'blocked_403_not_requested_by_profile' },
    receipt, receipts, operationStates: { review_page: reviews.states, other_sellers: sellers?.states ?? states(false, failure.receipt ?? {}) },
    states: states(reviews.states.live_replay && sellers?.states.live_replay === true, receipt) };
}
