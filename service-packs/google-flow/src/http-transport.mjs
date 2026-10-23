import { randomInt } from 'node:crypto';
import { readCredential, writeCredential } from './secure-credential-store.mjs';
import { FLOW_CREDENTIAL } from './session-name.mjs';
import { getBatchPayload, FlowProtocolError, isFlowErrorCandidateReason } from './protocol.mjs';
import { createFlowDocumentDiagnostics, createFlowDocumentError, parseFlowDocument } from './document-diagnostics.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const BATCH_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';
const PROJECT_ID = /^[a-f0-9-]{16,64}$/i;
const MAX_BODY = 5 * 1024 * 1024;
const COOKIE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/;
const COOKIE_VALUE = /^(?:[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E])*$/;
const FLOW_COOKIE_DOMAINS = new Set(['flow.google.com', 'google.com']);
const AUTH_COOKIE_NAMES = new Set(['SID', '__Secure-1PSID', 'OSID', '__Secure-OSID']);

export function classifyFlowRedirect(location, requestUrl = FLOW_ORIGIN) {
  if (typeof location !== 'string' || !location.trim()) return 'other';
  try {
    const target = new URL(location, requestUrl);
    const hostname = target.hostname.toLowerCase();
    if (hostname === 'accounts.google.com'
        || (hostname === 'www.google.com' && /\/(?:signin|servicelogin|login|accountchooser)(?:\/|$)/i.test(target.pathname))) {
      return 'accounts_login';
    }
    if (target.origin === FLOW_ORIGIN) {
      if (/^\/project\/[A-Fa-f0-9-]{16,64}\/?$/.test(target.pathname)) return 'flow_project';
      if (target.pathname === '/' || /^\/(?:home|home\/)$/i.test(target.pathname)) return 'flow_root';
    }
  } catch { /* Never include the raw Location value in diagnostics. */ }
  return 'other';
}

