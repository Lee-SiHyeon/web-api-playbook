import { createHash } from 'node:crypto';
import { readCredential } from '../../naver/apps/naver-blog-api/scripts/secure-credential-store.mjs';

// Read-only feasibility check. Values never leave process memory. No store writes.
const expectedHash = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(expectedHash || '')) throw new Error('EXPECTED_ACTOR_HASH_REQUIRED');
const source = readCredential('naver-blog-session');
if (!source) throw new Error('NAVER_SESSION_MISSING');
let bundle;
try { bundle = JSON.parse(source); } catch { throw new Error('NAVER_SESSION_INVALID'); }
const cookies = (bundle.cookies || []).filter(c => ['NID_AUT', 'NID_SES'].includes(c.name)
  && (c.expires === -1 || c.expires > Date.now() / 1000));
const origins = new Set(['https://apis.cafe.naver.com', 'https://article.cafe.naver.com', 'https://apis.naver.com']);
const referer = 'https://m.cafe.naver.com/ca-fe/web/cafes/serenacademmy/articles/21?useCafeId=false&tc';
async function get(url) {
  const target = new URL(url);
  if (!origins.has(target.origin)) throw new Error('ORIGIN_SCOPE');
  const scoped = cookies.filter(c => (target.hostname === c.domain.replace(/^\./, '')
    || (c.domain.startsWith('.') && target.hostname.endsWith(c.domain)))
    && (target.pathname === c.path || (target.pathname.startsWith(c.path)
      && (c.path.endsWith('/') || target.pathname[c.path.length] === '/'))));
  if (!['NID_AUT', 'NID_SES'].every(n => scoped.some(c => c.name === n))) throw new Error('AUTH_COOKIES_MISSING');
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/json, text/plain, */*', Referer: referer, 'X-Cafe-Product': 'mweb',
      ...(bundle.userAgent ? { 'User-Agent': bundle.userAgent } : {}),
      Cookie: scoped.map(c => `${c.name}=${c.value}`).join('; ') } });
  const body = await response.text();
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('json'))
    throw new Error(`HTTP_${response.status}_OR_NON_JSON`);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('INVALID_JSON'); }
  return { json, status: response.status, bytes: Buffer.byteLength(body) };
}
const evidence = [];
try {
  const identity = await get('https://apis.cafe.naver.com/home/v1/member/identifier?cafeUrl=serenacademmy');
  const actor = identity.json.message?.result;
  const identityMatch = actor?.loggedIn === true && typeof actor.userId === 'string'
    && createHash('sha256').update(actor.userId).digest('hex') === expectedHash;
  evidence.push({ operation: 'identity', status: identity.status, loggedIn: actor?.loggedIn === true, identityMatch });
  if (!identityMatch) throw new Error('CAFE_ACTOR_MISMATCH_OR_REAUTH_REQUIRED');
  if (process.argv.includes('--identity-only')) {
    console.log(JSON.stringify({ ok: true, cookieNames: cookies.map(c => c.name), browserUsed: false, storeWritten: false, evidence }));
    process.exit(0);
  }
  const member = await get('https://apis.naver.com/cafe-web/cafe2/CafeMemberInfo.json?cafeId=31714934');
  evidence.push({ operation: 'member', status: member.status, cafeMember: member.json.message?.result?.cafeMember === true,
    memberLevelName: member.json.message?.result?.memberLevelName });
  if (member.json.message?.result?.cafeMember !== true) throw new Error('CAFE_MEMBERSHIP_REQUIRED');
  const article = await get('https://article.cafe.naver.com/gw/v4/cafes/serenacademmy/articles/21?useCafeId=false');
  evidence.push({ operation: 'article_without_buid', status: article.status, bytes: article.bytes,
    cafeId: article.json.result?.cafeId, articleId: article.json.result?.articleId,
    loggedIn: article.json.result?.user?.isLogin, cafeMember: article.json.result?.user?.isCafeMember,
    readable: article.json.result?.article?.isReadable, attachmentCount: article.json.result?.attaches?.length });
  const list = await get('https://apis.naver.com/cafe-web/cafe2/ArticleListV3dot1.json?search.clubid=31714934&search.queryType=lastArticle&search.page=1&search.perPage=50&newPopularArticle=true');
  evidence.push({ operation: 'list_without_ad_tracking', status: list.status, cafeId: list.json.message?.result?.cafeId,
    itemCount: list.json.message?.result?.articleList?.length,
    firstItemFields: Object.keys(list.json.message?.result?.articleList?.[0] || {}),
    articleCount: list.json.message?.result?.articleList?.filter(x => x.type === 'ARTICLE' || (x.articleId != null && typeof x.subject === 'string')).length,
    hasNext: list.json.message?.result?.hasNext,
    nextRequestParameter: list.json.message?.result?.nextRequestParameter });
  console.log(JSON.stringify({ ok: true, provider: 'existing_naver_dpapi_verified_for_cafe_in_memory', browserUsed: false, storeWritten: false, evidence }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CAFE_PROBE_FAILED', evidence }));
  process.exitCode = 1;
}
