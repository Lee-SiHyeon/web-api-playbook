import fs from 'node:fs/promises';
import { SOCIAL_REQUEST_TIMEOUTS } from './request-timeouts.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../../affiliate-api-hub/adapters/web-auth-provider.mjs';

export const TIKTOK_ORIGIN = 'https://www.tiktok.com';
export const TIKTOK_STORE_NAME = 'tiktok-auth-state-v1';
export const TIKTOK_OWNER_HANDLE = 'lifehack__aibal';
const REQUIRED_SESSION_COOKIES = ['sessionid', 'sessionid_ss'];
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
  return error;
}

function validateStoredState(state, ScopedSession) {
  if (!state || state.version !== 1 || state.ownerHandle !== TIKTOK_OWNER_HANDLE
    || state.origin !== TIKTOK_ORIGIN || !state.session) throw fail('TIKTOK_AUTH_STATE_INVALID');
  let session;
  try { session = ScopedSession.fromJSON(state.session, { timeoutMs: SOCIAL_REQUEST_TIMEOUTS.write }); }
  catch { throw fail('TIKTOK_AUTH_STATE_INVALID'); }
  const bundle = session.toJSON();
  if (JSON.stringify(bundle.allowedOrigins) !== JSON.stringify([TIKTOK_ORIGIN])
    || JSON.stringify(bundle.cookieOrigins) !== JSON.stringify([TIKTOK_ORIGIN])) {
    throw fail('TIKTOK_AUTH_STATE_SCOPE_INVALID');
  }
  const names = new Set((bundle.cookieJar?.cookies || []).map(cookie => cookie.key));
  if (!REQUIRED_SESSION_COOKIES.every(name => names.has(name))) throw fail('TIKTOK_AUTH_COOKIES_MISSING');
  return session;
}

export async function persistTikTokSessionFromCookies(inputCookies) {
  if (!Array.isArray(inputCookies) || inputCookies.length > 200) throw fail('TIKTOK_COOKIE_INPUT_INVALID');
  const cookies = inputCookies.filter(cookie => {
    const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
    return (domain === 'tiktok.com' || domain === 'www.tiktok.com')
      && COOKIE_NAME.test(cookie?.name || '') && COOKIE_VALUE.test(cookie?.value || '');
  });
  if (!REQUIRED_SESSION_COOKIES.every(name => cookies.some(cookie => cookie?.name === name && cookie?.value))) {
    throw fail('TIKTOK_AUTH_COOKIES_MISSING');
  }
  const { ProtectedStore, ScopedSession } = await runtime();
  const session = new ScopedSession({
    allowedOrigins: [TIKTOK_ORIGIN],
    cookieOrigins: [TIKTOK_ORIGIN],
    cookies,
    defaultHeaders: { accept: 'application/json, text/plain, */*' },
    timeoutMs: SOCIAL_REQUEST_TIMEOUTS.write,
    maxResponseBytes: 4 * 1024 * 1024,
    maxRedirects: 0,
  });
  const state = {
    version: 1,
    ownerHandle: TIKTOK_OWNER_HANDLE,
    origin: TIKTOK_ORIGIN,
    provider: 'authorized_chrome_one_time_handoff',
    capturedAt: new Date().toISOString(),
    session: session.toJSON(),
  };
  const store = new ProtectedStore();
  const receipt = store.write(TIKTOK_STORE_NAME, JSON.stringify(state));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') throw fail('TIKTOK_DPAPI_REQUIRED');
  const readback = store.read(TIKTOK_STORE_NAME);
  if (!readback) throw fail('TIKTOK_DPAPI_READBACK_FAILED');
  let restoredState;
  try { restoredState = JSON.parse(readback); } catch { throw fail('TIKTOK_DPAPI_READBACK_FAILED'); }
  validateStoredState(restoredState, ScopedSession);
  return {
    stored: true,
    persistent: true,
    provider: receipt.provider,
    ownerHandle: TIKTOK_OWNER_HANDLE,
    originCount: 1,
    cookieCount: cookies.length,
    authCookiePresence: true,
    tokenValuesRecorded: false,
  };
}

