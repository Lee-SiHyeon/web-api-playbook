import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireRunLock } from './process-run-lock.mjs';

export const shoppingOrigins = Object.freeze({
  gmarket: 'https://item.gmarket.co.kr',
  'gmarket-search': 'https://www.gmarket.co.kr',
  auction: 'https://itempage3.auction.co.kr',
  'naver-brand': 'https://brand.naver.com',
  'naver-catalog': 'https://search.shopping.naver.com',
  'naver-search': 'https://search.shopping.naver.com',
  'coupang-search': 'https://www.coupang.com',
  'coupang-consumer': 'https://www.coupang.com',
});
const helper = fileURLToPath(new URL('./shopping-session-store.ps1', import.meta.url));
const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AffiliateContentOperations', 'ShoppingApi');
const lifetimeMs = 6 * 60 * 60 * 1000; // Local handoff limit, not a claim about the site's token lifetime.
const readPaths = { gmarket: '/Review', 'gmarket-search': '/n/search', auction: '/WebService/ReviewService.asmx/GetReviewList', 'naver-brand': '/n/v1/contents/reviews/query-pages', 'naver-catalog': '/catalog/api/', 'naver-search': '/search/all', 'coupang-search': '/np/search', 'coupang-consumer': '/vp/products/' };
// First-party session cookies observed on the search request after normal Coupang login.
// Analytics, tracking and bot-defense cookies are deliberately outside this scope.
const coupangSessionCookieNames = new Set(['CT_LSID', 'CT_JKTH', 'CT_AT', 'CPUSR_RL', 'CUPT', 'ILOGIN', 'CSID', 'web-session-id', 'member_srl', 'sid', 'x-cp-s']);
// Consumer requests were observed with CT_ATH in the authenticated account
// context. CT_DPOP is a bound-proof token and is intentionally never persisted.
const coupangConsumerSessionCookieNames = new Set([...coupangSessionCookieNames, 'CT_ATH']);
// Keep application headers; the native HTTP transport supplies its own wire headers.
const retainedHeaders = new Set(['accept', 'accept-language', 'content-type', 'origin', 'referer', 'x-requested-with',
  'rsc', 'next-url', 'next-router-state-tree']);
const botCookieName = /^(?:cf_clearance|__cf_bm|_cfuvid|_abck|ak_bmsc|bm_.+|datadome|_px(?:\d+|vid|hd|de)|incap_ses_.+|visid_incap_.+)$/i;
const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const maxCookies = 256;
const requiredCookieNames = service => service === 'coupang-search' ? ['ILOGIN', 'CT_AT']
  : service === 'coupang-consumer' ? ['ILOGIN', 'CT_AT', 'CT_ATH'] : [];

const coupangConsumerReviewKeys = ['productId', 'page', 'size', 'sortBy', 'ratingSummary', 'ratings', 'market'];
const positiveDecimalId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const coupangQuantityInfoKeys = new Set([
  'productId', 'vendorItemId', 'quantity', 'deliveryToggle',
  'landingItemId', 'landingProductId', 'landingVendorItemId',
]);
const coupangQuantityLandingKeys = ['landingItemId', 'landingProductId', 'landingVendorItemId'];

// Validate and retain the exact captured query. Source-confirmed quantity-info
// fields are deliberately narrow; this does not synthesize or broaden a read.
export function validateCoupangQuantityInfoRequestUrl(value, expected = {}) {
  if (typeof value !== 'string' || value.length > 2048) throw new ShoppingReadError('SESSION_SCOPE');
  let target;
  try { target = new URL(value); } catch { throw new ShoppingReadError('SESSION_SCOPE'); }
  if (target.origin !== shoppingOrigins['coupang-consumer'] || target.username || target.password || target.hash)
    throw new ShoppingReadError('SESSION_ORIGIN_SCOPE');
  if (target.pathname !== '/next-api/products/quantity-info' || target.href !== value)
    throw new ShoppingReadError('SESSION_SCOPE');

  const rawQuery = target.search.slice(1);
  if (!rawQuery) throw new ShoppingReadError('SESSION_SCOPE');
  const parameters = new Map();
  for (const part of rawQuery.split('&')) {
    const equals = part.indexOf('=');
    if (equals < 1 || part.indexOf('=', equals + 1) !== -1) throw new ShoppingReadError('SESSION_SCOPE');
    const key = part.slice(0, equals), value = part.slice(equals + 1);
    if (!coupangQuantityInfoKeys.has(key) || parameters.has(key)) throw new ShoppingReadError('SESSION_SCOPE');
    if (['productId', 'vendorItemId', ...coupangQuantityLandingKeys].includes(key) && !positiveDecimalId(value))
      throw new ShoppingReadError('SESSION_SCOPE');
    if (key === 'quantity' && value !== '1') throw new ShoppingReadError('SESSION_SCOPE');
    if (key === 'deliveryToggle' && value !== 'true' && value !== 'false') throw new ShoppingReadError('SESSION_SCOPE');
    parameters.set(key, value);
  }

  const productId = parameters.get('productId'), vendorItemId = parameters.get('vendorItemId');
  if (!productId || !vendorItemId ||
      expected.productId !== undefined && (!positiveDecimalId(expected.productId) || productId !== expected.productId) ||
      expected.vendorItemId !== undefined && (!positiveDecimalId(expected.vendorItemId) || vendorItemId !== expected.vendorItemId))
    throw new ShoppingReadError('SESSION_SCOPE');
  const landingCount = coupangQuantityLandingKeys.filter(key => parameters.has(key)).length;
  if (landingCount !== 0 && landingCount !== coupangQuantityLandingKeys.length)
    throw new ShoppingReadError('SESSION_SCOPE');
  if (landingCount && parameters.get('landingProductId') !== productId)
    throw new ShoppingReadError('SESSION_SCOPE');
  return value;
}

function canonicalCoupangConsumerObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 3 || !['operation', 'url', 'method'].every(key => Object.hasOwn(value, key)) ||
      value.method !== 'GET' || typeof value.url !== 'string' || value.url.length > 2048)
    throw new ShoppingReadError('SESSION_SCOPE');
  let target;
  try { target = new URL(value.url); } catch { throw new ShoppingReadError('SESSION_SCOPE'); }
  if (target.origin !== shoppingOrigins['coupang-consumer'] || target.username || target.password || target.hash)
    throw new ShoppingReadError('SESSION_ORIGIN_SCOPE');
  const canonical = new URL(target.pathname, target.origin);
  if (value.operation === 'product_document') {
    if (!/^\/vp\/products\/[1-9]\d{0,19}$/.test(target.pathname) ||
        [...target.searchParams.keys()].some(key => !['itemId', 'vendorItemId'].includes(key)) ||
        ['itemId', 'vendorItemId'].some(key => target.searchParams.getAll(key).length !== 1 || !positiveDecimalId(target.searchParams.get(key))))
      throw new ShoppingReadError('SESSION_SCOPE');
    for (const key of ['itemId', 'vendorItemId']) canonical.searchParams.set(key, target.searchParams.get(key));
  } else if (value.operation === 'review_page') {
    if (target.pathname !== '/next-api/review' ||
        [...target.searchParams.keys()].some(key => !coupangConsumerReviewKeys.includes(key)) ||
        coupangConsumerReviewKeys.some(key => target.searchParams.getAll(key).length !== 1))
      throw new ShoppingReadError('SESSION_SCOPE');
    const productId = target.searchParams.get('productId'), page = target.searchParams.get('page');
    if (!positiveDecimalId(productId) || !/^([1-9]\d{0,3}|10000)$/.test(page) || target.searchParams.get('size') !== '10' ||
        !['DATE_DESC', 'ORDER_SCORE_ASC'].includes(target.searchParams.get('sortBy')) ||
        target.searchParams.get('ratingSummary') !== 'true' || target.searchParams.get('ratings') !== '' || target.searchParams.get('market') !== '')
      throw new ShoppingReadError('SESSION_SCOPE');
    for (const key of coupangConsumerReviewKeys) canonical.searchParams.set(key, target.searchParams.get(key));
  } else if (value.operation === 'quantity_info') {
    return { operation: value.operation, url: validateCoupangQuantityInfoRequestUrl(value.url), method: 'GET' };
  } else if (value.operation === 'other_sellers') {
    const keys = ['productId', 'selectedId', 'itemId'];
    const pathname = '/next-api/products/other-seller-info';
    if (target.pathname !== pathname || [...target.searchParams.keys()].some(key => !keys.includes(key)) ||
        keys.some(key => target.searchParams.getAll(key).length !== 1 || !positiveDecimalId(target.searchParams.get(key))))
      throw new ShoppingReadError('SESSION_SCOPE');
    for (const key of keys) canonical.searchParams.set(key, target.searchParams.get(key));
  } else throw new ShoppingReadError('SESSION_SCOPE');
  if (canonical.href !== value.url) throw new ShoppingReadError('SESSION_SCOPE');
  return { operation: value.operation, url: canonical.href, method: 'GET' };
}

