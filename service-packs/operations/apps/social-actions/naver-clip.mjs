import { loadNaverCookies } from '../naver-blog-api/scripts/session-vault.mjs';

export const NAVER_CLIP_OPERATIONS = Object.freeze({
  profileSelf: Object.freeze({
    origin: 'https://clip-service-elb-public.io.naver.com',
    path: '/studio/webapi/profiles/self',
  }),
  contentList: Object.freeze({
    origin: 'https://clip-service-elb-public.io.naver.com',
    pathTemplate: '/studio/webapi/profiles/{profileKey}/contents/cursor',
  }),
  workingProgress: Object.freeze({
    origin: 'https://smart-clip-be.naver.com',
    path: '/v1/me/working-clip-progress',
  }),
});

const APP_ORIGIN = 'https://clipcreators.naver.com';
const APP_REFERER = APP_ORIGIN + '/web/signup';
const PROFILE_CONTENT_QUERY = Object.freeze({ type: 'VOD', size: '30' });
const SAFE_PROFILE_KEY = /^[A-Za-z0-9_-]{12,64}$/;
const REQUIRED_COOKIES = new Set(['NID_AUT', 'NID_SES']);
const MAX_RESPONSE_BYTES = 512 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function cookieApplies(cookie, url, nowSeconds) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
    || /[\r\n;]/.test(cookie.name + cookie.value)) return false;
  const rawDomain = String(cookie.domain || '').toLowerCase();
  const domain = rawDomain.replace(/^\./, '');
  const domainMatch = url.hostname === domain
    || (rawDomain.startsWith('.') && url.hostname.endsWith('.' + domain));
  const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  const pathMatch = url.pathname === cookiePath
    || (url.pathname.startsWith(cookiePath)
      && (cookiePath.endsWith('/') || url.pathname[cookiePath.length] === '/'));
  const expiryMatch = cookie.expires === -1
    || (Number.isFinite(cookie.expires) && cookie.expires > nowSeconds);
  return domainMatch && pathMatch && expiryMatch;
}

function isObservedContentListUrl(url) {
  if (url.origin !== NAVER_CLIP_OPERATIONS.contentList.origin
    || !/^\/studio\/webapi\/profiles\/[A-Za-z0-9_-]{12,64}\/contents\/cursor$/.test(url.pathname)) return false;
  const entries = [...url.searchParams.entries()];
  return entries.length === 2
    && url.searchParams.getAll('type').length === 1
    && url.searchParams.getAll('size').length === 1
    && url.searchParams.get('type') === PROFILE_CONTENT_QUERY.type
    && url.searchParams.get('size') === PROFILE_CONTENT_QUERY.size;
}

export function buildNaverClipCookieHeader(cookies, rawUrl, now = Date.now()) {
  let url;
  try { url = new URL(rawUrl); } catch { fail('NAVER_CLIP_URL_INVALID'); }
  const exactRead = Object.values(NAVER_CLIP_OPERATIONS)
    .some(operation => operation.path && url.origin === operation.origin && url.pathname === operation.path
      && !url.search);
  if (url.protocol !== 'https:' || (!exactRead && !isObservedContentListUrl(url))
    || url.username || url.password || url.hash) fail('NAVER_CLIP_URL_OUT_OF_SCOPE');
  if (!Array.isArray(cookies) || cookies.length > 1024) fail('NAVER_CLIP_SESSION_INVALID');

  const selected = cookies.filter(cookie => cookieApplies(cookie, url, now / 1000))
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  const names = new Set(selected.filter(cookie => cookie.value).map(cookie => cookie.name));
  if (![...REQUIRED_COOKIES].every(name => names.has(name))) fail('NAVER_CLIP_AUTH_COOKIES_MISSING');
  return selected.map(cookie => cookie.name + '=' + cookie.value).join('; ');
}

function safeServiceCode(data) {
  for (const key of ['code', 'errorCode', 'resultCode']) {
    const value = data && typeof data === 'object' ? data[key] : null;
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)) return value;
  }
  return null;
}

function jsonKeys(data) {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data).slice(0, 40)
    : Array.isArray(data) ? ['array'] : [];
}

async function readResponse(response, operation, endpoint, provider) {
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() || null;
  const text = await response.text();
  const byteLength = Buffer.byteLength(text);
  if (byteLength > MAX_RESPONSE_BYTES) fail('NAVER_CLIP_RESPONSE_TOO_LARGE');
  let data = null;
  if (mime === 'application/json' || mime?.endsWith('+json')) {
    try { data = JSON.parse(text); } catch { fail('NAVER_CLIP_RESPONSE_JSON_INVALID'); }
  }
  return {
    operation,
    origin: endpoint.origin,
    path: endpoint.path,
    credentialProvider: typeof provider === 'string' ? provider : null,
    credentialPropagated: true,
    httpStatus: response.status,
    mime,
    byteLength,
    responseKeys: jsonKeys(data),
    serviceCode: safeServiceCode(data),
    authenticatedRead: response.status >= 200 && response.status < 300 && data !== null,
    data,
  };
}

