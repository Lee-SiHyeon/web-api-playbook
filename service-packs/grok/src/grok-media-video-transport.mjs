import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.mjs';
import { validateGrokAssetRequestContext } from './grok-media-asset-reader.mjs';

const HELPER = fileURLToPath(new URL('../scripts/grok_media_video_submit.py', import.meta.url));
const CREATE_URL = 'https://grok.com/rest/app-chat/conversations/new';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 8 * 1024;
const ALLOWED_HEADERS = new Set([
  'accept', 'content-type', 'origin', 'referer', 'user-agent',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'x-statsig-id', 'x-xai-request-id',
]);
const ENV_NAMES = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'];
const SAFE_RESPONSE_HEADER_NAMES = new Set(['content-type', 'content-length', 'cf-mitigated', 'retry-after']);
const SAFE_ERROR_STAGES = new Set(['validation', 'dependency', 'session_setup', 'request', 'response_headers', 'response_body']);

function envForChild() {
  const result = {};
  for (const name of ENV_NAMES) if (typeof process.env[name] === 'string') result[name] = process.env[name];
  return result;
}

function objectOrFail(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(code);
  return value;
}

function validateVideoBody(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length < 1 || Buffer.byteLength(bodyText) > MAX_BODY_BYTES) {
    throw fail('MEDIA_VIDEO_BODY_INVALID');
  }
  let body;
  try { body = JSON.parse(bodyText); } catch { throw fail('MEDIA_VIDEO_BODY_INVALID'); }
  const expectedKeys = [
    'enableImageStreaming', 'enableSideBySide', 'kind', 'mediaGenInput', 'message', 'modelName', 'responseMetadata', 'sendFinalMetadata',
  ];
  if (!objectOrFail(body, 'MEDIA_VIDEO_BODY_INVALID')
    || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...expectedKeys].sort())) throw fail('MEDIA_VIDEO_BODY_SCHEMA_INVALID');
  const mediaInput = body.mediaGenInput;
  const modes = mediaInput && typeof mediaInput === 'object' && !Array.isArray(mediaInput) ? Object.keys(mediaInput) : [];
  const textMode = modes.length === 1 && modes[0] === 'textToVideo';
  const imageMode = modes.length === 1 && modes[0] === 'imageToVideo';
  const input = textMode ? mediaInput.textToVideo : imageMode ? mediaInput.imageToVideo : null;
  const inputKeys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort() : [];
  const textKeys = ['aspectRatio', 'duration', 'prompt', 'resolutionName', 'skipAudio'];
  const imageKeys = ['aspectRatio', 'duration', 'inputAssets', 'mode', 'prompt', 'resolutionName', 'skipAudio'];
  const imageShape = imageMode && (inputKeys.join(',') === [...imageKeys].sort().join(',')
    || inputKeys.length === imageKeys.length + 1 && inputKeys.includes('useFirstFrame')
      && inputKeys.filter(key => key !== 'useFirstFrame').sort().join(',') === [...imageKeys].sort().join(','));
  if (body.modelName !== 'imagine-video-gen' || body.kind !== 'CONVERSATION_KIND_IMAGINE'
    || body.enableImageStreaming !== true || body.enableSideBySide !== true || body.sendFinalMetadata !== true
    || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4_000
    || (!textMode && !imageShape) || !input
    || textMode && inputKeys.join(',') !== [...textKeys].sort().join(',')
    || typeof input.prompt !== 'string' || body.message !== `${input.prompt.trim()} --mode=custom`
    || input.aspectRatio !== '2:3' || input.duration !== 6
    || input.resolutionName !== '480p' || input.skipAudio !== true
    || imageMode && (input.mode !== 'custom' || !Array.isArray(input.inputAssets) || input.inputAssets.length !== 1
      || typeof input.inputAssets[0] !== 'string' || !input.inputAssets[0] || input.inputAssets[0].length > 256
      || Object.hasOwn(input, 'useFirstFrame') && typeof input.useFirstFrame !== 'boolean')) {
    throw fail('MEDIA_VIDEO_BODY_PROFILE_INVALID');
  }
  const meta = body.responseMetadata;
  if (!meta || !Array.isArray(meta.experiments) || meta.experiments.length !== 0
    || !meta.modelConfigOverride?.modelMap || Object.keys(meta).sort().join(',') !== 'experiments,modelConfigOverride'
    || Object.keys(meta.modelConfigOverride).sort().join(',') !== 'modelMap'
    || Object.keys(meta.modelConfigOverride.modelMap).length !== 0) throw fail('MEDIA_VIDEO_BODY_PROFILE_INVALID');
}

