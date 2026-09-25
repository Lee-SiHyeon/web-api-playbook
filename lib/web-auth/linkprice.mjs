import path from 'node:path';
import { ProtectedStore } from '../protected-store.mjs';
import { ScopedSession } from '../scoped-session.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WebAuthError } from './myrealtrip.mjs';

const API = 'https://api.linkprice.com';
const WEB = 'https://ac.linkprice.net';
const CLICK = 'https://click.linkprice.com/click.php';
const LOGIN = 'linkprice-login';
const STATE = 'linkprice-state';
const PENDING = 'linkprice-pending';
const reject = (code, receipt) => { throw new WebAuthError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\s\x00-\x1f\x7f]/.test(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 320 && !/[\x00-\x20\x7f]/.test(value);
const merchantId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
// Observed 2026-09-25: an expired or invalid Bearer gets HTTP 200 with {error_code, error_message:"Token is expired"}.
const AUTH_ERROR = /token|expired|unauthori[sz]ed|not\s+logged|login|jwt|csrf/i;

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

// /svc/query answers NDJSON (one JSON object per line, text/html MIME). One row is a single object.
export function parseLinkpriceBody(raw) {
  const lines = String(raw).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const values = lines.map(line => JSON.parse(line));
  return values.length === 1 ? values[0] : values;
}

// The web app builds tracking links client-side (getClickUrl in the ac.linkprice.net bundle); no API call.
export function linkpriceClickUrl({ merchantId: m, affiliateId, targetUrl, lCd1 = '3', lCd2 = '0' }) {
  if (!merchantId(m) || !/^A\d{6,12}$/.test(String(affiliateId || ''))) reject('LINK_INPUT_INVALID');
  let target;
  try { target = new URL(targetUrl); } catch { reject('LINK_TARGET_INVALID'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) reject('LINK_TARGET_INVALID');
  if (!/^\d{1,2}$/.test(String(lCd1)) || !/^\d{1,2}$/.test(String(lCd2))) reject('LINK_INPUT_INVALID');
  return `${CLICK}?m=${m}&a=${affiliateId}&l=9999&l_cd1=${lCd1}&l_cd2=${lCd2}&tu=${encodeURIComponent(target.href)}`;
}

const MERCHANT_FIELDS = ['merchant_id', 'site_name', 'site_url', 'site_short_desc', 'approval_type', 'return_day', 'cps_yn', 'cpa_yn',
  'pgm_std_end_date', 'category1_id', 'category2_id', 'cps_category_id', 'mobile_yn', 'lp_approval', 'hidden_flag', 'error_flag'];

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
      timeoutMs: 15000, maxResponseBytes: 4 * 1024 * 1024, maxRedirects: 0,
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
  function withToken(session, token, csrf) {
    const transport = session.toJSON();
    transport.headersByOrigin[API].authorization = 'Bearer ' + token;
    if (csrf) transport.headersByOrigin[API]['x-csrf-token'] = csrf;
    return ScopedSession.fromJSON(transport, { fetchImpl });
  }
  async function request(session, route, body, { login = false, emptyOnNoRows = false } = {}) {
    let result;
    try {
      result = await session.request(API + route, { method: 'PUT', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      reject(login ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_TRANSPORT_FAILED', {
        phase: login ? 'login' : 'read',
        causeCode: /^SCOPED_SESSION_[A-Z_]+$/.test(error.code || '') ? error.code : 'TRANSPORT_ERROR',
      });
    }
    if (result.status === 401) reject('REAUTH_REQUIRED');
    if (result.status === 403) reject('AUTH_FORBIDDEN');
    if (result.status === 429) reject('AUTH_THROTTLED');
    // Observed API returns JSON/NDJSON with text/html; parsing and exact schemas remain mandatory.
    const mime = result.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (result.status !== 200 || !['application/json', 'text/html'].includes(mime)) {
      reject(login ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID', { httpStatus: result.status });
    }
    let data;
    try { data = parseLinkpriceBody(result.raw); } catch { reject(login ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID'); }
    const receipt = { method: 'PUT', origin: API, path: route, httpStatus: result.status, mime,
      checkedAt: new Date(now()).toISOString(), browserUsed: false };
    // Application errors arrive as HTTP 200 bodies: {error_code, error_message} on /svc/query, {code, msg} on token routes.
    if (object(data) && (data.error_code != null || (route.startsWith('/svc/token/') && data.code != null && !secret(data.tkn)))) {
      const message = String(data.error_message ?? data.msg ?? '');
      if (message === 'ErrNoRows' && emptyOnNoRows) return { data: [], receipt: { ...receipt, noRows: true } };
      if (AUTH_ERROR.test(message)) reject('REAUTH_REQUIRED', { ...receipt, applicationErrorCode: Number(data.error_code ?? data.code) || null });
      reject('AUTH_APPLICATION_ERROR', { ...receipt, applicationErrorCode: Number(data.error_code ?? data.code) || null });
    }
    return { data, receipt };
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
    // Password login does not change account state, so an earlier ambiguous attempt is kept as evidence
    // and a fresh login is allowed instead of blocking every later run.
    const previous = read(PENDING);
    const input = credentials();
    let session = freshSession();
    save(PENDING, { version: 1, phase: 'login_outcome_unknown', startedAt: new Date(now()).toISOString(),
      ...(previous?.phase === 'login_outcome_unknown' ? { previousAttempt: { startedAt: previous.startedAt, code: previous.code ?? null } } : {}) });
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
    session = withToken(session, response.data.token, response.data.csrf);
    const state = { version: 1, username: input.username, verified: false, expiresAt: expiryHint(response.data.token),
      issuedAt: new Date(now()).toISOString() };
    saveState(state, session);
    save(PENDING, { version: 1, phase: 'owner_verification_pending' });
    const checked = await owner(session, state);
    state.verified = true;
    saveState(state, session);
    save(PENDING, { version: 1, phase: 'complete' });
    return { state, session, receipt: { ...checked, stored: true, renewal: 'password_login', reason,
      loginReceipt: { ...response.receipt, applicationSuccess: true }, expiresAt: state.expiresAt } };
  }
  // Observed in the web bundle: PUT /svc/token/refresh with the current Bearer returns {tkn}; the CSRF value is kept.
  // The server refuses refresh three months after the first issuance ({code,msg}); then password login takes over.
  async function refreshInternal(state, session) {
    const { data, receipt } = await request(session, '/svc/token/refresh', undefined);
    if (!object(data) || !secret(data.tkn)) reject('AUTH_RESPONSE_INVALID');
    const refreshed = withToken(session, data.tkn);
    const next = { ...state, verified: false, expiresAt: expiryHint(data.tkn) };
    saveState(next, refreshed);
    const checked = await owner(refreshed, next);
    next.verified = true;
    saveState(next, refreshed);
    return { state: next, session: refreshed, receipt: { ...checked, renewal: 'token_refresh', refreshReceipt: receipt, expiresAt: next.expiresAt } };
  }
  async function renewInternal(state, session, reason) {
    try { return await refreshInternal(state, session); }
    catch (error) {
      if (!['REAUTH_REQUIRED', 'AUTH_APPLICATION_ERROR', 'AUTH_RESPONSE_INVALID'].includes(error.code)) throw error;
    }
    return loginInternal(reason);
  }
  async function ensureInternal() {
    const loaded = loadState();
    if (!loaded) return loginInternal('session_missing');
    const { state, session } = loaded;
    const input = credentials();
    input.password = '';
    if (state.username !== input.username) return loginInternal('configured_account_changed');
    const expiry = state.expiresAt ? Date.parse(state.expiresAt) : NaN;
    if (Number.isFinite(expiry) && expiry <= now() + 30000) return renewInternal(state, session, 'expiry_hint');
    try {
      const checked = await owner(session, state);
      state.verified = true;
      if (read(PENDING)?.phase === 'owner_verification_pending') save(PENDING, { version: 1, phase: 'complete' });
      saveState(state, session);
      return { state, session, receipt: { ...checked, renewal: 'stored_session', expiresAt: state.expiresAt } };
    } catch (error) {
      if (error.code !== 'REAUTH_REQUIRED') { saveState(state, session); throw error; }
    }
    return renewInternal(state, session, 'server_rejected_session');
  }
  async function query(session, orm_key, input, columns) {
    const { data, receipt } = await request(session, '/svc/query', { orm_key, input, ...(columns ? { columns } : {}) }, { emptyOnNoRows: true });
    const rows = Array.isArray(data) ? data : object(data) ? [data] : null;
    if (!rows || rows.some(row => !object(row))) reject('QUERY_SCHEMA_INVALID', { ...receipt, operation: orm_key });
    return { rows, receipt: { ...receipt, operation: orm_key, recordCount: rows.length } };
  }
  async function sitesInternal(session, state) {
    const { rows, receipt } = await query(session, 'dc_lpop/taffiliate/v1/GetAffiliates', { account_id: state.username }, ['affiliate_id', 'site_url']);
    if (rows.some(row => typeof row.affiliate_id !== 'string' || typeof row.site_url !== 'string')) reject('SITES_SCHEMA_INVALID');
    return { authenticated: true, ownerVerified: true, browserUsed: false,
      sites: rows.map(row => ({ affiliateId: row.affiliate_id, siteUrl: row.site_url })),
      receipt: { ...receipt, operation: 'sites' } };
  }
  async function merchantsInternal(session, { kind = 'cps' } = {}) {
    if (!['cps', 'cpa'].includes(kind)) reject('MERCHANT_KIND_INVALID');
    const today = new Date(now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    // Same input the web app sends for its "live" merchant list.
    const { rows, receipt } = await query(session, 'dc_lpop/tmerchant/v1/GetMerchants',
      { hidden_flag: 'N', max_pgm_std_end_date: today, [kind === 'cps' ? 'is_cps' : 'is_cpa']: true, orderby: 'start_date DESC' });
    if (rows.some(row => !merchantId(row.merchant_id) || typeof row.site_name !== 'string')) reject('MERCHANTS_SCHEMA_INVALID');
    return { merchants: rows.map(row => Object.fromEntries(MERCHANT_FIELDS.filter(k => k in row).map(k => [k, row[k]]))),
      receipt: { ...receipt, operation: 'merchants', kind } };
  }
  async function subscriptionInternal(session, affiliateId, merchant) {
    if (!merchantId(merchant) || !/^A\d{6,12}$/.test(affiliateId)) reject('SUBSCRIPTION_INPUT_INVALID');
    const { rows, receipt } = await query(session, 'dc_lpop/tsubscript/v1/GetSubscript', { aff_id: affiliateId, mer_id: merchant });
    const row = rows[0];
    // APR approved, REQ requested, DEN denied (web app wording). No row = never applied.
    const status = row ? (typeof row.subs_status === 'string' ? row.subs_status : reject('SUBSCRIPTION_SCHEMA_INVALID')) : 'NONE';
    return { merchantId: merchant, affiliateId, status, linkable: status === 'APR', receipt: { ...receipt, operation: 'subscription' } };
  }
  async function defaultAffiliate(session, state) {
    const { sites } = await sitesInternal(session, state);
    if (sites.length !== 1) reject(sites.length ? 'AFFILIATE_AMBIGUOUS' : 'AFFILIATE_MISSING');
    return sites[0].affiliateId;
  }
  return {
    status: () => ({ service: 'linkprice', loginStored: store.status(LOGIN).available,
      sessionStored: store.status(STATE).available, pendingPhase: read(PENDING)?.phase ?? null,
      currentAuthentication: 'not_checked', passwordLoginImplemented: true, renewalMode: 'token_refresh_then_password_login' }),
    importTokens: input => locked(async () => {
      if (!secret(input?.token) || !secret(input?.csrf)) reject('AUTH_IMPORT_INVALID');
      const configured = credentials();
      configured.password = '';
      const session = withToken(freshSession(), input.token, input.csrf);
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
    refresh: () => locked(async () => {
      const loaded = loadState();
      if (!loaded) reject('SESSION_MISSING');
      return (await refreshInternal(loaded.state, loaded.session)).receipt;
    }),
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
    merchants: options => locked(async () => {
      const { state, session } = await ensureInternal();
      try { return await merchantsInternal(session, options); }
      finally { saveState(state, session); }
    }),
    subscriptions: merchantIds => locked(async () => {
      if (!Array.isArray(merchantIds) || !merchantIds.length || merchantIds.length > 50 || !merchantIds.every(merchantId)) reject('SUBSCRIPTION_INPUT_INVALID');
      const { state, session } = await ensureInternal();
      try {
        const affiliateId = await defaultAffiliate(session, state);
        const results = [];
        for (const m of merchantIds) results.push(await subscriptionInternal(session, affiliateId, m));
        return { affiliateId, subscriptions: results.map(({ receipt, ...r }) => r), receipt: results.at(-1)?.receipt ?? null };
      } finally { saveState(state, session); }
    }),
    // Builds a tracking link only for an approved (APR) merchant subscription; never for an unapproved program.
    link: input => locked(async () => {
      const { state, session } = await ensureInternal();
      try {
        const affiliateId = await defaultAffiliate(session, state);
        const sub = await subscriptionInternal(session, affiliateId, input?.merchantId);
        if (!sub.linkable) reject('MERCHANT_NOT_APPROVED', { merchantId: input?.merchantId, status: sub.status });
        return { affiliateId, merchantId: sub.merchantId, subscriptionStatus: sub.status,
          url: linkpriceClickUrl({ merchantId: sub.merchantId, affiliateId, targetUrl: input?.targetUrl }), receipt: sub.receipt };
      } finally { saveState(state, session); }
    }),
  };
}
