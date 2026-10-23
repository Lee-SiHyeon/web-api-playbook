import path from 'node:path';
import { ProtectedStore } from './protected-store.mjs';
import { ScopedSession } from './scoped-session.mjs';
import { withSessionLock } from './session-lock.mjs';

export const ELEVENLABS_STORE = 'elevenlabs-session-v1';
const STATE_SCHEMA = 'elevenlabs-observed-session-v1';
const AUTH_HEADER = /^(?:authorization|[a-z0-9-]{0,48}(?:api[-_]?key|auth(?:orization|entication)?|access[-_]?token|refresh[-_]?token|csrf|xsrf|session[-_]?id)[a-z0-9-]{0,48})$/i;
const MAX_CAPTURE_AGE_MS = 5 * 60 * 1000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateOrigin(value) {
  if (typeof value !== 'string' || value.length > 512) fail('ELEVENLABS_ORIGIN_INVALID');
  let url;
  try { url = new URL(value); } catch { fail('ELEVENLABS_ORIGIN_INVALID'); }
  const host = url.hostname.toLowerCase();
  if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password
    || url.port || url.pathname !== '/' || url.search || url.hash
    || !(host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io'))) fail('ELEVENLABS_ORIGIN_SCOPE');
  return value;
}

function validateCapture(envelope, now = Date.now()) {
  if (!object(envelope) || Object.keys(envelope).some(key => !['capturedAt', 'observedOrigins'].includes(key))) {
    fail('ELEVENLABS_IMPORT_SCHEMA_INVALID');
  }
  const capturedAt = Date.parse(envelope?.capturedAt);
  const age = now - capturedAt;
  if (!Number.isFinite(age) || age < -1000 || age > MAX_CAPTURE_AGE_MS
    || !Array.isArray(envelope.observedOrigins) || envelope.observedOrigins.length < 1
    || envelope.observedOrigins.length > 8) fail('ELEVENLABS_IMPORT_STALE_OR_INVALID');

  const allowedOrigins = [];
  const cookieOrigins = [];
  const headersByOrigin = {};
  const cookies = [];
  const credentialKinds = [];
  for (const observed of envelope.observedOrigins) {
    if (!object(observed) || Object.keys(observed).some(key => !['origin', 'responseStatus', 'authHeaders', 'cookies'].includes(key))
      || observed.responseStatus !== 200) fail('ELEVENLABS_IMPORT_EVIDENCE_REQUIRED');
    const origin = validateOrigin(observed.origin);
    if (allowedOrigins.includes(origin)) fail('ELEVENLABS_IMPORT_ORIGIN_DUPLICATE');
    allowedOrigins.push(origin);

    const authHeaders = observed.authHeaders ?? {};
    if (!object(authHeaders) || Object.keys(authHeaders).length > 16) fail('ELEVENLABS_IMPORT_HEADERS_INVALID');
    const normalized = {};
    for (const [name, value] of Object.entries(authHeaders)) {
      if (!AUTH_HEADER.test(name) || typeof value !== 'string' || !value || value.length > 16_384
        || /[\r\n\0]/.test(value) || Object.hasOwn(normalized, name.toLowerCase())) fail('ELEVENLABS_IMPORT_HEADERS_INVALID');
      normalized[name.toLowerCase()] = value;
      credentialKinds.push(`header:${name.toLowerCase()}`);
    }
    if (Object.keys(normalized).length) headersByOrigin[origin] = normalized;

    if (observed.cookies !== undefined && (!Array.isArray(observed.cookies) || observed.cookies.length > 256)) {
      fail('ELEVENLABS_IMPORT_COOKIES_INVALID');
    }
    const originCookies = observed.cookies ?? [];
    if (originCookies.length) cookieOrigins.push(origin);
    const cookieKeys = new Set();
    for (const cookie of originCookies) {
      if (!object(cookie) || Object.keys(cookie).some(key => !['name', 'value', 'domain', 'path', 'expires', 'expirationDate',
        'secure', 'httpOnly', 'sameSite', 'hostOnly'].includes(key))
        || typeof cookie.name !== 'string' || !cookie.name
        || typeof cookie.value !== 'string' || cookie.value.length > 8192
        || typeof cookie.domain !== 'string' || !/^(?:elevenlabs\.io|[a-z0-9.-]+\.elevenlabs\.io)$/i
          .test(cookie.domain.toLowerCase().replace(/^\./, ''))
        || cookie.expires != null && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))
        || cookie.expirationDate != null && (typeof cookie.expirationDate !== 'number' || !Number.isFinite(cookie.expirationDate))
        || (cookie.expires ?? cookie.expirationDate) > 0 && (cookie.expires ?? cookie.expirationDate) <= now / 1000) {
        fail('ELEVENLABS_IMPORT_COOKIES_INVALID');
      }
      const cookieKey = `${cookie.name}\0${cookie.domain.toLowerCase()}\0${cookie.path ?? '/'}`;
      if (cookieKeys.has(cookieKey)) fail('ELEVENLABS_IMPORT_COOKIES_INVALID');
      cookieKeys.add(cookieKey);
      cookies.push(cookie);
      credentialKinds.push(`cookie:${cookie.name}`);
    }
    if (!Object.keys(normalized).length && !originCookies.length) fail('ELEVENLABS_IMPORT_CREDENTIAL_MISSING');
  }

  const session = new ScopedSession({
    allowedOrigins,
    cookieOrigins,
    cookies,
    defaultHeaders: {},
    headersByOrigin,
    timeoutMs: 30_000,
    maxResponseBytes: 32 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxRedirects: 0,
  });
  return {
    schema: STATE_SCHEMA,
    capturedAt: new Date(capturedAt).toISOString(),
    observedResponseStatuses: envelope.observedOrigins.map(item => item.responseStatus),
    credentialKinds: [...new Set(credentialKinds)].sort(),
    session: session.toJSON(),
  };
}

