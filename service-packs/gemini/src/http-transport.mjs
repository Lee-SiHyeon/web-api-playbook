import { readCredential } from './secure-credential-store.mjs';
import { CREDENTIAL_NAME, SERVICE_ORIGIN } from './constants.mjs';
import { GeminiClientError } from './errors.mjs';
import { makeCookieHeader, validateSessionBundle } from './session.mjs';
import { requireCapturedOperation, requireCapturedRequestOperation } from './contract.mjs';
import { consumeMutationDispatch, digestBody } from './journal.mjs';
import { httpsFetch } from './https-transport.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const STATIC_FORBIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length']);

function mimeType(header) {
  return String(header || '').split(';', 1)[0].trim().toLowerCase();
}

function toBodyBuffer(body) {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

async function cancelResponseBody(response) {
  const body = response?.body;
  if (!body) return;
  if (typeof body.cancel === 'function') {
    try { await body.cancel(); } catch { /* Best-effort cancellation. */ }
  }
  if (typeof body.destroy === 'function') body.destroy();
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response);
    throw new GeminiClientError('RESPONSE_TOO_LARGE', 'The Gemini response exceeded the configured size limit.');
  }
  let length = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) {
        await cancelResponseBody(response);
        throw new GeminiClientError('RESPONSE_TOO_LARGE', 'The Gemini response exceeded the configured size limit.');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof GeminiClientError) throw error;
    throw new GeminiClientError('RESPONSE_READ_FAILED', 'The Gemini response body could not be read.');
  }
  return Buffer.concat(chunks, length);
}

export async function loadProtectedSession(contract) {
  const stored = readCredential(CREDENTIAL_NAME);
  if (!stored) throw new GeminiClientError('REAUTH_REQUIRED', 'No protected Gemini web session is stored.');
  let bundle;
  try { bundle = JSON.parse(stored); }
  catch { throw new GeminiClientError('SESSION_INVALID', 'The protected Gemini web session is not valid JSON.'); }
  return validateSessionBundle(bundle, contract);
}

