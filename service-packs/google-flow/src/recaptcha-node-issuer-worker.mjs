import { createHash } from 'node:crypto';
import { parentPort, workerData, MessageChannel, MessagePort, Worker as NodeWorker } from 'node:worker_threads';
import { TextEncoder, TextDecoder } from 'node:util';
import { Writable } from 'node:stream';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import { CookieJar, JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { parse as parseHtml } from 'parse5';
import { readIssuerRequest } from './recaptcha-http-guard.mjs';

const GOOGLE_ORIGIN = 'https://www.google.com';
const GSTATIC_ORIGIN = 'https://www.gstatic.com';
const WORKER_MODULE_STARTED_AT = Date.now();
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_ANCHOR_BYTES = 512 * 1024;
const MAX_PROTO_BYTES = 128 * 1024;
const MAX_REPLY_BYTES = 256 * 1024;
const MAX_EXECUTE_MS = 45_000;
const SAFE_NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'ABORT_ERR']);
const reloadReceipt = { postCount: 0, requestBytes: 0, responseBytes: 0, decodedResponseBytes: 0,
  responseSchemaValid: false, sdkVersionMatchesAnchor: false, anchorTokenMatchesRequest: false,
  actionMatches: false, siteKeyMatches: false, outcomeUncertain: false };
const clearReceipt = { postCount: 0, status: null, responseBytes: 0 };
let anchor = null;
let reloadToken = null;
let reloadIssuedAt = null;
let reloadVerified = false;
let reloadResolver;
const reloadResponse = new Promise(resolve => { reloadResolver = resolve; });
const trackedWorkers = [];
const trackedChannels = [];
const timerHandles = [];
let activeDom = null;
let activeJar = null;
let originalHttpRequest;
let originalHttpsRequest;
let networkBlockedCount = 0;
let sdkExecuteStarted = false;
let sdkExecuteReturned = false;
let executeTokenLength = 0;
let tokenMatchesReload = false;
let sourceRuntime = null;
let anchorToken = null;
let sourceLoader = null;
let siteKey = null;
let closed = false;
const sdkWindows = new Set();

const receipt = {
  mode: 'node_jsdom_unmodified_sdk',
  nodeVersion: process.version,
  jsdomVersion: '26.1.0',
  siteKeyFromCurrentFlowDocument: true,
  cookieValuesRecorded: false,
  tokenValuesRecorded: false,
  browserEngineUsed: false,
  browserSignalsOverridden: false,
  sdkSourceModified: false,
  loader: {}, runtime: {}, anchor: {}, worker: {}, execute: {}, reload: reloadReceipt, clear: clearReceipt,
  blockedRequests: [],
};

function reportStage(stage) {
  if (!/^[a-z][a-z0-9_]{0,48}$/.test(stage)) return;
  receipt.stage = stage;
  receipt.elapsedMs = Math.max(0, Math.min(120_000, Date.now() - WORKER_MODULE_STARTED_AT));
  parentPort?.postMessage({ kind: 'receipt', receipt });
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeNetworkCode(value) {
  return typeof value === 'string' && (SAFE_NETWORK_CODES.has(value)
    || /^FLOW_NODE_ISSUER_[A-Z0-9_]{1,80}$/.test(value)) ? value : null;
}

function mimeOf(headers) {
  return String(headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
}

async function cancelBody(response) {
  try { await response?.body?.cancel(); } catch { /* No response bytes are retained on failure. */ }
}

async function boundedBytes(response, limit, code) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await cancelBody(response);
    throw codedError(code);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) {
        await cancelBody(response);
        chunks.forEach(value => value.fill(0));
        throw codedError(code);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    chunks.forEach(value => value.fill(0));
    if (error?.code === code) throw error;
    throw codedError(code);
  }
  return Buffer.concat(chunks, size);
}

function addResponseCookies(response, url, jar) {
  for (const line of response.headers.getSetCookie?.() || []) {
    try { jar.setCookieSync(line, url.href); } catch { /* Cookie values remain only in the scoped in-memory jar. */ }
  }
}

function buildCookieJar(cookies) {
  const jar = new CookieJar();
  for (const cookie of cookies) {
    const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`, 'Domain=google.com'];
    if (cookie.secure) parts.push('Secure');
    if (cookie.httpOnly) parts.push('HttpOnly');
    if (typeof cookie.sameSite === 'string') {
      const sameSite = cookie.sameSite.toLowerCase();
      if (['lax', 'strict', 'none'].includes(sameSite)) parts.push(`SameSite=${sameSite}`);
    }
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
      parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
    }
    try { jar.setCookieSync(parts.join('; '), `https://google.com${cookie.path}`); } catch { /* Skip a jar-incompatible saved cookie. */ }
  }
  return jar;
}

function urlWithinSdkAllowlist(url, { runtimePath, releaseId }) {
  if (url.protocol !== 'https:') return false;
  if (url.origin === GOOGLE_ORIGIN) {
    return ['/recaptcha/enterprise/anchor', '/recaptcha/enterprise/webworker.js'].includes(url.pathname);
  }
  if (url.origin !== GSTATIC_ORIGIN) return false;
  return url.pathname === runtimePath
    || url.pathname === `/recaptcha/releases/${releaseId}/styles__ltr.css`
    || url.pathname === `/recaptcha/releases/${releaseId}/styles__rtl.css`;
}

function readVarint(bytes, state) {
  let value = 0n;
  let shift = 0n;
  for (let count = 0; count < 10 && state.offset < bytes.length; count += 1) {
    const byte = bytes[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value };
    shift += 7n;
  }
  throw codedError('FLOW_NODE_ISSUER_PROTO_INVALID');
}

function protobufField(bytes, wanted) {
  const state = { offset: 0 };
  while (state.offset < bytes.length) {
    const tag = readVarint(bytes, state).value;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (field < 1) throw codedError('FLOW_NODE_ISSUER_PROTO_INVALID');
    if (wireType === 2) {
      const length = Number(readVarint(bytes, state).value);
      if (!Number.isSafeInteger(length) || length < 0 || state.offset + length > bytes.length) {
        throw codedError('FLOW_NODE_ISSUER_PROTO_INVALID');
      }
      const value = bytes.subarray(state.offset, state.offset + length);
      state.offset += length;
      if (field === wanted) return value;
    } else if (wireType === 0) readVarint(bytes, state);
    else if (wireType === 1) state.offset += 8;
    else if (wireType === 5) state.offset += 4;
    else throw codedError('FLOW_NODE_ISSUER_PROTO_INVALID');
    if (state.offset > bytes.length) throw codedError('FLOW_NODE_ISSUER_PROTO_INVALID');
  }
  return null;
}

