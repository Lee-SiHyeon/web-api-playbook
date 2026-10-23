import { createHash } from 'node:crypto';
import { credentialExists, readCredential, writeCredential } from '../../naver/apps/naver-blog-api/scripts/secure-credential-store.mjs';
import { freshHttpsFetch } from './fresh-https.mjs';

export const DEFAULT_CAFE = Object.freeze({ id: '31714934', slug: 'serenacademmy', articleId: '21' });
export const CAFE_SESSION_KEY = 'naver-cafe-session';
export const CAFE_SESSION_STATE_KEY = 'naver-cafe-session-state';
export const CAFE_ORIGINS = Object.freeze([
  'https://apis.cafe.naver.com',
  'https://article.cafe.naver.com',
  'https://apis.naver.com',
]);
export const CAFE_ATTACHMENT_ORIGIN = 'https://downapi.cafe.naver.com';

const COOKIE_AUTH_NAMES = Object.freeze(['NID_AUT', 'NID_SES']);
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const NAVER_DOMAIN = /^(?:\.)?(?:[a-z0-9-]+\.)*naver\.com$/i;
const HASH = /^[a-f0-9]{64}$/i;
const CAFE_SLUG = /^[A-Za-z0-9_-]{1,80}$/;
const NUMERIC_ID = /^\d{1,24}$/;
const headerNames = new Set(['accept', 'referer', 'x-cafe-product', 'user-agent']);
const defaultAccept = 'application/json, text/plain, */*';

export class CafeApiError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'CafeApiError';
    this.code = code;
    this.details = details;
  }
}

function assertContext(context = {}) {
  const cafeId = String(context.cafeId ?? DEFAULT_CAFE.id);
  const cafeSlug = String(context.cafeSlug ?? DEFAULT_CAFE.slug);
  if (!NUMERIC_ID.test(cafeId) || !CAFE_SLUG.test(cafeSlug)) throw new CafeApiError('INPUT', 'Invalid cafe scope');
  return { cafeId, cafeSlug };
}

