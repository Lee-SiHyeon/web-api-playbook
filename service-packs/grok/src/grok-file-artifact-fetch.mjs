import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { validateContractRegistry } from './contracts.mjs';
import { fail } from './errors.mjs';

const HELPER_PATH = fileURLToPath(new URL('../scripts/grok-file-artifact-download.py', import.meta.url));
const MAX_PACKET_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

function failWith(code, cause) {
  return Object.assign(fail(code), { cause });
}

function childEnvironment() {
  const environment = { PYTHONDONTWRITEBYTECODE: '1' };
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function parseSafeHeader(line, maxBytes) {
  let value;
  try { value = JSON.parse(line); } catch { throw fail('FILE_ARTIFACT_HELPER_FAILED'); }
  if (value?.error) {
    const code = typeof value.error === 'string' && /^FILE_ARTIFACT_[A-Z0-9_]{1,64}$/.test(value.error)
      ? value.error : 'FILE_ARTIFACT_HELPER_FAILED';
    const stage = typeof value.stage === 'string' && /^[a-z_]{1,32}$/.test(value.stage) ? value.stage : undefined;
    throw fail(code, stage ? { stage } : undefined);
  }
  if (!Number.isInteger(value?.status) || value.status < 100 || value.status > 599
      || typeof value.contentType !== 'string' || value.contentType.length > 256
      || (value.redirectLocation !== null && value.redirectLocation !== undefined
        && (typeof value.redirectLocation !== 'string' || value.redirectLocation.length > 8192 || /[\r\n\0]/.test(value.redirectLocation)))
      || !['http/1.0', 'http/1.1', 'h2', 'h3', 'other'].includes(value.httpVersion)
      || typeof value.tlsVerified !== 'boolean' || typeof value.trustEnv !== 'boolean'
      || typeof value.redirectsFollowed !== 'boolean' || !Number.isInteger(value.explicitRetries)
      || !Array.isArray(value.requestHeaderNames)
      || value.requestHeaderNames.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name))
      || (value.contentLength !== null && value.contentLength !== undefined
        && (!Number.isSafeInteger(value.contentLength) || value.contentLength < 0 || value.contentLength > maxBytes))) {
    throw fail('FILE_ARTIFACT_HELPER_FAILED');
  }
  return value;
}

function makeResponseStream(child, header, initialBody, timer, signal) {
  const stream = new PassThrough({ highWaterMark: 64 * 1024 });
  let finished = false;
  const finish = (error = undefined) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (error) stream.destroy(error);
    else stream.end();
  };
  const abort = () => {
    child.kill('SIGKILL');
    finish(fail('FILE_ARTIFACT_ABORTED'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  if (initialBody.length && !stream.write(Buffer.from(initialBody))) child.stdout.pause();
  stream.on('drain', () => child.stdout.resume());
  child.stdout.on('data', chunk => {
    if (finished) return;
    if (!stream.write(chunk)) child.stdout.pause();
  });
  child.on('error', error => finish(failWith('FILE_ARTIFACT_HELPER_FAILED', error)));
  child.on('close', code => {
    if (code === 0) finish();
    else finish(fail('FILE_ARTIFACT_TRANSPORT_FAILED'));
  });
  const headers = new Headers();
  if (header.contentType) headers.set('content-type', header.contentType);
  if (Number.isSafeInteger(header.contentLength)) headers.set('content-length', String(header.contentLength));
  if (header.redirectLocation) headers.set('location', header.redirectLocation);
  const body = [204, 205, 304].includes(header.status) ? null : Readable.toWeb(stream);
  const response = new Response(body, { status: header.status, headers });
  Object.defineProperty(response, 'transportEvidence', {
    value: Object.freeze({
      httpVersion: header.httpVersion,
      profile: 'curl-cffi-chrome150',
      tlsVerified: header.tlsVerified,
      trustEnv: header.trustEnv,
      redirectsFollowed: header.redirectsFollowed,
      explicitRetries: header.explicitRetries,
      requestHeaderNames: Object.freeze([...header.requestHeaderNames]),
      cookieNamesPrepared: Object.freeze([]),
    }),
  });
  return response;
}

function credentiallessOriginFetch({ pythonExecutable, timeoutMs, maxBytes }) {
  return async (url, init) => new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [HELPER_PATH], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: childEnvironment(),
    });
    let headerBuffer = Buffer.alloc(0);
    let headerReceived = false;
    let responseStreamCreated = false;
    let timer;
    let signalAbort;
    const destroy = (error, { kill = true } = {}) => {
      clearTimeout(timer);
      if (kill && !child.killed) child.kill('SIGKILL');
      if (!responseStreamCreated) reject(error);
    };
    timer = setTimeout(() => destroy(fail('FILE_ARTIFACT_TIMEOUT')), timeoutMs);
    timer.unref?.();
    if (init.signal) {
      signalAbort = () => destroy(fail('FILE_ARTIFACT_ABORTED'));
      if (init.signal.aborted) signalAbort();
      else init.signal.addEventListener('abort', signalAbort, { once: true });
    }
    child.stdout.on('data', chunk => {
      if (headerReceived) return;
      headerBuffer = Buffer.concat([headerBuffer, Buffer.from(chunk)]);
      if (headerBuffer.length > MAX_HEADER_BYTES) {
        destroy(fail('FILE_ARTIFACT_HELPER_FAILED'));
        return;
      }
      const newline = headerBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = headerBuffer.subarray(0, newline).toString('utf8');
      const initialBody = Buffer.from(headerBuffer.subarray(newline + 1));
      headerBuffer.fill(0);
      headerBuffer = Buffer.alloc(0);
      try {
        const header = parseSafeHeader(line, maxBytes);
        headerReceived = true;
        responseStreamCreated = true;
        init.signal?.removeEventListener('abort', signalAbort);
        const response = makeResponseStream(child, header, initialBody, timer, init.signal);
        resolve(response);
      } catch (error) {
        destroy(error);
      } finally {
        initialBody.fill(0);
      }
    });
    child.stdout.on('error', error => destroy(failWith('FILE_ARTIFACT_HELPER_FAILED', error)));
    child.stdin.on('error', error => destroy(failWith('FILE_ARTIFACT_HELPER_FAILED', error)));
    child.on('error', error => destroy(failWith('FILE_ARTIFACT_HELPER_FAILED', error)));
    child.on('close', code => {
      if (!headerReceived) destroy(fail(code === 0 ? 'FILE_ARTIFACT_HELPER_FAILED' : 'FILE_ARTIFACT_TRANSPORT_FAILED'), { kill: false });
    });
    const packet = Buffer.from(JSON.stringify({
      url: url.href,
      allowedOrigins: [...init.allowedOrigins],
      timeoutMs,
      maxBytes,
    }), 'utf8');
    if (packet.length > MAX_PACKET_BYTES) {
      packet.fill(0);
      destroy(fail('FILE_ARTIFACT_PACKET_INVALID'));
      return;
    }
    child.stdin.end(packet, () => packet.fill(0));
  });
}

function validateSourceResolvedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('FILE_ARTIFACT_URL_INVALID'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !hostname.includes('.') || isIP(hostname)
      || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || hostname.endsWith('.internal') || url.username || url.password || url.hash) {
    throw fail('FILE_ARTIFACT_URL_SCOPE');
  }
  return url;
}

export function createGrokFileArtifactFetch({ registry, pythonExecutable = 'python3', timeoutMs = 120_000,
  maxBytes = MAX_ARTIFACT_BYTES, fetchImpl } = {}) {
  validateContractRegistry(registry);
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim()
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES
      || (fetchImpl !== undefined && typeof fetchImpl !== 'function')) {
    throw fail('FILE_ARTIFACT_FETCH_OPTIONS_INVALID');
  }
  const artifactOrigins = new Set(registry.operations.filter(operation => operation.kind === 'download')
    .flatMap(operation => operation.artifact.allowedOrigins));
  const cffiFetch = credentiallessOriginFetch({ pythonExecutable, timeoutMs, maxBytes });
  const fetchStaticArtifact = async (input, init = {}) => {
    let url;
    try { url = new URL(String(input)); } catch { throw fail('FILE_ARTIFACT_URL_INVALID'); }
    if (url.protocol !== 'https:' || !artifactOrigins.has(url.origin) || url.username || url.password || url.hash
        || init.method !== 'GET' || init.credentials !== 'omit' || init.redirect !== 'manual'
        || init.body !== undefined && init.body !== null || init.headers && new Headers(init.headers).size > 0) {
      throw fail('FILE_ARTIFACT_FETCH_SCOPE');
    }
    const originAllowed = registry.operations.some(operation => operation.kind === 'download'
      && operation.artifact.allowedOrigins.includes(url.origin))
    const allowedOrigins = originAllowed ? [url.origin] : [];
    const headerNames = [...new Headers(init.headers ?? {}).keys()];
    if (!allowedOrigins.length || headerNames.length) throw fail('FILE_ARTIFACT_FETCH_SCOPE');
    if (fetchImpl) {
      return fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'manual', signal: init.signal });
    }
    return cffiFetch(url, { ...init, allowedOrigins });
  };
  const fetchSourceResolvedArtifact = async (sourceUrl, { signal } = {}) => {
    if (typeof sourceUrl !== 'string' || sourceUrl.length > 8192) throw fail('FILE_ARTIFACT_URL_INVALID');
    const url = validateSourceResolvedUrl(sourceUrl);
    if (fetchImpl) {
      return fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'manual', signal });
    }
    return cffiFetch(url, { method: 'GET', credentials: 'omit', redirect: 'manual', signal,
      allowedOrigins: [url.origin] });
  };
  return Object.freeze({ fetch: fetchStaticArtifact, fetchSourceResolvedArtifact });
}