function validateGenerationFrequency(freq, activeProjectId, inputMode = 'verified_pure_http') {
  if (typeof freq !== 'string' || freq.length > 250_000 || freq.includes('__CAPTCHA__')) return false;
  if (!['verified_pure_http', 'absent_probe'].includes(inputMode)) return false;
  try {
    const envelope = JSON.parse(freq);
    if (!Array.isArray(envelope) || envelope.length !== 1 || !Array.isArray(envelope[0]) || envelope[0].length !== 1) return false;
    const rpc = envelope?.[0]?.[0];
    if (!Array.isArray(rpc) || rpc.length !== 4 || rpc[0] !== 'YhhmEf'
        || typeof rpc[1] !== 'string' || rpc[2] !== null || rpc[3] !== 'generic') return false;
    const payload = JSON.parse(rpc[1]);
    const requests = payload?.[0];
    const request = Array.isArray(requests) && requests.length === 1 ? requests[0] : null;
    const context = payload?.[1];
    const inputSlot = context?.[10];
    const requestId = payload?.[2];
    const token = inputSlot?.[0];
    const model = request?.[1];
    const prompt = request?.[0]?.[2]?.[0]?.[0]?.[0];
    const is360p = typeof model === 'string' && model.endsWith('_360p');
    const validProbeModel = inputMode !== 'absent_probe' || (model === 'abra_t2v_8s' && request?.[2] === 2);
    const validVideoShape = Array.isArray(request) && (is360p
      ? request.length === 8 && request[5] === null && request[6] === null
        && Array.isArray(request[7]) && request[7].length === 1 && request[7][0] === 4
      : request.length === 5);
    return Array.isArray(payload) && payload.length === 3
      && validVideoShape
      && (inputMode === 'absent_probe' ? validProbeModel : /^abra_t2v_(?:4|6|8|10)s(?:_360p)?$/.test(model))
      && (inputMode === 'absent_probe' ? request[2] === 2 : (request[2] === 1 || request[2] === 2))
      && typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 20_000
      && Array.isArray(request[4]) && request[4].length === 6
      && request[4].slice(0, 4).every(value => value === null)
      && request[4].slice(4).every(id => typeof id === 'string' && /^[A-F0-9-]{36}$/.test(id))
      && Array.isArray(context) && context.length === (inputMode === 'absent_probe' ? 10 : 11) && context[1] === 22
      && context[0] === null && context[2] === null && context[3] === null && context[4] === null
      && context[6] === null && context[7] === null && context[8] === null && context[9] === null
      && typeof activeProjectId === 'string' && typeof context[5] === 'string'
      && context[5].toLowerCase() === activeProjectId.toLowerCase()
      && (inputMode === 'absent_probe'
        ? inputSlot === undefined
        : Array.isArray(inputSlot) && inputSlot.length === 2
          && inputSlot[1] === 1
          && typeof token === 'string' && token.trim().length > 0 && token.length <= 8_192
          && !/[\r\n\0]/.test(token))
      && Array.isArray(requestId) && requestId.length === 2
      && typeof requestId[0] === 'string' && /^[A-F0-9-]{36}$/.test(requestId[0])
      && requestId[1] === 2;
  } catch { return false; }
}
function cookieHeader(bundle, url) {
  if (url.origin !== FLOW_ORIGIN || url.protocol !== 'https:') {
    throw new FlowProtocolError('Flow credential target is outside its origin.');
  }
  if (typeof bundle.cookieHeader === 'string' && bundle.cookieHeader) return bundle.cookieHeader;
  if (Array.isArray(bundle.cookies)) {
    const now = Date.now() / 1000;
    const selected = bundle.cookies.filter(cookie => {
      if (!cookie || typeof cookie !== 'object'
        || typeof cookie.name !== 'string' || !COOKIE_NAME.test(cookie.name)
        || typeof cookie.value !== 'string' || /[\r\n\0;]/.test(cookie.value)) return false;

      const rawDomain = typeof cookie.domain === 'string' ? cookie.domain.trim().toLowerCase() : '';
      if (!rawDomain) return false;
      const domainScoped = rawDomain.startsWith('.') || cookie.hostOnly === false;
      const domain = rawDomain.replace(/^\./, '');
      if (domain !== 'flow.google.com' && domain !== 'google.com') return false;
      if (domainScoped) {
        if (url.hostname !== domain && !url.hostname.endsWith('.' + domain)) return false;
      } else if (url.hostname !== domain) {
        return false;
      }

      const cookiePath = cookie.path;
      if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/')) return false;
      if (url.pathname !== cookiePath
        && (!url.pathname.startsWith(cookiePath)
          || (!cookiePath.endsWith('/') && url.pathname[cookiePath.length] !== '/'))) return false;

      if (cookie.secure === true && url.protocol !== 'https:') return false;
      if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') return false;

      const rawExpires = cookie.expires ?? cookie.expirationDate;
      if (rawExpires === undefined || rawExpires === null) return cookie.session === true;
      const expires = Number(rawExpires);
      return Number.isFinite(expires) && (expires < 0 || expires > now);
    });
    if (!selected.length) throw new FlowProtocolError('Protected Flow session has no cookies scoped to this request.');
    return selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  throw new FlowProtocolError('The protected Flow session is unavailable.');
}

function defaultCookiePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname === '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

export function parseObservedSetCookie(line, responseUrl, now = Date.now()) {
  if (typeof line !== 'string' || line.length > 16_384 || /[\r\n\0]/.test(line)) return null;
  const [pair, ...parts] = line.split(';');
  const equal = pair.indexOf('=');
  if (equal < 1) return null;
  const name = pair.slice(0, equal).trim();
  const value = pair.slice(equal + 1).trim();
  if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) return null;

  const attributes = Object.create(null);
  for (const part of parts) {
    const attribute = part.trim();
    if (!attribute) continue;
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const attributeValue = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(key) || Object.hasOwn(attributes, key)) return null;
    attributes[key] = attributeValue;
  }

  if (Object.hasOwn(attributes, 'partitioned')) return null;
  for (const flag of ['secure', 'httponly']) {
    if (Object.hasOwn(attributes, flag) && attributes[flag] !== '') return null;
  }
  const secure = Object.hasOwn(attributes, 'secure');
  const httpOnly = Object.hasOwn(attributes, 'httponly');

  const hasDomain = Object.hasOwn(attributes, 'domain');
  let domain = responseUrl.hostname.toLowerCase();
  if (hasDomain) {
    const rawDomain = attributes.domain.toLowerCase();
    if (rawDomain.startsWith('..')) return null;
    domain = rawDomain.replace(/^\./, '');
    if (!FLOW_COOKIE_DOMAINS.has(domain)) return null;
    const host = responseUrl.hostname.toLowerCase();
    if (host !== domain && !host.endsWith('.' + domain)) return null;
  }

  let path = defaultCookiePath(responseUrl.pathname);
  if (Object.hasOwn(attributes, 'path')) {
    path = attributes.path;
    if (!path.startsWith('/') || /[\r\n\0;]/.test(path)) return null;
  }

  let sameSite;
  if (Object.hasOwn(attributes, 'samesite')) {
    const normalized = attributes.samesite.toLowerCase();
    if (normalized === 'lax') sameSite = 'Lax';
    else if (normalized === 'strict') sameSite = 'Strict';
    else if (normalized === 'none') sameSite = 'None';
    else return null;
  }
  if ((name.startsWith('__Secure-') || name.startsWith('__Host-')) && !secure) return null;
  if (name.startsWith('__Host-') && (hasDomain || path !== '/')) return null;
  if (sameSite === 'None' && !secure) return null;

  let expires;
  let session = true;
  let expired = false;
  if (Object.hasOwn(attributes, 'max-age')) {
    if (!/^-?\d+$/.test(attributes['max-age'])) return null;
    const maxAge = Number(attributes['max-age']);
    if (!Number.isSafeInteger(maxAge)) return null;
    if (maxAge <= 0) expired = true;
    else {
      expires = now / 1000 + maxAge;
      session = false;
    }
  } else if (Object.hasOwn(attributes, 'expires')) {
    const expiresAt = Date.parse(attributes.expires);
    if (!Number.isFinite(expiresAt)) return null;
    expires = expiresAt / 1000;
    session = false;
    expired = expiresAt <= now;
  }

  const cookie = {
    name,
    value,
    domain,
    path,
    hostOnly: !hasDomain,
    secure,
    httpOnly,
    session,
    ...(sameSite === undefined ? {} : { sameSite }),
    ...(expires === undefined ? {} : { expires }),
  };
  return { name, domain, path, deleted: expired, cookie };
}