function scopedCredentialKeys(context) {
  const normalized = assertContext(context);
  if (normalized.cafeId === DEFAULT_CAFE.id && normalized.cafeSlug === DEFAULT_CAFE.slug) {
    return { session: CAFE_SESSION_KEY, state: CAFE_SESSION_STATE_KEY };
  }
  const scopeHash = createHash('sha256')
    .update(`${normalized.cafeId}\n${normalized.cafeSlug}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return {
    session: `naver-cafe-session-${scopeHash}`,
    state: `naver-cafe-session-state-${scopeHash}`,
  };
}

function validCookie(cookie) {
  return cookie && typeof cookie.name === 'string' && COOKIE_NAME.test(cookie.name)
    && typeof cookie.value === 'string' && COOKIE_VALUE.test(cookie.value)
    && typeof cookie.domain === 'string' && NAVER_DOMAIN.test(cookie.domain)
    && typeof cookie.path === 'string' && cookie.path.startsWith('/')
    && !/[\x00-\x20\x7f;]/.test(cookie.path)
    && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires);
}

function live(cookie, now) {
  return cookie.expires === -1 || cookie.expires > now / 1000;
}

function normalizeCookies(cookies, now = Date.now(), { authenticationRequired = true } = {}) {
  if (!Array.isArray(cookies) || cookies.length > 1024) throw new CafeApiError('SESSION_INVALID', 'Stored session is invalid');
  const normalized = cookies.filter(validCookie).filter(cookie => live(cookie, now))
    .map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain.toLowerCase(),
      path: cookie.path,
      secure: cookie.secure === true,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly === true,
      ...(typeof cookie.sameSite === 'string' ? { sameSite: cookie.sameSite.slice(0, 32) } : {}),
    }));
  if (authenticationRequired && !COOKIE_AUTH_NAMES.every(name => normalized.some(cookie => cookie.name === name && cookie.value))) {
    throw new CafeApiError('AUTH_MISSING', 'A current Naver authentication session is unavailable');
  }
  return normalized;
}

function normalizeCafeAuthCookies(cookies, now = Date.now(), { authenticationRequired = true } = {}) {
  const normalized = normalizeCookies(cookies, now, { authenticationRequired: false })
    .filter(cookie => COOKIE_AUTH_NAMES.includes(cookie.name));
  if (authenticationRequired && !COOKIE_AUTH_NAMES.every(name => normalized.some(cookie => cookie.name === name && cookie.value))) {
    throw new CafeApiError('AUTH_MISSING', 'A current Naver authentication session is unavailable');
  }
  return normalized;
}

function cookieDomainMatches(host, domain) {
  const bare = domain.replace(/^\./, '');
  return host === bare || (domain.startsWith('.') && host.endsWith(domain));
}

function pathMatches(urlPath, cookiePath) {
  return urlPath === cookiePath || (urlPath.startsWith(cookiePath)
    && (cookiePath.endsWith('/') || urlPath[cookiePath.length] === '/'));
}

function allowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new CafeApiError('SCOPE', 'Invalid request URL'); }
  if (!CAFE_ORIGINS.includes(url.origin) || url.username || url.password || url.hash) {
    throw new CafeApiError('SCOPE', 'Request is outside the observed Naver Cafe origins');
  }
  return url;
}

function requireId(value, label) {
  const id = String(value ?? '');
  if (!NUMERIC_ID.test(id)) throw new CafeApiError('INPUT', `Invalid ${label}`);
  return id;
}

function requireSlug(value) {
  const slug = String(value ?? '');
  if (!CAFE_SLUG.test(slug)) throw new CafeApiError('INPUT', 'Invalid cafe slug');
  return slug;
}

function pageNumber(value) {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new CafeApiError('INPUT', 'Invalid page number');
  return String(page);
}

function menuNumber(value) {
  const menu = Number(value);
  if (!Number.isSafeInteger(menu) || menu < 1 || menu > 10000000) throw new CafeApiError('INPUT', 'Invalid cafe menu');
  return String(menu);
}

function pageReferer(slug, articleId = DEFAULT_CAFE.articleId) {
  return `https://m.cafe.naver.com/ca-fe/web/cafes/${requireSlug(slug)}/articles/${requireId(articleId, 'article ID')}?useCafeId=false&tc`;
}

function addQuery(url, entries) {
  for (const [key, value] of entries) url.searchParams.append(key, value);
  return url;
}

export function buildObservedCafeRequest(operation, args = {}) {
  const fieldsByOperation = {
    identity: ['cafeId', 'cafeSlug', 'refererArticleId'],
    member: ['cafeId', 'cafeSlug', 'refererArticleId'],
    article: ['cafeId', 'cafeSlug', 'articleId', 'refererArticleId', 'maxBytes'],
    comments: ['cafeId', 'cafeSlug', 'articleId', 'refererArticleId', 'maxBytes'],
    list: ['cafeId', 'cafeSlug', 'page', 'menu', 'refererArticleId', 'maxBytes'],
    search: ['cafeId', 'cafeSlug', 'query', 'page', 'menu', 'refererArticleId', 'maxBytes'],
    menus: ['cafeId', 'cafeSlug', 'refererArticleId', 'maxBytes'],
  };
  if (!fieldsByOperation[operation]) throw new CafeApiError('UNOBSERVED', 'Operation is not in the observed Cafe read catalog');
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !fieldsByOperation[operation].includes(key))) {
    throw new CafeApiError('INPUT', 'Operation contains unsupported request fields');
  }
  const context = assertContext(args);
  const cafeId = context.cafeId;
  const slug = context.cafeSlug;
  const refererArticleId = args.refererArticleId ?? DEFAULT_CAFE.articleId;
  const referer = pageReferer(slug, refererArticleId);
  let url;
  let queryFields;

  switch (operation) {
    case 'identity':
      url = addQuery(new URL('/home/v1/member/identifier', CAFE_ORIGINS[0]), [['cafeUrl', slug]]);
      queryFields = ['cafeUrl'];
      break;
    case 'member':
      url = addQuery(new URL('/cafe-web/cafe2/CafeMemberInfo.json', CAFE_ORIGINS[2]), [['cafeId', cafeId]]);
      queryFields = ['cafeId'];
      break;
    case 'article': {
      const articleId = requireId(args.articleId, 'article ID');
      url = addQuery(new URL(`/gw/v4/cafes/${slug}/articles/${articleId}`, CAFE_ORIGINS[1]), [['useCafeId', 'false']]);
      queryFields = ['useCafeId'];
      break;
    }
    case 'comments': {
      const articleId = requireId(args.articleId, 'article ID');
      url = addQuery(new URL(`/gw/v4/cafes/${cafeId}/articles/${articleId}/comments`, CAFE_ORIGINS[1]), [
        ['requestFrom', 'B'], ['orderBy', 'asc'], ['fromPopular', 'false'],
      ]);
      queryFields = ['fromPopular', 'orderBy', 'requestFrom'];
      break;
    }
    case 'list': {
      const entries = [
        ['search.clubid', cafeId],
        ['search.queryType', 'lastArticle'],
      ];
      if (args.menu != null) entries.push(['search.menuid', menuNumber(args.menu)]);
      entries.push(['search.page', pageNumber(args.page ?? 1)], ['search.perPage', '50']);
      url = addQuery(new URL('/cafe-web/cafe2/ArticleListV3dot1.json', CAFE_ORIGINS[2]), entries);
      queryFields = entries.map(([key]) => key).sort();
      break;
    }
    case 'search': {
      const query = args.query;
      if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\r\n\0]/.test(query)) {
        throw new CafeApiError('INPUT', 'Invalid Cafe search query');
      }
      const entries = [
        ['query', query.trim()],
        ['searchBy', '0'],
        ['sortBy', 'RECENCY'],
        ['views', 'MEMBER_LEVEL,COUNT,SALE_INFO,CAFE_MENU'],
      ];
      if (args.menu != null) entries.push(['menuId', menuNumber(args.menu)]);
      entries.push(['page', pageNumber(args.page ?? 1)], ['perPage', '20']);
      url = addQuery(new URL(`/cafe-web/cafe-search-api/v2/cafes/${cafeId}/search/articles`, CAFE_ORIGINS[2]), entries);
      queryFields = entries.map(([key]) => key).sort();
      break;
    }
    case 'menus':
      url = addQuery(new URL('/cafe-web/cafe2/SideMenuList', CAFE_ORIGINS[2]), [['cafeId', cafeId]]);
      queryFields = ['cafeId'];
      break;
    default:
      throw new CafeApiError('UNOBSERVED', 'Operation is not in the observed Cafe read catalog');
  }

  return Object.freeze({ operation, url, referer, queryFields: Object.freeze(queryFields) });
}

