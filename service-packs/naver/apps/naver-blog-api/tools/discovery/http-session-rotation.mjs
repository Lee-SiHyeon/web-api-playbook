import { mergeNaverSetCookies, storeNaverCookies } from '../../scripts/session-vault.mjs';

// Persist an observed rotation only while both required authentication cookies
// survive vault validation. The vault validates before replacing its current
// bundle; the caller's in-memory jar changes only after that succeeds.
export async function acceptAndPersistNaverCookies(jar, response, rawUrl, { userAgent, now = Date.now() } = {}) {
  if (!Array.isArray(jar)) throw new Error('NAVER_SESSION_INVALID');
  const update = mergeNaverSetCookies(jar, response, rawUrl, now);
  if (!update.changed) return false;
  await storeNaverCookies(update.cookies, { userAgent });
  jar.splice(0, jar.length, ...update.cookies);
  return true;
}
