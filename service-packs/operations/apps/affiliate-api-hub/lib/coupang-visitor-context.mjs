import { createHash } from 'node:crypto';
import { isStrongPublicChallenge } from './cps-public-reader.mjs';

const ORIGIN = 'https://www.coupang.com';
const BOOTSTRAP = `${ORIGIN}/n-api/web-adapter/proxy`;
const COOKIE_NAMES = new Set(['PCID', 'x-coupang-target-market', 'x-coupang-accept-language']);
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // Local memory lifetime, not the server's session TTL.
const contexts = new WeakMap();

export class CoupangVisitorError extends Error {
  constructor(code, receipt = null) { super(code); this.code = code; this.receipt = receipt; }
}
const fail = (code, receipt) => { throw new CoupangVisitorError(code, receipt); };

// Opaque handle: values cannot enter JSON receipts or an account credential store.
export function createCoupangVisitorContext({ fetchImpl = globalThis.fetch, now = Date.now,
  maxAgeMs = DEFAULT_MAX_AGE_MS, allowRebootstrap = true } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 1200000
    || typeof allowRebootstrap !== 'boolean') fail('COUPANG_VISITOR_INPUT');
  const context = Object.freeze({ type: 'coupang_public_visitor' });
  contexts.set(context, { fetchImpl, now, maxAgeMs, allowRebootstrap, cookies: [], issuedAt: null, pending: null,
    invalidated: false });
  return context;
}

function readScope(target, operation) {
  let url;
  try { url = new URL(target); } catch { fail('COUPANG_VISITOR_OPERATION_SCOPE'); }
  const keys = [...url.searchParams.keys()];
  const exactly = expected => keys.length === expected.length && expected.every(key => keys.includes(key));
  const validId = key => /^[1-9]\d{0,19}$/.test(url.searchParams.get(key) ?? '');
  const sellers = operation === 'other_sellers' && url.pathname === '/next-api/products/other-seller-info'
    && exactly(['productId', 'selectedId', 'itemId']) && ['productId', 'selectedId', 'itemId'].every(validId);
  const goldboxRequired = ['widgetId', 'isAsync', 'trafficType', 'landingId', 'target', 'productOffset',
    'sourceType', 'isMLP', 'nextWidgetPageKey', 'categoryId', 'subSourceType'];
  const goldboxOptional = ['gbpSessionKey', 'pageVisitId', 'gbpBottomVids'];
  const goldboxShape = keys.length >= goldboxRequired.length && keys.length <= goldboxRequired.length + goldboxOptional.length
    && new Set(keys).size === keys.length
    && goldboxRequired.every(key => keys.includes(key))
    && keys.every(key => goldboxRequired.includes(key) || goldboxOptional.includes(key));
  const pageKey = url.searchParams.get('nextWidgetPageKey') ?? '';
  const cursorValue = (value, maxLength = 128) => typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && /^[A-Za-z0-9._~+\/=\-]+$/.test(value);
  const bottomVids = url.searchParams.get('gbpBottomVids');
  // The server-issued continuation URL carries an opaque URL-safe marker; keep it transient and bounded.
  // This accumulated marker grows with subsequent pages (225 characters observed on page 3).
  // Other cursor/session fields retain their independent 128-character limit.
  const validBottomVids = bottomVids === null || bottomVids === '' || cursorValue(bottomVids, 4096);
  const validOptionalGoldboxValue = key => !url.searchParams.has(key) || (key === 'gbpBottomVids'
    ? validBottomVids : cursorValue(url.searchParams.get(key)));
  const productOffset = url.searchParams.get('productOffset') ?? '';
  const goldbox = operation === 'goldbox_widget_page' && url.pathname === '/vm/mlp/v1/newweb/mlp-widget-landing'
    && goldboxShape
    && url.searchParams.get('widgetId') === '43145' && url.searchParams.get('isAsync') === 'Y'
    && url.searchParams.get('trafficType') === 'organic' && url.searchParams.get('landingId') === '3712'
    && url.searchParams.get('target') === 'MLP_GOLDBOX' && /^(?:0|[1-9]\d{0,5})$/.test(productOffset)
    && Number(productOffset) <= 100000 && url.searchParams.get('sourceType') === 'gm_crm_goldbox'
    && url.searchParams.get('isMLP') === 'Y' && cursorValue(pageKey) && url.searchParams.get('categoryId') === '0'
    && url.searchParams.get('subSourceType') === 'gm_crm_gwsrtcut'
    && goldboxOptional.every(validOptionalGoldboxValue);
  const offers = operation === 'offer_list' && url.pathname === '/next-api/offer-list'
    && exactly(['productId', 'itemId', 'selectedVendorItemId'])
    && ['productId', 'itemId', 'selectedVendorItemId'].every(validId);
  const reviews = operation === 'review_page' && url.pathname === '/next-api/review'
    && exactly(['productId', 'page', 'size', 'sortBy', 'ratingSummary', 'ratings', 'market'])
    && validId('productId') && /^[1-9]\d{0,4}$/.test(url.searchParams.get('page') ?? '')
    && Number(url.searchParams.get('page')) <= 10000 && url.searchParams.get('size') === '10'
    && ['DATE_DESC', 'ORDER_SCORE_ASC'].includes(url.searchParams.get('sortBy'))
    && url.searchParams.get('ratingSummary') === 'true' && url.searchParams.get('ratings') === ''
    && url.searchParams.get('market') === '';
  if (url.origin !== ORIGIN || url.username || url.password || url.port || url.hash
    || !sellers && !offers && !goldbox && !reviews)
    fail('COUPANG_VISITOR_OPERATION_SCOPE');
  return url;
}

