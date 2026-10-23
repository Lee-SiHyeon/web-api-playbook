import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { parentPort, workerData, MessageChannel, MessagePort } from 'node:worker_threads';

const nativeFetch = globalThis.fetch;
const GOOGLE_ORIGIN = 'https://www.google.com';
const GSTATIC_ORIGIN = 'https://www.gstatic.com';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const scopeUrl = new URL(workerData?.url || 'about:blank');
const runtimeUrl = new URL(workerData?.runtimeUrl || 'about:blank');
const eventTarget = new EventTarget();
const sources = new Map();
const pendingFetch = new Map();
const cookies = Array.isArray(workerData?.cookies) ? workerData.cookies : [];
let nextFetchId = 1;
let initialized = false;
let closed = false;
const queuedMessages = [];

function safeError(error) {
  const message = String(error?.message || '');
  const missing = /(?:reading ['"]([A-Za-z_$][A-Za-z0-9_$]{0,63})['"]|([A-Za-z_$][A-Za-z0-9_$]{0,63}) is not defined)/.exec(message);
  const category = /postMessage|structured.?clone|transfer/i.test(message) ? 'message_transfer'
    : /origin|source.*valid/i.test(message) ? 'message_origin'
      : /fetch|network|load failed/i.test(message) ? 'network'
        : /parse.*URL|invalid.*URL/i.test(message) ? 'relative_url'
          : /syntax|unexpected/i.test(message) ? 'syntax'
            : /unsupported|not implemented/i.test(message) ? 'missing_capability' : 'unclassified';
  return { name: error?.name === 'SyntaxError' ? 'SyntaxError' : 'Error', category,
    missingProperty: missing?.[1] || missing?.[2] || null,
    missingConstructor: /is not a constructor/.test(message),
    missingFunction: /is not a function/.test(message) };
}

function isScopedGoogleHost(hostname) {
  return hostname === 'google.com' || hostname.endsWith('.google.com');
}

function cookieHeader(url) {
  if (!isScopedGoogleHost(url.hostname)) return '';
  const now = Date.now() / 1000;
  return cookies.filter(cookie => {
    if (cookie?.domain !== '.google.com' || cookie.hostOnly !== false || typeof cookie.name !== 'string'
      || typeof cookie.value !== 'string' || cookie.secure !== true && cookie.secure !== false) return false;
    if (cookie.secure && url.protocol !== 'https:') return false;
    const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
    if (!url.pathname.startsWith(cookiePath) || (cookiePath !== '/' && !cookiePath.endsWith('/')
      && url.pathname.length > cookiePath.length && url.pathname[cookiePath.length] !== '/')) return false;
    const expires = Number(cookie.expires);
    return !Number.isFinite(expires) || expires <= 0 || expires > now;
  }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function allowedGet(url) {
  if (url.protocol !== 'https:') return false;
  if (url.origin === GOOGLE_ORIGIN) return url.pathname === '/recaptcha/enterprise/webworker.js';
  return url.origin === GSTATIC_ORIGIN && url.pathname === runtimeUrl.pathname
    && /^\/recaptcha\/releases\/[A-Za-z0-9_-]+\/recaptcha__(?:en|ko)\.js$/.test(url.pathname);
}

function sdkMimeMatches(url, mime) {
  if (url.pathname.endsWith('.css')) return mime === 'text/css';
  return /^(?:text|application)\/(?:javascript|ecmascript)$/.test(mime);
}

async function boundedResponseBytes(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
    try { await response.body?.cancel(); } catch {}
    throw new Error('FLOW_NODE_ISSUER_WORKER_SOURCE_TOO_LARGE');
  }
  const chunks = [];
  let size = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_SOURCE_BYTES) {
          try { await response.body.cancel(); } catch {}
          chunks.forEach(value => value.fill(0));
          throw new Error('FLOW_NODE_ISSUER_WORKER_SOURCE_TOO_LARGE');
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    chunks.forEach(value => value.fill(0));
    if (/^FLOW_NODE_ISSUER_WORKER_/.test(error?.message || '')) throw error;
    throw new Error('FLOW_NODE_ISSUER_WORKER_SOURCE_READ_FAILED');
  }
}

async function boundedRequestBytes(request) {
  const chunks = [];
  let size = 0;
  try {
    if (request.body) {
      for await (const chunk of request.body) {
        size += chunk.byteLength;
        if (size > MAX_REQUEST_BYTES) {
          try { await request.body.cancel(); } catch {}
          chunks.forEach(value => value.fill(0));
          throw new Error('FLOW_NODE_ISSUER_WORKER_REQUEST_TOO_LARGE');
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    chunks.forEach(value => value.fill(0));
    if (/^FLOW_NODE_ISSUER_WORKER_/.test(error?.message || '')) throw error;
    throw new Error('FLOW_NODE_ISSUER_WORKER_REQUEST_READ_FAILED');
  }
}

function publicGetEvidence(url, response, bytes) {
  parentPort.postMessage({ kind: 'diagnostic', event: 'public_source_get', host: url.hostname,
    path: url.pathname, status: response.status, mime: String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase(),
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}

async function loadPublicScript(input) {
  const url = new URL(input, scopeUrl);
  if (!allowedGet(url)) throw new Error('FLOW_NODE_ISSUER_WORKER_SOURCE_SCOPE');
  const headers = { accept: 'text/javascript, application/javascript' };
  const cookie = cookieHeader(url);
  if (cookie) headers.cookie = cookie;
  const response = await globalThis.fetch(url, {
    method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000),
  });
  const mime = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (response.status !== 200 || !/^(?:text|application)\/(?:javascript|ecmascript)$/.test(mime)) {
    try { await response.body?.cancel(); } catch {}
    throw new Error('FLOW_NODE_ISSUER_WORKER_SOURCE_HTTP');
  }
  const bytes = await boundedResponseBytes(response);
  publicGetEvidence(url, response, bytes);
  const source = bytes.toString('utf8');
  sources.set(url.href, source);
  bytes.fill(0);
  return source;
}

function absolute(input) { return new URL(String(input), scopeUrl).href; }

function dispatch(packet) {
  const event = new MessageEvent('message', { data: packet.data, ports: packet.ports || [] });
  try { globalThis.onmessage?.(event); eventTarget.dispatchEvent(event); }
  catch (error) { parentPort.postMessage({ kind: 'diagnostic', event: 'sdk_runtime_error', error: safeError(error) }); }
}

function handleParentMessage(packet) {
  if (packet?.kind === 'close') {
    closed = true;
    for (const cookie of cookies) cookie.value = '';
    sources.clear();
    for (const [requestId, finish] of pendingFetch) finish(new Response('', { status: 400 }));
    pendingFetch.clear();
    parentPort.close();
    return;
  }
  if (packet?.kind === 'fetch_response' && Number.isSafeInteger(packet.requestId)) {
    const finish = pendingFetch.get(packet.requestId);
    if (!finish) return;
    pendingFetch.delete(packet.requestId);
    const status = Number.isInteger(packet.status) ? packet.status : 400;
    const responseBody = [204, 205, 304].includes(status) ? null : packet.body || new Uint8Array();
    finish(new Response(responseBody, {
      status,
      headers: { 'content-type': typeof packet.contentType === 'string' ? packet.contentType : 'text/plain' },
    }));
    return;
  }
  if (packet?.kind !== 'message') return;
  if (initialized) dispatch(packet);
  else queuedMessages.push(packet);
}

parentPort.on('message', handleParentMessage);
globalThis.self = globalThis;
globalThis.location = scopeUrl;
globalThis.MessageChannel = MessageChannel;
globalThis.MessagePort = MessagePort;
globalThis.console = Object.freeze({ debug() {}, info() {}, log() {}, warn() {}, error() {}, trace() {}, time() {}, timeEnd() {} });
globalThis.addEventListener = (...args) => eventTarget.addEventListener(...args);
globalThis.removeEventListener = (...args) => eventTarget.removeEventListener(...args);
globalThis.dispatchEvent = (...args) => eventTarget.dispatchEvent(...args);
globalThis.postMessage = (data, transfer = []) => parentPort.postMessage({ kind: 'message', data,
  ports: transfer.filter(value => value instanceof MessagePort) }, transfer);
globalThis.close = () => {
  closed = true;
  for (const cookie of cookies) cookie.value = '';
  sources.clear();
  parentPort.close();
};
globalThis.importScripts = (...urls) => {
  for (const input of urls) {
    const source = sources.get(absolute(input));
    if (typeof source !== 'string') throw new Error('FLOW_NODE_ISSUER_WORKER_IMPORT_UNOBSERVED');
    vm.runInThisContext(source, { filename: absolute(input) });
  }
};
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), scopeUrl), init);
  const url = new URL(request.url);
  if (request.method === 'GET' && allowedGet(url)) {
    const headers = new Headers(request.headers);
    if (request.credentials === 'include' || (request.credentials === 'same-origin' && url.origin === scopeUrl.origin)) {
      const cookie = cookieHeader(url);
      if (cookie) headers.set('cookie', cookie);
    }
    const response = await nativeFetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch {}
      return new Response(null, { status: response.status });
    }
    const mime = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!sdkMimeMatches(url, mime)) {
      try { await response.body?.cancel(); } catch {}
      return new Response('', { status: 400 });
    }
    const bytes = await boundedResponseBytes(response);
    const body = Uint8Array.from(bytes);
    bytes.fill(0);
    return new Response(body, { status: 200, headers: { 'content-type': mime } });
  }
  let body;
  try { body = await boundedRequestBytes(request); }
  catch {
    parentPort.postMessage({ kind: 'diagnostic', event: 'network_blocked' });
    return new Response('', { status: 400 });
  }
  const requestId = nextFetchId++;
  const contentType = request.headers.get('content-type') || '';
  const transfer = new Uint8Array(body);
  body.fill(0);
  const responsePromise = new Promise(resolve => pendingFetch.set(requestId, resolve));
  parentPort.postMessage({ kind: 'fetch_request', requestId, url: url.href, method: request.method,
    contentType, accept: request.headers.get('accept') || '*/*', credentials: request.credentials, body: transfer }, [transfer.buffer]);
  return responsePromise;
};
try {
  if (!parentPort || scopeUrl.origin !== GOOGLE_ORIGIN || scopeUrl.pathname !== '/recaptcha/enterprise/webworker.js'
    || runtimeUrl.origin !== GSTATIC_ORIGIN
    || !/^\/recaptcha\/releases\/[A-Za-z0-9_-]+\/recaptcha__(?:en|ko)\.js$/.test(runtimeUrl.pathname)) {
    throw new Error('FLOW_NODE_ISSUER_WORKER_SCOPE');
  }
  const workerSource = await loadPublicScript(scopeUrl.href);
  const imports = [...workerSource.matchAll(/https:\/\/www\.gstatic\.com\/recaptcha\/releases\/[^'"\s<>]+\/recaptcha__(?:en|ko)\.js/g)]
    .map(match => match[0]);
  if (!imports.some(input => new URL(input).href === runtimeUrl.href)) throw new Error('FLOW_NODE_ISSUER_WORKER_RUNTIME_UNOBSERVED');
  for (const input of new Set(imports)) {
    if (new URL(input).href !== runtimeUrl.href) throw new Error('FLOW_NODE_ISSUER_WORKER_RUNTIME_SCOPE');
    await loadPublicScript(input);
  }
  vm.runInThisContext(workerSource, { filename: scopeUrl.origin + scopeUrl.pathname });
  initialized = true;
  parentPort.postMessage({ kind: 'diagnostic', event: 'worker_initialized', nativeNodeIdentity: true, sourceModified: false });
  queuedMessages.splice(0).forEach(dispatch);
} catch (error) {
  parentPort.postMessage({ kind: 'diagnostic', event: 'initialization_error', error: safeError(error) });
  parentPort.close();
}
