import { createDecipheriv } from 'node:crypto';

export const ORIGIN = 'https://m.oliveyoung.co.kr';
const PREFIX = '/review/api/affiliate/v1';
export const SESSION_COOKIE_NAMES = Object.freeze(['OYSESSIONID', 'linkageString', '__cf_bm', '_cfuvid']);
const COOKIE_DOMAINS = new Set(['m.oliveyoung.co.kr', '.m.oliveyoung.co.kr', '.oliveyoung.co.kr']);
const PATHS = Object.freeze({
  refresh: '/m/login/additionalInfo.do', status: `${PREFIX}/education/status`,
  ranking: `${PREFIX}/activities/ranking`, search: `${PREFIX}/activities/search`,
  generated: `${PREFIX}/activities/generated`, landing: `${PREFIX}/activities/landing`,
  shorten: '/base/shorten/v2/verified',
});

export class OliveyoungError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'OliveyoungError'; this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new OliveyoungError(code, details); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const cleanHeader = value => typeof value === 'string' && value.length <= 16384 && !/[\r\n\0]/.test(value);
const identifier = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[A-Za-z0-9_-]{1,100}$/.test(String(value));

export function selectSessionCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length > 300) fail('SESSION_INPUT');
  return cookies.filter(cookie => object(cookie) && SESSION_COOKIE_NAMES.includes(cookie.name)
    && COOKIE_DOMAINS.has(cookie.domain) && typeof cookie.path === 'string' && cookie.path.startsWith('/')
    && typeof cookie.value === 'string' && cookie.value.length <= 16384
    && !/[^\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]/.test(cookie.value))
    .map(({ name, value, domain, path, expires, secure }) => ({ name, value, domain, path, expires, secure }));
}

// Same decoding as official public module 24474, not a login or signature bypass.
// The public web-client format constant is not an account credential.
function decodeLinkageString(value) {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{32})+$/.test(value)) fail('AUTH_REQUIRED');
  try {
    const decoder = createDecipheriv('aes-128-ecb', Buffer.from('cjone_g4de7353f1'), null);
    const token = Buffer.concat([decoder.update(Buffer.from(value, 'hex')), decoder.final()]).toString('utf8');
    if (!cleanHeader(token) || !token) fail('AUTH_REQUIRED');
    return token;
  } catch { fail('AUTH_REQUIRED'); }
}

// Public module 73262 supplies this minute-scoped header for the same-origin shortener.
export function shortenerHeader(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).map(part => [part.type, part.value]));
  const minute = ['year', 'month', 'day', 'hour', 'minute'].map(key => parts[key]).join('');
  return Buffer.from(`e3ea1c526eef4570946ebdf083dad7a7:shrt-auth:${minute}`).toString('base64');
}

