import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '../..');
const HELPER_PATH = path.join(REPO_ROOT, 'scripts/oliveyoung-http-transport.py');
const CONTRACT_PATH = path.join(REPO_ROOT, 'references/commerce-oliveyoung-http-transport-contracts.json');
const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ALLOWED_RESPONSE_HEADERS = new Set(['content-type', 'content-length']);
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class OliveyoungHttpTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OliveyoungHttpTransportError';
    this.code = code;
  }
}

const fail = code => { throw new OliveyoungHttpTransportError(code); };
const allowedOrigins = new Set(CONTRACT.origins);
const requestHeaderNames = new Set(CONTRACT.requestHeaders);
const refererPaths = new Set(CONTRACT.refererPaths);

function resolvePythonPath(explicitPath) {
  const fromEnvironment = process.env.WEB_API_OLIVEYOUNG_PYTHON;
  const selected = explicitPath ?? fromEnvironment;
  if (selected !== undefined) {
    if (typeof selected !== 'string' || !selected.trim() || selected.length > 1024 || /[\0\r\n]/.test(selected)) {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_OPTIONS_INVALID');
    }
    return selected;
  }
  const candidates = process.platform === 'win32'
    ? [path.join(REPO_ROOT, '.venv-oliveyoung', 'Scripts', 'python.exe')]
    : [path.join(REPO_ROOT, '.venv-oliveyoung', 'bin', 'python')];
  return candidates.find(candidate => existsSync(candidate)) ?? 'python3';
}

function findRoute(origin, pathname) {
  for (const route of CONTRACT.routes) {
    if (route.origin !== origin) continue;
    if (route.path === pathname) return route;
    if (route.pathPattern && new RegExp(route.pathPattern).test(pathname)) return route;
  }
  return null;
}

function validateQuery(url, route) {
  if (url.search.length > 4096) fail('OLIVEYOUNG_HTTP_TRANSPORT_QUERY_REJECTED');
  let count = 0;
  const names = new Set();
  for (const [name, value] of url.searchParams) {
    count += 1;
    if (count > 24 || names.has(name) || !route.queryFields.includes(name) || value.length > 2048 || CONTROL.test(value)) {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_QUERY_REJECTED');
    }
    names.add(name);
    if (name === 'referer') validateReferer(value);
  }
}

function validateReferer(value) {
  let referer;
  try { referer = new URL(value); } catch { fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED'); }
  if (!allowedOrigins.has(referer.origin) || referer.username || referer.password || referer.hash ||
      !refererPaths.has(referer.pathname) || referer.search.length > 512) {
    fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
  }
  for (const [name, queryValue] of referer.searchParams) {
    if (name !== 'goodsNo' || queryValue.length > 64 || CONTROL.test(queryValue)) {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
    }
  }
}

function validateHeaders(headers, route) {
  const output = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!requestHeaderNames.has(name) || name === 'cookie' || typeof value !== 'string' ||
        value.length > 8192 || CONTROL.test(value)) {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
    }
    if (name === 'content-type') {
      const mediaType = value.split(';', 1)[0].trim().toLowerCase();
      if (!route.bodyFormat || !(['json', 'form'].includes(route.bodyFormat)) ||
          !route.allowedContentTypes.includes(mediaType)) {
        fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
      }
    } else if (name === 'origin' && !allowedOrigins.has(value)) {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
    } else if (name === 'referer') {
      validateReferer(value);
    } else if (name === 'x-requested-with' && value !== 'XMLHttpRequest') {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
    } else if (name === 'accept-language' && !/^[A-Za-z0-9,*;= ._-]{1,128}$/.test(value)) {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
    } else if (name === 'accept' && !/^[A-Za-z0-9!#$&^_.+*/;= ,_-]{1,256}$/.test(value)) {
      fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
    }
    output[name] = value;
  }
  if (route.bodyFormat && output['content-type']) {
    const mediaType = output['content-type'].split(';', 1)[0].trim().toLowerCase();
    if (!route.allowedContentTypes.includes(mediaType)) fail('OLIVEYOUNG_HTTP_TRANSPORT_HEADER_REJECTED');
  }
  return output;
}

function sensitiveFieldName(name) {
  return /cookie|authorization|password|passwd|secret|credential|csrf|xsrf|token|session|jwt|email|phone|mobile|account/i.test(name);
}

