import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.mjs';

const DEFAULT_PYTHON_SCRIPT = fileURLToPath(new URL('../scripts/grok_media_asset_download.py', import.meta.url));
const MAX_PACKET_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const COOKIE_FIELDS = ['domain', 'httpOnly', 'name', 'path', 'secure', 'value'];
const CONTEXT_FIELDS = ['assetOrigin', 'cookies', 'headers', 'method', 'observedCookieNames', 'ownerIdentityDigest', 'pathClass', 'schemaVersion', 'source'];
const HEADER_NAMES = new Set([
  'accept', 'accept-language', 'origin', 'referer', 'user-agent',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
]);
const SAFE_ENV_NAMES = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
];

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateOutputTarget({ outputRoot, outputName }) {
  if (outputRoot === undefined && outputName === undefined) return null;
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || /[\r\n\0]/.test(outputRoot)
    || typeof outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(outputName)) {
    throw fail('MEDIA_ASSET_OUTPUT_TARGET_INVALID');
  }
  return { outputRoot: path.resolve(outputRoot), outputName };
}

function validateAssetRequestContext(assetUrl, context, expectedOwnerIdentityDigest) {
  if (!exactKeys(context, CONTEXT_FIELDS) || context.schemaVersion !== 1
    || context.source !== 'normal_ui_asset_request' || context.method !== 'GET'
    || context.assetOrigin !== 'https://assets.grok.com' || context.pathClass !== '/users/*/generated/*'
    || typeof expectedOwnerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedOwnerIdentityDigest)
    || context.ownerIdentityDigest !== expectedOwnerIdentityDigest
    || !Array.isArray(context.observedCookieNames) || context.observedCookieNames.length !== 1
    || context.observedCookieNames[0] !== 'sso' || !Array.isArray(context.cookies) || context.cookies.length !== 1
    || !exactKeys(context.cookies[0], COOKIE_FIELDS)) {
    throw fail('MEDIA_ASSET_REQUEST_CONTEXT_INVALID');
  }
  const url = new URL(assetUrl);
  if (url.protocol !== 'https:' || url.origin !== context.assetOrigin || url.username || url.password || url.hash
    || url.searchParams.get('cache') !== '1' || [...url.searchParams.keys()].some(key => key !== 'cache')
    || !url.pathname.startsWith('/users/') || !url.pathname.includes('/generated/')) {
    throw fail('MEDIA_ASSET_CONTEXT_URL_SCOPE');
  }
  const cookie = context.cookies[0];
  if (cookie.name !== 'sso' || typeof cookie.value !== 'string' || !cookie.value || cookie.value.length > 8_192
    || /[\r\n\0]/.test(cookie.value) || typeof cookie.domain !== 'string'
    || !['grok.com', 'assets.grok.com'].includes(cookie.domain.replace(/^\./, '').toLowerCase())
    || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || !url.pathname.startsWith(cookie.path)
    || cookie.secure !== true || typeof cookie.httpOnly !== 'boolean') {
    throw fail('MEDIA_ASSET_COOKIE_SCOPE_INVALID');
  }
  if (!context.headers || typeof context.headers !== 'object' || Array.isArray(context.headers)
    || Object.keys(context.headers).some(name => !HEADER_NAMES.has(name.toLowerCase()))
    || Object.values(context.headers).some(value => typeof value !== 'string' || !value.trim()
      || value.length > 2_048 || /[\r\n\0]/.test(value))) {
    throw fail('MEDIA_ASSET_HEADERS_INVALID');
  }
  const origin = Object.entries(context.headers).find(([name]) => name.toLowerCase() === 'origin')?.[1];
  if (origin !== undefined && origin !== 'https://grok.com') throw fail('MEDIA_ASSET_HEADERS_INVALID');
  const referer = Object.entries(context.headers).find(([name]) => name.toLowerCase() === 'referer')?.[1];
  if (typeof referer !== 'string') throw fail('MEDIA_ASSET_REFERER_REQUIRED');
  let refererUrl;
  try { refererUrl = new URL(referer); } catch { throw fail('MEDIA_ASSET_HEADERS_INVALID'); }
  const imagineReferer = refererUrl.pathname === '/' || refererUrl.pathname === '/imagine';
  const assetPostReferer = /^\/imagine\/post\/[A-Za-z0-9._~-]{1,256}$/.test(refererUrl.pathname);
  const refererKeys = [...refererUrl.searchParams.keys()];
  const safeRefererQuery = refererKeys.every(key => key === 'scope' || key === 'conversation')
    && new Set(refererKeys).size === refererKeys.length
    && (!refererUrl.searchParams.has('scope') || refererUrl.searchParams.get('scope') === 'asset')
    && (!refererUrl.searchParams.has('conversation')
      || /^[A-Za-z0-9._~-]{1,128}$/.test(refererUrl.searchParams.get('conversation')));
  if (refererUrl.origin !== 'https://grok.com' || refererUrl.username || refererUrl.password || refererUrl.hash
    || !(imagineReferer || assetPostReferer) || !safeRefererQuery) throw fail('MEDIA_ASSET_HEADERS_INVALID');
  if (!Object.keys(context.headers).some(name => name.toLowerCase() === 'user-agent')
    || !Object.keys(context.headers).some(name => name.toLowerCase() === 'sec-ch-ua-platform')) {
    throw fail('MEDIA_ASSET_HEADERS_INVALID');
  }
  return {
    cookies: [{ ...cookie }],
    headers: Object.fromEntries(Object.entries(context.headers).map(([name, value]) => [name.toLowerCase(), value])),
  };
}