function ssoFromHeader(headers, context) {
  const cookieHeader = [...headers.entries()].find(([name]) => name.toLowerCase() === 'cookie')?.[1];
  if (typeof cookieHeader !== 'string' || !cookieHeader) throw fail('MEDIA_VIDEO_OWNER_COOKIE_MISSING');
  const pairs = cookieHeader.split(';').map(value => value.trim());
  if (pairs.length !== 1 || !pairs[0].startsWith('sso=')) throw fail('MEDIA_VIDEO_COOKIE_SCOPE_INVALID');
  const value = pairs[0].slice(4);
  if (!value || value !== context.cookies[0].value) throw fail('MEDIA_VIDEO_OWNER_COOKIE_MISMATCH');
  return value;
}

function helperTransportEvidence({ stage, requestStarted, requestBodyBytes, requestHeaderNames, errorClass = null }) {
  const safeClass = typeof errorClass === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(errorClass) ? errorClass : null;
  return Object.freeze({
    stage,
    requestStarted,
    responseReceived: false,
    httpStatus: null,
    contentType: null,
    httpVersion: 'other',
    responseBytesRead: 0,
    requestBodyBytes,
    cfMitigated: false,
    errorClass: safeClass,
    requestHeaderNames: Object.freeze([...requestHeaderNames].sort()),
    responseHeaderNames: Object.freeze([]),
    cookieNamesUsed: Object.freeze(requestStarted ? ['sso'] : []),
    source: 'curl_cffi-0.16.3-chrome150',
  });
}

