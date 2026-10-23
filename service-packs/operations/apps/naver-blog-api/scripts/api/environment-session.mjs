import { SessionClient } from '../session-client.mjs';

// Runtime-only, origin-restricted cookie rotation. Accepting a server cookie is
// not a refresh-token API, password login, or proof of unlimited session renewal.
export function environmentSession({ NAVER_COOKIE, now = Date.now } = {}) {
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
    acceptResponse(response, raw) {
      const target = scope(raw), before = header(target);
      jar.acceptResponse(response, target);
      let after;
      try { after = jar.cookieFor(target); }
      catch { authState = 'reauth_required'; return; }
      if (authCookies(after) !== authCookies(before)) rotationObserved = true;
    },
    markOwnerVerified() {
      header('https://blog.naver.com/');
      authState = 'verified'; lastOwnerVerifiedAt = new Date(now()).toISOString();
    },
    requireReauthentication() { authState = 'reauth_required'; jar.clear(); },
    status() {
      try { header('https://blog.naver.com/'); } catch { /* no secrets in status */ }
      return { authState, lastOwnerVerifiedAt, cookieRotationObserved: rotationObserved,
        credentialsPersisted: false, automaticLoginRenewalVerified: false };
    },
    clear() { jar.clear(); authState = 'cleared'; },
  });
}
