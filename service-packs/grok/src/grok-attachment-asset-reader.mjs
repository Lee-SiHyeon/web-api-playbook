import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.mjs';

const DEFAULT_SCRIPT = fileURLToPath(new URL('../scripts/grok_attachment_asset_download.py', import.meta.url));
const SAFE_HEADERS = new Set([
  'accept', 'accept-language', 'origin', 'referer', 'user-agent',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
]);
const MAX_PACKET_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
export const MAX_ATTACHMENT_ASSET_BYTES = 256 * 1024 * 1024;
const MIME_ALLOWLIST = new Set([
  'text/plain', 'application/octet-stream', 'application/pdf', 'application/rtf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateInput({ assetUrl, assetOrigin, mimeType, expectedBytes, expectedSha256,
  assetCookieScope, ssoCookieValue, headers, ownerIdentityDigest, outputRoot, outputName, maxBytes }) {
  if (typeof assetOrigin !== 'string' || assetOrigin !== 'https://assets.grok.com'
    || typeof ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ownerIdentityDigest)
    || !Number.isInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_ATTACHMENT_ASSET_BYTES
    || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || !MIME_ALLOWLIST.has(String(mimeType).toLowerCase())
    || !Number.isInteger(maxBytes) || maxBytes < expectedBytes || maxBytes > MAX_ATTACHMENT_ASSET_BYTES) {
    throw fail('ATTACHMENT_ASSET_READER_INPUT_INVALID');
  }
  let url;
  try { url = new URL(assetUrl); } catch { throw fail('ATTACHMENT_ASSET_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== assetOrigin || url.username || url.password || url.hash
    || !url.pathname.startsWith('/users/') || url.pathname.split('/').some(part => part === '.' || part === '..')
    || [...url.searchParams.keys()].some(key => key !== 'cache')
    || url.searchParams.get('cache') !== '1') throw fail('ATTACHMENT_ASSET_URL_SCOPE');
  if (!exactKeys(assetCookieScope, ['domain', 'httpOnly', 'path', 'secure'])
    || typeof assetCookieScope.domain !== 'string' || typeof assetCookieScope.path !== 'string'
    || !assetCookieScope.path.startsWith('/') || !url.pathname.startsWith(assetCookieScope.path)
    || !['.grok.com', '.assets.grok.com', 'assets.grok.com'].includes(assetCookieScope.domain.toLowerCase())
    || assetCookieScope.secure !== true || typeof assetCookieScope.httpOnly !== 'boolean'
    || typeof ssoCookieValue !== 'string' || !ssoCookieValue || ssoCookieValue.length > 8192
    || /[\r\n\0;]/.test(ssoCookieValue)) throw fail('ATTACHMENT_ASSET_COOKIE_SCOPE_INVALID');
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)
    || Object.keys(headers).some(name => !SAFE_HEADERS.has(name.toLowerCase())
      || typeof headers[name] !== 'string' || !headers[name].trim() || headers[name].length > 2048
      || /[\r\n\0]/.test(headers[name]))) throw fail('ATTACHMENT_ASSET_HEADERS_INVALID');
  const referer = headers.referer ?? headers.Referer;
  const userAgent = headers['user-agent'] ?? headers['User-Agent'];
  const platform = headers['sec-ch-ua-platform'] ?? headers['Sec-CH-UA-Platform'];
  if (typeof referer !== 'string' || new URL(referer).origin !== 'https://grok.com'
    || typeof userAgent !== 'string' || !/Chrome\//.test(userAgent)
    || typeof platform !== 'string' || platform !== '"Linux"') throw fail('ATTACHMENT_ASSET_HEADERS_INVALID');
  if (outputRoot === undefined || typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)
    || typeof outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(outputName)) {
    throw fail('ATTACHMENT_ASSET_OUTPUT_TARGET_INVALID');
  }
  return {
    assetUrl: url.href, assetOrigin, mimeType: String(mimeType).toLowerCase(), expectedBytes,
    expectedSha256, assetCookieScope: { ...assetCookieScope }, ssoCookieValue,
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    ownerIdentityDigest, outputRoot: path.resolve(outputRoot), outputName, maxBytes,
  };
}

