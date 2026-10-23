// Naver Creator Advisor (creator-advisor.naver.com) read-only client.
// Owner 2026-10-03: "네이버 크리에이터 어드바이저 먼저 붙여" — platform-native trends and our own channel analytics.
// Contract (bundle /assets/index-*.js, 2026-10-03): every call is GET /api/v6<path>?<query> on the same origin, with
// the owner's Naver login cookies (NID_AUT/NID_SES on .naver.com). The page answers 401/406 by sending the browser to
// /introduction or "/", so those statuses mean "session or channel not accepted", not "empty data".
// Cookies come from the DPAPI Naver session (session-vault.mjs); they are kept in memory and sent only to this origin.
import { pathToFileURL } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';

const ORIGIN = 'https://creator-advisor.naver.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SESSION_VAULT = new URL('../../../scripts/session-vault.mjs', import.meta.url);
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Observed query builders (names as the bundle uses them). Dates are YYYY-MM-DD; interval is day|week|month.
export const ENDPOINTS = Object.freeze({
  channels: () => ['/accounts/channels', {}],
  trendCategory: ({ service = 'naver_blog', contentType, interval = 'day', date, categories, limit = 20 }) =>
    ['/trend/category', { service, categories, contentType, interval, date, hasRankChange: true, limit }],
  trendDemo: ({ service = 'naver_blog', contentType, interval = 'day', date, age, gender, metric = 'cv', limit = 20 }) =>
    ['/trend/demo', { service, contentType, interval, metric, date, age, gender, hasRankChange: true, limit }],
  trendContents: ({ service = 'naver_blog', keyword, interval = 'day', date, limit = 20 }) =>
    ['/trend/trend-contents', { service, keyword, interval, date, limit }],
  searchInflowTrend: ({ service = 'naver_blog', keyword, interval = 'day', startDate, endDate }) =>
    ['/trend/search-inflow-trend', { service, interval, startDate, endDate, keyword }],
  popularCategoryKeyword: ({ service = 'naver_blog', channelId, date }) => ['/home/popular-category-keyword', { service, channelId, date }],
  popularDemoKeyword: ({ service = 'naver_blog', channelId, date }) => ['/home/popular-demo-keyword', { service, channelId, date }],
  soaringContents: ({ service = 'naver_blog', channelId, interval = 'day', date }) => ['/home/soaring-contents', { service, channelId, interval, date }],
  yesterdaySummary: ({ service = 'naver_blog', channelId, date }) => ['/home/yesterday-summary', { date, service, channelId }],
  // Owner browser GET observed 2026-10-05: ct is not a wire parameter here.
  // Legacy callers may still pass ct; omit it. Adding ct=text returned 400, removing only ct returned 200.
  referrerQueryRank: ({ service = 'naver_blog', channelId, metric = 'cv', interval = 'day', date, limit = 20 }) =>
    ['/inflow-analysis/referrer-query-rank', { service, channelId, metric, interval, date, limit }],
  revenueTrend: ({ service = 'naver_blog', channelId, contentType, interval = 'day', startDate, endDate }) =>
    ['/revenue/trend', { service, channelId, contentType, interval, startDate, endDate }],
  followerCount: ({ service = 'naver_blog', channelId, interval = 'day', startDate, endDate }) =>
    ['/integrated-analysis/follower-count', { service, channelId, interval, startDate, endDate }],
  // 통합 분석 > 조회수 순위 (bundle 2026-10-05: LF('cv-ranks', service, channelId, contentType, interval, date, limit)).
  // The blog page passes contentType 'text-and-moment' (글+클립); 'text' is 글 only. like/reply-ranks share the builder.
  contentRanks: ({ service = 'naver_blog', channelId, metric = 'cv', contentType, interval = 'day', date, limit = 20 }) =>
    [`/integrated-analysis/${{ cv: 'cv-ranks', like: 'like-ranks', reply: 'reply-ranks' }[metric] ?? fail('CREATOR_ADVISOR_METRIC')}`,
      { service, channelId, contentType, interval, date, limit }],
  // 수익 > 게시물별 수익 순위 (bundle 2026-10-05: tme).
  contentRevenueRanks: ({ service = 'naver_blog', channelId, contentType, interval = 'day', date, limit = 20 }) =>
    ['/revenue/content-revenue-ranks', { service, channelId, contentType, interval, date, limit }],
  // 유입 분석 > 검색어별 인기 게시물 (bundle 2026-10-05).
  popularContents: ({ service = 'naver_blog', channelId, keyword, metric = 'cv', contentType, interval = 'day', date, limit = 20 }) =>
    ['/inflow-analysis/popular-contents', { service, channelId, keyword, metric, contentType, interval, date, limit }],
});

