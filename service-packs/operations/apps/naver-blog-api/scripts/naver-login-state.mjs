import { readCredential, writeCredential } from './secure-credential-store.mjs';

const name = 'naver-login-control';
const actor = 'aicandoanything';

export function loadLoginControl() {
  const saved = readCredential(name);
  if (!saved) return { blocked: false };
  let state;
  try { state = JSON.parse(saved); } catch { throw new Error('LOGIN_CONTROL_INVALID'); }
  if (state.version !== 1 || state.actor !== actor || typeof state.blocked !== 'boolean'
    || (state.blocked && state.code !== 'ACCOUNT_PROTECTION_REQUIRED')) throw new Error('LOGIN_CONTROL_INVALID');
  return { blocked: state.blocked, code: state.blocked ? state.code : null, checkedAt: state.checkedAt,
    lastLoginAt: typeof state.lastLoginAt === 'string' ? state.lastLoginAt : null };
}

// 2026-10-03: a fresh login (protected read OK, session stored) was rejected by the next process a minute later.
// session-keeper then sent another password login and Naver locked the account again. After a verified login,
// automatic password logins wait this long; the operator can still log in explicitly with --identity-stdin.
export const AUTOMATIC_RELOGIN_COOLDOWN_MS = 6 * 3600_000;

export function automaticReloginBlocked(control, now = Date.now()) {
  const last = Date.parse(control?.lastLoginAt ?? '');
  return Number.isFinite(last) && now - last < AUTOMATIC_RELOGIN_COOLDOWN_MS;
}

export function recordLoginSuccess(now = new Date()) {
  return writeCredential(name, JSON.stringify({ version: 1, actor, blocked: false,
    checkedAt: now.toISOString(), lastLoginAt: now.toISOString() }));
}

export function recordAccountProtection() {
  return writeCredential(name, JSON.stringify({ version: 1, actor, blocked: true,
    code: 'ACCOUNT_PROTECTION_REQUIRED', checkedAt: new Date().toISOString() }));
}

// Explicit operator assertion after Naver's account-recovery process completes.
// This does not call recovery endpoints or certify that the server accepted recovery.
export function acknowledgeAccountRecovery() {
  return writeCredential(name, JSON.stringify({ version: 1, actor, blocked: false,
    checkedAt: new Date().toISOString() }));
}
