import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Cookie, CookieJar } from 'tough-cookie';
import { coupangForbiddenCode } from './coupang-response.mjs';

export const COUPANG_PARTNERS_ORIGIN = 'https://partners.coupang.com';
export const COUPANG_CONFIG_PROOF_PATH = '/api/v1/config';
export const COUPANG_AUTH_COOKIE_NAMES = Object.freeze([
  'AFATK', 'CT_AT', 'CT_LSID', 'CT_JKTH', 'sid', 'web-session-id', 'member_srl',
  'CPUSR_RL', 'CSID', 'PCID', 'ILOGIN', 'MARKETID', 'CUPT',
]);
export const COUPANG_ROUTING_COOKIE_NAMES = Object.freeze([
  'AWSALB', 'AWSALBCORS', 'AWSALBTG', 'AWSALBTGCORS',
]);

const ORIGIN = COUPANG_PARTNERS_ORIGIN;
const PROOF_URL = `${ORIGIN}${COUPANG_CONFIG_PROOF_PATH}`;
const DASHBOARD_URL = `${ORIGIN}/api/v1/dashboard`;
const AUTH_NAMES = new Set(COUPANG_AUTH_COOKIE_NAMES);
const ROUTING_NAMES = new Set(COUPANG_ROUTING_COOKIE_NAMES);
const ALLOWED_COOKIE_NAMES = new Set([...AUTH_NAMES, ...ROUTING_NAMES]);
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 10 * 1000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseCookieHeader(header) {
  const values = new Map();
  if (typeof header !== 'string' || !header) return values;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!ALLOWED_COOKIE_NAMES.has(name)) continue;
    if (values.has(name)) throw fail('COUPANG_OWNER_BINDING_INVALID');
    values.set(name, value);
  }
  return values;
}

function cookieJarForSession(session) {
  if (!session || typeof session.toJSON !== 'function') throw fail('COUPANG_OWNER_BINDING_INVALID');
  let serialized;
  try { serialized = session.toJSON(); } catch { throw fail('COUPANG_OWNER_BINDING_INVALID'); }
  if (!plainObject(serialized) || JSON.stringify(serialized.allowedOrigins) !== JSON.stringify([ORIGIN])
    || JSON.stringify(serialized.cookieOrigins) !== JSON.stringify([ORIGIN])
    || !plainObject(serialized.cookieJar)) throw fail('COUPANG_OWNER_BINDING_INVALID');
  let jar;
  try { jar = CookieJar.deserializeSync(serialized.cookieJar); } catch { throw fail('COUPANG_OWNER_BINDING_INVALID'); }
  return { serialized, jar };
}

function observedCookieMap(value) {
  if (!Array.isArray(value) || value.length > 64) throw fail('COUPANG_ATTESTATION_INVALID');
  const map = new Map();
  for (const cookie of value) {
    if (!plainObject(cookie) || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
      throw fail('COUPANG_ATTESTATION_INVALID');
    }
    if (!ALLOWED_COOKIE_NAMES.has(cookie.name)) continue;
    if (map.has(cookie.name)) throw fail('COUPANG_ATTESTATION_INVALID');
    map.set(cookie.name, cookie.value);
  }
  if (COUPANG_AUTH_COOKIE_NAMES.some(name => !map.has(name))) throw fail('COUPANG_ATTESTATION_INVALID');
  return map;
}

function expectedCookieMap(session) {
  const { serialized, jar } = cookieJarForSession(session);
  const cookies = serialized.cookieJar.cookies;
  if (!Array.isArray(cookies) || cookies.length > 17) throw fail('COUPANG_OWNER_BINDING_INVALID');
  const presentNames = new Set();
  for (const cookie of cookies) {
    if (!plainObject(cookie) || typeof cookie.key !== 'string' || typeof cookie.value !== 'string'
      || !ALLOWED_COOKIE_NAMES.has(cookie.key) || presentNames.has(cookie.key)) {
      throw fail('COUPANG_OWNER_BINDING_INVALID');
    }
    presentNames.add(cookie.key);
  }
  let outgoing;
  try { outgoing = parseCookieHeader(jar.getCookieStringSync(PROOF_URL)); }
  catch (error) {
    if (error?.code) throw error;
    throw fail('COUPANG_OWNER_BINDING_INVALID');
  }
  if (COUPANG_AUTH_COOKIE_NAMES.some(name => !outgoing.has(name))) throw fail('COUPANG_OWNER_BINDING_INVALID');
  return outgoing;
}

