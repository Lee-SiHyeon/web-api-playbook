// Paced, bounded JSON GET/POST for public fashion-site APIs (Musinsa, 29CM).
// Pure HTTP: no cookies (none are sent or stored), no login, no browser, no writes.
// Every response is classified with backoff.mjs: 401/403/challenge stop the run,
// 429/5xx are not retried. See references/commerce-musinsa.md and references/anti-bot-boundaries.md.

import { classifyResponse } from './backoff.mjs';

export const FASHION_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

export function fashionFail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

/**
 * createFashionHttp({ service, allowedHosts, headers, minIntervalMs }) -> { request, receipts }
 * request(url, { method, body }) resolves to the parsed JSON body.
 * fetchImpl/sleep/now are injectable for tests.
 */
export function createFashionHttp({
  service, allowedHosts, headers = {}, minIntervalMs = 3000,
  fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(),
  maxBytes = 4 * 1024 * 1024, timeoutMs = 30_000,
} = {}) {
  const up = service.toUpperCase();
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) fashionFail(`${up}_INTERVAL_INVALID`);
  const hosts = new Set(allowedHosts);
  let last = 0;
  const receipts = [];

  async function request(input, { method = 'GET', body, html = false } = {}) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname)) fashionFail(`${up}_ORIGIN_INVALID`);
    const wait = last + minIntervalMs - now();
    if (last && wait > 0) await sleep(wait);
    const checkedAt = new Date(now()).toISOString();
    last = now();
    const init = {
      method,
      headers: { 'User-Agent': FASHION_USER_AGENT, Accept: html ? 'text/html' : 'application/json, text/plain, */*', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetchImpl(url, init);
    const text = await res.text();
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const receipt = {
      method, origin: url.origin, path: url.pathname, queryFields: [...url.searchParams.keys()],
      httpStatus: res.status, mime, responseBytes: Buffer.byteLength(text), checkedAt,
      credentialsUsed: false, cookieSent: false, browserUsed: false,
    };
    receipts.push(receipt);
    if (Buffer.byteLength(text) > maxBytes) fashionFail(`${up}_RESPONSE_TOO_LARGE`, { path: url.pathname });
    if (res.status === 404) fashionFail(`${up}_NOT_FOUND`, { httpStatus: 404, path: url.pathname });
    const verdict = classifyResponse({ status: res.status, headers: res.headers, bodySample: mime === 'application/json' ? '' : text });
    if (verdict.action !== 'ok') {
      const code = res.status === 429 ? `${up}_RATE_LIMITED`
        : res.status === 401 ? `${up}_AUTH_REJECTED`
          : verdict.reason === 'challenge_detected' ? `${up}_CHALLENGE`
            : `${up}_HTTP_ERROR`;
      fashionFail(code, { httpStatus: res.status, path: url.pathname, vendor: verdict.vendor ?? null });
    }
    if (html) {
      if (mime !== 'text/html') fashionFail(`${up}_NOT_HTML`, { path: url.pathname, mime });
      return text;
    }
    if (mime !== 'application/json') fashionFail(`${up}_NOT_JSON`, { path: url.pathname, mime });
    let parsed;
    try { parsed = JSON.parse(text); } catch { fashionFail(`${up}_JSON_INVALID`, { path: url.pathname }); }
    if (parsed?.result === 'FAIL' || parsed?.meta?.result === 'FAIL') {
      fashionFail(`${up}_API_FAILED`, { path: url.pathname, vendorCode: String(parsed.errorCode ?? parsed.meta?.errorCode ?? parsed.error_code ?? '').slice(0, 64) || null });
    }
    return parsed;
  }

  return { request, receipts };
}
