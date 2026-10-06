import { createRequire } from 'node:module';
import { storeSession, checkSession, request, STORE_NAME } from './client.mjs';
import { ownerMatches, validateBundle } from './client-core.mjs';
import { ProtectedStore } from '../../protected-store.mjs';

const require = createRequire(import.meta.url);
const { CookieJar } = require('tough-cookie');
const origins = new Set(['https://business.toss.im', 'https://business-accounts.toss.im', 'https://sharelink.toss.im']);
const clientId = 'ajvm9wq2t0p1ttet13y3qzb3rvjxhacn';
const redirectUri = 'https://sharelink.toss.im/signup-start';
const fail = code => Object.assign(new Error(code), { code });

// Source-observed 2026-09-30: Sharelink app/error config and Business sign-in
// chunk 9781.2ce36c8a3715e115.js, module 48684 (hidden HTML POST form).
// No guessed SMS/account conversion requests and no password persistence.
export async function loginHttp(identity, {
  loadBaseline = () => JSON.parse(new ProtectedStore().read(STORE_NAME) || 'null'),
  fetchImpl = fetch,
  persistSession = storeSession,
  check = checkSession,
  read = request,
} = {}) {
  if (!identity || typeof identity.email !== 'string' || typeof identity.password !== 'string' || !identity.password) throw fail('TOSS_LOGIN_INPUT_INVALID');
  const rawBaseline = loadBaseline();
  if (!rawBaseline?.expectedOwner || !rawBaseline?.readRequests) throw fail('TOSS_LOGIN_OWNER_BASELINE_REQUIRED');
  const previous = validateBundle(rawBaseline);
  const jar = new CookieJar();
  const steps = [];
  async function send(rawUrl, init = {}) {
    const u = new URL(rawUrl);
    if (!origins.has(u.origin) || u.username || u.password || u.hash) throw fail('TOSS_LOGIN_ORIGIN_REJECTED');
    const cookie = jar.getCookieStringSync(u.href);
    const response = await fetchImpl(u, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
    for (const line of response.headers.getSetCookie?.() || []) jar.setCookieSync(line, u.href);
    steps.push({ method: init.method || 'GET', origin: u.origin, path: u.pathname, httpStatus: response.status });
    return response;
  }
  const loginPage = new URL('https://business.toss.im/account/sign-in');
  loginPage.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri }).toString();
  await (await send(loginPage)).body?.cancel();
  let body = new URLSearchParams({ email: identity.email.trim(), password: identity.password, client_id: clientId, redirect_uri: redirectUri }).toString();
  identity.password = '';
  let r;
  try {
    r = await send('https://business-accounts.toss.im/v1/sign-in', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://business.toss.im', Referer: loginPage.href } });
  } finally { body = ''; }
  for (let hop = 0; hop < 8; hop++) {
    const location = r.headers.get('location');
    if (!location || ![301, 302, 303].includes(r.status)) break;
    const u = new URL(location, r.url || steps.at(-1).origin + steps.at(-1).path);
    await r.body?.cancel();
    const error = u.searchParams.get('error');
    if (error || /password|two-factor|account-locked|consent|conversion|sign-up/.test(u.pathname)) {
      return { authenticated: false, code: error ? 'TOSS_LOGIN_REJECTED' : 'TOSS_LOGIN_USER_ACTION_REQUIRED', nextOrigin: u.origin, nextPath: u.pathname, errorCode: error && /^[A-Z0-9_]{1,100}$/.test(error) ? error : null, steps, browserUsed: false, stored: false };
    }
    r = await send(u);
  }
  await r.body?.cancel();
  const memberUrl = previous.readRequests.member.url;
  const member = await send(memberUrl, { headers: { Accept: 'application/json' } });
  let data;
  try { data = await member.json(); } catch { throw fail('TOSS_LOGIN_MEMBER_RESPONSE_INVALID'); }
  if (member.status !== 200 || data?.resultType !== 'SUCCESS') return { authenticated: false, code: 'TOSS_LOGIN_AUTH_NOT_ESTABLISHED', steps, stored: false, browserUsed: false };
  if (!ownerMatches(data.success, previous.expectedOwner)) throw fail('TOSS_OWNER_MISMATCH');
  const cookies = jar.getCookiesSync('https://sharelink.toss.im/').filter(c => ['TBIZAUTH', 'TGSID'].includes(c.key)).map(c => ({ name: c.key, value: c.value, domain: c.hostOnly ? c.domain : '.' + c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expiryTime() === Infinity ? -1 : c.expiryTime() / 1000 }));
  const saved = persistSession({ ...previous, cookies, capturedAt: Date.now() });
  const owner = await check();
  const curation = await read('shopping-curation-sections');
  return { ...saved, ...owner, steps, sections: curation.data.success?.sections?.length ?? null, executionMode: 'pure_http', passwordPersisted: false };
}
