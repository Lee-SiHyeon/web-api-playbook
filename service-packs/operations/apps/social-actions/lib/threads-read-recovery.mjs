// Call only around a phase that cannot dispatch a social mutation. Do not wrap
// a mixed read/write phase or use this predicate to retry a transport request.
export class ThreadsBenefitReadTimeout extends Error {
  constructor(phase, cause) {
    super('THREADS_BENEFIT_READ_TIMEOUT', { cause });
    this.code = 'THREADS_BENEFIT_READ_TIMEOUT';
    this.phase = phase;
  }
}

export class ThreadsBenefitReadContextExpired extends Error {
  constructor(phase, cause) {
    super('THREADS_BENEFIT_READ_CONTEXT_EXPIRED', { cause });
    this.code = 'THREADS_BENEFIT_READ_CONTEXT_EXPIRED';
    this.phase = phase;
  }
}

export async function readThreadsBenefitPhase(phase, operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.code === 'META_CONTEXT_EXPIRED' && error?.receipt == null && error?.response == null
      && error?.httpStatus == null && error?.writeSent !== true && error?.requestDiagnostic?.writeSent !== true
      && error?.dispatchStarted !== true && error?.dispatchConfirmed !== true
      && !error?.writeCountUnknown && !error?.needsReconciliation && !error?.needs_reconciliation
      && error?.mutationCount == null && error?.writes == null) {
      throw new ThreadsBenefitReadContextExpired(phase, error);
    }
    if (!isRecoverableThreadsReadTimeout(error)) {
      try { if (error && !error.phase) error.phase = phase; } catch { /* Preserve frozen provider errors. */ }
      throw error;
    }
    throw new ThreadsBenefitReadTimeout(phase, error);
  }
}

export function isRecoverableThreadsReadTimeout(error) {
  if (error?.cause != null || error?.httpStatus != null || error?.status != null || error?.statusCode != null
    || error?.providerErrorCode != null || error?.receipt != null || error?.response != null
    || error?.writes != null || error?.mutationCount != null || error?.attempts != null
    || error?.needs_reconciliation || error?.needsReconciliation || error?.writeCountUnknown
    || error?.writeSent === true || error?.dispatchConfirmed === true) return false;
  if (error?.name === 'TimeoutError' && (error.code == null || error.code === 23)) return true;
  if (error?.code === 'THREADS_AI_TIMEOUT') return true;
  return ['CREDENTIAL_STORE_UNREADABLE', 'CREDENTIAL_STORE_FAILED', 'CREDENTIAL_STORE_UNVERIFIED'].includes(error?.code)
    && error?.detail?.timedOut === true;
}