export function productNumber(input) {
  if (typeof input !== 'string') fail('INPUT_GOODS');
  if (/^[A-Za-z0-9_-]{1,100}$/.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { fail('INPUT_GOODS'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['m.oliveyoung.co.kr', 'www.oliveyoung.co.kr'].includes(url.hostname)
    || !['/m/goods/getGoodsDetail.do', '/store/goods/getGoodsDetail.do'].includes(url.pathname)
    || url.searchParams.getAll('goodsNo').length !== 1) fail('INPUT_GOODS');
  const goods = url.searchParams.get('goodsNo');
  if (!identifier(goods)) fail('INPUT_GOODS');
  return goods;
}

function activityFields(value) {
  if (!object(value) || !['goodsNumber', 'affiliateActivityId', 'affiliatePartnerId'].every(key => identifier(value[key]))) fail('RESPONSE_SCHEMA');
  return Object.fromEntries(['goodsNumber', 'affiliateActivityId', 'affiliatePartnerId'].map(key => [key, value[key]]));
}

function activityUrl(activity) {
  const url = new URL('/m/goods/getGoodsDetail.do', ORIGIN);
  url.search = new URLSearchParams({ goodsNo: activity.goodsNumber, utm_source: 'shutter',
    utm_medium: 'affiliate', utm_content: `OY_${activity.affiliateActivityId}` }).toString();
  return url.href;
}

function shortCode(value) {
  let url;
  try { url = new URL(value); } catch { fail('RESPONSE_SCHEMA'); }
  if (url.protocol !== 'https:' || url.host !== 'oy.run' || url.username || url.password
    || url.search || url.hash || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname)) fail('RESPONSE_SCHEMA');
  return url.pathname.slice(1);
}

function pageParameters(input = {}) {
  const pageNumber = input.pageNumber ?? 0, pageSize = input.pageSize ?? 10;
  if (!Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber > 10000
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) fail('INPUT_PAGINATION');
  return { pageNumber, pageSize };
}

export function createOliveyoungClient(session, { fetchImpl = fetch, now = () => new Date(), timeoutMs = 15000 } = {}) {
  if (!object(session)) fail('SESSION_REQUIRED');
  let cookies = selectSessionCookies(session.cookies ?? []);
  let authorization = session.authorization ?? '';
  if (!cleanHeader(authorization) || !cleanHeader(session.userAgent ?? '')
    || ![undefined, false, true].includes(session.gateway)) fail('SESSION_INPUT');
  if (!authorization && !cookies.length) fail('SESSION_REQUIRED');
  const secrets = new Set([authorization, ...cookies.map(cookie => cookie.value)].filter(Boolean));
  const cookieHeader = pathname => cookies.filter(cookie => (cookie.expires === undefined || cookie.expires < 0 || cookie.expires * 1000 > now().getTime())
    && (pathname === cookie.path || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
    .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  function absorbCookies(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attributes] = raw.split(';');
      const equals = pair.indexOf('=');
      if (equals < 1) continue;
      const attrs = Object.fromEntries(attributes.map(item => { const [key, ...rest] = item.trim().split('='); return [key.toLowerCase(), rest.join('=')]; }));
      const cookie = { name: pair.slice(0, equals), value: pair.slice(equals + 1),
        domain: attrs.domain ? `.${attrs.domain.replace(/^\./, '').toLowerCase()}` : 'm.oliveyoung.co.kr', path: attrs.path || '/', secure: 'secure' in attrs,
        expires: attrs['max-age'] !== undefined ? now().getTime() / 1000 + Number(attrs['max-age']) : attrs.expires ? Date.parse(attrs.expires) / 1000 : -1 };
      if (!selectSessionCookies([cookie]).length) continue;
      cookies = cookies.filter(existing => !(existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path));
      cookies.push(cookie);
      if (cookie.value) secrets.add(cookie.value);
    }
  }
  async function request(path, { method = 'GET', query, body, headers = {}, anonymous = false } = {}) {
    if (!Object.values(PATHS).includes(path) && !/^\/base\/shorten\/detail\/[A-Za-z0-9_-]+$/.test(path)) fail('ENDPOINT_NOT_ALLOWED');
    const url = new URL(path, ORIGIN);
    if (query) url.search = new URLSearchParams(query).toString();
    const outgoing = { Accept: 'application/json', ...headers };
    const cookie = cookieHeader(url.pathname);
    if (cookie) outgoing.Cookie = cookie;
    if (!anonymous && authorization) outgoing.Authorization = authorization;
    if (session.userAgent) outgoing['User-Agent'] = session.userAgent;
    if (session.gateway === true) outgoing['X-OY-GW'] = 'Y';
    if (body !== undefined) outgoing['Content-Type'] = 'application/json';
    let response, text = '';
    try {
      response = await fetchImpl(url.href, { method, headers: outgoing, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      absorbCookies(response);
      if (response.status === 401) fail('AUTH_REQUIRED');
      if (response.status === 403) fail('ACCESS_BLOCKED', { httpStatus: 403 });
      if (response.status >= 300 && response.status < 400) fail('REDIRECT_BLOCKED', { httpStatus: response.status });
      if (response.status === 429) fail('RATE_LIMITED');
      if (!response.ok) fail(method === 'POST' ? 'WRITE_OUTCOME_UNKNOWN' : 'HTTP_ERROR', { httpStatus: response.status });
      if (Number(response.headers.get('content-length')) > 2097152) fail('RESPONSE_SIZE');
      if (!response.body) fail('RESPONSE_SCHEMA');
      const decoder = new TextDecoder(); let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 2097152) fail('RESPONSE_SIZE');
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      if (/^\s*</.test(text)) fail('HTML_RESPONSE');
      let result;
      try { result = JSON.parse(text); } catch { fail('RESPONSE_JSON'); }
      if (!object(result)) fail('RESPONSE_SCHEMA');
      if (result.code !== undefined && String(result.code) !== '200') {
        if (String(result.code) === '3000') fail('AUTH_REQUIRED');
        fail('SERVICE_REJECTED', { serviceCode: /^[A-Za-z0-9_-]{1,30}$/.test(String(result.code)) ? String(result.code) : 'unknown' });
      }
      return result;
    } catch (error) {
      const uncertain = !(error instanceof OliveyoungError) || ['RESPONSE_SIZE', 'RESPONSE_SCHEMA', 'RESPONSE_JSON', 'HTML_RESPONSE'].includes(error.code);
      if (method === 'POST' && uncertain) fail('WRITE_OUTCOME_UNKNOWN');
      if (error instanceof OliveyoungError) throw error;
      fail('NETWORK_ERROR');
    } finally { text = ''; }
  }
  async function ensureAuthorization() {
    if (authorization) return;
    const response = await request(PATHS.refresh, { anonymous: true, query: {
      refreshYn: 'Y', referrer: `${ORIGIN}/m/mtn/affiliate/product/search`, reqSystem: 'mtn',
    } });
    if (!response.linkageString) fail('AUTH_REQUIRED');
    secrets.add(response.linkageString);
    authorization = decodeLinkageString(response.linkageString);
    secrets.add(authorization);
  }
  async function read(name, query) {
    await ensureAuthorization();
    const response = await request(PATHS[name], { query });
    if (!Object.hasOwn(response, 'data')) fail('RESPONSE_SCHEMA');
    return response;
  }
  async function status() {
    const { data } = await read('status');
    if (!object(data) || typeof data.isAffiliate !== 'boolean'
      || (data.isAffiliate && typeof data.needsEducation !== 'boolean')) fail('RESPONSE_SCHEMA');
    return { isAffiliate: data.isAffiliate, needsEducation: data.needsEducation ?? null,
      ready: data.isAffiliate && data.needsEducation === false };
  }
  async function requireReady() {
    const result = await status();
    if (!result.isAffiliate) fail('CURATOR_ENROLLMENT_REQUIRED');
    if (result.needsEducation) fail('CURATOR_EDUCATION_REQUIRED');
  }
  async function generated(input) {
    const response = await read('generated', pageParameters(input));
    if (!Array.isArray(response.data)) fail('RESPONSE_SCHEMA');
    return { data: response.data, pagination: response.pagination };
  }
  async function findActivity(goodsNumber, activityId) {
    // Do not issue another attribution ID if the account's complete history could not be checked.
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await generated({ pageNumber, pageSize: 10 });
      for (const item of page.data) {
        if (String(item?.generatedActivity?.goodsNumber) !== goodsNumber) continue;
        const activity = activityFields(item.generatedActivity);
        if (activityId === undefined || String(activity.affiliateActivityId) === String(activityId)) return activity;
      }
      if (page.pagination?.isLastPage === true) return null;
      if (page.pagination?.isLastPage !== false || page.pagination?.pageNumber !== pageNumber) fail('RESPONSE_PAGINATION');
    }
    fail('HISTORY_INCOMPLETE');
  }
  async function finishLink(activity, reused) {
    const originalUrl = activityUrl(activity);
    try {
      const response = await request(PATHS.shorten, { method: 'POST',
        headers: { 'x-api-key': shortenerHeader(now()) },
        body: [{ originalUrl, registerId: activity.affiliatePartnerId }] });
      const shortenedUrl = response.data?.[0]?.shortenedUrl;
      const code = shortCode(shortenedUrl);
      const resolved = await request(`/base/shorten/detail/${code}`);
      if (resolved.originalUrl !== originalUrl) fail('LINK_VERIFICATION_FAILED');
      return { activity, originalUrl, shortenedUrl, reused, verified: true };
    } catch (error) {
      fail('LINK_INCOMPLETE', { outcome: reused ? 'existing_activity' : 'activity_created', activity,
        causeCode: error instanceof OliveyoungError ? error.code : 'UNKNOWN_ERROR', resumeOperation: 'completeLink' });
    }
  }
  return Object.freeze({
    status,
    async ranking() { const { data } = await read('ranking'); if (!Array.isArray(data)) fail('RESPONSE_SCHEMA'); return { data }; },
    async search(input) {
      if (!object(input) || typeof input.keyword !== 'string' || !input.keyword.trim() || input.keyword.length > 200) fail('INPUT_KEYWORD');
      const response = await read('search', { keyword: input.keyword, ...pageParameters(input) });
      if (!Array.isArray(response.data)) fail('RESPONSE_SCHEMA');
      return { data: response.data, pagination: response.pagination };
    },
    generated,
    async createLink(input) {
      const goodsNumber = productNumber(input?.goodsNumber ?? input?.productUrl);
      if (!identifier(input?.categoryNumber)) fail('INPUT_CATEGORY');
      await requireReady();
      const existing = await findActivity(goodsNumber);
      if (existing) return finishLink(existing, true);
      const response = await request(PATHS.landing, { method: 'POST', body: { goodsNumber, categoryNumber: input.categoryNumber } });
      let activity;
      try { activity = activityFields(response.data); if (String(activity.goodsNumber) !== goodsNumber) fail('RESPONSE_SCHEMA'); }
      catch { fail('WRITE_OUTCOME_UNKNOWN', { stage: 'landing', nextOperation: 'generated' }); }
      return finishLink(activity, false);
    },
    async completeLink(input) {
      const goodsNumber = productNumber(input?.goodsNumber ?? input?.productUrl);
      if (!identifier(input?.affiliateActivityId)) fail('INPUT_ACTIVITY');
      await requireReady();
      const existing = await findActivity(goodsNumber, input.affiliateActivityId);
      if (!existing) fail('ACTIVITY_NOT_FOUND');
      return finishLink(existing, true);
    },
    assertSafeOutput(value) {
      const encoded = JSON.stringify(value);
      if ([...secrets].some(secret => encoded.includes(secret) || encoded.includes(JSON.stringify(secret).slice(1, -1)))) fail('OUTPUT_REDACTED');
      return value;
    },
  });
}

export async function runOliveyoungEnvelope(envelope, options) {
  if (!object(envelope) || !['status', 'ranking', 'search', 'generated', 'createLink', 'completeLink'].includes(envelope.operation)) fail('INPUT_OPERATION');
  const client = createOliveyoungClient(envelope.session, options);
  try {
    const result = await client[envelope.operation](envelope.input);
    return client.assertSafeOutput({ ok: true, operation: envelope.operation, result });
  } catch (error) {
    // Also filter safe error checkpoints against the in-memory session material.
    return client.assertSafeOutput(oliveyoungErrorResult(error));
  }
}

export function oliveyoungErrorResult(error) {
  return { ok: false, error: error instanceof OliveyoungError ? error.code : 'INTERNAL_ERROR',
    ...(error instanceof OliveyoungError ? { details: error.details } : {}) };
}
