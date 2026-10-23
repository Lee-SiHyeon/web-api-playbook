import { createHash } from 'node:crypto';
import { ScopedHttpSession, BLOG_ORIGIN } from './transport.mjs';
import { loadState, saveState } from './state.mjs';
import { verifySession, renewSession, authError, decodeJson } from './auth.mjs';
import { withSessionLock } from './lock.mjs';
import { buildAuthHealth, sanitizeAuthDiagnostic } from './auth-health.mjs';

export function safeError(error) {
  return /^TISTORY_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'TISTORY_OPERATION_FAILED';
}

async function prepare({ renew = false, statusOnly = false } = {}) {
  let state = loadState();
  if (!state) throw authError('TISTORY_PROVIDER_MISSING');
  try {
    let session = ScopedHttpSession.fromJSON(state.session);
    let verified;
    let mode = 'stored_session';
    let reauthDetected = false;
    const forcedRemoval = renew ? (await session.removeTistoryCookies()).removed : 0;
    try { verified = await verifySession(session, state.identity); }
    catch (error) {
      if (statusOnly || error.code !== 'TISTORY_REAUTH_REQUIRED') throw error;
      reauthDetected = true;
    }
    if (!verified) {
      // Automatic callers respect the latch. An explicit --renew repair checks
      // the current first-party saved-account flow once without changing stored
      // state unless the protected owner and blog reads both pass.
      if (state.login?.reauthRequired && !renew) throw authError('TISTORY_KAKAO_REAUTH_REQUIRED');
      try {
        verified = await renewSession(session, { expectedIdentity: state.identity, accountDisplayId: state.login?.accountDisplayId });
        mode = 'kakao_simple_login';
      } catch (error) {
        // A failed deliberate renewal probe must not overwrite a working session.
        if (!renew && ['TISTORY_KAKAO_REAUTH_REQUIRED', 'TISTORY_ACCOUNT_MISMATCH', 'TISTORY_ACCOUNT_SELECTION_REQUIRED'].includes(error.code)) {
          state = { ...state, login: { ...state.login, reauthRequired: true, lastFailure: safeError(error), failedAt: new Date().toISOString(),
            failureDiagnostic: sanitizeAuthDiagnostic(error.authDiagnostic) } };
          saveState(state);
        }
        throw error;
      }
    }
    const next = { ...state, session: session.toJSON(), identity: verified.identity, verifiedAt: verified.verifiedAt,
      login: { ...state.login, reauthRequired: false, lastFailure: null, failedAt: null, failureDiagnostic: null,
        ...(verified.accountDisplayId ? { accountDisplayId: verified.accountDisplayId } : {}),
        ...(mode === 'kakao_simple_login' ? { method: mode, lastRenewedAt: verified.verifiedAt } : {}) } };
    saveState(next);
    return { session, state: next, receipt: { ...verified.receipt, mode, execution: 'pure_http',
      browserUsed: false, provider: 'windows_dpapi_current_user', checkedAt: verified.verifiedAt,
      reauthDetected, authHealth: buildAuthHealth(next),
      ...(verified.trace ? { trace: verified.trace, removedTistoryCookies: forcedRemoval + verified.removedTistoryCookies } : {}) } };
  } catch (error) {
    const health = buildAuthHealth(state);
    error.authHealth = error.authDiagnostic
      ? { ...health, failureDiagnostic: sanitizeAuthDiagnostic(error.authDiagnostic) } : health;
    throw error;
  }
}

export async function login(options = {}) {
  return withSessionLock(async () => (await prepare(options)).receipt);
}

// Shared authenticated transaction for observed management and media clients.
// The callback retains the scoped transport; cookie rotation is saved even if
// its operation-specific response validation fails. No request is retried here.
export async function withAuthenticatedSession(operation) {
  if (typeof operation !== 'function') throw authError('TISTORY_REQUEST_INVALID');
  return withSessionLock(async () => {
    const active = await prepare();
    try { return await operation(active); }
    finally { saveState({ ...active.state, session: active.session.toJSON() }); }
  });
}

export function shape(value, depth = 0) {
  if (depth > 12) return 'depth-limit';
  if (value === null) return 'null';
  if (Array.isArray(value)) return { type: 'array', item: value.length ? shape(value[0], depth + 1) : null };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)]));
  return typeof value;
}

// Compatible with the republisher's earlier tistoryRequest interface. Auth is
// resolved before a mutation, and no business write is retried automatically.
export async function requestManagement(request) {
  let url;
  try { url = new URL(request?.url); } catch { throw authError('TISTORY_REQUEST_INVALID'); }
  const method = String(request.method || 'GET').toUpperCase();
  if (url.origin !== BLOG_ORIGIN || !url.pathname.startsWith('/manage/') || url.hash || url.username || url.password
    || !['GET', 'POST', 'PUT', 'DELETE'].includes(method)
    || [...url.searchParams.keys()].some(key => /token|cookie|password|secret|authorization/i.test(key))) throw authError('TISTORY_REQUEST_SCOPE');
  return withAuthenticatedSession(async active => {
    let response;
    try {
      response = await active.session.request(url.href, { method,
        headers: { accept: 'application/json', 'content-type': 'application/json', origin: BLOG_ORIGIN },
        referer: BLOG_ORIGIN + '/manage', body: request.body === undefined ? undefined : JSON.stringify(request.body) });
    } catch (error) {
      if (method !== 'GET') throw authError('TISTORY_WRITE_OUTCOME_UNKNOWN');
      throw error;
    }
    const data = decodeJson(response);
    return { httpStatus: response.status, mime: response.headers['content-type'], bytes: Buffer.byteLength(response.raw),
      sha256: createHash('sha256').update(response.raw).digest('hex'), schema: shape(data), data,
      auth: active.receipt };
  });
}
