import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '../..');
const HELPER_PATH = path.join(REPO_ROOT, 'scripts/oliveyoung-anonymous-ranking-session.py');
const ORIGIN = 'https://www.oliveyoung.co.kr';
const RANKING_PATH = '/store/main/getBestList.do';
const QUERY_FIELDS = new Set(['dispCatNo', 'fltDispCatNo', 'pageIdx', 'rowsPerPage']);
const CF_COOKIE_NAMES = new Set(['__cf_bm', '_cfuvid', 'cf_clearance']);
const ACCEPT = 'text/html,application/xhtml+xml';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 32 * 1024;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class OliveyoungAnonymousRankingTransportError extends Error {
  constructor(code, anonymousSessionReceipt) {
    super(code);
    this.name = 'OliveyoungAnonymousRankingTransportError';
    this.code = code;
    if (anonymousSessionReceipt) this.anonymousSessionReceipt = anonymousSessionReceipt;
  }
}

const fail = code => { throw new OliveyoungAnonymousRankingTransportError(code); };

function resolvePythonPath(explicitPath) {
  const fromEnvironment = process.env.WEB_API_OLIVEYOUNG_PYTHON;
  const selected = explicitPath ?? fromEnvironment;
  if (selected !== undefined) {
    if (typeof selected !== 'string' || !selected.trim() || selected.length > 1024 || /[\0\r\n]/.test(selected)) {
      fail('OLIVEYOUNG_ANONYMOUS_OPTIONS_INVALID');
    }
    return selected;
  }
  const candidates = process.platform === 'win32'
    ? [path.join(REPO_ROOT, '.venv-oliveyoung', 'Scripts', 'python.exe')]
    : [path.join(REPO_ROOT, '.venv-oliveyoung', 'bin', 'python')];
  return candidates.find(candidate => existsSync(candidate)) ?? 'python3';
}

function validateTarget(input, init = {}) {
  let request;
  try { request = new Request(input, init); }
  catch { fail('OLIVEYOUNG_ANONYMOUS_REQUEST_INVALID'); }
  if (request.method !== 'GET' || request.bodyUsed || request.mode === 'navigate' ||
      request.credentials === 'include' || request.redirect !== 'manual') {
    fail('OLIVEYOUNG_ANONYMOUS_REQUEST_REJECTED');
  }
  let url;
  try { url = new URL(request.url); }
  catch { fail('OLIVEYOUNG_ANONYMOUS_TARGET_REJECTED'); }
  if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || url.pathname !== RANKING_PATH) {
    fail('OLIVEYOUNG_ANONYMOUS_TARGET_REJECTED');
  }
  if (url.search.length > 1024) fail('OLIVEYOUNG_ANONYMOUS_QUERY_REJECTED');
  const names = new Set();
  for (const [name, value] of url.searchParams) {
    if (!QUERY_FIELDS.has(name) || names.has(name) || value.length > 64 || CONTROL.test(value)) {
      fail('OLIVEYOUNG_ANONYMOUS_QUERY_REJECTED');
    }
    names.add(name);
  }
  if (names.size && names.size !== QUERY_FIELDS.size) fail('OLIVEYOUNG_ANONYMOUS_QUERY_REJECTED');
  if (names.size) {
    const value = Object.fromEntries(url.searchParams);
    if (!/^\d{1,18}$/.test(value.dispCatNo) || value.fltDispCatNo && !/^\d{1,18}$/.test(value.fltDispCatNo) ||
        !/^\d{1,6}$/.test(value.pageIdx) || !/^\d{1,4}$/.test(value.rowsPerPage)) {
      fail('OLIVEYOUNG_ANONYMOUS_QUERY_REJECTED');
    }
  }
  if ([...request.headers].length !== 1 || request.headers.get('accept') !== ACCEPT) {
    fail('OLIVEYOUNG_ANONYMOUS_HEADERS_REJECTED');
  }
  return { request, url };
}

function validateSafeNameList(value, allowed = null) {
  return Array.isArray(value) && value.length <= 16 && value.every(name =>
    typeof name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) &&
    (!allowed || allowed.has(name))) && new Set(value).size === value.length;
}