function requestContractMatches(body) {
  if (!anchor || !anchor.version || !anchor.token || !siteKey) return false;
  try {
    const copyField = field => {
      const bytes = protobufField(body, field);
      return bytes ? Buffer.from(bytes) : null;
    };
    const version = copyField(1);
    const token = copyField(2);
    const action = copyField(8);
    const key = copyField(14);
    const matches = {
      sdkVersionMatchesAnchor: Boolean(version && version.toString('utf8') === anchor.version),
      anchorTokenMatchesRequest: Boolean(token && token.toString('utf8') === anchor.token),
      actionMatches: Boolean(action && action.toString('utf8') === 'VIDEO_GENERATION'),
      siteKeyMatches: Boolean(key && key.toString('utf8') === siteKey),
    };
    Object.assign(reloadReceipt, matches);
    for (const value of [version, token, action, key]) {
      value?.fill(0);
    }
    return Object.values(matches).every(Boolean);
  } catch {
    return false;
  }
}

function parseReloadResponse(wireBytes, encoding) {
  let decoded = wireBytes;
  try {
    const normalized = String(encoding || 'identity').trim().toLowerCase();
    if (normalized === 'gzip') decoded = gunzipSync(wireBytes, { maxOutputLength: MAX_REPLY_BYTES });
    else if (normalized === 'deflate') decoded = inflateSync(wireBytes, { maxOutputLength: MAX_REPLY_BYTES });
    else if (normalized === 'br') decoded = brotliDecompressSync(wireBytes, { maxOutputLength: MAX_REPLY_BYTES });
    else if (normalized !== 'identity') throw codedError('FLOW_NODE_ISSUER_ENCODING_UNSUPPORTED');
    if (decoded.length > MAX_REPLY_BYTES) throw codedError('FLOW_NODE_ISSUER_REPLY_TOO_LARGE');
    const source = decoded.toString('utf8');
    const start = source.indexOf('[');
    if (start < 0) throw codedError('FLOW_NODE_ISSUER_REPLY_INVALID');
    const data = JSON.parse(source.slice(start));
    if (!Array.isArray(data) || data[0] !== 'rresp' || typeof data[1] !== 'string'
      || !data[1] || data[1].length > 8_192 || /[\r\n\0]/.test(data[1])) {
      throw codedError('FLOW_NODE_ISSUER_REPLY_INVALID');
    }
    return { token: data[1], arrayLength: data.length, decodedBytes: decoded.length };
  } catch (error) {
    if (/^FLOW_NODE_ISSUER_/.test(error?.code || '')) throw error;
    throw codedError('FLOW_NODE_ISSUER_REPLY_INVALID');
  } finally {
    if (decoded !== wireBytes) decoded.fill(0);
  }
}

function makeBlockedRequest() {
  const stream = new Writable({
    highWaterMark: 16 * 1024,
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) { callback(codedError('FLOW_NODE_ISSUER_NETWORK_BLOCKED')); },
  });
  stream.on('error', () => {});
  stream.setHeader = () => stream;
  stream.getHeader = () => undefined;
  stream.removeHeader = () => {};
  stream.abort = () => stream.destroy();
  return stream;
}

function recordBlockedRequest(descriptor) {
  networkBlockedCount += 1;
  if (receipt.blockedRequests.length >= 12) return;
  const safeHost = ['www.google.com', 'www.gstatic.com'].includes(descriptor?.hostname) ? descriptor.hostname : 'other';
  const path = typeof descriptor?.pathname === 'string' && /^\/recaptcha\/[A-Za-z0-9_./-]{0,160}$/.test(descriptor.pathname)
    ? descriptor.pathname : '/other';
  const method = typeof descriptor?.method === 'string' && /^[A-Z]{3,10}$/.test(descriptor.method)
    ? descriptor.method : 'OTHER';
  const pathAllowed = Boolean(descriptor && (
    descriptor.hostname === 'www.google.com' && ['/recaptcha/enterprise/anchor', '/recaptcha/enterprise/webworker.js', '/recaptcha/enterprise/reload'].includes(descriptor.pathname)
    || descriptor.hostname === 'www.gstatic.com' && /^\/recaptcha\/releases\/[A-Za-z0-9_-]+\/(?:recaptcha__(?:en|ko)\.js|styles__(?:ltr|rtl)\.css)$/.test(descriptor.pathname)
  ));
  const reason = !descriptor ? 'unparsed'
    : descriptor.hasCustomAgent ? 'nonstandard_agent'
      : descriptor.hasCustomSocketPath ? 'custom_socket_path'
        : descriptor.hasCustomConnection ? 'custom_connection'
          : descriptor.hasCustomLookup ? 'custom_lookup'
            : descriptor.hasCustomNetworkBinding ? 'custom_network_binding'
              : descriptor.hasCustomTlsIdentity ? 'custom_tls_identity'
                : descriptor.hasUnexpectedServername ? 'unexpected_servername'
                  : descriptor.hasAuth ? 'has_auth'
                    : descriptor.port ? 'non_default_port'
                      : descriptor.protocol !== 'https:' ? 'non_https'
                        : !pathAllowed ? 'path_not_allowlisted'
                          : descriptor.method !== 'GET' && !(descriptor.hostname === 'www.google.com'
                            && descriptor.pathname === '/recaptcha/enterprise/reload' && descriptor.method === 'POST')
                            ? 'method_not_allowed' : 'other';
  receipt.blockedRequests.push({
    host: safeHost, path, method, reason, agent: descriptor?.agentSummary,
    reasons: {
      unparsed: !descriptor,
      nonHttps: descriptor?.protocol !== 'https:',
      nonDefaultPort: Boolean(descriptor?.port),
      hasAuth: descriptor?.hasAuth === true,
      pathNotAllowlisted: !pathAllowed,
      methodNotAllowed: descriptor?.method !== 'GET' && !(descriptor?.hostname === 'www.google.com'
        && descriptor.pathname === '/recaptcha/enterprise/reload' && descriptor.method === 'POST'),
      nonstandardAgent: descriptor?.hasCustomAgent === true,
      customConnection: descriptor?.hasCustomConnection === true,
      customSocketPath: descriptor?.hasCustomSocketPath === true,
      customLookup: descriptor?.hasCustomLookup === true,
      customNetworkBinding: descriptor?.hasCustomNetworkBinding === true,
      customTlsIdentity: descriptor?.hasCustomTlsIdentity === true,
      unexpectedServername: descriptor?.hasUnexpectedServername === true,
    },
  });
  reportStage('request_blocked');
}