function buildManagerRequest(operation, args, context) {
  const cafeId = context.cafeId;
  const adminReferer = `https://cafe.naver.com/ca-fe/admin/cafes/${cafeId}/menu-management`;
  const mobileBase = 'https://apis.naver.com/cafe-web/cafe-mobile';
  let method = 'GET';
  let url;
  let body = null;
  let contentType = null;
  let referer = adminReferer;
  const menuId = args.menuId == null ? null : requireId(args.menuId, 'menu ID');
  const articleId = args.articleId == null ? null : requireId(args.articleId, 'article ID');

  switch (operation) {
    case 'managerMenus':
      url = new URL(`${mobileBase}/ManageMenuList.json`);
      url.searchParams.set('cafeId', cafeId);
      break;
    case 'managerMenuInfo':
      if (!menuId) throw new CafeApiError('INPUT', 'Menu ID is required');
      url = new URL(`${mobileBase}/ManageMenuInfo.json`);
      url.searchParams.set('cafeId', cafeId);
      url.searchParams.set('menuId', menuId);
      break;
    case 'articleEditor':
      if (!menuId) throw new CafeApiError('INPUT', 'Menu ID is required');
      url = new URL(`https://apis.cafe.naver.com/editor/v2/cafes/${cafeId}/editor`);
      if(articleId) url.searchParams.set('articleId', articleId);
      url.searchParams.set('menuId', menuId);
      url.searchParams.set('from', 'pc');
      referer = articleId ? `https://cafe.naver.com/ca-fe/cafes/${cafeId}/articles/${articleId}/modify` : `https://cafe.naver.com/ca-fe/cafes/${cafeId}/menus/${menuId}/articles/write`;
      break;
    case 'menuDeletableCheck':
      if (!menuId) throw new CafeApiError('INPUT', 'Menu ID is required');
      method = 'POST';
      url = new URL(`${mobileBase}/ManageMenuDeletableCheck.json`);
      body = new URLSearchParams({ cafeId, menuId }).toString();
      contentType = 'application/x-www-form-urlencoded';
      break;
    case 'menuSave':
      if (!args.editedMenuInfo || typeof args.editedMenuInfo !== 'object' || Array.isArray(args.editedMenuInfo)) {
        throw new CafeApiError('INPUT', 'Menu save payload is required');
      }
      method = 'POST';
      url = new URL(`${mobileBase}/ManageMenuListSave.json`);
      body = new URLSearchParams({
        cafeId,
        editedMenuInfo: encodeURIComponent(JSON.stringify(args.editedMenuInfo)),
      }).toString();
      contentType = 'application/x-www-form-urlencoded';
      break;
    case 'articleCreate':
    case 'articleUpdate': {
      if (!args.article || typeof args.article !== 'object' || Array.isArray(args.article)
        || String(args.article.cafeId) !== cafeId || !menuId
        || (operation === 'articleUpdate' && !articleId)) {
        throw new CafeApiError('INPUT', 'Scoped Cafe article payload is required');
      }
      method = 'POST';
      url = new URL(operation === 'articleCreate'
        ? `https://apis.cafe.naver.com/editor/v2.0/cafes/${cafeId}/menus/${menuId}/articles`
        : `https://apis.cafe.naver.com/editor/v2.0/cafes/${cafeId}/articles/${articleId}`);
      body = JSON.stringify({ article: args.article });
      contentType = 'application/json';
      referer = operation === 'articleCreate'
        ? `https://cafe.naver.com/ca-fe/cafes/${cafeId}/menus/${menuId}/articles/write`
        : `https://cafe.naver.com/ca-fe/cafes/${cafeId}/articles/${articleId}/modify`;
      break;
    }
    case 'articleDelete':
      if (!articleId) throw new CafeApiError('INPUT', 'Article ID is required');
      method = 'POST';
      url = new URL(`${mobileBase}/ArticleDelete.json`);
      body = new URLSearchParams({
        cafeId, articleId, requestFrom: 'A',
        ...(args.articleRemoveReasonNo == null ? {} : { articleRemoveReasonNo: String(args.articleRemoveReasonNo) }),
        ...(args.articleRemoveReason == null ? {} : { articleRemoveReason: String(args.articleRemoveReason) }),
      }).toString();
      contentType = 'application/x-www-form-urlencoded';
      referer = `https://cafe.naver.com/ca-fe/cafes/${cafeId}/articles/${articleId}`;
      break;
    default:
      throw new CafeApiError('UNOBSERVED', 'Operation is outside the captured Cafe management catalog');
  }
  if (!CAFE_ORIGINS.includes(url.origin)) throw new CafeApiError('SCOPE', 'Cafe management origin is not allowed');
  return { operation, method, url, body, contentType, referer };
}

function selectCafeCookieHeader(cookies, rawUrl, now = Date.now(), { attachment = false } = {}) {
  const url = attachment ? normalizeAttachmentUrl(rawUrl) : allowedUrl(rawUrl);
  const selected = normalizeCookies(cookies, now, { authenticationRequired: false })
    .filter(cookie => COOKIE_AUTH_NAMES.includes(cookie.name)
      && cookieDomainMatches(url.hostname, cookie.domain)
      && pathMatches(url.pathname, cookie.path))
    .sort((a, b) => b.path.length - a.path.length);
  const names = new Set(selected.map(cookie => cookie.name));
  if (!COOKIE_AUTH_NAMES.every(name => names.has(name))) {
    throw new CafeApiError('AUTH_MISSING', 'Current Naver authentication cookies do not cover this Cafe request');
  }
  return selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function normalizeUserAgent(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[^\x20-\x7e]/.test(value)) {
    throw new CafeApiError('SESSION_INVALID', 'Stored browser identity is invalid');
  }
  return value;
}

