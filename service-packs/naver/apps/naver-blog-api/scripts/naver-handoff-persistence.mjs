import { NAVER_LOGIN_ACTOR } from './naver-login-http.mjs';
import { normalizeNaverUserAgent } from './session-vault.mjs';
import { safeNaverHandoffCode } from './naver-handoff-options.mjs';

function handoffError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Persists a browser-captured session only while holding the shared publisher
 * lock and after SessionClient has minted a protected owner-verification proof.
 * Dependencies are explicit so the orchestration can be tested without DPAPI,
 * a real lock, or network access.
 */
export async function persistVerifiedNaverHandoff({
  cookies,
  userAgent,
  createSessionClient,
  acquireSessionLock,
  recordLoginSuccess,
}) {
  if (typeof createSessionClient !== 'function' || typeof acquireSessionLock !== 'function'
    || typeof recordLoginSuccess !== 'function') throw handoffError('HANDOFF_DEPENDENCY_INVALID');

  let observedUserAgent;
  try { observedUserAgent = normalizeNaverUserAgent(userAgent); }
  catch { throw handoffError('HANDOFF_USER_AGENT_INVALID'); }
  if (!observedUserAgent) throw handoffError('HANDOFF_USER_AGENT_REQUIRED');

  let release;
  try { release = await acquireSessionLock(); }
  catch (error) { throw handoffError(safeNaverHandoffCode(error, 'NAVER_SESSION_LOCK_FAILED')); }
  if (typeof release !== 'function') throw handoffError('NAVER_SESSION_LOCK_NOT_ACQUIRED');

  let client;
  try {
    client = createSessionClient({ cookies, ownerBlogId: NAVER_LOGIN_ACTOR,
      persistRotation: false, defaultHeaders: { 'user-agent': observedUserAgent } });
    const persistence = await client.persistVerifiedSession();
    const verification = persistence?.verification;
    const ownerVerified = verification?.verified === true
      && verification.actor === NAVER_LOGIN_ACTOR
      && verification.actorMatched === true
      && verification.adminShell === true;
    if (!ownerVerified) throw handoffError('HANDOFF_OWNER_UNVERIFIED');
    if (verification.userAgentApplied !== true) throw handoffError('HANDOFF_USER_AGENT_UNVERIFIED');
    if (persistence?.stored !== true) throw handoffError('HANDOFF_CREDENTIAL_STORE_UNVERIFIED');

    let loginControlStored = false;
    try { loginControlStored = (await recordLoginSuccess())?.stored === true; }
    catch { /* Keep the successful session receipt and report guard-write failure safely. */ }
    return {
      stored: true,
      protectedOwnerRead: true,
      loginControlStored,
      ...(loginControlStored ? {} : { code: 'LOGIN_CONTROL_STORE_FAILED' }),
    };
  } catch (error) {
    const code = safeNaverHandoffCode(error, 'HANDOFF_PERSIST_FAILED');
    throw handoffError(code);
  } finally {
    try { client?.clear(); } finally { release?.(); }
  }
}