export function buildUrl(path, query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return `${ORIGIN}/api/v6${path}${qs ? `?${qs}` : ''}`;
}

export function cookieHeader(cookies, rawUrl = ORIGIN, now = Date.now()) {
  const url = new URL(rawUrl);
  if (url.origin !== ORIGIN || url.username || url.password) fail('CREATOR_ADVISOR_COOKIE_SCOPE');
  const host = url.hostname;
  const picked = cookies.filter(c => c && typeof c.name === 'string' && typeof c.value === 'string' && c.value
    && (host === String(c.domain).replace(/^\./, '') || (String(c.domain).startsWith('.') && host.endsWith(c.domain)))
    && (c.expires === -1 || c.expires > now / 1000)
    && (url.pathname === (c.path || '/') || (url.pathname.startsWith(c.path || '/')
      && ((c.path || '/').endsWith('/') || url.pathname[(c.path || '/').length] === '/'))))
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  if (!['NID_AUT', 'NID_SES'].every(n => picked.some(c => c.name === n))) fail('CREATOR_ADVISOR_AUTH_MISSING');
  return picked.map(c => `${c.name}=${c.value}`).join('; ');
}

// The page signs data requests (bundle fJ/dJ, 2026-10-03): key = first "."-part of the __ca_key cookie the server sets
// on /api/v6/accounts/channels; X-CA-Sig = hex HMAC-SHA256(key, "GET|<pathname>|<ts ms>|<nonce>"), plus X-CA-Nonce,
// X-CA-Ts and an instanceId header (the page keeps one random id per tab). A 403 {code:"CA_KEY_INVALID"} means the key
// rotated: the page re-reads /accounts/channels once and retries, and so do we.
export function signHeaders(method, url, key, { now = Date.now(), nonce = randomUUID() } = {}) {
  const ts = String(now);
  const sig = createHmac('sha256', key).update(`${method.toUpperCase()}|${new URL(url).pathname}|${ts}|${nonce}`).digest('hex');
  return { 'X-CA-Nonce': nonce, 'X-CA-Ts': ts, 'X-CA-Sig': sig };
}

export function caKeyFrom(setCookies = []) {
  for (const line of setCookies) {
    const m = /^__ca_key=([^;]*)/.exec(line);
    if (m && m[1]) {
      let key;
      try { key = decodeURIComponent(m[1]).split('.')[0]; }
      catch { fail('CREATOR_ADVISOR_CA_KEY_INVALID'); }
      return { cookie: `__ca_key=${m[1]}`, key: key || null };
    }
  }
  return null;
}