function normalizeHeaders(referer, userAgent) {
  let refererUrl;
  try { refererUrl = new URL(referer); } catch { throw new CafeApiError('INPUT', 'Invalid Cafe referer'); }
  if (refererUrl.origin !== 'https://m.cafe.naver.com' || refererUrl.username || refererUrl.password
    || !/^\/ca-fe\/web\/cafes\/[A-Za-z0-9_-]+\/articles\/\d+$/.test(refererUrl.pathname)
    || refererUrl.search !== '?useCafeId=false&tc') {
    throw new CafeApiError('SCOPE', 'Referer is outside the observed Cafe page scope');
  }
  const entries = [
    ['accept', defaultAccept],
    ['referer', refererUrl.href],
    ['x-cafe-product', 'mweb'],
  ];
  if (userAgent) entries.push(['user-agent', userAgent]);
  const headers = new Headers();
  for (const [name, value] of entries) {
    if (!headerNames.has(name) || value.length > 512 || /[\r\n]/.test(value)) throw new CafeApiError('INPUT', 'Invalid request headers');
    headers.set(name, value);
  }
  return headers;
}

function normalizeAttachmentUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new CafeApiError('ATTACHMENT_SCOPE', 'Invalid Cafe attachment URL'); }
  if (url.origin !== CAFE_ATTACHMENT_ORIGIN || url.username || url.password || url.search || url.hash
    || !/^\/v1\.0\/cafes\/article\/file\/[a-f0-9-]+\/download$/i.test(url.pathname)) {
    throw new CafeApiError('ATTACHMENT_SCOPE', 'Attachment URL is outside the observed Naver Cafe download route');
  }
  return url;
}

function normalizeAttachmentReferer(referer, userAgent) {
  let refererUrl;
  try { refererUrl = new URL(referer); } catch { throw new CafeApiError('INPUT', 'Invalid Cafe attachment referer'); }
  if (refererUrl.origin !== 'https://m.cafe.naver.com' || refererUrl.username || refererUrl.password
    || !/^\/ca-fe\/web\/cafes\/[A-Za-z0-9_-]+\/articles\/\d+$/.test(refererUrl.pathname)
    || refererUrl.search !== '?useCafeId=false&tc') {
    throw new CafeApiError('ATTACHMENT_SCOPE', 'Attachment referer is outside the observed Cafe page scope');
  }
  const headers = new Headers({
    accept: '*/*',
    referer: refererUrl.href,
    'x-cafe-product': 'mweb',
  });
  if (userAgent) headers.set('user-agent', userAgent);
  return headers;
}

function unwrapBundle(value, context, now = Date.now()) {
  let bundle;
  try { bundle = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new CafeApiError('SESSION_INVALID', 'Stored Cafe session is invalid'); }
  if (!bundle || bundle.version !== 1 || bundle.cafeId !== context.cafeId || bundle.cafeSlug !== context.cafeSlug
    || !HASH.test(bundle.actorHash || '') || bundle.cafeMember !== true
    || typeof bundle.verifiedAt !== 'string' || !Number.isFinite(Date.parse(bundle.verifiedAt))) {
    throw new CafeApiError('SESSION_SCOPE', 'Stored Cafe session is not verified for this cafe');
  }
  return {
    ...bundle,
    cookies: normalizeCookies(bundle.cookies, now),
    userAgent: normalizeUserAgent(bundle.userAgent),
  };
}

