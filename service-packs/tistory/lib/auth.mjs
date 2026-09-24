import { BLOG_ORIGIN } from './transport.mjs';
import { JSDOM } from 'jsdom';

export const LOGIN_CONTRACT = Object.freeze({
  entry: 'https://www.tistory.com/auth/login',
  authorize: 'https://kauth.kakao.com/oauth/authorize',
  callback: 'https://www.tistory.com/auth/kakao/redirect',
  simpleChange: 'https://accounts.kakao.com/api/v2/simple_login/change.json',
  clientId: '3e6ddd834b023f24221217e370daed18',
  target: BLOG_ORIGIN + '/manage',
});
const expectedState = Buffer.from(LOGIN_CONTRACT.target).toString('base64');
const authRoutes = new Map([
  ['https://www.tistory.com', new Set(['/auth/login', '/auth/kakao/redirect'])],
  ['https://kauth.kakao.com', new Set(['/oauth/authorize'])],
  ['https://accounts.kakao.com', new Set(['/login', '/login/', '/login/simple', '/login/simple/', '/login/login', '/login/login/'])],
  [BLOG_ORIGIN, new Set(['/manage', '/manage/'])],
]);

export function authError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function decodeJson(response) {
  if ([301, 302, 303, 307, 308, 401].includes(response.status)) throw authError('TISTORY_REAUTH_REQUIRED');
  if (response.status === 403) throw authError('TISTORY_ACCESS_DENIED');
  if (response.status === 429) throw authError('TISTORY_RATE_LIMITED');
  if (response.status !== 200) throw authError('TISTORY_HTTP_FAILED');
  if (!/\bjson\b/i.test(response.headers['content-type'] || '')) {
    if (/accounts\.kakao\.com|auth\/login|로그인/.test(response.raw)) throw authError('TISTORY_REAUTH_REQUIRED');
    throw authError('TISTORY_MIME_MISMATCH');
  }
  try { return JSON.parse(response.raw); }
  catch { throw authError('TISTORY_JSON_INVALID'); }
}

// These two independent protected reads bind both the account and the target blog.
export async function verifySession(session, expectedIdentity) {
  const init = decodeJson(await session.request('https://www.tistory.com/api/v1/init', {
    headers: { accept: 'application/json' }, referer: BLOG_ORIGIN + '/manage',
  }));
  const user = init?.data?.user;
  if (user?.isLogin !== true || !Number.isSafeInteger(user.id) || user.id <= 0) throw authError('TISTORY_REAUTH_REQUIRED');
  if (expectedIdentity?.userId != null && String(user.id) !== String(expectedIdentity.userId)) throw authError('TISTORY_ACCOUNT_MISMATCH');
  const blog = decodeJson(await session.request(BLOG_ORIGIN + '/manage/setting/blog.json', {
    headers: { accept: 'application/json' }, referer: BLOG_ORIGIN + '/manage',
  }));
  const primary = blog?.address?.primaryDomain;
  let hostname;
  try { hostname = new URL(primary?.includes('://') ? primary : 'https://' + primary).hostname; } catch {}
  if (hostname !== new URL(BLOG_ORIGIN).hostname || !Number.isSafeInteger(blog?.info?.blogId)) throw authError('TISTORY_BLOG_MISMATCH');
  if (expectedIdentity?.blogId != null && String(blog.info.blogId) !== String(expectedIdentity.blogId)) throw authError('TISTORY_BLOG_MISMATCH');
  return {
    identity: { userId: user.id, appUserId: user.appUserId, blogId: blog.info.blogId },
    verifiedAt: new Date().toISOString(),
    receipt: { authenticated: true, ownerVerified: true, blogOrigin: BLOG_ORIGIN, probes: ['account-init', 'blog-settings'] },
  };
}

function authUrl(value, base, depth = 0) {
  let url;
  try { url = new URL(value, base); } catch { throw authError('TISTORY_LOGIN_REDIRECT_INVALID'); }
  url.hash = '';
  if (depth > 4 || url.username || url.password || !authRoutes.get(url.origin)?.has(url.pathname)) throw authError('TISTORY_LOGIN_REDIRECT_SCOPE');
  if (url.origin === 'https://kauth.kakao.com') {
    if (url.searchParams.get('client_id') !== LOGIN_CONTRACT.clientId
      || url.searchParams.get('redirect_uri') !== LOGIN_CONTRACT.callback
      || url.searchParams.get('response_type') !== 'code'
      || url.searchParams.get('state') !== expectedState) throw authError('TISTORY_OAUTH_SCOPE');
  }
  if (url.href.startsWith(LOGIN_CONTRACT.callback) && url.searchParams.get('state') !== expectedState) throw authError('TISTORY_OAUTH_STATE_MISMATCH');
  if (url.searchParams.has('continue')) authUrl(url.searchParams.get('continue'), url.origin, depth + 1);
  return url;
}

export async function followLoginRedirects(session, start, trace = []) {
  let url = authUrl(start, LOGIN_CONTRACT.entry);
  let referer = LOGIN_CONTRACT.entry;
  for (let hop = 0; hop < 12; hop++) {
    const response = await session.request(url.href, { referer, headers: { accept: 'text/html,application/xhtml+xml' } });
    trace.push({ method: 'GET', origin: url.origin, path: url.pathname, queryFields: [...url.searchParams.keys()], status: response.status });
    if (response.status === 429) throw authError('TISTORY_RATE_LIMITED');
    if (response.status === 403) throw authError('TISTORY_ACCESS_DENIED');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location) throw authError('TISTORY_LOGIN_REDIRECT_INVALID');
      referer = url.origin + url.pathname; // Never forward an OAuth code in Referer.
      url = authUrl(response.location, url.href);
      continue;
    }
    if (response.status !== 200) throw authError('TISTORY_LOGIN_HTTP_FAILED');
    return response;
  }
  throw authError('TISTORY_LOGIN_REDIRECT_LIMIT');
}

