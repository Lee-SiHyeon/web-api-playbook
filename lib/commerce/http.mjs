import { createHash } from 'node:crypto';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MIME_JSON = /^(?:application\/json|application\/[^;]+\+json)$/i;

export class CommerceHttpError extends Error {
  constructor(service, code, receipt = {}) {
    super(code);
    this.name = 'CommerceHttpError';
    this.service = service;
    this.code = code;
    this.receipt = receipt;
  }
}

export function commerceFail(service, code, receipt) {
  throw new CommerceHttpError(service, code, receipt);
}

export function validateAccessToken(service, accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8192 ||
      accessToken !== accessToken.trim() || /[\s\x00-\x1f\x7f]/.test(accessToken)) {
    commerceFail(service, `${service.toUpperCase()}_ACCESS_TOKEN_REQUIRED`);
  }
  return accessToken;
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

async function readBounded(response, maxBytes, service, receipt) {
  if (!response.body?.getReader) commerceFail(service, `${service.toUpperCase()}_BODY_UNREADABLE`, receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        commerceFail(service, `${service.toUpperCase()}_RESPONSE_TOO_LARGE`, {
          ...receipt, responseBytes: total,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function validateRequestUrl(origin, path, query, service) {
  let url;
  try { url = new URL(path, origin); }
  catch { commerceFail(service, `${service.toUpperCase()}_REQUEST_INVALID`); }
  if (url.origin !== origin || !path.startsWith('/') || path.startsWith('//') || url.hash ||
      url.username || url.password) {
    commerceFail(service, `${service.toUpperCase()}_REQUEST_INVALID`);
  }
  if (query) {
    for (const [key, value] of query) {
      if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
          typeof value !== 'string' || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) {
        commerceFail(service, `${service.toUpperCase()}_REQUEST_INVALID`);
      }
      url.searchParams.append(key, value);
    }
  }
  return url;
}

/**
 * Make one bounded JSON request to a fixed HTTPS origin. Credentials are supplied
 * in memory and are never included in receipts, errors, or redirect follow-ups.
 */
export async function commerceJsonRequest({
  service,
  origin,
  path,
  method = 'GET',
  query = [],
  jsonBody,
  accessToken,
  authHeader,
  userAgent,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxBytes = 4 * 1024 * 1024,
  timeoutMs = 15_000,
}) {
  if (typeof service !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(service) ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !['GET', 'POST'].includes(method)) {
    commerceFail(service ?? 'commerce', 'COMMERCE_REQUEST_CONFIGURATION_INVALID');
  }
  if (typeof origin !== 'string' || !/^https:\/\/[^/]+$/.test(origin)) {
    commerceFail(service, `${service.toUpperCase()}_ORIGIN_INVALID`);
  }
  const url = validateRequestUrl(origin, path, query, service);
  const checkedAt = new Date(now()).toISOString();
  const hasToken = accessToken !== undefined && accessToken !== null;
  const baseReceipt = {
    method,
    origin,
    path: url.pathname,
    checkedAt,
    browserUsed: false,
    anonymous: !hasToken,
    credentialsUsed: hasToken,
    cookieSent: false,
    queryFields: [...new Set(query.map(([key]) => key))],
    ...(authHeader && hasToken ? { authHeader } : {}),
  };
  const headers = new Headers({ accept: 'application/json' });
  if (hasToken) {
    if (typeof authHeader !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(authHeader)) {
      commerceFail(service, `${service.toUpperCase()}_AUTH_HEADER_INVALID`, baseReceipt);
    }
    validateAccessToken(service, accessToken);
    const value = authHeader.toLowerCase() === 'authorization'
      ? `Bearer ${accessToken}` : accessToken;
    headers.set(authHeader, value);
  }
  if (userAgent !== undefined) {
    if (typeof userAgent !== 'string' || userAgent.length > 200 || /[\r\n\0]/.test(userAgent)) {
      commerceFail(service, `${service.toUpperCase()}_USER_AGENT_INVALID`, baseReceipt);
    }
    headers.set('user-agent', userAgent);
  }
  let body;
  if (jsonBody !== undefined) {
    if (method !== 'POST') commerceFail(service, `${service.toUpperCase()}_REQUEST_INVALID`, baseReceipt);
    try { body = JSON.stringify(jsonBody); }
    catch { commerceFail(service, `${service.toUpperCase()}_REQUEST_INVALID`, baseReceipt); }
    if (Buffer.byteLength(body, 'utf8') > 64 * 1024) {
      commerceFail(service, `${service.toUpperCase()}_REQUEST_TOO_LARGE`, baseReceipt);
    }
    headers.set('content-type', 'application/json');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    commerceFail(service, `${service.toUpperCase()}_TRANSPORT_FAILED`, {
      ...baseReceipt,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    });
  }
  const receipt = { ...baseReceipt, httpStatus: response.status, mime: mimeOf(response) };
  if (REDIRECTS.has(response.status) || response.redirected) {
    await response.body?.cancel().catch(() => {});
    commerceFail(service, `${service.toUpperCase()}_REDIRECT_REJECTED`, {
      ...receipt, redirectFollowed: false,
    });
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    commerceFail(service, `${service.toUpperCase()}_AUTH_REJECTED`, receipt);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    commerceFail(service, `${service.toUpperCase()}_THROTTLED`, receipt);
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {});
    commerceFail(service, `${service.toUpperCase()}_HTTP_ERROR`, receipt);
  }
  if (!MIME_JSON.test(receipt.mime ?? '')) {
    await response.body?.cancel().catch(() => {});
    commerceFail(service, `${service.toUpperCase()}_MIME_INVALID`, receipt);
  }
  const raw = await readBounded(response, maxBytes, service, receipt);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { commerceFail(service, `${service.toUpperCase()}_JSON_INVALID`, {
    ...receipt, responseBytes: raw.byteLength,
  }); }
  return {
    payload,
    request: {
      ...receipt,
      responseBytes: raw.byteLength,
      responseSha256: createHash('sha256').update(raw).digest('hex'),
    },
  };
}
