import { ChatGPTWebError } from './errors.mjs';
import { PRIMARY_ORIGIN } from './contracts.mjs';

export function mimeBase(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

export function assertResponseHead(response, operation) {
  const mimeType = mimeBase(response.headers.get('content-type'));
  if (!operation.response.successStatuses.includes(response.status)) {
    const code = response.status === 401 ? 'SESSION_REJECTED'
      : response.status === 403 ? 'HTTP_FORBIDDEN_OR_CHALLENGE'
        : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_STATUS_UNEXPECTED';
    throw new ChatGPTWebError(code, { operationId: operation.id, httpStatus: response.status, mimeType });
  }
  if (!mimeType && operation.response.allowEmpty === true && [204, 205].includes(response.status)) return { mimeType: '', empty: true };
  if (!operation.response.contentTypes.some((allowed) => mimeBase(allowed) === mimeType)) {
    throw new ChatGPTWebError('RESPONSE_MIME_UNEXPECTED', { operationId: operation.id, httpStatus: response.status, mimeType });
  }
  return { mimeType, empty: false };
}

export async function readBoundedBody(response, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 200_000_000) throw new ChatGPTWebError('RESPONSE_LIMIT_INVALID');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ChatGPTWebError('RESPONSE_TOO_LARGE', { byteLength: size });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export class ChatGPTHttpTransport {
  constructor({ fetchImpl = globalThis.fetch, sessionProvider, primaryOrigin = PRIMARY_ORIGIN } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible function is required.');
    this.fetch = fetchImpl;
    this.sessionProvider = sessionProvider;
    this.primaryOrigin = primaryOrigin;
  }

  async prepareRequest(operation, request) {
    const url = request.url instanceof URL ? request.url : new URL(request.url);
    if (url.protocol !== 'https:' || url.origin !== operation.origin) {
      throw new ChatGPTWebError('REQUEST_ORIGIN_REJECTED', { operationId: operation.id });
    }
    const headers = new Headers(request.headers);
    if (operation.auth === 'chatgpt-session') {
      if (url.origin !== this.primaryOrigin || !this.sessionProvider) throw new ChatGPTWebError('SESSION_REQUIRED', { operationId: operation.id });
      const cookie = await this.sessionProvider.cookieHeaderFor(url);
      if (typeof cookie !== 'string' || !cookie) throw new ChatGPTWebError('SESSION_REQUIRED', { operationId: operation.id });
      headers.set('cookie', cookie);
    }
    return { ...request, url, headers };
  }

  async send(operation, request, { timeoutMs = 120_000, bodyOverride, prepared = false } = {}) {
    const ready = prepared ? request : await this.prepareRequest(operation, request);
    let response;
    try {
      response = await this.fetch(ready.url, {
        method: ready.method,
        headers: ready.headers,
        body: bodyOverride === undefined ? ready.body : bodyOverride,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ChatGPTWebError('HTTP_TRANSPORT_FAILED', { operationId: operation.id });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ChatGPTWebError('HTTP_REDIRECT_REJECTED', { operationId: operation.id, httpStatus: response.status });
    }
    return response;
  }
}
