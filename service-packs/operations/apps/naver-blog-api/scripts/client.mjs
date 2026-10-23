import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadNaverCookies, mergeNaverSetCookies, naverCookieHeaderFor, normalizeNaverUserAgent, storeNaverCookies } from './session-vault.mjs';

export const BLOG_ID = process.env.NAVER_BLOG_ID || '4053103';
const ORIGIN = 'https://blog.stat.naver.com';
const catalog = JSON.parse(await readFile(new URL('../references/api-catalog.json', import.meta.url), 'utf8'));
const currentCatalog = JSON.parse(await readFile(new URL('../references/current-contracts.json', import.meta.url), 'utf8'))
  .filter(c => c.method === 'GET' && c.httpStatus === 200 && c.applicationStatus === 200 && c.schema?.result?.statDataList?.type === 'array');
export const operations = Object.freeze(Object.fromEntries([...catalog, ...currentCatalog]
  .filter(c => c.method === 'GET' && c.url.startsWith(`${ORIGIN}/api/blog/`))
  .map(c => [c.url.slice(`${ORIGIN}/api/blog/`.length), Object.freeze({
    path: new URL(c.url).pathname,
    queryFields: Object.freeze([...c.queryFields].sort()),
    observedOn: c.observedAt?.slice(0, 10) || '2026-09-06',
  })])));

export class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return { type: 'array', length: value.length, item: value.length ? shape(value[0]) : null };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  return typeof value;
}

export function resolveRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('INPUT', 'Provide a request object');
  if (Object.keys(input).some(k => !['url', 'operation', 'query'].includes(k))) throw new ApiError('INPUT', 'Supported request fields: url OR operation/query');
  let url;
  if (Object.hasOwn(input, 'url')) {
    if (Object.hasOwn(input, 'operation') || Object.hasOwn(input, 'query')) throw new ApiError('INPUT', 'Use url OR operation/query');
    try { url = new URL(input.url); } catch { throw new ApiError('INPUT', 'Invalid URL'); }
  } else {
    if (!Object.hasOwn(operations, input.operation)) throw new ApiError('UNOBSERVED', 'Operation is not in the observed read catalog');
    if (!input.query || typeof input.query !== 'object' || Array.isArray(input.query)) throw new ApiError('INPUT', 'Provide observed query values');
    url = new URL(operations[input.operation].path, ORIGIN);
    for (const [k, v] of Object.entries(input.query)) {
      if (typeof v !== 'string') throw new ApiError('INPUT', 'Query values must be strings captured from an authorized request');
      url.searchParams.append(k, v);
    }
  }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw new ApiError('SCOPE', 'Target is outside the supported statistics scope');
  const operation = Object.keys(operations).find(k => operations[k].path === url.pathname);
  if (!operation) throw new ApiError('UNOBSERVED', 'Endpoint is not in the observed read catalog');
  const keys = [...url.searchParams.keys()].sort();
  if (new Set(keys).size !== keys.length || JSON.stringify(keys) !== JSON.stringify(operations[operation].queryFields)) {
    throw new ApiError('INPUT', 'Provide exactly the observed query fields', { operation, queryFields: operations[operation].queryFields });
  }
  if ([...url.searchParams.values()].some(v => /[\r\n]|\[redacted\]|<.*>/i.test(v))) throw new ApiError('INPUT', 'Replace placeholder values with current observed inputs');
  return { operation, url };
}

async function boundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ApiError('SIZE', 'Response exceeds byte budget');
  }
  if (!response.body) throw new ApiError('SCHEMA', 'Response has no body');
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
        throw new ApiError('SIZE', 'Response exceeds byte budget');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function retryDelay(response, now) {
  const raw = response.headers.get('retry-after');
  if (raw === null) return 500;
  const numeric = Number(raw);
  const ms = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(raw) - now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 500;
}