export function parseSimpleLogin(html, pageUrl, accountDisplayId) {
  const url = authUrl(pageUrl, 'https://accounts.kakao.com');
  if (url.origin !== 'https://accounts.kakao.com') throw authError('TISTORY_LOGIN_PAGE_UNEXPECTED');
  const dom = new JSDOM(html, { url: url.href });
  let data;
  try { data = JSON.parse(dom.window.document.querySelector('#__NEXT_DATA__')?.textContent || 'null'); }
  catch { throw authError('TISTORY_KAKAO_PAGE_CHANGED'); }
  finally { dom.window.close(); }
  if (data?.page !== '/login/simple_login') throw authError('TISTORY_KAKAO_REAUTH_REQUIRED');
  const page = data?.props?.pageProps?.pageContext;
  const csrf = page?.commonContext?._csrf;
  const context = page?.context;
  if (typeof csrf !== 'string' || !csrf || csrf.length > 8192 || !Array.isArray(context?.simpleLoginInfos)) throw authError('TISTORY_KAKAO_PAGE_CHANGED');
  const infos = context.simpleLoginInfos;
  let selected;
  if (accountDisplayId) selected = infos.find(info => info.displayId === accountDisplayId);
  else if (infos.length === 1) selected = infos[0];
  if (!selected) throw authError(infos.length > 1 ? 'TISTORY_ACCOUNT_SELECTION_REQUIRED' : 'TISTORY_KAKAO_REAUTH_REQUIRED');
  if (typeof selected.sessionKey !== 'string' || !selected.sessionKey || typeof selected.displayId !== 'string') throw authError('TISTORY_KAKAO_PAGE_CHANGED');
  const continueUrl = authUrl(context.continueUrl, url.origin).href;
  if (new URL(continueUrl).origin !== 'https://kauth.kakao.com') throw authError('TISTORY_OAUTH_SCOPE');
  return { body: { _csrf: csrf, loginInfo: selected, continueUrl }, accountDisplayId: selected.displayId };
}

// Restores Tistory via the same stored-account action used by the Kakao page.
// A fresh HTML response supplies CSRF and account sessionKey for every exchange.
export async function renewSession(session, { expectedIdentity, accountDisplayId } = {}) {
  const trace = [];
  const removed = await session.removeTistoryCookies();
  const entry = new URL(LOGIN_CONTRACT.entry);
  entry.searchParams.set('redirectUrl', LOGIN_CONTRACT.target);
  const response = await session.request(entry.href, { headers: { accept: 'text/html' } });
  trace.push({ method: 'GET', origin: entry.origin, path: entry.pathname, queryFields: ['redirectUrl'], status: response.status });
  if (response.status !== 200 || !/\bhtml\b/i.test(response.headers['content-type'] || '')) throw authError('TISTORY_LOGIN_ENTRY_FAILED');
  const key = /Kakao\.init\(\s*["']([0-9a-f]{32})["']\s*\)/i.exec(response.raw)?.[1];
  if (key !== LOGIN_CONTRACT.clientId) throw authError('TISTORY_LOGIN_CONTRACT_CHANGED');
  const authorize = new URL(LOGIN_CONTRACT.authorize);
  authorize.search = new URLSearchParams({ client_id: key, redirect_uri: LOGIN_CONTRACT.callback, response_type: 'code', state: expectedState, prompt: 'select_account' });
  const page = await followLoginRedirects(session, authorize.href, trace);
  let selectedHint = accountDisplayId;
  if (new URL(page.url).origin === 'https://accounts.kakao.com') {
    const parsed = parseSimpleLogin(page.raw, page.url, accountDisplayId);
    selectedHint = parsed.accountDisplayId;
    const change = await session.request(LOGIN_CONTRACT.simpleChange, {
      method: 'POST', referer: page.url,
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'https://accounts.kakao.com' },
      body: JSON.stringify(parsed.body),
    });
    trace.push({ method: 'POST', origin: 'https://accounts.kakao.com', path: '/api/v2/simple_login/change.json',
      bodyFields: ['_csrf', 'loginInfo', 'continueUrl'], status: change.status });
    if (change.status === 429) throw authError('TISTORY_RATE_LIMITED');
    if (change.status === 403) throw authError('TISTORY_ACCESS_DENIED');
    if (change.status !== 200 || !/\bjson\b/i.test(change.headers['content-type'] || '')) throw authError('TISTORY_KAKAO_LOGIN_FAILED');
    let result;
    try { result = JSON.parse(change.raw); } catch { throw authError('TISTORY_KAKAO_JSON_INVALID'); }
    if (result.status !== 0 || typeof result.continueUrl !== 'string') throw authError('TISTORY_KAKAO_REAUTH_REQUIRED');
    await followLoginRedirects(session, result.continueUrl, trace);
  }
  const verified = await verifySession(session, expectedIdentity);
  return { ...verified, accountDisplayId: selectedHint, trace, removedTistoryCookies: removed.removed };
}
