import { createHash } from 'node:crypto';
import { boundCredentials } from './session.mjs';
import { operationReadiness, materializeOperationUrl, materializeTemplate, validateContractRegistry } from './contracts.mjs';
import { fail } from './errors.mjs';
import { collectStream } from './streaming.mjs';
import { MAX_DIRECT_MULTIPART_BODY_BYTES } from './grok-attachment-constants.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FAILURE_BODY_BYTES = 16 * 1024;

function normalizedMime(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function isAllowedMime(actual, expected) {
  const normalized = normalizedMime(actual);
  return expected.some(type => normalizedMime(type) === normalized);
}

const OMIT_TEMPLATE_VALUE = Symbol('omit-template-value');

function pathIsMissingAndOptional(operation, input, path) {
  let value = input;
  let schema = operation.request.inputSchema;
  for (const part of path.split('.')) {
    const rule = schema?.properties?.[part];
    if (!rule) return false;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) {
      return !(schema.required ?? []).includes(part);
    }
    value = value[part];
    schema = rule;
  }
  return false;
}

function pruneMissingOptionalBodyFields(template, operation, input) {
  if (typeof template === 'string') {
    const match = /^\{\{input\.([A-Za-z][A-Za-z0-9_.-]{0,127})\}\}$/.exec(template);
    return match && pathIsMissingAndOptional(operation, input, match[1]) ? OMIT_TEMPLATE_VALUE : template;
  }
  if (Array.isArray(template)) {
    return template.map(value => pruneMissingOptionalBodyFields(value, operation, input))
      .filter(value => value !== OMIT_TEMPLATE_VALUE);
  }
  if (template && typeof template === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(template)) {
      const pruned = pruneMissingOptionalBodyFields(value, operation, input);
      if (pruned !== OMIT_TEMPLATE_VALUE) result[key] = pruned;
    }
    return result;
  }
  return template;
}

async function readBounded(response, maxBytes) {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) throw fail('RESPONSE_SIZE_LIMIT');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) throw fail('RESPONSE_SIZE_LIMIT');
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error?.code === 'RESPONSE_SIZE_LIMIT') throw error;
    throw fail('RESPONSE_READ_FAILED');
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}

function retryAfterSeconds(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{1,8}$/.test(value.trim())) return Math.min(Number(value), 7 * 24 * 60 * 60);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(7 * 24 * 60 * 60, Math.ceil((at - Date.now()) / 1000))) : null;
}

function classifyForbiddenHtml(status, contentType, prefix) {
  if (status !== 403 || !normalizedMime(contentType).includes('html')) return { challenge: false, signal: null };
  const text = prefix.toString('utf8', 0, Math.min(prefix.length, MAX_FAILURE_BODY_BYTES));
  const patterns = [
    ['access_denied_page', /<title[^>]*>\s*(?:access denied|request blocked|security check)/i],
    ['challenge_markup', /(?:challenge-platform|cf-chl-|cf-turnstile|captcha|verify you are human|checking your browser)/i],
    ['blocked_request_marker', /(?:error\s*1020|automated requests? (?:are )?not allowed|unusual traffic)/i],
  ];
  const matched = patterns.find(([, regex]) => regex.test(text));
  return matched ? { challenge: true, signal: matched[0] } : { challenge: false, signal: 'forbidden_html_unclassified' };
}

function requestBody(operation, input) {
  if (operation.request.bodyTemplate === undefined || operation.request.bodyTemplate === null) return undefined;
  const template = pruneMissingOptionalBodyFields(operation.request.bodyTemplate, operation, input);
  if (template === OMIT_TEMPLATE_VALUE) return undefined;
  const value = materializeTemplate(template, input);
  if (operation.request.bodyEncoding === 'json' || operation.request.bodyEncoding === undefined) {
    try { return JSON.stringify(value); } catch { throw fail('REQUEST_BODY_INVALID'); }
  }
  if (operation.request.bodyEncoding === 'text' && typeof value === 'string') return value;
  if (operation.request.bodyEncoding === 'base64' && typeof value === 'string'
    && value.length <= Math.ceil((operation.request.maxBodyBytes ?? 1_048_576) * 4 / 3)
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    const maxBytes = operation.request.maxBodyBytes ?? 1_048_576;
    if (bytes.length > maxBytes || bytes.toString('base64') !== value
      || maxBytes > 1_048_576 && operation.id !== 'attachment.upload.direct'
      || operation.id === 'attachment.upload.direct' && maxBytes !== MAX_DIRECT_MULTIPART_BODY_BYTES) {
      bytes.fill(0);
      throw fail('REQUEST_BODY_ENCODING_INVALID');
    }
    return bytes;
  }
  throw fail('REQUEST_BODY_ENCODING_UNSUPPORTED');
}