function sameCookieScope(cookie, update) {
  if (cookie?.name !== update.name || cookie.path !== update.path || typeof cookie.domain !== 'string') return false;
  const rawDomain = cookie.domain.trim().toLowerCase();
  return rawDomain.replace(/^\./, '') === update.domain;
}

async function boundedText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new FlowProtocolError('Flow response exceeded the size limit.');
  let length = 0;
  const parts = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_BODY) throw new FlowProtocolError('Flow response exceeded the size limit.');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

export class FlowHttpTransport {
  constructor({ fetchImpl = globalThis.fetch, readCredentialImpl = readCredential,
    writeCredentialImpl = writeCredential } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible function is required.');
    if (typeof readCredentialImpl !== 'function' || typeof writeCredentialImpl !== 'function') {
      throw new TypeError('Credential store functions are required.');
    }
    this.fetch = fetchImpl;
    this.readCredential = readCredentialImpl;
    this.writeCredential = writeCredentialImpl;
    this.bundle = null;
    this.document = null;
  }

  async start() {
    const stored = this.readCredential(FLOW_CREDENTIAL);
    if (!stored) throw new FlowProtocolError('No protected Flow session is stored. Bootstrap from the signed-in first-party page.');
    let bundle;
    try { bundle = JSON.parse(stored); } catch { throw new FlowProtocolError('Protected Flow session is invalid.'); }
    if (bundle?.version !== 1 || bundle.origin !== FLOW_ORIGIN || !PROJECT_ID.test(bundle.projectId)
      || bundle.reauthRequired === true
      || (typeof bundle.cookieHeader !== 'string' && !Array.isArray(bundle.cookies))) {
      throw new FlowProtocolError('Protected Flow session has an unexpected scope.');
    }
    this.bundle = bundle;
    await this.refreshDocument();
  }