function decodeHelperResponse(stdout, { requestBodyBytes = 0 } = {}) {
  let packet;
  try { packet = JSON.parse(stdout.toString('utf8')); } catch { throw fail('MEDIA_VIDEO_HELPER_RESPONSE_INVALID'); }
  if (packet && typeof packet === 'object' && !Array.isArray(packet) && typeof packet.error === 'string') {
    const evidence = packet.transportEvidence;
    const partialResources = packet.partialResources;
    const errorKeys = ['error', 'transportEvidence', 'partialResources', 'responseBodySha256'];
    const partialResourceKeys = ['requestIds', 'conversationIds', 'responseIds', 'assetIds', 'itemIds', 'postIds'];
    const evidenceKeys = ['stage', 'requestStarted', 'responseReceived', 'httpStatus', 'contentType', 'httpVersion',
      'responseBytesRead', 'requestBodyBytes', 'cfMitigated', 'errorClass', 'requestHeaderNames',
      'responseHeaderNames', 'cookieNamesUsed', 'source'];
    if (JSON.stringify(Object.keys(packet).sort()) !== JSON.stringify(errorKeys.sort())
      || !/^[A-Z][A-Z0-9_]{0,63}$/.test(packet.error)
      || packet.responseBodySha256 !== null && (typeof packet.responseBodySha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(packet.responseBodySha256))
      || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(evidenceKeys.sort())
      || !SAFE_ERROR_STAGES.has(evidence.stage)
      || typeof evidence.requestStarted !== 'boolean' || typeof evidence.responseReceived !== 'boolean'
      || evidence.httpStatus !== null && (!Number.isInteger(evidence.httpStatus) || evidence.httpStatus < 100 || evidence.httpStatus > 599)
      || evidence.contentType !== null && (typeof evidence.contentType !== 'string' || evidence.contentType.length > 128
        || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(evidence.contentType))
      || !['http/1.0', 'http/1.1', 'h2', 'h3', 'other'].includes(evidence.httpVersion)
      || !Number.isInteger(evidence.responseBytesRead) || evidence.responseBytesRead < 0 || evidence.responseBytesRead > MAX_RESPONSE_BYTES
      || !Number.isInteger(evidence.requestBodyBytes) || evidence.requestBodyBytes < 0 || evidence.requestBodyBytes > MAX_BODY_BYTES
      || typeof evidence.cfMitigated !== 'boolean'
      || evidence.errorClass !== null && (typeof evidence.errorClass !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(evidence.errorClass))
      || !Array.isArray(evidence.requestHeaderNames) || evidence.requestHeaderNames.some(name => !ALLOWED_HEADERS.has(name))
      || !Array.isArray(evidence.responseHeaderNames) || evidence.responseHeaderNames.some(name => !SAFE_RESPONSE_HEADER_NAMES.has(name))
      || !Array.isArray(evidence.cookieNamesUsed) || evidence.cookieNamesUsed.some(name => name !== 'sso')
      || evidence.cookieNamesUsed.length > 1 || evidence.source !== 'curl_cffi-0.16.3-chrome150'
      || evidence.responseReceived && !evidence.requestStarted
      || !evidence.requestStarted && (evidence.responseReceived || evidence.httpStatus !== null
        || evidence.contentType !== null || evidence.responseBytesRead !== 0 || evidence.cookieNamesUsed.length !== 0
        || evidence.responseHeaderNames.length !== 0)
      || !evidence.responseReceived && (evidence.httpStatus !== null || evidence.contentType !== null
        || evidence.responseBytesRead !== 0 || evidence.responseHeaderNames.length !== 0)
      || !partialResources || typeof partialResources !== 'object' || Array.isArray(partialResources)
      || JSON.stringify(Object.keys(partialResources).sort()) !== JSON.stringify([...partialResourceKeys].sort())
      || partialResourceKeys.some(key => !Array.isArray(partialResources[key]) || partialResources[key].length > 100
        || partialResources[key].some(id => typeof id !== 'string' || id.length < 1 || id.length > 256
          || !/^[A-Za-z0-9._:-]+$/.test(id)))) {
      throw fail('MEDIA_VIDEO_HELPER_RESPONSE_INVALID');
    }
    const transportEvidence = Object.freeze({
      stage: evidence.stage,
      requestStarted: evidence.requestStarted,
      responseReceived: evidence.responseReceived,
      httpStatus: evidence.httpStatus,
      contentType: evidence.contentType,
      httpVersion: evidence.httpVersion,
      responseBytesRead: evidence.responseBytesRead,
      requestBodyBytes: evidence.requestBodyBytes,
      cfMitigated: evidence.cfMitigated,
      errorClass: evidence.errorClass,
      requestHeaderNames: Object.freeze([...evidence.requestHeaderNames]),
      responseHeaderNames: Object.freeze([...evidence.responseHeaderNames]),
      cookieNamesUsed: Object.freeze([...evidence.cookieNamesUsed]),
      source: evidence.source,
    });
    const inMemoryResources = Object.fromEntries(partialResourceKeys.map(key => [key, [...new Set(partialResources[key])]]));
    throw fail('MEDIA_VIDEO_CFFI_REQUEST_FAILED', {
      helperErrorCode: packet.error,
      transportEvidence,
      partialResources: inMemoryResources,
      responseBodySha256: packet.responseBodySha256,
    });
  }
  const allowed = ['status', 'contentType', 'httpVersion', 'bodyBase64', 'bodyBytes', 'responseBodySha256',
    'contentLength', 'retryAfterSeconds', 'cfMitigated', 'requestHeaderNames', 'responseHeaderNames', 'cookieNamesUsed', 'source'];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
    || JSON.stringify(Object.keys(packet).sort()) !== JSON.stringify([...allowed].sort())
    || !Number.isInteger(packet.status) || packet.status < 200 || packet.status > 599
    || typeof packet.contentType !== 'string' || packet.contentType.length > 256
    || !['http/1.0', 'http/1.1', 'h2', 'h3', 'other'].includes(packet.httpVersion)
    || typeof packet.bodyBase64 !== 'string' || packet.bodyBase64.length > Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 16
    || !Number.isInteger(packet.bodyBytes) || packet.bodyBytes < 0 || packet.bodyBytes > MAX_RESPONSE_BYTES
    || typeof packet.responseBodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packet.responseBodySha256)
    || packet.contentLength !== null && (!Number.isInteger(packet.contentLength) || packet.contentLength < 0 || packet.contentLength > MAX_RESPONSE_BYTES)
    || packet.retryAfterSeconds !== null && (!Number.isInteger(packet.retryAfterSeconds) || packet.retryAfterSeconds < 0 || packet.retryAfterSeconds > 86_400)
    || typeof packet.cfMitigated !== 'boolean' || packet.source !== 'curl_cffi-0.16.3-chrome150'
    || !Array.isArray(packet.requestHeaderNames) || packet.requestHeaderNames.some(name => !ALLOWED_HEADERS.has(name))
    || !Array.isArray(packet.responseHeaderNames) || packet.responseHeaderNames.some(name => !SAFE_RESPONSE_HEADER_NAMES.has(name))
    || JSON.stringify(packet.cookieNamesUsed) !== JSON.stringify(['sso'])) throw fail('MEDIA_VIDEO_HELPER_RESPONSE_INVALID');
  const body = Buffer.from(packet.bodyBase64, 'base64');
  if (body.length > MAX_RESPONSE_BYTES || body.length !== packet.bodyBytes || body.toString('base64') !== packet.bodyBase64
    || createHash('sha256').update(body).digest('hex') !== packet.responseBodySha256) {
    body.fill(0);
    throw fail('MEDIA_VIDEO_HELPER_RESPONSE_INVALID');
  }
  const headers = new Headers();
  if (packet.contentType) headers.set('content-type', packet.contentType);
  if (packet.contentLength !== null) headers.set('content-length', String(packet.contentLength));
  if (packet.retryAfterSeconds !== null) headers.set('retry-after', String(packet.retryAfterSeconds));
  if (packet.cfMitigated) headers.set('cf-mitigated', 'challenge');
  const response = new Response([204, 205, 304].includes(packet.status) ? null : body, { status: packet.status, headers });
  Object.defineProperty(response, 'transportEvidence', {
    value: Object.freeze({
      source: packet.source,
      httpVersion: packet.httpVersion,
      responseHeaderNames: Object.freeze([...packet.responseHeaderNames]),
      requestBodyBytes,
      requestHeaderNames: packet.requestHeaderNames,
      cookieNamesUsed: packet.cookieNamesUsed,
      responseBodySha256: packet.responseBodySha256,
      responseBytesRead: packet.bodyBytes,
      contentLength: packet.contentLength,
      retryAfterSeconds: packet.retryAfterSeconds,
      cfMitigated: packet.cfMitigated,
    }),
  });
  return response;
}