function coupangConsumerObservations(inputs) {
  const priceScope = inputs?.scopeMode === 'price';
  const allowedKeys = priceScope ? ['scopeMode', 'observedRequests'] : ['observedRequests'];
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) ||
      (inputs.scopeMode !== undefined && inputs.scopeMode !== 'price') ||
      Object.keys(inputs).length !== allowedKeys.length || !allowedKeys.every(key => Object.hasOwn(inputs, key)) ||
      !Array.isArray(inputs.observedRequests) ||
      inputs.observedRequests.length < 1 || inputs.observedRequests.length > 16)
    throw new ShoppingReadError('SESSION_SCOPE');
  const observations = inputs.observedRequests.map(canonicalCoupangConsumerObservation);
  const keys = observations.map(row => `${row.operation}|${row.url}`);
  if (new Set(keys).size !== keys.length) throw new ShoppingReadError('SESSION_SCOPE');
  if (priceScope && (observations.length !== 2 ||
      observations.filter(row => row.operation === 'product_document').length !== 1 ||
      observations.filter(row => row.operation === 'quantity_info').length !== 1))
    throw new ShoppingReadError('SESSION_SCOPE');
  const productIds = observations.filter(row => row.operation === 'product_document')
    .map(row => new URL(row.url).pathname.match(/^\/vp\/products\/(\d+)$/)?.[1]);
  const reviewIds = observations.filter(row => row.operation === 'review_page')
    .map(row => new URL(row.url).searchParams.get('productId'));
  if (!productIds.length || (!priceScope && (!reviewIds.length || reviewIds.some(id => !productIds.includes(id)))))
    throw new ShoppingReadError('SESSION_SCOPE');
  for (const row of observations.filter(row => ['quantity_info', 'other_sellers'].includes(row.operation))) {
    const request = new URL(row.url);
    const matchingProduct = observations.filter(item => item.operation === 'product_document').some(item => {
      const product = new URL(item.url);
      return product.pathname === '/vp/products/' + request.searchParams.get('productId') &&
        product.searchParams.get('vendorItemId') === request.searchParams.get(row.operation === 'quantity_info' ? 'vendorItemId' : 'selectedId') &&
        (row.operation !== 'other_sellers' || product.searchParams.get('itemId') === request.searchParams.get('itemId'));
    });
    if (!matchingProduct) throw new ShoppingReadError('SESSION_SCOPE');
  }
  if (priceScope && observations.some(row => !['product_document', 'quantity_info'].includes(row.operation)))
    throw new ShoppingReadError('SESSION_SCOPE');
  return observations;
}

function canonicalCoupangConsumerInputs(inputs) {
  const observations = coupangConsumerObservations(inputs).map(row => ({ ...row }));
  return inputs.scopeMode === 'price'
    ? { scopeMode: 'price', observedRequests: observations }
    : { observedRequests: observations };
}

function coupangConsumerScopeMode(inputs) {
  coupangConsumerObservations(inputs);
  return inputs.scopeMode === 'price' ? 'price' : 'reviews';
}
const persistenceContext = new AsyncLocalStorage();

function requirePersistenceLock(service) {
  const held = persistenceContext.getStore();
  if (!held?.active || held.service !== service) throw new ShoppingReadError('SESSION_LOCK_REQUIRED');
}

export class ShoppingReadError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'ShoppingReadError'; this.code = code; this.details = details; }
}

export function normalizeObservedHeaderNames(headers = {}) {
  if (headers === null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) throw new ShoppingReadError('SHOPPING_HEADER_SCHEMA');
  if (Object.keys(headers).length > 64) throw new ShoppingReadError('SHOPPING_HEADER_SCHEMA');
  const normalized = new Map();
  for (const [key, value] of Object.entries(headers)) {
    if (!cookieName.test(key) || key.length > 128) throw new ShoppingReadError('SHOPPING_HEADER_SCHEMA');
    const name = key.toLowerCase();
    if (normalized.has(name) && !Object.is(normalized.get(name), value))
      throw new ShoppingReadError('AMBIGUOUS_HEADER', { header: name });
    normalized.set(name, value);
  }
  return Object.fromEntries(normalized);
}

function unknownImportFidelity() {
  return { complete: null, wireCookieCount: null, matchedCookieCount: null, unmatchedCookieCount: null };
}

function safeImportFidelity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.complete !== 'boolean' ||
      !Number.isSafeInteger(value.wireCookieCount) || value.wireCookieCount < 0 ||
      !Number.isSafeInteger(value.matchedCookieCount) || value.matchedCookieCount < 0 ||
      !Number.isSafeInteger(value.unmatchedCookieCount) || value.unmatchedCookieCount < 0 ||
      value.matchedCookieCount + value.unmatchedCookieCount !== value.wireCookieCount ||
      value.complete !== (value.unmatchedCookieCount === 0)) return unknownImportFidelity();
  return {
    complete: value.complete,
    wireCookieCount: value.wireCookieCount,
    matchedCookieCount: value.matchedCookieCount,
    unmatchedCookieCount: value.unmatchedCookieCount,
  };
}

