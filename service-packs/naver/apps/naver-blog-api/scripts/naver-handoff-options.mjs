export const NAVER_HANDOFF_DEFAULT_MAX_WAIT_MS = 120_000;
export const NAVER_HANDOFF_MAX_WAIT_MS = 300_000;
const SAFE_HANDOFF_CODE_PREFIXES = Object.freeze([
  'HANDOFF_', 'NAVER_SESSION_', 'AUTH_', 'CREDENTIAL_STORE_', 'SESSION_', 'LOGIN_CONTROL_',
]);

export function safeNaverHandoffCode(error, fallback = 'HANDOFF_FAILED') {
  const candidate = typeof error?.code === 'string' ? error.code : error?.message;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)
    && SAFE_HANDOFF_CODE_PREFIXES.some(prefix => candidate.startsWith(prefix)) ? candidate : fallback;
}

/** Parse the small public CLI surface for the encrypted browser handoff. */
export function createNaverHandoffWindow(startedAt, args = []) {
  if (!Number.isFinite(startedAt) || !Array.isArray(args)) throw new Error('HANDOFF_ARGUMENT_INVALID');

  let localForm = false;
  let hasMaxWait = false;
  let maxWaitMs = NAVER_HANDOFF_DEFAULT_MAX_WAIT_MS;
  for (const arg of args) {
    if (arg === '--local-form') {
      if (localForm) throw new Error('HANDOFF_ARGUMENT_INVALID');
      localForm = true;
      continue;
    }
    if (typeof arg !== 'string' || !arg.startsWith('--max-wait-ms=')) throw new Error('HANDOFF_ARGUMENT_INVALID');
    if (hasMaxWait) throw new Error('HANDOFF_ARGUMENT_INVALID');
    hasMaxWait = true;
    const value = arg.slice('--max-wait-ms='.length);
    if (!/^\d{1,6}$/.test(value)) throw new Error('HANDOFF_MAX_WAIT_INVALID');
    maxWaitMs = Number(value);
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > NAVER_HANDOFF_MAX_WAIT_MS) {
      throw new Error('HANDOFF_MAX_WAIT_INVALID');
    }
  }

  return Object.freeze({ localForm, maxWaitMs, expiresAt: startedAt + maxWaitMs });
}