function validateBootstrapReceipt(value, requireIssuedCookies, allowPartial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.method !== 'GET' || value.origin !== ORIGIN || value.path !== '/store/main/main.do' ||
      !(allowPartial && value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 200 && value.httpStatus <= 599) ||
      !(value.mime === null || typeof value.mime === 'string' && value.mime.length <= 256 && !CONTROL.test(value.mime)) ||
      !(allowPartial && value.responseBytes === null || Number.isSafeInteger(value.responseBytes) && value.responseBytes >= 0) ||
      !(allowPartial && value.responseSha256 === null || typeof value.responseSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.responseSha256)) ||
      typeof value.checkedAt !== 'string' ||
      value.browserUsed !== false || value.anonymous !== true || value.cookieSent !== false ||
      value.credentialsUsed !== false || value.inputCookiesAccepted !== false ||
      typeof value.sourceSetCookiePresent !== 'boolean' ||
      !Number.isSafeInteger(value.sourceSetCookieCount) || value.sourceSetCookieCount < 0 ||
      value.sourceSetCookiePresent !== (value.sourceSetCookieCount > 0) ||
      value.sourceSetCookieCount !== value.sourceSetCookieNames?.length ||
      !validateSafeNameList(value.sourceSetCookieNames) ||
      !validateSafeNameList(value.issuedCookieNames, CF_COOKIE_NAMES) ||
      requireIssuedCookies && !value.issuedCookieNames.length ||
      !validateSafeNameList(value.cookieNames, CF_COOKIE_NAMES) ||
      value.issuedCookieNames.some(name => !value.sourceSetCookieNames.includes(name))) {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
}

function validateFailureRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.method !== 'GET' || value.origin !== ORIGIN || value.path !== RANKING_PATH ||
      !(value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 200 && value.httpStatus <= 599) ||
      !(value.mime === null || typeof value.mime === 'string' && value.mime.length <= 256 && !CONTROL.test(value.mime)) ||
      !(value.responseBytes === null || Number.isSafeInteger(value.responseBytes) && value.responseBytes >= 0) ||
      !(value.responseSha256 === null || typeof value.responseSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.responseSha256)) ||
      typeof value.checkedAt !== 'string' || value.browserUsed !== false || value.anonymous !== true ||
      value.credentialsUsed !== false || value.inputCookiesAccepted !== false ||
      value.sessionKind !== 'server_issued_anonymous' ||
      !validateSafeNameList(value.cookieNames, CF_COOKIE_NAMES) ||
      !validateSafeNameList(value.sentCookieNames, CF_COOKIE_NAMES) ||
      value.cookieSent !== (value.sentCookieNames.length > 0) ||
      value.cookieNames.length !== value.sentCookieNames.length ||
      value.cookieNames.some((name, index) => name !== value.sentCookieNames[index]) ||
      !validateSafeNameList(value.sourceSetCookieNames) ||
      typeof value.sourceSetCookiePresent !== 'boolean' ||
      !Number.isSafeInteger(value.sourceSetCookieCount) || value.sourceSetCookieCount < 0 ||
      value.sourceSetCookiePresent !== (value.sourceSetCookieCount > 0) ||
      value.sourceSetCookieCount !== value.sourceSetCookieNames.length) {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
}

function validateFailureReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'anonymous,bootstrapRequest,browserUsed,credentialsUsed,inputCookiesAccepted,phase,request,retryAfter' ||
      value.anonymous !== true || value.browserUsed !== false || value.credentialsUsed !== false ||
      value.inputCookiesAccepted !== false || !['bootstrap', 'ranking'].includes(value.phase) ||
      !(value.retryAfter === null || typeof value.retryAfter === 'string' && value.retryAfter.length <= 128 && !CONTROL.test(value.retryAfter))) {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
  if (value.phase === 'bootstrap') {
    validateBootstrapReceipt(value.bootstrapRequest, false, true);
    if (value.request !== null) fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  } else {
    validateBootstrapReceipt(value.bootstrapRequest, true);
    validateFailureRequest(value.request);
  }
}

function validateSessionReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'anonymous,bootstrapRequest,browserUsed,credentialsUsed,inputCookiesAccepted,phase,request,retryAfter') {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
  const bootstrap = value.bootstrapRequest;
  validateBootstrapReceipt(bootstrap, value.phase === 'ranking' || bootstrap?.httpStatus === 200);
  if (value.anonymous !== true || value.browserUsed !== false || value.credentialsUsed !== false ||
      value.inputCookiesAccepted !== false || !['bootstrap', 'ranking'].includes(value.phase) ||
      !(value.retryAfter === null || typeof value.retryAfter === 'string' && value.retryAfter.length <= 128 && !CONTROL.test(value.retryAfter))) {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
  if (value.phase === 'bootstrap') {
    if (value.request !== null) fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
    return;
  }
  const request = value.request;
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      request.method !== 'GET' || request.origin !== ORIGIN || request.path !== RANKING_PATH ||
      !Number.isInteger(request.httpStatus) || request.httpStatus < 200 || request.httpStatus > 599 ||
      !(request.mime === null || typeof request.mime === 'string' && request.mime.length <= 256 && !CONTROL.test(request.mime)) ||
      !Number.isSafeInteger(request.responseBytes) || request.responseBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(request.responseSha256) || typeof request.checkedAt !== 'string' ||
      request.browserUsed !== false || request.anonymous !== true || request.cookieSent !== true ||
      request.credentialsUsed !== false || request.inputCookiesAccepted !== false ||
      request.sessionKind !== 'server_issued_anonymous' ||
      !validateSafeNameList(request.cookieNames, CF_COOKIE_NAMES) || !request.cookieNames.length ||
      !validateSafeNameList(request.sentCookieNames, CF_COOKIE_NAMES) ||
      request.sentCookieNames.length !== request.cookieNames.length ||
      request.sentCookieNames.some((name, index) => name !== request.cookieNames[index]) ||
      request.cookieNames.some(name => !bootstrap.issuedCookieNames.includes(name))) {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
}

function validateReply(reply, maxResponseBytes) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || reply.ok !== true ||
      !Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 ||
      typeof reply.bodyBase64 !== 'string' || !reply.headers || typeof reply.headers !== 'object' ||
      Array.isArray(reply.headers) || Object.keys(reply.headers).some(name => !['content-type', 'retry-after'].includes(name)) ||
      !reply.transport || reply.transport.library !== 'curl_cffi' || reply.transport.version !== '0.16.3' ||
      reply.transport.profile !== 'chrome150' || !Object.hasOwn(reply, 'anonymousSessionReceipt')) {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
  for (const [name, value] of Object.entries(reply.headers)) {
    const maxLength = name === 'retry-after' ? 128 : 256;
    if (typeof value !== 'string' || value.length > maxLength || CONTROL.test(value)) {
      fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
    }
  }
  validateSessionReceipt(reply.anonymousSessionReceipt);
  let body;
  try { body = Buffer.from(reply.bodyBase64, 'base64'); }
  catch { fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'); }
  if (body.byteLength > maxResponseBytes || body.toString('base64') !== reply.bodyBase64) {
    fail('OLIVEYOUNG_ANONYMOUS_RESPONSE_TOO_LARGE');
  }
  if (body.byteLength !== reply.anonymousSessionReceipt.request?.responseBytes &&
      reply.anonymousSessionReceipt.phase === 'ranking' ||
      body.byteLength !== reply.anonymousSessionReceipt.bootstrapRequest.responseBytes &&
      reply.anonymousSessionReceipt.phase === 'bootstrap') {
    fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
  }
  return body;
}

function safeErrorCode(value) {
  const codes = new Set([
    'ANONYMOUS_COOKIE_UNAVAILABLE', 'COOKIE_POLICY_FAILED', 'DEPENDENCY_UNAVAILABLE',
    'DEPENDENCY_VERSION_MISMATCH', 'NETWORK_FAILED', 'PROTOCOL_INVALID', 'RATE_LIMITED_UNTIL_CLOSE',
    'REQUEST_REJECTED', 'RESPONSE_TOO_LARGE', 'TLS_FAILED', 'WORKER_CLOSED',
  ]);
  return codes.has(value) ? value : 'PROCESS_FAILED';
}

/**
 * Make a persistent public-ranking fetch adapter. It bootstraps a short-lived,
 * server-issued anonymous session in memory and only forwards the observed CF
 * cookie names to the fixed Olive Young ranking route. Caller cookies and
 * caller-provided headers are never forwarded.
 */
export function createOliveyoungAnonymousRankingFetch(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['pythonPath', 'timeoutMs', 'maxResponseBytes', 'minIntervalMs'].includes(key))) {
    fail('OLIVEYOUNG_ANONYMOUS_OPTIONS_INVALID');
  }
  const pythonPath = resolvePythonPath(options.pythonPath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const minIntervalMs = options.minIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 5_000 || minIntervalMs > 120_000 ||
      timeoutMs <= minIntervalMs) {
    fail('OLIVEYOUNG_ANONYMOUS_OPTIONS_INVALID');
  }

  let child = null;
  let lineBuffer = Buffer.alloc(0);
  let pending = null;
  let workerReady = null;
  let closePromise = null;
  let closed = false;
  let rateLimited = false;
  let queue = Promise.resolve();

  function stopChild(error = new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROCESS_FAILED')) {
    const processChild = child;
    child = null;
    workerReady = null;
    lineBuffer = Buffer.alloc(0);
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.signal?.removeEventListener('abort', current.onAbort);
      current.reject(error);
    }
    if (processChild && processChild.exitCode === null && !processChild.killed) {
      processChild.kill('SIGKILL');
    }
  }

  function parseLine(raw) {
    if (raw.byteLength > MAX_LINE_BYTES || !raw.byteLength) {
      stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'));
      return;
    }
    let value;
    try { value = JSON.parse(raw.toString('utf8')); }
    catch {
      stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'));
      return;
    }
    if (!pending) {
      stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'));
      return;
    }
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.signal?.removeEventListener('abort', current.onAbort);
    current.resolve(value);
  }

  function attachProcess(processChild) {
    processChild.stdout.on('data', chunk => {
      lineBuffer = Buffer.concat([lineBuffer, chunk]);
      if (lineBuffer.byteLength > MAX_LINE_BYTES && !lineBuffer.includes(0x0a)) {
        stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'));
        return;
      }
      for (;;) {
        const newline = lineBuffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = lineBuffer.subarray(0, newline);
        lineBuffer = lineBuffer.subarray(newline + 1);
        parseLine(line);
        if (child !== processChild) return;
      }
      if (lineBuffer.byteLength > MAX_LINE_BYTES) {
        stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'));
      }
    });
    processChild.stderr.on('data', () => {});
    processChild.on('error', error => {
      stopChild(new OliveyoungAnonymousRankingTransportError(
        error?.code === 'ENOENT' ? 'OLIVEYOUNG_ANONYMOUS_PYTHON_UNAVAILABLE' :
          'OLIVEYOUNG_ANONYMOUS_PROCESS_FAILED'));
    });
    processChild.on('close', () => {
      if (child === processChild) child = null;
      if (pending) stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROCESS_FAILED'));
    });
  }

  function send(message, { signal, requestTimeoutMs = timeoutMs } = {}) {
    if (!child || pending) {
      return Promise.reject(new OliveyoungAnonymousRankingTransportError(
        'OLIVEYOUNG_ANONYMOUS_PROCESS_FAILED'));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => stopChild(new OliveyoungAnonymousRankingTransportError(
        signal?.reason?.name === 'TimeoutError' ? 'OLIVEYOUNG_ANONYMOUS_TIMEOUT' : 'OLIVEYOUNG_ANONYMOUS_ABORTED'));
      const timer = setTimeout(() => stopChild(
        new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_TIMEOUT')),
      requestTimeoutMs + 3000);
      timer.unref?.();
      pending = { resolve, reject, timer, signal, onAbort };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let encoded;
      try { encoded = Buffer.from(JSON.stringify(message) + '\n', 'utf8'); }
      catch { return stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID')); }
      if (encoded.byteLength > 16 * 1024) return stopChild(
        new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_REQUEST_TOO_LARGE'));
      child.stdin.write(encoded, error => {
        if (error) stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROCESS_FAILED'));
      });
    });
  }

  async function ensureWorker() {
    if (workerReady) return workerReady;
    const env = {
      PATH: process.env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin'),
      PYTHONNOUSERSITE: '1',
      PYTHONUNBUFFERED: '1',
    };
    child = spawn(pythonPath, [HELPER_PATH], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    attachProcess(child);
    workerReady = send({ op: 'hello', protocolVersion: 1 }, { requestTimeoutMs: 10_000 })
      .then(reply => {
        if (!reply || reply.ok !== true || reply.op !== 'hello' || !reply.transport ||
            reply.transport.library !== 'curl_cffi' || reply.transport.version !== '0.16.3' ||
            reply.transport.profile !== 'chrome150') {
          stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'));
          fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
        }
      }).catch(error => {
        workerReady = null;
        throw error;
      });
    return workerReady;
  }

  async function perform(input, init) {
    if (closed) fail('OLIVEYOUNG_ANONYMOUS_CLOSED');
    if (rateLimited) fail('OLIVEYOUNG_ANONYMOUS_RATE_LIMITED_UNTIL_CLOSE');
    const { request, url } = validateTarget(input, init);
    if (request.signal?.aborted) {
      fail(request.signal.reason?.name === 'TimeoutError' ? 'OLIVEYOUNG_ANONYMOUS_TIMEOUT' : 'OLIVEYOUNG_ANONYMOUS_ABORTED');
    }
    await ensureWorker();
    const reply = await send({
      op: 'request', protocolVersion: 1, url: url.href,
      timeoutMs, maxResponseBytes, minIntervalMs,
    }, { signal: request.signal, requestTimeoutMs: timeoutMs });
    if (reply?.ok !== true) {
      const suffix = safeErrorCode(reply?.error);
      const allowedErrorKeys = ['error', 'ok', ...(reply?.anonymousSessionReceipt ? ['anonymousSessionReceipt'] : [])].sort();
      if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
          Object.keys(reply).sort().join(',') !== allowedErrorKeys.join(',')) {
        fail('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID');
      }
      const receipt = reply.anonymousSessionReceipt;
      if (receipt) validateFailureReceipt(receipt);
      const prefix = suffix.startsWith('ANONYMOUS_') ? 'OLIVEYOUNG_' : 'OLIVEYOUNG_ANONYMOUS_';
      const error = new OliveyoungAnonymousRankingTransportError(
        prefix + suffix, suffix === 'PROCESS_FAILED' ? undefined : receipt);
      throw error;
    }
    const body = validateReply(reply, maxResponseBytes);
    if (reply.status === 429) rateLimited = true;
    const headers = new Headers();
    if (reply.headers['content-type']) headers.set('content-type', reply.headers['content-type']);
    if (reply.headers['retry-after']) headers.set('retry-after', reply.headers['retry-after']);
    headers.set('content-length', String(body.byteLength));
    const noBodyStatuses = new Set([204, 205, 304]);
    const response = new Response(noBodyStatuses.has(reply.status) ? null : body, {
      status: reply.status,
      headers,
    });
    Object.defineProperty(response, 'anonymousSessionReceipt', {
      value: reply.anonymousSessionReceipt,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return response;
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      await queue.catch(() => {});
      if (!child) return;
      try {
        const reply = await send({ op: 'close', protocolVersion: 1 }, { requestTimeoutMs: 1500 });
        if (!reply || reply.ok !== true || reply.op !== 'close') {
          stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_PROTOCOL_INVALID'));
        }
        child?.stdin.end();
        await new Promise(resolve => {
          if (!child || child.exitCode !== null) return resolve();
          const timer = setTimeout(() => {
            stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_CLOSE_TIMEOUT'));
            resolve();
          }, 1500);
          timer.unref?.();
          child.once('close', () => { clearTimeout(timer); resolve(); });
        });
      } catch {
        stopChild(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_CLOSE_FAILED'));
      }
    })();
    return closePromise;
  }

  function oliveyoungAnonymousRankingFetch(input, init = {}) {
    if (closed) return Promise.reject(new OliveyoungAnonymousRankingTransportError('OLIVEYOUNG_ANONYMOUS_CLOSED'));
    const work = queue.then(() => perform(input, init));
    queue = work.catch(() => {});
    return work;
  }
  oliveyoungAnonymousRankingFetch.close = close;
  oliveyoungAnonymousRankingFetch.transportKind = 'server_issued_anonymous';
  return oliveyoungAnonymousRankingFetch;
}