  rotateObservedCookies(response) {
    let responseUrl;
    try {
      if (!response.url) return false;
      responseUrl = new URL(response.url);
    } catch { return false; }
    if (responseUrl.origin !== FLOW_ORIGIN) return false;
    const headers = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (!headers.length) return false;
    const updates = headers.map(line => parseObservedSetCookie(line, responseUrl)).filter(Boolean);
    if (!updates.length) return false;

    let changed = false;
    let authDeleted = false;
    if (typeof this.bundle.cookieHeader === 'string' && this.bundle.cookieHeader) {
      const values = new Map(this.bundle.cookieHeader.split(/;\s*/).map(entry => {
        const equal = entry.indexOf('=');
        return [entry.slice(0, equal), entry.slice(equal + 1)];
      }));
      for (const update of updates) {
        // A flat legacy header has no saved path/domain scope. Only root-scoped
        // Flow cookies can be safely rotated through this compatibility format.
        if (update.path !== '/' || !values.has(update.name)) continue;
        if (update.deleted) {
          values.delete(update.name);
          if (AUTH_COOKIE_NAMES.has(update.name)) authDeleted = true;
        } else {
          values.set(update.name, update.cookie.value);
        }
        changed = true;
      }
      if (changed) {
        this.bundle.cookieHeader = [...values].map(([name, value]) => `${name}=${value}`).join('; ');
        this.bundle.cookieCount = values.size;
      }
    } else if (Array.isArray(this.bundle.cookies)) {
      const cookies = this.bundle.cookies.map(cookie => ({ ...cookie }));
      for (const update of updates) {
        const index = cookies.findIndex(cookie => sameCookieScope(cookie, update));
        if (update.deleted) {
          if (index >= 0) {
            cookies.splice(index, 1);
            if (AUTH_COOKIE_NAMES.has(update.name)) authDeleted = true;
          }
        } else {
          if (index >= 0) cookies[index] = update.cookie;
          else cookies.push(update.cookie);
        }
        if (index >= 0 || !update.deleted) changed = true;
      }
      if (changed) {
        this.bundle.cookies = cookies;
        this.bundle.cookieCount = cookies.length;
      }
    }
    if (!changed && !authDeleted) return false;
    if (authDeleted) this.bundle.reauthRequired = true;
    this.writeCredential(FLOW_CREDENTIAL, JSON.stringify(this.bundle));
    return authDeleted;
  }

