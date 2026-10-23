import { readCredential, writeCredential } from './secure-credential-store.mjs';
import { FLOW_CREDENTIAL } from './session-name.mjs';
import { validateFlowSessionBundle } from './session-bundle.mjs';
import { parseObservedSetCookie } from './http-transport.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const ACCOUNTS_ORIGIN = 'https://accounts.google.com';
const ROTATE_PATH = '/RotateCookiesPage';
const ROTATED_COOKIE_NAMES = Object.freeze(['SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC']);
const ROTATED_COOKIE_SET = new Set(ROTATED_COOKIE_NAMES);
const SAFE_CREDENTIAL_ERRORS = new Set([
  'CREDENTIAL_STORE_TIMEOUT', 'CREDENTIAL_STORE_UNREADABLE', 'CREDENTIAL_STORE_FAILED',
  'CREDENTIAL_STORE_PLATFORM_UNSUPPORTED', 'CREDENTIAL_STORE_UNVERIFIED',
  'CREDENTIAL_NAME_INVALID', 'CREDENTIAL_TEST_CONTEXT_REQUIRED',
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function readProtectedBundle(readCredentialImpl, stage) {
  try { return readCredentialImpl(FLOW_CREDENTIAL); } catch (cause) {
    const credentialStoreCode = SAFE_CREDENTIAL_ERRORS.has(cause?.code) ? cause.code : null;
    const error = new Error(stage === 'initial'
      ? 'Protected Flow session could not be read.' : 'Protected Flow session could not be reread.');
    error.code = credentialStoreCode
      ? `FLOW_SESSION_ROTATION_${credentialStoreCode}` : 'FLOW_SESSION_ROTATION_SESSION_UNAVAILABLE';
    if (credentialStoreCode) error.credentialStoreCode = credentialStoreCode;
    error.operation = stage === 'initial' ? 'read' : 'reread';
    if (Number.isInteger(cause?.timeoutMs) && cause.timeoutMs >= 1_000 && cause.timeoutMs <= 300_000) {
      error.timeoutMs = cause.timeoutMs;
    }
    throw error;
  }
}

function parseBundle(raw, now) {
  if (typeof raw !== 'string' || raw.length === 0) {
    fail('FLOW_SESSION_ROTATION_SESSION_UNAVAILABLE', 'No protected Flow session is stored.');
  }
  let bundle;
  try { bundle = JSON.parse(raw); } catch {
    fail('FLOW_SESSION_ROTATION_SESSION_INVALID', 'Protected Flow session is invalid.');
  }
  if (bundle?.version !== 1 || bundle?.origin !== FLOW_ORIGIN || !Array.isArray(bundle?.cookies)) {
    fail('FLOW_SESSION_ROTATION_SESSION_SCOPE', 'Cookie rotation requires a scoped Flow cookie bundle.');
  }
  if (bundle.reauthRequired === true) {
    fail('FLOW_SESSION_ROTATION_REAUTH_REQUIRED', 'Protected Flow session requires first-party bootstrap.');
  }
  let validated;
  try { validated = validatedActiveView(bundle, now); } catch {
    fail('FLOW_SESSION_ROTATION_SESSION_INVALID', 'Protected Flow session is invalid.');
  }
  return { raw: bundle, validated };
}

function isExpired(cookie, now) {
  const rawExpires = cookie?.expires ?? cookie?.expirationDate;
  if (rawExpires === undefined || rawExpires === null || rawExpires === -1) return false;
  const expires = Number(rawExpires);
  return Number.isFinite(expires) && expires >= 0 && expires <= now / 1000;
}

function validatedActiveView(bundle, now) {
  const nowSeconds = now / 1000;
  for (const cookie of bundle.cookies) {
    if (Object.hasOwn(cookie || {}, 'expires') && cookie.expires !== null
      && Object.hasOwn(cookie || {}, 'expirationDate') && cookie.expirationDate !== null
      && cookie.expires !== cookie.expirationDate) {
      throw new Error('FLOW_COOKIE_INVALID');
    }
  }
  const structurallyChecked = {
    ...bundle,
    cookies: bundle.cookies.map(cookie => {
      if (!isExpired(cookie, now)) return cookie;
      const futureExpiry = nowSeconds + 3_600;
      return {
        ...cookie,
        ...(Object.hasOwn(cookie, 'expires') ? { expires: futureExpiry } : {}),
        ...(Object.hasOwn(cookie, 'expirationDate') ? { expirationDate: futureExpiry } : {}),
      };
    }),
  };
  // Validate every cookie's syntax and scope first, using a transient future
  // expiry only for already-expired entries. Then validate the live-cookie view.
  validateFlowSessionBundle(structurallyChecked, { now });
  const activeCookies = bundle.cookies.filter(cookie => !isExpired(cookie, now));
  return validateFlowSessionBundle({ ...bundle, cookies: activeCookies }, { now });
}

function requestCookieHeader(bundle, now) {
  const requestPath = ROTATE_PATH;
  const applicable = bundle.cookies.filter((cookie) => {
    const domain = typeof cookie?.domain === 'string' ? cookie.domain.toLowerCase().replace(/^\./, '') : '';
    if (domain !== 'google.com' || cookie.hostOnly !== false
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) return false;
    const pathMatches = requestPath === cookie.path
      || (requestPath.startsWith(cookie.path)
        && (cookie.path.endsWith('/') || requestPath[cookie.path.length] === '/'));
    if (!pathMatches) return false;
    const expires = cookie.expires ?? cookie.expirationDate;
    if (expires === undefined || expires === null || expires === -1) return cookie.session === true || expires === -1;
    return Number.isFinite(Number(expires)) && Number(expires) > now / 1000;
  });
  if (applicable.length === 0) {
    fail('FLOW_SESSION_ROTATION_COOKIE_SCOPE', 'Protected Flow session has no shared Google cookies for the observed rotation endpoint.');
  }
  return applicable.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function createObservedUrl() {
  const url = new URL(ROTATE_PATH, ACCOUNTS_ORIGIN);
  url.searchParams.set('og_pid', '749');
  url.searchParams.set('rot', '3');
  url.searchParams.set('origin', FLOW_ORIGIN);
  url.searchParams.set('exp_id', '0');
  return url;
}

function assertResponseUrl(responseUrl, expectedUrl) {
  if (!responseUrl) return;
  let actual;
  try { actual = new URL(responseUrl); } catch {
    fail('FLOW_SESSION_ROTATION_RESPONSE_SCOPE', 'Cookie rotation response URL was outside the observed endpoint.');
  }
  if (actual.href !== expectedUrl.href) {
    fail('FLOW_SESSION_ROTATION_RESPONSE_SCOPE', 'Cookie rotation response URL was outside the observed endpoint.');
  }
}

function rawCookieName(line) {
  if (typeof line !== 'string') return '';
  const equal = line.indexOf('=');
  return equal < 1 ? '' : line.slice(0, equal).trim();
}

function parseRotatedCookies(headers, endpoint, receivedAt) {
  if (typeof headers?.getSetCookie !== 'function') {
    fail('FLOW_SESSION_ROTATION_HEADERS_UNAVAILABLE', 'Cookie rotation response did not expose individual Set-Cookie headers.');
  }
  let lines;
  try { lines = headers.getSetCookie(); } catch {
    fail('FLOW_SESSION_ROTATION_HEADERS_INVALID', 'Cookie rotation response headers were invalid.');
  }
  if (!Array.isArray(lines)) {
    fail('FLOW_SESSION_ROTATION_HEADERS_INVALID', 'Cookie rotation response headers were invalid.');
  }
  const relevant = lines.filter(line => ROTATED_COOKIE_SET.has(rawCookieName(line)));
  const updates = new Map();
  for (const line of relevant) {
    const update = parseObservedSetCookie(line, endpoint, receivedAt);
    const expectedSecure = update?.name !== 'SIDCC';
    if (!update || update.deleted || update.domain !== 'google.com' || update.path !== '/'
      || update.cookie.hostOnly !== false || update.cookie.secure !== expectedSecure
      || !Number.isFinite(update.cookie.expires) || update.cookie.expires <= receivedAt / 1000) {
      fail('FLOW_SESSION_ROTATION_COOKIE_INVALID', 'Cookie rotation response contained an invalid scoped cookie.');
    }
    if (updates.has(update.name)) {
      fail('FLOW_SESSION_ROTATION_COOKIE_DUPLICATE', 'Cookie rotation response contained duplicate target cookies.');
    }
    updates.set(update.name, update.cookie);
  }
  if (updates.size !== ROTATED_COOKIE_NAMES.length
    || ROTATED_COOKIE_NAMES.some(name => !updates.has(name))) {
    fail('FLOW_SESSION_ROTATION_COOKIE_SET_INCOMPLETE', 'Cookie rotation response did not include the complete observed cookie set.');
  }
  return updates;
}

async function cancelBody(response) {
  try { await response?.body?.cancel(); } catch { /* Response body is intentionally discarded. */ }
}

function findRotatedCookieIndex(cookies, name) {
  const matches = [];
  for (let index = 0; index < cookies.length; index += 1) {
    const cookie = cookies[index];
    const rawDomain = typeof cookie?.domain === 'string' ? cookie.domain.toLowerCase() : '';
    const domain = rawDomain.replace(/^\./, '');
    const hostOnly = Object.hasOwn(cookie || {}, 'hostOnly') ? cookie.hostOnly : !rawDomain.startsWith('.');
    if (cookie?.name === name && domain === 'google.com' && hostOnly === false && cookie.path === '/') {
      matches.push(index);
    }
  }
  if (matches.length !== 1) {
    fail('FLOW_SESSION_ROTATION_STORE_CONFLICT', 'Protected Flow cookie scopes changed during rotation; nothing was stored.');
  }
  return matches[0];
}

/**
 * Performs only the observed accounts.google.com RotateCookiesPage GET and merges
 * its three observed shared-cookie rotations into the freshest protected bundle.
 * This is explicit normal cookie rotation; it does not prove recovery of an
 * expired Flow session.
 */
export async function renewFlowGoogleCookies({
  fetchImpl = globalThis.fetch,
  readCredentialImpl = readCredential,
  writeCredentialImpl = writeCredential,
  clock = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof readCredentialImpl !== 'function'
    || typeof writeCredentialImpl !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Cookie rotation dependencies are invalid.');
  }
  const loadedAt = clock();
  if (!Number.isFinite(loadedAt)) throw new TypeError('Cookie rotation clock is invalid.');
  const raw = readProtectedBundle(readCredentialImpl, 'initial');
  const loaded = parseBundle(raw, loadedAt);
  const bundle = loaded.raw;
  const cookie = requestCookieHeader(loaded.validated, loadedAt);
  const endpoint = createObservedUrl();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { cookie, accept: 'text/html' },
    });
  } catch {
    fail('FLOW_SESSION_ROTATION_TRANSPORT', 'Observed Google cookie rotation request failed.');
  }

  let updates;
  try {
    assertResponseUrl(response?.url, endpoint);
    if (response?.status >= 300 && response.status < 400) {
      fail('FLOW_SESSION_ROTATION_REDIRECT', 'Observed Google cookie rotation endpoint redirected; redirect following is disabled.');
    }
    if (response?.status !== 200) {
      fail('FLOW_SESSION_ROTATION_HTTP_ERROR', `Observed Google cookie rotation endpoint returned HTTP ${Number.isInteger(response?.status) ? response.status : 0}.`);
    }
    const mime = response.headers?.get?.('content-type') || '';
    if (!/^text\/html(?:\s*;|$)/i.test(mime)) {
      fail('FLOW_SESSION_ROTATION_MIME', 'Observed Google cookie rotation response was not HTML.');
    }
    const receivedAt = clock();
    if (!Number.isFinite(receivedAt)) throw new TypeError('Cookie rotation clock is invalid.');
    updates = parseRotatedCookies(response.headers, endpoint, receivedAt);
  } finally {
    await cancelBody(response);
  }

  const latestRaw = readProtectedBundle(readCredentialImpl, 'reread');
  const committedAt = clock();
  if (!Number.isFinite(committedAt)) throw new TypeError('Cookie rotation clock is invalid.');
  const latestParsed = parseBundle(latestRaw, committedAt);
  const latest = latestParsed.raw;
  if (latest.projectId.toLowerCase() !== bundle.projectId.toLowerCase()) {
    fail('FLOW_SESSION_ROTATION_STORE_CONFLICT', 'Protected Flow project changed during rotation; nothing was stored.');
  }
  const merged = latest.cookies.map(cookie => ({ ...cookie }));
  for (const name of ROTATED_COOKIE_NAMES) {
    const index = findRotatedCookieIndex(latest.cookies, name);
    merged[index] = updates.get(name);
  }
  const candidate = { ...latest, cookies: merged, cookieCount: merged.length };
  try { validatedActiveView(candidate, committedAt); } catch {
    fail('FLOW_SESSION_ROTATION_COOKIE_INVALID', 'Rotated cookies did not validate for the protected Flow project.');
  }
  const storedBundle = {
    ...latest,
    cookies: merged,
    cookieCount: merged.length,
    capturedAt: new Date(committedAt).toISOString(),
  };
  let stored;
  try { stored = writeCredentialImpl(FLOW_CREDENTIAL, JSON.stringify(storedBundle)); } catch {
    fail('FLOW_SESSION_ROTATION_STORE_FAILED', 'Rotated Google cookies could not be saved to the protected store.');
  }
  if (stored?.stored !== true) {
    fail('FLOW_SESSION_ROTATION_STORE_UNVERIFIED', 'Protected credential store did not confirm the cookie update.');
  }
  return {
    operation: 'normal_observed_cookie_rotation',
    method: 'GET',
    host: 'accounts.google.com',
    path: ROTATE_PATH,
    httpStatus: 200,
    requestCookieCount: cookie.split('; ').length,
    rotatedCookieNames: [...ROTATED_COOKIE_NAMES],
    stored: true,
    capturedAt: storedBundle.capturedAt,
  };
}