function safeResult(value, { expectedMimeType, outputTarget }) {
  const allowed = new Set([
    'assetHttpStatus', 'bodyBytes', 'magicVerified', 'mimeType', 'sha256', 'source',
    'cookiesUsed', 'cookieNamesUsed', 'headersSubmittedNames', 'artifactPath', 'failure', 'errorClass',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.has(key))
    || !Number.isInteger(value.assetHttpStatus) || value.assetHttpStatus < 0 || value.assetHttpStatus > 599
    || !Number.isInteger(value.bodyBytes) || value.bodyBytes < 0 || value.bodyBytes > MAX_ASSET_BYTES
    || typeof value.magicVerified !== 'boolean' || typeof value.cookiesUsed !== 'boolean'
    || value.mimeType !== null && typeof value.mimeType !== 'string'
    || value.sha256 !== null && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256))
    || value.source !== 'curl_cffi-0.16.3-chrome150'
    || !Array.isArray(value.cookieNamesUsed) || value.cookieNamesUsed.some(name => name !== 'sso')
    || !Array.isArray(value.headersSubmittedNames) || value.headersSubmittedNames.some(name => !HEADER_NAMES.has(name))) {
    throw fail('MEDIA_ASSET_READER_RESPONSE_INVALID');
  }
  if (value.cookiesUsed !== (value.cookieNamesUsed.length === 1 && value.cookieNamesUsed[0] === 'sso')) {
    throw fail('MEDIA_ASSET_READER_RESPONSE_INVALID');
  }
  const actualMime = String(value.mimeType ?? '').toLowerCase();
  const expected = String(expectedMimeType).toLowerCase();
  const verified = [200, 206].includes(value.assetHttpStatus) && actualMime === expected
    && value.bodyBytes > 0 && value.magicVerified === true && typeof value.sha256 === 'string';
  let artifactPath = null;
  if (value.artifactPath !== null && value.artifactPath !== undefined) {
    if (!outputTarget || typeof value.artifactPath !== 'string'
      || path.resolve(value.artifactPath) !== path.join(outputTarget.outputRoot, outputTarget.outputName)) {
      throw fail('MEDIA_ASSET_READER_ARTIFACT_PATH_INVALID');
    }
    artifactPath = value.artifactPath;
  }
  if (outputTarget && verified && artifactPath === null) throw fail('MEDIA_ASSET_READER_ARTIFACT_MISSING');
  return {
    status: value.assetHttpStatus,
    mimeType: value.mimeType,
    bodyBytes: value.bodyBytes,
    magicVerified: value.magicVerified,
    sha256: value.sha256,
    source: value.source,
    cookiesUsed: value.cookiesUsed,
    cookieNamesUsed: value.cookieNamesUsed,
    headersSubmittedNames: value.headersSubmittedNames,
    artifactPath,
    verified,
    ...(typeof value.failure === 'string' ? { failure: value.failure } : {}),
    ...(typeof value.errorClass === 'string' && /^[A-Za-z][A-Za-z0-9]{0,50}$/.test(value.errorClass)
      ? { errorClass: value.errorClass } : {}),
  };
}