function serviceOrigin(service) {
  if (!Object.hasOwn(shoppingOrigins, service)) throw new ShoppingReadError('SERVICE_SCOPE');
  return shoppingOrigins[service];
}

function serviceCookieRoot(service) {
  if (service === 'gmarket' || service === 'gmarket-search') return 'gmarket.co.kr';
  if (service === 'auction') return 'auction.co.kr';
  if (service === 'coupang-search' || service === 'coupang-consumer') return 'coupang.com';
  return 'naver.com';
}

export function normalizeShoppingHeaders(headers = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(normalizeObservedHeaderNames(headers))) {
    if (!retainedHeaders.has(name) && name !== 'cookie') continue;
    if (typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024 || /[\r\n\0]/.test(value)) throw new ShoppingReadError('SHOPPING_HEADER_SCHEMA');
    normalized[name] = value;
  }
  return normalized;
}

function validCookie(cookie) {
  return cookie && typeof cookie.name === 'string' && cookieName.test(cookie.name) && cookie.name.length <= 256 &&
    typeof cookie.value === 'string' && cookie.value.length <= 8192 && cookieValue.test(cookie.value) &&
    typeof cookie.domain === 'string' && /^\.?[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(cookie.domain) &&
    (cookie.hostOnly === undefined || typeof cookie.hostOnly === 'boolean') &&
    (cookie.secure === undefined || typeof cookie.secure === 'boolean') &&
    (cookie.httpOnly === undefined || typeof cookie.httpOnly === 'boolean') &&
    (cookie.path === undefined || typeof cookie.path === 'string' && cookie.path.startsWith('/') && !/[\x00-\x20\x7f;]/.test(cookie.path)) &&
    Number.isFinite(cookie.expires ?? -1) && (cookie.expires ?? -1) >= -1;
}

function validateSessionCookies(session) {
  if (!Array.isArray(session.cookies) || session.cookies.length > maxCookies) throw new ShoppingReadError('SESSION_SCHEMA');
  const hostname = new URL(serviceOrigin(session.service)).hostname;
  const minimum = serviceCookieRoot(session.service);
  for (const c of session.cookies) {
    if (!validCookie(c)) throw new ShoppingReadError('SESSION_COOKIE_SCHEMA');
    const bare = c.domain.toLowerCase().replace(/^\./, '');
    const hostOnly = c.hostOnly ?? !c.domain.startsWith('.');
    if (!(bare === minimum || bare.endsWith('.' + minimum)) ||
        !(hostname === bare || !hostOnly && hostname.endsWith('.' + bare))) throw new ShoppingReadError('SESSION_COOKIE_SCOPE');
    if ((session.service === 'coupang-search' && !coupangSessionCookieNames.has(c.name)) ||
        (session.service === 'coupang-consumer' && !coupangConsumerSessionCookieNames.has(c.name)))
      throw new ShoppingReadError('SESSION_COOKIE_SCOPE');
    if (botCookieName.test(c.name)) throw new ShoppingReadError('SESSION_VERIFICATION_COOKIE_UNSUPPORTED');
    if (c.name.startsWith('__Secure-') && !c.secure ||
        c.name.startsWith('__Host-') && (!c.secure || !hostOnly || (c.path || '/') !== '/')) throw new ShoppingReadError('SESSION_COOKIE_SCHEMA');
  }
}

function decodeJwtJsonSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0 || segment.length > 8192
    || segment.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const decoded = Buffer.from(segment, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== segment) return null;
    const value = JSON.parse(decoded);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// CT_AT is treated only as an expiry hint. This does not verify its signature,
// establish that Coupang accepted it, or imply that renewal is available.
function coupangConsumerAccessTokenExpired(session, now) {
  if (session?.service !== 'coupang-consumer' || !Array.isArray(session.cookies)) return false;
  const accessCookies = session.cookies.filter(cookie => cookie?.name === 'CT_AT');
  if (accessCookies.length !== 1 || typeof accessCookies[0].value !== 'string') return false;
  const parts = accessCookies[0].value.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  const header = decodeJwtJsonSegment(parts[0]);
  const claims = decodeJwtJsonSegment(parts[1]);
  if (!header || typeof header.alg !== 'string' || !header.alg || header.alg.length > 128
    || /[\x00-\x20\x7f]/.test(header.alg)
    || !claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return false;
  return Number.isFinite(now) && claims.exp <= now / 1000;
}

function assertCoupangConsumerAccessTokenNotExpired(session, now) {
  if (coupangConsumerAccessTokenExpired(session, now))
    throw new ShoppingReadError('SESSION_ACCESS_TOKEN_EXPIRED');
}

function validateHandoffAge(session, now, required = false) {
  if (!required && session.capturedAt === undefined) return; // Explicit in-memory callers may own their lifetime.
  const age = now - Date.parse(session.capturedAt);
  if (!Number.isFinite(age) || age < -60000 || age > lifetimeMs) throw new ShoppingReadError('SESSION_HANDOFF_STALE', { service: session.service });
}

// Both the service contract and the captured request path must match. This is not
// an origin-wide HTTP client; read cookies must never reach arbitrary write paths.
export function assertShoppingRequestScope(session, value) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new ShoppingReadError('SESSION_SCHEMA');
  let target;
  try { target = new URL(value); } catch { throw new ShoppingReadError('URL_INPUT'); }
  if (target.origin !== session.origin || session.origin !== serviceOrigin(session.service) ||
      target.username || target.password || target.hash) throw new ShoppingReadError('SESSION_ORIGIN_SCOPE');
  if (session.service === 'coupang-consumer') {
    const observations = coupangConsumerObservations(session.inputs);
    if (!observations.some(row => row.url === target.href) ||
        !observations.some(row => new URL(row.url).pathname === session.requestPath))
      throw new ShoppingReadError('SESSION_SCOPE');
    return target;
  }
  const base = readPaths[session.service];
  if (!(target.pathname === base || base.endsWith('/') && target.pathname.startsWith(base)) ||
      target.pathname !== (session.requestPath ?? base)) throw new ShoppingReadError('SESSION_SCOPE');
  if (session.service === 'coupang-search' && (!target.searchParams.get('q')?.trim() || !target.searchParams.has('_rsc')))
    throw new ShoppingReadError('SESSION_SCOPE');
  return target;
}

function matchingCookies(session, url, now) {
  validateHandoffAge(session, now);
  validateSessionCookies(session);
  assertCoupangConsumerAccessTokenNotExpired(session, now);
  if (session.invalidatedAt) throw new ShoppingReadError('REAUTH_REQUIRED');
  const cookies = session.cookies.map((cookie, index) => ({ cookie, index }))
    .filter(({ cookie }) => cookieMatches(cookie, url, now))
    .sort((a, b) => ((b.cookie.path || '/').length - (a.cookie.path || '/').length) || a.index - b.index)
    .map(({ cookie }) => cookie);
  const missing = requiredCookieNames(session.service).filter(name => !cookies.some(c => c.name === name && c.value));
  if (missing.length) throw new ShoppingReadError('SESSION_REQUIRED_COOKIES_UNAVAILABLE', { missingRequiredCookieCount: missing.length });
  if (!cookies.length) throw new ShoppingReadError('SESSION_COOKIES_EXPIRED');
  return cookies;
}

export function cookieMatches(cookie, url, now = Date.now()) {
  const target = new URL(url);
  if (!validCookie(cookie)) return false;
  const expires = Number(cookie.expires ?? -1);
  if (!Number.isFinite(expires) || expires < -1) return false;
  const domain = String(cookie.domain ?? '').toLowerCase();
  const bare = domain.replace(/^\./, '');
  const hostOnly = cookie.hostOnly ?? !domain.startsWith('.');
  if (!bare || !(target.hostname === bare || (!hostOnly && target.hostname.endsWith('.' + bare)))) return false;
  const cookiePath = cookie.path || '/';
  if (!(target.pathname === cookiePath || (target.pathname.startsWith(cookiePath) && (cookiePath.endsWith('/') || target.pathname[cookiePath.length] === '/')))) return false;
  if (cookie.secure && target.protocol !== 'https:') return false;
  return !(expires >= 0 && expires * 1000 <= now);
}

export function prepareShoppingSession(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ShoppingReadError('SESSION_SCHEMA');
  const origin = serviceOrigin(input.service);
  if (input.origin !== origin || !Array.isArray(input.cookies) || input.cookies.length > maxCookies) throw new ShoppingReadError('SESSION_SCOPE');
  let requestUrl;
  try { requestUrl = new URL(input.requestUrl ?? readPaths[input.service], origin); } catch { throw new ShoppingReadError('SESSION_SCOPE'); }
  const inputs = input.service === 'coupang-consumer'
    ? canonicalCoupangConsumerInputs(input.inputs)
    : input.inputs ?? {};
  assertShoppingRequestScope({ service: input.service, origin, requestPath: requestUrl.pathname, inputs }, requestUrl);
  if (input.service === 'coupang-search' && (requestUrl.pathname !== '/np/search' ||
      !requestUrl.searchParams.get('q')?.trim() || !requestUrl.searchParams.has('_rsc')))
    throw new ShoppingReadError('SESSION_SCOPE');
  const headers = normalizeShoppingHeaders(input.headers);
  if (headers.origin && headers.origin !== origin) throw new ShoppingReadError('SESSION_SCOPE');
  const parts = (headers.cookie ?? '').split(';').map(part => part.trim()).filter(Boolean);
  if (parts.some(part => part.indexOf('=') < 1)) throw new ShoppingReadError('SESSION_COOKIE_SCHEMA');
  const wire = parts.map(part => {
    const index = part.indexOf('='); return { name: part.slice(0, index), value: part.slice(index + 1) };
  });
  if (wire.length > maxCookies || wire.some(c => !cookieName.test(c.name) || !cookieValue.test(c.value))) throw new ShoppingReadError('SESSION_COOKIE_SCHEMA');
  if (input.service === 'coupang-search' &&
      (wire.some(c => !coupangSessionCookieNames.has(c.name)) ||
       !wire.some(c => c.name === 'ILOGIN') || !wire.some(c => c.name === 'CT_AT')))
    throw new ShoppingReadError('SESSION_COOKIE_SCOPE');
  if (input.service === 'coupang-consumer' &&
      (wire.some(c => !coupangConsumerSessionCookieNames.has(c.name)) || !wire.some(c => c.name === 'CT_ATH')))
    throw new ShoppingReadError('SESSION_COOKIE_SCOPE');
  if (wire.some(c => botCookieName.test(c.name))) throw new ShoppingReadError('SESSION_VERIFICATION_COOKIE_UNSUPPORTED');
  const hostname = new URL(origin).hostname;
  const minimumDomain = serviceCookieRoot(input.service);
  const consumedMetadataIndexes = new Set();
  const matches = wire.map(pair => {
    const metadataIndex = input.cookies.findIndex((c, index) => !consumedMetadataIndexes.has(index) &&
      c?.name === pair.name && c?.value === pair.value && cookieMatches(c, requestUrl, now));
    if (metadataIndex >= 0) consumedMetadataIndexes.add(metadataIndex);
    const cookie = metadataIndex >= 0 ? input.cookies[metadataIndex] : null;
    if (!cookie) return { pair, cookie: null };
    const bare = String(cookie.domain).toLowerCase().replace(/^\./, '');
    if (!(bare === minimumDomain || bare.endsWith('.' + minimumDomain)) || !(hostname === bare || hostname.endsWith('.' + bare)) ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) || /[;\r\n\0]/.test(cookie.value)) return { pair, cookie: null };
    return { pair, cookie: { name: cookie.name, value: cookie.value, domain: cookie.domain, hostOnly: cookie.hostOnly ?? !cookie.domain.startsWith('.'), path: cookie.path || '/', secure: !!cookie.secure, httpOnly: !!cookie.httpOnly, expires: Number(cookie.expires ?? -1) } };
  });
  const unmatched = matches.filter(match => !match.cookie);
  if (unmatched.length) {
    const names = [...new Set(unmatched.map(({ pair }) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(pair.name) ? pair.name : '<invalid>'))];
    throw new ShoppingReadError('SESSION_COOKIE_METADATA_MISMATCH', {
      wireCookieCount: wire.length,
      matchedCookieCount: wire.length - unmatched.length,
      unmatchedCookieCount: unmatched.length,
      missingCookieNames: names.slice(0, 32),
      missingCookieNameCount: names.length,
    });
  }
  const cookies = matches.map(match => match.cookie);
  delete headers.cookie;
  delete headers.referer;
  if (!cookies.length) throw new ShoppingReadError('SCOPED_SESSION_MISSING');
  const session = { schemaVersion: 1, service: input.service, origin, capturedAt: new Date(now).toISOString(), requestPath: requestUrl.pathname, headers, cookies,
    importFidelity: { complete: true, wireCookieCount: wire.length, matchedCookieCount: cookies.length, unmatchedCookieCount: 0 }, inputs };
  matchingCookies(session, requestUrl, now);
  return session;
}

