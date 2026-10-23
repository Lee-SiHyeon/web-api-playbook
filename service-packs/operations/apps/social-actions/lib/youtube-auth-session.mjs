import path from 'node:path';
import { SOCIAL_REQUEST_TIMEOUTS } from './request-timeouts.mjs';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../../affiliate-api-hub/adapters/web-auth-provider.mjs';

export const YOUTUBE_ORIGINS = Object.freeze(['https://studio.youtube.com', 'https://www.youtube.com']);
export const YOUTUBE_STORE_NAME = 'youtube-auth-state-v1';
export const YOUTUBE_CHANNEL_ID = 'UCtLdZc1Ooz6KLbDNfo60E5A';
export const YOUTUBE_CURRENT_HANDLE = 'lifehack__ailab';
const AUTH_COOKIE_GROUPS = [['SAPISID', '__Secure-3PAPISID'], ['SID', '__Secure-3PSID']];
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

async function runtime() {
  const root = webApiPlaybookRoot();
  const [{ ProtectedStore }, { ScopedSession }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'lib', 'protected-store.mjs')).href),
    import(pathToFileURL(path.join(root, 'lib', 'scoped-session.mjs')).href),
  ]);
  return { ProtectedStore, ScopedSession };
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateState(state, ScopedSession) {
  if (!state || state.version !== 1 || state.channelId !== YOUTUBE_CHANNEL_ID || !state.session) {
    fail('YOUTUBE_AUTH_STATE_INVALID');
  }
  let session;
  try { session = ScopedSession.fromJSON(state.session, { timeoutMs: SOCIAL_REQUEST_TIMEOUTS.write }); } catch { fail('YOUTUBE_AUTH_STATE_INVALID'); }
  const bundle = session.toJSON();
  if (YOUTUBE_ORIGINS.some(origin => !bundle.allowedOrigins.includes(origin) || !bundle.cookieOrigins.includes(origin))
    || bundle.allowedOrigins.some(origin => !YOUTUBE_ORIGINS.includes(origin))) fail('YOUTUBE_AUTH_STATE_SCOPE_INVALID');
  const names = new Set((bundle.cookieJar?.cookies || []).map(cookie => cookie.key));
  if (!AUTH_COOKIE_GROUPS.every(group => group.some(name => names.has(name)))) fail('YOUTUBE_AUTH_COOKIES_MISSING');
  return session;
}

export async function persistYoutubeSessionFromCookies(inputCookies) {
  if (!Array.isArray(inputCookies) || inputCookies.length > 300) fail('YOUTUBE_COOKIE_INPUT_INVALID');
  const cookies = inputCookies.filter(cookie => {
    const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
    return ['youtube.com', 'www.youtube.com', 'studio.youtube.com'].includes(domain)
      && COOKIE_NAME.test(cookie?.name || '') && COOKIE_VALUE.test(cookie?.value || '');
  });
  const present = new Set(cookies.filter(cookie => cookie.value).map(cookie => cookie.name));
  if (!AUTH_COOKIE_GROUPS.every(group => group.some(name => present.has(name)))) fail('YOUTUBE_AUTH_COOKIES_MISSING');
  const { ProtectedStore, ScopedSession } = await runtime();
  const session = new ScopedSession({
    allowedOrigins: YOUTUBE_ORIGINS,
    cookieOrigins: YOUTUBE_ORIGINS,
    cookies,
    defaultHeaders: { accept: 'application/json, text/plain, */*' },
    timeoutMs: SOCIAL_REQUEST_TIMEOUTS.write,
    maxResponseBytes: 8 * 1024 * 1024,
    maxRedirects: 0,
  });
  const state = {
    version: 1,
    channelId: YOUTUBE_CHANNEL_ID,
    currentHandle: YOUTUBE_CURRENT_HANDLE,
    provider: 'authorized_chrome_one_time_handoff',
    capturedAt: new Date().toISOString(),
    session: session.toJSON(),
  };
  validateState(state, ScopedSession);
  const store = new ProtectedStore();
  const receipt = store.write(YOUTUBE_STORE_NAME, JSON.stringify(state));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') fail('YOUTUBE_DPAPI_REQUIRED');
  const saved = store.read(YOUTUBE_STORE_NAME);
  let reread;
  try { reread = JSON.parse(saved); } catch { fail('YOUTUBE_DPAPI_READBACK_FAILED'); }
  validateState(reread, ScopedSession);
  return {
    stored: true,
    persistent: true,
    provider: receipt.provider,
    channelId: YOUTUBE_CHANNEL_ID,
    allowedOrigins: YOUTUBE_ORIGINS,
    cookieCount: cookies.length,
    authCookiesPresent: true,
    tokenValuesRecorded: false,
  };
}

export async function loadYoutubeSession() {
  const { ProtectedStore, ScopedSession } = await runtime();
  const raw = new ProtectedStore().read(YOUTUBE_STORE_NAME);
  if (!raw) fail('YOUTUBE_REAUTH_REQUIRED');
  let state;
  try { state = JSON.parse(raw); } catch { fail('YOUTUBE_AUTH_STATE_INVALID'); }
  const session = validateState(state, ScopedSession);
  return {
    session,
    channelId: YOUTUBE_CHANNEL_ID,
    currentHandle: state.currentHandle,
    provider: 'windows_dpapi_current_user',
    persistent: true,
    capturedAt: state.capturedAt,
  };
}

export async function storeYoutubeSessionState(session) {
  const { ProtectedStore, ScopedSession } = await runtime();
  const store = new ProtectedStore();
  const raw = store.read(YOUTUBE_STORE_NAME);
  if (!raw) fail('YOUTUBE_REAUTH_REQUIRED');
  let state;
  try { state = JSON.parse(raw); } catch { fail('YOUTUBE_AUTH_STATE_INVALID'); }
  let bundle;
  try { bundle = session.toJSON(); } catch { fail('YOUTUBE_AUTH_STATE_INVALID'); }
  validateState({ ...state, session: bundle }, ScopedSession);
  const receipt = store.write(YOUTUBE_STORE_NAME, JSON.stringify({ ...state, session: bundle, updatedAt: new Date().toISOString() }));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') fail('YOUTUBE_DPAPI_REQUIRED');
  return { persistent: true, provider: receipt.provider };
}

export async function youtubeSessionStatus() {
  const { ProtectedStore, ScopedSession } = await runtime();
  const store = new ProtectedStore();
  const availability = store.status(YOUTUBE_STORE_NAME);
  if (!availability.available) return { available: false, persistent: availability.persistent, provider: availability.provider };
  const raw = store.read(YOUTUBE_STORE_NAME);
  let state;
  try { state = JSON.parse(raw); } catch { fail('YOUTUBE_AUTH_STATE_INVALID'); }
  validateState(state, ScopedSession);
  return {
    available: true,
    persistent: true,
    provider: 'Windows DPAPI CurrentUser',
    channelId: YOUTUBE_CHANNEL_ID,
    currentHandle: state.currentHandle,
    allowedOrigins: YOUTUBE_ORIGINS,
    capturedAt: state.capturedAt,
    authCookiesPresent: true,
  };
}
