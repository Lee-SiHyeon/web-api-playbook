import path from 'node:path';
import { ProtectedStore } from '../protected-store.mjs';
import { withSessionLock } from '../session-lock.mjs';

const ORIGIN = 'https://api3-backoffice.myrealtrip.com';
const LOGIN = 'myrealtrip-login', STATE = 'myrealtrip-state', PENDING = 'myrealtrip-pending';
export class WebAuthError extends Error { constructor(code, receipt) { super(code); this.code = code; this.receipt = receipt; } }
const fail = code => { throw new WebAuthError(code); };
const token = v => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !/[\s\x00-\x1f]/.test(v);
const object = v => v && typeof v === 'object' && !Array.isArray(v);

export function createMyrealtripAuth({ store = new ProtectedStore(), fetchImpl = fetch } = {}) {
  const read = name => { const raw = store.read(name); if (!raw) return null; try { return JSON.parse(raw); } catch { fail('AUTH_STATE_INVALID'); } };
  const save = (name, value) => store.write(name, JSON.stringify(value));
  const locked = fn => withSessionLock(fn, { root: path.join(store.directory, 'locks'), key: STATE });
  const credentials = () => {
    const c = read(LOGIN);
    if (!c || c.version !== 1 || typeof c.email !== 'string' || !c.email.includes('@') ||
        typeof c.password !== 'string' || !c.password || typeof c.isKeepSignIn !== 'boolean' ||
        /[\0\r\n]/.test(c.email + c.password)) fail('LOGIN_INPUT_MISSING');
    return c;
  };
  async function request(route, { body, accessToken } = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    let response;
    try {
      response = await fetchImpl(ORIGIN + route, { method, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { accept: 'application/json', origin: 'https://partner.myrealtrip.com',
          referer: 'https://partner.myrealtrip.com/', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(accessToken ? { 'partner-access-token': accessToken } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail(method === 'POST' ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_TRANSPORT_FAILED'); }
    try {
      if (response.status === 401) fail('REAUTH_REQUIRED');
      if (response.status === 403) fail('AUTH_FORBIDDEN');
      if (response.status === 429) fail('AUTH_THROTTLED');
      if ([404,405].includes(response.status)) fail('AUTH_ROUTE_UNAVAILABLE');
      if (response.status !== 200 || response.redirected || !response.headers.get('content-type')?.includes('json')) fail(method === 'POST' ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID');
      let bytes=0; const parts=[];
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024*1024) fail('AUTH_RESPONSE_TOO_LARGE'); parts.push(chunk); }
      let b; try { b=JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail(method === 'POST' ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID'); }
      if (!object(b?.result) || !Number.isInteger(b.result.status)) fail(method === 'POST' ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID');
      if (b?.result?.status === 401) fail('REAUTH_REQUIRED');
      if (b.result.status !== 200) fail('AUTH_APPLICATION_REJECTED');
      if (!object(b.data)) fail(method === 'POST' ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_RESPONSE_INVALID');
      return b.data;
    } catch (error) {
      if (error instanceof WebAuthError) throw error;
      fail(method === 'POST' ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_TRANSPORT_FAILED');
    } finally { await response.body?.cancel().catch(()=>{}); }
  }
  const definitiveRejections = new Set(['REAUTH_REQUIRED', 'AUTH_FORBIDDEN', 'AUTH_THROTTLED', 'AUTH_ROUTE_UNAVAILABLE', 'AUTH_APPLICATION_REJECTED']);
  function pendingStep({ allowExpired = false } = {}) {
    const pending = read(PENDING);
    if (pending?.phase?.endsWith('_outcome_unknown')) fail('AUTH_OUTCOME_UNKNOWN');
    if (pending?.phase === 'send_otp') return { authenticated: false, browserUsed: false, next: 'otp-send', loginAccepted: true };
    if (pending?.phase === 'verify_otp') {
      const expiresAt = Date.parse(pending.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return { authenticated: false, browserUsed: false, next: 'otp-verify' };
      if (!allowExpired) fail('OTP_STATE_EXPIRED');
    }
    return null;
  }
  async function trackedMutation(phase, callback) {
    save(PENDING, { version: 1, phase: `${phase}_outcome_unknown`, startedAt: new Date().toISOString() });
    try { return await callback(); }
    catch (error) {
      if (definitiveRejections.has(error.code)) save(PENDING, { version: 1, phase: 'rejected', code: error.code });
      throw error;
    }
  }
  async function owner(accessToken, email, partnerId) {
    if (!token(accessToken)) fail('AUTH_STATE_INVALID');
    const b = await request('/partner/v1/partners', { accessToken });
    if (!Number.isSafeInteger(b.id) || b.id <= 0 || typeof b.email !== 'string') fail('OWNER_SCHEMA_INVALID');
    if (b.email.toLowerCase() !== email.toLowerCase() || (partnerId != null && String(b.id) !== String(partnerId))) fail('OWNER_MISMATCH');
    return { partnerId: b.id, email: b.email };
  }
  async function acceptTokens(tokens, identity, renewal) {
    if (!token(tokens.accessToken) || !token(tokens.refreshToken)) fail('AUTH_TOKENS_INVALID');
    // Preserve a rotated token even if the subsequent owner read fails; it is not usable until verified.
    const state = { version: 1, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      email: identity.email, partnerId: identity.partnerId ?? null, verified: false, updatedAt: new Date().toISOString() };
    save(STATE, state);
    save(PENDING, { version: 1, phase: 'owner_verification_pending' });
    const verified = await owner(state.accessToken, state.email, state.partnerId);
    save(STATE, { ...state, ...verified, verified: true });
    save(PENDING, { version: 1, phase: 'complete' });
    return { authenticated: true, ownerVerified: true, stored: true, browserUsed: false, renewal };
  }
  async function loginInternal() {
    const pending = pendingStep({ allowExpired: true });
    if (pending) return pending;
    const c = credentials();
    const payload = { email: c.email, password: c.password, isKeepSignIn: c.isKeepSignIn,
      ...(c.partnerId === undefined ? {} : { partnerId: c.partnerId }) };
    const data = await trackedMutation('login', () => request('/partner/v1/sign-in', { body: payload }));
    if (token(data.preAuthToken)) {
      save(PENDING, { version: 1, phase: 'send_otp', preAuthToken: data.preAuthToken, email: c.email,
        partnerId: c.partnerId ?? null, createdAt: new Date().toISOString() });
      return { authenticated: false, browserUsed: false, next: 'otp-send', loginAccepted: true };
    }
    return acceptTokens(data, c, 'password_login');
  }
  async function refreshInternal(state) {
    if (!state || !token(state.refreshToken)) fail('SESSION_MISSING');
    const pending = pendingStep();
    if (pending) return pending;
    const data = await trackedMutation('refresh', async () => {
      try { return await request('/authentication/v3/partner/token/refresh', { body: { refreshToken: state.refreshToken } }); }
      catch (e) {
        if (e.code !== 'AUTH_ROUTE_UNAVAILABLE') throw e;
        return request('/authentication/legacy/partner/token', { body: { refreshToken: state.refreshToken } });
      }
    });
    return acceptTokens({ ...data, refreshToken: data.refreshToken || state.refreshToken }, state, 'refresh_token');
  }
  async function ensureInternal() {
    const state = read(STATE);
    if (!state) return loginInternal();
    try {
      await owner(state.accessToken, state.email, state.partnerId);
      if (!state.verified) save(STATE, { ...state, verified: true });
      if (read(PENDING)?.phase === 'owner_verification_pending') save(PENDING, { version: 1, phase: 'complete' });
      return { authenticated: true, ownerVerified: true, browserUsed: false, renewal: 'stored_session' };
    } catch (e) { if (e.code !== 'REAUTH_REQUIRED') throw e; }
    try { return await refreshInternal(state); }
    catch (e) { if (e.code !== 'REAUTH_REQUIRED') throw e; }
    return loginInternal();
  }
  return {
    status: () => ({ service: 'myrealtrip', loginStored: store.status(LOGIN).available,
      sessionStored: store.status(STATE).available, pendingStored: store.status(PENDING).available,
      currentAuthentication: 'not_checked' }),
    login: () => locked(loginInternal),
    ensure: () => locked(ensureInternal),
    refresh: () => locked(() => refreshInternal(read(STATE))),
    health: () => locked(async () => {
      const s = read(STATE); if (!s) fail('SESSION_MISSING');
      await owner(s.accessToken,s.email,s.partnerId);
      return { authenticated: true, ownerVerified: true, browserUsed: false };
    }),
    importTokens: data => locked(() => acceptTokens(data, credentials(), 'captured_login_import')),
    sendOtp: () => locked(async () => {
      const p=read(PENDING);
      if (p?.phase !== 'send_otp' || !token(p.preAuthToken)) fail('OTP_STATE_INVALID');
      // Set before POST: ambiguous send is not automatically repeated.
      save(PENDING, { ...p, phase: 'send_outcome_unknown' });
      let data;
      try { data=await request('/partner/v1/sign-in/send-otp',{body:{preAuthToken:p.preAuthToken}}); }
      catch (error) {
        if (definitiveRejections.has(error.code)) save(PENDING, { ...p, lastFailure: error.code });
        throw error;
      }
      if (!token(data.loginAttemptId) || !Number.isInteger(data.codeExpiresIn) || data.codeExpiresIn <= 0) fail('OTP_RESPONSE_INVALID');
      save(PENDING,{version:1,phase:'verify_otp',loginAttemptId:data.loginAttemptId,email:p.email,partnerId:p.partnerId,
        requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+data.codeExpiresIn*1000).toISOString()});
      return { authenticated:false,browserUsed:false,next:'otp-verify',codeExpiresIn:data.codeExpiresIn };
    }),
    verifyOtp: code => locked(async () => {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail('OTP_INPUT_INVALID');
      const p=read(PENDING);
      if (p?.phase !== 'verify_otp' || !token(p.loginAttemptId) || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt)<=Date.now()) fail('OTP_STATE_EXPIRED');
      save(PENDING,{...p,phase:'verify_outcome_unknown'});
      let data;
      try { data=await request('/partner/v1/sign-in/verify-otp',{body:{loginAttemptId:p.loginAttemptId,code}}); }
      catch (error) {
        if (definitiveRejections.has(error.code)) save(PENDING, { ...p, lastFailure: error.code });
        throw error;
      }
      return acceptTokens(data,p,'password_and_email_otp');
    }),
    // Business clients receive credentials only in-process, after the same protected owner read.
    withSession: callback => locked(async () => {
      const result=await ensureInternal(); if (!result.authenticated) fail('OTP_REQUIRED');
      const s=read(STATE); const session={token:s.accessToken,expectedPartnerId:s.partnerId,expectedEmail:s.email};
      try { return await callback(session, result); } finally { session.token=''; }
    }),
  };
}