export function summarizeNaverClipOperation(result) {
  const summary = {
    operation: result.operation,
    origin: result.origin,
    path: result.path,
    credentialProvider: result.credentialProvider,
    credentialPropagated: result.credentialPropagated,
    httpStatus: result.httpStatus,
    mime: result.mime,
    byteLength: result.byteLength,
    responseKeys: result.responseKeys,
    serviceCode: result.serviceCode,
    authenticatedRead: result.authenticatedRead,
    requiresClipProfile: result.serviceCode === 'NOT_CLIP_PROFILE_USER',
  };
  if (result.operation === 'contentList' && result.authenticatedRead) {
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    summary.totalCount = Number.isSafeInteger(result.data?.totalCount) ? result.data.totalCount : null;
    summary.itemCount = items.length;
    summary.publicOpenCount = items.filter(item => item?.userPublicStatusCode === 'PUBLIC_OPEN'
      && item?.systemExposureStatusCode === 'EXPOSURE').length;
  }
  return summary;
}

export function createNaverClipClient({
  sessionProvider = () => loadNaverCookies({ env: {} }),
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  if (typeof sessionProvider !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    fail('NAVER_CLIP_CLIENT_CONFIGURATION_INVALID');
  }

  async function requestRead(operationName, endpoint, requestUrl, safePath, {
    referer = APP_REFERER,
    sendOrigin = true,
  } = {}) {
    let session;
    try { session = await sessionProvider(); } catch { fail('NAVER_CLIP_SESSION_UNAVAILABLE'); }
    if (!session || !Array.isArray(session.cookies)) fail('NAVER_CLIP_SESSION_INVALID');
    const url = requestUrl || endpoint.origin + endpoint.path;
    const cookie = buildNaverClipCookieHeader(session.cookies, url);
    let response;
    try {
      const headers = {
        accept: 'application/json, text/plain, */*',
        referer,
        cookie,
      };
      if (sendOrigin) headers.origin = APP_ORIGIN;
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      });
    } catch {
      fail('NAVER_CLIP_TRANSPORT_FAILED');
    }
    return readResponse(response, operationName, {
      origin: endpoint.origin,
      path: safePath || endpoint.path,
    }, session.provider);
  }

  async function read(operationName) {
    const endpoint = NAVER_CLIP_OPERATIONS[operationName];
    if (!endpoint?.path) fail('NAVER_CLIP_OPERATION_INVALID');
    return requestRead(operationName, endpoint);
  }

  async function readContentList() {
    const profile = await read('profileSelf');
    const profileEntry = Array.isArray(profile.data)
      ? profile.data.find(item => item && typeof item === 'object' && SAFE_PROFILE_KEY.test(item.profileKey || ''))
      : null;
    if (!profileEntry) fail('NAVER_CLIP_PROFILE_KEY_MISSING');
    const endpoint = NAVER_CLIP_OPERATIONS.contentList;
    const path = endpoint.pathTemplate.replace('{profileKey}', encodeURIComponent(profileEntry.profileKey));
    const url = new URL(endpoint.origin + path);
    url.searchParams.set('type', PROFILE_CONTENT_QUERY.type);
    url.searchParams.set('size', PROFILE_CONTENT_QUERY.size);
    return requestRead('contentList', endpoint, url.href,
      '/studio/webapi/profiles/<profileKey>/contents/cursor?type=VOD&size=30', {
        referer: APP_ORIGIN + '/web/contents/clips',
        sendOrigin: false,
      });
  }

  return Object.freeze({
    readProfileSelf: () => read('profileSelf'),
    readContentList,
    readWorkingProgress: () => read('workingProgress'),
    async probe() {
      const operations = [];
      for (const operation of ['profileSelf', 'workingProgress']) {
        try { operations.push(summarizeNaverClipOperation(await read(operation))); }
        catch (error) {
          operations.push({ operation, errorCode: /^NAVER_CLIP_[A-Z0-9_]+$/.test(error?.code || '')
            ? error.code : 'NAVER_CLIP_READ_FAILED' });
        }
      }
      return {
        executionMode: 'pure_http',
        browserUsed: false,
        credentialProvider: operations.find(item => item.credentialProvider)?.credentialProvider || null,
        credentialPropagated: operations.some(item => item.credentialPropagated === true),
        operations,
      };
    },
  });
}