function contentTypeHeader(operation) {
  if (operation.request.bodyTemplate === undefined || operation.request.bodyTemplate === null) return null;
  return operation.request.contentType ?? 'application/json';
}

export function createRequestDigest({ method, url, body }) {
  const hash = createHash('sha256').update(`${method}\n${url}\n`, 'utf8');
  if (body !== undefined && body !== null) hash.update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
  return hash.digest('hex');
}

export class ObservedHttpTransport {
  #registry;
  #sessionStore;
  #fetch;
  #timeoutMs;

  constructor({ registry, sessionStore, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validateContractRegistry(registry);
    if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) {
      throw fail('TRANSPORT_OPTIONS_INVALID');
    }
    this.#registry = registry;
    this.#sessionStore = sessionStore;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  prepare(operation, input, session = null, requestMetadataHeaders = {}, { sourceDiscoveryPermit = null } = {}) {
    const readiness = operationReadiness(operation);
    const sourceWriteCandidate = operation?.evidence?.source === 'first_party_sdk_contract'
      && operation?.evidence?.firstLiveReplayPermit === true && operation.kind === 'submit'
      && sourceDiscoveryPermit === `first-live:${operation.id}`;
    const sourceReadCandidate = operation?.evidence?.source === 'first_party_sdk_contract'
      && operation?.evidence?.firstLiveReadPermit === true && operation.kind === 'read'
      && sourceDiscoveryPermit === `first-read:${operation.id}`;
    if (!readiness.ready && !sourceWriteCandidate && !sourceReadCandidate) throw fail(readiness.reason);
    const url = materializeOperationUrl(operation, input);
    const headers = new Headers();
    for (const [name, value] of Object.entries(operation.request.headers ?? {})) headers.set(name, value);
    const body = requestBody(operation, input);
    const contentType = contentTypeHeader(operation);
    if (contentType && !headers.has('content-type')) headers.set('content-type', contentType);
    const requiredMetadataHeaders = operation.request.perActionMetadataHeaders ?? [];
    const allowedMetadataHeaders = [...requiredMetadataHeaders, ...(operation.request.optionalPerActionMetadataHeaders ?? [])];
    if (!requestMetadataHeaders || typeof requestMetadataHeaders !== 'object' || Array.isArray(requestMetadataHeaders)
      || Object.keys(requestMetadataHeaders).some(name => !allowedMetadataHeaders.some(allowed => allowed.toLowerCase() === name.toLowerCase()))
      || requiredMetadataHeaders.some(name => typeof requestMetadataHeaders[name] !== 'string' || !requestMetadataHeaders[name].trim())
      || Object.values(requestMetadataHeaders).some(value => typeof value !== 'string' || !value.trim()
        || value.length > 4096 || /[\r\n\0]/.test(value))
      || new Set(Object.keys(requestMetadataHeaders).map(name => name.toLowerCase())).size !== Object.keys(requestMetadataHeaders).length) {
      throw fail('REQUEST_METADATA_HEADERS_INVALID');
    }
    for (const [name, value] of Object.entries(requestMetadataHeaders)) headers.set(name.toLowerCase(), value);
    if (operation.request.credentialBindings) {
      const bindings = operation.request.credentialBindings;
      if ((bindings.cookies?.length || bindings.headers?.length) && !session) throw fail('SESSION_NOT_AVAILABLE');
      if (session) {
        const credentials = boundCredentials(session, url.origin, url.pathname, {
          cookieNames: bindings.cookies ?? [],
          headerNames: bindings.headers ?? [],
        });
        if (credentials.cookieHeader) headers.set('cookie', credentials.cookieHeader);
        for (const [name, value] of Object.entries(credentials.headers)) headers.set(name, value);
      }
    }
    if ((operation.authMode === 'session') && !session) throw fail('SESSION_NOT_AVAILABLE');
    if (operation.authMode === 'none' && (headers.has('cookie') || headers.has('authorization'))) throw fail('CONTRACT_AUTH_MODE_INVALID');
    return {
      url,
      method: operation.method,
      headers,
      body,
      requestDigest: createRequestDigest({ method: operation.method, url: url.href, body }),
    };
  }

