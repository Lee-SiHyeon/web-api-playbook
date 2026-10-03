import path from 'node:path';
import { ProtectedStore } from '../protected-store.mjs';
import { ScopedSession } from '../scoped-session.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WriteJournal } from '../write-journal.mjs';

const API = 'https://gw-brandconnect.naver.com';
const WEB = 'https://brandconnect.naver.com';
const STATE = 'brandconnect-state';
const ORIGINS = [API];
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const fail = (code, receipt) => { throw new BrandconnectError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => (typeof value === 'string' && /^\d{1,32}$/.test(value))
  || (Number.isSafeInteger(value) && value > 0);

export class BrandconnectError extends Error {
  constructor(code, receipt) { super(code); this.name = 'BrandconnectError'; this.code = code; this.receipt = receipt; }
}

function exactKeys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INPUT_INVALID');
}

function text(value, { max = 256, min = 1 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\0\r\n]/.test(value)) fail('INPUT_INVALID');
  return value;
}

function spaceId(value) {
  if (!safeId(value)) fail('SPACE_ID_INVALID');
  return String(value);
}

function pageNumber(value, { min = 1, max = 100 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INPUT_INVALID');
  return value;
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('DATE_INVALID');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('DATE_INVALID');
  return value;
}

function kstDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizedUrl(value, { origin, pathPrefix } = {}) {
  let url;
  try { url = new URL(text(value, { max: 4096 })); } catch { fail('URL_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.hash
    || !url.pathname.startsWith(pathPrefix) || url.pathname.length <= pathPrefix.length) fail('URL_SCOPE_INVALID');
  return url;
}

function shortNaverUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.origin === 'https://naver.me' && !url.username && !url.password && !url.hash
    && url.pathname.length > 1;
}

function selectedCookies(cookies, now) {
  if (!Array.isArray(cookies) || cookies.length < 1 || cookies.length > 128) fail('AUTH_IMPORT_INVALID');
  const selected = new Map();
  for (const cookie of cookies) {
    if (!object(cookie) || !['NID_AUT', 'NID_SES', 'NID_JKL'].includes(cookie.name)) continue;
    const domain = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase() : '';
    const host = domain.replace(/^\./, '');
    const parentDomain = host === 'naver.com' && cookie.hostOnly !== true;
    const serviceDomain = host === 'gw-brandconnect.naver.com';
    if ((!parentDomain && !serviceDomain) || cookie.path !== '/') fail('COOKIE_SCOPE_INVALID');
    const expiry = cookie.expirationDate ?? cookie.expires;
    if (expiry != null && (typeof expiry !== 'number' || !Number.isFinite(expiry))) fail('COOKIE_INVALID');
    if (expiry > 0 && expiry * 1000 <= now) continue;
    if (typeof cookie.value !== 'string' || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,16384}$/.test(cookie.value)) fail('COOKIE_INVALID');
    if (selected.has(cookie.name)) fail('COOKIE_AMBIGUOUS');
    selected.set(cookie.name, {
      ...cookie,
      domain: domain.startsWith('.') ? domain : (parentDomain ? '.naver.com' : domain),
      hostOnly: serviceDomain ? cookie.hostOnly === true : false,
      path: '/',
    });
  }
  if (!selected.has('NID_AUT') || !selected.has('NID_SES')) fail('AUTH_MISSING');
  return [...selected.values()];
}

function requiredCookiesPresent(session, now) {
  let cookies;
  try { cookies = session.toJSON().cookieJar.cookies; } catch { return false; }
  const found = new Set();
  for (const cookie of cookies) {
    if (!['NID_AUT', 'NID_SES'].includes(cookie.key) || cookie.path !== '/') continue;
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (!['naver.com', 'gw-brandconnect.naver.com'].includes(domain)) continue;
    if (typeof cookie.value !== 'string' || !cookie.value) continue;
    const expiry = cookie.expires === 'Infinity' || cookie.expires == null ? Infinity : Date.parse(cookie.expires);
    if (Number.isFinite(expiry) && expiry <= now) continue;
    if (!Number.isFinite(expiry) && expiry !== Infinity) continue;
    found.add(cookie.key);
  }
  return found.has('NID_AUT') && found.has('NID_SES');
}

function validateReferer(value, selectedSpace) {
  if (value == null) return `${WEB}/`;
  let url;
  try { url = new URL(text(value, { max: 1024 })); } catch { fail('REFERER_INVALID'); }
  if (url.origin !== WEB || url.username || url.password || url.search || url.hash) fail('REFERER_INVALID');
  if (url.pathname !== '/' && !url.pathname.startsWith(`/${selectedSpace}/`)) fail('REFERER_INVALID');
  return url.href;
}

