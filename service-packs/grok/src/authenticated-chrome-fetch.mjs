import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationReadiness, validateContractRegistry } from './contracts.mjs';
import { fail } from './errors.mjs';
import { MAX_DIRECT_MULTIPART_BODY_BYTES } from './grok-attachment-constants.mjs';

const HELPER_PATH = fileURLToPath(new URL('../scripts/authenticated-chrome-transport.py', import.meta.url));
const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const CHALLENGE_COOKIE = /(?:^|[_-])(?:cf[_-]?clearance|cf[_-]?chl|__?cf[_-]?bm|captcha|challenge|turnstile)(?:$|[_-])/i;
const BASIC_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'origin', 'referer']);
const HELPER_ERRORS = new Set([
  'AUTH_CHROME_DEPENDENCY_MISSING',
  'AUTH_CHROME_DEPENDENCY_VERSION_MISMATCH',
  'AUTH_CHROME_REQUEST_REJECTED',
  'AUTH_CHROME_RESPONSE_TOO_LARGE',
  'AUTH_CHROME_FAILED',
]);
const authenticatedFetchers = new WeakSet();

async function writePrivateRequestBody(body) {
  const home = path.resolve(homedir());
  const scratchRoot = path.resolve(process.env.TMPDIR || path.join(home, '.nad-scratch', 'tmp'));
  const relative = path.relative(home, scratchRoot);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail('AUTH_CHROME_TEMP_ROOT_INVALID');
  }
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 }).catch(() => { throw fail('AUTH_CHROME_TEMP_ROOT_INVALID'); });
  const rootInfo = await lstat(scratchRoot).catch(() => { throw fail('AUTH_CHROME_TEMP_ROOT_INVALID'); });
  const rootReal = await realpath(scratchRoot).catch(() => { throw fail('AUTH_CHROME_TEMP_ROOT_INVALID'); });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootReal !== scratchRoot
    || typeof process.getuid === 'function' && rootInfo.uid !== process.getuid()
    || (rootInfo.mode & 0o777) !== 0o700) throw fail('AUTH_CHROME_TEMP_ROOT_INVALID');
  let directory;
  try {
    directory = await mkdtemp(path.join(scratchRoot, 'grok-http-body-'));
    await chmod(directory, 0o700);
    const filePath = path.join(directory, 'request-body.bin');
    const handle = await open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally { await handle.close(); }
    const fileInfo = await lstat(filePath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink !== 1
      || typeof process.getuid === 'function' && fileInfo.uid !== process.getuid()
      || (fileInfo.mode & 0o777) !== 0o600 || fileInfo.size !== body.length) {
      throw fail('AUTH_CHROME_TEMP_FILE_INVALID');
    }
    return Object.freeze({ directory, filePath, bodyBytes: fileInfo.size });
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error?.code === 'AUTH_CHROME_TEMP_ROOT_INVALID' || error?.code === 'AUTH_CHROME_TEMP_FILE_INVALID') throw error;
    throw failWith('AUTH_CHROME_TEMP_FILE_FAILED', error);
  }
}

