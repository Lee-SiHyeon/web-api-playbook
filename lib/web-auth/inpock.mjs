import path from 'node:path';
import { ProtectedStore } from '../protected-store.mjs';
import { ScopedSession } from '../scoped-session.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WebAuthError } from './myrealtrip.mjs';

const API = 'https://link-rest.inpock.co.kr';
const WEB = 'https://link.inpock.co.kr';
const LOGIN = 'inpock-login', STATE = 'inpock-state';
const fail = (code, receipt) => { throw new WebAuthError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const username = value => typeof value === 'string' && value.length > 0 && value.length <= 320 && !/[\x00-\x20\x7f]/.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{1,16384}$/.test(value);

export function validateInpockLogin(input) {
  if (!object(input) || !username(input.username) || typeof input.password !== 'string' ||
      !input.password || input.password.length > 4096 || /[\0\r\n]/.test(input.password) ||
      Object.keys(input).some(key => !['username', 'password'].includes(key))) fail('LOGIN_INPUT_INVALID');
  return { version: 1, username: input.username, password: input.password };
}

// Observed 2026-10-04: multipart username/password -> 201 {username,token};
// the web app uses that token in a cookie for GET /v2/users. No browser state is imported.
export function createInpockAuth({ store = new ProtectedStore(), fetchImpl = fetch, now = Date.now } = {}) {
  const locked = callback => withSessionLock(callback, { root: path.join(store.directory, 'locks'), key: STATE });
  const save = (name, value) => store.write(name, JSON.stringify(value));
  const read = name => {
    const raw = store.read(name);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { fail('AUTH_STATE_INVALID'); }
  };
  function credentials() {
    const input = read(LOGIN);
    if (!input || input.version !== 1) fail('LOGIN_INPUT_MISSING');
    return validateInpockLogin({ username: input.username, password: input.password });
  }
  function freshSession(cookies = []) {
    return new ScopedSession({
      allowedOrigins: [API], cookieOrigins: [API], cookies, fetchImpl,
      defaultHeaders: { accept: 'application/json' },
      headersByOrigin: { [API]: { origin: WEB, referer: WEB + '/' } },
      timeoutMs: 15000, maxRequestBytes: 32768, maxResponseBytes: 1024 * 1024, maxRedirects: 0,
    });
  }
  function loadState() {
    const state = read(STATE);
    if (!state) return null;
    const transport = state.session;
    if (state.version !== 1 || !username(state.username) || !Number.isSafeInteger(state.ownerId) || state.ownerId <= 0 ||
        JSON.stringify(transport?.allowedOrigins) !== JSON.stringify([API]) ||
        JSON.stringify(transport?.cookieOrigins) !== JSON.stringify([API]) || transport.allowLoopbackHttp !== false ||
        JSON.stringify(transport?.defaultHeaders) !== JSON.stringify({ accept: 'application/json' }) ||
        JSON.stringify(transport?.headersByOrigin) !== JSON.stringify({ [API]: { origin: WEB, referer: WEB + '/' } }) ||
        transport.maxRedirects !== 0 || transport.maxRequestBytes !== 32768 || transport.maxResponseBytes !== 1024 * 1024 ||
        transport.timeoutMs !== 15000) fail('AUTH_STATE_INVALID');
    let session;
    try { session = ScopedSession.fromJSON(transport, { fetchImpl }); } catch { fail('AUTH_STATE_INVALID'); }
    return { state, session };
  }
  function saveState(state, session) {
    save(STATE, { ...state, session: session.toJSON(), updatedAt: new Date(now()).toISOString() });
  }
  function requireToken(session) {
    const cookies = session.toJSON().cookieJar.cookies;
    const usable = cookies.filter(c => c.key === 'token' && c.path === '/' && c.secure === true && token(c.value) &&
      (c.expires === undefined || c.expires === 'Infinity' || Date.parse(c.expires) > now()));
    if (usable.length !== 1) fail('REAUTH_REQUIRED');
  }
  async function request(session, route, { method = 'GET', body, contentType, expectedStatus = 200 } = {}) {
    let response;
    try {
      response = await session.request(API + route, { method,
        ...(body === undefined ? {} : { body }), ...(contentType ? { headers: { 'content-type': contentType } } : {}) });
    } catch (error) {
      fail(method === 'POST' ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_TRANSPORT_FAILED', {
        phase: method === 'POST' ? 'login' : 'read',
        causeCode: /^SCOPED_SESSION_[A-Z_]+$/.test(error.code || '') ? error.code : 'TRANSPORT_ERROR',
      });
    }
    const mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
    const receipt = { method, origin: API, path: route, httpStatus: response.status, mime: mime ?? null,
      responseBytes: Buffer.byteLength(response.raw), checkedAt: new Date(now()).toISOString(), browserUsed: false };
    if (response.status === 401) fail(method === 'POST' ? 'LOGIN_REJECTED' : 'REAUTH_REQUIRED', receipt);
    if (response.status === 403) fail('AUTH_FORBIDDEN', receipt);
    if (response.status === 429) fail('AUTH_THROTTLED', receipt);
    if (response.status >= 500) fail('AUTH_SERVER_ERROR', receipt);
    if (response.status !== expectedStatus || mime !== 'application/json') fail('AUTH_RESPONSE_INVALID', receipt);
    let data;
    try { data = JSON.parse(response.raw); } catch { fail('AUTH_RESPONSE_INVALID', receipt); }
    return { data, receipt };
  }
  async function owner(session, state) {
    requireToken(session);
    const { data, receipt } = await request(session, '/v2/users');
    requireToken(session); // a response deleting the cookie invalidates even a 200 owner response
    if (!object(data) || !Number.isSafeInteger(data.id) || data.id <= 0 || !username(data.username)) fail('OWNER_SCHEMA_INVALID', receipt);
    if (data.username !== state.username || (state.ownerId != null && data.id !== state.ownerId)) fail('OWNER_MISMATCH', receipt);
    state.ownerId = data.id;
    return { authenticated: true, ownerVerified: true, browserUsed: false,
      user: { username: data.username, ...(typeof data.plan === 'string' ? { plan: data.plan } : {}) },
      receipt: { ...receipt, operation: 'owner', fieldsReturned: ['username', ...(typeof data.plan === 'string' ? ['plan'] : [])] } };
  }
  async function loginInternal(reason = 'explicit_login') {
    const input = credentials();
    const previous = loadState();
    const form = new FormData();
    form.set('username', input.username);
    form.set('password', input.password);
    // ScopedSession accepts bounded byte buffers, not streaming FormData.
    // Request serializes the exact observed multipart encoding without sending it.
    const encoded = new Request(API + '/login', { method: 'POST', body: form });
    const body = Buffer.from(await encoded.arrayBuffer());
    let result;
    try {
      result = await request(freshSession(), '/login', {
        method: 'POST', body, contentType: encoded.headers.get('content-type'), expectedStatus: 201,
      });
    } finally { body.fill(0); input.password = ''; form.set('password', ''); }
    if (!object(result.data) || !username(result.data.username) || !token(result.data.token)) fail('AUTH_RESPONSE_INVALID', result.receipt);
    if (result.data.username !== input.username) fail('OWNER_MISMATCH', result.receipt);
    const session = freshSession([{ url: API + '/', setCookie: `token=${result.data.token}; Path=/; Secure; HttpOnly; SameSite=Lax` }]);
    result.data.token = '';
    const state = { version: 1, username: input.username, verified: false, issuedAt: new Date(now()).toISOString(),
      ...(previous?.state.username === input.username ? { ownerId: previous.state.ownerId } : {}) };
    const checked = await owner(session, state);
    state.verified = true;
    saveState(state, session); // replace a previous trusted session only after the owner matches
    return { state, session, receipt: { ...checked, renewal: 'password_login', reason,
      loginReceipt: { ...result.receipt, applicationSuccess: true }, expiresAt: null } };
  }
  async function checkLoaded(loaded) {
    try {
      const receipt = await owner(loaded.session, loaded.state);
      loaded.state.verified = true;
      return receipt;
    } catch (error) { loaded.state.verified = false; throw error; }
    finally { saveState(loaded.state, loaded.session); }
  }
  async function ensureInternal() {
    const loaded = loadState();
    if (!loaded) return loginInternal('session_missing');
    const configured = read(LOGIN);
    if (configured && configured.username !== loaded.state.username) return loginInternal('configured_account_changed');
    try {
      const receipt = await checkLoaded(loaded);
      return { ...loaded, receipt: { ...receipt, renewal: 'stored_session', expiresAt: null } };
    } catch (error) {
      if (error.code !== 'REAUTH_REQUIRED') throw error;
    }
    // No refresh endpoint or token lifetime has been observed. One password login
    // is allowed only after an explicit authentication failure, never on an unknown 403.
    return loginInternal('server_rejected_session');
  }
  return {
    status: () => ({ service: 'inpock', login: store.status(LOGIN), session: store.status(STATE), authenticated: false }),
    importLogin: input => locked(() => {
      const receipt = save(LOGIN, validateInpockLogin(input));
      return { ...receipt, authenticated: false };
    }),
    login: () => locked(async () => (await loginInternal()).receipt),
    ensure: () => locked(async () => (await ensureInternal()).receipt),
    owner: () => locked(async () => (await ensureInternal()).receipt),
    health: () => locked(async () => {
      const loaded = loadState();
      if (!loaded) fail('SESSION_MISSING');
      const configured = read(LOGIN);
      if (configured && configured.username !== loaded.state.username) fail('CONFIGURED_OWNER_MISMATCH');
      return checkLoaded(loaded);
    }),
    withSession: callback => locked(async () => {
      if (typeof callback !== 'function') fail('AUTH_CALLBACK_INVALID');
      const { state, session, receipt } = await ensureInternal();
      try { return await callback(session, receipt, { id: state.ownerId, username: state.username }); }
      finally { saveState(state, session); }
    }),
  };
}