function validateExpectedIdentity(identity) {
  if (!plainObject(identity) || typeof identity.email !== 'string' || !identity.email.includes('@')
    || typeof identity.affiliateCode !== 'string' || !identity.affiliateCode) {
    throw fail('COUPANG_ATTESTATION_INVALID');
  }
}

function validateObservedProof(expectedIdentity, proof, now = Date.now()) {
  validateExpectedIdentity(expectedIdentity);
  if (!plainObject(proof) || proof.version !== 1 || proof.origin !== ORIGIN
    || proof.path !== COUPANG_CONFIG_PROOF_PATH || proof.method !== 'GET'
    || proof.httpStatus !== 200 || proof.rCode !== '0'
    || !Number.isSafeInteger(proof.capturedAt)
    || now - proof.capturedAt > MAX_PROOF_AGE_MS || proof.capturedAt - now > MAX_FUTURE_SKEW_MS
    || !plainObject(proof.member) || proof.member.valid !== true
    || typeof proof.member.email !== 'string'
    || proof.member.email.trim().toLowerCase() !== expectedIdentity.email.trim().toLowerCase()
    || !plainObject(proof.affiliate) || proof.affiliate.affiliateCode !== expectedIdentity.affiliateCode) {
    throw fail('COUPANG_ATTESTATION_INVALID');
  }
  return observedCookieMap(proof.requestCookies);
}

function authCookieProjection(session) {
  const { serialized } = cookieJarForSession(session);
  const jarCookies = serialized.cookieJar.cookies;
  if (!Array.isArray(jarCookies)) throw fail('COUPANG_OWNER_BINDING_INVALID');
  const seen = new Set();
  const authCookies = [];
  for (const cookie of jarCookies) {
    if (!plainObject(cookie) || typeof cookie.key !== 'string') throw fail('COUPANG_OWNER_BINDING_INVALID');
    if (!ALLOWED_COOKIE_NAMES.has(cookie.key) || seen.has(cookie.key)) throw fail('COUPANG_OWNER_BINDING_INVALID');
    seen.add(cookie.key);
    if (!AUTH_NAMES.has(cookie.key)) continue;
    if (typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') {
      throw fail('COUPANG_OWNER_BINDING_INVALID');
    }
    // Cookie lifetime and access timestamps may refresh without rotating its
    // identity. Keep binding the value and scope/security attributes instead.
    authCookies.push({
      name: cookie.key,
      value: cookie.value,
      domain: cookie.domain.toLowerCase(),
      path: cookie.path,
      hostOnly: cookie.hostOnly === true,
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      sameSite: typeof cookie.sameSite === 'string' ? cookie.sameSite : null,
    });
  }
  if (authCookies.length !== COUPANG_AUTH_COOKIE_NAMES.length
    || COUPANG_AUTH_COOKIE_NAMES.some(name => !seen.has(name))) throw fail('COUPANG_OWNER_BINDING_INVALID');
  authCookies.sort((a, b) => a.name.localeCompare(b.name));
  return authCookies;
}

function bindingPayload(session, state) {
  return JSON.stringify({
    version: 1,
    origin: ORIGIN,
    allowedOrigins: [ORIGIN],
    cookieOrigins: [ORIGIN],
    email: state.email.trim().toLowerCase(),
    affiliateCode: state.affiliateCode,
    authCookies: authCookieProjection(session),
  });
}

function calculateDigest(key, session, state) {
  let keyBytes;
  try { keyBytes = Buffer.from(key, 'base64url'); } catch { throw fail('COUPANG_OWNER_BINDING_INVALID'); }
  if (keyBytes.length !== 32 || keyBytes.toString('base64url') !== key) throw fail('COUPANG_OWNER_BINDING_INVALID');
  return createHmac('sha256', keyBytes).update(bindingPayload(session, state), 'utf8').digest('base64url');
}