function requestBytes(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return null;
  if (Buffer.isBuffer(chunk)) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  return Buffer.from(chunk);
}

function installHttpGuard({ runtimePath, releaseId }) {
  originalHttpRequest = http.request;
  originalHttpsRequest = https.request;
  const wrap = (original, fallbackProtocol) => function guardedRequest(...args) {
    const descriptor = readIssuerRequest(args[0], `${fallbackProtocol}:`, typeof args[1] === 'object' ? args[1] : {});
    if (!descriptor) { recordBlockedRequest(null); return makeBlockedRequest(); }
    const allowedGet = descriptor.protocol === 'https:' && descriptor.port === '' && !descriptor.hasAuth
      && !descriptor.hasCustomTransport && descriptor.method === 'GET'
      && urlWithinSdkAllowlist(new URL(`${descriptor.protocol}//${descriptor.hostname}${descriptor.pathname}`), { runtimePath, releaseId });
    const reloadRequest = descriptor.protocol === 'https:' && descriptor.port === '' && !descriptor.hasAuth
      && !descriptor.hasCustomTransport && descriptor.hostname === 'www.google.com'
      && descriptor.pathname === '/recaptcha/enterprise/reload' && descriptor.method === 'POST'
      && descriptor.contentType === 'application/x-protobuffer' && reloadReceipt.postCount === 0;
    if (!allowedGet && !reloadRequest) { recordBlockedRequest(descriptor); return makeBlockedRequest(); }
    const request = original.apply(this, args);
    if (reloadRequest) {
      reloadReceipt.postCount = 1;
      let bodyBytes = 0;
      let bodyOverflow = false;
      const bodyChunks = [];
      const originalEnd = request.end.bind(request);
      const capture = (chunk, encoding) => {
        const bytes = requestBytes(chunk, encoding);
        if (!bytes) return;
        bodyBytes += bytes.length;
        if (!bodyOverflow && bodyBytes <= MAX_PROTO_BYTES) bodyChunks.push(bytes);
        else { bodyOverflow = true; bytes.fill(0); }
      };
      request.write = (chunk, ...rest) => {
        const encoding = typeof rest[0] === 'string' ? rest[0] : undefined;
        capture(chunk, encoding);
        const callback = rest.find(value => typeof value === 'function');
        if (bodyOverflow) {
          const error = codedError('FLOW_NODE_ISSUER_REQUEST_TOO_LARGE');
          if (callback) queueMicrotask(() => callback(error));
          bodyChunks.forEach(value => value.fill(0));
          bodyChunks.length = 0;
          request.destroy(error);
          return false;
        }
        // This acknowledges the bounded local copy. JSDOM waits for this callback
        // before ending a multi-chunk body; no HTTP body is sent until end validates it.
        if (callback) queueMicrotask(() => callback());
        return true;
      };
      request.flushHeaders = () => request;
      request.end = (chunk, ...rest) => {
        const encoding = typeof rest[0] === 'string' ? rest[0] : undefined;
        capture(chunk, encoding);
        reloadReceipt.requestBytes = bodyBytes;
        const endCallback = rest.find(value => typeof value === 'function');
        const completeBufferedCallbacks = error => {
          try { endCallback?.(error); } catch { /* The SDK owns its callback behavior. */ }
        };
        if (bodyOverflow) {
          bodyChunks.forEach(value => value.fill(0));
          bodyChunks.length = 0;
          const error = codedError('FLOW_NODE_ISSUER_REQUEST_TOO_LARGE');
          completeBufferedCallbacks(error);
          request.destroy(error);
          return request;
        }
        const body = Buffer.concat(bodyChunks, bodyBytes);
        const matched = requestContractMatches(body);
        bodyChunks.forEach(value => value.fill(0));
        bodyChunks.length = 0;
        if (!matched) {
          body.fill(0);
          const error = codedError('FLOW_NODE_ISSUER_REQUEST_CONTRACT_INVALID');
          completeBufferedCallbacks(error);
          request.destroy(error);
          reloadReceipt.outcomeUncertain = false;
          reloadResolver({ valid: false, token: null, issuedAt: null });
          return request;
        }
        request.once('error', () => body.fill(0));
        return originalEnd(body, error => {
          body.fill(0);
          completeBufferedCallbacks(error);
        });
      };
      request.on('finish', () => { reloadReceipt.sendFinishedAt = new Date().toISOString(); });
      request.on('error', () => {
        reloadReceipt.outcomeUncertain = request.socket?.bytesWritten > 0;
        reloadResolver({ valid: false, token: null, issuedAt: null });
      });
      request.on('response', response => {
        reloadReceipt.status = response.statusCode;
        reloadReceipt.mime = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        const encoding = response.headers['content-encoding'] || 'identity';
        let responseBytes = 0;
        let oversize = false;
        const chunks = [];
        response.on('data', chunk => {
          responseBytes += chunk.length;
          if (!oversize && responseBytes <= MAX_REPLY_BYTES) chunks.push(Buffer.from(chunk));
          else { oversize = true; }
        });
        response.on('end', () => {
          reloadReceipt.responseBytes = responseBytes;
          reloadReceipt.responseEndedAt = new Date().toISOString();
          if (response.statusCode !== 200 || reloadReceipt.mime !== 'application/json' || oversize) {
            chunks.forEach(value => value.fill(0));
            reloadResolver({ valid: false, token: null, issuedAt: null });
            return;
          }
          const wire = Buffer.concat(chunks, responseBytes);
          try {
            const parsed = parseReloadResponse(wire, encoding);
            reloadReceipt.decodedResponseBytes = parsed.decodedBytes;
            reloadReceipt.responseSchemaValid = true;
            reloadToken = parsed.token;
            reloadIssuedAt = Date.now();
            reloadVerified = true;
            reloadResolver({ valid: true, token: reloadToken, issuedAt: reloadIssuedAt });
          } catch {
            reloadReceipt.responseSchemaValid = false;
            reloadResolver({ valid: false, token: null, issuedAt: null });
          } finally {
            wire.fill(0);
            chunks.forEach(value => value.fill(0));
          }
        });
      });
    }
    return request;
  };
  http.request = wrap(originalHttpRequest, 'http');
  https.request = wrap(originalHttpsRequest, 'https');
}