function validateResult(value, expected) {
  const allowed = new Set(['status', 'mimeType', 'bodyBytes', 'sha256', 'bytesMatch', 'artifactPath',
    'headersSubmittedNames', 'cookieNamesUsed', 'failure', 'errorClass', 'source']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.has(key))
    || !Number.isInteger(value.status) || value.status < 0 || value.status > 599
    || !Number.isInteger(value.bodyBytes) || value.bodyBytes < 0 || value.bodyBytes > expected.maxBytes
    || (value.mimeType !== null && typeof value.mimeType !== 'string')
    || (value.sha256 !== null && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)))
    || typeof value.bytesMatch !== 'boolean' || value.source !== 'curl_cffi-0.16.3-chrome150'
    || !Array.isArray(value.headersSubmittedNames) || value.headersSubmittedNames.some(name => !SAFE_HEADERS.has(name))
    || !Array.isArray(value.cookieNamesUsed) || value.cookieNamesUsed.some(name => name !== 'sso')) {
    throw fail('ATTACHMENT_ASSET_READER_RESPONSE_INVALID');
  }
  const verified = value.status === 200 && value.mimeType === expected.mimeType
    && value.bodyBytes === expected.expectedBytes && value.sha256 === expected.expectedSha256 && value.bytesMatch === true
    && typeof value.artifactPath === 'string'
    && path.resolve(value.artifactPath) === path.join(expected.outputRoot, expected.outputName)
    && value.cookieNamesUsed.length === 1 && value.cookieNamesUsed[0] === 'sso';
  return {
    status: value.status, mimeType: value.mimeType, bodyBytes: value.bodyBytes,
    sha256: value.sha256, bytesMatch: value.bytesMatch, artifactPath: value.artifactPath ?? null,
    headersSubmittedNames: value.headersSubmittedNames, cookieNamesUsed: value.cookieNamesUsed,
    source: value.source, verified,
    ...(typeof value.failure === 'string' ? { failure: value.failure } : {}),
    ...(typeof value.errorClass === 'string' && /^[A-Za-z][A-Za-z0-9]{0,50}$/.test(value.errorClass)
      ? { errorClass: value.errorClass } : {}),
  };
}

export function createGrokCffiAttachmentAssetReader({
  pythonExecutable = process.env.GROK_CHROME_PYTHON ?? 'python3', scriptPath = DEFAULT_SCRIPT, timeoutMs = 90_000,
} = {}) {
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim() || /[\r\n\0]/.test(pythonExecutable)
    || typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath) || /[\r\n\0]/.test(scriptPath)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10 * 60_000) {
    throw fail('ATTACHMENT_ASSET_READER_OPTIONS_INVALID');
  }
  return async function readGrokAttachmentAsset(input = {}) {
    const packet = validateInput(input);
    const encoded = Buffer.from(JSON.stringify(packet), 'utf8');
    packet.ssoCookieValue = '';
    if (encoded.length > MAX_PACKET_BYTES) { encoded.fill(0); throw fail('ATTACHMENT_ASSET_READER_INPUT_SIZE_LIMIT'); }
    const environment = {};
    for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
      if (typeof process.env[name] === 'string') environment[name] = process.env[name];
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(pythonExecutable, [scriptPath], { stdio: ['pipe', 'pipe', 'ignore'], env: environment });
      const chunks = [];
      let size = 0; let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); encoded.fill(0);
        const stdout = Buffer.concat(chunks, size);
        try {
          if (result.code !== 0 || result.error || size > MAX_OUTPUT_BYTES) throw fail('ATTACHMENT_ASSET_READER_PROCESS_FAILED');
          let value;
          try { value = JSON.parse(stdout.toString('utf8')); } catch { throw fail('ATTACHMENT_ASSET_READER_RESPONSE_INVALID'); }
          resolve(validateResult(value, input));
        } catch (error) {
          if (error?.code === 'ATTACHMENT_ASSET_READER_PROCESS_FAILED') resolve({
            status: 0, mimeType: null, bodyBytes: 0, sha256: null, bytesMatch: false, artifactPath: null,
            headersSubmittedNames: Object.keys(input.headers ?? {}).map(name => name.toLowerCase()).filter(name => SAFE_HEADERS.has(name)),
            cookieNamesUsed: [], source: 'curl_cffi-0.16.3-chrome150', verified: false,
            failure: 'ATTACHMENT_ASSET_READER_PROCESS_FAILED',
          });
          else reject(error);
        } finally { stdout.fill(0); for (const chunk of chunks) chunk.fill(0); }
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: 1 }); }, timeoutMs);
      timer.unref?.();
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) { child.kill('SIGKILL'); return; }
        chunks.push(Buffer.from(chunk));
      });
      child.on('error', error => finish({ code: 1, error }));
      child.on('close', code => finish({ code }));
      child.stdin.on('error', () => {});
      child.stdin.end(encoded, () => encoded.fill(0));
    });
  };
}