function inspectJsonValue(value, route, depth = 0, budget = { count: 0 }) {
  budget.count += 1;
  if (budget.count > 4096 || depth > 8) fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
  if (typeof value === 'string') {
    if (value.length > 8192 || CONTROL.test(value)) fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
  } else if (Array.isArray(value)) {
    for (const entry of value) inspectJsonValue(entry, route, depth + 1, budget);
  } else if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) {
      if (sensitiveFieldName(name) || depth === 0 && !route.bodyFields.includes(name)) {
        fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
      }
      inspectJsonValue(entry, route, depth + 1, budget);
    }
  }
}

function validateBody(bytes, route, headers, method) {
  if (bytes.byteLength > MAX_REQUEST_BYTES) fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_TOO_LARGE');
  if (method === 'GET') {
    if (bytes.byteLength) fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
    return;
  }
  if (!route.bodyFormat || bytes.byteLength === 0) fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
  const type = headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (!type || !route.allowedContentTypes.includes(type)) fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
  if (type === 'application/json') {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED'); }
    if (!value || Array.isArray(value) || typeof value !== 'object') fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
    inspectJsonValue(value, route);
  } else {
    const params = new URLSearchParams(bytes.toString('utf8'));
    let count = 0;
    const names = new Set();
    for (const [name, value] of params) {
      count += 1;
      if (count > 64 || names.has(name) || !route.bodyFields.includes(name) || sensitiveFieldName(name) ||
          value.length > 8192 || CONTROL.test(value)) fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_REJECTED');
      names.add(name);
    }
  }
}