function findInputToken(htmlBuffer) {
  const tree = parseHtml(htmlBuffer.toString('utf8'));
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (node?.tagName === 'input') {
      const attrs = Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]));
      if (attrs.id === 'recaptcha-token' && typeof attrs.value === 'string' && attrs.value.length <= 8_192) {
        return attrs.value || null;
      }
    }
    if (Array.isArray(node?.childNodes)) pending.push(...node.childNodes);
  }
  return null;
}

function anchorReceiptFrom(url, response, bytes) {
  const key = url.searchParams.get('k');
  const version = url.searchParams.get('v');
  anchorToken = findInputToken(bytes);
  anchor = { key, version, token: anchorToken };
  receipt.anchor = {
    host: url.hostname, path: url.pathname, method: 'GET', status: response.status,
    mime: mimeOf(response.headers), bytes: bytes.length,
    queryKeyCount: [...url.searchParams.keys()].length,
    configuredKeyMatches: key === siteKey,
    hiddenTokenPresent: Boolean(anchorToken),
  };
  if (!anchorToken || !version || key !== siteKey || response.status !== 200 || mimeOf(response.headers) !== 'text/html') {
    throw codedError('FLOW_NODE_ISSUER_ANCHOR_INVALID');
  }
}

function mappedResource(promise, mapper) {
  const mapped = promise.then(mapper);
  mapped.abort = () => promise.abort?.();
  mapped.getHeader = (...args) => promise.getHeader?.(...args);
  for (const key of ['response', 'href']) Object.defineProperty(mapped, key, { get: () => promise[key] });
  return mapped;
}

function responseMime(headers) {
  const value = headers['content-type'];
  return String(Array.isArray(value) ? value[0] : value || '').split(';', 1)[0].trim().toLowerCase();
}

function sdkMimeMatches(url, mime) {
  if (url.pathname === '/recaptcha/enterprise/anchor') return mime === 'text/html';
  if (url.pathname.endsWith('.css')) return mime === 'text/css';
  return /^(?:text|application)\/(?:javascript|ecmascript)$/.test(mime);
}

function addIncomingCookies(headers, url, jar) {
  const values = headers['set-cookie'];
  for (const line of Array.isArray(values) ? values : values ? [values] : []) {
    try { jar.setCookieSync(line, url.href); } catch { /* Cookie values stay scoped to the in-memory jar. */ }
  }
}

function boundedResourceGet(url, options, limit) {
  const headers = {
    accept: url.pathname.endsWith('.css') ? 'text/css,*/*;q=0.1' : 'text/javascript, application/javascript, */*;q=0.1',
    'user-agent': `Node.js/${process.versions.node} jsdom/26.1.0`,
  };
  const cookie = activeJar?.getCookieStringSync(url.href);
  if (cookie) headers.cookie = cookie;
  const referrer = options?.element?.ownerDocument?.URL;
  try {
    if (typeof referrer === 'string' && new URL(referrer).origin === 'https://flow.google.com') headers.referer = referrer;
  } catch { /* Ignore an invalid document referrer; the request remains origin-allowlisted. */ }

  let request;
  const promise = new Promise((resolve, reject) => {
    request = https.request(url, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) }, response => {
      const mime = responseMime(response.headers);
      const responseHeaders = Object.create(null);
      for (const name of ['content-type', 'content-encoding', 'content-length']) {
        const value = response.headers[name];
        if (value !== undefined) responseHeaders[name] = value;
      }
      responseHeaders.get = name => responseHeaders[String(name).toLowerCase()] ?? null;
      const metadata = { status: response.statusCode, statusCode: response.statusCode, headers: responseHeaders };
      promise.response = metadata;
      addIncomingCookies(response.headers, url, activeJar);
      if (response.statusCode !== 200) {
        response.destroy();
        reject(codedError('FLOW_NODE_ISSUER_RESOURCE_HTTP_FAILED'));
        return;
      }
      if (!sdkMimeMatches(url, mime)) {
        response.destroy();
        reject(codedError('FLOW_NODE_ISSUER_RESOURCE_MIME_FAILED'));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        response.destroy();
        request.destroy(codedError('FLOW_NODE_ISSUER_RESOURCE_TOO_LARGE'));
        reject(codedError('FLOW_NODE_ISSUER_RESOURCE_TOO_LARGE'));
        return;
      }
      const chunks = [];
      let size = 0;
      let finished = false;
      const failStream = code => {
        if (finished) return;
        finished = true;
        chunks.forEach(value => value.fill(0));
        chunks.length = 0;
        reject(codedError(code));
      };
      response.on('data', chunk => {
        size += chunk.byteLength;
        if (size > limit) {
          failStream('FLOW_NODE_ISSUER_RESOURCE_TOO_LARGE');
          response.destroy();
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (finished) return;
        finished = true;
        const bytes = Buffer.concat(chunks, size);
        chunks.forEach(value => value.fill(0));
        resolve(bytes);
      });
      response.on('error', error => {
        receipt.runtimeError ||= safeJsdomError(error);
        reportStage('resource_response_error');
        failStream('FLOW_NODE_ISSUER_RESOURCE_READ_FAILED');
      });
    });
    request.on('error', error => {
      receipt.runtimeError ||= safeJsdomError(error);
      reportStage('resource_get_error');
      reject(codedError('FLOW_NODE_ISSUER_RESOURCE_GET_FAILED'));
    });
    request.end();
  });
  promise.href = url.href;
  promise.abort = () => request?.destroy();
  return promise;
}