function storePath(service) { serviceOrigin(service); return path.join(root, service + '.dpapi'); }

function runStore(service, mode, input = '') {
  if (mode === 'set') requirePersistenceLock(service);
  if (mode === 'set' && Buffer.byteLength(input) > 768 * 1024) throw new ShoppingReadError('SESSION_SERIALIZATION_LIMIT');
  if (process.platform !== 'win32') throw new ShoppingReadError('DPAPI_WINDOWS_REQUIRED');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-Mode', mode, '-Path', storePath(service), '-Service', service], {
    input, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new ShoppingReadError('CREDENTIAL_STORE_' + mode.toUpperCase());
  return result.stdout;
}

export async function withShoppingSessionLock(service, callback) {
  serviceOrigin(service);
  let release;
  try { release = await acquireRunLock(path.join(root, 'locks', service)); }
  catch { throw new ShoppingReadError('SESSION_BUSY'); }
  const held = { service, active: true };
  try { return await persistenceContext.run(held, callback); }
  finally { held.active = false; await release(); }
}

export async function saveShoppingSession(input) {
  const session = prepareShoppingSession(input);
  await withShoppingSessionLock(session.service, async () => runStore(session.service, 'set', JSON.stringify(session)));
  return { stored: true, service: session.service, provider: 'windows_current_user_dpapi', capturedAt: session.capturedAt,
    cookieCount: session.cookies.length, importFidelity: safeImportFidelity(session.importFidelity) };
}