export function createGrokCffiVideoFetch({
  pythonExecutable = process.env.GROK_CHROME_PYTHON ?? 'python3',
  scriptPath = HELPER,
  assetRequestContext,
  expectedOwnerIdentityDigest,
  timeoutMs = 60_000,
} = {}) {
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim() || /[\r\n\0]/.test(pythonExecutable)
    || typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath) || /[\r\n\0]/.test(scriptPath)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw fail('MEDIA_VIDEO_TRANSPORT_OPTIONS_INVALID');
  }
  const context = objectOrFail(assetRequestContext, 'MEDIA_ASSET_REQUEST_CONTEXT_INVALID');
  validateGrokAssetRequestContext('https://assets.grok.com/users/owner/generated/asset.jpg?cache=1', context, expectedOwnerIdentityDigest);

  return async (input, init = {}) => {
    let url;
    try { url = new URL(String(input)); } catch { throw fail('MEDIA_VIDEO_REQUEST_URL_INVALID'); }
    const method = String(init.method ?? 'GET').toUpperCase();
    if (url.href !== CREATE_URL || method !== 'POST' || init.credentials !== 'omit' || init.redirect !== 'manual') {
      throw fail('MEDIA_VIDEO_REQUEST_SCOPE_INVALID');
    }
    const bodyText = typeof init.body === 'string' ? init.body : '';
    validateVideoBody(bodyText);
    const requestHeaders = new Headers(init.headers ?? {});
    const contentType = requestHeaders.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const referer = requestHeaders.get('referer');
    let refererUrl;
    try { refererUrl = new URL(referer); } catch { throw fail('MEDIA_VIDEO_HEADERS_INVALID'); }
    const imaginePath = refererUrl.pathname === '/imagine';
    const assetPostPath = /^\/imagine\/post\/[A-Za-z0-9._~-]{1,256}$/.test(refererUrl.pathname);
    const allowedQuery = [...refererUrl.searchParams.keys()].every(key => ['scope', 'conversation'].includes(key))
      && (!refererUrl.searchParams.has('scope') || refererUrl.searchParams.get('scope') === 'asset')
      && (!refererUrl.searchParams.has('conversation')
        || /^[A-Za-z0-9._~-]{1,128}$/.test(refererUrl.searchParams.get('conversation')))
      && [...refererUrl.searchParams.keys()].length === new Set(refererUrl.searchParams.keys()).size;
    if (contentType !== 'application/json' || requestHeaders.get('origin') !== 'https://grok.com'
      || refererUrl.origin !== 'https://grok.com' || refererUrl.username || refererUrl.password || refererUrl.hash
      || !(imaginePath || assetPostPath) || !allowedQuery) throw fail('MEDIA_VIDEO_HEADERS_INVALID');
    const requiredSdk = ['x-statsig-id', 'x-xai-request-id'];
    const allowedInputHeaders = new Set([...ALLOWED_HEADERS, 'cookie']);
    if (requiredSdk.some(name => !requestHeaders.has(name))
      || [...requestHeaders.keys()].some(name => !allowedInputHeaders.has(name.toLowerCase()))) throw fail('MEDIA_VIDEO_HEADERS_INVALID');
    ssoFromHeader(requestHeaders, context);
    const ordinary = {};
    for (const [name, value] of requestHeaders.entries()) {
      if (name.toLowerCase() === 'cookie') continue;
      if (!ALLOWED_HEADERS.has(name.toLowerCase())) throw fail('MEDIA_VIDEO_HEADERS_INVALID');
      ordinary[name.toLowerCase()] = value;
    }
    const cookies = [{ ...context.cookies[0] }];
    const packet = {
      url: CREATE_URL,
      method: 'POST',
      headers: ordinary,
      cookies,
      observedCookieNames: ['sso'],
      bodyText,
      timeoutMs,
    };
    const bytes = Buffer.from(JSON.stringify(packet), 'utf8');
    const requestBodyBytes = Buffer.byteLength(bodyText, 'utf8');
    const requestHeaderNames = Object.keys(ordinary);
    cookies[0].value = '';
    if (bytes.length > 128 * 1024) {
      bytes.fill(0);
      throw fail('MEDIA_VIDEO_REQUEST_TOO_LARGE');
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(pythonExecutable, [scriptPath], {
        stdio: ['pipe', 'pipe', 'ignore'], shell: false,
        env: Object.fromEntries(ENV_NAMES.filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]])),
      });
      const chunks = [];
      let length = 0;
      let settled = false;
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', abort);
        bytes.fill(0);
        const stdout = Buffer.concat(chunks, length);
        try {
          if (error) {
            if (['MEDIA_VIDEO_TRANSPORT_ABORTED', 'MEDIA_VIDEO_TRANSPORT_TIMEOUT'].includes(error?.code)
              && error?.details?.transportEvidence) throw error;
            throw fail('MEDIA_VIDEO_HELPER_FAILED', { transportEvidence: helperTransportEvidence({
              stage: 'session_setup', requestStarted: false, requestBodyBytes, requestHeaderNames, errorClass: error?.name,
            }) });
          }
          if (length > MAX_OUTPUT_BYTES) throw fail('MEDIA_VIDEO_HELPER_OUTPUT_LIMIT', { transportEvidence: helperTransportEvidence({
            stage: 'request', requestStarted: true, requestBodyBytes, requestHeaderNames,
          }) });
          const response = decodeHelperResponse(stdout, { requestBodyBytes });
          if (code !== 0) throw fail('MEDIA_VIDEO_HELPER_EXIT_UNEXPECTED', { transportEvidence: helperTransportEvidence({
            stage: 'request', requestStarted: true, requestBodyBytes, requestHeaderNames,
          }) });
          resolve(response);
        } catch (failure) { reject(failure); }
        finally { stdout.fill(0); for (const chunk of chunks) chunk.fill(0); }
      };
      const abort = (requestMayHaveStarted = true) => {
        try { child.kill('SIGKILL'); } catch { /* The helper may already have exited. */ }
        finish(fail('MEDIA_VIDEO_TRANSPORT_ABORTED', { transportEvidence: helperTransportEvidence({
          stage: requestMayHaveStarted ? 'request' : 'validation',
          requestStarted: requestMayHaveStarted,
          requestBodyBytes,
          requestHeaderNames,
        }) }), 1);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(fail('MEDIA_VIDEO_TRANSPORT_TIMEOUT', { transportEvidence: helperTransportEvidence({
          stage: 'request', requestStarted: true, requestBodyBytes, requestHeaderNames,
        }) }), 1);
      }, timeoutMs + 5_000);
      timer.unref?.();
      if (init.signal?.aborted) {
        abort(false);
        return;
      }
      init.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_OUTPUT_BYTES) { child.kill('SIGKILL'); return; }
        chunks.push(Buffer.from(chunk));
      });
      child.on('error', error => finish(error, 1));
      child.on('close', code => finish(null, code));
      child.stdin.on('error', () => {});
      child.stdin.end(bytes, () => bytes.fill(0));
    });
  };
}