export function createCoupangOwnerBinding(session, expectedIdentity, observedProof) {
  const observed = validateObservedProof(expectedIdentity, observedProof);
  const actual = expectedCookieMap(session);
  for (const name of COUPANG_AUTH_COOKIE_NAMES) {
    if (!observed.has(name) || observed.get(name) !== actual.get(name)) throw fail('COUPANG_ATTESTATION_INVALID');
  }
  const key = randomBytes(32).toString('base64url');
  const state = { email: expectedIdentity.email, affiliateCode: expectedIdentity.affiliateCode };
  return {
    version: 1,
    source: 'authorized_browser_config_session_binding',
    generationId: randomUUID(),
    derivationVersion: 'AFATK_v1',
    hmacKey: key,
    digest: calculateDigest(key, session, state),
  };
}

export function assertCoupangOwnerBinding(session, state) {
  if (!plainObject(state) || state.version !== 2 || typeof state.email !== 'string'
    || typeof state.affiliateCode !== 'string' || !state.affiliateCode
    || !plainObject(state.ownerBinding)) throw fail('COUPANG_OWNER_BINDING_INVALID');
  const binding = state.ownerBinding;
  if (binding.version !== 1 || binding.source !== 'authorized_browser_config_session_binding'
    || binding.derivationVersion !== 'AFATK_v1'
    || typeof binding.generationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.generationId)
    || typeof binding.hmacKey !== 'string' || typeof binding.digest !== 'string') {
    throw fail('COUPANG_OWNER_BINDING_INVALID');
  }
  const expected = calculateDigest(binding.hmacKey, session, state);
  let actualBytes;
  let expectedBytes;
  try {
    actualBytes = Buffer.from(binding.digest, 'base64url');
    expectedBytes = Buffer.from(expected, 'base64url');
  } catch { throw fail('COUPANG_OWNER_BINDING_INVALID'); }
  if (actualBytes.length !== 32 || actualBytes.toString('base64url') !== binding.digest
    || expectedBytes.length !== actualBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw fail('COUPANG_OWNER_BINDING_INVALID');
  }
  return true;
}

function setCookieList(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const joined = headers.get('set-cookie');
  if (!joined) return [];
  return joined.split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g);
}

function isAllowedSetCookie(value) {
  const match = /^\s*([^=;\s]+)=/.exec(value);
  return Boolean(match && ALLOWED_COOKIE_NAMES.has(match[1]));
}

function filterResponseCookies(response) {
  let values;
  try { values = setCookieList(response.headers); } catch { throw fail('COUPANG_COOKIE_RESPONSE_INVALID'); }
  if (!values.length) return response;
  const allowed = values.filter(isAllowedSetCookie);
  if (allowed.length === values.length) return response;
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const value of allowed) headers.append('set-cookie', value);
  return { status: response.status, statusText: response.statusText, headers, body: response.body, url: response.url };
}

export function createCoupangServiceFetch(fetchImpl = fetch) {
  if (typeof fetchImpl !== 'function') throw fail('SCOPED_SESSION_FETCH_UNAVAILABLE');
  return async (rawUrl, init = {}) => {
    let url;
    try { url = new URL(rawUrl); } catch { throw fail('COUPANG_SERVICE_URL_INVALID'); }
    const headers = new Headers(init.headers);
    // Caller-supplied token material is never trusted. The one observed x-token
    // is rebuilt from the Cookie header that ScopedSession is actually sending.
    headers.delete('x-token');
    headers.delete('x-de-token');
    if (url.origin === ORIGIN) {
      const businessApi = url.pathname.startsWith('/api/v1/')
        && url.pathname !== '/api/v1/config' && url.pathname !== '/api/v1/prelogin';
      if (businessApi) {
        const cookies = parseCookieHeader(headers.get('cookie') || '');
        const token = cookies.get('AFATK');
        if (token) headers.set('x-token', token);
      }
    } else {
      headers.delete('cookie');
      headers.delete('authorization');
      headers.delete('x-csrf-token');
      headers.delete('x-xsrf-token');
    }
    const response = await fetchImpl(rawUrl, { ...init, headers });
    if (url.origin === ORIGIN) return filterResponseCookies(response);
    return response;
  };
}

