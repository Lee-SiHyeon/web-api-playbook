import path from 'node:path';
import { ProtectedStore } from '../protected-store.mjs';
import { ScopedSession } from '../scoped-session.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WebAuthError } from './myrealtrip.mjs';

const API = 'https://api.linkprice.com';
const WEB = 'https://ac.linkprice.net';
const LOGIN = 'linkprice-login';
const STATE = 'linkprice-state';
const PENDING = 'linkprice-pending';
const reject = (code, receipt) => { throw new WebAuthError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\s\x00-\x1f\x7f]/.test(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 320 && !/[\x00-\x20\x7f]/.test(value);

// JWT exp is only a scheduling hint. Protected owner read is the authentication proof.
function expiryHint(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(body.exp) || body.exp < 0 || body.exp > 8640000000000) return null;
    return new Date(body.exp * 1000).toISOString();
  } catch { return null; }
}

export function createLinkpriceAuth({ store = new ProtectedStore(), fetchImpl = fetch, now = Date.now } = {}) {
  const locked = callback => withSessionLock(callback, { root: path.join(store.directory, 'locks'), key: STATE });
  const save = (name, value) => store.write(name, JSON.stringify(value));
  function read(name) {
    const raw = store.read(name);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { reject('AUTH_STATE_INVALID'); }
  }
  function credentials() {
    const input = read(LOGIN);
    if (input?.version !== 1 || !identifier(input.username) || typeof input.password !== 'string' ||
        !input.password || input.password.length > 4096 || /[\0\r\n]/.test(input.password)) reject('LOGIN_INPUT_MISSING');
    return input;
  }
  function freshSession() {
    return new ScopedSession({
      allowedOrigins: [API], cookieOrigins: [API], fetchImpl,
      defaultHeaders: { accept: 'application/json' },
      headersByOrigin: { [API]: { origin: WEB, referer: WEB + '/', 'content-type': 'application/json' } },
      timeoutMs: 15000, maxResponseBytes: 1024 * 1024, maxRedirects: 0,
    });
  }
  function loadState() {
    const state = read(STATE);
    if (!state) return null;
    if (state.version !== 1 || !identifier(state.username) ||
        JSON.stringify(state.session?.allowedOrigins) !== JSON.stringify([API]) ||
        JSON.stringify(state.session?.cookieOrigins) !== JSON.stringify([API]) ||
        typeof state.session?.headersByOrigin?.[API]?.authorization !== 'string' ||
        !state.session.headersByOrigin[API].authorization.startsWith('Bearer ') ||
        !secret(state.session.headersByOrigin[API]['x-csrf-token'])) reject('AUTH_STATE_INVALID');
    return { state, session: ScopedSession.fromJSON(state.session, { fetchImpl }) };
  }
  function saveState(state, session) {
    save(STATE, { ...state, session: session.toJSON(), updatedAt: new Date(now()).toISOString() });
  }
  async function request(session, route, body, { login = false } = {}) {
    let result;
    try {
      result = await session.request(API + route, { method: 'PUT', body: JSON.stringify(body) });
    } catch (error) {
      reject(login ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_TRANSPORT_FAILED', {
        phase: login ? 'login' : 'read',
        causeCode: /^SCOPED_SESSION_[A-Z_]+$/.test(error.code || '') ? error.code : 'TRANSPORT_ERROR',
      });
    }
    if (result.status === 401) reject('REAUTH_REQUIRED');
    if (result.status === 403) reject('AUTH_FORBIDDEN');
    if (result.status === 429) reject('AUTH_THROTTLED');
    // Observed API returns JSON with text/html; JSON parsing and exact schemas remain mandatory.
    const mime = result.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (result.status !== 200 || !['application/json', 'text/html'].includes(mime)) {
      reject(login ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID', { httpStatus: result.status });
    }
    let data;
    try { data = JSON.parse(result.raw); } catch { reject(login ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID'); }
    return { data, receipt: { method: 'PUT', origin: API, path: route, httpStatus: result.status, mime,
      checkedAt: new Date(now()).toISOString(), browserUsed: false } };
  }
  async function owner(session, state) {
    // The unprojected web response also has sensitive personal fields. Never fetch those here.
    const { data, receipt } = await request(session, '/svc/query', {
      orm_key: 'dc_lpop/taccount/v1/GetAccount', input: { acc_id: state.username }, columns: ['account_id'],
    });
    if (!object(data) || typeof data.account_id !== 'string' || Object.keys(data).length !== 1) reject('OWNER_SCHEMA_INVALID');
    if (data.account_id !== state.username) reject('OWNER_MISMATCH');
    return { authenticated: true, ownerVerified: true, browserUsed: false,
      receipt: { ...receipt, operation: 'account', fieldsReturned: ['account_id'] } };
  }
  async function loginInternal(reason = 'explicit_login') {
    if (read(PENDING)?.phase === 'login_outcome_unknown') reject('AUTH_OUTCOME_UNKNOWN');
    const input = credentials();
    let session = freshSession();
    save(PENDING, { version: 1, phase: 'login_outcome_unknown', startedAt: new Date(now()).toISOString() });
    let response;
    try {
      response = await request(session, '/svc/login', { dom: 'AC', id: input.username, pw: input.password }, { login: true });
      if (response.data?.success === false) reject('LOGIN_REJECTED');
      if (response.data?.success !== true || !secret(response.data.token) || !secret(response.data.csrf)) reject('AUTH_RESPONSE_INVALID');
    } catch (error) {
      if (['REAUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_THROTTLED', 'LOGIN_REJECTED'].includes(error.code)) {
        save(PENDING, { version: 1, phase: 'rejected', code: error.code });
      } else {
        save(PENDING, { ...read(PENDING), code: error instanceof WebAuthError ? error.code : 'AUTH_OUTCOME_UNKNOWN',
          ...(error instanceof WebAuthError && error.receipt ? { receipt: error.receipt } : {}) });
      }
      throw error;
    } finally { input.password = ''; }
    const transport = session.toJSON();
    transport.headersByOrigin[API].authorization = 'Bearer ' + response.data.token;
    transport.headersByOrigin[API]['x-csrf-token'] = response.data.csrf;
    session = ScopedSession.fromJSON(transport, { fetchImpl });
    const state = { version: 1, username: input.username, verified: false, expiresAt: expiryHint(response.data.token) };
    saveState(state, session);
    save(PENDING, { version: 1, phase: 'owner_verification_pending' });
    const checked = await owner(session, state);
    state.verified = true;
    saveState(state, session);
    save(PENDING, { version: 1, phase: 'complete' });
    return { state, session, receipt: { ...checked, stored: true, renewal: 'password_login', reason,
      loginReceipt: { ...response.receipt, applicationSuccess: true }, expiresAt: state.expiresAt } };
  }
  async function ensureInternal() {
    const loaded = loadState();
    if (!loaded) return loginInternal('session_missing');
    const { state, session } = loaded;
    const input = credentials();
    input.password = '';
    if (state.username !== input.username) return loginInternal('configured_account_changed');
    const expiry = state.expiresAt ? Date.parse(state.expiresAt) : NaN;
    if (Number.isFinite(expiry) && expiry <= now() + 30000) return loginInternal('expiry_hint');
    try {
      const checked = await owner(session, state);
      state.verified = true;
      if (read(PENDING)?.phase === 'owner_verification_pending') save(PENDING, { version: 1, phase: 'complete' });
      return { state, session, receipt: { ...checked, renewal: 'stored_session', expiresAt: state.expiresAt } };
    } catch (error) {
      if (error.code !== 'REAUTH_REQUIRED') throw error;
    } finally { saveState(state, session); }
    return loginInternal('server_rejected_session');
  }
  async function sitesInternal(session, state) {
    const { data, receipt } = await request(session, '/svc/query', {
      orm_key: 'dc_lpop/taffiliate/v1/GetAffiliates', input: { account_id: state.username },
      columns: ['affiliate_id', 'site_url'],
    });
    // The observed single-site response is an object, not a one-element array.
    const rows = Array.isArray(data) ? data : object(data) ? [data] : null;
    if (!rows || rows.some(row => !object(row) || typeof row.affiliate_id !== 'string' || typeof row.site_url !== 'string')) {
      reject('SITES_SCHEMA_INVALID');
    }
    return { authenticated: true, ownerVerified: true, browserUsed: false,
      sites: rows.map(row => ({ affiliateId: row.affiliate_id, siteUrl: row.site_url })),
      receipt: { ...receipt, operation: 'sites', recordCount: rows.length, responseShape: Array.isArray(data) ? 'array' : 'object' } };
  }
  return {
    status: () => ({ service: 'linkprice', loginStored: store.status(LOGIN).available,
      sessionStored: store.status(STATE).available, currentAuthentication: 'not_checked',
      passwordLoginImplemented: true, renewalMode: 'password_login' }),
    importTokens: input => locked(async () => {
      if (!secret(input?.token) || !secret(input?.csrf)) reject('AUTH_IMPORT_INVALID');
      const configured = credentials();
      configured.password = '';
      const transport = freshSession().toJSON();
      transport.headersByOrigin[API].authorization = 'Bearer ' + input.token;
      transport.headersByOrigin[API]['x-csrf-token'] = input.csrf;
      const session = ScopedSession.fromJSON(transport, { fetchImpl });
      const state = { version: 1, username: configured.username, verified: true, expiresAt: expiryHint(input.token) };
      const checked = await owner(session, state);
      const pending = read(PENDING);
      saveState(state, session);
      save(PENDING, { version: 1, phase: 'complete', ...(pending?.phase === 'login_outcome_unknown'
        ? { previousAttempt: pending, reconciledBy: 'protected_owner_read_with_imported_session' } : {}) });
      return { ...checked, stored: true, renewal: 'verified_token_import' };
    }),
    login: () => locked(async () => (await loginInternal()).receipt),
    renew: () => locked(async () => (await loginInternal('explicit_renewal')).receipt),
    ensure: () => locked(async () => (await ensureInternal()).receipt),
    health: () => locked(async () => {
      const loaded = loadState();
      if (!loaded) reject('SESSION_MISSING');
      try { return await owner(loaded.session, loaded.state); }
      finally { saveState(loaded.state, loaded.session); }
    }),
    sites: () => locked(async () => {
      const { state, session } = await ensureInternal();
      try { return await sitesInternal(session, state); }
      finally { saveState(state, session); }
    }),
  };
}
