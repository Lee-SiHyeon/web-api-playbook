import { mergeNaverLoginSetCookies } from '../../scripts/session-vault.mjs';

const loginUrl = 'https://nid.naver.com/nidlogin.login';
const requiredAuthCookies = new Set(['NID_AUT', 'NID_SES']);

export function mergeLoginResponseCookies(cookies, response, now = Date.now()) {
  return mergeNaverLoginSetCookies(cookies, response, loginUrl, now);
}

function cookieAppliesTo(cookie, url) {
  if (!cookie || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') return false;
  const bareDomain = cookie.domain.replace(/^\./, '').toLowerCase();
  const domainMatches = url.hostname === bareDomain
    || (cookie.domain.startsWith('.') && url.hostname.endsWith(`.${bareDomain}`));
  const pathMatches = url.pathname === cookie.path
    || (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
  return domainMatches && pathMatches;
}

function cookieIdentity(cookie) {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path]);
}

// A response counts as a fresh login only when both authentication cookies
// changed for the protected Blog origin that the handoff verifies.
export function hasFreshAuthenticationCookies(previous, next, actor = 'aicandoanything') {
  if (!Array.isArray(previous) || !Array.isArray(next) || !/^[A-Za-z0-9_-]{1,64}$/.test(actor)) return false;
  const target = new URL(`https://admin.blog.naver.com/${actor}`);
  const previousValues = new Map(previous.filter(cookie => requiredAuthCookies.has(cookie?.name)
    && cookie?.value && cookieAppliesTo(cookie, target))
    .map(cookie => [cookieIdentity(cookie), cookie.value]));
  const changedNames = new Set(next.filter(cookie => requiredAuthCookies.has(cookie?.name)
    && cookie?.value && cookieAppliesTo(cookie, target)
    && previousValues.get(cookieIdentity(cookie)) !== cookie.value)
    .map(cookie => cookie.name));
  return [...requiredAuthCookies].every(name => changedNames.has(name));
}
