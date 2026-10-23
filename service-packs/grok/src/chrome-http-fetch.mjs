import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.mjs';

const PUBLIC_MODELS_URL = 'https://grok.com/rest/models';
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_IPC_BYTES = 256 * 1024;
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
]);
const HELPER_ERRORS = new Set([
  'CHROME_HTTP_DEPENDENCY_MISSING',
  'CHROME_HTTP_DEPENDENCY_VERSION_MISMATCH',
  'CHROME_HTTP_RESPONSE_TOO_LARGE',
  'CHROME_HTTP_REQUEST_REJECTED',
  'CHROME_HTTP_FAILED',
]);
const chromeFetchers = new WeakSet();
const HELPER_PATH = fileURLToPath(new URL('../scripts/chrome-http-transport.py', import.meta.url));

function childEnvironment() {
  const environment = { PYTHONDONTWRITEBYTECODE: '1' };
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function requestPacket(input, init) {
  let url;
  try { url = new URL(String(input)); } catch { throw fail('CHROME_TRANSPORT_REQUEST_BLOCKED'); }
  if (url.href !== PUBLIC_MODELS_URL || String(init.method || 'GET').toUpperCase() !== 'POST'
      || init.credentials !== 'omit' || init.redirect !== 'manual') {
    throw fail('CHROME_TRANSPORT_REQUEST_BLOCKED');
  }

  const headers = new Headers(init.headers || {});
  if (headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || [...headers.keys()].some(name => name.toLowerCase() !== 'content-type')) {
    throw fail('CHROME_TRANSPORT_REQUEST_BLOCKED');
  }

  let body;
  try {
    body = Buffer.from(typeof init.body === 'string' ? init.body : '');
    const value = JSON.parse(body.toString('utf8'));
    if (body.length > MAX_REQUEST_BYTES || JSON.stringify(value) !== '{"locale":"en"}') {
      throw new Error('body mismatch');
    }
  } catch {
    throw fail('CHROME_TRANSPORT_REQUEST_BLOCKED');
  }

  return {
    url: PUBLIC_MODELS_URL,
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    bodyBase64: body.toString('base64'),
    timeoutMs: 20_000,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  };
}

function decodeHelperResponse(stdout) {
  let value;
  try { value = JSON.parse(stdout.toString('utf8')); } catch { throw fail('CHROME_TRANSPORT_HELPER_FAILED'); }
  if (HELPER_ERRORS.has(value?.error)) throw fail(value.error);
  if (!Number.isInteger(value?.status) || value.status < 200 || value.status > 599
      || typeof value.contentType !== 'string' || value.contentType.length > 256
      || !['http/1.0', 'http/1.1', 'h2', 'other'].includes(value.httpVersion)
      || typeof value.bodyBase64 !== 'string' || value.bodyBase64.length > Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 8) {
    throw fail('CHROME_TRANSPORT_HELPER_FAILED');
  }
  const body = Buffer.from(value.bodyBase64, 'base64');
  if (body.length > MAX_RESPONSE_BYTES || body.toString('base64') !== value.bodyBase64) {
    throw fail('CHROME_TRANSPORT_HELPER_FAILED');
  }
  const noBodyStatus = [204, 205, 304].includes(value.status);
  const response = new Response(noBodyStatus ? null : body, {
    status: value.status,
    headers: value.contentType ? { 'content-type': value.contentType } : undefined,
  });
  Object.defineProperty(response, 'transportEvidence', {
    value: Object.freeze({ httpVersion: value.httpVersion }),
  });
  return response;
}

export function isChromeCompatibleFetch(fetchImpl) {
  return typeof fetchImpl === 'function' && chromeFetchers.has(fetchImpl);
}

export function createChromeCompatibleFetch({ pythonExecutable, timeoutMs = 25_000 } = {}) {
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim()
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw fail('CHROME_TRANSPORT_OPTIONS_INVALID');
  }

  const fetchImpl = async (input, init = {}) => {
    const packet = requestPacket(input, init);
    const encoded = Buffer.from(JSON.stringify(packet), 'utf8');
    if (encoded.length > MAX_REQUEST_BYTES) throw fail('CHROME_TRANSPORT_REQUEST_BLOCKED');
    if (init.signal?.aborted) throw fail('CHROME_TRANSPORT_ABORTED');

    return await new Promise((resolve, reject) => {
      let settled = false;
      let child;
      let timer;
      let stdout = Buffer.alloc(0);
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', abort);
        if (error) {
          if (child && child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGTERM'); } catch { /* The owned process may already be closing. */ }
          }
          reject(error);
        }
        else resolve(response);
      };
      const abort = () => {
        finish(fail('CHROME_TRANSPORT_ABORTED'));
      };
      try {
        child = spawn(pythonExecutable, [HELPER_PATH], {
          stdio: ['pipe', 'pipe', 'ignore'], shell: false, env: childEnvironment(),
        });
      } catch {
        finish(fail('CHROME_TRANSPORT_HELPER_FAILED'));
        return;
      }
      timer = setTimeout(() => {
        finish(fail('CHROME_TRANSPORT_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      init.signal?.addEventListener('abort', abort, { once: true });
      if (init.signal?.aborted) {
        abort();
        return;
      }
      child.stdout.on('data', chunk => {
        stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
        if (stdout.length > MAX_IPC_BYTES) {
          finish(fail('CHROME_TRANSPORT_HELPER_FAILED'));
        }
      });
      child.on('error', () => finish(fail('CHROME_TRANSPORT_HELPER_FAILED')));
      child.on('close', code => {
        if (code !== 0) {
          try {
            const value = JSON.parse(stdout.toString('utf8'));
            if (HELPER_ERRORS.has(value?.error)) {
              finish(fail(value.error));
              return;
            }
          } catch { /* Return the same sanitized error for malformed helper output. */ }
          finish(fail('CHROME_TRANSPORT_HELPER_FAILED'));
          return;
        }
        try { finish(null, decodeHelperResponse(stdout)); }
        catch (error) { finish(error?.code ? error : fail('CHROME_TRANSPORT_HELPER_FAILED')); }
      });
      child.stdin.on('error', () => finish(fail('CHROME_TRANSPORT_HELPER_FAILED')));
      child.stdin.end(encoded);
    });
  };

  chromeFetchers.add(fetchImpl);
  return fetchImpl;
}
