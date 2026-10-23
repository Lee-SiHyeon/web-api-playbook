import { randomInt } from 'node:crypto';
import { readCredential, writeCredential } from '../../google-flow/src/secure-credential-store.mjs';
import {
  buildConversationListRequest,
  buildConversationReadRequest,
  GEMINI_BATCH_PATH,
  GEMINI_ORIGIN,
  GEMINI_RPC,
  GeminiProtocolError,
  isGeminiConversationId,
  parseBatchReply,
  parseConversationList,
  parseConversationRows,
} from './protocol.mjs';

export const GEMINI_SESSION_CREDENTIAL = 'google-gemini-session-v1';

const MAX_BODY = 5 * 1024 * 1024;
const COOKIE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/;
const AUTH_COOKIE_NAMES = new Set(['SID', '__Secure-1PSID']);

function fail(code, message, details = {}) {
  return new GeminiProtocolError(message, { code, ...details });
}

function safeErrorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(code) ? code : undefined;
}

function responseEvidence({ operation, method, url, response, mime, bytes, errorCode }) {
  const evidence = {
    operation, method, origin: url.origin, path: url.pathname,
    httpStatus: Number.isInteger(response?.status) ? response.status : null,
    mime: typeof mime === 'string' && mime ? mime.split(';', 1)[0] : null,
    bytes: Number.isInteger(bytes) && bytes >= 0 ? bytes : null,
    checkedAt: new Date().toISOString(),
  };
  if (typeof errorCode === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(errorCode)) evidence.errorCode = errorCode;
  return evidence;
}

function declaredLength(response) {
  const raw = response?.headers?.get('content-length');
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function allowedDomain(domain, host) {
  const raw = domain.trim().toLowerCase();
  const domainScoped = raw.startsWith('.');
  const base = raw.replace(/^\./, '');
  if (!['google.com', 'gemini.google.com'].includes(base)) return false;
  if (domainScoped) return host === base || host.endsWith('.' + base);
  return host === base;
}

function pathMatches(cookiePath, requestPath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function validCookie(cookie) {
  return Boolean(cookie && typeof cookie === 'object'
    && typeof cookie.name === 'string' && COOKIE_NAME.test(cookie.name)
    && typeof cookie.value === 'string' && cookie.value.length > 0
    && !/[\r\n\0;]/.test(cookie.value)
    && typeof cookie.domain === 'string'
    && typeof cookie.path === 'string' && cookie.path.startsWith('/')
    && typeof cookie.secure === 'boolean'
    && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires));
}

function cookiesFor(bundle, url, nowMs) {
  if (url.protocol !== 'https:' || url.origin !== GEMINI_ORIGIN) {
    throw fail('GEMINI_ORIGIN_SCOPE', 'Gemini credential target is outside the configured origin.');
  }
  const host = url.hostname.toLowerCase();
  const nowSeconds = nowMs / 1000;
  const selected = bundle.cookies.filter((cookie) => {
    if (!validCookie(cookie) || !allowedDomain(cookie.domain, host)) return false;
    if (cookie.secure && url.protocol !== 'https:') return false;
    if (!pathMatches(cookie.path, url.pathname)) return false;
    return cookie.expires < 0 || cookie.expires > nowSeconds;
  });
  if (!selected.length) {
    throw fail('GEMINI_AUTH_COOKIE_MISSING', 'Protected Gemini session has no cookies scoped to this request.');
  }
  if (!selected.some((cookie) => AUTH_COOKIE_NAMES.has(cookie.name))) {
    throw fail('GEMINI_AUTH_COOKIE_MISSING', 'Protected Gemini session has no recognized authentication cookie for this request.');
  }
  return selected.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function readDocumentValue(html, name) {
  const pattern = new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = pattern.exec(html);
  if (!match) throw fail('GEMINI_DOCUMENT_TOKEN_MISSING', 'Gemini document omitted a required request token.');
  try {
    const value = JSON.parse(match[1]);
    if (typeof value === 'string' && value) return value;
  } catch { /* The first-party document did not match its observed shape. */ }
  throw fail('GEMINI_DOCUMENT_TOKEN_INVALID', 'Gemini document contains an invalid request token.');
}

async function boundedText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await response.body?.cancel().catch(() => {});
    throw fail('GEMINI_RESPONSE_TOO_LARGE', 'Gemini response exceeded the local size limit.');
  }
  if (!response.body) throw fail('GEMINI_RESPONSE_EMPTY', 'Gemini response body is missing.');
  let length = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_BODY) {
        await response.body.cancel().catch(() => {});
        throw fail('GEMINI_RESPONSE_TOO_LARGE', 'Gemini response exceeded the local size limit.');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof GeminiProtocolError) throw error;
    throw fail('GEMINI_RESPONSE_READ_FAILED', 'Gemini response could not be read.');
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseSetCookie(line, responseUrl) {
  if (typeof line !== 'string' || line.length > 8192) return null;
  const parts = line.split(';');
  const pair = parts.shift() || '';
  const equal = pair.indexOf('=');
  if (equal < 1) return null;
  const name = pair.slice(0, equal).trim();
  const value = pair.slice(equal + 1).trim();
  if (!COOKIE_NAME.test(name) || /[\r\n\0;]/.test(value)) return null;

  const attrs = new Map();
  for (const part of parts) {
    const index = part.indexOf('=');
    const key = part.slice(0, index < 0 ? undefined : index).trim().toLowerCase();
    attrs.set(key, index < 0 ? '' : part.slice(index + 1).trim());
  }
  const rawDomain = attrs.get('domain');
  let domain = responseUrl.hostname.toLowerCase();
  if (rawDomain) {
    const base = rawDomain.toLowerCase().replace(/^\./, '');
    if (!['google.com', 'gemini.google.com'].includes(base)) return null;
    domain = '.' + base;
  }
  if (!allowedDomain(domain, responseUrl.hostname)) return null;
  let cookiePath = attrs.get('path');
  if (!cookiePath || !cookiePath.startsWith('/')) {
    const lastSlash = responseUrl.pathname.lastIndexOf('/');
    cookiePath = lastSlash <= 0 ? '/' : responseUrl.pathname.slice(0, lastSlash);
  }

  const maxAge = attrs.has('max-age') ? Number(attrs.get('max-age')) : undefined;
  if (maxAge !== undefined && !Number.isFinite(maxAge)) return null;
  const expiresMs = attrs.has('expires') ? Date.parse(attrs.get('expires')) : NaN;
  const expires = Number.isFinite(maxAge)
    ? Date.now() / 1000 + maxAge
    : Number.isFinite(expiresMs) ? expiresMs / 1000 : -1;
  const deleted = !value || (Number.isFinite(maxAge) && maxAge <= 0)
    || (Number.isFinite(expiresMs) && expiresMs <= Date.now());
  return {
    name, value, domain, path: cookiePath,
    secure: attrs.has('secure'), httpOnly: attrs.has('httponly'), expires, deleted,
  };
}