function validateUserAgent(value) {
  if (value == null) return DEFAULT_USER_AGENT;
  return text(value, { max: 512 });
}

function validatedObservedUserAgent(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || !/^[\x20-\x7e]+$/.test(value) || !value.trim()) fail('USER_AGENT_INVALID');
  return value;
}

function plainJson(raw) {
  const value = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  if (!object(value) && !Array.isArray(value)) fail('RESPONSE_SCHEMA_INVALID');
  return value;
}

function unwrappedData(value) {
  return object(value.data) ? value.data : value;
}

function validatedDateRange(input, minKey = 'minCreatedDate', maxKey = 'maxCreatedDate') {
  const min = date(input?.[minKey]);
  const max = date(input?.[maxKey]);
  if (min > max) fail('DATE_RANGE_INVALID');
  return { min, max };
}

export function createBrandconnectAuth({ store = new ProtectedStore(), fetchImpl = fetch, now = Date.now } = {}) {
  const lock = callback => withSessionLock(callback, { root: path.join(store.directory, 'locks'), key: STATE });
  const journal = new WriteJournal({ root: path.join(store.directory, 'journal'), service: 'brandconnect' });
  const save = (state, session) => store.write(STATE, JSON.stringify({
    ...state, session: session.toJSON(), updatedAt: new Date(now()).toISOString(),
  }));

  function newSession(input) {
    const selectedSpace = spaceId(input.spaceId);
    const userAgent = validateUserAgent(input.userAgent);
    const referer = validateReferer(input.referer, selectedSpace);
    const cookies = selectedCookies(input.cookies, now());
    const session = new ScopedSession({
      allowedOrigins: ORIGINS,
      cookieOrigins: ORIGINS,
      cookies,
      defaultHeaders: { accept: 'application/json', 'user-agent': userAgent },
      headersByOrigin: { [API]: { referer, 'x-space-id': selectedSpace } },
      timeoutMs: 15000,
      maxResponseBytes: 4 * 1024 * 1024,
      maxRequestBytes: 256 * 1024,
      maxRedirects: 0,
      fetchImpl,
    });
    if (!requiredCookiesPresent(session, now())) fail('AUTH_MISSING');
    return { session, selectedSpace, referer, userAgent };
  }

  function load() {
    const raw = store.read(STATE);
    if (!raw) fail('SESSION_MISSING');
    let state;
    try { state = JSON.parse(raw); } catch { fail('AUTH_STATE_INVALID'); }
    if (!object(state) || state.version !== 1 || typeof state.expectedLoginId !== 'string'
      || !state.expectedLoginId || !safeId(state.spaceId) || typeof state.referer !== 'string'
      || typeof state.userAgent !== 'string'
      || JSON.stringify(state.session?.allowedOrigins) !== JSON.stringify(ORIGINS)
      || JSON.stringify(state.session?.cookieOrigins) !== JSON.stringify(ORIGINS)) fail('AUTH_STATE_INVALID');
    let session;
    try { session = ScopedSession.fromJSON(state.session, { fetchImpl }); } catch { fail('AUTH_STATE_INVALID'); }
    if (!requiredCookiesPresent(session, now())) fail('REAUTH_REQUIRED');
    return { state, session };
  }

  async function request(session, state, pathOrUrl, { method = 'GET', body, empty = false, operation, write = false } = {}) {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : API + pathOrUrl;
    let result;
    try {
      result = await session.request(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      });
    } catch (error) {
      const code = /^SCOPED_SESSION_[A-Z_]+$/.test(error?.code || '') ? error.code : 'TRANSPORT_FAILED';
      fail(write ? 'WRITE_OUTCOME_UNKNOWN' : code, { operation, method, browserUsed: false });
    }
    const raw = typeof result.raw === 'string' ? result.raw : Buffer.from(result.raw ?? '').toString('utf8');
    const receipt = {
      operation, method, origin: API, path: new URL(url).pathname,
      httpStatus: result.status, responseBytes: Buffer.byteLength(raw),
      checkedAt: new Date(now()).toISOString(), browserUsed: false, executionMode: 'pure_http',
    };
    if (!requiredCookiesPresent(session, now())) fail('AUTH_SESSION_INVALIDATED', receipt);
    if (result.status === 401) fail('REAUTH_REQUIRED', receipt);
    if (result.status === 403) fail('FORBIDDEN', receipt);
    if (result.status === 429) fail('THROTTLED', receipt);
    if (result.status !== 200) fail(write ? 'WRITE_OUTCOME_UNKNOWN' : 'HTTP_STATUS', receipt);
    if (empty) {
      if (raw.trim() !== '') fail('RESPONSE_SCHEMA_INVALID', receipt);
      return { body: null, receipt };
    }
    const mime = result.headers?.['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (mime !== 'application/json' && mime !== 'application/problem+json') {
      fail(write ? 'WRITE_OUTCOME_UNKNOWN' : 'RESPONSE_MIME_INVALID', receipt);
    }
    let data;
    try { data = plainJson(raw); } catch (error) {
      if (error instanceof BrandconnectError) fail(write ? 'WRITE_OUTCOME_UNKNOWN' : error.code, receipt);
      fail(write ? 'WRITE_OUTCOME_UNKNOWN' : 'RESPONSE_JSON_INVALID', receipt);
    }
    return { body: data, receipt };
  }

  async function owner(session, state) {
    const me = await request(session, state, '/brand-connect/query/me', { operation: 'account' });
    const data = me.body;
    if (!object(data)) fail('OWNER_SCHEMA_INVALID', me.receipt);
    if (data.loginId == null || data.loginId === '') fail('REAUTH_REQUIRED', me.receipt);
    if (typeof data.loginId !== 'string' || typeof data.creator !== 'boolean' || typeof data.partner !== 'boolean'
      || !Array.isArray(data.activeSpaceIds) || !data.activeSpaceIds.every(safeId)) fail('OWNER_SCHEMA_INVALID', me.receipt);
    if (data.loginId !== state.expectedLoginId) fail('ACCOUNT_MISMATCH', me.receipt);
    if (data.creator !== true) fail('ENTITLEMENT_REQUIRED', me.receipt);
    const active = data.activeSpaceIds.map(String);
    if (!active.includes(String(state.spaceId))) fail('SPACE_NOT_ACTIVE', me.receipt);
    const checkUrl = new URL('/brand-connect/query/space/check-owner', API);
    checkUrl.searchParams.set('spaceId', String(state.spaceId));
    const ownerCheck = await request(session, state, checkUrl.href, { operation: 'space-owner', empty: true });
    return {
      authenticated: true, identityMatched: true, creator: true,
      spaceId: String(state.spaceId), activeSpaceVerified: true,
      ownerVerified: true, browserUsed: false, renewal: 'unverified',
      receipt: { ...ownerCheck.receipt, priorRead: 'account' },
    };
  }

  async function withSession(callback) {
    return lock(async () => {
      const { state, session } = load();
      try {
        const verified = await owner(session, state);
        const result = await callback(session, state, verified);
        return result;
      } finally {
        save(state, session);
      }
    });
  }

  async function readJson(session, state, pathOrUrl, options = {}) {
    const { body, receipt } = await request(session, state, pathOrUrl, options);
    return { data: body, receipt };
  }

  async function travelLinksInternal(session, state, { minCreatedDate, maxCreatedDate, pageSize = 20, page = 1 } = {}) {
    const range = validatedDateRange({ minCreatedDate, maxCreatedDate });
    pageSize = pageNumber(pageSize, { max: 100 });
    page = pageNumber(page, { max: 10000 });
    const url = new URL('/affiliate/query/connect-urls/search', API);
    url.searchParams.set('minCreatedDate', range.min);
    url.searchParams.set('maxCreatedDate', range.max);
    url.searchParams.set('sortType', 'CREATED_AT');
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('page', String(page));
    const { data, receipt } = await readJson(session, state, url.href, { operation: 'travel-links' });
    if (!Array.isArray(data.data) || !object(data.paging) || typeof data.paging.total !== 'number') fail('TRAVEL_LINKS_SCHEMA_INVALID', receipt);
    return { data, receipt };
  }

  async function shoppingLinksInternal(session, state, input = {}) {
    const range = validatedDateRange(input, 'minAffiliateUrlCreatedDate', 'maxAffiliateUrlCreatedDate');
    const pageSize = pageNumber(input.pageSize ?? 10, { max: 100 });
    const page = pageNumber(input.page ?? 1, { max: 10000 });
    const name = input.name == null ? '' : text(input.name, { max: 200, min: 0 });
    const minCommissionRate = input.minCommissionRate ?? 1;
    const maxCommissionRate = input.maxCommissionRate ?? 50;
    if (!Number.isFinite(minCommissionRate) || !Number.isFinite(maxCommissionRate)
      || minCommissionRate < 0 || maxCommissionRate > 100 || minCommissionRate > maxCommissionRate) fail('INPUT_INVALID');
    const body = {
      name,
      enable: true,
      minCommissionRate,
      maxCommissionRate,
      minAffiliateUrlCreatedDate: range.min,
      maxAffiliateUrlCreatedDate: range.max,
      pageSize,
      sortType: 'AFFILIATE_URL_CREATED_AT',
      page,
    };
    const { data, receipt } = await readJson(session, state, '/affiliate/query/affiliate-urls/search', {
      operation: 'shopping-links', method: 'POST', body,
    });
    if (!Array.isArray(data.data) || !object(data.paging) || typeof data.paging.total !== 'number') fail('SHOPPING_LINKS_SCHEMA_INVALID', receipt);
    return { data, receipt };
  }

  async function detailTravel(session, state, productUrl) {
    const product = normalizedUrl(productUrl, { origin: 'https://pkgtour.naver.com', pathPrefix: '/products/' });
    const url = new URL('/affiliate/query/connect/products/detail', API);
    url.searchParams.set('productUrl', product.href);
    const { data: response, receipt } = await readJson(session, state, url.href, { operation: 'travel-detail' });
    const data = unwrappedData(response);
    if (data.connectServiceType !== 'TRAVEL_PACKAGE' || typeof data.affiliateEnabled !== 'boolean'
      || typeof data.url !== 'string' || !Object.hasOwn(data, 'shortenUrl')) fail('TRAVEL_DETAIL_SCHEMA_INVALID', receipt);
    let returned;
    try { returned = new URL(data.url); } catch { fail('TRAVEL_DETAIL_SCHEMA_INVALID', receipt); }
    // Since 2026-09-28 the detail echoes the product with ?reqChannel=brandconnect and a literal "|" where the request
    // had %7C. Same product: compare origin, decoded path and the remaining query without that channel tag.
    const identity = u => { const x = new URL(u); x.searchParams.delete('reqChannel'); return `${x.origin}${decodeURIComponent(x.pathname)}${x.searchParams.size ? `?${x.searchParams}` : ''}`; };
    if (identity(returned.href) !== identity(product.href)) fail('TRAVEL_DETAIL_MISMATCH', receipt);
    return { data, receipt, productUrl: product.href };
  }

  async function detailShopping(session, state, affiliateProductId) {
    if (!safeId(affiliateProductId)) fail('PRODUCT_ID_INVALID');
    const id = String(affiliateProductId);
    const { data: response, receipt } = await readJson(session, state,
      `/affiliate/query/affiliate-products/${encodeURIComponent(id)}`, { operation: 'shopping-detail' });
    const data = unwrappedData(response);
    if (String(data.id) !== id || typeof data.enabled !== 'boolean' || typeof data.storeStatus !== 'string'
      || typeof data.affiliateStorePenalty !== 'boolean' || typeof data.productStatus !== 'string'
      || !Object.hasOwn(data, 'shortenUrl')) fail('SHOPPING_DETAIL_SCHEMA_INVALID', receipt);
    return { data, receipt };
  }

  function eligibleTravel(detail) {
    if (detail.data.connectServiceType !== 'TRAVEL_PACKAGE' || detail.data.affiliateEnabled !== true) fail('PRODUCT_NOT_ELIGIBLE', detail.receipt);
    if (detail.data.shortenUrl != null && !shortNaverUrl(detail.data.shortenUrl)) fail('TRAVEL_DETAIL_SCHEMA_INVALID', detail.receipt);
    return detail.data.shortenUrl ?? null;
  }

  function eligibleShopping(detail) {
    const data = detail.data;
    if (data.enabled !== true || data.storeStatus !== 'ACTIVE' || data.affiliateStorePenalty !== false || data.productStatus !== 'SALE') {
      fail('PRODUCT_NOT_ELIGIBLE', detail.receipt);
    }
    if (data.shortenUrl != null && !shortNaverUrl(data.shortenUrl)) fail('SHOPPING_DETAIL_SCHEMA_INVALID', detail.receipt);
    return data.shortenUrl ?? null;
  }

  async function findTravelLink(session, state, resourceId, returnedUrl, since = now()) {
    if (!resourceId) return undefined;
    try {
      const today = kstDate(now());
      for (let page = 1; page <= 100; page++) {
      const { data } = await travelLinksInternal(session, state, { minCreatedDate: kstDate(since), maxCreatedDate: today, pageSize: 100, page });
      const match = data.data.find(item => String(item.connectUrlId) === String(resourceId));
      if (!match) { if (page * 100 >= data.paging.total) return null; continue; }
      if (!shortNaverUrl(match.shortenUrl) || (returnedUrl && match.shortenUrl !== returnedUrl)) return false;
      return match;
      }
      return null;
    } catch { return undefined; }
  }

  async function findShoppingLink(session, state, affiliateProductId, resourceId, returnedUrl, since = now()) {
    try {
      const today = kstDate(now());
      for (let page = 1; page <= 100; page++) {
      const { data } = await shoppingLinksInternal(session, state, {
        minAffiliateUrlCreatedDate: kstDate(since), maxAffiliateUrlCreatedDate: today, pageSize: 100, page,
      });
      const match = data.data.find(item => String(item.affiliateUrlId) === String(resourceId)
        || (!resourceId && String(item.id) === String(affiliateProductId)));
      if (!match) { if (page * 100 >= data.paging.total) return null; continue; }
      if (String(match.id) !== String(affiliateProductId) || !shortNaverUrl(match.shortenUrl)
        || (returnedUrl && match.shortenUrl !== returnedUrl)) return false;
      return match;
      }
      return null;
    } catch { return undefined; }
  }

  async function reconcilePrior(key, prior, readback) {
    const resourceId = prior.safeReceipt?.resourceId ?? null;
    const found = await readback(resourceId, null);
    const result = found ? 'found' : (found === false ? 'not-found' : 'ambiguous');
    if (prior.status !== 'reconciled' && ['reserved', 'needs-reconciliation'].includes(prior.status)
      || prior.status === 'finished' && /readback|verify/i.test(prior.state || '')) {
      await journal.reconcile(key, { result, independentRead: found !== undefined, resourceIdPresent: !!resourceId });
    }
    return { result, resourceId, found: found || null };
  }

  async function createTravelLink(session, state, input) {
    exactKeys(input, ['productUrl']);
    const detail = await detailTravel(session, state, input.productUrl);
    const existingUrl = eligibleTravel(detail);
    const target = { spaceId: String(state.spaceId), targetHost: 'pkgtour.naver.com', productType: 'TRAVEL_PACKAGE' };
    const payload = { productUrl: detail.productUrl };
    const key = journal.key('create-travel-link', target, payload);
    const prior = await journal.read(key);
    if (prior) {
      const checked = await reconcilePrior(key, prior, (id, url) => findTravelLink(session, state, id, url, Date.parse(prior.createdAt)));
      return { outcome: checked.result === 'found' ? 'already_created' : 'previous_attempt_unresolved',
        writeSuppressed: true, resourceId: checked.resourceId, url: checked.found?.shortenUrl ?? null };
    }
    if (existingUrl) return { outcome: 'existing', url: existingUrl, productEligible: true, receipt: detail.receipt };
    await journal.reserve(key, { operation: 'create-travel-link', spaceId: String(state.spaceId), targetHost: 'pkgtour.naver.com' });
    let created;
    try {
      const { data: response, receipt } = await readJson(session, state, '/affiliate/command/connect-urls', {
        operation: 'create-travel-link', method: 'POST', body: { url: detail.productUrl }, write: true,
      });
      const data = unwrappedData(response);
      if (!safeId(data.connectUrlId) || !shortNaverUrl(data.url)) fail('WRITE_OUTCOME_UNKNOWN', receipt);
      created = { resourceId: String(data.connectUrlId), url: data.url, receipt };
      await journal.finish(key, 'acknowledged_requires_readback', {
        httpStatus: receipt.httpStatus, resourceId: created.resourceId, shortHost: 'naver.me',
      });
    } catch (error) {
      await journal.finish(key, 'outcome_unknown', { code: error instanceof BrandconnectError ? error.code : 'WRITE_FAILED' }).catch(() => {});
      await journal.reconcile(key, { result: 'ambiguous', independentRead: false, resourceIdPresent: false }).catch(() => {});
      fail('WRITE_OUTCOME_UNKNOWN', { operation: 'create-travel-link', writeSuppressed: true });
    }
    const found = await findTravelLink(session, state, created.resourceId, created.url);
    const result = found ? 'found' : 'ambiguous';
    await journal.reconcile(key, { result, independentRead: found !== undefined, resourceIdPresent: true });
    return { outcome: found ? 'created_verified' : 'created_unverified', writeSuppressed: true,
      resourceId: created.resourceId, url: created.url, readbackVerified: !!found, receipt: created.receipt };
  }

  async function createShoppingLink(session, state, input) {
    exactKeys(input, ['affiliateProductId']);
    const id = String(input.affiliateProductId ?? '');
    const detail = await detailShopping(session, state, input.affiliateProductId);
    const existingUrl = eligibleShopping(detail);
    const target = { spaceId: String(state.spaceId), affiliateProductId: id };
    const payload = { affiliateProductId: id };
    const key = journal.key('create-shopping-link', target, payload);
    const prior = await journal.read(key);
    if (prior) {
      const checked = await reconcilePrior(key, prior, (resourceId, url) => findShoppingLink(session, state, id, resourceId, url, Date.parse(prior.createdAt)));
      return { outcome: checked.result === 'found' ? 'already_created' : 'previous_attempt_unresolved',
        writeSuppressed: true, resourceId: checked.resourceId, url: checked.found?.shortenUrl ?? null };
    }
    if (existingUrl) return { outcome: 'existing', url: existingUrl, productEligible: true, receipt: detail.receipt };
    await journal.reserve(key, { operation: 'create-shopping-link', spaceId: String(state.spaceId), affiliateProductId: id });
    let created;
    try {
      const createUrl = new URL('/affiliate/command/affiliate-urls', API);
      createUrl.searchParams.set('affiliateProductId', id);
      const { data: response, receipt } = await readJson(session, state, createUrl.href, {
        operation: 'create-shopping-link', method: 'POST', body: {}, write: true,
      });
      const data = unwrappedData(response);
      if (!safeId(data.affiliateUrlId) || !shortNaverUrl(data.url)) fail('WRITE_OUTCOME_UNKNOWN', receipt);
      created = { resourceId: String(data.affiliateUrlId), url: data.url, receipt };
      await journal.finish(key, 'acknowledged_requires_readback', {
        httpStatus: receipt.httpStatus, resourceId: created.resourceId, shortHost: 'naver.me',
      });
    } catch (error) {
      await journal.finish(key, 'outcome_unknown', { code: error instanceof BrandconnectError ? error.code : 'WRITE_FAILED' }).catch(() => {});
      const found = await findShoppingLink(session, state, id, null, null);
      await journal.reconcile(key, { result: found ? 'found' : 'ambiguous', independentRead: found !== undefined, resourceIdPresent: false }).catch(() => {});
      if (found) return { outcome: 'created_verified_after_unclear_response', writeSuppressed: true,
        resourceId: String(found.affiliateUrlId), url: found.shortenUrl, readbackVerified: true };
      fail('WRITE_OUTCOME_UNKNOWN', { operation: 'create-shopping-link', writeSuppressed: true });
    }
    const found = await findShoppingLink(session, state, id, created.resourceId, created.url);
    const result = found ? 'found' : 'ambiguous';
    await journal.reconcile(key, { result, independentRead: found !== undefined, resourceIdPresent: true });
    return { outcome: found ? 'created_verified' : 'created_unverified', writeSuppressed: true,
      resourceId: created.resourceId, url: created.url, readbackVerified: !!found, receipt: created.receipt };
  }

  const reads = {
    shoppingSearch: async (session, state, input) => {
      exactKeys(input, ['query', 'limit']);
      const query = text(input.query);
      const limit = pageNumber(input.limit, { max: 100 });
      const url = new URL('/affiliate/query/affiliate-products/search-by-query', API);
      url.searchParams.set('query', query);
      url.searchParams.set('limit', String(limit));
      return readJson(session, state, url.href, { operation: 'shopping-search' });
    },
    shoppingStores: async (session, state, input) => {
      exactKeys(input, ['query', 'pageSize']);
      const query = text(input.query);
      const pageSize = pageNumber(input.pageSize ?? 20, { max: 100 });
      const url = new URL('/affiliate/query/affiliate-stores/search', API);
      url.searchParams.set('query', query);
      url.searchParams.set('pageSize', String(pageSize));
      return readJson(session, state, url.href, { operation: 'shopping-stores' });
    },
    shoppingFeatured: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      return readJson(session, state, '/affiliate/query/popup-stores', { operation: 'shopping-featured' });
    },
    travelSearch: async (session, state, input) => {
      exactKeys(input, ['query']);
      const url = new URL('/affiliate/query/connect/products', API);
      url.searchParams.set('serviceType', 'TRAVEL_PACKAGE');
      url.searchParams.set('query', text(input.query));
      return readJson(session, state, url.href, { operation: 'travel-search' });
    },
    travelRates: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      const url = new URL('/affiliate/query/connect-services/commission-rates', API);
      url.searchParams.set('type', 'TRAVEL_PACKAGE');
      return readJson(session, state, url.href, { operation: 'travel-rates' });
    },
    travelTabs: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      const url = new URL('/affiliate/query/connect/recommend-tabs', API);
      url.searchParams.set('serviceType', 'TRAVEL_PACKAGE');
      return readJson(session, state, url.href, { operation: 'travel-tabs' });
    },
    travelRecommend: async (session, state, input) => {
      exactKeys(input, ['section', 'tabId']);
      const sectionTabs = { SPECIAL_OFFER: ['여행핫딜'], REGION_BEST: ['ALL'], PRICE_DROP: ['ALL'] };
      if (!Object.hasOwn(sectionTabs, input.section) || !sectionTabs[input.section].includes(input.tabId)) fail('INPUT_INVALID');
      const url = new URL('/affiliate/query/connect/recommend-products', API);
      url.searchParams.set('serviceType', 'TRAVEL_PACKAGE');
      url.searchParams.set('section', input.section);
      url.searchParams.set('tabId', input.tabId);
      return readJson(session, state, url.href, { operation: 'travel-recommend' });
    },
    travelDetail: async (session, state, input) => {
      exactKeys(input, ['productUrl']);
      return detailTravel(session, state, input.productUrl);
    },
    travelLinks: async (session, state, input) => {
      exactKeys(input, ['minCreatedDate', 'maxCreatedDate', 'pageSize', 'page']);
      return travelLinksInternal(session, state, input);
    },
    shoppingDetail: async (session, state, input) => {
      exactKeys(input, ['affiliateProductId']);
      return detailShopping(session, state, input.affiliateProductId);
    },
    shoppingLinks: async (session, state, input) => {
      exactKeys(input, ['minAffiliateUrlCreatedDate', 'maxAffiliateUrlCreatedDate', 'pageSize', 'page', 'name', 'minCommissionRate', 'maxCommissionRate']);
      return shoppingLinksInternal(session, state, input);
    },
    // The creator space the session is bound to: profile and linked external channels (blog, Instagram, YouTube ...).
    // Contract from the site's own bundle (6049-*.js, 2026-09-30): GET {Query}/creator-space/{creatorSpaceId}.
    creatorSpace: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      return readJson(session, state, `/brand-connect/query/creator-space/${encodeURIComponent(String(state.spaceId))}`, { operation: 'creator-space' });
    },
    // 캠페인 제휴 (the "캠페인 찾기" list): cash reward per channel, provided products, recruitment counts and dates.
    campaignSearch: async (session, state, input) => {
      exactKeys(input ?? {}, ['page', 'pageSize']);
      const url = new URL('/brand-connect/query/campaigns/recruitment-search', API);
      url.searchParams.set('page', String(pageNumber(input?.page ?? 1, { max: 10000 })));
      url.searchParams.set('pageSize', String(pageNumber(input?.pageSize ?? 20, { max: 100 })));
      const { data, receipt } = await readJson(session, state, url.href, { operation: 'campaign-search' });
      if (!Array.isArray(data?.data) || typeof data?.paging?.total !== 'number') fail('CAMPAIGN_SEARCH_SCHEMA_INVALID', receipt);
      return { data, receipt };
    },
    campaignFavorites: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      return readJson(session, state, '/brand-connect/query/favorite/campaign', { operation: 'campaign-favorites' });
    },
    campaignHistory: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      return readJson(session, state, `/brand-connect/query/creator-space/${encodeURIComponent(String(state.spaceId))}/contents-campaign-history`, { operation: 'campaign-history' });
    },
    // 정산: registration state only (the record holds bank/business details, which are reduced to present/absent).
    settlementInfo: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      const { data, receipt } = await readJson(session, state, '/brand-connect/query/settlement-information', { operation: 'settlement-info' });
      if (!object(data)) fail('SETTLEMENT_INFO_SCHEMA_INVALID', receipt);
      const present = v => v !== null && v !== undefined;
      return { data: { bankAccountRegistered: present(data.bankAccount), businessInformationRegistered: present(data.businessInformation),
        customerRegistered: present(data.customer), existSettlement: data.existSettlement === true, existCampaignSettlement: data.existCampaignSettlement === true,
        payoutRequested: data.existPayoutRequestedConnectSettlement === true, payoutPending: data.existPayoutPendingConnectSettlement === true,
        kycRequired: data.showKyc === true }, receipt };
    },
    earningsRecent: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      return readJson(session, state, '/affiliate/query/connect-creator-settlements/recent-earnings', { operation: 'earnings-recent' });
    },
    earningReports: async (session, state, input) => {
      exactKeys(input, ['fromEarningMonth', 'toEarningMonth', 'page', 'pageSize']);
      for (const m of [input.fromEarningMonth, input.toEarningMonth]) if (typeof m !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) fail('INPUT_INVALID');
      const url = new URL('/affiliate/query/connect-creator-settlements/earning-reports', API);
      url.searchParams.set('fromEarningMonth', input.fromEarningMonth);
      url.searchParams.set('toEarningMonth', input.toEarningMonth);
      url.searchParams.set('page', String(pageNumber(input.page ?? 1, { max: 10000 })));
      url.searchParams.set('pageSize', String(pageNumber(input.pageSize ?? 20, { max: 100 })));
      return readJson(session, state, url.href, { operation: 'earning-reports' });
    },
    coPurchaseSettlementSummary: async (session, state, input) => {
      exactKeys(input ?? {}, []);
      return readJson(session, state, '/co-purchase/query/settlements/accumulated-summary', { operation: 'co-purchase-settlement-summary' });
    },
    creatorChannel: async (session, state, input) => {
      exactKeys(input, ['externalChannelId']);
      const id = String(input.externalChannelId ?? '');
      if (!safeId(id)) fail('INPUT_INVALID');
      return readJson(session, state, `/brand-connect/query/creator-space/${encodeURIComponent(String(state.spaceId))}/external-channels/${encodeURIComponent(id)}`, { operation: 'creator-channel' });
    },
  };

  async function runRead(name, input = {}) {
    const operation = reads[name];
    if (!operation) fail('OPERATION_NOT_ALLOWED');
    return withSession(async (session, state, verified) => {
      try {
        const result = await operation(session, state, input);
        return { authenticated: true, ownerVerified: true, browserUsed: false,
          operation: name, ...result, verification: { identityMatched: true, creator: verified.creator, spaceId: verified.spaceId } };
      } finally { save(state, session); }
    });
  }

  return {
    status: () => { const credential = store.status(STATE); return { service: 'naver-brandconnect', sessionStored: credential.available,
      provider: credential.provider, persistent: credential.persistent,
      currentAuthentication: 'not_checked', loginRenewal: 'naver_session_import', browserUsedForHttp: false };
    },
    importSession: input => lock(async () => {
      exactKeys(input, ['cookies', 'expectedLoginId', 'spaceId', 'userAgent', 'referer']);
      const expectedLoginId = text(input.expectedLoginId, { max: 100 });
      const { session, selectedSpace, referer, userAgent } = newSession(input);
      const state = { version: 1, expectedLoginId, spaceId: selectedSpace, referer, userAgent, verified: false };
      const verification = await owner(session, state);
      state.verified = true;
      save(state, session);
      return { ...verification, stored: true, provider: store.status(STATE).provider,
        persistent: store.status(STATE).persistent, operation: 'import-session' };
    }),
    // Brand Connect authenticates with the same .naver.com NID_AUT/NID_SES cookies as the rest of Naver, so a
    // session renewed by the Naver HTTP login can replace an expired one here. The stored account binding
    // (login id, space, referer, user agent) is kept and must verify again before the new session is saved.
    renewSession: input => lock(async () => {
      exactKeys(input, ['cookies', 'userAgent']);
      const raw = store.read(STATE);
      if (!raw) fail('SESSION_MISSING');
      let prior;
      try { prior = JSON.parse(raw); } catch { fail('AUTH_STATE_INVALID'); }
      if (!object(prior) || prior.version !== 1 || typeof prior.expectedLoginId !== 'string' || !prior.expectedLoginId
        || !safeId(prior.spaceId) || typeof prior.referer !== 'string' || typeof prior.userAgent !== 'string') fail('AUTH_STATE_INVALID');
      const userAgent = Object.hasOwn(input, 'userAgent')
        ? validatedObservedUserAgent(input.userAgent)
        : validatedObservedUserAgent(prior.userAgent);
      const { session, selectedSpace, referer, userAgent: sessionUserAgent } = newSession({
        cookies: input.cookies, spaceId: prior.spaceId, referer: prior.referer, userAgent });
      const state = { version: 1, expectedLoginId: prior.expectedLoginId, spaceId: selectedSpace, referer,
        userAgent: sessionUserAgent, verified: false };
      const verification = await owner(session, state);
      state.verified = true;
      save(state, session);
      return { ...verification, renewal: 'naver_session_import', stored: true, operation: 'renew-session' };
    }),
    health: () => withSession(async (_session, _state, verified) => verified),
    shoppingSearch: input => runRead('shoppingSearch', input),
    shoppingStores: input => runRead('shoppingStores', input),
    shoppingFeatured: (input = {}) => runRead('shoppingFeatured', input),
    travelSearch: input => runRead('travelSearch', input),
    travelRates: (input = {}) => runRead('travelRates', input),
    travelTabs: (input = {}) => runRead('travelTabs', input),
    travelRecommend: input => runRead('travelRecommend', input),
    travelDetail: input => runRead('travelDetail', input),
    travelLinks: input => runRead('travelLinks', input),
    shoppingDetail: input => runRead('shoppingDetail', input),
    shoppingLinks: input => runRead('shoppingLinks', input),
    creatorSpace: (input = {}) => runRead('creatorSpace', input),
    creatorChannel: input => runRead('creatorChannel', input),
    campaignSearch: (input = {}) => runRead('campaignSearch', input),
    campaignFavorites: (input = {}) => runRead('campaignFavorites', input),
    campaignHistory: (input = {}) => runRead('campaignHistory', input),
    settlementInfo: (input = {}) => runRead('settlementInfo', input),
    earningsRecent: (input = {}) => runRead('earningsRecent', input),
    earningReports: input => runRead('earningReports', input),
    coPurchaseSettlementSummary: (input = {}) => runRead('coPurchaseSettlementSummary', input),
    travelCreateLink: input => withSession(async (session, state) => createTravelLink(session, state, input)),
    shoppingCreateLink: input => withSession(async (session, state) => createShoppingLink(session, state, input)),
  };
}
