import { SessionClient } from '../session-client.mjs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function loadProtectedSessionPersistence(modulePath) {
  if (!modulePath) return null;
  if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath) ||
      path.basename(modulePath) !== 'session-vault.mjs') throw Error('CREDENTIAL_PROVIDER_INVALID');
  const expectedPath = fileURLToPath(new URL('../session-vault.mjs', import.meta.url));
  let actual, expected;
  try { [actual, expected] = await Promise.all([realpath(modulePath), realpath(expectedPath)]); }
  catch { throw Error('CREDENTIAL_PROVIDER_INVALID'); }
  if (actual !== expected) throw Error('CREDENTIAL_PROVIDER_INVALID');
  const vault = await import(pathToFileURL(actual).href);
  if (typeof vault.persistNaverVerifiedSession !== 'function' ||
      typeof vault.persistNaverObservedResponse !== 'function') throw Error('CREDENTIAL_PROVIDER_INVALID');
  return Object.freeze({
    persistVerifiedSession: vault.persistNaverVerifiedSession,
    persistObservedResponse: vault.persistNaverObservedResponse,
  });
}

// Origin-restricted cookies stay in process memory for requests. When the
// trusted launcher supplies a protected store, verified rotations are saved
// there. This is not proof of unlimited automatic login renewal.
export function environmentSession({ NAVER_COOKIE, now = Date.now, persistence = null } = {}) {
  if (typeof NAVER_COOKIE !== 'string' || NAVER_COOKIE.length > 32768 || /[\r\n]/.test(NAVER_COOKIE))
    throw Error('AUTH_MISSING');
  const required = ['NID_AUT', 'NID_SES'];
  const cookies = NAVER_COOKIE.split(';').map(part => {
    const equal = part.indexOf('=');
    return { name: part.slice(0, equal).trim(), value: part.slice(equal + 1).trim(),
      domain: '.naver.com', path: '/', secure: true, expires: -1 };
  }).filter(c => required.includes(c.name));
  if (!required.every(name => cookies.filter(c => c.name === name).length === 1 && cookies.find(c => c.name === name).value))
    throw Error('AUTH_MISSING');
  const jar = new SessionClient({ cookies, now });
  jar.cookieFor('https://blog.naver.com/');
  cookies.forEach(c => { c.value = ''; });
  let authState = 'unverified', lastOwnerVerifiedAt = null, rotationObserved = false;
  const pendingResponses = [];
  const authCookies = value => value.split('; ').filter(part => required.includes(part.slice(0, part.indexOf('=')))).sort().join('; ');
  const scope = raw => {
    const url = new URL(raw);
    if (url.origin !== 'https://blog.naver.com' || url.username || url.password || url.hash) throw Error('SCOPE');
    return url.href;
  };
  const header = raw => {
    const target = scope(raw);
    if (['reauth_required', 'cleared'].includes(authState)) throw Error('AUTH_MISSING');
    try { return jar.cookieFor(target); }
    catch { authState = 'reauth_required'; throw Error('AUTH_MISSING'); }
  };
  return Object.freeze({
    provider: 'runtime_environment',
    cookieFor: header,
    async acceptResponse(response, raw) {
      const target = scope(raw), before = header(target);
      const wasVerified = authState === 'verified';
      jar.acceptResponse(response, target);
      let after;
      try { after = jar.cookieFor(target); }
      catch { authState = 'reauth_required'; }
      if (after && authCookies(after) !== authCookies(before)) rotationObserved = true;
      if (!wasVerified) {
        if (pendingResponses.length >= 16) throw Error('SESSION_RESPONSE_LIMIT');
        pendingResponses.push({ response, rawUrl: target });
      } else if (persistence) {
        try { await persistence.persistObservedResponse(response, target); }
        catch { authState = 'reauth_required'; throw Error('CREDENTIAL_STORE_WRITE_FAILED'); }
      }
    },
    async markOwnerVerified() {
      header('https://blog.naver.com/');
      if (persistence) {
        const snapshot = jar.snapshotForProtectedStore();
        try { await persistence.persistVerifiedSession(snapshot, pendingResponses); }
        catch { authState = 'reauth_required'; throw Error('CREDENTIAL_STORE_WRITE_FAILED'); }
        finally { snapshot.forEach(cookie => { cookie.value = ''; }); }
      }
      pendingResponses.length = 0;
      authState = 'verified'; lastOwnerVerifiedAt = new Date(now()).toISOString();
    },
    requireReauthentication() { authState = 'reauth_required'; jar.clear(); },
    status() {
      try { header('https://blog.naver.com/'); } catch { /* no secrets in status */ }
      return { authState, lastOwnerVerifiedAt, cookieRotationObserved: rotationObserved,
        credentialsPersisted: Boolean(persistence) && authState === 'verified', automaticLoginRenewalVerified: false };
    },
    clear() { jar.clear(); pendingResponses.length = 0; authState = 'cleared'; },
  });
}