async function normalizedRequest(input, init, maxResponseBytes) {
  let request;
  try { request = new Request(input, init); }
  catch { fail('OLIVEYOUNG_HTTP_TRANSPORT_REQUEST_INVALID'); }
  if (request.credentials === 'include' || request.mode === 'navigate' || request.bodyUsed) {
    fail('OLIVEYOUNG_HTTP_TRANSPORT_REQUEST_INVALID');
  }
  let url;
  try { url = new URL(request.url); }
  catch { fail('OLIVEYOUNG_HTTP_TRANSPORT_TARGET_REJECTED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.port && url.port !== '443' || !allowedOrigins.has(url.origin)) {
    fail('OLIVEYOUNG_HTTP_TRANSPORT_TARGET_REJECTED');
  }
  const route = findRoute(url.origin, url.pathname);
  if (!route || !route.methods.includes(request.method)) fail('OLIVEYOUNG_HTTP_TRANSPORT_PATH_REJECTED');
  validateQuery(url, route);
  const headers = validateHeaders(request.headers, route);
  let body = Buffer.alloc(0);
  if (request.body?.getReader) {
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_REQUEST_BYTES) {
          await reader.cancel().catch(() => {});
          fail('OLIVEYOUNG_HTTP_TRANSPORT_BODY_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
      body = Buffer.concat(chunks, total);
    } catch (error) {
      if (error instanceof OliveyoungHttpTransportError) throw error;
      fail('OLIVEYOUNG_HTTP_TRANSPORT_REQUEST_INVALID');
    } finally {
      reader.releaseLock();
    }
  }
  validateBody(body, route, headers, request.method);
  return {
    request,
    route,
    payload: {
      protocolVersion: 1,
      url: url.href,
      method: request.method,
      headers,
      bodyBase64: body.toString('base64'),
      maxResponseBytes,
    },
  };
}

function runHelper(payload, { pythonPath, signal, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = Buffer.alloc(0);
    let outputBytes = 0;
    const stdoutLimit = Math.ceil(maxResponseBytes * 4 / 3) + 24 * 1024;
    const child = spawn(pythonPath, [HELPER_PATH], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' },
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const kill = error => {
      child.kill('SIGKILL');
      done(error);
    };
    const onAbort = () => kill(new OliveyoungHttpTransportError(
      signal.reason?.name === 'TimeoutError'
        ? 'OLIVEYOUNG_HTTP_TRANSPORT_TIMEOUT' : 'OLIVEYOUNG_HTTP_TRANSPORT_ABORTED'));
    const timer = setTimeout(() => kill(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_TIMEOUT')),
      timeoutMs + 3000);
    timer.unref?.();
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => done(new OliveyoungHttpTransportError(
      error?.code === 'ENOENT' ? 'OLIVEYOUNG_HTTP_TRANSPORT_PYTHON_UNAVAILABLE'
        : 'OLIVEYOUNG_HTTP_TRANSPORT_PROCESS_FAILED')));
    child.stdout.on('data', chunk => {
      outputBytes += chunk.byteLength;
      if (outputBytes > stdoutLimit) return kill(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_RESPONSE_TOO_LARGE'));
      output = Buffer.concat([output, chunk], outputBytes);
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return done(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_PROCESS_FAILED'));
      let reply;
      try { reply = JSON.parse(output.toString('utf8')); }
      catch { return done(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_PROTOCOL_INVALID')); }
      const expectedReplyKeys = ['bodyBase64', 'headers', 'ok', 'outgoingCookieAbsent', 'status', 'transport'];
      if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
          Object.keys(reply).sort().join(',') !== expectedReplyKeys.join(',')) {
        return done(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_PROTOCOL_INVALID'));
      }
      if (reply.ok !== true) {
        const codes = new Set(['DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_VERSION_MISMATCH', 'REQUEST_REJECTED',
          'TLS_FAILED', 'NETWORK_FAILED', 'RESPONSE_TOO_LARGE', 'PROTOCOL_INVALID', 'COOKIE_HEADER_PRESENT']);
        const codeName = codes.has(reply.error) ? reply.error : 'PROCESS_FAILED';
        return done(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_' + codeName));
      }
      if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 ||
          typeof reply.bodyBase64 !== 'string' || reply.outgoingCookieAbsent !== true ||
          !reply.transport || reply.transport.library !== 'curl_cffi' ||
          reply.transport.version !== '0.16.3' || reply.transport.profile !== 'chrome' ||
          !reply.headers || typeof reply.headers !== 'object' || Array.isArray(reply.headers) ||
          Object.keys(reply.headers).some(name => !ALLOWED_RESPONSE_HEADERS.has(name))) {
        return done(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_PROTOCOL_INVALID'));
      }
      let body;
      try { body = Buffer.from(reply.bodyBase64, 'base64'); }
      catch { return done(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_PROTOCOL_INVALID')); }
      if (body.byteLength > maxResponseBytes || body.toString('base64') !== reply.bodyBase64) {
        return done(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_RESPONSE_TOO_LARGE'));
      }
      return done(null, { status: reply.status, headers: reply.headers, body });
    });
    const payloadJson = JSON.stringify({ ...payload, timeoutMs });
    if (Buffer.byteLength(payloadJson) > Math.ceil(MAX_REQUEST_BYTES * 4 / 3) + 32 * 1024) {
      return kill(new OliveyoungHttpTransportError('OLIVEYOUNG_HTTP_TRANSPORT_REQUEST_TOO_LARGE'));
    }
    child.stdin.on('error', () => {});
    child.stdin.end(payloadJson);
  });
}

/**
 * Create a cookie-free, direct HTTP fetch adapter for captured public Olive Young reads.
 * The Python helper is pinned to curl_cffi 0.16.3; it never installs packages at runtime.
 */
export function createOliveyoungHttpFetch(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['pythonPath', 'timeoutMs', 'maxResponseBytes'].includes(key))) {
    fail('OLIVEYOUNG_HTTP_TRANSPORT_OPTIONS_INVALID');
  }
  const pythonPath = resolvePythonPath(options.pythonPath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    fail('OLIVEYOUNG_HTTP_TRANSPORT_OPTIONS_INVALID');
  }
  return async function oliveyoungHttpFetch(input, init = {}) {
    const { request, payload } = await normalizedRequest(input, init, maxResponseBytes);
    const reply = await runHelper(payload, {
      pythonPath, signal: request.signal, timeoutMs, maxResponseBytes,
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(reply.headers)) {
      if (ALLOWED_RESPONSE_HEADERS.has(name) && typeof value === 'string' &&
          value.length <= 256 && !CONTROL.test(value)) headers.set(name, value);
    }
    headers.set('content-length', String(reply.body.byteLength));
    const noBodyStatuses = new Set([204, 205, 304]);
    return new Response(noBodyStatuses.has(reply.status) ? null : reply.body,
      { status: reply.status, headers });
  };
}
