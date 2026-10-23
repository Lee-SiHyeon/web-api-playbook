import { readRetryAt } from './x-recovery.mjs';
// Session bootstrap failures happen before any request of the operation is sent (the /home owner check, the
// transaction id or main-asset bootstrap). One X_HOME_OWNER_UNVERIFIED stopped the follow-back bot for 9 hours on
// 2026-10-02; they are retried after 5 minutes (up to 30 minutes after repeats) whatever the calling phase.
export const X_SESSION_BOOTSTRAP_CODES = Object.freeze(['X_HOME_OWNER_UNVERIFIED', 'X_HOME_VIEWER_INCOMPLETE',
  'X_TRANSACTION_BOOTSTRAP_FAILED', 'X_BOOTSTRAP_UNAVAILABLE', 'X_MAIN_ASSET_UNAVAILABLE', 'X_BOOTSTRAP_CHANGED']);
export function readCooldown(error, phase, now = Date.now(), failures = 1) {
  if (X_SESSION_BOOTSTRAP_CODES.includes(error?.code) && error.receipt?.writeSent !== true && error.writeSent !== true)
    return { status: 'waiting_for_session_bootstrap', retryAt: now + Math.min(30, 5 * Math.max(1, failures)) * 60000 };
  if (phase !== 'read' || error.receipt?.writeSent === true || error.writeSent === true) return null;
  if (error.code === 'PROTECTED_STORE_READ_FAILED' && error.detail?.timedOut === true) return { status: 'waiting_for_protected_store', retryAt: now + 60000 };
  const receipt = error.receipt || {};
  if(error.code==='X_READ_BUDGET_WAIT'&&receipt.localBudget===true)return {status:'waiting_for_read_budget',retryAt:Math.max(now+1000,receipt.readBudgetRetryAt||(receipt.rateLimitReset||0)*1000)};
  if (receipt.httpStatus === 429) {
    const reset = Number.isFinite(receipt.rateLimitReset) ? receipt.rateLimitReset * 1000 : 0;
    const retry = Number.isFinite(receipt.retryAfterSeconds) ? now + receipt.retryAfterSeconds * 1000 : 0;
    return { status: 'cooldown', retryAt: Math.max(now + 60000, reset, retry, reset || retry ? 0 : now + 15 * 60000) };
  }
  if (['X_OWNER_VERIFY_FAILED', 'AUTH_RESPONSE_INVALID'].includes(error.code) && receipt.httpStatus === 404) return { status: 'waiting_for_owner_read', retryAt: now + 5 * 60000 };
  const retryAt=readRetryAt(error,{phase,now,failures});
  if(retryAt)return {status:'waiting_for_search_read',retryAt};
  return null;
}