function validateState(state) {
  if (!object(state) || state.schema !== STATE_SCHEMA || !Number.isFinite(Date.parse(state.capturedAt))
    || !Array.isArray(state.observedResponseStatuses) || state.observedResponseStatuses.length < 1
    || state.observedResponseStatuses.some(status => status !== 200)
    || !Array.isArray(state.credentialKinds) || !object(state.session)) fail('ELEVENLABS_STATE_INVALID');
  const session = state.session;
  if (!Array.isArray(session.allowedOrigins) || session.allowedOrigins.length < 1 || session.allowedOrigins.length > 8
    || session.allowedOrigins.some(origin => validateOrigin(origin) !== origin)
    || new Set(session.allowedOrigins).size !== session.allowedOrigins.length
    || state.observedResponseStatuses.length !== session.allowedOrigins.length
    || session.defaultHeaders == null || Object.keys(session.defaultHeaders).length !== 0
    || session.maxRedirects !== 0 || session.allowLoopbackHttp !== false) fail('ELEVENLABS_STATE_SCOPE');
  if (!object(session.headersByOrigin) || Object.keys(session.headersByOrigin).some(origin => !session.allowedOrigins.includes(origin))) {
    fail('ELEVENLABS_STATE_SCOPE');
  }
  for (const values of Object.values(session.headersByOrigin)) {
    if (!object(values) || Object.entries(values).some(([name, value]) => !AUTH_HEADER.test(name)
      || typeof value !== 'string' || !value || value.length > 16_384 || /[\r\n\0]/.test(value))) fail('ELEVENLABS_STATE_SCOPE');
  }
  ScopedSession.fromJSON(session);
  return session;
}

export async function importElevenLabsSession(envelope, { store = new ProtectedStore() } = {}) {
  const state = validateCapture(envelope);
  return withSessionLock(() => store.write(ELEVENLABS_STORE, JSON.stringify(state)), {
    root: path.join(store.directory, 'locks'), key: ELEVENLABS_STORE,
  });
}

export async function elevenLabsSessionStatus({ store = new ProtectedStore() } = {}) {
  const storage = store.status(ELEVENLABS_STORE);
  if (!storage.available) return { storage, stored: false, liveCheckPerformed: false };
  try {
    const state = JSON.parse(store.read(ELEVENLABS_STORE));
    const session = validateState(state);
    return {
      storage,
      stored: true,
      capturedAt: state.capturedAt,
      observedOrigins: [...session.allowedOrigins],
      credentialKinds: [...state.credentialKinds],
      liveCheckPerformed: false,
      authenticatedOwnerVerified: false,
      optionsRead: false,
      generationPerformed: false,
    };
  } catch (error) {
    const code = /^ELEVENLABS_[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'ELEVENLABS_STATE_INVALID';
    return { storage, stored: false, liveCheckPerformed: false, code };
  }
}

// Build a validated in-memory session for observed request code. This module
// intentionally declares no endpoint paths or request bodies; those must be
// added only after browser-network capture and independent response validation.
export function loadElevenLabsSession({ store = new ProtectedStore(), fetchImpl } = {}) {
  const raw = store.read(ELEVENLABS_STORE);
  if (!raw) fail('ELEVENLABS_SESSION_MISSING');
  let state;
  try { state = JSON.parse(raw); } catch { fail('ELEVENLABS_STATE_INVALID'); }
  const session = validateState(state);
  return ScopedSession.fromJSON(session, fetchImpl ? { fetchImpl } : {});
}