// The jar starts from the DPAPI Naver session. Every response's Set-Cookie (NID_SES rotation, __ca_key) is merged in
// memory; when a merge changes the jar, the rotated session is written back through `persist` so the next process does
// not reuse a NID_SES the server already replaced (the stale-session failure seen 2026-10-03).
export function createClient({ cookies, userAgent = UA, fetchImpl = globalThis.fetch, minIntervalMs = 2000,
  merge = null, persist = null } = {}) {
  let jar = cookies.map(c => ({ ...c }));
  cookieHeader(jar);
  const instanceId = randomUUID();
  let last = 0, ca = null;
  const headers = (url, extra) => ({ cookie: cookieHeader(ca ? jar.filter(c => c.name !== '__ca_key') : jar, url) + (ca ? `; ${ca.cookie}` : ''), 'user-agent': userAgent,
    accept: 'application/json', 'accept-language': 'ko-KR,ko;q=0.9', referer: `${ORIGIN}/naver_blog/aicandoanything`, instanceId, ...extra });
  async function pace() { const wait = last + minIntervalMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); }
  async function absorb(res, url) {
    const next = caKeyFrom(res.headers.getSetCookie?.() ?? []);
    if (next?.key) ca = next;
    if (!merge) return;
    const update = merge(jar, res, url);
    if (update?.changed) { jar = update.cookies; if (persist) await persist(jar); }
  }
  async function refreshKey() {
    await pace();
    const url = buildUrl('/accounts/channels', {});
    const res = await fetchImpl(url, { headers: headers(url, {}), redirect: 'manual' });
    if (res.status === 401) fail('CREATOR_ADVISOR_REAUTH_REQUIRED', { httpStatus: 401 });
    await absorb(res, url);
    if (res.status === 400) fail('CREATOR_ADVISOR_BAD_REQUEST', { httpStatus: 400 });
    if (!res.ok) fail('CREATOR_ADVISOR_HTTP_ERROR', { httpStatus: res.status });
    // A valid existing __ca_key suppresses Set-Cookie on /channels. Re-read that scoped
    // jar cookie too, otherwise every subsequent GET unnecessarily bootstraps unsigned.
    if (!ca?.key) ca = caKeyFrom(cookieHeader(jar, url).split(';').map(s => s.trim()));
    if (!ca?.key) fail('CREATOR_ADVISOR_CA_KEY_MISSING');
    return res;
  }
  async function get(name, params = {}, retried = false) {
    const build = ENDPOINTS[name];
    if (!build) fail('CREATOR_ADVISOR_ENDPOINT_UNKNOWN');
    const [path, query] = build(params);
    if (path !== '/accounts/channels' && !ca) await refreshKey();
    await pace();
    const url = buildUrl(path, query);
    const res = await fetchImpl(url, { headers: headers(url, ca?.key ? signHeaders('GET', url, ca.key) : {}), redirect: 'manual' });
    await absorb(res, url);
    if (res.status === 403) {
      const body = await res.clone().json().catch(() => ({}));
      if (body?.code === 'CA_KEY_INVALID' && !retried) { await refreshKey(); return get(name, params, true); }
      fail('CREATOR_ADVISOR_FORBIDDEN', { httpStatus: 403, serviceCode: body?.code === 'CA_KEY_INVALID' ? 'CA_KEY_INVALID' : null });
    }
    if (res.status === 401) fail('CREATOR_ADVISOR_REAUTH_REQUIRED', { httpStatus: 401 });
    if (res.status === 406) fail('CREATOR_ADVISOR_CHANNEL_NOT_SELECTED', { httpStatus: 406 });
    if (res.status === 400) fail('CREATOR_ADVISOR_BAD_REQUEST', { httpStatus: 400 });
    if (res.status === 429) fail('CREATOR_ADVISOR_THROTTLED', { httpStatus: 429 });
    if (!res.ok) fail('CREATOR_ADVISOR_HTTP_ERROR', { httpStatus: res.status });
    if (!/json/i.test(res.headers.get('content-type') ?? '')) fail('CREATOR_ADVISOR_NOT_JSON', { httpStatus: res.status });
    return res.json();
  }
  return { get };
}

export async function loadClient(options = {}) {
  const { loadNaverCookies, mergeNaverSetCookies, storeNaverCookies } = await import(SESSION_VAULT.href);
  const session = await loadNaverCookies({ env: {} });
  const userAgent = session.userAgent || UA;
  return createClient({ cookies: session.cookies, userAgent, merge: mergeNaverSetCookies,
    persist: jar => storeNaverCookies(jar, { userAgent: session.userAgent ?? undefined }), ...options });
}

// CLI: node creator-advisor.mjs <endpoint> [--key=value ...]   (prints the JSON response; values never include cookies)
async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const params = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; }));
  const client = await loadClient();
  console.log(JSON.stringify(await client.get(name || 'channels', params), null, 1));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || 'CREATOR_ADVISOR_FAILED', httpStatus: e.httpStatus ?? null, serviceCode: e.serviceCode ?? null })); process.exitCode = 1; });
}