export function createGrokCffiAssetReader({
  pythonExecutable = process.env.GROK_CHROME_PYTHON ?? 'python3',
  scriptPath = DEFAULT_PYTHON_SCRIPT,
  timeoutMs = 90_000,
} = {}) {
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim() || /[\r\n\0]/.test(pythonExecutable)
    || typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath) || /[\r\n\0]/.test(scriptPath)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw fail('MEDIA_ASSET_READER_OPTIONS_INVALID');
  }

  return async function readGrokAsset({
    assetUrl,
    mimeType,
    assetRequestContext,
    expectedOwnerIdentityDigest,
    outputRoot,
    outputName,
    maxBytes = MAX_ASSET_BYTES,
    timeoutMs: requestTimeoutMs = timeoutMs,
  } = {}) {
    if (typeof assetUrl !== 'string' || typeof mimeType !== 'string'
      || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'].includes(mimeType.toLowerCase())) {
      throw fail('MEDIA_ASSET_READER_INPUT_INVALID');
    }
    const bound = validateAssetRequestContext(assetUrl, assetRequestContext, expectedOwnerIdentityDigest);
    const outputTarget = validateOutputTarget({ outputRoot, outputName });
    if (!Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > MAX_ASSET_BYTES
      || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > timeoutMs) {
      throw fail('MEDIA_ASSET_READER_OPTIONS_INVALID');
    }
    const packet = {
      assetUrl,
      mimeType: mimeType.toLowerCase(),
      cookies: bound.cookies,
      observedCookieNames: assetRequestContext.observedCookieNames,
      headers: bound.headers,
      maxBytes,
      requestTimeoutMs,
      ...(outputTarget ? { outputRoot: outputTarget.outputRoot, outputName: outputTarget.outputName } : {}),
    };
    const input = Buffer.from(JSON.stringify(packet), 'utf8');
    if (input.length > MAX_PACKET_BYTES) {
      input.fill(0);
      throw fail('MEDIA_ASSET_READER_INPUT_SIZE_LIMIT');
    }
    for (const item of packet.cookies) item.value = '';
    const environment = {};
    for (const name of SAFE_ENV_NAMES) {
      if (typeof process.env[name] === 'string') environment[name] = process.env[name];
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(pythonExecutable, [scriptPath], { stdio: ['pipe', 'pipe', 'ignore'], env: environment });
      const chunks = [];
      let total = 0;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.fill(0);
        const stdout = Buffer.concat(chunks, total);
        try {
          if (result.code !== 0 || result.error || total > MAX_OUTPUT_BYTES) throw fail('MEDIA_ASSET_READER_PROCESS_FAILED');
          let value;
          try { value = JSON.parse(stdout.toString('utf8')); } catch { throw fail('MEDIA_ASSET_READER_RESPONSE_INVALID'); }
          resolve(safeResult(value, { expectedMimeType: mimeType, outputTarget }));
        } catch (error) {
          if (error?.code === 'MEDIA_ASSET_READER_PROCESS_FAILED') resolve({ status: 0, mimeType: null, bodyBytes: 0,
            magicVerified: false, sha256: null, source: 'curl_cffi-0.16.3-chrome150', cookiesUsed: false,
            cookieNamesUsed: [], headersSubmittedNames: Object.keys(bound.headers), artifactPath: null, verified: false,
            failure: error.code });
          else reject(error);
        } finally {
          stdout.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: 1 });
      }, Math.min(timeoutMs, requestTimeoutMs));
      timer.unref?.();
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      child.on('error', error => finish({ code: 1, error }));
      child.on('close', code => finish({ code }));
      child.stdin.on('error', () => {});
      child.stdin.end(input, () => input.fill(0));
    });
  };
}

export const validateGrokAssetRequestContext = validateAssetRequestContext;