  async request(operation, input = {}, { session, signal, timeoutMs = this.#timeoutMs, binary = false, prepared: suppliedPrepared, requestMetadataHeaders = {}, sourceDiscoveryPermit = null } = {}) {
    const prepared = suppliedPrepared ?? this.prepare(operation, input, session, requestMetadataHeaders, { sourceDiscoveryPermit });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.#fetch(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
        redirect: 'manual',
        signal: requestSignal,
        sourceDiscoveryPermit,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && /^AUTH_CHROME_[A-Z0-9_]{1,80}$/.test(error.code)) throw error;
      throw fail('HTTP_TRANSPORT_FAILED');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw fail('HTTP_REDIRECT_BLOCKED', { status: response.status });
    }
    if (!operation.response.statuses.includes(response.status)) {
      const smallBody = await readBounded(response, MAX_FAILURE_BODY_BYTES).catch(() => Buffer.alloc(0));
      const forbidden = classifyForbiddenHtml(response.status, contentType, smallBody);
      const details = {
        status: response.status,
        contentType: normalizedMime(contentType) || null,
        retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
        challengeDetected: forbidden.challenge,
        securitySignal: forbidden.signal,
        cookieNamesPrepared: Array.isArray(response.transportEvidence?.cookieNamesPrepared) ? response.transportEvidence.cookieNamesPrepared : [],
        requestHeaderNames: Array.isArray(response.transportEvidence?.requestHeaderNames) ? response.transportEvidence.requestHeaderNames : [],
        requestMeta: response.transportEvidence?.requestMeta ?? null,
      };
      if (forbidden.challenge) throw fail('SECURITY_CHALLENGE_BLOCKED', details);
      throw fail('HTTP_STATUS_UNEXPECTED', details);
    }
    const explicitJsonNoContent = response.status === 204 && operation.response.mode === 'json'
      && operation.response.statuses.includes(204);
    if (!explicitJsonNoContent && !isAllowedMime(contentType, operation.response.contentTypes)) {
      await response.body?.cancel().catch(() => {});
      throw fail('RESPONSE_MIME_UNEXPECTED', { status: response.status, contentType: normalizedMime(contentType) || null });
    }
    const setCookieNames = operation.response.setCookieNames ?? [];
    if (setCookieNames.length && response.headers.getSetCookie && this.#sessionStore) {
      const cookies = response.headers.getSetCookie();
      if (cookies.length) await this.#sessionStore.rotateCookies(prepared.url.origin, setCookieNames, cookies);
    }
    if (operation.response.mode === 'bytes') {
      if (!binary || operation.kind !== 'download') throw fail('BINARY_RESPONSE_NOT_ALLOWED');
      return { status: response.status, contentType: normalizedMime(contentType), response, prepared };
    }
    if (operation.response.mode === 'sse' || operation.response.mode === 'ndjson') {
      if (!response.body) throw fail('STREAM_BODY_MISSING');
      const data = await collectStream(response.body, operation.response.mode, { signal: requestSignal });
      return { status: response.status, contentType: normalizedMime(contentType), data, responseBytes: null, prepared,
        transportEvidence: response.transportEvidence ?? null };
    }
    const bytes = await readBounded(response, operation.response.maxBytes);
    try {
      if (operation.response.mode === 'json') {
        const rawResponseDigest = createHash('sha256').update(bytes).digest('hex');
        let data = null;
        if (response.status !== 204) {
          try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
          catch { throw fail('RESPONSE_JSON_INVALID'); }
        }
        return { status: response.status, contentType: normalizedMime(contentType), data, responseBytes: bytes.length,
          rawResponseDigest, prepared, transportEvidence: response.transportEvidence ?? null };
      }
      throw fail('RESPONSE_MODE_UNSUPPORTED');
    } finally {
      bytes.fill(0);
    }
  }
}

export const transportContract = Object.freeze({
  redirects: 'manual; cross-origin and same-origin redirects are not followed automatically',
  writes: 'one fetch call per submit; no automatic retries',
  userAgent: 'Node runtime default; browser user-agent and sec-ch-ua values are not replayed',
  challenge: 'confirmed challenge HTML is held and reported with status/signal only; no solving or replay',
  secrets: 'no request headers, cookies, body, response body, or signed URLs in errors or logs',
});
