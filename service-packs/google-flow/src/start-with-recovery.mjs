import { credentialExists } from './secure-credential-store.mjs';
import { formatSafeFlowRecoveryDiagnostics, recoverFlowGoogleSession } from './google-sso-recovery.mjs';
import { formatSafeFlowDocumentDiagnostics } from './document-diagnostics.mjs';

const STARTUP_DOCUMENT_CODES = new Set([
  'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING',
  'FLOW_DOCUMENT_AUTH_COOKIE_DELETED',
  'FLOW_DOCUMENT_REDIRECT',
  'FLOW_DOCUMENT_HTTP_ERROR',
]);
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

function canRecoverStartup(error) {
  return error?.code === 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING'
    || error?.code === 'FLOW_DOCUMENT_AUTH_COOKIE_DELETED'
    || (error?.code === 'FLOW_DOCUMENT_REDIRECT' && error.redirectCategory === 'accounts_login')
    || (error?.code === 'FLOW_DOCUMENT_HTTP_ERROR' && [401, 403].includes(error.httpStatus));
}

function copySafeStartupFailure(error) {
  if (!STARTUP_DOCUMENT_CODES.has(error?.code)
    || formatSafeFlowDocumentDiagnostics(error) === null) return null;
  return {
    code: error.code,
    sessionStatus: 'undetermined',
    documentDiagnostics: structuredClone(error.documentDiagnostics),
  };
}

/** Formats the original startup document failure using the existing safe marker/path formatter. */
export function formatSafeFlowStartupFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'code') || !STARTUP_DOCUMENT_CODES.has(value.code)
    || value.sessionStatus !== 'undetermined'
    || !Object.hasOwn(value, 'documentDiagnostics')) return null;
  const summary = formatSafeFlowDocumentDiagnostics(value);
  return summary ? `startupErrorCode=${value.code} ${summary}` : null;
}

/** Combines only the original safe document summary and the allowlisted recovery hop summary. */
export function formatSafeFlowRecoveryContext(error) {
  const startup = formatSafeFlowStartupFailure(error?.startupFailure);
  const recovery = formatSafeFlowRecoveryDiagnostics(error?.recoveryDiagnostics);
  const summaries = [startup, recovery].filter(Boolean);
  return summaries.length ? summaries.join(' ') : null;
}

function attachRecoveryContext(error, startupError, recoveryDiagnostics) {
  const startupFailure = copySafeStartupFailure(startupError);
  const safeRecoveryDiagnostics = formatSafeFlowRecoveryDiagnostics(recoveryDiagnostics) === null
    ? { hops: [] } : recoveryDiagnostics;
  let target = error && typeof error === 'object' ? error : null;
  try {
    if (!target || !Object.isExtensible(target)) throw new TypeError('nonextensible recovery error');
    Object.defineProperty(target, 'recoveryDiagnostics', {
      value: safeRecoveryDiagnostics, enumerable: true, configurable: true,
    });
    if (startupFailure) {
      Object.defineProperty(target, 'startupFailure', {
        value: startupFailure, enumerable: true, configurable: true,
      });
    }
    return target;
  } catch {
    const code = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
      ? error.code : 'FLOW_SSO_RECOVERY_FAILED';
    target = new Error(code);
    target.code = code;
    target.recoveryDiagnostics = safeRecoveryDiagnostics;
    if (startupFailure) target.startupFailure = startupFailure;
    return target;
  }
}

/** Recovery is attempted once, only before any Flow create or generation journal. */
export async function startFlowWithRecovery(client, {
  recoverImpl = recoverFlowGoogleSession,
  credentialExistsImpl = credentialExists,
  onRecovery = () => {},
  syncImpl = null,
} = {}) {
  try { await client.start(); return; }
  catch (error) {
    if (!canRecoverStartup(error)) throw error;
    let googleBrokerAvailable;
    try { googleBrokerAvailable = credentialExistsImpl('google-flow-google-auth-v1'); }
    catch (storeError) {
      const code = storeError?.code === 'CREDENTIAL_STORE_TIMEOUT'
        ? 'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_STATUS_TIMEOUT'
        : 'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_STATUS_FAILED';
      const statusError = Object.assign(new Error(code), { code });
      throw attachRecoveryContext(statusError, error, { hops: [] });
    }
    if (!googleBrokerAvailable) {
      if (!syncImpl) throw error;
      const receipt = await syncImpl();
      onRecovery(receipt);
      await client.start();
      return;
    }
    let receipt;
    try { receipt = await recoverImpl(); }
    catch (recoveryError) {
      if (syncImpl && recoveryError?.code === 'FLOW_SSO_RECOVERY_LOGIN_REQUIRED') {
        try {
          const synced = await syncImpl();
          onRecovery(synced);
          await client.start();
          return;
        } catch (syncError) {
          throw attachRecoveryContext(syncError, error, recoveryError?.recoveryDiagnostics ?? { hops: [] });
        }
      }
      throw attachRecoveryContext(recoveryError, error, recoveryError?.recoveryDiagnostics ?? { hops: [] });
    }
    onRecovery(receipt);
    try { await client.start(); }
    catch (retryError) {
      if (syncImpl && canRecoverStartup(retryError)) {
        try {
          const synced = await syncImpl();
          onRecovery(synced);
          await client.start();
          return;
        } catch (syncError) {
          throw attachRecoveryContext(syncError, error, { hops: Array.isArray(receipt?.hops) ? receipt.hops : [] });
        }
      }
      throw attachRecoveryContext(retryError, error, { hops: Array.isArray(receipt?.hops) ? receipt.hops : [] });
    }
  }
}