function parseJsonResponse(response) {
  if (response.status === 401) throw fail('REAUTH_REQUIRED');
  if (response.status === 403) throw fail(coupangForbiddenCode(response));
  if (response.status === 429) throw fail('AUTH_THROTTLED');
  if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers?.['content-type'] || '')) {
    throw fail('AUTH_RESPONSE_INVALID');
  }
  let body;
  try { body = JSON.parse(Buffer.isBuffer(response.raw) ? response.raw.toString('utf8') : String(response.raw)); }
  catch { throw fail('AUTH_RESPONSE_INVALID'); }
  if (body?.rCode !== '0') throw fail('AUTH_APPLICATION_REJECTED');
  return body.data;
}

function assertLiveBusinessToken(session) {
  const { jar } = cookieJarForSession(session);
  const outgoing = parseCookieHeader(jar.getCookieStringSync(DASHBOARD_URL));
  if (!outgoing.get('AFATK')) throw fail('REAUTH_REQUIRED');
}

function acceptObservedSessionRotation(session, state, before, observedCookies) {
  const after = authCookieProjection(session);
  const changed = after.filter((cookie, index) => JSON.stringify(cookie) !== JSON.stringify(before[index]));
  const allowed = new Set(['CT_AT', 'CT_JKTH']);
  for (const name of allowed) {
    const observed = observedCookies.filter(cookie => cookie.key === name);
    if (observed.length > 1 || observed.some(cookie => !(Cookie.fromJSON(cookie)?.expiryTime() > Date.now()))) {
      throw fail('COUPANG_OWNER_BINDING_INVALID');
    }
  }
  for (const cookie of changed) {
    const previous = before.find(value => value.name === cookie.name);
    const matching = observedCookies.filter(value => value.key === cookie.name);
    if (!allowed.has(cookie.name) || !previous || matching.length !== 1
      || JSON.stringify({ ...cookie, value: null }) !== JSON.stringify({ ...previous, value: null })) {
      throw fail('COUPANG_OWNER_BINDING_INVALID');
    }
    const observed = matching[0];
    const observedScope = {
      name: observed.key, value: observed.value, domain: observed.domain?.toLowerCase(), path: observed.path,
      hostOnly: observed.hostOnly === true, secure: observed.secure === true, httpOnly: observed.httpOnly === true,
      sameSite: typeof observed.sameSite === 'string' ? observed.sameSite : null,
    };
    if (JSON.stringify(observedScope) !== JSON.stringify(cookie)
      || !(Cookie.fromJSON(observed)?.expiryTime() > Date.now())) {
      throw fail('COUPANG_OWNER_BINDING_INVALID');
    }
  }
  if (changed.length) {
    // The pre-request HMAC and unchanged AFATK/account cookies establish owner
    // continuity. Only these two observed dashboard response rotations qualify.
    state.ownerBinding = { ...state.ownerBinding,
      digest: calculateDigest(state.ownerBinding.hmacKey, session, state) };
  }
  assertCoupangOwnerBinding(session, state);
  return changed.map(cookie => cookie.name);
}

export async function verifyCoupangBoundOwner(session, state) {
  assertCoupangOwnerBinding(session, state);
  assertLiveBusinessToken(session);
  if (typeof session.retainExpiredCookieEvidence !== 'function') {
    throw fail('COUPANG_SESSION_CLIENT_INCOMPATIBLE');
  }
  session.retainExpiredCookieEvidence();
  const before = authCookieProjection(session);
  const observedCookies = [];
  const response = await session.request(DASHBOARD_URL, { onCookiesApplied: event => {
    if (event.origin === ORIGIN && event.path === '/api/v1/dashboard' && event.status === 200) {
      observedCookies.push(...event.cookies.filter(cookie => cookie.key === 'CT_AT' || cookie.key === 'CT_JKTH'));
    }
  } });
  const data = parseJsonResponse(response);
  if (!plainObject(data) || !Array.isArray(data.categories) || !plainObject(data.dailyTrend)
    || !plainObject(data.monthlyAggregation)) throw fail('DASHBOARD_SCHEMA_INVALID');
  assertLiveBusinessToken(session);
  const rotatedCookieNames = acceptObservedSessionRotation(session, state, before, observedCookies);
  return {
    authenticated: true,
    ownerVerified: true,
    browserUsed: false,
    ownerVerificationSource: 'authorized_browser_config_session_binding',
    freshHttpIdentityRead: false,
    ...(rotatedCookieNames.length ? { rotatedCookieNames } : {}),
  };
}
