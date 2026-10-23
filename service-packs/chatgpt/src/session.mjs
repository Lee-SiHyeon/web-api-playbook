import { ChatGPTWebError } from './errors.mjs';
import { PRIMARY_ORIGIN } from './contracts.mjs';
import { credentialExists, credentialStoreReady, readCredential, writeCredential } from './secure-credential-store.mjs';

export const CREDENTIAL_NAME = 'chatgpt-web-session-v1';
export const MAX_COOKIE_COUNT = 100;
export const MAX_COOKIE_VALUE = 8192;
const COOKIE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/;
const CHALLENGE_COOKIE = /(?:^|[_-])(?:cf[_-]?clearance|cf[_-]?chl|__?cf[_-]?bm|ak[_-]?bmsc|bm[_-]?sv|bm[_-]?sz|_abck|captcha|challenge|turnstile)(?:$|[_-])/i;

function fail(code) {
  throw new ChatGPTWebError(code);
}

function cookieApplies(cookie, url, nowSeconds) {
  const host = url.hostname.toLowerCase();
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  if (domain !== host || (cookie.secure === true && url.protocol !== 'https:')) return false;
  if (Number.isFinite(cookie.expires) && cookie.expires > 0 && cookie.expires <= nowSeconds) return false;
  const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  if (!url.pathname.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return url.pathname.length === cookiePath.length || url.pathname[cookiePath.length] === '/';
}

export function validateSessionBundle(bundle, { now = Date.now(), maxAgeMs = 5 * 60_000 } = {}) {
  if (!bundle || typeof bundle !== 'object' || bundle.version !== 1 || bundle.service !== 'chatgpt-web'
    || bundle.origin !== PRIMARY_ORIGIN || typeof bundle.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(bundle.capturedAt)) || !Array.isArray(bundle.cookies)
    || bundle.cookies.length < 1 || bundle.cookies.length > MAX_COOKIE_COUNT) fail('SESSION_BUNDLE_INVALID');
  const capturedAt = Date.parse(bundle.capturedAt);
  if (capturedAt > now + 10_000 || now - capturedAt > maxAgeMs) fail('SESSION_HANDOFF_STALE');
  const seen = new Set();
  const cookies = bundle.cookies.map((cookie) => {
    if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || !COOKIE_NAME.test(cookie.name)
      || typeof cookie.value !== 'string' || !cookie.value || cookie.value.length > MAX_COOKIE_VALUE
      || /[;\r\n\0]/.test(cookie.value) || typeof cookie.domain !== 'string'
      || !['chatgpt.com', '.chatgpt.com'].includes(cookie.domain.toLowerCase())
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || /[\r\n\0;]/.test(cookie.path)) {
      fail('SESSION_COOKIE_INVALID');
    }
    if (CHALLENGE_COOKIE.test(cookie.name)) fail('SESSION_CHALLENGE_COOKIE_REJECTED');
    if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') fail('SESSION_COOKIE_INVALID');
    if (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean') fail('SESSION_COOKIE_INVALID');
    if (cookie.expires !== undefined && (!Number.isFinite(cookie.expires) || cookie.expires < 0)) fail('SESSION_COOKIE_INVALID');
    if (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None', 'Unspecified'].includes(cookie.sameSite)) fail('SESSION_COOKIE_INVALID');
    const key = `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
    if (seen.has(key)) fail('SESSION_COOKIE_DUPLICATE');
    seen.add(key);
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
    };
  });
  return { version: 1, service: 'chatgpt-web', origin: PRIMARY_ORIGIN,
    capturedAt: new Date(capturedAt).toISOString(), cookies };
}

export class ChatGPTSessionProvider {
  constructor({ store = { credentialExists, readCredential, writeCredential, credentialStoreReady }, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.bundle = null;
  }

  async saveObserved(bundle) {
    const valid = validateSessionBundle(bundle, { now: this.now() });
    const serialized = JSON.stringify(valid);
    if (Buffer.byteLength(serialized, 'utf8') > 131_072) fail('SESSION_BUNDLE_TOO_LARGE');
    const stored = await this.store.writeCredential(CREDENTIAL_NAME, serialized);
    this.bundle = valid;
    return { stored: stored?.stored === true, origin: PRIMARY_ORIGIN, cookieCount: valid.cookies.length,
      capturedAt: valid.capturedAt, provider: 'Windows DPAPI CurrentUser' };
  }

  async load() {
    if (this.bundle) return this.bundle;
    const raw = await this.store.readCredential(CREDENTIAL_NAME);
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('SESSION_STORE_INVALID'); }
    this.bundle = validateSessionBundle(parsed, { now: this.now(), maxAgeMs: Number.POSITIVE_INFINITY });
    return this.bundle;
  }

  async cookieHeaderFor(target) {
    const url = target instanceof URL ? target : new URL(target);
    if (url.protocol !== 'https:' || url.origin !== PRIMARY_ORIGIN) fail('SESSION_ORIGIN_REJECTED');
    const bundle = await this.load();
    if (!bundle) fail('SESSION_REQUIRED');
    const nowSeconds = Math.floor(this.now() / 1000);
    const applicable = bundle.cookies.filter((cookie) => cookieApplies(cookie, url, nowSeconds));
    if (!applicable.length) fail('SESSION_COOKIES_NOT_APPLICABLE');
    return applicable.map(({ name, value }) => `${name}=${value}`).join('; ');
  }

  async status() {
    const ready = await this.store.credentialStoreReady();
    const present = ready ? await this.store.credentialExists(CREDENTIAL_NAME) : false;
    return { providerReady: ready, credentialPresent: present, authenticated: false,
      verification: 'not_checked', origin: PRIMARY_ORIGIN };
  }
}

export function sessionProviderReady() {
  return credentialStoreReady();
}
