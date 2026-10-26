import path from 'node:path';
import { ProtectedStore } from '../protected-store.mjs';
import { ScopedSession } from '../scoped-session.mjs';
import { withSessionLock } from '../session-lock.mjs';

export const KMONG_ACCOUNT_ORIGIN = 'https://kmong.com';
export const KMONG_ACCOUNT_PATH = '/api/user/v3/me';
export const KMONG_ACCOUNT_URL = KMONG_ACCOUNT_ORIGIN + KMONG_ACCOUNT_PATH;
export const KMONG_ACCOUNT_STORE = 'kmong-account-state';
export const KMONG_AUTH_COOKIE = 'x-kmong-authorization';

const ORIGINS = [KMONG_ACCOUNT_ORIGIN];
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_COOKIE_VALUE_LENGTH = 8_192;
// Match ScopedSession's RFC 6265 value policy; punctuation that can break a
// Cookie header pair (quote, comma, semicolon, backslash) is rejected here.
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,8192}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;

function fail(code, receipt) {
  const error = new Error(code);
  error.name = 'KmongAuthError';
  error.code = code;
  if (receipt) error.receipt = receipt;
  throw error;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  Object.keys(value).every(key => keys.includes(key));
const validEmail = value => typeof value === 'string' && value.length <= 320 && EMAIL.test(value) && !CONTROL.test(value);
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);
const validIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

function checkedAt(now) {
  let value;
  try { value = now(); } catch { fail('KMONG_AUTH_CLOCK_INVALID'); }
  const millis = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(millis)) fail('KMONG_AUTH_CLOCK_INVALID');
  try { return new Date(millis).toISOString(); } catch { fail('KMONG_AUTH_CLOCK_INVALID'); }
}