export async function read(input, {
  cookie, userAgent, fetchImpl = globalThis.fetch,
  timeoutMs = 20000, maxBytes = 5 * 1024 * 1024, maxRetries = 1,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
} = {}) {
  const { operation, url } = resolveRequest(input);
  let persistedCookies = null;
  if (cookie === undefined) {
    try {
      const session = await loadNaverCookies();
      cookie = naverCookieHeaderFor(session.cookies, url.href, now());
      persistedCookies = session.cookies;
      userAgent = session.userAgent;
    } catch {
      throw new ApiError('AUTH_MISSING', 'A current Naver session is unavailable in the DPAPI store or runtime environment');
    }
  }
  if (typeof cookie !== 'string' || !cookie.trim()) throw new ApiError('AUTH_MISSING', 'Current NAVER_COOKIE required');
  if (/\r|\n/.test(cookie)) throw new ApiError('INPUT', 'Invalid credential header format');
  userAgent = normalizeNaverUserAgent(userAgent);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new ApiError('INPUT', 'maxRetries must be 0, 1, or 2');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10 * 1024 * 1024) throw new ApiError('INPUT', 'Invalid request budget');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { cookie, accept: 'application/json', referer: `https://admin.blog.naver.com/${BLOG_ID}/stat/today`,
          ...(userAgent ? { 'user-agent': userAgent } : {}) },
      });
      if (persistedCookies) {
        const rotated = mergeNaverSetCookies(persistedCookies, response, url.href, now());
        // A rejected session comes back with NID_AUT/NID_SES deletions. Persisting that would wipe the
        // shared login used by the publisher (observed 2026-09-24), so fail without touching the vault.
        const authIntact = ['NID_AUT', 'NID_SES'].every(name => rotated.cookies.some(c => c.name === name && c.value));
        if (rotated.changed && !authIntact) {
          await response.body?.cancel();
          throw new ApiError('AUTH_MISSING', 'The server rejected the stored Naver session; the vault was left unchanged');
        }
        if (rotated.changed) {
          try { await storeNaverCookies(rotated.cookies, { allowIncomplete: true, userAgent }); }
          catch { throw new ApiError('CREDENTIAL_STORE_WRITE_FAILED', 'Rotated session could not be saved in the Windows DPAPI vault'); }
          persistedCookies = rotated.cookies;
          cookie = naverCookieHeaderFor(persistedCookies, url.href, now());
        }
      }
      if ([429, 502, 503, 504].includes(response.status)) {
        const delay = retryDelay(response, now);
        await response.body?.cancel();
        if (attempt < maxRetries && delay <= 5000) {
          clearTimeout(timer);
          await sleep(delay);
          continue;
        }
        throw new ApiError(response.status === 429 ? 'THROTTLED' : 'SERVICE', 'Read deferred after bounded retry policy', { httpStatus: response.status });
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        const code = response.status === 401 ? 'AUTH' : response.status === 403 ? 'FORBIDDEN' : response.status >= 300 && response.status < 400 ? 'REDIRECT' : 'HTTP';
        throw new ApiError(code, 'Unexpected HTTP response; body and redirect URL omitted', { httpStatus: response.status });
      }
      const mime = response.headers.get('content-type') || '';
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(mime)) {
        await response.body?.cancel();
        throw new ApiError('MIME', 'Expected JSON; login HTML or fallback is not API success');
      }
      const bytes = await boundedBody(response, maxBytes);
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError('JSON', 'Malformed JSON; body omitted'); }
      if (!data || typeof data !== 'object' || data.statusCode !== 200) {
        throw new ApiError('APPLICATION', 'Application status is not numeric 200; message omitted', { applicationStatus: typeof data?.statusCode === 'number' ? data.statusCode : null });
      }
      if (!Array.isArray(data.result?.statDataList)) throw new ApiError('SCHEMA', 'Expected result.statDataList array absent');
      return {
        data,
        evidence: {
          operation, method: 'GET', url: ORIGIN + url.pathname,
          queryFields: operations[operation].queryFields,
          httpStatus: response.status, applicationStatus: data.statusCode,
          expectedResultPresent: true, attempts: attempt + 1,
          mime: mime.split(';')[0], bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), schema: shape(data),
          checkedAt: new Date(now()).toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.message === 'NAVER_AUTH_COOKIES_MISSING') {
        throw new ApiError('AUTH_MISSING', 'The stored Naver session is no longer authenticated');
      }
      throw new ApiError(controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT', 'Request failed; transport details omitted to protect session data');
    } finally { clearTimeout(timer); }
  }
}