function safeJsdomError(error) {
  const message = String(error?.message || '');
  const missing = /(?:reading ['"]([A-Za-z_$][A-Za-z0-9_$]{0,63})['"]|([A-Za-z_$][A-Za-z0-9_$]{0,63}) is not defined)/.exec(message);
  const category = /postMessage|structured.?clone|transfer/i.test(message) ? 'message_transfer'
    : /origin|source.*valid/i.test(message) ? 'message_origin'
      : /fetch|network|load failed/i.test(message) ? 'network'
        : /parse.*URL|invalid.*URL/i.test(message) ? 'relative_url'
          : /syntax|unexpected/i.test(message) ? 'syntax'
            : /unsupported|not implemented/i.test(message) ? 'missing_capability' : 'unclassified';
  const source = /https:\/\/([^\s:/()?#]+)(\/[^\s:?#()]*)?:(\d+)(?::\d+)?/.exec(String(error?.stack || ''));
  const sourceHost = source?.[1]?.toLowerCase();
  const sourceAllowed = sourceHost === 'www.google.com' || sourceHost === 'www.gstatic.com';
  const errorCode = safeNetworkCode(error?.code) || safeNetworkCode(message);
  const frames = String(error?.stack || '').split(/\r?\n/).slice(1, 6).map(line => {
    const functionIdentifier = /\bat\s+(?:async\s+)?([A-Za-z0-9_.$<>-]{1,120})(?:\s|\()/.exec(line)?.[1] || null;
    const moduleBasename = /(?:^|[\\/])([A-Za-z0-9_.-]+\.(?:js|mjs|cjs)):\d+:\d+/.exec(line)?.[1] || null;
    return { functionIdentifier, moduleBasename };
  });
  return {
    name: error?.name === 'SyntaxError' ? 'SyntaxError' : 'Error', category,
    missingProperty: missing?.[1] || missing?.[2] || null,
    missingConstructor: /is not a constructor/.test(message),
    missingFunction: /is not a function/.test(message),
    ...(errorCode ? { errorCode } : {}),
    frames,
    ...(sourceAllowed ? { sourceHost, sourcePath: source[2] || '/', sourceLine: Number(source[3]) } : {}),
  };
}

// Observe fatal worker errors without changing Node's default termination behavior.
process.on('uncaughtExceptionMonitor', error => {
  receipt.runtimeError ||= safeJsdomError(error);
  const code = safeNetworkCode(error?.code) || safeNetworkCode(error?.message);
  if (code?.startsWith('FLOW_NODE_ISSUER_')) receipt.failureCode = code;
  reportStage('uncaught_exception');
});

function callerRealm(values, windows) {
  for (const value of values) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
    const prototype = Object.getPrototypeOf(value);
    for (const window of windows) {
      if (prototype === window.Object.prototype || prototype === window.Array.prototype
        || prototype === window.Function.prototype) return window;
    }
  }
  return null;
}

function bindWindow(window, workerUrl, runtimeUrl, runtimeOptions) {
  if (sdkWindows.has(window)) return;
  sdkWindows.add(window);
  const windows = sdkWindows;
  const userAgent = `Node.js/${process.versions.node} jsdom/26.1.0`;
  for (const [name, value] of Object.entries({ TextEncoder, TextDecoder, MessageChannel, MessagePort,
    Request: globalThis.Request, Response: globalThis.Response, Headers: globalThis.Headers,
    AbortController: globalThis.AbortController, AbortSignal: globalThis.AbortSignal })) {
    if (typeof window[name] === 'function' || typeof value !== 'function') continue;
    window[name] = value;
  }
  window.console = Object.freeze({ debug() {}, info() {}, log() {}, warn() {}, error() {}, trace() {}, time() {}, timeEnd() {} });
  if (window.Request === globalThis.Request) {
    window.Request = class extends Request {
      constructor(input, init) {
        const relative = typeof input === 'string' || input instanceof URL;
        super(relative ? new URL(String(input), window.location.href) : input, init);
      }
    };
  }
  window.fetch = async (input, init) => {
    let request;
    try { request = new window.Request(input, init); } catch { networkBlockedCount += 1; return new Response('', { status: 400 }); }
    const url = new URL(request.url);
    if (request.method !== 'GET' || !urlWithinSdkAllowlist(url, runtimeOptions)) {
      networkBlockedCount += 1;
      return new Response('', { status: 400 });
    }
    const headers = new Headers(request.headers);
    if (request.credentials === 'include' || (request.credentials === 'same-origin' && url.origin === window.location.origin)) {
      const cookie = activeJar.getCookieStringSync(url.href);
      if (cookie) headers.set('cookie', cookie);
    }
    const response = await globalThis.fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    addResponseCookies(response, url, activeJar);
    if (response.status !== 200) {
      await cancelBody(response);
      return new Response(null, { status: response.status });
    }
    if (!sdkMimeMatches(url, mimeOf(response.headers))) {
      await cancelBody(response);
      networkBlockedCount += 1;
      return new Response('', { status: 400 });
    }
    const limit = url.pathname === '/recaptcha/enterprise/anchor' ? MAX_ANCHOR_BYTES : MAX_SCRIPT_BYTES;
    const bytes = await boundedBytes(response, limit, 'FLOW_NODE_ISSUER_FETCH_RESOURCE_TOO_LARGE');
    const body = Uint8Array.from(bytes);
    const mime = mimeOf(response.headers);
    bytes.fill(0);
    return new Response(body, { status: 200, headers: { 'content-type': mime } });
  };

  const childWorkers = new Set();
  window.Worker = class extends window.EventTarget {
    constructor(url) {
      super();
      const parsed = new URL(String(url), window.location.href);
      if (parsed.origin !== GOOGLE_ORIGIN || parsed.pathname !== '/recaptcha/enterprise/webworker.js') {
        throw codedError('FLOW_NODE_ISSUER_WORKER_SCOPE');
      }
      receipt.worker = { constructed: true, host: parsed.hostname, path: parsed.pathname, sourceModified: false };
      const child = new NodeWorker(new URL('./recaptcha-node-classic-worker.mjs', import.meta.url), {
        workerData: { url: parsed.href, runtimeUrl: runtimeUrl.href, cookies: workerData.cookies },
        resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 8 },
      });
      this.nodeWorker = child;
      childWorkers.add(child);
      trackedWorkers.push(child);
      child.on('message', packet => {
        if (packet?.kind === 'diagnostic') {
          if (packet.event === 'worker_initialized') {
            receipt.worker.initialized = packet.nativeNodeIdentity === true && packet.sourceModified === false;
          } else if (packet.event === 'public_source_get') {
            if (packet.host === 'www.google.com' && packet.path === parsed.pathname) {
              receipt.worker.scriptStatus = packet.status;
              receipt.worker.scriptBytes = packet.bytes;
              receipt.worker.scriptSha256 = packet.sha256;
            } else if (packet.host === 'www.gstatic.com' && packet.path === runtimeUrl.pathname) {
              receipt.worker.runtimeStatus = packet.status;
              receipt.worker.runtimeBytes = packet.bytes;
              receipt.worker.runtimeSha256 = packet.sha256;
            }
          } else if (packet.event === 'initialization_error' || packet.event === 'sdk_runtime_error') {
            receipt.runtimeError = packet.error;
          } else if (packet.event === 'network_blocked') {
            networkBlockedCount += 1;
          }
          return;
        }
        if (packet?.kind === 'fetch_request') {
          void bridgeClearRequest(child, packet);
          return;
        }
        if (packet?.kind !== 'message') return;
        const event = new window.MessageEvent('message', { data: packet.data, ports: packet.ports || [] });
        this.onmessage?.(event);
        this.dispatchEvent(event);
      });
      child.on('error', error => {
        receipt.runtimeError ||= safeJsdomError(error);
        receipt.worker.errorName = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError'].includes(error?.name)
          ? error.name : 'Error';
        if (typeof error?.code === 'string' && /^ERR_[A-Z0-9_]{1,64}$/.test(error.code)) receipt.worker.errorCode = error.code;
        reportStage('classic_worker_error');
        const event = new window.ErrorEvent('error', { message: 'Node reCAPTCHA worker failed.' });
        this.onerror?.(event);
        this.dispatchEvent(event);
      });
      child.on('exit', code => {
        childWorkers.delete(child);
        if (!closed && code !== 0) {
          receipt.worker.exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
          reportStage('classic_worker_exited');
        }
        if (!closed && code !== 0) {
          const event = new window.ErrorEvent('error', { message: 'Node reCAPTCHA worker exited unexpectedly.' });
          this.onerror?.(event);
          this.dispatchEvent(event);
        }
      });
    }
    postMessage(data, transfer = []) {
      this.nodeWorker.postMessage({ kind: 'message', data, ports: transfer.filter(port => port instanceof MessagePort) }, transfer);
    }
    terminate() { return this.nodeWorker.terminate(); }
  };

  window.postMessage = function (data, targetOrOptions = {}, legacyTransfer = []) {
    const options = targetOrOptions && typeof targetOrOptions === 'object' ? targetOrOptions : null;
    const source = callerRealm([options, legacyTransfer, data], windows);
    if (!source) return;
    const suppliedTarget = options ? options.targetOrigin ?? '/' : targetOrOptions;
    const targetOrigin = suppliedTarget === '/' ? source.location.origin
      : suppliedTarget === '*' ? '*' : new URL(String(suppliedTarget)).origin;
    if (targetOrigin !== '*' && targetOrigin !== window.location.origin) return;
    const transfer = options ? options.transfer ?? [] : legacyTransfer;
    const ports = transfer.filter(value => value instanceof MessagePort);
    const cloned = structuredClone({ data, ports }, { transfer });
    for (const port of cloned.ports) trackedChannels.push({ port1: port, port2: port });
    window.setTimeout(() => window.dispatchEvent(new window.MessageEvent('message', {
      data: cloned.data, origin: source.location.origin, source, ports: cloned.ports,
    })), 0);
  };
}

async function main() {
  reportStage('worker_module_ready');
  if (!parentPort || typeof workerData?.siteKey !== 'string' || !Array.isArray(workerData.cookies)) {
    throw codedError('FLOW_NODE_ISSUER_INPUT_INVALID');
  }
  siteKey = workerData.siteKey;
  activeJar = buildCookieJar(workerData.cookies);
  reportStage('input_ready');
  const loaderUrl = new URL('/recaptcha/enterprise.js', GOOGLE_ORIGIN);
  loaderUrl.searchParams.set('trustedtypes', 'true');
  loaderUrl.searchParams.set('render', siteKey);
  const cookie = activeJar.getCookieStringSync(loaderUrl.href);
  reportStage('loader_request_started');
  const loaderResponse = await globalThis.fetch(loaderUrl, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: cookie ? { cookie, accept: 'text/javascript, application/javascript' } : { accept: 'text/javascript, application/javascript' },
  });
  addResponseCookies(loaderResponse, loaderUrl, activeJar);
  const loaderMime = mimeOf(loaderResponse.headers);
  if (loaderResponse.status !== 200 || !/^(?:text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/.test(loaderMime)) {
    await cancelBody(loaderResponse);
    throw codedError('FLOW_NODE_ISSUER_LOADER_HTTP_FAILED');
  }
  const loaderBytes = await boundedBytes(loaderResponse, MAX_SCRIPT_BYTES, 'FLOW_NODE_ISSUER_LOADER_TOO_LARGE');
  sourceLoader = loaderBytes.toString('utf8');
  receipt.loader = { host: loaderUrl.hostname, path: loaderUrl.pathname, method: 'GET', status: 200,
    mime: loaderMime, bytes: loaderBytes.length, sha256: createHash('sha256').update(loaderBytes).digest('hex') };
  reportStage('loader_loaded');
  loaderBytes.fill(0);
  const runtimeMatch = /https:\/\/www\.gstatic\.com\/recaptcha\/releases\/[^'"\s<>]+\/recaptcha__(?:en|ko)\.js/.exec(sourceLoader);
  if (!runtimeMatch) throw codedError('FLOW_NODE_ISSUER_RUNTIME_UNOBSERVED');
  sourceRuntime = new URL(runtimeMatch[0]);
  if (sourceRuntime.origin !== GSTATIC_ORIGIN || !/^\/recaptcha\/releases\/([A-Za-z0-9_-]+)\/recaptcha__(?:en|ko)\.js$/.test(sourceRuntime.pathname)) {
    throw codedError('FLOW_NODE_ISSUER_RUNTIME_SCOPE');
  }
  const releaseId = /^\/recaptcha\/releases\/([^/]+)\//.exec(sourceRuntime.pathname)?.[1];
  const locale = /recaptcha__(ko|en)\.js$/.exec(sourceRuntime.pathname)?.[1] || null;
  const cssRuntimeOptions = { runtimePath: sourceRuntime.pathname, releaseId };
  const runtimeLoader = new URL(sourceRuntime.href);
  receipt.runtime = { host: sourceRuntime.hostname, path: sourceRuntime.pathname, method: 'GET', locale, sdkVersion: releaseId };

  const loaderCookie = activeJar.getCookieStringSync(loaderUrl.href);
  if (!loaderCookie) throw codedError('FLOW_NODE_ISSUER_GOOGLE_COOKIE_UNAVAILABLE');
  siteKey = workerData.siteKey;
  installHttpGuard(cssRuntimeOptions);

  class ScopedResources extends ResourceLoader {
    constructor() { super({ userAgent: `Node.js/${process.versions.node} jsdom/26.1.0` }); }
    fetch(rawUrl, options) {
      const realm = options.element?.ownerDocument?.defaultView;
      if (realm) bindWindow(realm, workerUrl, runtimeLoader, cssRuntimeOptions);
      let url;
      try { url = new URL(rawUrl); } catch { networkBlockedCount += 1; return null; }
      if (url.href === loaderUrl.href) return Promise.resolve(Buffer.from(sourceLoader));
      if (!urlWithinSdkAllowlist(url, cssRuntimeOptions)) { networkBlockedCount += 1; return null; }
      const limit = url.pathname === '/recaptcha/enterprise/anchor' ? MAX_ANCHOR_BYTES : MAX_SCRIPT_BYTES;
      const promise = boundedResourceGet(url, options, limit);
      if (url.pathname === '/recaptcha/enterprise/anchor') {
        return mappedResource(promise, bytes => {
          if (bytes && promise.response?.status === 200 && bytes.length <= MAX_ANCHOR_BYTES) {
            anchorReceiptFrom(url, promise.response, bytes);
          }
          return bytes;
        });
      }
      if (url.pathname === runtimeLoader.pathname) {
        return mappedResource(promise, bytes => {
          if (bytes) {
            receipt.runtime.status = promise.response?.status || null;
            receipt.runtime.mime = String(promise.response?.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
            receipt.runtime.bytes = bytes.length;
            receipt.runtime.sha256 = createHash('sha256').update(bytes).digest('hex');
          }
          return bytes;
        });
      }
      return promise;
    }
  }

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    receipt.runtimeError = safeJsdomError(error.detail || error);
  });
  const workerUrl = new URL('/recaptcha/enterprise/webworker.js', GOOGLE_ORIGIN);
  workerUrl.searchParams.set('hl', locale || 'en');
  workerUrl.searchParams.set('v', releaseId);
  const resources = new ScopedResources();
  if (typeof workerData.projectId !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(workerData.projectId)) {
    throw codedError('FLOW_NODE_ISSUER_PROJECT_BINDING_INVALID');
  }
  const projectLocation = new URL(`/project/${workerData.projectId}`, 'https://flow.google.com');
  reportStage('jsdom_create_started');
  activeDom = new JSDOM(`<!doctype html><html lang="ko"><head><script src="${loaderUrl.href}"></script></head><body></body></html>`, {
    url: projectLocation.href,
    runScripts: 'dangerously', resources, cookieJar: activeJar,
    userAgent: `Node.js/${process.versions.node} jsdom/26.1.0`, virtualConsole,
    beforeParse(window) { bindWindow(window, workerUrl, runtimeLoader, cssRuntimeOptions); },
  });

  if (typeof activeDom.window.navigator.userAgent !== 'string'
    || !activeDom.window.navigator.userAgent.startsWith(`Node.js/${process.versions.node} jsdom/26.1.0`)) {
    throw codedError('FLOW_NODE_ISSUER_NODE_IDENTITY_UNAVAILABLE');
  }
  receipt.nodeVersion = process.version;
  receipt.browserEngineUsed = false;
  receipt.browserSignalsOverridden = false;
  reportStage('jsdom_created');

  const startedAt = Date.now();
  const timeout = new Promise((_, reject) => {
    timerHandles.push(setTimeout(() => reject(codedError('FLOW_NODE_ISSUER_EXECUTE_TIMEOUT')), MAX_EXECUTE_MS));
  });
  const sdkExecute = new Promise((resolve, reject) => {
    let readyTimer;
    let api;
    const probe = () => {
      if (closed) return reject(codedError('FLOW_NODE_ISSUER_CANCELLED'));
      api = activeDom?.window?.grecaptcha?.enterprise;
      if (typeof api?.ready !== 'function') {
        readyTimer = setTimeout(probe, 25);
        timerHandles.push(readyTimer);
        return;
      }
      sdkExecuteStarted = true;
      receipt.execute.callCount = 1;
      reportStage('sdk_execute_started');
      try {
        api.ready(() => {
          let output;
          try { output = api.execute(siteKey, { action: 'VIDEO_GENERATION' }); }
          catch { reject(codedError('FLOW_NODE_ISSUER_EXECUTE_FAILED')); return; }
          Promise.resolve(output).then(token => {
            if (typeof token !== 'string' || !token || token.length > 8_192 || /[\r\n\0]/.test(token)) {
              reject(codedError('FLOW_NODE_ISSUER_TOKEN_INVALID'));
              return;
            }
            sdkExecuteReturned = true;
            executeTokenLength = token.length;
            resolve(token);
          }, () => reject(codedError('FLOW_NODE_ISSUER_EXECUTE_FAILED')));
        });
      } catch { reject(codedError('FLOW_NODE_ISSUER_EXECUTE_FAILED')); }
    };
    probe();
  });

  let executeToken;
  let reloadResult;
  [executeToken, reloadResult] = await Promise.race([
    Promise.all([sdkExecute, reloadResponse]),
    timeout,
  ]);
  tokenMatchesReload = reloadResult.valid && executeToken === reloadResult.token;
  receipt.execute = { callCount: sdkExecuteStarted ? 1 : 0, returnedNonemptyToken: sdkExecuteReturned,
    returnedTokenLength: executeTokenLength, matchesReloadReply: tokenMatchesReload };
  if (!tokenMatchesReload || !reloadReceipt.responseSchemaValid || reloadReceipt.postCount !== 1
    || reloadReceipt.status !== 200 || !Object.values({
      sdkVersionMatchesAnchor: reloadReceipt.sdkVersionMatchesAnchor,
      anchorTokenMatchesRequest: reloadReceipt.anchorTokenMatchesRequest,
      actionMatches: reloadReceipt.actionMatches,
      siteKeyMatches: reloadReceipt.siteKeyMatches,
    }).every(Boolean)) {
    receipt.completedAt = new Date().toISOString();
    parentPort.postMessage({ kind: 'receipt', receipt });
    throw codedError('FLOW_NODE_ISSUER_CONTRACT_UNVERIFIED');
  }
  receipt.anchor.configuredKeyMatches = anchor?.key === siteKey;
  receipt.anchor.hiddenTokenPresent = Boolean(anchorToken);
  receipt.execute.callCount = 1;
  receipt.execute.returnedNonemptyToken = true;
  receipt.execute.returnedTokenLength = executeTokenLength;
  receipt.execute.matchesReloadReply = true;
  receipt.reload = { ...reloadReceipt };
  receipt.clear = { ...clearReceipt };
  receipt.networkBlockedCount = networkBlockedCount;
  receipt.completedAt = new Date().toISOString();
  reportStage('reload_verified');
  parentPort.postMessage({ kind: 'receipt', receipt });
  let token = executeToken;
  const issuedAt = reloadResult.issuedAt;
  executeTokenLength = 0;
  executeToken = null;
  reloadResult.token = null;
  reloadResult = null;
  reloadToken = null;
  reloadIssuedAt = null;
  reloadResolver = () => {};
  anchorToken = null;
  anchor = null;
  siteKey = null;
  sourceLoader = null;
  sourceRuntime = null;
  parentPort.postMessage({ kind: 'issued', token, issuedAt, receipt });
  token = null;
  return startedAt;
}

async function bridgeClearRequest(worker, packet) {
  const requestId = Number.isSafeInteger(packet?.requestId) ? packet.requestId : null;
  const body = packet?.body instanceof Uint8Array ? Buffer.from(packet.body) : null;
  const url = (() => { try { return new URL(packet.url); } catch { return null; } })();
  const contentType = typeof packet.contentType === 'string' ? packet.contentType.toLowerCase() : '';
  const allowed = requestId !== null && body && body.length <= MAX_PROTO_BYTES && packet.method === 'POST'
    && url?.protocol === 'https:' && url.origin === GOOGLE_ORIGIN && url.pathname === '/recaptcha/enterprise/clr'
    && ['application/x-protobuf', 'application/x-protobuffer'].includes(contentType)
    && reloadVerified && typeof reloadToken === 'string' && clearReceipt.postCount === 0;
  if (!allowed) {
    networkBlockedCount += 1;
    body?.fill(0);
    if (requestId !== null) worker.postMessage({ kind: 'fetch_response', requestId, status: 400, contentType: 'text/plain', body: new Uint8Array() });
    return;
  }
  clearReceipt.postCount = 1;
  try {
    const headers = new Headers({ 'content-type': contentType, accept: packet.accept || '*/*' });
    if (packet.credentials === 'include' || packet.credentials === 'same-origin') {
      const cookie = activeJar.getCookieStringSync(url.href);
      if (cookie) headers.set('cookie', cookie);
    }
    const response = await globalThis.fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    addResponseCookies(response, url, activeJar);
    clearReceipt.status = response.status;
    const bytes = await boundedBytes(response, 64 * 1024, 'FLOW_NODE_ISSUER_CLEAR_REPLY_TOO_LARGE');
    clearReceipt.responseBytes = bytes.length;
    const transfer = new Uint8Array(bytes);
    worker.postMessage({ kind: 'fetch_response', requestId, status: response.status,
      contentType: mimeOf(response.headers), body: transfer }, [transfer.buffer]);
    bytes.fill(0);
  } catch {
    worker.postMessage({ kind: 'fetch_response', requestId, status: 400, contentType: 'text/plain', body: new Uint8Array() });
  } finally {
    body.fill(0);
  }
}

function clearMemory() {
  closed = true;
  // Keep the scoped HTTP guard installed until this isolated issuer worker exits.
  timerHandles.forEach(clearTimeout);
  if (activeDom) {
    try { activeDom.window.close(); } catch { /* Keep teardown best-effort and silent. */ }
  }
  for (const channel of trackedChannels) {
    try { channel.port1.close(); } catch {}
    try { channel.port2.close(); } catch {}
  }
  for (const worker of trackedWorkers) {
    try { worker.postMessage({ kind: 'close' }); } catch { /* Termination below still closes the isolated realm. */ }
    void worker.terminate().catch(() => {});
  }
  try { activeJar?.removeAllCookiesSync(); } catch { /* Scoped cookie memory is discarded with this worker. */ }
  for (const cookie of workerData?.cookies || []) cookie.value = '';
  activeDom = null;
  activeJar = null;
  sdkWindows.clear();
  anchorToken = null;
  anchor = null;
  reloadToken = null;
  siteKey = null;
  sourceLoader = null;
  sourceRuntime = null;
}

parentPort?.on('message', packet => {
  if (packet?.kind === 'close') {
    clearMemory();
    for (const worker of trackedWorkers) void worker.terminate();
  }
});

main().then(() => {
  clearMemory();
}).catch(error => {
  const code = /^FLOW_NODE_ISSUER_[A-Z0-9_]{1,80}$/.test(error?.code || '')
    ? error.code : 'FLOW_NODE_ISSUER_WORKER_FAILED';
  receipt.runtimeError = safeJsdomError(error);
  receipt.failureCode = code;
  receipt.stage = 'failed';
  receipt.elapsedMs = Math.max(0, Math.min(120_000, Date.now() - WORKER_MODULE_STARTED_AT));
  receipt.completedAt ||= new Date().toISOString();
  receipt.networkBlockedCount = networkBlockedCount;
  parentPort?.postMessage({ kind: 'receipt', receipt });
  parentPort?.postMessage({ kind: 'failed', code });
  clearMemory();
});
