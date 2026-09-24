import { openSync, writeFileSync, closeSync } from 'node:fs';
import { loadNaverCookies } from './session-vault.mjs';

const actor = 'aicandoanything';
const args = process.argv.slice(2);
let outputFd;
let result = { actor, provider: null, stored: false, protectedOwnerRead: false, browserUsed: false };
try {
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw new Error('SESSION_HEALTH_ARGUMENT_INVALID');
  if (args.length) {
    try { outputFd = openSync(args[1], 'wx'); } catch { throw new Error('SESSION_HEALTH_OUTPUT_RESERVATION_FAILED'); }
  }
  const session = await loadNaverCookies({ env: {} });
  result.provider = session.provider;
  result.stored = session.persisted;
  const { SessionClient } = await import('./session-client.mjs');
  const client = new SessionClient({ cookies: session.cookies, ownerBlogId: actor,
    defaultHeaders: session.userAgent ? { 'user-agent': session.userAgent } : {} });
  try {
    const receipt = await client.verifyRoot();
    result = { ...result, protectedOwnerRead: receipt.verified === true && receipt.actorMatched === true && receipt.adminShell === true,
      httpStatus: receipt.httpStatus, mime: receipt.mime, actorMatched: receipt.actorMatched,
      adminShell: receipt.adminShell, loginHTML: receipt.loginHTML, bytes: receipt.bytes,
      redirectCount: receipt.redirectCount, checkedAt: receipt.checkedAt, userAgentRestored: !!session.userAgent };
    if (!result.protectedOwnerRead) throw new Error('PROTECTED_READ_UNVERIFIED');
  } finally { client.clear(); }
} catch (error) {
  const raw = error?.code || error?.message || '';
  result.code = /^[A-Z_]+$/.test(raw) ? raw : 'PROTECTED_READ_FAILED';
  process.exitCode = 2;
}
if (outputFd != null) {
  try { writeFileSync(outputFd, JSON.stringify(result, null, 2) + '\n'); }
  catch { result.receiptWriteFailed = true; process.exitCode = 2; }
  finally { closeSync(outputFd); }
}
console.log(JSON.stringify(result));