export async function captureTikTokSessionFromChrome({
  env = process.env,
  connect = async (endpoint, options) => {
    const { chromium } = await import('playwright');
    return chromium.connectOverCDP(endpoint, options);
  },
} = {}) {
  if (!env.LOCALAPPDATA) throw fail('TIKTOK_CDP_PROFILE_UNAVAILABLE');
  const portFile = path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
  let lines;
  try { lines = (await fs.readFile(portFile, 'utf8')).trim().split(/\r?\n/); }
  catch { throw fail('TIKTOK_CDP_ENDPOINT_MISSING'); }
  const [port, socketPath] = lines;
  if (port !== '9222' || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(socketPath || '')) {
    throw fail('TIKTOK_CDP_SCOPE_INVALID');
  }

  let browser;
  try {
    browser = await connect(`ws://127.0.0.1:9222${socketPath}`, { timeout: 15_000, noDefaults: true });
    const contexts = browser.contexts().filter(context => context.pages().some(page => {
      try { return new URL(page.url()).origin === TIKTOK_ORIGIN; } catch { return false; }
    }));
    if (contexts.length !== 1) throw fail('TIKTOK_CDP_CONTEXT_AMBIGUOUS');
    const cookies = (await contexts[0].cookies([TIKTOK_ORIGIN])).filter(cookie => {
      const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
      return (domain === 'tiktok.com' || domain.endsWith('.tiktok.com'))
        && (cookie.expires === -1 || cookie.expires > Date.now() / 1000);
    });
    if (!REQUIRED_SESSION_COOKIES.every(name => cookies.some(cookie => cookie.name === name && cookie.value))) {
      throw fail('TIKTOK_AUTH_COOKIES_MISSING');
    }
    return { ...(await persistTikTokSessionFromCookies(cookies)), browserUsedForHandoff: true };
  } catch (error) {
    if (error?.code?.startsWith('TIKTOK_')) throw error;
    throw fail(error?.name === 'TimeoutError' ? 'TIKTOK_CDP_TIMEOUT' : 'TIKTOK_CDP_CONNECTION_FAILED');
  } finally {
    if (browser) {
      try { await browser.close(); }
      catch { throw fail('TIKTOK_CDP_DISCONNECT_FAILED'); }
    }
  }
}

export async function loadTikTokSession() {
  const { ProtectedStore, ScopedSession } = await runtime();
  const store = new ProtectedStore();
  const raw = store.read(TIKTOK_STORE_NAME);
  if (!raw) throw fail('TIKTOK_REAUTH_REQUIRED');
  let state;
  try { state = JSON.parse(raw); } catch { throw fail('TIKTOK_AUTH_STATE_INVALID'); }
  const session = validateStoredState(state, ScopedSession);
  return {
    session,
    ownerHandle: TIKTOK_OWNER_HANDLE,
    provider: 'windows_dpapi_current_user',
    persistent: true,
    capturedAt: state.capturedAt,
  };
}

export async function storeTikTokSessionState(session) {
  const { ProtectedStore, ScopedSession } = await runtime();
  let bundle;
  try { bundle = session.toJSON(); } catch { throw fail('TIKTOK_AUTH_STATE_INVALID'); }
  const store = new ProtectedStore();
  const raw = store.read(TIKTOK_STORE_NAME);
  if (!raw) throw fail('TIKTOK_REAUTH_REQUIRED');
  let state;
  try { state = JSON.parse(raw); } catch { throw fail('TIKTOK_AUTH_STATE_INVALID'); }
  validateStoredState({ ...state, session: bundle }, ScopedSession);
  const receipt = store.write(TIKTOK_STORE_NAME, JSON.stringify({ ...state, session: bundle, updatedAt: new Date().toISOString() }));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') throw fail('TIKTOK_DPAPI_REQUIRED');
  return { persistent: true, provider: receipt.provider };
}

export async function tiktokSessionStatus() {
  const { ProtectedStore, ScopedSession } = await runtime();
  const store = new ProtectedStore();
  const availability = store.status(TIKTOK_STORE_NAME);
  if (!availability.available) return { available: false, persistent: availability.persistent, provider: availability.provider };
  const raw = store.read(TIKTOK_STORE_NAME);
  let state;
  try { state = JSON.parse(raw); } catch { throw fail('TIKTOK_AUTH_STATE_INVALID'); }
  validateStoredState(state, ScopedSession);
  return {
    available: true,
    persistent: true,
    provider: 'Windows DPAPI CurrentUser',
    ownerHandle: TIKTOK_OWNER_HANDLE,
    allowedOrigins: [TIKTOK_ORIGIN],
    capturedAt: state.capturedAt,
    authCookiesPresent: true,
  };
}