export function loadShoppingSession(service, now = Date.now()) {
  if (!existsSync(storePath(service))) throw new ShoppingReadError('SESSION_PROVIDER_MISSING', { service });
  let session;
  try { session = JSON.parse(runStore(service, 'get')); } catch (error) { if (error instanceof ShoppingReadError) throw error; throw new ShoppingReadError('SESSION_SCHEMA'); }
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new ShoppingReadError('SESSION_SCHEMA');
  if (session.schemaVersion !== 1 || session.service !== service || session.origin !== serviceOrigin(service) || !Array.isArray(session.cookies)) throw new ShoppingReadError('SESSION_SCOPE');
  validateSessionCookies(session);
  const expectedPath = readPaths[service], capturedPath = session.requestPath ?? expectedPath;
  if (service === 'coupang-consumer') {
    const observations = coupangConsumerObservations(session.inputs);
    if (typeof capturedPath !== 'string' || !observations.some(row => new URL(row.url).pathname === capturedPath))
      throw new ShoppingReadError('SESSION_SCOPE');
  } else if (typeof capturedPath !== 'string' || /[?#\\\x00-\x20]/.test(capturedPath) ||
      !(capturedPath === expectedPath || expectedPath.endsWith('/') && capturedPath.startsWith(expectedPath)))
    throw new ShoppingReadError('SESSION_SCOPE');
  validateHandoffAge(session, now, true);
  assertCoupangConsumerAccessTokenNotExpired(session, now);
  // Pre-integrity DPAPI sessions remain usable, but their import completeness is unknown.
  session.importFidelity = safeImportFidelity(session.importFidelity);
  return session;
}

export function shoppingSessionStatus(service) {
  try {
    const s = loadShoppingSession(service);
    const requestPath = typeof s.requestPath === 'string' && s.requestPath.startsWith('/') && !s.requestPath.startsWith('//') ? s.requestPath : readPaths[service];
    let activeCookieCount = 0, code = null, activeObservedRequestCount = null;
    if (service === 'coupang-consumer') {
      const targets = coupangConsumerObservations(s.inputs).map(row => row.url);
      const counts = [];
      for (const target of targets) {
        try { counts.push(matchingCookies(s, target, Date.now()).length); }
        catch (e) { code ??= e.code ?? 'SESSION_SCHEMA'; }
      }
      if (counts.length) activeCookieCount = Math.min(...counts);
      activeObservedRequestCount = counts.length;
    } else {
      try { activeCookieCount = matchingCookies(s, s.origin + requestPath, Date.now()).length; } catch (e) { code = e.code ?? 'SESSION_SCHEMA'; }
    }
    return { service, present: true, usableForAttempt: code === null, ...(code ? { code } : {}),
      capturedAt: s.capturedAt, handoffExpiresAt: new Date(Date.parse(s.capturedAt) + lifetimeMs).toISOString(),
      activeCookieCount, requiredCookieCount: requiredCookieNames(service).length,
      ...(service === 'coupang-consumer' ? { observedRequestCount: s.inputs.observedRequests.length, activeObservedRequestCount,
        scopeMode: coupangConsumerScopeMode(s.inputs), excludedBoundProof: true } : {}),
      authenticatedOwnerVerified: false, liveReplayVerified: false, renewalImplemented: false,
      browserRequiredForRead: false, importFidelity: safeImportFidelity(s.importFidelity) };
  } catch (e) {
    return { service, present: Object.hasOwn(shoppingOrigins, service) && existsSync(storePath(service)), usableForAttempt: false,
      code: e.code ?? 'SESSION_SCHEMA', authenticatedOwnerVerified: false, liveReplayVerified: false,
      ...(service === 'coupang-consumer' ? { excludedBoundProof: true } : {}),
      renewalImplemented: false, browserRequiredForRead: false, importFidelity: unknownImportFidelity() };
  }
}

export function headersForShoppingSession(session, url, referer = null) {
  assertShoppingRequestScope(session, url);
  if (referer) {
    let parsed; try { parsed = new URL(referer); } catch { throw new ShoppingReadError('SESSION_ORIGIN_SCOPE'); }
    if (parsed.origin !== session.origin || parsed.username || parsed.password || parsed.hash) throw new ShoppingReadError('SESSION_ORIGIN_SCOPE');
    if (session.service === 'coupang-consumer' &&
        !coupangConsumerObservations(session.inputs).some(row => row.operation === 'product_document' && row.url === parsed.href))
      throw new ShoppingReadError('SESSION_SCOPE');
  }
  const cookies = matchingCookies(session, url, Date.now());
  const headers = normalizeShoppingHeaders(session.headers);
  delete headers.cookie; delete headers.referer;
  if (headers.origin && headers.origin !== session.origin) throw new ShoppingReadError('SESSION_ORIGIN_SCOPE');
  return { ...headers, ...(referer ? { referer } : {}), cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') };
}

export function rotateShoppingCookies(session, setCookies, requestUrl, now = Date.now()) {
  const url = assertShoppingRequestScope(session, requestUrl);
  validateSessionCookies(session);
  if (!Array.isArray(setCookies) || setCookies.length > 100) throw new ShoppingReadError('SESSION_COOKIE_ROTATION_SCHEMA');
  let changed = false;
  for (const line of setCookies) {
    if (typeof line !== 'string' || line.length > 8192 || /[\r\n\0]/.test(line)) continue;
    const pieces = line.split(';').map(s => s.trim()); const first = pieces.shift(); const eq = first.indexOf('=');
    if (eq < 1) continue;
    const cookie = { name: first.slice(0, eq), value: first.slice(eq + 1), domain: url.hostname, hostOnly: true, path: url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/', secure: false, httpOnly: false, expires: -1 };
    if (botCookieName.test(cookie.name)) continue;
    if ((session.service === 'coupang-search' && !coupangSessionCookieNames.has(cookie.name)) ||
        (session.service === 'coupang-consumer' && !coupangConsumerSessionCookieNames.has(cookie.name))) continue;
    let maxAge;
    for (const piece of pieces) {
      const i = piece.indexOf('='); const key = (i < 0 ? piece : piece.slice(0, i)).toLowerCase(); const value = i < 0 ? '' : piece.slice(i + 1);
      if (key === 'domain') { cookie.domain = '.' + value.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; }
      else if (key === 'path' && value.startsWith('/')) cookie.path = value;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'httponly') cookie.httpOnly = true;
      else if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value) / 1000;
      else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    }
    if (maxAge !== undefined && !Number.isFinite(maxAge)) continue;
    if (maxAge !== undefined) cookie.expires = now / 1000 + maxAge;
    if (!Number.isSafeInteger(maxAge ?? 0) || !Number.isFinite(cookie.expires)) continue;
    const deleted = maxAge !== undefined ? maxAge <= 0 : cookie.expires !== -1 && cookie.expires * 1000 <= now;
    if (!validCookie({ ...cookie, expires: deleted ? 0 : cookie.expires })) continue;
    const domain = cookie.domain.replace(/^\./, '');
    const minimumDomain = serviceCookieRoot(session.service);
    if (!(domain === minimumDomain || domain.endsWith('.' + minimumDomain)) || !(url.hostname === domain || url.hostname.endsWith('.' + domain)) || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) || /[\r\n\0]/.test(cookie.value)) continue;
    if (cookie.name.startsWith('__Secure-') && !cookie.secure) continue;
    if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/' || cookie.domain.startsWith('.'))) continue;
    const sameIdentity = c => c?.name === cookie.name && String(c.domain ?? '').toLowerCase().replace(/^\./, '') === domain && (c.path || '/') === cookie.path;
    const matchingIndexes = [];
    for (let i = 0; i < session.cookies.length; i++) if (sameIdentity(session.cookies[i])) matchingIndexes.push(i);
    if (matchingIndexes.length) {
      const firstIndex = matchingIndexes[0];
      if (deleted) {
        for (const index of matchingIndexes.reverse()) session.cookies.splice(index, 1);
      } else {
        session.cookies[firstIndex] = cookie;
        for (const index of matchingIndexes.slice(1).reverse()) session.cookies.splice(index, 1);
      }
    } else if (!deleted) {
      if (session.cookies.length >= maxCookies) throw new ShoppingReadError('SESSION_COOKIE_LIMIT');
      session.cookies.push(cookie);
    } else continue;
    changed = true;
  }
  return changed;
}

export function applyShoppingCookieRotation(session, setCookies, requestUrl, now = Date.now()) {
  requirePersistenceLock(session.service);
  const changed = rotateShoppingCookies(session, setCookies, requestUrl, now);
  if (changed) runStore(session.service, 'set', JSON.stringify(session));
  return changed;
}

// Persist only sanitized auth rejection metadata. Rotation never clears this flag
// or extends the handoff window; a fresh authorized bootstrap must replace it.
export function invalidateShoppingSession(session, { persist = false, now = Date.now() } = {}) {
  if (persist) requirePersistenceLock(session.service);
  session.invalidatedAt = new Date(now).toISOString();
  if (persist) runStore(session.service, 'set', JSON.stringify(session));
}