function cookieIdentity(cookie) {
  return [cookie.name, cookie.domain.toLowerCase(), cookie.path].join('\n');
}

export class GeminiHttpTransport {
  #fetch;
  #readSession;
  #writeSession;
  #reqId;
  #now;
  #bundle = null;
  #document = null;

  constructor({
    fetchImpl = globalThis.fetch,
    readSession = () => readCredential(GEMINI_SESSION_CREDENTIAL),
    writeSession = (value) => writeCredential(GEMINI_SESSION_CREDENTIAL, value),
    reqId = () => randomInt(1_000_000, 10_000_000),
    now = () => Date.now(),
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible function is required.');
    this.#fetch = fetchImpl;
    this.#readSession = readSession;
    this.#writeSession = writeSession;
    this.#reqId = reqId;
    this.#now = now;
    this.evidence = [];
  }

  async start() {
    let stored;
    try { stored = this.#readSession(); }
    catch { throw fail('GEMINI_SESSION_UNAVAILABLE', 'Protected Gemini session could not be read.'); }
    if (typeof stored !== 'string' || stored.length < 2 || stored.length > 131_072) {
      throw fail('GEMINI_SESSION_UNAVAILABLE', 'Protected Gemini session is missing or invalid.');
    }
    let bundle;
    try { bundle = JSON.parse(stored); }
    catch { throw fail('GEMINI_SESSION_INVALID', 'Protected Gemini session is not valid JSON.'); }
    if (bundle?.version !== 1 || bundle.origin !== GEMINI_ORIGIN || !Array.isArray(bundle.cookies)
        || bundle.cookies.length < 2 || bundle.cookies.length > 64) {
      throw fail('GEMINI_SESSION_SCOPE_INVALID', 'Protected Gemini session has an unexpected scope.');
    }
    if (bundle.cookies.some((cookie) => !validCookie(cookie))) {
      throw fail('GEMINI_SESSION_COOKIE_INVALID', 'Protected Gemini session contains an invalid cookie record.');
    }
    this.#bundle = {
      version: 1,
      origin: GEMINI_ORIGIN,
      cookies: bundle.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly === true,
        expires: cookie.expires,
      })),
      ...(typeof bundle.capturedAt === 'string' ? { capturedAt: bundle.capturedAt } : {}),
    };
    const url = new URL('/app', GEMINI_ORIGIN);
    const cookie = cookiesFor(this.#bundle, url, this.#now());
    if (!this.#bundle.cookies.some((item) => AUTH_COOKIE_NAMES.has(item.name)
        && allowedDomain(item.domain, url.hostname) && pathMatches(item.path, url.pathname)
        && (item.expires < 0 || item.expires > this.#now() / 1000))) {
      throw fail('GEMINI_AUTH_COOKIE_MISSING', 'Protected Gemini session has no active authentication cookie.');
    }
    await this.#refreshDocument(cookie);
    return {
      origin: GEMINI_ORIGIN,
      path: '/app',
      httpStatus: 200,
      checkedAt: this.#document.checkedAt,
    };
  }

  #rotateObservedCookies(response, requestUrl) {
    const responseUrl = response.url ? new URL(response.url) : requestUrl;
    if (responseUrl.origin !== GEMINI_ORIGIN || responseUrl.protocol !== 'https:') return false;
    const headers = response.headers;
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (!setCookies.length) return false;
    const updates = setCookies.map((line) => parseSetCookie(line, responseUrl)).filter(Boolean);
    if (!updates.length) return false;

    const cookies = this.#bundle.cookies.map((cookie) => ({ ...cookie }));
    let changed = false;
    let authDeleted = false;
    for (const update of updates) {
      const identity = cookieIdentity(update);
      const index = cookies.findIndex((cookie) => cookieIdentity(cookie) === identity);
      if (update.deleted) {
        if (index < 0) continue;
        cookies.splice(index, 1);
        if (AUTH_COOKIE_NAMES.has(update.name)) authDeleted = true;
        changed = true;
        continue;
      }
      const next = {
        ...(index >= 0 ? cookies[index] : {}),
        name: update.name,
        value: update.value,
        domain: update.domain,
        path: update.path,
        secure: update.secure,
        httpOnly: update.httpOnly,
        expires: update.expires,
      };
      if (index >= 0) cookies[index] = next;
      else cookies.push(next);
      changed = true;
    }
    if (!changed) return false;
    this.#bundle = { ...this.#bundle, cookies };
    try { this.#writeSession(JSON.stringify(this.#bundle)); }
    catch { throw fail('GEMINI_SESSION_ROTATION_FAILED', 'Observed Gemini cookie rotation could not be saved.'); }
    return authDeleted;
  }

  async #refreshDocument(cookie = cookiesFor(this.#bundle, new URL('/app', GEMINI_ORIGIN), this.#now())) {
    const sourcePath = '/app';
    const url = new URL(sourcePath, GEMINI_ORIGIN);
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: { cookie, accept: 'text/html' },
      });
    } catch (error) {
      const transportCode = safeErrorCode(error);
      this.evidence.push({
        operation: 'document', method: 'GET', origin: GEMINI_ORIGIN, path: sourcePath,
        httpStatus: null, mime: null, bytes: null, checkedAt: new Date(this.#now()).toISOString(),
        ...(transportCode ? { transportCode } : {}),
      });
      throw fail('GEMINI_DOCUMENT_TRANSPORT', 'Gemini document request failed.', { transportCode });
    }
    let authDeleted;
    try { authDeleted = this.#rotateObservedCookies(response, url); }
    catch (error) {
      this.evidence.push(responseEvidence({ operation: 'document', method: 'GET', url, response,
        mime: response.headers.get('content-type'), bytes: declaredLength(response), errorCode: safeErrorCode(error) ?? 'GEMINI_SESSION_ROTATION_FAILED' }));
      throw error;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      this.evidence.push(responseEvidence({ operation: 'document', method: 'GET', url, response,
        mime: response.headers.get('content-type'), bytes: declaredLength(response), errorCode: 'GEMINI_DOCUMENT_HTTP_ERROR' }));
      throw fail('GEMINI_DOCUMENT_HTTP_ERROR', `Gemini document returned HTTP ${response.status}.`, { httpStatus: response.status });
    }
    if (authDeleted) {
      await response.body?.cancel().catch(() => {});
      this.evidence.push(responseEvidence({ operation: 'document', method: 'GET', url, response,
        mime: response.headers.get('content-type'), bytes: declaredLength(response), errorCode: 'GEMINI_REAUTH_REQUIRED' }));
      throw fail('GEMINI_REAUTH_REQUIRED', 'Gemini deleted an authentication cookie; bootstrap the session again.');
    }
    const mime = response.headers.get('content-type') || '';
    if (!/^text\/html(?:\s*;|$)/i.test(mime)) {
      await response.body?.cancel().catch(() => {});
      this.evidence.push(responseEvidence({ operation: 'document', method: 'GET', url, response,
        mime, bytes: declaredLength(response), errorCode: 'GEMINI_DOCUMENT_MIME' }));
      throw fail('GEMINI_DOCUMENT_MIME', 'Gemini document did not return HTML.', { httpStatus: response.status });
    }
    let html;
    let at;
    let sid;
    let bl;
    try {
      html = await boundedText(response);
      at = readDocumentValue(html, 'SNlM0e');
      sid = readDocumentValue(html, 'FdrFJe');
      bl = readDocumentValue(html, 'cfb2h');
    } catch (error) {
      this.evidence.push(responseEvidence({ operation: 'document', method: 'GET', url, response, mime,
        bytes: html === undefined ? declaredLength(response) : Buffer.byteLength(html), errorCode: safeErrorCode(error) ?? 'GEMINI_DOCUMENT_PARSE_FAILED' }));
      throw error;
    }
    const checkedAt = new Date(this.#now()).toISOString();
    this.#document = { sourcePath, at, sid, bl, checkedAt };
    this.evidence.push({
      operation: 'document', method: 'GET', origin: GEMINI_ORIGIN, path: sourcePath,
      httpStatus: response.status, mime: mime.split(';', 1)[0], bytes: Buffer.byteLength(html), checkedAt,
    });
    return this.#document;
  }

  async listConversationsPayload() {
    return this.#rpc(GEMINI_RPC.listConversations, buildConversationListRequest());
  }

  async readConversationPayload(conversationId) {
    return this.#rpc(GEMINI_RPC.readConversation, buildConversationReadRequest(conversationId));
  }

  async #rpc(rpcId, fReq, { timeoutMs = 60_000 } = {}) {
    if (!this.#bundle || !this.#document) throw fail('GEMINI_SESSION_NOT_READY', 'Gemini session has not been started.');
    if (![GEMINI_RPC.listConversations, GEMINI_RPC.readConversation].includes(rpcId)) {
      throw fail('GEMINI_RPC_OUT_OF_SCOPE', 'Gemini RPC is not in the read-only allowlist.', { rpcId });
    }
    if (typeof fReq !== 'string' || fReq.length > 250_000) {
      throw fail('GEMINI_RPC_INPUT_INVALID', 'Gemini RPC input is invalid.', { rpcId });
    }
    const requestId = this.#reqId();
    if (!Number.isInteger(requestId) || requestId < 1_000_000 || requestId > 9_999_999) {
      throw fail('GEMINI_REQUEST_ID_INVALID', 'Gemini request id is invalid.', { rpcId });
    }
    const url = new URL(GEMINI_BATCH_PATH, GEMINI_ORIGIN);
    for (const [key, value] of Object.entries({
      rpcids: rpcId,
      'source-path': this.#document.sourcePath,
      bl: this.#document.bl,
      'f.sid': this.#document.sid,
      hl: 'ko',
      _reqid: String(requestId),
      rt: 'c',
    })) url.searchParams.set(key, value);

    let cookie;
    try { cookie = cookiesFor(this.#bundle, url, this.#now()); }
    catch (error) {
      if (error instanceof GeminiProtocolError) throw error;
      throw fail('GEMINI_AUTH_COOKIE_MISSING', 'Gemini RPC has no cookies scoped to this request.', { rpcId });
    }
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          cookie,
          origin: GEMINI_ORIGIN,
          referer: GEMINI_ORIGIN + '/',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
          accept: '*/*',
        },
        body: new URLSearchParams({ 'f.req': fReq, at: this.#document.at }),
      });
    } catch (error) {
      const transportCode = safeErrorCode(error);
      this.evidence.push({
        operation: rpcId, method: 'POST', origin: GEMINI_ORIGIN, path: GEMINI_BATCH_PATH,
        queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
        httpStatus: null, mime: null, bytes: null, checkedAt: new Date(this.#now()).toISOString(),
        ...(transportCode ? { transportCode } : {}),
      });
      throw fail('GEMINI_RPC_TRANSPORT', 'Gemini RPC transport failed.', { rpcId, transportCode });
    }
    let authDeleted;
    try { authDeleted = this.#rotateObservedCookies(response, url); }
    catch (error) {
      this.evidence.push(responseEvidence({ operation: rpcId, method: 'POST', url, response,
        mime: response.headers.get('content-type'), bytes: declaredLength(response), errorCode: safeErrorCode(error) ?? 'GEMINI_SESSION_ROTATION_FAILED' }));
      throw error;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      this.evidence.push({ ...responseEvidence({ operation: rpcId, method: 'POST', url, response,
        mime: response.headers.get('content-type'), bytes: declaredLength(response), errorCode: 'GEMINI_RPC_HTTP_ERROR' }),
        queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'] });
      throw fail('GEMINI_RPC_HTTP_ERROR', `Gemini RPC returned HTTP ${response.status}.`, { rpcId, httpStatus: response.status });
    }
    if (authDeleted) {
      await response.body?.cancel().catch(() => {});
      this.evidence.push({ ...responseEvidence({ operation: rpcId, method: 'POST', url, response,
        mime: response.headers.get('content-type'), bytes: declaredLength(response), errorCode: 'GEMINI_REAUTH_REQUIRED' }),
        queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'] });
      throw fail('GEMINI_REAUTH_REQUIRED', 'Gemini deleted an authentication cookie; bootstrap the session again.', { rpcId });
    }
    const mime = response.headers.get('content-type') || '';
    if (!/^application\/json(?:\s*;|$)/i.test(mime)) {
      await response.body?.cancel().catch(() => {});
      this.evidence.push({ ...responseEvidence({ operation: rpcId, method: 'POST', url, response,
        mime, bytes: declaredLength(response), errorCode: 'GEMINI_RPC_MIME' }),
        queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'] });
      throw fail('GEMINI_RPC_MIME', 'Gemini RPC did not return JSON.', { rpcId, httpStatus: response.status });
    }
    let body;
    let attempt;
    try {
      body = await boundedText(response);
      attempt = responseEvidence({ operation: rpcId, method: 'POST', url, response, mime, bytes: Buffer.byteLength(body) });
      attempt.queryKeys = ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'];
      this.evidence.push(attempt);
      return parseBatchReply(body, rpcId);
    } catch (error) {
      if (!attempt) {
        attempt = responseEvidence({ operation: rpcId, method: 'POST', url, response, mime,
          bytes: body === undefined ? declaredLength(response) : Buffer.byteLength(body), errorCode: safeErrorCode(error) ?? 'GEMINI_RPC_PARSE_FAILED' });
        attempt.queryKeys = ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'];
        this.evidence.push(attempt);
      } else {
        attempt.errorCode = safeErrorCode(error) ?? 'GEMINI_RPC_PARSE_FAILED';
      }
      throw error;
    }
  }
}

export class GeminiWebClient {
  constructor(options = {}) {
    this.transport = options.transport ?? new GeminiHttpTransport(options);
    this.evidence = this.transport.evidence;
  }

  async start() {
    return this.transport.start();
  }

  async listConversations() {
    const payload = await this.transport.listConversationsPayload();
    return parseConversationList(payload);
  }

  async readConversation(conversationId) {
    if (!isGeminiConversationId(conversationId)) {
      throw fail('GEMINI_CONVERSATION_ID_INVALID', 'Gemini conversation id is invalid.');
    }
    const conversations = await this.listConversations();
    const conversation = conversations.find((item) => item.id.toLowerCase() === conversationId.toLowerCase());
    if (!conversation) {
      throw fail('GEMINI_CONVERSATION_OUT_OF_SCOPE', 'Conversation is not present in the current Gemini list.');
    }
    const payload = await this.transport.readConversationPayload(conversation.id);
    return { id: conversation.id, title: conversation.title, rows: parseConversationRows(payload) };
  }
}