  async refreshDocument() {
    if (!this.bundle) throw new FlowProtocolError('Flow session is not loaded.');
    const sourcePath = `/project/${this.bundle.projectId}`;
    const url = new URL(sourcePath, FLOW_ORIGIN);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { cookie: cookieHeader(this.bundle, url), accept: 'text/html' },
      });
    } catch { throw new FlowProtocolError('Flow document transport failed.'); }
    const authDeleted = this.rotateObservedCookies(response);
    const mime = response.headers.get('content-type') || '';
    const responseUrl = response.url || url.href;
    const isRedirect = response.status >= 300 && response.status < 400;
    const redirectCategory = isRedirect ? classifyFlowRedirect(response.headers.get('location'), url.href) : null;
    if (authDeleted) {
      const documentDiagnostics = createFlowDocumentDiagnostics({
        httpStatus: response.status, mime, sourcePath, responseUrl,
      });
      await response.body?.cancel().catch(() => {});
      const detail = isRedirect ? `after a redirect (${redirectCategory})`
        : response.status === 200 ? '' : `after HTTP ${response.status}`;
      const error = createFlowDocumentError(
        `Flow deleted an authentication cookie${detail ? ` ${detail}` : ''}; bootstrap again.`,
        { code: 'FLOW_DOCUMENT_AUTH_COOKIE_DELETED', httpStatus: response.status, diagnostics: documentDiagnostics },
      );
      if (isRedirect) error.redirectCategory = redirectCategory;
      throw error;
    }
    if (isRedirect) {
      const documentDiagnostics = createFlowDocumentDiagnostics({
        httpStatus: response.status, mime, sourcePath, responseUrl,
      });
      await response.body?.cancel().catch(() => {});
      const error = createFlowDocumentError('Flow document redirected (' + redirectCategory + '); redirect following is disabled.', {
        code: 'FLOW_DOCUMENT_REDIRECT', httpStatus: response.status, diagnostics: documentDiagnostics,
      });
      error.redirectCategory = redirectCategory;
      throw error;
    }
    if (response.status !== 200) {
      const documentDiagnostics = createFlowDocumentDiagnostics({
        httpStatus: response.status, mime, sourcePath, responseUrl,
      });
      await response.body?.cancel().catch(() => {});
      throw createFlowDocumentError(
        `Flow document returned HTTP ${response.status}; session validity is undetermined.`,
        { code: 'FLOW_DOCUMENT_HTTP_ERROR', httpStatus: response.status, diagnostics: documentDiagnostics },
      );
    }
    if (!/^text\/html(?:\s*;|$)/i.test(mime)) {
      const documentDiagnostics = createFlowDocumentDiagnostics({
        httpStatus: response.status, mime, sourcePath, responseUrl,
      });
      await response.body?.cancel().catch(() => {});
      throw createFlowDocumentError('Flow document did not return HTML.', {
        code: 'FLOW_DOCUMENT_MIME_UNEXPECTED', httpStatus: response.status, diagnostics: documentDiagnostics,
      });
    }
    const html = await boundedText(response);
    this.document = {
      ...parseFlowDocument(html, { sourcePath, responseUrl, httpStatus: response.status, mime }),
      checkedAt: new Date().toISOString(),
    };
    return { projectId: this.bundle.projectId, documentStatus: 200, checkedAt: this.document.checkedAt };
  }

  getContext() {
    if (!this.bundle || !this.document) throw new FlowProtocolError('Flow session is not ready.');
    return { projectId: this.bundle.projectId, documentCheckedAt: this.document.checkedAt };
  }

  async rpc(rpcId, freq, { timeoutMs = 60_000 } = {}) {
    if (!['Zzl0ze', 'as29s', 'jwpduf'].includes(rpcId)) throw new FlowProtocolError('RPC is not in the browser-free read catalog.', { rpcId });
    return this.sendRpc(rpcId, freq, { timeoutMs });
  }

  async createVideo(freq, { timeoutMs = 60_000, inputMode = 'verified_pure_http' } = {}) {
    if (!validateGenerationFrequency(freq, this.bundle?.projectId, inputMode)) {
      throw new FlowProtocolError('Flow generation request is invalid or has no fresh first-party input.', {
        code: 'FLOW_GENERATION_REQUEST_INVALID', rpcId: 'YhhmEf', rejected: true,
      });
    }
    return this.sendRpc('YhhmEf', freq, { timeoutMs, generation: true, inputMode });
  }

  async sendRpc(rpcId, freq, { timeoutMs = 60_000, generation = false, inputMode = 'verified_pure_http' } = {}) {
    if (!this.bundle || !this.document) throw new FlowProtocolError('Flow session is not ready.');
    if (generation ? rpcId !== 'YhhmEf' : !['Zzl0ze', 'as29s', 'jwpduf'].includes(rpcId)) {
      throw new FlowProtocolError('RPC is not in the observed Flow HTTP catalog.', { rpcId });
    }
    if (generation && !validateGenerationFrequency(freq, this.bundle.projectId, inputMode)) {
      throw new FlowProtocolError('Flow generation request is invalid or outside the protected project scope.', {
        code: 'FLOW_GENERATION_REQUEST_INVALID', rpcId, rejected: true,
      });
    }
    if (typeof freq !== 'string' || freq.length > 250_000 || freq.includes('__CAPTCHA__')) {
      throw new FlowProtocolError('Flow RPC input is invalid.', { rpcId, rejected: generation });
    }
    const url = new URL(BATCH_PATH, FLOW_ORIGIN);
    for (const [key, value] of Object.entries({
      rpcids: rpcId,
      'source-path': this.document.sourcePath,
      bl: this.document.bl,
      'f.sid': this.document.sid,
      hl: 'ko',
      _reqid: String(randomInt(100000, 1000000)),
      rt: 'c',
    })) url.searchParams.set(key, value);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          cookie: cookieHeader(this.bundle, url),
          origin: FLOW_ORIGIN,
          referer: `${FLOW_ORIGIN}/`,
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
          accept: '*/*',
        },
        body: new URLSearchParams({ 'f.req': freq, at: this.document.at }),
      });
    } catch {
      throw new FlowProtocolError(generation
        ? 'Flow generation transport ended without a confirmed response; outcome is uncertain.'
        : 'Flow direct HTTP transport failed.', { rpcId, ambiguous: generation });
    }
    let authDeleted;
    try { authDeleted = this.rotateObservedCookies(response); } catch {
      throw new FlowProtocolError(generation
        ? 'Flow generation response could not be recorded; outcome is uncertain.'
        : 'Flow response cookie rotation could not be recorded.', { rpcId, httpStatus: response.status, ambiguous: generation });
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new FlowProtocolError(generation
        ? 'Flow generation returned HTTP ' + response.status + '; outcome is uncertain.'
        : `Flow RPC returned HTTP ${response.status}.`,
        { rpcId, httpStatus: response.status, ambiguous: generation });
    }
    if (authDeleted) {
      await response.body?.cancel().catch(() => {});
      throw new FlowProtocolError(generation
        ? 'Flow deleted an authentication cookie after generation; outcome is uncertain.'
        : 'Flow deleted an authentication cookie; bootstrap again.', { rpcId, httpStatus: response.status, ambiguous: generation });
    }
    const mime = response.headers.get('content-type') || '';
    if (!/^application\/json(?:\s*;|$)/i.test(mime)) {
      await response.body?.cancel().catch(() => {});
      throw new FlowProtocolError(generation
        ? 'Flow generation returned an unexpected response type; outcome is uncertain.'
        : 'Flow RPC did not return JSON; login or challenge may be required.', { rpcId, httpStatus: response.status, ambiguous: generation });
    }
    let body;
    try { body = await boundedText(response); } catch {
      throw new FlowProtocolError(generation
        ? 'Flow generation response could not be read; outcome is uncertain.'
        : 'Flow RPC response could not be read.', { rpcId, httpStatus: response.status, ambiguous: generation });
    }
    let payload;
    try {
      payload = getBatchPayload(body, rpcId, { ambiguousOnMissing: generation });
    } catch (error) {
      if (!generation) throw error;
      throw new FlowProtocolError(error?.rejected === true
        ? 'Flow returned a generation RPC error; outcome is uncertain.'
        : 'Flow generation response did not contain the expected RPC result; outcome is uncertain.', {
        code: error?.code === 'FLOW_RPC_DUPLICATE_RESULT' ? error.code : undefined,
        rpcId, httpStatus: response.status, rpcStatus: error.rpcStatus, ambiguous: true, serverCode: error.serverCode,
        errorMessagePresent: error?.errorMessagePresent,
        errorInfoPresent: error?.errorInfoPresent,
        errorInfoCount: error?.errorInfoCount,
        errorDomainPresent: error?.errorDomainPresent,
        errorMetadataPresent: error?.errorMetadataPresent,
        errorMetadataCount: error?.errorMetadataCount,
        errorReasonConflict: error?.errorReasonConflict,
        errorCandidateReason: isFlowErrorCandidateReason(error?.errorCandidateReason)
          ? error.errorCandidateReason : undefined,
        errorInfoSchemaVerified: error?.errorInfoSchemaVerified === false ? false : undefined,
      });
    }
    return { payload, evidence: {
      operation: rpcId, method: 'POST', origin: FLOW_ORIGIN, path: BATCH_PATH,
      httpStatus: response.status, mime: mime.split(';')[0], bytes: Buffer.byteLength(body),
      checkedAt: new Date().toISOString(), browserUsed: false,
    } };
  }
}