function failWith(code, cause) {
  return Object.assign(fail(code), { cause });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function operationMatches(operation, url, method) {
  if (operation.method !== method || url.origin !== new URL(operation.urlTemplate).origin) return false;
  const template = new URL(operation.urlTemplate);
  const rawPath = operation.urlTemplate.slice(template.origin.length).split(/[?#]/, 1)[0];
  const pathParts = rawPath.split(/(\{\{input\.[A-Za-z][A-Za-z0-9_.-]{0,127}\}\})/g);
  const pathPattern = `^${pathParts.map(part => /^\{\{input\.[A-Za-z][A-Za-z0-9_.-]{0,127}\}\}$/.test(part) ? '[^/]+' : escapeRegex(part)).join('')}$`;
  if (!new RegExp(pathPattern).test(url.pathname)) return false;
  const allowedQueryKeys = new Set([
    ...template.searchParams.keys(),
    ...Object.keys(operation.request.queryTemplate ?? {}),
  ]);
  const providedKeys = [...url.searchParams.keys()];
  if (new Set(providedKeys).size !== providedKeys.length || providedKeys.some(key => !allowedQueryKeys.has(key))) return false;
  for (const [key, value] of template.searchParams) {
    const token = /^\{\{input\.[A-Za-z][A-Za-z0-9_.-]{0,127}\}\}$/.test(value);
    if (!token && url.searchParams.get(key) !== value) return false;
  }
  return true;
}

function parseCookieHeader(value, allowedNames) {
  const allowed = new Set(allowedNames);
  if (typeof value !== 'string' || !value.trim()) {
    if (allowed.size) throw fail('AUTH_CHROME_COOKIE_REJECTED');
    return [];
  }
  if (!allowed.size) throw fail('AUTH_CHROME_COOKIE_REJECTED');
  const cookies = [];
  const names = new Set();
  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) throw fail('AUTH_CHROME_COOKIE_REJECTED');
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (!COOKIE_NAME.test(name) || !cookieValue || /[\r\n\0;]/.test(cookieValue)
      || CHALLENGE_COOKIE.test(name) || !allowed.has(name) || names.has(name)) {
      throw fail('AUTH_CHROME_COOKIE_REJECTED');
    }
    names.add(name);
    cookies.push({ name, value: cookieValue });
  }
  if (allowed.size !== names.size || [...allowed].some(name => !names.has(name))) {
    throw fail('AUTH_CHROME_COOKIE_REJECTED');
  }
  return cookies;
}

function decodeResponse(stdout, operation) {
  let packet;
  try { packet = JSON.parse(stdout.toString('utf8')); } catch { throw fail('AUTH_CHROME_HELPER_FAILED'); }
  if (HELPER_ERRORS.has(packet?.error)) throw fail(packet.error, typeof packet.stage === 'string' && /^[a-z_]{1,40}$/.test(packet.stage) ? { stage: packet.stage } : undefined);
  if (!Number.isInteger(packet?.status) || packet.status < 200 || packet.status > 599
    || typeof packet.contentType !== 'string' || packet.contentType.length > 256
    || !['http/1.0', 'http/1.1', 'h2', 'h3', 'other'].includes(packet.httpVersion)
    || typeof packet.bodyBase64 !== 'string' || packet.bodyBase64.length > Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 16) {
    throw fail('AUTH_CHROME_HELPER_FAILED');
  }
  const body = Buffer.from(packet.bodyBase64, 'base64');
  const allowedLimit = operation.response.statuses.includes(packet.status) ? operation.response.maxBytes : MAX_ERROR_BYTES;
  if (body.length > allowedLimit || body.toString('base64') !== packet.bodyBase64) {
    body.fill(0);
    throw fail('AUTH_CHROME_HELPER_FAILED');
  }
  const headers = new Headers();
  if (packet.contentType) headers.set('content-type', packet.contentType);
  for (const line of packet.setCookies ?? []) {
    if (typeof line !== 'string' || line.length > 16_384 || /[\r\n\0]/.test(line)) continue;
    headers.append('set-cookie', line);
  }
  const status = packet.status;
  const response = new Response([204, 205, 304].includes(status) ? null : body, { status, headers });
  Object.defineProperty(response, 'transportEvidence', {
    value: Object.freeze({
      httpVersion: packet.httpVersion,
      profile: 'curl-cffi-chrome150',
      tlsVerified: true,
      trustEnv: false,
      redirectsFollowed: false,
      explicitRetries: 0,
      requestHeaderNames: Array.isArray(packet.requestHeaderNames) ? packet.requestHeaderNames.filter(name => typeof name === 'string') : [],
      cookieNamesPrepared: Array.isArray(packet.requestMeta?.cookieNames) ? packet.requestMeta.cookieNames.filter(name => typeof name === 'string') : [],
      requestMeta: packet.requestMeta && typeof packet.requestMeta === 'object' ? packet.requestMeta : null,
    }),
    configurable: true,
  });
  return response;
}

function childEnvironment() {
  const environment = { PYTHONDONTWRITEBYTECODE: '1' };
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

export function isAuthenticatedChromeFetch(fetchImpl) {
  return typeof fetchImpl === 'function' && authenticatedFetchers.has(fetchImpl);
}

export function createAuthenticatedChromeFetch({ registry, pythonExecutable, timeoutMs = 120_000 } = {}) {
  validateContractRegistry(registry);
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim()
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) {
    throw fail('AUTH_CHROME_OPTIONS_INVALID');
  }

  const fetchImpl = async (input, init = {}) => {
    let url;
    try { url = new URL(String(input)); } catch { throw fail('AUTH_CHROME_REQUEST_BLOCKED'); }
    const method = String(init.method ?? 'GET').toUpperCase();
    const matches = registry.operations.filter(operation => operationMatches(operation, url, method));
    if (matches.length !== 1) throw fail('AUTH_CHROME_OPERATION_UNRESOLVED');
    const operation = matches[0];
    const sourceDiscoveryEligible = init.sourceDiscoveryPermit === `first-live:${operation.id}`
      && operation.kind === 'submit'
      && operation.evidence?.source === 'first_party_sdk_contract'
      && operation.evidence.firstLiveReplayPermit === true
      && !operation.evidence.directReplay;
    const sourceReadEligible = init.sourceDiscoveryPermit === `first-read:${operation.id}`
      && operation.kind === 'read'
      && operation.evidence?.source === 'first_party_sdk_contract'
      && operation.evidence.firstLiveReadPermit === true
      && !operation.evidence.directReplay;
    if ((!operationReadiness(operation).ready && !sourceDiscoveryEligible && !sourceReadEligible) || operation.authMode !== 'session'
      || init.redirect !== 'manual' || init.signal?.aborted) throw fail('AUTH_CHROME_REQUEST_BLOCKED');

    const requestHeaders = new Headers(init.headers ?? {});
    const cookieNames = operation.request.credentialBindings?.cookies ?? [];
    const credentialHeaderNames = [
      ...(operation.request.credentialBindings?.headers ?? []),
      ...(operation.request.perActionMetadataHeaders ?? []),
      ...(operation.request.optionalPerActionMetadataHeaders ?? []),
    ];
    const optionalHeaderSet = new Set((operation.request.optionalPerActionMetadataHeaders ?? []).map(name => name.toLowerCase()));
    const credentialHeaderSet = new Set(credentialHeaderNames.map(name => name.toLowerCase()));
    const headers = {};
    for (const [name, value] of requestHeaders) {
      const key = name.toLowerCase();
      if (key === 'cookie') continue;
      if (credentialHeaderSet.has(key)) continue;
      if (!BASIC_HEADERS.has(key) && !credentialHeaderSet.has(key)) throw fail('AUTH_CHROME_HEADER_REJECTED');
      if (key === 'origin' && value !== url.origin) throw fail('AUTH_CHROME_HEADER_REJECTED');
      if (key === 'referer') {
        let referer;
        try { referer = new URL(value); } catch { throw fail('AUTH_CHROME_HEADER_REJECTED'); }
        if (referer.origin !== url.origin || referer.username || referer.password || referer.search || referer.hash) {
          throw fail('AUTH_CHROME_HEADER_REJECTED');
        }
      }
      headers[key] = value;
    }
    const cookies = parseCookieHeader(requestHeaders.get('cookie'), cookieNames);
    const credentialHeaders = {};
    for (const name of credentialHeaderNames) {
      const value = requestHeaders.get(name);
      if (!requestHeaders.has(name) && optionalHeaderSet.has(name.toLowerCase())) continue;
      if (!value) throw fail('AUTH_CHROME_HEADER_REJECTED');
      credentialHeaders[name.toLowerCase()] = value;
    }
    const body = init.body === undefined || init.body === null ? Buffer.alloc(0)
      : Buffer.from(typeof init.body === 'string' ? init.body : init.body);
    const bodyLimit = operation.request.maxBodyBytes ?? MAX_PACKET_BYTES;
    const streamBodyFile = operation.request.streamBodyFile === true;
    if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > MAX_DIRECT_MULTIPART_BODY_BYTES
      || body.length > bodyLimit || bodyLimit > MAX_PACKET_BYTES && operation.id !== 'attachment.upload.direct'
      || streamBodyFile && (operation.id !== 'attachment.upload.direct' || bodyLimit !== MAX_DIRECT_MULTIPART_BODY_BYTES)) {
      body.fill(0);
      throw fail('AUTH_CHROME_REQUEST_TOO_LARGE');
    }
    let requestBodyFile = null;
    let bodyBase64 = '';
    let bodySha256 = '';
    try {
      if (streamBodyFile) {
        bodySha256 = createHash('sha256').update(body).digest('hex');
        requestBodyFile = await writePrivateRequestBody(body);
      }
      else bodyBase64 = body.toString('base64');
    } finally { body.fill(0); }
    const requestBodyBytes = requestBodyFile?.bodyBytes ?? 0;
    const packet = {
      url: url.href,
      method,
      ...(streamBodyFile ? { operationId: operation.id } : {}),
      headers,
      cookies,
      allowedCookieNames: cookieNames,
      credentialHeaders,
      allowedCredentialHeaderNames: Object.keys(credentialHeaders),
      setCookieNames: operation.response.setCookieNames ?? [],
      bodyBase64,
      ...(requestBodyFile ? { bodyFilePath: requestBodyFile.filePath, bodyBytes: requestBodyBytes } : {}),
      ...(requestBodyFile ? { bodySha256 } : {}),
      timeoutMs,
      maxResponseBytes: operation.response.maxBytes,
      acceptedStatuses: operation.response.statuses,
    };
    let encoded;
    try {
      encoded = Buffer.from(JSON.stringify(packet), 'utf8');
    } finally {
      // The packet is only a one-request handoff. Keep the serialized buffer
      // alive for the child, but release every additional JS copy immediately.
      for (const cookie of cookies) cookie.value = '';
      cookies.length = 0;
      for (const name of Object.keys(credentialHeaders)) credentialHeaders[name] = '';
      for (const name of credentialHeaderNames) requestHeaders.delete(name);
      requestHeaders.delete('cookie');
      packet.url = '';
      packet.cookies = [];
      packet.credentialHeaders = {};
      packet.bodyBase64 = '';
      packet.bodyFilePath = '';
      packet.bodySha256 = '';
    }
    if (encoded.length > MAX_PACKET_BYTES) {
      encoded.fill(0);
      if (requestBodyFile) await rm(requestBodyFile.directory, { recursive: true, force: true }).catch(() => {});
      throw fail('AUTH_CHROME_REQUEST_TOO_LARGE');
    }
    if (init.signal?.aborted) {
      encoded.fill(0);
      if (requestBodyFile) await rm(requestBodyFile.directory, { recursive: true, force: true }).catch(() => {});
      throw fail('AUTH_CHROME_ABORTED');
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      let child;
      let timer;
      let stdout = Buffer.alloc(0);
      const maxStdout = Math.ceil((operation.response.maxBytes + MAX_ERROR_BYTES) * 4 / 3) + 8192;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', abort);
        void (async () => {
          if (error && child && child.exitCode === null && child.signalCode === null) {
            const closed = new Promise(resolveClose => child.once('close', resolveClose));
            try { child.kill('SIGTERM'); } catch { /* The bounded helper may already have exited. */ }
            await closed;
          }
          encoded.fill(0);
          stdout.fill(0);
          let cleanup = 'not_used';
          if (requestBodyFile) {
            try {
              await rm(requestBodyFile.directory, { recursive: true, force: true });
              cleanup = 'removed';
            } catch { cleanup = 'remove_failed'; }
          }
          if (response && requestBodyFile) {
            Object.defineProperty(response, 'transportEvidence', {
              value: Object.freeze({ ...response.transportEvidence, privateTempBodyCleanup: cleanup }),
              configurable: false,
            });
          }
          if (error) reject(error);
          else resolve(response);
        })().catch(() => {
          if (error) reject(error);
          else resolve(response);
        });
      };
      const abort = () => finish(fail('AUTH_CHROME_ABORTED'));
      try {
        child = spawn(pythonExecutable, [HELPER_PATH], {
          stdio: ['pipe', 'pipe', 'ignore'], shell: false, env: childEnvironment(),
        });
      } catch (error) {
        finish(failWith('AUTH_CHROME_HELPER_FAILED', error));
        return;
      }
      timer = setTimeout(() => finish(fail('AUTH_CHROME_TIMEOUT')), timeoutMs + 5_000);
      timer.unref?.();
      init.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
        if (stdout.length > maxStdout) finish(fail('AUTH_CHROME_HELPER_FAILED'));
      });
      child.on('error', error => finish(failWith('AUTH_CHROME_HELPER_FAILED', error)));
      child.on('close', code => {
        if (code !== 0) {
          try {
            const value = JSON.parse(stdout.toString('utf8'));
            if (HELPER_ERRORS.has(value?.error)) {
              finish(fail(value.error, {
                ...(typeof value.stage === 'string' && /^[a-z_]{1,40}$/.test(value.stage) ? { stage: value.stage } : {}),
                ...(typeof value.errorClass === 'string' && /^[A-Za-z][A-Za-z0-9]{0,50}$/.test(value.errorClass) ? { errorClass: value.errorClass } : {}),
              }));
              return;
            }
          } catch { /* Preserve one sanitized error for malformed helper output. */ }
          finish(fail('AUTH_CHROME_HELPER_FAILED'));
          return;
        }
        try { finish(null, decodeResponse(stdout, operation)); }
        catch (error) { finish(error?.code ? error : fail('AUTH_CHROME_HELPER_FAILED')); }
      });
      child.stdin.on('error', () => finish(fail('AUTH_CHROME_HELPER_FAILED')));
      child.stdin.end(encoded);
    });
  };

  authenticatedFetchers.add(fetchImpl);
  return fetchImpl;
}