function applyCookies(state, lines, issuer, now) {
  if (!Array.isArray(lines) || lines.length > 100) fail('COUPANG_VISITOR_COOKIE_HEADERS');
  const url = new URL(issuer);
  if (url.origin !== ORIGIN) fail('COUPANG_VISITOR_COOKIE_SCOPE');
  let changed = false;
  for (const line of lines) {
    if (typeof line !== 'string' || line.length > 8192 || /[\r\n\0]/.test(line)) continue;
    const [first, ...attributes] = line.split(';').map(value => value.trim());
    const eq = first.indexOf('=');
    if (eq < 1 || !COOKIE_NAMES.has(first.slice(0, eq))) continue;
    const cookie = { name: first.slice(0, eq), value: first.slice(eq + 1), domain: url.hostname,
      hostOnly: true, path: url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/', secure: false, expires: null };
    if (/[^\x21-\x7e]|[",;\\]/.test(cookie.value)) continue;
    let maxAge;
    for (const attribute of attributes) {
      const i = attribute.indexOf('=');
      const key = (i < 0 ? attribute : attribute.slice(0, i)).toLowerCase();
      const value = i < 0 ? '' : attribute.slice(i + 1);
      if (key === 'domain') { cookie.domain = value.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; }
      else if (key === 'path' && value.startsWith('/')) cookie.path = value;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value);
      else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    }
    if (!['coupang.com', 'www.coupang.com'].includes(cookie.domain)
      || cookie.path.length > 2048 || /[\r\n\0]/.test(cookie.path)
      || maxAge !== undefined && !Number.isSafeInteger(maxAge)) continue;
    if (maxAge !== undefined) cookie.expires = now + maxAge * 1000;
    if (cookie.expires !== null && !Number.isFinite(cookie.expires)) continue;
    const same = row => row.name === cookie.name && row.domain === cookie.domain && row.path === cookie.path;
    state.cookies = state.cookies.filter(row => !same(row));
    if (cookie.value && !(cookie.expires !== null && cookie.expires <= now)) state.cookies.push(cookie);
    changed = true;
  }
  return changed;
}

function matches(cookie, url, now) {
  return (cookie.hostOnly ? cookie.domain === url.hostname : url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`))
    && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))
    && (!cookie.secure || url.protocol === 'https:') && (cookie.expires === null || cookie.expires > now);
}

function visitorContextCurrent(state, url, now) {
  return !state.invalidated && state.issuedAt !== null && now >= state.issuedAt
    && now - state.issuedAt < state.maxAgeMs
    && state.cookies.some(cookie => cookie.name === 'PCID' && matches(cookie, url, now));
}

function observedVisitorCookieNames(lines) {
  if (!Array.isArray(lines) || lines.length > 100) return [];
  return [...new Set(lines.flatMap(line => {
    if (typeof line !== 'string' || line.length > 8192 || /[\r\n\0]/.test(line)) return [];
    const first = line.split(';', 1)[0].trim(), separator = first.indexOf('=');
    if (separator < 1) return [];
    const name = first.slice(0, separator);
    return COOKIE_NAMES.has(name) ? [name] : [];
  }))].sort();
}

function sameCookieState(left, right) {
  if (left.length !== right.length) return false;
  const fields = ['name', 'value', 'domain', 'hostOnly', 'path', 'secure', 'expires'];
  const sort = rows => [...rows].sort((a, b) => `${a.name}\0${a.domain}\0${a.path}`.localeCompare(`${b.name}\0${b.domain}\0${b.path}`));
  const a = sort(left), b = sort(right);
  return a.every((cookie, index) => fields.every(field => cookie[field] === b[index][field]));
}

async function bootstrap(state) {
  const receipt = { operation: 'public_visitor_bootstrap', method: 'GET', origin: ORIGIN,
    path: '/n-api/web-adapter/proxy', status: null, execution: 'pure_http', browserUsed: false,
    transport: state.fetchImpl === globalThis.fetch ? 'native_fetch' : 'injected',
    ownerCredentialUsed: false, valuesPersisted: false, redirectsFollowed: false, retries: 0,
    challengeConfirmed: false };
  let response;
  try { response = await state.fetchImpl(BOOTSTRAP, { method: 'GET', headers: { accept: 'text/html' },
    credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
  catch { fail('COUPANG_VISITOR_TRANSPORT', receipt); }
  if (!response?.headers?.get || !Number.isInteger(response.status)) fail('COUPANG_VISITOR_RESPONSE_SCHEMA', receipt);
  receipt.status = response.status;
  if (response.redirected || response.url && response.url !== BOOTSTRAP || response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    fail('COUPANG_VISITOR_REDIRECT', receipt);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    fail(response.status === 429 ? 'COUPANG_VISITOR_RATE_LIMITED' : 'COUPANG_VISITOR_HTTP_REJECTED', receipt);
  }
  receipt.contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (receipt.contentType !== 'text/html' || !response.body) {
    await response.body?.cancel().catch(() => {});
    fail('COUPANG_VISITOR_CONTENT_TYPE', receipt);
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) fail('COUPANG_VISITOR_RESPONSE_SIZE', receipt);
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    if (error instanceof CoupangVisitorError) throw error;
    fail('COUPANG_VISITOR_BODY_FAILED', receipt);
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  receipt.bytes = bytes;
  receipt.responseSha256 = createHash('sha256').update(body).digest('hex');
  // Check the observed static bridge; never execute its localStorage code.
  const html = body.toString('utf8');
  const challengeHeaders = Object.fromEntries(['cf-mitigated', 'x-captcha-required', 'x-sucuri-block']
    .map(key => [key, response.headers.get(key)]));
  receipt.challengeConfirmed = isStrongPublicChallenge(challengeHeaders, html);
  if (receipt.challengeConfirmed) fail('COUPANG_VISITOR_CHALLENGE', receipt);
  if (!html.includes('web-adapter-proxy') || !html.includes('getLocalStorage')
    || /<title\b[^>]*>\s*Access Denied/i.test(html)) fail('COUPANG_VISITOR_BOOTSTRAP_SCHEMA', receipt);
  if (typeof response.headers.getSetCookie !== 'function') fail('COUPANG_VISITOR_COOKIE_HEADERS', receipt);
  const now = state.now();
  state.cookies = [];
  applyCookies(state, response.headers.getSetCookie(), BOOTSTRAP, now);
  state.issuedAt = now;
  receipt.cookieNames = [...new Set(state.cookies.map(cookie => cookie.name))].sort();
  receipt.botCookiesAccepted = false;
  receipt.accountCookiesAccepted = false;
  return receipt;
}

// Revisit the known public bridge with the same visitor identity for bounded diagnostics.
// This is not an authentication refresh API and never establishes a replacement identity.
export async function revisitCoupangVisitorBootstrap({ context, fetchImpl = globalThis.fetch } = {}) {
  const state = contexts.get(context);
  if (!state || state.fetchImpl !== fetchImpl) fail('COUPANG_VISITOR_CONTEXT');
  const url = new URL(BOOTSTRAP), now = state.now();
  if (!visitorContextCurrent(state, url, now)) fail('COUPANG_VISITOR_CONTEXT_EXPIRED');
  const matching = state.cookies.filter(cookie => COOKIE_NAMES.has(cookie.name) && matches(cookie, url, now));
  const names = matching.map(cookie => cookie.name);
  if (new Set(names).size !== names.length || names.filter(name => name === 'PCID').length !== 1)
    fail('COUPANG_VISITOR_COOKIE_AMBIGUOUS');
  const currentPcid = matching.find(cookie => cookie.name === 'PCID');
  const receipt = { operation: 'public_visitor_bootstrap_revisit', method: 'GET', origin: ORIGIN,
    path: '/n-api/web-adapter/proxy', status: null, contentType: null, bytes: null,
    execution: 'pure_http', browserUsed: false,
    transport: fetchImpl === globalThis.fetch ? 'native_fetch' : 'injected',
    ownerCredentialUsed: false, valuesPersisted: false, redirectsFollowed: false, retries: 0,
    visitorCookiesSent: true, visitorCookieNames: [...names].sort(), responseCookieNames: [],
    cookieRotationApplied: false, identityPreserved: null, challengeConfirmed: false };
  let response;
  try { response = await fetchImpl(BOOTSTRAP, { method: 'GET', headers: {
    accept: 'text/html', cookie: matching.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
  }, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
  catch { fail('COUPANG_VISITOR_TRANSPORT', receipt); }
  if (!response?.headers?.get || !Number.isInteger(response.status)) fail('COUPANG_VISITOR_RESPONSE_SCHEMA', receipt);
  receipt.status = response.status;
  if (response.redirected || response.url && response.url !== BOOTSTRAP || response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    fail('COUPANG_VISITOR_REDIRECT', receipt);
  }
  let responseCookies;
  try {
    if (typeof response.headers.getSetCookie !== 'function') fail('COUPANG_VISITOR_COOKIE_HEADERS', receipt);
    responseCookies = response.headers.getSetCookie();
    receipt.responseCookieNames = observedVisitorCookieNames(responseCookies);
  } catch (error) {
    if (error instanceof CoupangVisitorError) throw error;
    fail('COUPANG_VISITOR_COOKIE_HEADERS', receipt);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    fail(response.status === 429 ? 'COUPANG_VISITOR_RATE_LIMITED' : 'COUPANG_VISITOR_HTTP_REJECTED', receipt);
  }
  receipt.contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'text/html'
    ? 'text/html' : null;
  if (receipt.contentType !== 'text/html' || !response.body) {
    await response.body?.cancel().catch(() => {});
    fail('COUPANG_VISITOR_CONTENT_TYPE', receipt);
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) fail('COUPANG_VISITOR_RESPONSE_SIZE', receipt);
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    if (error instanceof CoupangVisitorError) throw error;
    fail('COUPANG_VISITOR_BODY_FAILED', receipt);
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  receipt.bytes = bytes;
  const html = Buffer.concat(chunks).toString('utf8');
  const challengeHeaders = Object.fromEntries(['cf-mitigated', 'x-captcha-required', 'x-sucuri-block']
    .map(key => [key, response.headers.get(key)]));
  receipt.challengeConfirmed = isStrongPublicChallenge(challengeHeaders, html);
  if (receipt.challengeConfirmed) fail('COUPANG_VISITOR_CHALLENGE', receipt);
  if (!html.includes('web-adapter-proxy') || !html.includes('getLocalStorage')
    || /<title\b[^>]*>\s*Access Denied/i.test(html)) fail('COUPANG_VISITOR_BOOTSTRAP_SCHEMA', receipt);
  if (!Array.isArray(responseCookies) || responseCookies.length > 100)
    fail('COUPANG_VISITOR_COOKIE_HEADERS', receipt);

  const updatedAt = state.now();
  if (!visitorContextCurrent(state, url, updatedAt)) fail('COUPANG_VISITOR_CONTEXT_EXPIRED', receipt);
  const candidate = { cookies: state.cookies.map(cookie => ({ ...cookie })) };
  try { applyCookies(candidate, responseCookies, BOOTSTRAP, updatedAt); }
  catch (error) {
    if (error instanceof CoupangVisitorError) fail(error.code, receipt);
    throw error;
  }
  const candidatePcids = candidate.cookies.filter(cookie => cookie.name === 'PCID' && matches(cookie, url, updatedAt));
  if (candidatePcids.length !== 1 || candidatePcids[0].value !== currentPcid.value) {
    state.invalidated = true;
    state.cookies = [];
    state.issuedAt = null;
    state.pending = null;
    receipt.identityPreserved = false;
    fail('COUPANG_VISITOR_IDENTITY_CHANGED', receipt);
  }
  receipt.cookieRotationApplied = !sameCookieState(state.cookies, candidate.cookies);
  state.cookies = candidate.cookies;
  receipt.identityPreserved = true;
  return receipt;
}

export async function prepareCoupangVisitorRead({ context, target, operation, fetchImpl = globalThis.fetch }) {
  const url = readScope(target, operation), state = contexts.get(context);
  if (!state || state.fetchImpl !== fetchImpl) fail('COUPANG_VISITOR_CONTEXT');
  if (state.invalidated) fail('COUPANG_VISITOR_CONTEXT_EXPIRED');
  let bootstrapReceipt = null;
  const valid = () => {
    const current = state.now();
    return state.issuedAt !== null && current >= state.issuedAt && current - state.issuedAt < state.maxAgeMs
      && state.cookies.some(cookie => cookie.name === 'PCID' && matches(cookie, url, current));
  };
  if (!valid()) {
    if (state.issuedAt !== null && !state.allowRebootstrap) fail('COUPANG_VISITOR_CONTEXT_EXPIRED');
    if (!state.pending) state.pending = bootstrap(state);
    try { bootstrapReceipt = await state.pending; } finally { state.pending = null; }
  }
  if (!valid()) fail('COUPANG_VISITOR_COOKIE_MISSING', bootstrapReceipt);
  const cookies = state.cookies.filter(cookie => matches(cookie, url, state.now()));
  if (new Set(cookies.map(cookie => cookie.name)).size !== cookies.length) fail('COUPANG_VISITOR_COOKIE_AMBIGUOUS');
  return { cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    cookieNames: cookies.map(cookie => cookie.name).sort(), bootstrapReceipt };
}

export function rotateCoupangVisitorCookies(context, setCookies, target, operation) {
  readScope(target, operation);
  const state = contexts.get(context);
  if (!state) fail('COUPANG_VISITOR_CONTEXT');
  return applyCookies(state, setCookies, target, state.now());
}