function cookieKey(cookie) {
  return `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
}

function cookieDomainForSetCookie(hostname, supplied) {
  if (!supplied) return hostname;
  const normalized = supplied.toLowerCase().replace(/^\./, '');
  if (!NAVER_DOMAIN.test(normalized) || !(hostname === normalized || hostname.endsWith(`.${normalized}`))) return null;
  // A Domain attribute creates a domain cookie whether or not the source text
  // includes its optional leading dot.
  return `.${normalized}`;
}

function mergeObservedCookies(cookies, response, rawUrl, now = Date.now()) {
  const url = allowedUrl(rawUrl);
  let updated = normalizeCookies(cookies, now, { authenticationRequired: false });
  let changed = false;
  let deletedAuth = false;
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const raw of setCookies.slice(0, 100)) {
    if (raw.length > 8192 || /[\r\n]/.test(raw)) continue;
    const [pair, ...attributes] = raw.split(';');
    const equal = pair.indexOf('=');
    if (equal < 1) continue;
    const cookie = {
      name: pair.slice(0, equal).trim(), value: pair.slice(equal + 1).trim(),
      domain: url.hostname, path: url.pathname.slice(0, Math.max(1, url.pathname.lastIndexOf('/'))) || '/',
      secure: false, expires: -1, httpOnly: false,
    };
    let maxAge = null;
    for (const attribute of attributes) {
      const index = attribute.indexOf('=');
      const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const value = index < 0 ? '' : attribute.slice(index + 1).trim();
      if (key === 'domain') cookie.domain = cookieDomainForSetCookie(url.hostname, value) || '';
      if (key === 'path' && value.startsWith('/')) cookie.path = value;
      if (key === 'secure') cookie.secure = true;
      if (key === 'httponly') cookie.httpOnly = true;
      if (key === 'samesite') cookie.sameSite = value;
      if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value) / 1000;
      if (key === 'max-age' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) maxAge = Number(value);
    }
    if (!COOKIE_AUTH_NAMES.includes(cookie.name)) continue;
    if (maxAge !== null) cookie.expires = maxAge <= 0 ? 0 : now / 1000 + maxAge;
    if (cookie.name.startsWith('__Secure-') && !cookie.secure) continue;
    const cookieForValidation = cookie.value ? cookie : { ...cookie, value: 'empty-deletion-marker' };
    if (!validCookie(cookieForValidation) || !cookieDomainMatches(url.hostname, cookie.domain)) continue;
    const same = item => cookieKey(item) === cookieKey(cookie);
    const existing = updated.find(same);
    const expired = cookie.expires === 0 || (cookie.expires !== -1 && cookie.expires <= now / 1000) || !cookie.value;
    if (expired) {
      deletedAuth = true;
      if (existing) { updated = updated.filter(item => !same(item)); changed = true; }
      continue;
    }
    if (!existing || existing.value !== cookie.value || existing.expires !== cookie.expires
      || existing.secure !== cookie.secure || existing.httpOnly !== cookie.httpOnly) changed = true;
    updated = updated.filter(item => !same(item));
    if (live(cookie, now)) updated.push(cookie);
  }
  return { cookies: normalizeCookies(updated, now, { authenticationRequired: false }), changed, deletedAuth };
}

async function readResponseBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new CafeApiError('SIZE', 'Cafe response exceeds the byte limit');
  }
  if (!response.body) throw new CafeApiError('SCHEMA', 'Cafe response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CafeApiError('SIZE', 'Cafe response exceeds the byte limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function keepTimeoutUntilBodyEnds(response, timer) {
  if (!response.body) {
    clearTimeout(timer);
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        clearTimeout(timer);
        try { reader.releaseLock(); } catch {}
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally {
        clearTimeout(timer);
        try { reader.releaseLock(); } catch {}
      }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function hasResult(data) {
  return (data?.message && Object.hasOwn(data.message, 'result')) || Object.hasOwn(data || {}, 'result');
}

function requestEvidence(request, response, bytes, data, now) {
  const path = request.url.pathname
    .replace(/\/cafes\/([^/]+)(?=\/articles)/g, (_match, value) => /^\d+$/.test(value) ? '/cafes/:cafeId' : '/cafes/:cafeSlug')
    .replace(/\/cafes\/\d+(?=\/search)/g, '/cafes/:cafeId')
    .replace(/\/articles\/\d+/g, '/articles/:articleId');
  const appStatus = data?.message?.status ?? data?.statusCode ?? null;
  return Object.freeze({
    operation: request.operation,
    method: 'GET',
    origin: request.url.origin,
    path,
    queryFields: request.queryFields,
    httpStatus: response.status,
    applicationStatus: typeof appStatus === 'string' || typeof appStatus === 'number' ? String(appStatus) : null,
    mime: (response.headers.get('content-type') || '').split(';')[0] || null,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    checkedAt: new Date(now).toISOString(),
    browserUsedForHTTPRequest: false,
  });
}

export class CafeSession {
  #cookies;
  #userAgent;
  #context;
  #sessionCredentialKey;
  #stateCredentialKey;
  #actorHash;
  #cafeMember;
  #verifiedAt;
  #vault;
  #fetchImpl;
  #now;
  #persistRotations;
  #invalidateOnAuthRejection;
  #reauthRequired = false;

  constructor({ cookies, userAgent = null, context, actorHash = null, cafeMember = false,
    verifiedAt = null, vault = { readCredential, writeCredential, credentialExists },
    fetchImpl = globalThis.fetch, now = Date.now, persistRotations = false,
    invalidateOnAuthRejection = false } = {}) {
    this.#context = assertContext(context);
    const credentialKeys = scopedCredentialKeys(this.#context);
    this.#sessionCredentialKey = credentialKeys.session;
    this.#stateCredentialKey = credentialKeys.state;
    this.#cookies = normalizeCafeAuthCookies(cookies);
    this.#userAgent = normalizeUserAgent(userAgent);
    this.#actorHash = actorHash;
    this.#cafeMember = cafeMember === true;
    this.#verifiedAt = verifiedAt;
    this.#vault = vault;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#persistRotations = persistRotations === true;
    this.#invalidateOnAuthRejection = invalidateOnAuthRejection === true;
    if (typeof fetchImpl !== 'function' || typeof now !== 'function'
      || !vault || typeof vault.readCredential !== 'function' || typeof vault.writeCredential !== 'function') {
      throw new CafeApiError('INPUT', 'Invalid Cafe session runtime');
    }
  }

  static async readStoredActorPin({ context, vault = { readCredential, writeCredential, credentialExists } } = {}) {
    const normalizedContext = assertContext(context);
    const credentialKey = scopedCredentialKeys(normalizedContext).session;
    let value;
    try { value = await vault.readCredential(credentialKey); }
    catch { throw new CafeApiError('CREDENTIAL_STORE_UNREADABLE', 'The protected Cafe session could not be read'); }
    if (!value) throw new CafeApiError('CAFE_ACTOR_PIN_MISSING', 'No previously verified Cafe account binding is stored');

    let bundle;
    try { bundle = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new CafeApiError('CAFE_ACTOR_PIN_INVALID', 'Stored Cafe account binding is invalid'); }
    if (!bundle || bundle.version !== 1 || bundle.cafeId !== normalizedContext.cafeId
      || bundle.cafeSlug !== normalizedContext.cafeSlug || !HASH.test(bundle.actorHash || '')
      || bundle.cafeMember !== true || typeof bundle.verifiedAt !== 'string'
      || !Number.isFinite(Date.parse(bundle.verifiedAt)) || !Array.isArray(bundle.cookies)) {
      throw new CafeApiError('CAFE_ACTOR_PIN_INVALID', 'Stored Cafe account binding is not verified for this Cafe');
    }
    return bundle.actorHash.toLowerCase();
  }

  static async fromStored({ context, vault = { readCredential, writeCredential, credentialExists }, ...options } = {}) {
    const normalizedContext = assertContext(context);
    const credentialKeys = scopedCredentialKeys(normalizedContext);
    let stateValue;
    try { stateValue = await vault.readCredential(credentialKeys.state); }
    catch { throw new CafeApiError('CREDENTIAL_STORE_UNREADABLE', 'The protected Cafe session state could not be read'); }
    if (stateValue) {
      let state;
      try { state = JSON.parse(stateValue); } catch { throw new CafeApiError('SESSION_STATE_INVALID', 'Stored Cafe session state is invalid'); }
      if (state?.version !== 1) throw new CafeApiError('SESSION_STATE_INVALID', 'Stored Cafe session state is invalid');
      if (state.cafeId === normalizedContext.cafeId && state.cafeSlug === normalizedContext.cafeSlug
        && state.state === 'reauth_required') {
        throw new CafeApiError('REAUTH_REQUIRED', 'Naver rejected the stored Cafe session; bootstrap is required before retrying');
      }
    }
    let value;
    try { value = await vault.readCredential(credentialKeys.session); }
    catch { throw new CafeApiError('CREDENTIAL_STORE_UNREADABLE', 'The protected Cafe session could not be read'); }
    if (!value) throw new CafeApiError('AUTH_MISSING', 'No protected Naver Cafe session is stored');
    const bundle = unwrapBundle(value, normalizedContext, options.now?.() ?? Date.now());
    return new CafeSession({ ...bundle, context: normalizedContext, vault, persistRotations: true,
      invalidateOnAuthRejection: true, ...options });
  }

  static async fromSharedBlogVault({ context, vault = { readCredential, writeCredential, credentialExists }, ...options } = {}) {
    const normalizedContext = assertContext(context);
    let value;
    try { value = await vault.readCredential('naver-blog-session'); }
    catch { throw new CafeApiError('CREDENTIAL_STORE_UNREADABLE', 'The protected Naver session could not be read'); }
    if (!value) throw new CafeApiError('AUTH_MISSING', 'No protected Naver SSO session is stored');
    let bundle;
    try { bundle = JSON.parse(value); } catch { throw new CafeApiError('SESSION_INVALID', 'Stored Naver SSO session is invalid'); }
    if (bundle?.version !== 1 || !Array.isArray(bundle.cookies)) throw new CafeApiError('SESSION_INVALID', 'Stored Naver SSO session is invalid');
    const now = options.now?.() ?? Date.now();
    const cookies = normalizeCookies(bundle.cookies, now).filter(cookie => COOKIE_AUTH_NAMES.includes(cookie.name));
    const names = new Set(cookies.map(cookie => cookie.name));
    if (!COOKIE_AUTH_NAMES.every(name => names.has(name))) throw new CafeApiError('AUTH_MISSING', 'Required Naver SSO cookies are unavailable');
    return new CafeSession({ ...options, cookies, userAgent: bundle.userAgent, context: normalizedContext, vault,
      persistRotations: false, invalidateOnAuthRejection: false });
  }

  async request(operation, args = {}) {
    if (this.#reauthRequired) throw new CafeApiError('REAUTH_REQUIRED', 'This Cafe session was rejected; bootstrap is required');
    const request = buildObservedCafeRequest(operation, { ...args, ...this.#context });
    const cookie = selectCafeCookieHeader(this.#cookies, request.url.href, this.#now());
    const headers = normalizeHeaders(request.referer, this.#userAgent);
    headers.set('cookie', cookie);
    const controller = new AbortController();
    const timeoutMs = args.timeoutMs ?? 20000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new CafeApiError('INPUT', 'Invalid request timeout');
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await (request.method==='POST' && this.#fetchImpl===globalThis.fetch ? freshHttpsFetch : this.#fetchImpl)(request.url.href, {
          method: 'GET', redirect: 'manual', signal: controller.signal, headers,
        });
      } catch {
        throw new CafeApiError(controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT', 'Naver Cafe request failed; transport details omitted');
      }
      const rotation = mergeObservedCookies(this.#cookies, response, request.url.href, this.#now());
      if (rotation.deletedAuth) {
        await response.body?.cancel().catch(() => {});
        if (this.#invalidateOnAuthRejection) {
          await this.#markReauthRequired('auth_cookie_deleted');
          throw new CafeApiError('REAUTH_REQUIRED', 'Naver removed an authentication cookie; bootstrap is required before retrying');
        }
        throw new CafeApiError('AUTH', 'Naver removed an authentication cookie; protected state was left unchanged');
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        if (this.#invalidateOnAuthRejection) {
          await this.#markReauthRequired('http_401');
          throw new CafeApiError('REAUTH_REQUIRED', 'Naver rejected the stored Cafe session; bootstrap is required before retrying', { httpStatus: 401 });
        }
        throw new CafeApiError('AUTH', 'Naver rejected the current Naver session', { httpStatus: 401 });
      }
      if (response.status === 403) { await response.body?.cancel(); throw new CafeApiError('FORBIDDEN', 'Naver Cafe denied this read', { httpStatus: 403 }); }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new CafeApiError('REDIRECT', 'Naver Cafe returned a redirect; destination omitted', { httpStatus: response.status });
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new CafeApiError('HTTP', 'Naver Cafe returned an unexpected status', { httpStatus: response.status });
      }
      const mime = response.headers.get('content-type') || '';
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(mime)) {
        await response.body?.cancel();
        throw new CafeApiError(/^text\/html/i.test(mime) ? 'LOGIN_HTML' : 'MIME', 'Naver Cafe did not return JSON');
      }
      const maxBytes = args.maxBytes ?? 5 * 1024 * 1024;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10 * 1024 * 1024) {
        await response.body?.cancel();
        throw new CafeApiError('INPUT', 'Invalid Cafe response byte limit');
      }
      let bytes;
      try { bytes = await readResponseBody(response, maxBytes); }
      catch (error) {
        if (controller.signal.aborted) throw new CafeApiError('TIMEOUT', 'Naver Cafe response body timed out');
        throw error;
      }
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); }
      catch { throw new CafeApiError('JSON', 'Naver Cafe returned invalid JSON'); }
      if (!data || typeof data !== 'object' || !hasResult(data)) {
        throw new CafeApiError('APPLICATION', 'Naver Cafe response did not contain the observed result field');
      }
      const status = data?.message?.status ?? data?.statusCode;
      if (status != null && !['200', 'SUCCESS', 'success'].includes(String(status))) {
        throw new CafeApiError('APPLICATION', 'Naver Cafe application status was not successful', {
          applicationStatus: typeof status === 'string' || typeof status === 'number' ? String(status).slice(0, 32) : null,
        });
      }
      const evidence = requestEvidence(request, response, bytes, data, this.#now());
      const authNames = new Set(rotation.cookies.map(cookie => cookie.name));
      if (rotation.deletedAuth || !COOKIE_AUTH_NAMES.every(name => authNames.has(name))) {
        if (this.#invalidateOnAuthRejection) {
          await this.#markReauthRequired('auth_cookie_deleted');
          throw new CafeApiError('REAUTH_REQUIRED', 'Naver removed an authentication cookie; bootstrap is required before retrying');
        }
        throw new CafeApiError('AUTH', 'Naver removed an authentication cookie; protected state was left unchanged');
      }
      this.#cookies = rotation.cookies;
      if (rotation.changed && this.#persistRotations && this.#actorHash && this.#cafeMember) {
        await this.#storeBundle(this.#actorHash, this.#cafeMember, this.#verifiedAt || new Date(this.#now()).toISOString());
      }
      return { data, evidence };
    } finally { clearTimeout(timer); }
  }

  async managerRequest(operation, args = {}) {
    if (this.#reauthRequired) throw new CafeApiError('REAUTH_REQUIRED', 'This Cafe session was rejected; bootstrap is required');
    const request = buildManagerRequest(operation, args, this.#context);
    const cookie = selectCafeCookieHeader(this.#cookies, request.url.href, this.#now());
    const headers = new Headers({
      accept: defaultAccept,
      cookie,
      origin: 'https://cafe.naver.com',
      referer: request.referer,
      'x-cafe-product': 'pc',
    });
    if (request.contentType) headers.set('content-type', request.contentType);
    // Closing every mutation connection prevents pool reuse across article writes.
    if (request.method === 'POST') headers.set('connection', 'close');
    if (this.#userAgent) headers.set('user-agent', this.#userAgent);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      let response;
      try {
        response = await (request.method==='POST' && this.#fetchImpl===globalThis.fetch ? freshHttpsFetch : this.#fetchImpl)(request.url.href, {
          method: request.method, redirect: 'manual', signal: controller.signal, headers,
          ...(request.body == null ? {} : { body: request.body }),
        });
      } catch {
        throw new CafeApiError(request.method === 'POST' ? 'WRITE_UNCERTAIN' : controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT',
          'Naver Cafe management request failed; reconcile before a write retry');
      }
      const rotation = mergeObservedCookies(this.#cookies, response, request.url.href, this.#now());
      if (rotation.deletedAuth || response.status === 401) {
        await response.body?.cancel().catch(() => {});
        if (this.#invalidateOnAuthRejection) await this.#markReauthRequired(rotation.deletedAuth ? 'auth_cookie_deleted' : 'http_401');
        throw new CafeApiError('REAUTH_REQUIRED', 'Naver rejected the stored Cafe session; bootstrap is required before retrying', { httpStatus: response.status });
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new CafeApiError('REDIRECT', 'Cafe management returned a redirect', { httpStatus: response.status });
      }
      const mime = response.headers.get('content-type') || '';
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(mime)) {
        await response.body?.cancel().catch(() => {});
        throw new CafeApiError('MIME', 'Cafe management did not return JSON', { httpStatus: response.status });
      }
      const bytes = await readResponseBody(response, 5 * 1024 * 1024);
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); }
      catch { throw new CafeApiError('JSON', 'Cafe management returned invalid JSON', { httpStatus: response.status }); }
      const errorCode = data?.error?.errorCode ?? data?.message?.error?.errorCode ?? null;
      const appStatus = data?.message?.status ?? data?.statusCode ?? null;
      if (![200, 201].includes(response.status) || errorCode != null
        || (appStatus != null && !['200', '201', 'SUCCESS', 'success'].includes(String(appStatus)))) {
        throw new CafeApiError(request.method === 'POST' ? 'WRITE_REJECTED' : 'APPLICATION',
          'Cafe management rejected the request', {
            httpStatus: response.status,
            applicationStatus: appStatus == null ? null : String(appStatus).slice(0, 32),
            errorCode: errorCode == null ? null : String(errorCode).slice(0, 32),
          });
      }
      this.#cookies = rotation.cookies;
      if (rotation.changed && this.#persistRotations && this.#actorHash && this.#cafeMember) {
        await this.#storeBundle(this.#actorHash, this.#cafeMember, this.#verifiedAt || new Date(this.#now()).toISOString());
      }
      return {
        data,
        evidence: Object.freeze({
          operation, method: request.method, origin: request.url.origin, path: request.url.pathname,
          queryFields: [...request.url.searchParams.keys()].sort(), httpStatus: response.status,
          applicationStatus: appStatus == null ? null : String(appStatus), mime: mime.split(';')[0],
          bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          checkedAt: new Date(this.#now()).toISOString(), browserUsedForHTTPRequest: false,
        }),
      };
    } finally { clearTimeout(timer); }
  }

  async openAttachmentRequest({ url: rawUrl, referer, timeoutMs = 20000 } = {}) {
    if (this.#reauthRequired) throw new CafeApiError('REAUTH_REQUIRED', 'This Cafe session was rejected; bootstrap is required');
    const url = normalizeAttachmentUrl(rawUrl);
    const cookie = selectCafeCookieHeader(this.#cookies, url.href, this.#now(), { attachment: true });
    const headers = normalizeAttachmentReferer(referer, this.#userAgent);
    headers.set('cookie', cookie);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new CafeApiError('INPUT', 'Invalid attachment timeout');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetchImpl(url.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal, headers,
      });
      return keepTimeoutUntilBodyEnds(response, timer);
    } catch {
      clearTimeout(timer);
      throw new CafeApiError(controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT', 'Cafe attachment request failed; transport details omitted');
    }
  }

  async persistVerified({ actorHash, cafeMember } = {}) {
    if (!HASH.test(actorHash || '') || cafeMember !== true) throw new CafeApiError('AUTH_UNVERIFIED', 'Only a verified Cafe member session can be stored');
    this.#actorHash = actorHash.toLowerCase();
    this.#cafeMember = true;
    this.#verifiedAt = new Date(this.#now()).toISOString();
    await this.#storeBundle(this.#actorHash, true, this.#verifiedAt);
    try {
      await this.#vault.writeCredential(this.#stateCredentialKey, JSON.stringify({
        version: 1,
        cafeId: this.#context.cafeId,
        cafeSlug: this.#context.cafeSlug,
        state: 'verified',
        verifiedAt: this.#verifiedAt,
      }));
    } catch {
      throw new CafeApiError('CREDENTIAL_STORE_WRITE_FAILED', 'Cafe session was stored, but its reauthentication state could not be cleared');
    }
    this.#persistRotations = true;
    return this.metadata();
  }

  async requireReauthentication(reason = 'auth_rejected') {
    await this.#markReauthRequired(reason);
  }

  async #storeBundle(actorHash, cafeMember, verifiedAt) {
    const bundle = {
      version: 1,
      cafeId: this.#context.cafeId,
      cafeSlug: this.#context.cafeSlug,
      actorHash,
      cafeMember,
      verifiedAt,
      cookies: normalizeCafeAuthCookies(this.#cookies),
      userAgent: this.#userAgent,
    };
    try {
      const result = await this.#vault.writeCredential(this.#sessionCredentialKey, JSON.stringify(bundle));
      if (result?.stored === false) throw new Error();
    } catch {
      throw new CafeApiError('CREDENTIAL_STORE_WRITE_FAILED', 'Verified Cafe session could not be saved to Windows DPAPI');
    }
  }

  async #markReauthRequired(reason) {
    this.#reauthRequired = true;
    this.#cookies = [];
    this.#cafeMember = false;
    const state = {
      version: 1,
      cafeId: this.#context.cafeId,
      cafeSlug: this.#context.cafeSlug,
      state: 'reauth_required',
      reason: ['http_401', 'auth_cookie_deleted', 'identity_mismatch'].includes(reason) ? reason : 'auth_rejected',
      observedAt: new Date(this.#now()).toISOString(),
    };
    try {
      await this.#vault.writeCredential(this.#stateCredentialKey, JSON.stringify(state));
    } catch {
      throw new CafeApiError('CREDENTIAL_STORE_WRITE_FAILED', 'Naver rejected the session, but the reauthentication state could not be saved');
    }
  }

  metadata() {
    return Object.freeze({
      available: this.#cookies.length > 0,
      provider: 'windows_dpapi_current_user',
      cafeId: this.#context.cafeId,
      cafeSlug: this.#context.cafeSlug,
      actorHash: this.#actorHash,
      cafeMember: this.#cafeMember,
      verifiedAt: this.#verifiedAt,
      cookieNames: [...new Set(this.#cookies.map(cookie => cookie.name))].sort(),
      userAgentStored: Boolean(this.#userAgent),
      reauthRequired: this.#reauthRequired,
    });
  }

  static async availability({ context, vault = { readCredential, writeCredential, credentialExists } } = {}) {
    try {
      const normalizedContext = assertContext(context);
      const credentialKeys = scopedCredentialKeys(normalizedContext);
      const available = await vault.credentialExists(credentialKeys.session);
      const stateValue = await vault.readCredential(credentialKeys.state);
      let reauthRequired = false;
      if (stateValue) {
        try {
          const state = JSON.parse(stateValue);
          reauthRequired = state?.version === 1 && state.state === 'reauth_required'
            && state.cafeId === normalizedContext.cafeId && state.cafeSlug === normalizedContext.cafeSlug;
        } catch { reauthRequired = true; }
      }
      return {
        storedSessionAvailable: available === true,
        provider: 'windows_dpapi_current_user',
        verification: 'stored_presence_only',
        reauthRequired,
      };
    } catch {
      return {
        storedSessionAvailable: false,
        provider: 'windows_dpapi_current_user',
        verification: 'unavailable',
        error: 'CREDENTIAL_STORE_UNAVAILABLE',
      };
    }
  }
}