export function validateKmongSessionImport(input, { now = Date.now } = {}) {
  if (!exactKeys(input, ['schemaVersion', 'service', 'expectedEmail', 'cookies']) ||
      input.schemaVersion !== 1 || input.service !== 'kmong' || !validEmail(input.expectedEmail) ||
      !Array.isArray(input.cookies) || input.cookies.length !== 1) fail('KMONG_AUTH_IMPORT_INVALID');
  const cookie = input.cookies[0];
  if (!exactKeys(cookie, ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expiresAt']) ||
      cookie.name !== KMONG_AUTH_COOKIE || typeof cookie.value !== 'string' ||
      cookie.value.length > MAX_COOKIE_VALUE_LENGTH || !COOKIE_VALUE.test(cookie.value) ||
      cookie.domain !== '.kmong.com' || cookie.path !== '/' || cookie.secure !== true || cookie.httpOnly !== true ||
      !(cookie.expiresAt === null || validIso(cookie.expiresAt))) fail('KMONG_AUTH_COOKIE_INVALID');
  if (cookie.expiresAt !== null && Date.parse(cookie.expiresAt) <= Number(now())) fail('KMONG_AUTH_COOKIE_EXPIRED');
  return {
    version: 1,
    service: 'kmong',
    expectedEmail: input.expectedEmail.trim().toLowerCase(),
    requiredCookieNames: [KMONG_AUTH_COOKIE],
    cookies: [{
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: true,
      httpOnly: true,
      hostOnly: false,
      ...(cookie.expiresAt === null ? {} : { expires: Date.parse(cookie.expiresAt) / 1000 }),
    }],
  };
}

function safeSession(session, fetchImpl) {
  let serialized;
  try { serialized = session.toJSON(); } catch { fail('KMONG_AUTH_STATE_INVALID'); }
  if (JSON.stringify(serialized.allowedOrigins) !== JSON.stringify(ORIGINS) ||
      JSON.stringify(serialized.cookieOrigins) !== JSON.stringify(ORIGINS) || serialized.allowLoopbackHttp !== false ||
      JSON.stringify(serialized.defaultHeaders) !== JSON.stringify({ accept: 'application/json' }) ||
      JSON.stringify(serialized.headersByOrigin) !== JSON.stringify({}) || serialized.timeoutMs !== 15_000 ||
      serialized.maxRequestBytes !== 1_024 || serialized.maxResponseBytes !== MAX_RESPONSE_BYTES || serialized.maxRedirects !== 0 ||
      !Array.isArray(serialized.cookieJar?.cookies)) fail('KMONG_AUTH_STATE_INVALID');
  serialized.cookieJar.cookies = serialized.cookieJar.cookies.filter(cookie =>
    cookie?.key === KMONG_AUTH_COOKIE && typeof cookie.value === 'string' && cookie.value.length > 0);
  for (const cookie of serialized.cookieJar.cookies) {
    if (cookie.domain !== 'kmong.com' || cookie.path !== '/' || cookie.hostOnly !== false || cookie.secure !== true || cookie.httpOnly !== true ||
        typeof cookie.value !== 'string' || !COOKIE_VALUE.test(cookie.value) || cookie.value.length > MAX_COOKIE_VALUE_LENGTH) {
      fail('KMONG_AUTH_STATE_INVALID');
    }
  }
  try { return ScopedSession.fromJSON(serialized, { fetchImpl }); }
  catch { fail('KMONG_AUTH_STATE_INVALID'); }
}

function validCookieState(session, { now, allowMissing = false } = {}) {
  let cookies;
  try { cookies = session.toJSON().cookieJar.cookies; } catch { fail('KMONG_AUTH_STATE_INVALID'); }
  if (!Array.isArray(cookies) || cookies.some(cookie => cookie?.key !== KMONG_AUTH_COOKIE)) fail('KMONG_AUTH_STATE_INVALID');
  if (!cookies.length) {
    if (allowMissing) return false;
    fail('KMONG_AUTH_REAUTH_REQUIRED');
  }
  let currentTime;
  try { currentTime = typeof now === 'function' ? now() : now; } catch { fail('KMONG_AUTH_CLOCK_INVALID'); }
  if (currentTime instanceof Date) currentTime = currentTime.getTime();
  if (!Number.isFinite(currentTime)) fail('KMONG_AUTH_CLOCK_INVALID');
  const scoped = cookies.filter(cookie => cookie.domain === 'kmong.com' && cookie.path === '/' && cookie.hostOnly === false &&
    cookie.secure === true && cookie.httpOnly === true && typeof cookie.value === 'string' &&
    cookie.value.length <= MAX_COOKIE_VALUE_LENGTH && (cookie.value === '' || COOKIE_VALUE.test(cookie.value)));
  if (cookies.length !== 1 || scoped.length !== 1) fail('KMONG_AUTH_COOKIE_INVALID');
  const cookie = scoped[0];
  if (!cookie.value || cookie.expires !== undefined && cookie.expires !== 'Infinity' && Date.parse(cookie.expires) <= currentTime) {
    if (allowMissing) return false;
    fail('KMONG_AUTH_REAUTH_REQUIRED');
  }
  return true;
}

function validateStoredState(state, fetchImpl) {
  const keys = ['version', 'service', 'expectedEmail', 'ownerId', 'requiredCookieNames', 'verified',
    'bootstrapMode', 'createdAt', 'updatedAt', 'lastVerifiedAt', 'session'];
  if (!exactKeys(state, keys) || state.version !== 1 || state.service !== 'kmong' ||
      !validEmail(state.expectedEmail) || !Number.isSafeInteger(state.ownerId) || state.ownerId <= 0 ||
      JSON.stringify(state.requiredCookieNames) !== JSON.stringify([KMONG_AUTH_COOKIE]) ||
      typeof state.verified !== 'boolean' || state.bootstrapMode !== 'manual_browser_cookie_import' ||
      !validIso(state.createdAt) || !validIso(state.updatedAt) || !validIso(state.lastVerifiedAt)) fail('KMONG_AUTH_STATE_INVALID');
  const transport = state.session;
  if (!object(transport) || JSON.stringify(transport.allowedOrigins) !== JSON.stringify(ORIGINS) ||
      JSON.stringify(transport.cookieOrigins) !== JSON.stringify(ORIGINS) || transport.allowLoopbackHttp !== false ||
      JSON.stringify(transport.defaultHeaders) !== JSON.stringify({ accept: 'application/json' }) ||
      JSON.stringify(transport.headersByOrigin) !== JSON.stringify({}) || transport.timeoutMs !== 15_000 ||
      transport.maxRequestBytes !== 1_024 || transport.maxResponseBytes !== MAX_RESPONSE_BYTES || transport.maxRedirects !== 0) {
    fail('KMONG_AUTH_STATE_INVALID');
  }
  let session;
  try { session = ScopedSession.fromJSON(transport, { fetchImpl }); } catch { fail('KMONG_AUTH_STATE_INVALID'); }
  session = safeSession(session, fetchImpl);
  validCookieState(session, { now: Date.now, allowMissing: true });
  return { state, session };
}

function accountSchema(data, receipt) {
  if (!object(data) || !Number.isSafeInteger(data.USERID) || data.USERID <= 0 ||
      !validEmail(data.email) || !validText(data.username, 320) || typeof data.is_mobile_auth !== 'boolean' ||
      !validText(data.social_provider, 200)) fail('KMONG_AUTH_OWNER_SCHEMA_INVALID', receipt);
  return {
    userId: data.USERID,
    email: data.email.trim().toLowerCase(),
    username: data.username,
  };
}

function responseReceipt(status, mime, bytes, checkedAtValue, { cookiesSent = true } = {}) {
  return {
    method: 'GET', origin: KMONG_ACCOUNT_ORIGIN, path: KMONG_ACCOUNT_PATH,
    httpStatus: status, mime: mime ?? null, responseBytes: bytes,
    checkedAt: checkedAtValue, browserUsed: false, authenticated: false,
    credentialsUsed: true, cookiesSent, readOnly: true,
  };
}

function transportReceipt(causeCode, checkedAtValue) {
  return {
    method: 'GET', origin: KMONG_ACCOUNT_ORIGIN, path: KMONG_ACCOUNT_PATH,
    checkedAt: checkedAtValue, browserUsed: false, authenticated: false,
    credentialsUsed: true, cookiesSent: true, readOnly: true,
    causeCode: typeof causeCode === 'string' && /^SCOPED_SESSION_[A-Z_]+$/.test(causeCode)
      ? causeCode : 'TRANSPORT_ERROR',
  };
}

export function createKmongAuth({ store = new ProtectedStore(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' ||
      typeof store.status !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') {
    fail('KMONG_AUTH_CONFIGURATION_INVALID');
  }
  const locked = callback => withSessionLock(callback, {
    root: path.join(store.directory, 'locks'), key: KMONG_ACCOUNT_STORE,
  });
  const save = state => store.write(KMONG_ACCOUNT_STORE, JSON.stringify(state));

  function loadState() {
    const raw = store.read(KMONG_ACCOUNT_STORE);
    if (!raw) fail('KMONG_AUTH_SESSION_MISSING');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('KMONG_AUTH_STATE_INVALID'); }
    return validateStoredState(parsed, fetchImpl);
  }

  function makeSession(imported) {
    let session;
    try {
      session = new ScopedSession({
        allowedOrigins: ORIGINS,
        cookieOrigins: ORIGINS,
        cookies: imported.cookies,
        defaultHeaders: { accept: 'application/json' },
        timeoutMs: 15_000,
        maxRequestBytes: 1_024,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        fetchImpl,
      });
    } catch { fail('KMONG_AUTH_COOKIE_INVALID'); }
    validCookieState(session, { now, allowMissing: false });
    return session;
  }

  async function readOwner(session, { operation, expectedEmail, expectedOwnerId, stateToInvalidate = null } = {}) {
    try { validCookieState(session, { now, allowMissing: false }); }
    catch (error) {
      if (error?.code === 'KMONG_AUTH_REAUTH_REQUIRED' && stateToInvalidate) {
        stateToInvalidate.verified = false;
        stateToInvalidate.updatedAt = checkedAt(now);
        stateToInvalidate.session = safeSession(session, fetchImpl).toJSON();
        save(stateToInvalidate);
      }
      throw error;
    }
    let response;
    try {
      response = await session.request(KMONG_ACCOUNT_URL, {
        method: 'GET', headers: { accept: 'application/json' },
      });
    } catch (error) {
      const code = error?.code === 'SCOPED_SESSION_TIMEOUT' ? 'KMONG_AUTH_TIMEOUT' :
        error?.code === 'SCOPED_SESSION_REDIRECT_LIMIT' || error?.code === 'SCOPED_SESSION_REDIRECT_SCOPE' ||
          error?.code === 'SCOPED_SESSION_REDIRECT_AUTO_FOLLOWED' ? 'KMONG_AUTH_REDIRECT_REJECTED' :
          error?.code === 'SCOPED_SESSION_COOKIE_ROTATION_FAILED' ? 'KMONG_AUTH_COOKIE_RESPONSE_INVALID' :
            'KMONG_AUTH_TRANSPORT_FAILED';
      const causeCode = typeof error?.code === 'string' && /^SCOPED_SESSION_[A-Z_]+$/.test(error.code)
        ? error.code : 'TRANSPORT_ERROR';
      fail(code, transportReceipt(causeCode, checkedAt(now)));
    }
    const body = typeof response.raw === 'string' ? response.raw : response.raw?.toString?.('utf8') ?? '';
    const mime = response.headers?.['content-type']?.split(';')[0]?.trim().toLowerCase() ?? null;
    const receipt = responseReceipt(response.status, mime, Buffer.byteLength(body), checkedAt(now));
    const current = safeSession(session, fetchImpl);
    const cookiePresent = validCookieState(current, { now, allowMissing: true });
    const saveInvalidated = () => {
      if (!stateToInvalidate) return;
      stateToInvalidate.verified = false;
      stateToInvalidate.updatedAt = checkedAt(now);
      stateToInvalidate.session = current.toJSON();
      save(stateToInvalidate);
    };
    if (!cookiePresent) {
      saveInvalidated();
      fail('KMONG_AUTH_REAUTH_REQUIRED', receipt);
    }
    if (response.status === 204 || response.status === 401) {
      saveInvalidated();
      fail('KMONG_AUTH_REAUTH_REQUIRED', receipt);
    }
    if (response.status === 403) {
      saveInvalidated();
      fail('KMONG_AUTH_FORBIDDEN', receipt);
    }
    if (response.status === 429) {
      saveInvalidated();
      fail('KMONG_AUTH_THROTTLED', receipt);
    }
    if (response.status >= 500) {
      saveInvalidated();
      fail('KMONG_AUTH_SERVER_ERROR', receipt);
    }
    if (response.status !== 200) {
      saveInvalidated();
      fail('KMONG_AUTH_RESPONSE_INVALID', receipt);
    }
    if (mime === 'text/html') {
      saveInvalidated();
      fail('KMONG_AUTH_CHALLENGE_HTML', receipt);
    }
    if (mime !== 'application/json') {
      saveInvalidated();
      fail('KMONG_AUTH_RESPONSE_INVALID', receipt);
    }
    let data;
    try { data = JSON.parse(body); } catch {
      saveInvalidated();
      fail('KMONG_AUTH_RESPONSE_INVALID', receipt);
    }
    const owner = accountSchema(data, receipt);
    if (owner.email !== expectedEmail || (expectedOwnerId !== null && owner.userId !== expectedOwnerId)) {
      fail('KMONG_AUTH_OWNER_MISMATCH', receipt);
    }
    return { owner, session: current, receipt, operation };
  }

  async function verifyStored(operation) {
    return locked(async () => {
      const { state, session } = loadState();
      const result = await readOwner(session, {
        operation, expectedEmail: state.expectedEmail,
        expectedOwnerId: state.ownerId, stateToInvalidate: state,
      });
      const verifiedAt = checkedAt(now);
      save({
        ...state,
        verified: true,
        updatedAt: verifiedAt,
        lastVerifiedAt: verifiedAt,
        session: result.session.toJSON(),
      });
      return {
        service: 'kmong', command: operation,
        authenticated: true, ownerVerified: true, ownerIdPinned: true,
        browserUsed: false, readOnly: true, requestCount: 1,
        credentialProvider: store.status(KMONG_ACCOUNT_STORE).provider,
        persistent: store.status(KMONG_ACCOUNT_STORE).persistent,
        bootstrapMode: 'manual_browser_cookie_import',
        readMode: 'pure_http',
        renewal: 'not_implemented',
        receipt: { ...result.receipt, operation, authenticated: true, ownerVerified: true },
      };
    });
  }

  return Object.freeze({
    status() {
      const stored = store.status(KMONG_ACCOUNT_STORE);
      return {
        service: 'kmong', configured: stored.available, currentAuthentication: 'not_checked',
        credentialProvider: stored.provider, persistent: stored.persistent,
        browserUsed: false, requestCount: 0,
      };
    },
    importSession(input) {
      return locked(async () => {
        const imported = validateKmongSessionImport(input, { now });
        const candidate = makeSession(imported);
        const previousRaw = store.read(KMONG_ACCOUNT_STORE);
        let previous = null;
        if (previousRaw) {
          let parsed;
          try { parsed = JSON.parse(previousRaw); } catch { fail('KMONG_AUTH_STATE_INVALID'); }
          previous = validateStoredState(parsed, fetchImpl).state;
        }
        const result = await readOwner(candidate, {
          operation: 'session-import', expectedEmail: imported.expectedEmail, expectedOwnerId: null,
        });
        if (previous?.expectedEmail === imported.expectedEmail && previous.ownerId !== result.owner.userId) {
          fail('KMONG_AUTH_OWNER_MISMATCH', result.receipt);
        }
        const createdAt = previous?.expectedEmail === imported.expectedEmail ? previous.createdAt : checkedAt(now);
        const verifiedAt = checkedAt(now);
        const state = {
          version: 1,
          service: 'kmong',
          expectedEmail: imported.expectedEmail,
          ownerId: result.owner.userId,
          requiredCookieNames: imported.requiredCookieNames,
          verified: true,
          bootstrapMode: 'manual_browser_cookie_import',
          createdAt,
          updatedAt: verifiedAt,
          lastVerifiedAt: verifiedAt,
          session: result.session.toJSON(),
        };
        save(state);
        const stored = store.status(KMONG_ACCOUNT_STORE);
        return {
          service: 'kmong', command: 'session-import', stored: true,
          authenticated: true, ownerVerified: true, ownerIdPinned: true,
          importedCookieCount: 1,
          credentialProvider: stored.provider, persistent: stored.persistent,
          bootstrapMode: 'manual_browser_cookie_import', readMode: 'pure_http',
          browserUsed: false, requestCount: 1, renewal: 'not_implemented',
          receipt: { ...result.receipt, operation: 'session-import', authenticated: true, ownerVerified: true },
        };
      });
    },
    owner: () => verifyStored('owner'),
    health: () => verifyStored('health'),
    verify: () => verifyStored('verify'),
  });
}
