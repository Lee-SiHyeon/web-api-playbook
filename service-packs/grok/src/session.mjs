import { randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { ProtectedJsonStore } from './protected-json-store.mjs';

export const GROK_WEB_ORIGIN = 'https://grok.com';
export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const CONTROL_NAME_PATTERN = /(?:signature|integrity|challenge|captcha|proof|hmac|attestation)/i;
const FORBIDDEN_HEADER_PATTERN = /^(?:cookie|set-cookie|host|content-length|user-agent|origin|referer)$/i;
const MAX_CREDENTIAL_ITEMS = 64;
const MAX_CREDENTIAL_VALUE_LENGTH = 16 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeHttpsOrigin(value) {
  if (typeof value !== 'string') throw fail('SESSION_ORIGIN_INVALID');
  let parsed;
  try { parsed = new URL(value); } catch { throw fail('SESSION_ORIGIN_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) throw fail('SESSION_ORIGIN_INVALID');
  return parsed.origin;
}

function domainMatchesHost(domain, host) {
  const normalized = String(domain ?? host).replace(/^\./, '').toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

function validateCookie(cookie, origin) {
  if (!isPlainObject(cookie) || typeof cookie.name !== 'string' || !COOKIE_NAME_PATTERN.test(cookie.name)
    || typeof cookie.value !== 'string' || !cookie.value || cookie.value.length > MAX_CREDENTIAL_VALUE_LENGTH
    || /[\r\n\0;]/.test(cookie.value)) throw fail('SESSION_COOKIE_INVALID');
  const cookieOrigin = safeHttpsOrigin(cookie.origin ?? origin);
  if (cookieOrigin !== origin) throw fail('SESSION_CREDENTIAL_SCOPE');
  const host = new URL(origin).hostname;
  const domain = typeof cookie.domain === 'string' && cookie.domain ? cookie.domain : host;
  if (/[\r\n\0/\\]/.test(domain) || !domainMatchesHost(domain, host)) throw fail('SESSION_COOKIE_DOMAIN_SCOPE');
  const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') && !/[\r\n\0]/.test(cookie.path)
    ? cookie.path
    : '/';
  if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') throw fail('SESSION_COOKIE_INVALID');
  if (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean') throw fail('SESSION_COOKIE_INVALID');
  if (cookie.expiresAt !== undefined && cookie.expiresAt !== null
    && (typeof cookie.expiresAt !== 'string' || !Number.isFinite(Date.parse(cookie.expiresAt)))) throw fail('SESSION_COOKIE_INVALID');
  return {
    name: cookie.name,
    value: cookie.value,
    origin,
    domain: domain.replace(/^\./, '').toLowerCase(),
    path: cookiePath,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    expiresAt: cookie.expiresAt ?? null,
  };
}

function validateCredentialHeader(header, origin) {
  if (!isPlainObject(header) || typeof header.name !== 'string' || !HEADER_NAME_PATTERN.test(header.name)
    || FORBIDDEN_HEADER_PATTERN.test(header.name) || /^sec-/i.test(header.name) || CONTROL_NAME_PATTERN.test(header.name)
    || typeof header.value !== 'string' || !header.value || header.value.length > MAX_CREDENTIAL_VALUE_LENGTH
    || /[\r\n\0]/.test(header.value)) throw fail('SESSION_HEADER_INVALID');
  const headerOrigin = safeHttpsOrigin(header.origin ?? origin);
  if (headerOrigin !== origin) throw fail('SESSION_CREDENTIAL_SCOPE');
  return { name: header.name, value: header.value, origin };
}

export function validateSessionBundle(bundle, { now = Date.now(), maxHandoffAgeMs = SESSION_HANDOFF_MAX_AGE_MS } = {}) {
  if (!isPlainObject(bundle) || bundle.schemaVersion !== SESSION_SCHEMA_VERSION || bundle.serviceId !== 'grok-web'
    || safeHttpsOrigin(bundle.origin) !== GROK_WEB_ORIGIN || typeof bundle.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(bundle.capturedAt)) || Date.parse(bundle.capturedAt) > now + 30_000
    || now - Date.parse(bundle.capturedAt) > maxHandoffAgeMs
    || typeof bundle.sourceObservationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(bundle.sourceObservationId)
    || !Array.isArray(bundle.origins) || bundle.origins.length !== 1) throw fail('SESSION_BUNDLE_INVALID');
  const scoped = bundle.origins[0];
  if (!isPlainObject(scoped) || safeHttpsOrigin(scoped.origin) !== GROK_WEB_ORIGIN
    || !Array.isArray(scoped.cookies) || !Array.isArray(scoped.headers)
    || scoped.cookies.length > MAX_CREDENTIAL_ITEMS || scoped.headers.length > MAX_CREDENTIAL_ITEMS) throw fail('SESSION_BUNDLE_INVALID');
  const cookies = scoped.cookies.map(cookie => validateCookie(cookie, GROK_WEB_ORIGIN));
  const headers = scoped.headers.map(header => validateCredentialHeader(header, GROK_WEB_ORIGIN));
  const cookieKeys = cookies.map(cookie => `${cookie.name.toLowerCase()}\0${cookie.domain}\0${cookie.path}`);
  const headerKeys = headers.map(header => header.name.toLowerCase());
  if (new Set(cookieKeys).size !== cookieKeys.length || new Set(headerKeys).size !== headerKeys.length) throw fail('SESSION_CREDENTIAL_DUPLICATE');
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    serviceId: 'grok-web',
    origin: GROK_WEB_ORIGIN,
    capturedAt: new Date(Date.parse(bundle.capturedAt)).toISOString(),
    sourceObservationId: bundle.sourceObservationId,
    generation: randomUUID(),
    ownerBinding: null,
    origins: [{ origin: GROK_WEB_ORIGIN, cookies, headers }],
  };
}

export class GrokSessionStore {
  #store;
  #maxHandoffAgeMs;
  #ownerBindingToken;
  #mutations = Promise.resolve();

  constructor({ store, maxHandoffAgeMs = SESSION_HANDOFF_MAX_AGE_MS, ownerBindingToken } = {}) {
    this.#store = store ?? new ProtectedJsonStore({ fileName: 'session.dpapi' });
    this.#maxHandoffAgeMs = maxHandoffAgeMs;
    this.#ownerBindingToken = ownerBindingToken;
  }

  get provider() { return this.#store.provider; }

  #mutate(callback) {
    const pending = this.#mutations.then(callback);
    this.#mutations = pending.catch(() => {});
    return pending;
  }

  async importBundle(bundle, { now = Date.now() } = {}) {
    return this.#mutate(async () => {
      const session = validateSessionBundle(bundle, { now, maxHandoffAgeMs: this.#maxHandoffAgeMs });
      const receipt = await this.#store.write({ kind: 'grok-session', session });
      return {
        stored: true,
        provider: receipt.provider,
        persistent: receipt.persistent,
        scopes: [GROK_WEB_ORIGIN],
        cookieCount: session.origins[0].cookies.length,
        headerCount: session.origins[0].headers.length,
        capturedAt: session.capturedAt,
        ownerVerified: false,
      };
    });
  }

  async importVerifiedBundle(token, bundle, { expectedGeneration, operationId, httpStatus, identityMatched, identityDigest } = {}) {
    if (!this.#ownerBindingToken || token !== this.#ownerBindingToken) throw fail('OWNER_BINDING_NOT_AUTHORIZED');
    if (typeof operationId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(operationId)
      || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 299 || identityMatched !== true
      || typeof identityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(identityDigest)
      || typeof expectedGeneration !== 'string' || !expectedGeneration) throw fail('OWNER_IDENTITY_PROOF_INVALID');
    return this.#mutate(async () => {
      const current = await this.load();
      if (current.generation !== expectedGeneration || current.ownerBinding?.generation !== current.generation
        || current.ownerBinding?.identityDigest !== identityDigest) throw fail('SESSION_REFRESH_CONCURRENT_CHANGE');
      const session = validateSessionBundle(bundle, { maxHandoffAgeMs: this.#maxHandoffAgeMs });
      session.ownerBinding = { generation: session.generation, identityDigest, operationId, verifiedAt: new Date().toISOString() };
      await this.#store.write({ kind: 'grok-session', session });
      return { ownerVerified: true, source: 'direct_http_identity_read', identityValueEchoed: false };
    });
  }

  async load() {
    const state = await this.#store.read();
    if (!state) throw fail('SESSION_NOT_AVAILABLE');
    if (state.kind !== 'grok-session' || !isPlainObject(state.session) || state.session.schemaVersion !== SESSION_SCHEMA_VERSION
      || state.session.serviceId !== 'grok-web' || state.session.origin !== GROK_WEB_ORIGIN || !Array.isArray(state.session.origins)) {
      throw fail('SESSION_STATE_INVALID');
    }
    return state.session;
  }

  async status({ now = Date.now() } = {}) {
    const state = await this.#store.read();
    if (!state) return { available: false, provider: this.provider, persistent: this.provider === 'Windows DPAPI CurrentUser', scopes: [] };
    const session = state.session;
    const originRecord = session?.origins?.find(item => item.origin === GROK_WEB_ORIGIN);
    const expiredCookieCount = originRecord?.cookies?.filter(cookie => cookie.expiresAt
      && Date.parse(cookie.expiresAt) <= now).length ?? 0;
    return {
      available: true,
      provider: this.provider,
      persistent: this.provider === 'Windows DPAPI CurrentUser',
      scopes: [GROK_WEB_ORIGIN],
      capturedAt: session.capturedAt,
      ageSeconds: Math.max(0, Math.floor((now - Date.parse(session.capturedAt)) / 1000)),
      cookieCount: originRecord?.cookies?.length ?? 0,
      headerCount: originRecord?.headers?.length ?? 0,
      expiredCookieCount,
      ownerVerified: session.ownerBinding?.generation === session.generation,
      ownerVerificationSource: session.ownerBinding?.generation === session.generation ? 'direct_http_identity_read' : null,
    };
  }

  async verifiedOwnerIdentityDigest() {
    const session = await this.load();
    return session.ownerBinding?.generation === session.generation
      && typeof session.ownerBinding.identityDigest === 'string'
      && /^[a-f0-9]{64}$/.test(session.ownerBinding.identityDigest)
      ? session.ownerBinding.identityDigest
      : null;
  }

  async clear() {
    return this.#mutate(() => this.#store.clear());
  }

  async bindVerifiedOwner(token, { operationId, httpStatus, identityMatched, identityDigest, expectedGeneration } = {}) {
    if (!this.#ownerBindingToken || token !== this.#ownerBindingToken) throw fail('OWNER_BINDING_NOT_AUTHORIZED');
    if (typeof operationId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(operationId)
      || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 299 || identityMatched !== true
      || typeof identityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(identityDigest)) throw fail('OWNER_IDENTITY_PROOF_INVALID');
    return this.#mutate(async () => {
      const state = await this.#store.read();
      if (!state?.session || state.kind !== 'grok-session') throw fail('SESSION_NOT_AVAILABLE');
      if (expectedGeneration !== undefined && state.session.generation !== expectedGeneration) throw fail('SESSION_REFRESH_CONCURRENT_CHANGE');
      state.session.ownerBinding = {
        generation: state.session.generation,
        identityDigest,
        operationId,
        verifiedAt: new Date().toISOString(),
      };
      await this.#store.write(state);
      return { ownerVerified: true, source: 'direct_http_identity_read', identityValueEchoed: false };
    });
  }

  async rotateCookies(origin, names, setCookieHeaders, { now = Date.now() } = {}) {
    if (safeHttpsOrigin(origin) !== GROK_WEB_ORIGIN || !Array.isArray(names) || !Array.isArray(setCookieHeaders)) {
      throw fail('COOKIE_ROTATION_SCOPE');
    }
    const allowedNames = new Set(names);
    if ([...allowedNames].some(name => typeof name !== 'string' || !COOKIE_NAME_PATTERN.test(name))) throw fail('COOKIE_ROTATION_CONTRACT_INVALID');
    return this.#mutate(async () => {
      const state = await this.#store.read();
      if (!state?.session || state.kind !== 'grok-session') throw fail('SESSION_NOT_AVAILABLE');
      const record = state.session.origins.find(item => item.origin === GROK_WEB_ORIGIN);
      if (!record) throw fail('SESSION_SCOPE_INVALID');
      let changed = false;
      for (const line of setCookieHeaders) {
        if (typeof line !== 'string' || line.length > 16_384 || /[\r\n\0]/.test(line)) continue;
        const parts = line.split(';').map(part => part.trim());
        const first = parts.shift() ?? '';
        const equals = first.indexOf('=');
        if (equals <= 0) continue;
        const name = first.slice(0, equals).trim();
        const value = first.slice(equals + 1);
        if (!allowedNames.has(name)) continue;
        const attrs = new Map();
        for (const part of parts) {
          const at = part.indexOf('=');
          const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
          const attrValue = at < 0 ? true : part.slice(at + 1).trim();
          attrs.set(key, attrValue);
        }
        const host = new URL(GROK_WEB_ORIGIN).hostname;
        const domain = typeof attrs.get('domain') === 'string' ? attrs.get('domain').toLowerCase() : host;
        if (!domainMatchesHost(domain, host)) continue;
        const cookiePath = typeof attrs.get('path') === 'string' && attrs.get('path').startsWith('/') ? attrs.get('path') : '/';
        const normalizedDomain = domain.replace(/^\./, '');
        const currentIndex = record.cookies.findIndex(item => item.name === name
          && item.domain.replace(/^\./, '').toLowerCase() === normalizedDomain && item.path === cookiePath);
        const maxAge = typeof attrs.get('max-age') === 'string' && /^-?\d+$/.test(attrs.get('max-age'))
          ? Number(attrs.get('max-age')) : null;
        const validMaxAge = Number.isSafeInteger(maxAge);
        let expiresAt = typeof attrs.get('expires') === 'string' ? new Date(attrs.get('expires')) : null;
        if (validMaxAge) expiresAt = new Date(now + maxAge * 1000);
        const expiredByAge = validMaxAge && maxAge <= 0;
        const expiredByDate = expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= now;
        if (expiredByAge || expiredByDate || !value) {
          if (currentIndex >= 0) { record.cookies.splice(currentIndex, 1); changed = true; }
          continue;
        }
        if (/[\r\n\0;]/.test(value) || value.length > MAX_CREDENTIAL_VALUE_LENGTH) continue;
        const cookie = {
          name,
          value,
          origin: GROK_WEB_ORIGIN,
          domain: normalizedDomain,
          path: cookiePath,
          secure: attrs.has('secure'),
          httpOnly: attrs.has('httponly'),
          expiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null,
        };
        if (currentIndex >= 0) {
          const old = record.cookies[currentIndex];
          if (old.value !== cookie.value || old.expiresAt !== cookie.expiresAt
            || old.secure !== cookie.secure || old.httpOnly !== cookie.httpOnly || old.domain !== cookie.domain) {
            record.cookies[currentIndex] = cookie;
            changed = true;
          }
        } else {
          record.cookies.push(cookie);
          changed = true;
        }
      }
      if (changed) {
        state.session.ownerBinding = null;
        await this.#store.write(state);
      }
      return { changed, ownerBindingCleared: changed };
    });
  }
}

export function boundCredentials(session, origin, path, { cookieNames = [], headerNames = [] } = {}) {
  const normalized = safeHttpsOrigin(origin);
  if (normalized !== GROK_WEB_ORIGIN) throw fail('SESSION_CREDENTIAL_SCOPE');
  const record = session.origins.find(item => item.origin === normalized);
  if (!record) throw fail('SESSION_CREDENTIAL_SCOPE');
  const host = new URL(normalized).hostname;
  const now = Date.now();
  const cookies = [];
  for (const name of cookieNames) {
    const scoped = record.cookies.filter(cookie => cookie.name === name && domainMatchesHost(cookie.domain, host)
      && (path === cookie.path || path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)));
    const matches = scoped.filter(cookie => !cookie.expiresAt || Date.parse(cookie.expiresAt) > now);
    matches.sort((a, b) => b.path.length - a.path.length);
    if (!matches.length) throw fail(scoped.length ? 'SESSION_EXPIRED' : 'SESSION_COOKIE_MISSING');
    cookies.push(`${name}=${matches[0].value}`);
  }
  const headers = {};
  for (const name of headerNames) {
    const match = record.headers.find(header => header.name.toLowerCase() === name.toLowerCase());
    if (!match) throw fail('SESSION_HEADER_MISSING');
    headers[match.name] = match.value;
  }
  return { cookieHeader: cookies.join('; '), headers };
}
