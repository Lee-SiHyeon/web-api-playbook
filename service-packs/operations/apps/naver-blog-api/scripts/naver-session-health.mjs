import { openSync, writeFileSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inspectNaverSessionStore, loadNaverCookies } from './session-vault.mjs';
import { SessionClient } from './session-client.mjs';
import { withNaverSessionLock } from './naver-session-lock.mjs';

const actor = 'aicandoanything';

export async function runNaverSessionHealth({
  inspectStore = inspectNaverSessionStore,
  loadSession = loadNaverCookies,
  createClient = options => new SessionClient(options),
} = {}) {
  const result = { actor, provider: null, stored: false, storedAuthCookiesPresent: false,
    storedAuthCookieState: 'unknown', storedCookieCount: null, expiredCookieCount: null,
    storedSessionCode: null, protectedOwnerRead: false, sessionStoredAfterRead: false, browserUsed: false };
  try {
    const metadata = await inspectStore();
    result.provider = metadata.provider;
    result.stored = metadata.stored;
    result.storedAuthCookiesPresent = metadata.authCookiesPresent === true;
    result.storedAuthCookieState = metadata.authCookieState || 'unknown';
    result.storedCookieCount = metadata.cookieCount;
    result.expiredCookieCount = metadata.expiredCookieCount;
    result.storedSessionCode = metadata.code;
    result.userAgentRestored = metadata.userAgentPresent === true;

    const session = await loadSession({ env: {} });
    result.provider = session.provider;
    result.stored = session.persisted;
    const client = createClient({ cookies: session.cookies, ownerBlogId: actor, persistRotation: false,
      defaultHeaders: session.userAgent ? { 'user-agent': session.userAgent } : {} });
    try {
      const persisted = await client.persistVerifiedSession();
      const receipt = persisted.verification;
      result.protectedOwnerRead = receipt.verified === true && receipt.actorMatched === true && receipt.adminShell === true;
      result.sessionStoredAfterRead = persisted.stored === true;
      result.httpStatus = receipt.httpStatus;
      result.mime = receipt.mime;
      result.actorMatched = receipt.actorMatched;
      result.adminShell = receipt.adminShell;
      result.loginHTML = receipt.loginHTML;
      result.bytes = receipt.bytes;
      result.redirectCount = receipt.redirectCount;
      result.checkedAt = receipt.checkedAt;
      result.userAgentRestored = !!session.userAgent;
      if (!result.protectedOwnerRead) result.code = 'PROTECTED_READ_UNVERIFIED';
    } finally { client.clear(); }
  } catch (error) {
    const details = error?.details;
    if (Number.isInteger(details?.httpStatus)) result.httpStatus = details.httpStatus;
    if (typeof details?.finalPath === 'string' && details.finalPath.startsWith('https://nid.naver.com/')) result.loginRedirect = true;
    if (typeof details?.loginHTML === 'boolean') result.loginHTML = details.loginHTML;
    if (typeof details?.actorMatched === 'boolean') result.actorMatched = details.actorMatched;
    if (typeof details?.adminShell === 'boolean') result.adminShell = details.adminShell;
    if (typeof details?.verified === 'boolean') result.verified = details.verified;
    if (Number.isInteger(details?.redirectCount)) result.redirectCount = details.redirectCount;
    if (typeof details?.mime === 'string') result.mime = details.mime;
    const verification = details?.verification;
    if (verification && typeof verification === 'object') {
      result.protectedOwnerRead = verification.verified === true
        && verification.actorMatched === true && verification.adminShell === true;
      if (typeof verification.loginHTML === 'boolean') result.loginHTML = verification.loginHTML;
      if (typeof verification.actorMatched === 'boolean') result.actorMatched = verification.actorMatched;
      if (typeof verification.adminShell === 'boolean') result.adminShell = verification.adminShell;
      if (Number.isInteger(verification.httpStatus)) result.httpStatus = verification.httpStatus;
    }
    const raw = error?.code || error?.message || '';
    result.code = /^[A-Z_]+$/.test(raw) ? raw : 'PROTECTED_READ_FAILED';
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let outputFd;
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
    throw new Error('SESSION_HEALTH_ARGUMENT_INVALID');
  }
  if (args.length) {
    try { outputFd = openSync(args[1], 'wx'); }
    catch { throw new Error('SESSION_HEALTH_OUTPUT_RESERVATION_FAILED'); }
  }
  const result = await withNaverSessionLock(() => runNaverSessionHealth());
  if (result.code || !result.protectedOwnerRead) process.exitCode = 2;
  if (outputFd != null) {
    try { writeFileSync(outputFd, JSON.stringify(result, null, 2) + '\n'); }
    catch { result.receiptWriteFailed = true; process.exitCode = 2; }
    finally { closeSync(outputFd); }
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    const raw = error?.code || error?.message || '';
    const code = /^[A-Z_]+$/.test(raw) ? raw : 'SESSION_HEALTH_FAILED';
    console.log(JSON.stringify({ actor, provider: null, stored: false, storedAuthCookiesPresent: false,
      storedAuthCookieState: 'unknown', storedCookieCount: null, expiredCookieCount: null,
      storedSessionCode: null, protectedOwnerRead: false, sessionStoredAfterRead: false, browserUsed: false, code }));
    process.exitCode = 2;
  }
}