export class GeminiWebHttpTransport {
  constructor({ contract, session, fetchImpl = httpsFetch, timeoutMs = 30000, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
    if (!contract || contract.origin !== SERVICE_ORIGIN) {
      throw new GeminiClientError('CONTRACT_NOT_CAPTURED', 'An observed Gemini web contract is required before HTTP requests can run.');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible function is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new TypeError('Transport limits must be positive integers.');
    }
    this.contract = contract;
    this.session = session ? validateSessionBundle(session, contract) : null;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async startWithProtectedSession() {
    this.session = await loadProtectedSession(this.contract);
    return {
      provider: 'Windows DPAPI CurrentUser',
      service: this.contract.service,
      origin: this.contract.origin,
      credentialPropagated: false,
    };
  }

  async request(capability, requestSpec, { dispatchTicket, wireBodyDigest, omitCredentials = false, captureUnpairedResponse = false } = {}) {
    const operation = captureUnpairedResponse
      ? requireCapturedRequestOperation(this.contract, capability)
      : requireCapturedOperation(this.contract, capability);
    const request = operation.request;
    if (captureUnpairedResponse
        && (operation.observation?.requestResponse === true || operation.effect !== 'mutation' || operation.retryPolicy !== 'never')) {
      throw new GeminiClientError('CAPTURE_MODE_BLOCKED', 'First-response capture is limited to a request-only no-retry mutation.');
    }
    if (!requestSpec || requestSpec.method !== request.method || requestSpec.path !== request.path) {
      throw new GeminiClientError('REQUEST_CONTRACT_MISMATCH', 'The request method or path does not match the observed Gemini contract.');
    }
    const url = new URL(request.path, SERVICE_ORIGIN);
    if (url.origin !== request.origin || url.pathname !== request.path) {
      throw new GeminiClientError('REQUEST_ORIGIN_BLOCKED', 'The Gemini request escaped its captured service origin.');
    }
    const query = Array.isArray(requestSpec.query) ? requestSpec.query : [];
    const queryKeys = query.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
        throw new GeminiClientError('REQUEST_QUERY_INVALID', 'The observed query values are malformed.');
      }
      url.searchParams.append(entry[0], entry[1]);
      return entry[0];
    });
    if (queryKeys.length !== request.queryKeys.length
        || queryKeys.some((name, index) => name !== request.queryKeys[index])) {
      throw new GeminiClientError('REQUEST_CONTRACT_MISMATCH', 'The query keys do not match the captured Gemini request.');
    }
    const body = toBodyBuffer(requestSpec.body);
    if (request.method === 'GET' && body !== null) {
      throw new GeminiClientError('REQUEST_BODY_BLOCKED', 'The observed GET request does not accept a body.');
    }
    if (request.method !== 'GET' && (!body || !request.contentType)) {
      throw new GeminiClientError('REQUEST_BODY_REQUIRED', 'The observed Gemini request requires its captured body encoding.');
    }
    if (request.method !== 'GET' && mimeType(requestSpec.contentType) !== mimeType(request.contentType)) {
      throw new GeminiClientError('REQUEST_CONTENT_TYPE_MISMATCH', 'The request content type does not match the observed contract.');
    }
    if (request.bodyFieldNames) {
      let bodyFields;
      try { bodyFields = [...new URLSearchParams(body.toString('utf8')).keys()]; }
      catch { throw new GeminiClientError('REQUEST_BODY_INVALID', 'The observed Gemini form body could not be parsed.'); }
      if (bodyFields.length !== request.bodyFieldNames.length
          || bodyFields.some((name, index) => name !== request.bodyFieldNames[index])) {
        throw new GeminiClientError('REQUEST_CONTRACT_MISMATCH', 'The form fields do not match the captured Gemini request.');
      }
    }
    if ((this.contract.auth.cookieNames.length || this.contract.auth.headerNames.length) && !this.session) {
      throw new GeminiClientError('REAUTH_REQUIRED', 'The observed Gemini request requires a protected session.');
    }
    if (operation.effect === 'mutation') {
      if (!this.session) throw new GeminiClientError('REAUTH_REQUIRED', 'A protected Gemini web session is required for this mutation.');
      if (omitCredentials) throw new GeminiClientError('CREDENTIAL_OMISSION_BLOCKED', 'A Gemini mutation cannot run without its observed session.');
      if (!dispatchTicket || !/^[a-f0-9]{64}$/.test(wireBodyDigest || '') || digestBody(body) !== wireBodyDigest) {
        throw new GeminiClientError('MUTATION_JOURNAL_REQUIRED', 'A matching one-shot mutation journal ticket is required.');
      }
    }
    const suppliedHeaders = requestSpec.headers || {};
    const contractHeaders = new Set(request.headerNames.map((name) => name.toLowerCase()));
    const headers = new Headers();
    for (const [name, value] of Object.entries(suppliedHeaders)) {
      const normalized = name.toLowerCase();
      if (!contractHeaders.has(normalized) || STATIC_FORBIDDEN_HEADERS.has(normalized)
          || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
        throw new GeminiClientError('REQUEST_HEADER_BLOCKED', 'A request header was outside the observed contract.');
      }
      headers.set(normalized, value);
    }
    const capturedHeaders = this.session?.requestHeaders?.[capability] || {};
    for (const [name, value] of Object.entries(capturedHeaders)) {
      if (!contractHeaders.has(name) || STATIC_FORBIDDEN_HEADERS.has(name)) {
        throw new GeminiClientError('REQUEST_HEADER_BLOCKED', 'A captured Gemini request header was outside the operation contract.');
      }
      if (headers.has(name) && headers.get(name) !== value) {
        throw new GeminiClientError('REQUEST_HEADER_CONFLICT', 'A request header conflicts with the captured browser value.');
      }
      headers.set(name, value);
    }
    if (request.method !== 'GET' && headers.get('content-type') !== mimeType(request.contentType)) {
      if (headers.has('content-type') && mimeType(headers.get('content-type')) !== mimeType(request.contentType)) {
        throw new GeminiClientError('REQUEST_CONTENT_TYPE_MISMATCH', 'The captured content type header does not match the request encoding.');
      }
      if (!headers.has('content-type')) {
        headers.set('content-type', request.contentType);
      }
    }
    if (request.method !== 'GET' && !headers.has('content-type')) {
      headers.set('content-type', request.contentType);
    }
    if (this.session && !omitCredentials) {
      if (this.session.cookies.length) headers.set('cookie', makeCookieHeader(this.session, url));
      for (const [name, value] of Object.entries(this.session.headers)) {
        if (headers.has(name)) throw new GeminiClientError('REQUEST_HEADER_CONFLICT', 'A credential header conflicts with a static request header.');
        headers.set(name, value);
      }
    }
    if (operation.effect === 'mutation') consumeMutationDispatch(dispatchTicket, capability, wireBodyDigest);
    const dispatchStartedAt = operation.effect === 'mutation' ? new Date().toISOString() : undefined;
    let response;
    try {
      response = await this.fetch(url, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        timeoutMs: this.timeoutMs,
      });
    } catch {
      throw new GeminiClientError('TRANSPORT_FAILED', 'The observed Gemini HTTP request failed before a response was available.');
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw new GeminiClientError('REDIRECT_BLOCKED', 'The observed Gemini request returned a redirect and was not followed.', { httpStatus: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response);
      throw new GeminiClientError('HTTP_REJECTED', 'The observed Gemini request returned a non-success status.', { httpStatus: response.status });
    }
    const actualMime = mimeType(response.headers.get('content-type'));
    if (!captureUnpairedResponse && actualMime !== mimeType(operation.response.contentType)) {
      await cancelResponseBody(response);
      throw new GeminiClientError('RESPONSE_CONTENT_TYPE_MISMATCH', 'The Gemini response content type did not match the observed contract.');
    }
    const responseBody = await readBoundedBody(response, this.maxResponseBytes);
    const responseReceivedAt = operation.effect === 'mutation' ? new Date().toISOString() : undefined;
    return Object.freeze({
      capability,
      httpStatus: response.status,
      contentType: actualMime,
      body: responseBody,
      responseBytes: responseBody.length,
      responseHeaderBytes: Number.isSafeInteger(response.headerBytes) ? response.headerBytes : undefined,
      responseContractCaptured: !captureUnpairedResponse,
      ...(operation.effect === 'mutation' ? {
        responseSha256: digestBody(responseBody),
        dispatchStartedAt,
        responseReceivedAt,
      } : {}),
      credentialPropagated: Boolean(this.session && !omitCredentials && (
        this.session.cookies.length || Object.keys(this.session.headers).length
        || Object.keys(capturedHeaders).length || this.session.batchContext
      )),
    });
  }
}
