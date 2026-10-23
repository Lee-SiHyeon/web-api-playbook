import { createHash } from 'node:crypto';
import { consumeMutationDispatch, createMutationJournal, digestBody, markMutationReconciled, mutationDispatchConsumed, reserveMutationDispatch, settleMutationDispatch } from './journal.mjs';
import { GeminiClientError } from './errors.mjs';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const FORBIDDEN_COOKIE_NAME = /(?:clearance|challenge|captcha|cf[_-]|datadome)/i;
const FORBIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length']);
const uploadQueryTickets = new WeakMap();
const ALLOWED_UPLOAD_HEADERS = new Set([
  'accept', 'content-type', 'origin', 'referer', 'user-agent', 'push-id', 'x-client-pctx', 'x-tenant-id',
  'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-form-factors', 'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-model', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-wow64', 'x-goog-upload-protocol', 'x-goog-upload-command',
  'x-goog-upload-header-content-length',
]);
const ALLOWED_CONTINUATION_HEADERS = new Set([
  ...ALLOWED_UPLOAD_HEADERS,
  'cookie', 'x-goog-upload-offset', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'accept-encoding', 'accept-language', 'cache-control', 'content-language', 'pragma', 'priority',
  'x-goog-upload-header-content-type', 'x-requested-with',
]);
const FORBIDDEN_CONTINUATION_HEADERS = new Set(['authorization', 'proxy-authorization', 'host', 'content-length']);
const SOURCE_REQUIRED_CONTINUATION_HEADERS = Object.freeze([
  'push-id', 'x-client-pctx', 'x-tenant-id',
]);
const BROWSER_MANAGED_CONTINUATION_HEADERS = Object.freeze([
  'accept', 'origin', 'referer', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
  'sec-ch-ua-form-factors', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile',
  'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
]);

function mimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function urlRef(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); }
  catch { throw new GeminiClientError('ATTACHMENT_UPLOAD_URL_INVALID', 'The captured Gemini upload URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_URL_INVALID', 'The captured upload URL must use HTTPS without credentials or a fragment.');
  }
  let pathFamily = url.pathname.split('/').map((part) => (
    part.length > 40 || /^[0-9a-f-]{16,}$/i.test(part) ? '{id}' : part
  )).join('/');
  if (url.pathname.startsWith('/upload/') && url.pathname !== '/upload/') pathFamily = '/upload/{session}';
  return Object.freeze({
    origin: url.origin,
    pathFamily,
    queryKeyNames: Object.freeze([...new Set(url.searchParams.keys())].sort()),
  });
}

/** Compare a browser-normalized resumable URL with the exact server-issued URL. */
export function sameAttachmentUploadSessionUrl(actualValue, issuedValue) {
  const parseIdentity = (value) => {
    if (typeof value !== 'string' || !value || value.length > 8192) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.search) return null;
    const pairs = [...url.searchParams.entries()];
    if (!pairs.length || new Set(pairs.map(([name]) => name)).size !== pairs.length) return null;
    pairs.sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName)
      || leftValue.localeCompare(rightValue));
    return { origin: url.origin, pathname: url.pathname, pairs };
  };
  const actual = parseIdentity(actualValue);
  const issued = parseIdentity(issuedValue);
  return Boolean(actual && issued && actual.origin === issued.origin && actual.pathname === issued.pathname
    && actual.pairs.length === issued.pairs.length
    && actual.pairs.every(([name, value], index) => name === issued.pairs[index][0] && value === issued.pairs[index][1]));
}

function nameFieldFromMetadataBody(body, contract) {
  if (!Buffer.isBuffer(body) || body.length > 4096) return false;
  const text = body.toString('utf8');
  return text === `${contract.metadataBodyPrefix}${contract.fileNameFieldValue ?? ''}`;
}

function cookieDomainMatches(cookieDomain, host) {
  const domain = String(cookieDomain || '').toLowerCase().replace(/^\./, '');
  const target = String(host || '').toLowerCase();
  return target === domain || target.endsWith(`.${domain}`);
}

function cookiePathMatches(cookiePath, targetPath) {
  if (targetPath === cookiePath) return true;
  const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
  return targetPath.startsWith(prefix);
}

function validateContract(contract) {
  if (!contract || contract.version !== 1 || contract.capability !== 'attachment_upload'
      || contract.source?.origin !== 'https://push.clients6.google.com'
      || contract.source?.method !== 'POST' || contract.source?.pathFamily !== '/upload/'
      || contract.source?.contentType !== 'application/x-www-form-urlencoded'
      || contract.source?.startProtocol !== 'resumable' || contract.source?.startCommand !== 'start'
      || contract.source?.fileLengthHeader !== 'x-goog-upload-header-content-length'
      || typeof contract.source?.metadataBodyPrefix !== 'string'
      || !Array.isArray(contract.source?.headerNames)
      || !Array.isArray(contract.source?.cookieNames)
      || !Array.isArray(contract.source?.cookieScopes)
      || !Array.isArray(contract.source?.queryKeyNames)
      || !contract.resumable || contract.resumable.uploadUrlHeader !== 'x-goog-upload-url'
      || contract.resumable.startSuccessStatus !== 200 || contract.resumable.uploadMethod !== 'POST'
      || contract.resumable.commandHeader !== 'x-goog-upload-command'
      || contract.resumable.finalizeCommand !== 'upload, finalize'
      || contract.resumable.queryMethod !== 'POST' || contract.resumable.queryCommand !== 'query'
      || contract.resumable.uploadStatusHeader !== 'x-goog-upload-status'
      || contract.resumable.sizeReceivedHeader !== 'x-goog-upload-size-received'
      || typeof contract.resumable.cancelSupported !== 'boolean'
      || typeof contract.resumable.resumeSupported !== 'boolean'
      || contract.resumable.offsetHeader !== 'x-goog-upload-offset'
      || !Array.isArray(contract.resumable.uploadUrlOrigins)
      || !Array.isArray(contract.resumable.uploadUrlPathPrefixes)
      || contract.source.headerNames.some((name) => typeof name !== 'string' || name !== name.toLowerCase()
        || (name !== 'cookie' && !ALLOWED_UPLOAD_HEADERS.has(name)))
      || contract.source.cookieNames.some((name) => typeof name !== 'string' || FORBIDDEN_COOKIE_NAME.test(name))) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTRACT_NOT_CAPTURED', 'An observed Gemini attachment-upload contract is required.');
  }
  const nativeContinuation = contract.resumable.nativeContinuation;
  const headerValuePolicy = nativeContinuation?.headerValuePolicy;
  if (nativeContinuation !== undefined
      && (!nativeContinuation || nativeContinuation.method !== 'POST'
        || nativeContinuation.commandHeader !== contract.resumable.commandHeader
        || nativeContinuation.commandValue !== contract.resumable.finalizeCommand
        || nativeContinuation.offsetHeader !== contract.resumable.offsetHeader
        || nativeContinuation.initialOffset !== 0
        || nativeContinuation.bodySemantics !== 'selected_file_bytes'
        || (nativeContinuation.headerValueSource !== undefined
          && nativeContinuation.headerValueSource !== 'start_request_custom_header_map')
        || !Array.isArray(nativeContinuation.headerNames)
        || !Array.isArray(nativeContinuation.cookieNames)
        || (headerValuePolicy !== undefined && (!headerValuePolicy
          || headerValuePolicy.sourceFunction !== 'oF.Lsc' || headerValuePolicy.headerMapExpression !== 'a.Ja'
          || headerValuePolicy.transportFunction !== 'Hsc.send'
          || headerValuePolicy.optionalDirectValuePolicy !== 'current_start_request_custom_header_map_value'
          || headerValuePolicy.optionalNativeValuePolicy !== 'allow_captured_browser_variation'
          || headerValuePolicy.sourceEffectiveHeaderValueSource !== 'xhr_transport_default_content_type'
          || !Array.isArray(headerValuePolicy.requiredStartMapHeaderNames)
          || !Array.isArray(headerValuePolicy.sourceEffectiveHeaderNames)
          || !headerValuePolicy.sourceEffectiveHeaderValues
          || typeof headerValuePolicy.sourceEffectiveHeaderValues !== 'object'
          || !Array.isArray(headerValuePolicy.protocolManagedHeaderNames)
          || !Array.isArray(headerValuePolicy.optionalBrowserManagedHeaderNames))))) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTRACT_NOT_CAPTURED', 'The captured native upload continuation is malformed.');
  }
  if (nativeContinuation?.headerValuePolicy !== undefined) {
    const policy = nativeContinuation.headerValuePolicy;
    const sortedNames = (values) => [...values].sort();
    if (!policy || policy.sourceBundleSha256 !== '3137eb01bfe212ddc5b7df423acd9c9633537f528a0cd13a07c25e075495e7aa'
        || policy.sourceFunction !== 'oF.Lsc' || policy.headerMapExpression !== 'a.Ja'
        || policy.optionalDirectValuePolicy !== 'current_start_request_custom_header_map_value'
        || policy.optionalNativeValuePolicy !== 'allow_captured_browser_variation'
        || !Array.isArray(policy.requiredStartMapHeaderNames)
        || !Array.isArray(policy.optionalBrowserManagedHeaderNames)
        || !Array.isArray(policy.protocolManagedHeaderNames)
        || !Array.isArray(policy.sourceEffectiveHeaderNames)
        || !policy.sourceEffectiveHeaderValues || typeof policy.sourceEffectiveHeaderValues !== 'object'
        || JSON.stringify(sortedNames(policy.sourceEffectiveHeaderNames)) !== JSON.stringify(['content-type'])
        || JSON.stringify(Object.keys(policy.sourceEffectiveHeaderValues).sort()) !== JSON.stringify(['content-type'])
        || policy.sourceEffectiveHeaderValues['content-type'] !== 'application/x-www-form-urlencoded'
        || nativeContinuation.contentType !== 'application/x-www-form-urlencoded'
        || JSON.stringify(sortedNames(policy.requiredStartMapHeaderNames ?? []))
          !== JSON.stringify(sortedNames(SOURCE_REQUIRED_CONTINUATION_HEADERS))
        || JSON.stringify(sortedNames(policy.optionalBrowserManagedHeaderNames ?? []))
          !== JSON.stringify(sortedNames(BROWSER_MANAGED_CONTINUATION_HEADERS))
        || JSON.stringify(sortedNames(policy.protocolManagedHeaderNames ?? []))
          !== JSON.stringify(sortedNames([nativeContinuation.commandHeader, nativeContinuation.offsetHeader]))) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTRACT_NOT_CAPTURED', 'The captured native continuation header-value policy is invalid.');
    }
  }
  if (new Set(contract.source.headerNames).size !== contract.source.headerNames.length
      || new Set(contract.source.cookieNames).size !== contract.source.cookieNames.length
      || new Set(contract.source.cookieScopes.map((scope) => scope.name)).size !== contract.source.cookieScopes.length
      || contract.source.cookieScopes.some((scope) => !scope || typeof scope.name !== 'string'
        || scope.domain !== '.google.com' || scope.path !== '/' || typeof scope.secure !== 'boolean')
      || JSON.stringify([...contract.source.cookieNames].sort())
        !== JSON.stringify(contract.source.cookieScopes.map((scope) => scope.name).sort())
      || !contract.source.headerNames.includes('cookie')) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTRACT_NOT_CAPTURED', 'The observed attachment-upload header or cookie scopes are malformed.');
  }
  for (const origin of contract.resumable.uploadUrlOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { parsed = null; }
    if (!parsed || parsed.origin !== origin || !origin.startsWith('https://')) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTRACT_NOT_CAPTURED', 'An upload session URL origin is invalid.');
    }
  }
  if (contract.resumable.uploadUrlPathPrefixes.some((prefix) => typeof prefix !== 'string'
      || !prefix.startsWith('/') || prefix.includes('..') || prefix.includes('?') || prefix.includes('#'))) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTRACT_NOT_CAPTURED', 'An upload session path prefix is invalid.');
  }
  if (contract.resumable.cancelSupported === true
      && (contract.resumable.cancelMethod !== 'POST' || contract.resumable.cancelCommand !== 'cancel'
        || !Array.isArray(contract.resumable.cancelEligibleStates)
        || !contract.resumable.cancelEligibleStates.includes('Upload')
        || !contract.resumable.cancelEligibleStates.includes('Query'))) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTRACT_NOT_CAPTURED', 'The captured cancellation state and request contract is malformed.');
  }
  return contract;
}

function validateScopedUploadCookieSnapshot(contract, uploadUrl, uploadCookies) {
  const target = uploadUrl instanceof URL ? uploadUrl : new URL(uploadUrl);
  const ref = urlRef(target);
  if (ref.origin !== contract.source.origin
      || !contract.resumable.uploadUrlOrigins.includes(ref.origin)
      || !contract.resumable.uploadUrlPathPrefixes.some((prefix) => ref.pathFamily.startsWith(prefix))) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SCOPE_INVALID', 'Fresh upload cookies may be bound only to an observed resumable endpoint.');
  }
  const expectedCookieNames = [...new Set(contract.source.cookieNames)].sort();
  if (!Array.isArray(uploadCookies)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SCOPE_INVALID', 'A fresh scoped upload-cookie snapshot is required.');
  }
  const scopeByName = new Map(contract.source.cookieScopes.map((scope) => [scope.name, scope]));
  const cookieByName = new Map();
  const scopeMismatchCookieNames = [];
  for (const cookie of uploadCookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
        || !expectedCookieNames.includes(cookie.name)) continue;
    const scope = scopeByName.get(cookie.name);
    if (!scope || cookie.domain !== scope.domain || cookie.path !== scope.path || cookie.secure !== scope.secure
        || !cookieDomainMatches(cookie.domain, target.hostname) || !cookiePathMatches(cookie.path, target.pathname)
        || (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= Date.now() / 1000)
        || cookie.value.includes(';') || /[\r\n\0]/.test(cookie.value) || FORBIDDEN_COOKIE_NAME.test(cookie.name)) {
      scopeMismatchCookieNames.push(cookie.name);
      continue;
    }
    if (cookieByName.has(cookie.name)) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_AMBIGUOUS', 'A fresh upload-cookie name has more than one scoped value.', {
        duplicateCookieNames: [cookie.name],
      });
    }
    cookieByName.set(cookie.name, Object.freeze({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure,
      ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
    }));
  }
  const actualCookieNames = [...cookieByName.keys()].sort();
  const missingCookieNames = expectedCookieNames.filter((name) => !cookieByName.has(name));
  if (missingCookieNames.length || scopeMismatchCookieNames.length) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SET_MISMATCH', 'The fresh same-owner cookie snapshot does not match the installed name and scope contract.', {
      expectedCookieCount: expectedCookieNames.length,
      actualCookieCount: actualCookieNames.length,
      expectedCookieNames,
      actualCookieNames,
      missingCookieNames,
      scopeMismatchCookieNames: [...new Set(scopeMismatchCookieNames)].sort(),
      expectedCookieScopes: contract.source.cookieScopes.map(({ name, domain, path, secure }) => ({ name, domain, path, secure })),
    });
  }
  return Object.freeze(expectedCookieNames.map((name) => cookieByName.get(name)));
}

/** Validate a fresh browser cookie snapshot for one observed resumable URL without exposing values. */
export function validateAttachmentUploadCookieSnapshot(contract, uploadUrl, uploadCookies) {
  validateContract(contract);
  return validateScopedUploadCookieSnapshot(contract, uploadUrl, uploadCookies);
}

function validateCapture(contract, capture, uploadCookies, file) {
  if (!capture || typeof capture !== 'object' || !Buffer.isBuffer(capture.body)
      || !file || typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name)
      || !Buffer.isBuffer(file.body) || file.body.length < 1 || file.body.length > MAX_FILE_BYTES
      || typeof file.mimeType !== 'string' || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(file.mimeType)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_INPUT_INVALID', 'The one-shot file and captured upload request are malformed.');
  }
  const sourceRef = urlRef(capture.url);
  const source = contract.source;
  if (capture.method !== source.method || sourceRef.origin !== source.origin || sourceRef.pathFamily !== source.pathFamily
      || JSON.stringify(sourceRef.queryKeyNames) !== JSON.stringify(source.queryKeyNames)
      || mimeType(capture.contentType) !== mimeType(source.contentType)
      || capture.body.toString('utf8') !== `${source.metadataBodyPrefix}${file.name}`) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CAPTURE_MISMATCH', 'The upload request does not match the current file and captured source contract.');
  }
  if (file.body.length !== capture.declaredFileBytes) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_FILE_LENGTH_MISMATCH', 'The captured upload length does not match the selected file.');
  }
  if (!capture.headers || typeof capture.headers !== 'object' || Array.isArray(capture.headers)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_HEADERS_INVALID', 'Captured upload request headers are malformed.');
  }
  const headerNames = [...new Set((capture.headerNames ?? []).map((name) => String(name).toLowerCase()))].sort();
  const expectedHeaderNames = [...new Set(source.headerNames)].sort();
  if (JSON.stringify(headerNames) !== JSON.stringify(expectedHeaderNames)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_HEADER_SET_MISMATCH', 'The exact native upload header-name set changed.');
  }
  const normalizedHeaders = {};
  for (const [rawName, value] of Object.entries(capture.headers)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_UPLOAD_HEADERS.has(name) || !source.headerNames.includes(name) || FORBIDDEN_HEADERS.has(name)
        || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_HEADER_UNOBSERVED', 'A captured upload header is outside the observed request contract.');
    }
    normalizedHeaders[name] = value;
  }
  if (normalizedHeaders['x-goog-upload-protocol'] !== source.startProtocol
      || normalizedHeaders['x-goog-upload-command'] !== source.startCommand
      || normalizedHeaders[source.fileLengthHeader] !== String(file.body.length)
      || mimeType(normalizedHeaders['content-type']) !== mimeType(source.contentType)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_HEADER_MISMATCH', 'The upload protocol headers do not match the observed start contract.');
  }
  if (JSON.stringify(Object.keys(normalizedHeaders).sort()) !== JSON.stringify(expectedHeaderNames.filter((name) => name !== 'cookie').sort())) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_HEADER_VALUE_SET_MISMATCH', 'A value for every observed non-cookie upload header is required.');
  }

  const expectedCookieNames = [...new Set(source.cookieNames)].sort();
  if (!Array.isArray(uploadCookies)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SCOPE_INVALID', 'Current scoped upload cookies are required.');
  }
  const scopeByName = new Map(source.cookieScopes.map((scope) => [scope.name, scope]));
  const cookieByName = new Map();
  const now = Date.now() / 1000;
  for (const cookie of uploadCookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
        || !expectedCookieNames.includes(cookie.name)) continue;
    const scope = scopeByName.get(cookie.name);
    if (!scope || cookie.domain !== scope.domain || cookie.path !== scope.path || cookie.secure !== scope.secure
        || !cookieDomainMatches(cookie.domain, sourceRef.origin.split('://')[1])
        || !cookiePathMatches(cookie.path, new URL(capture.url).pathname)
        || (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= now)
        || cookie.value.includes(';') || /[\r\n\0]/.test(cookie.value)
        || FORBIDDEN_COOKIE_NAME.test(cookie.name)) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SCOPE_INVALID', 'A current upload cookie does not match the observed ordinary Google scope.');
    }
    if (cookieByName.has(cookie.name)) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_AMBIGUOUS', 'A current upload cookie name has more than one scoped value.');
    }
    cookieByName.set(cookie.name, cookie);
  }
  if (expectedCookieNames.length !== cookieByName.size || expectedCookieNames.some((name) => !cookieByName.has(name))) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SET_MISMATCH', 'The current session does not provide every cookie observed on the native upload start request.');
  }
  return Object.freeze({
    sourceUrl: new URL(capture.url),
    sourceRef,
    headers: Object.freeze(normalizedHeaders),
    cookies: Object.freeze(expectedCookieNames.map((name) => cookieByName.get(name))),
    bodyDigest: digestBody(capture.body),
    fileDigest: createHash('sha256').update(file.body).digest('hex'),
  });
}

async function readBoundedBody(response, limit = MAX_RESPONSE_BYTES) {
  if (!response?.body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > limit) {
      if (typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
      throw new GeminiClientError('ATTACHMENT_UPLOAD_RESPONSE_TOO_LARGE', 'The upload response exceeded the bounded metadata limit.');
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, bytes);
}

async function callUploadServer(fetchImpl, url, { method = 'POST', headers = {}, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_TRANSPORT_FAILED', 'The direct attachment-upload request failed before a response was available.');
  } finally {
    clearTimeout(timeout);
  }
}

function parseMetadata(body, mime, expectedName, expectedBytes, expectedMime = 'text/plain') {
  if (mime !== 'application/json' || !body.length) {
    return Object.freeze({
      decoded: false,
      responseMime: mime,
      responseBytes: body.length,
      responseSha256: createHash('sha256').update(body).digest('hex'),
      fileNameMatched: false,
      fileSizeMatched: false,
      fileMimeMatched: false,
      fileIdPresent: false,
      fileIdLength: null,
    });
  }
  let value;
  try { value = JSON.parse(body.toString('utf8')); }
  catch {
    return Object.freeze({
      decoded: false,
      responseMime: mime,
      responseBytes: body.length,
      responseSha256: createHash('sha256').update(body).digest('hex'),
      fileNameMatched: false,
      fileSizeMatched: false,
      fileMimeMatched: false,
      fileIdPresent: false,
      fileIdLength: null,
    });
  }
  const pending = [value];
  let visited = 0;
  let fileNameMatched = false;
  let fileSizeMatched = false;
  let fileMimeMatched = false;
  let fileIdLength = null;
  while (pending.length && visited < 20_000) {
    const item = pending.pop();
    visited += 1;
    if (Array.isArray(item)) {
      pending.push(...item.slice(0, 2000));
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        const normalized = key.toLowerCase();
        if (['name', 'filename'].includes(normalized) && child === expectedName) fileNameMatched = true;
        if (['size', 'filesize', 'contentlength', 'bytes'].includes(normalized)
            && (child === expectedBytes || String(child) === String(expectedBytes))) fileSizeMatched = true;
        if (['mimetype', 'contenttype'].includes(normalized) && mimeType(child) === mimeType(expectedMime)) fileMimeMatched = true;
        if (['id', 'fileid', 'resourceid'].includes(normalized) && typeof child === 'string' && child.length > 0) {
          fileIdLength = child.length;
        }
        if (child && (typeof child === 'object')) pending.push(child);
      }
    }
  }
  return Object.freeze({
    decoded: true,
    responseMime: mime,
    responseBytes: body.length,
    responseSha256: createHash('sha256').update(body).digest('hex'),
    fileNameMatched,
    fileSizeMatched,
    fileMimeMatched,
    fileIdPresent: fileIdLength !== null,
    fileIdLength,
  });
}

function buildSdkAttachmentReference(file, uploadResponseBody, responseMime, sourceFileType = null) {
  const responsePayload = uploadResponseBody.toString('utf8');
  if (!responsePayload || /\0/.test(responsePayload)) return null;
  const reference = {
    filename: file.name,
    mimeType: file.mimeType,
    dh: responsePayload,
    fileSizeBytes: file.body.length,
  };
  if (Number.isSafeInteger(sourceFileType) && sourceFileType >= 0) reference.fileType = sourceFileType;
  return Object.freeze(reference);
}

function withInternalAttachmentReference(result, attachmentRef) {
  Object.defineProperty(result, 'internal', {
    value: Object.freeze({ attachmentRef }),
    enumerable: false,
  });
  return Object.freeze(result);
}

function responseHeaderNames(response) {
  return Object.freeze([...response.headers.keys()].map((name) => name.toLowerCase()).sort());
}

function numericHeader(response, name) {
  const value = response.headers.get(name);
  return value && /^\d{1,12}$/.test(value) ? Number(value) : null;
}

function requireUploadUrl(raw, contract) {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_SESSION_URL_MISSING', 'The upload start response did not return a bounded resumable URL.');
  }
  const ref = urlRef(raw);
  if (!contract.resumable.uploadUrlOrigins.includes(ref.origin)
      || !contract.resumable.uploadUrlPathPrefixes.some((prefix) => ref.pathFamily.startsWith(prefix))) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_SESSION_URL_UNOBSERVED', 'The returned upload URL is outside the installed resumable origin/path contract.');
  }
  return new URL(raw);
}

function cookiePairs(header) {
  const values = new Map();
  for (const item of String(header || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_.$-]{1,128}$/.test(name) || values.has(name)) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SCOPE_INVALID', 'The captured continuation cookie header is malformed.');
    }
    values.set(name, value);
  }
  return values;
}

function cookieMismatchDetails(contract, nativeCookies, uploadCookies, extra = {}) {
  const expectedNames = [...new Set(contract.resumable.nativeContinuation?.cookieNames
    ?? contract.source.cookieNames)].sort();
  const actualNames = [...nativeCookies.keys()].sort();
  const currentByName = new Map(uploadCookies.map((cookie) => [cookie.name, cookie]));
  const missingNames = expectedNames.filter((name) => !nativeCookies.has(name));
  const unexpectedNames = actualNames.filter((name) => !expectedNames.includes(name));
  const valueMismatchNames = actualNames.filter((name) => currentByName.has(name)
    && currentByName.get(name).value !== nativeCookies.get(name));
  const scopeByName = new Map(contract.source.cookieScopes.map((scope) => [scope.name, scope]));
  return {
    expectedCookieCount: expectedNames.length,
    actualCookieCount: actualNames.length,
    expectedCookieNames: expectedNames,
    actualCookieNames: actualNames,
    missingCookieNames: missingNames,
    unexpectedCookieNames: unexpectedNames,
    valueMismatchCookieNames: valueMismatchNames,
    expectedCookieScopes: expectedNames.map((name) => {
      const scope = scopeByName.get(name);
      return scope ? { name, domain: scope.domain, path: scope.path, secure: scope.secure } : { name };
    }),
    currentCookieScopes: actualNames.filter((name) => currentByName.has(name)).map((name) => {
      const cookie = currentByName.get(name);
      return { name, domain: cookie.domain, path: cookie.path, secure: cookie.secure };
    }),
    ...extra,
  };
}

function safeCookieDiagnostics(input) {
  if (!input || typeof input !== 'object') return {};
  const output = {};
  for (const key of ['expectedCookieCount', 'actualCookieCount']) {
    if (Number.isInteger(input[key])) output[key] = input[key];
  }
  for (const key of ['expectedCookieNames', 'actualCookieNames', 'missingCookieNames', 'unexpectedCookieNames', 'valueMismatchCookieNames']) {
    if (Array.isArray(input[key]) && input[key].every((name) => typeof name === 'string'
        && /^[A-Za-z0-9_.$-]{1,128}$/.test(name))) output[key] = [...input[key]];
  }
  for (const key of ['expectedCookieScopes', 'currentCookieScopes']) {
    if (Array.isArray(input[key]) && input[key].every((scope) => scope && typeof scope.name === 'string'
        && typeof scope.domain === 'string' && typeof scope.path === 'string' && typeof scope.secure === 'boolean')) {
      output[key] = input[key].map(({ name, domain, path, secure }) => ({ name, domain, path, secure }));
    }
  }
  if (typeof input.headerNamesMatched === 'boolean') output.headerNamesMatched = input.headerNamesMatched;
  return output;
}

function safeContinuationDiagnostics(input) {
  if (!input || typeof input !== 'object') return {};
  const output = {};
  for (const key of ['nativeHeaderNames', 'installedHeaderNames', 'continuationHeaderValueMismatchNames',
    'sourceEffectiveHeaderValueMismatchNames', 'sourceEffectiveHeaderNames']) {
    if (Array.isArray(input[key]) && input[key].every((name) => typeof name === 'string'
        && /^[a-z0-9-]{1,128}$/.test(name))) output[key] = [...input[key]];
  }
  for (const key of ['nativeTransferMimeType', 'expectedTransferMimeType', 'selectedFileMimeType']) {
    if (typeof input[key] === 'string') {
      const value = mimeType(input[key]);
      if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)) output[key] = value;
    }
  }
  if (input.sourceEffectiveHeaderValueSource === 'xhr_transport_default_content_type') {
    output.sourceEffectiveHeaderValueSource = input.sourceEffectiveHeaderValueSource;
  }
  if (input.sourceEffectiveHeaderName === 'content-type') output.sourceEffectiveHeaderName = input.sourceEffectiveHeaderName;
  for (const key of ['urlMatched', 'urlStringNormalized', 'methodMatched', 'bodyMatched']) {
    if (typeof input[key] === 'boolean') output[key] = input[key];
  }
  return output;
}

function validateNativeContinuation(contract, uploadUrl, capture, uploadCookies, file, { templateFromContract = false } = {}) {
  if (!capture || typeof capture !== 'object' || capture.method !== 'POST'
      || typeof capture.url !== 'string' || !sameAttachmentUploadSessionUrl(capture.url, uploadUrl.href)
      || !Array.isArray(capture.headerNames) || !capture.headers || typeof capture.headers !== 'object'
      || Array.isArray(capture.headers) || !Buffer.isBuffer(capture.body) || !capture.body.equals(file.body)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_MISMATCH', 'The native upload continuation is not bound to this server-issued session and selected file.');
  }
  const names = [...new Set(capture.headerNames.map((name) => String(name).toLowerCase()))].sort();
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(capture.headers)) {
    const name = rawName.toLowerCase();
    if (name === 'content-length') {
      if (typeof rawValue !== 'string' || rawValue !== String(capture.body.length)) {
        throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_MISMATCH', 'The native continuation length does not match the selected file.');
      }
      headers[name] = rawValue;
      continue;
    }
    if (name === 'host') {
      if (typeof rawValue !== 'string' || rawValue.toLowerCase() !== uploadUrl.host.toLowerCase()) {
        throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_MISMATCH', 'The native continuation host does not match its server-issued URL.');
      }
      headers[name] = rawValue;
      continue;
    }
    if (name === 'connection') {
      if (typeof rawValue !== 'string' || rawValue.toLowerCase() !== 'keep-alive') {
        throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_HEADER_UNOBSERVED', 'The native continuation connection header is unsupported.');
      }
      headers[name] = rawValue;
      continue;
    }
    if (FORBIDDEN_CONTINUATION_HEADERS.has(name) || !ALLOWED_CONTINUATION_HEADERS.has(name)
        || typeof rawValue !== 'string' || rawValue.length > 8192 || /[\r\n\0]/.test(rawValue)) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_HEADER_UNOBSERVED', 'A native upload continuation header is outside the observed transport allowlist.');
    }
    headers[name] = rawValue;
  }
  const representedNames = [...new Set([...Object.keys(headers), ...(names.includes('content-length') ? ['content-length'] : [])])].sort();
  if (JSON.stringify(names) !== JSON.stringify(representedNames)
      || headers[contract.resumable.commandHeader] !== contract.resumable.finalizeCommand
      || !/^\d{1,12}$/.test(headers[contract.resumable.offsetHeader] ?? '')
      || Number(headers[contract.resumable.offsetHeader]) !== 0) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_MISMATCH', 'The native continuation command, offset, or header set changed.');
  }
  if (contract.resumable.nativeContinuation) {
    const expected = contract.resumable.nativeContinuation;
    const nativeCookies = cookiePairs(headers.cookie);
    const nativeCookieNames = [...nativeCookies.keys()].sort();
    if (expected.method !== capture.method
        || (templateFromContract
          ? names.some((name) => !expected.headerNames.includes(name))
          : JSON.stringify([...expected.headerNames].sort()) !== JSON.stringify(names))
        || JSON.stringify([...expected.cookieNames].sort()) !== JSON.stringify(nativeCookieNames)) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_MISMATCH', 'The native continuation no longer matches its installed source contract.',
        cookieMismatchDetails(contract, nativeCookies, uploadCookies, { headerNamesMatched: JSON.stringify([...expected.headerNames].sort()) === JSON.stringify(names) }));
    }
    const policy = expected.headerValuePolicy;
    const sourceEffectiveHeaderValues = policy?.sourceEffectiveHeaderValues
      ?? (typeof expected.contentType === 'string' ? { 'content-type': expected.contentType } : {});
    const sourceEffectiveHeaderNames = policy?.sourceEffectiveHeaderNames
      ?? Object.keys(sourceEffectiveHeaderValues);
    for (const name of sourceEffectiveHeaderNames) {
      const expectedValue = sourceEffectiveHeaderValues[name];
      if (typeof expectedValue !== 'string' || mimeType(headers[name]) !== mimeType(expectedValue)) {
        throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_CONTENT_TYPE_MISMATCH', 'The native continuation transport header does not match its installed source value.', {
          ...(name === 'content-type' ? {
            selectedFileMimeType: mimeType(file.mimeType),
            nativeTransferMimeType: mimeType(headers[name]),
            expectedTransferMimeType: mimeType(expectedValue),
          } : {}),
          sourceEffectiveHeaderName: name,
          sourceEffectiveHeaderValueSource: policy?.sourceEffectiveHeaderValueSource,
        });
      }
    }
  }

  const outputHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (!['cookie', 'content-length', 'host', 'connection'].includes(name)) outputHeaders.set(name, value);
  }
  const cookieNames = contract.resumable.nativeContinuation?.cookieNames ?? [];
  if (headers.cookie !== undefined) {
    const nativeCookies = cookiePairs(headers.cookie);
    const expectedCookies = new Map(uploadCookies.map((cookie) => [cookie.name, cookie.value]));
    if ([...nativeCookies].some(([name, value]) => expectedCookies.get(name) !== value)
        || (cookieNames.length && [...nativeCookies.keys()].some((name) => !cookieNames.includes(name)))) {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SET_MISMATCH', 'The continuation cookies do not match the current scoped Google session.',
        cookieMismatchDetails(contract, nativeCookies, uploadCookies));
    }
    outputHeaders.set('cookie', [...nativeCookies.keys()].map((name) => `${name}=${expectedCookies.get(name)}`).join('; '));
  } else if (cookieNames.length > 0) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_COOKIE_SET_MISMATCH', 'The native continuation cookie set changed.',
      cookieMismatchDetails(contract, new Map(), uploadCookies));
  }
  return Object.freeze({
    headerNames: Object.freeze(names),
    headers: outputHeaders,
    cookieNames: Object.freeze(headers.cookie === undefined ? [] : [...cookiePairs(headers.cookie).keys()].sort()),
    bodyDigest: digestBody(capture.body),
  });
}

function buildInstalledNativeContinuation(contract, uploadUrl, uploadCookies, file, startHeaders) {
  const continuation = contract.resumable.nativeContinuation;
  if (!continuation) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_NOT_CAPTURED', 'The Gemini UI finalize request has not been captured for this upload contract.');
  }
  const headers = {
    [continuation.commandHeader]: continuation.commandValue,
    [continuation.offsetHeader]: String(continuation.initialOffset),
  };
  if (continuation.headerNames.includes('content-type')) {
    const sourceEffectiveHeaderValues = continuation.headerValuePolicy?.sourceEffectiveHeaderValues;
    const contentType = typeof sourceEffectiveHeaderValues?.['content-type'] === 'string'
      ? sourceEffectiveHeaderValues['content-type']
      : typeof continuation.contentType === 'string' ? continuation.contentType
        : continuation.headerValueSource === 'start_request_custom_header_map' ? startHeaders?.['content-type'] : null;
    if (typeof contentType !== 'string') {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_VALUE_UNAVAILABLE', 'The captured continuation content type is not installed in the direct upload contract.');
    }
    headers['content-type'] = contentType;
  }
  for (const name of continuation.headerNames) {
    if (headers[name] !== undefined || ['cookie', 'content-length', 'host', 'connection'].includes(name)) continue;
    if (name === 'content-type') continue;
    const value = startHeaders?.[name];
    if (typeof value !== 'string') {
      throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_VALUE_UNAVAILABLE', 'A captured continuation header does not have a source-bound current-session value.');
    }
    headers[name] = value;
  }
  if (continuation.headerNames.includes('content-length')
      && !Object.hasOwn(headers, 'content-length')) headers['content-length'] = String(file.body.length);
  if (continuation.cookieNames.length) {
    headers.cookie = uploadCookies.filter((cookie) => continuation.cookieNames.includes(cookie.name))
      .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }
  const headerNames = [...new Set([
    ...Object.keys(headers),
    ...(continuation.headerNames.includes('content-length') ? ['content-length'] : []),
  ])].sort();
  return {
    url: uploadUrl.href,
    method: continuation.method,
    headerNames,
    headers,
    body: file.body,
  };
}

function validateInstalledContinuationValueCoverage(contract, startHeaders, file) {
  const continuation = contract.resumable.nativeContinuation;
  if (!continuation) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_NOT_CAPTURED', 'The Gemini UI finalize request has not been captured for this upload contract.');
  }
  const requiredDirectValues = continuation.headerNames.filter((name) => ![
    'cookie', 'content-length', 'host', 'connection', continuation.commandHeader, continuation.offsetHeader,
  ].includes(name));
  for (const name of requiredDirectValues) {
    if (name === 'content-type') {
      if (typeof continuation.headerValuePolicy?.sourceEffectiveHeaderValues?.['content-type'] === 'string') continue;
      if (typeof continuation.contentType === 'string') continue;
      if (continuation.headerValueSource === 'start_request_custom_header_map'
          && typeof startHeaders['content-type'] === 'string') continue;
      throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_VALUE_UNAVAILABLE', 'The captured continuation content type is not installed in the direct upload contract.');
    }
    if (Object.hasOwn(startHeaders, name)) continue;
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_VALUE_UNAVAILABLE', 'The current start capture does not provide a source-bound value for every continuation header.');
  }
}

function assertInstalledContinuationMatchesNative(contract, uploadUrl, observedCapture, uploadCookies, file, startHeaders) {
  const observed = validateNativeContinuation(contract, uploadUrl, observedCapture, uploadCookies, file);
  const installedCapture = buildInstalledNativeContinuation(contract, uploadUrl, uploadCookies, file, startHeaders);
  const installed = validateNativeContinuation(contract, uploadUrl, installedCapture, uploadCookies, file, {
    templateFromContract: true,
  });
  const normalizeHeaders = (headers) => [...headers.entries()].map(([rawName, rawValue]) => {
    const name = rawName.toLowerCase();
    if (name !== 'cookie') return [name, rawValue];
    const cookies = [...cookiePairs(rawValue).entries()].sort(([left], [right]) => left.localeCompare(right));
    return [name, cookies.map(([cookieName, cookieValue]) => `${cookieName}=${cookieValue}`).join('; ')];
  }).sort(([left], [right]) => left.localeCompare(right));
  const observedHeaders = normalizeHeaders(observed.headers);
  const installedHeaders = normalizeHeaders(installed.headers);
  const observedMap = new Map(observedHeaders);
  const installedMap = new Map(installedHeaders);
  const valuePolicy = contract.resumable.nativeContinuation.headerValuePolicy;
  const requiredMapNames = valuePolicy?.requiredStartMapHeaderNames
    ?? SOURCE_REQUIRED_CONTINUATION_HEADERS;
  const sourceEffectiveHeaderNames = valuePolicy?.sourceEffectiveHeaderNames
    ?? Object.keys(valuePolicy?.sourceEffectiveHeaderValues ?? {});
  const sourceEffectiveHeaderValues = valuePolicy?.sourceEffectiveHeaderValues ?? {};
  const optionalBrowserNames = valuePolicy?.optionalBrowserManagedHeaderNames
    ?? BROWSER_MANAGED_CONTINUATION_HEADERS;
  const protocolNames = valuePolicy?.protocolManagedHeaderNames
    ?? [contract.resumable.commandHeader, contract.resumable.offsetHeader];
  const requiredHeaderValueMismatchNames = requiredMapNames.filter((name) => observedMap.get(name) !== installedMap.get(name));
  const sourceEffectiveHeaderValueMismatchNames = sourceEffectiveHeaderNames.filter((name) => {
    const expected = mimeType(sourceEffectiveHeaderValues[name]);
    return !expected || mimeType(observedMap.get(name)) !== expected || mimeType(installedMap.get(name)) !== expected;
  });
  const optionalBrowserHeaderVariationNames = optionalBrowserNames.filter((name) => observedMap.has(name)
    && installedMap.has(name) && observedMap.get(name) !== installedMap.get(name));
  const unknownHeaderValueMismatchNames = [...new Set([...observedMap.keys(), ...installedMap.keys()])]
    .filter((name) => !requiredMapNames.includes(name) && !sourceEffectiveHeaderNames.includes(name) && !optionalBrowserNames.includes(name)
      && !protocolNames.includes(name) && name !== 'cookie' && observedMap.get(name) !== installedMap.get(name))
    .sort();
  const urlMatched = sameAttachmentUploadSessionUrl(observedCapture.url, installedCapture.url);
  const urlStringNormalized = urlMatched && observedCapture.url !== installedCapture.url;
  const methodMatched = observedCapture.method === installedCapture.method;
  const headerNamesMatched = JSON.stringify(observed.headerNames) === JSON.stringify(installed.headerNames);
  const bodyMatched = observed.bodyDigest === installed.bodyDigest;
  if (!urlMatched || !methodMatched || !headerNamesMatched || !bodyMatched
      || requiredHeaderValueMismatchNames.length || sourceEffectiveHeaderValueMismatchNames.length
      || unknownHeaderValueMismatchNames.length) {
    if (installedCapture.body !== file.body) installedCapture.body.fill(0);
    const observedHeaderMap = new Map(observedHeaders);
    const installedHeaderMap = new Map(installedHeaders);
    const allHeaderNames = [...new Set([...observedHeaderMap.keys(), ...installedHeaderMap.keys()])].sort();
    const continuationHeaderValueMismatchNames = allHeaderNames.filter((name) => observedHeaderMap.get(name) !== installedHeaderMap.get(name));
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_TEMPLATE_MISMATCH', 'The source-installed default continuation does not match the captured native request.', {
      nativeHeaderNames: observed.headerNames,
      installedHeaderNames: installed.headerNames,
      continuationHeaderValueMismatchNames,
      requiredHeaderValueMismatchNames,
      sourceEffectiveHeaderValueMismatchNames,
      sourceEffectiveHeaderNames,
      nativeTransferMimeType: mimeType(observedMap.get('content-type')),
      expectedTransferMimeType: mimeType(sourceEffectiveHeaderValues['content-type']),
      selectedFileMimeType: mimeType(file.mimeType),
      unknownHeaderValueMismatchNames,
      optionalBrowserHeaderVariationNames,
      sourceRequiredHeaderNames: [...requiredMapNames],
      optionalBrowserHeaderNames: [...optionalBrowserNames],
      urlMatched,
      urlStringNormalized,
      methodMatched,
      headerNamesMatched,
      bodyMatched,
    });
  }
  return Object.freeze({
    capture: installedCapture,
    summary: Object.freeze({
      sourceRequiredHeadersMatched: true,
      protocolHeadersMatched: true,
      sourceEffectiveHeadersMatched: true,
      optionalBrowserHeaderVariationNames: Object.freeze(optionalBrowserHeaderVariationNames),
      sourceRequiredHeaderNames: Object.freeze([...requiredMapNames]),
      sourceEffectiveHeaderNames: Object.freeze([...sourceEffectiveHeaderNames]),
      sourceEffectiveHeaderValues: Object.freeze({ ...sourceEffectiveHeaderValues }),
      sourceEffectiveHeaderValueSource: valuePolicy?.sourceEffectiveHeaderValueSource ?? 'source_effective_native_transport_header',
      serverIssuedUrlIdentityMatched: true,
      serverIssuedUrlStringNormalized: urlStringNormalized,
      optionalBrowserHeaderNames: Object.freeze([...optionalBrowserNames]),
      defaultTemplateValuesCameFrom: valuePolicy?.optionalDirectValuePolicy
        ?? 'current_start_request_custom_header_map_value',
      ...(typeof valuePolicy?.sourceBundleSha256 === 'string' ? { sourceBundleSha256: valuePolicy.sourceBundleSha256 } : {}),
      ...(typeof valuePolicy?.sourceFunction === 'string' ? { sourceFunction: valuePolicy.sourceFunction } : {}),
    }),
  });
}

/** Submit one observed Gemini upload-start request, then transfer the exact selected file once. */
export async function uploadAttachmentOnce({
  contract,
  capture,
  uploadCookies,
  file,
  actor,
  callerIntent,
  journalRoot,
  fetchImpl = globalThis.fetch,
  timeoutMs = 45_000,
  continuationCaptureProvider,
  useInstalledContinuationTemplate = false,
  uploadCookieRefreshProvider,
  uploadResponseHandler,
} = {}) {
  validateContract(contract);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_OPTIONS_INVALID', 'The direct upload options are invalid.');
  }
  if (continuationCaptureProvider !== undefined && typeof continuationCaptureProvider !== 'function') {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_OPTIONS_INVALID', 'The native continuation provider must be a function.');
  }
  if (uploadResponseHandler !== undefined && typeof uploadResponseHandler !== 'function') {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_OPTIONS_INVALID', 'The upload response handler must be a function.');
  }
  if (uploadCookieRefreshProvider !== undefined && typeof uploadCookieRefreshProvider !== 'function') {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_OPTIONS_INVALID', 'The fresh upload-cookie provider must be a function.');
  }
  if (typeof useInstalledContinuationTemplate !== 'boolean'
      || (useInstalledContinuationTemplate && !continuationCaptureProvider)) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_OPTIONS_INVALID', 'The installed continuation template requires a live native capture for comparison.');
  }
  if (!continuationCaptureProvider && !contract.resumable.nativeContinuation) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CONTINUATION_NOT_CAPTURED', 'The Gemini UI finalize request has not been captured for this upload contract.');
  }
  const inspected = validateCapture(contract, capture, uploadCookies, file);
  if (!continuationCaptureProvider) validateInstalledContinuationValueCoverage(contract, inspected.headers, file);
  const startJob = await createMutationJournal({
    capability: 'attachment_upload', body: capture.body, actor, callerIntent, root: journalRoot,
  });
  const startTicket = await reserveMutationDispatch(startJob);
  let activeTicket = startTicket;
  let httpRequestCount = 0;
  let startDispatchConsumed = false;
  let transferDispatchConsumed = false;
  let transferTicket = null;
  let transferJob = null;
  let startSettled = false;
  let transferSettled = false;
  let continuationCapture = null;
  let observedContinuationCapture = null;
  let continuationTemplateSummary = null;
  let currentUploadCookies = inspected.cookies;
  let activeUploadUrl = null;
  let querySummary = null;
  let queryPerformed = false;
  let startSummary = null;
  let stage = 'start_request';
  let lastHttpStatus = null;
  try {
    consumeMutationDispatch(startTicket, 'attachment_upload', inspected.bodyDigest);
    startDispatchConsumed = true;
    const startHeaders = new Headers(inspected.headers);
    startHeaders.set('cookie', inspected.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
    const start = await callUploadServer(fetchImpl, inspected.sourceUrl, {
      method: 'POST', headers: startHeaders, body: capture.body, timeoutMs,
    });
    httpRequestCount += 1;
    lastHttpStatus = start.status;
    const startBody = await readBoundedBody(start);
    const startMime = mimeType(start.headers.get('content-type'));
    const rawSessionUrl = start.headers.get(contract.resumable.uploadUrlHeader);
    startSummary = Object.freeze({
      httpStatus: start.status,
      contentType: startMime,
      responseBytes: startBody.length,
      responseSha256: createHash('sha256').update(startBody).digest('hex'),
      responseHeaderNames: responseHeaderNames(start),
      uploadUrlPresent: typeof rawSessionUrl === 'string' && rawSessionUrl.length > 0,
      uploadUrlRef: rawSessionUrl ? urlRef(rawSessionUrl) : null,
      chunkGranularity: numericHeader(start, contract.resumable.chunkGranularityHeader),
    });
    await settleMutationDispatch(startTicket, { state: 'response_received', httpStatus: start.status });
    startSettled = true;
    activeTicket = null;
    if (start.status !== contract.resumable.startSuccessStatus) {
      startBody.fill(0);
      return Object.freeze({
        status: 'start_rejected',
        directDispatchCount: 1,
        startDispatchCount: 1,
        transferDispatchCount: 0,
        httpRequestCount,
        initBodyBytes: capture.body.length,
        initBodySha256: inspected.bodyDigest,
        fileBytes: file.body.length,
        fileSha256: inspected.fileDigest,
        start: startSummary,
        upload: null,
        query: null,
        uploadedFileReadbackVerified: false,
        cleanup: Object.freeze({ supported: contract.resumable.cancelSupported === true, attempted: false }),
      });
    }
    const uploadUrl = requireUploadUrl(rawSessionUrl, contract);
    activeUploadUrl = rawSessionUrl;
    const startResponseHeaders = {};
    const transferableStartResponseHeaderNames = new Set([
      'access-control-allow-credentials', 'access-control-allow-origin', 'access-control-expose-headers',
      'content-type', contract.resumable.uploadUrlHeader, contract.resumable.chunkGranularityHeader,
      contract.resumable.uploadStatusHeader, 'x-goog-upload-control-url', 'x-guploader-uploadid',
    ]);
    for (const [name, value] of start.headers.entries()) {
      if (transferableStartResponseHeaderNames.has(name.toLowerCase())) startResponseHeaders[name.toLowerCase()] = value;
    }
    stage = 'upload_request';
    try {
      if (continuationCaptureProvider) {
        observedContinuationCapture = await continuationCaptureProvider(Object.freeze({
          httpStatus: start.status,
          uploadUrl: rawSessionUrl,
          responseHeaders: startResponseHeaders,
          responseBody: startBody,
        }));
      }
    } finally {
      startBody.fill(0);
      for (const name of Object.keys(startResponseHeaders)) startResponseHeaders[name] = '';
    }
    if (uploadCookieRefreshProvider) {
      const freshCookies = await uploadCookieRefreshProvider(Object.freeze({
        uploadUrl: rawSessionUrl,
        nativeContinuationCapture: observedContinuationCapture,
      }));
      currentUploadCookies = validateScopedUploadCookieSnapshot(contract, uploadUrl, freshCookies);
    }
    if (useInstalledContinuationTemplate) {
      const templateCheck = assertInstalledContinuationMatchesNative(
        contract, uploadUrl, observedContinuationCapture, currentUploadCookies, file, inspected.headers,
      );
      continuationCapture = templateCheck.capture;
      continuationTemplateSummary = templateCheck.summary;
    } else {
      continuationCapture = observedContinuationCapture
        ?? buildInstalledNativeContinuation(contract, uploadUrl, currentUploadCookies, file, inspected.headers);
    }
    const continuation = validateNativeContinuation(contract, uploadUrl, continuationCapture, currentUploadCookies, file, {
      templateFromContract: !continuationCaptureProvider,
    });
    transferJob = await createMutationJournal({
      capability: 'attachment_upload_transfer', body: continuationCapture.body, actor, callerIntent, root: journalRoot,
    });
    transferTicket = await reserveMutationDispatch(transferJob);
    activeTicket = transferTicket;
    consumeMutationDispatch(transferTicket, 'attachment_upload_transfer', continuation.bodyDigest);
    transferDispatchConsumed = true;
    const upload = await callUploadServer(fetchImpl, uploadUrl, {
      method: continuationCapture.method,
      headers: continuation.headers,
      body: continuationCapture.body,
      timeoutMs,
    });
    httpRequestCount += 1;
    lastHttpStatus = upload.status;
    const uploadBody = await readBoundedBody(upload);
    const uploadMime = mimeType(upload.headers.get('content-type'));
    const uploadMetadata = parseMetadata(uploadBody, uploadMime, file.name, file.body.length, file.mimeType);
    const sdkAttachmentRef = buildSdkAttachmentReference(file, uploadBody, uploadMime);
    const uploadStatus = upload.headers.get(contract.resumable.uploadStatusHeader)?.toLowerCase() ?? null;
    const uploadedSize = numericHeader(upload, contract.resumable.sizeReceivedHeader);
    const uploadSummary = Object.freeze({
      httpStatus: upload.status,
      contentType: uploadMime,
      responseBytes: uploadBody.length,
      responseSha256: createHash('sha256').update(uploadBody).digest('hex'),
      responseHeaderNames: responseHeaderNames(upload),
      uploadStatus,
      sizeReceived: uploadedSize,
      metadata: uploadMetadata,
    });
    if (contract.resumable.querySupported === true) {
      try {
        stage = 'query_readback';
        const queryHeaders = new Headers();
        queryHeaders.set(contract.resumable.commandHeader, contract.resumable.queryCommand);
        const query = await callUploadServer(fetchImpl, uploadUrl, {
          method: contract.resumable.queryMethod,
          headers: queryHeaders,
          timeoutMs,
        });
        httpRequestCount += 1;
        lastHttpStatus = query.status;
        const queryBody = await readBoundedBody(query);
        querySummary = Object.freeze({
          httpStatus: query.status,
          responseBytes: queryBody.length,
          responseSha256: createHash('sha256').update(queryBody).digest('hex'),
          responseHeaderNames: responseHeaderNames(query),
          uploadStatus: query.headers.get(contract.resumable.uploadStatusHeader)?.toLowerCase() ?? null,
          sizeReceived: numericHeader(query, contract.resumable.sizeReceivedHeader),
        });
        queryPerformed = true;
        queryBody.fill(0);
      } catch (error) {
        querySummary = Object.freeze({ status: 'failed', errorCode: error?.code === 'ATTACHMENT_UPLOAD_TRANSPORT_FAILED'
          ? error.code : 'ATTACHMENT_UPLOAD_QUERY_FAILED' });
      }
    }
    await settleMutationDispatch(transferTicket, { state: 'response_received', httpStatus: upload.status });
    transferSettled = true;
    activeTicket = null;
    const responseSizeMatched = uploadMetadata.fileSizeMatched || uploadedSize === file.body.length
      || querySummary?.sizeReceived === file.body.length;
    const uploadFinal = uploadStatus === 'final' || querySummary?.uploadStatus === 'final';
    const responseMetadataBound = uploadMetadata.fileNameMatched && uploadMetadata.fileSizeMatched;
    const readback = upload.status >= 200 && upload.status < 300 && responseSizeMatched
      && (uploadFinal || responseMetadataBound);
    let journalReconciled = false;
    if (readback) {
      await markMutationReconciled(transferJob.jobPath, { found: true, resultCategory: 'attachment_upload_response_metadata_readback' });
      await markMutationReconciled(startJob.jobPath, { found: true, resultCategory: 'attachment_upload_response_metadata_readback' });
      journalReconciled = true;
    }
    let responseHandlerSummary = null;
    if (readback && uploadResponseHandler) {
      const responseHeaders = [...upload.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]);
      const responseBody = Buffer.from(uploadBody);
      try {
        responseHandlerSummary = await uploadResponseHandler({
          httpStatus: upload.status,
          responseHeaders,
          responseBody,
          attachmentRef: sdkAttachmentRef,
        });
      } catch {
        responseHandlerSummary = Object.freeze({ completed: false });
      } finally {
        responseBody.fill(0);
        for (const header of responseHeaders) header[1] = '';
      }
    }
    const result = {
      status: readback ? 'verified' : upload.status < 200 || upload.status >= 300
        ? 'upload_rejected' : 'server_response_needs_readback',
      directDispatchCount: 1 + (transferDispatchConsumed ? 1 : 0),
      startDispatchCount: 1,
      transferDispatchCount: transferDispatchConsumed ? 1 : 0,
      httpRequestCount,
      initBodyBytes: capture.body.length,
      initBodySha256: inspected.bodyDigest,
      fileName: file.name,
      fileMimeType: file.mimeType,
      fileBytes: file.body.length,
      fileSha256: inspected.fileDigest,
      cookieNamesForwardedToStart: Object.freeze(inspected.cookies.map((cookie) => cookie.name).sort()),
      cookieDomainScopes: Object.freeze(inspected.cookies.map(({ name, domain, path, secure }) => Object.freeze({ name, domain, path, secure }))),
      continuationHeaderNames: continuation.headerNames,
      cookieNamesForwardedToContinuation: continuation.cookieNames,
      continuationOffset: Number(continuationCapture.headers[contract.resumable.offsetHeader]),
      continuationBodyBytes: continuationCapture.body.length,
      continuationBodySha256: continuation.bodyDigest,
      ...(continuationTemplateSummary ? { continuationTemplate: continuationTemplateSummary } : {}),
      start: startSummary,
      upload: uploadSummary,
      query: querySummary,
      uploadedFileReadbackVerified: readback,
      attachmentReferenceAvailable: readback && sdkAttachmentRef !== null,
      cleanup: Object.freeze({ supported: contract.resumable.cancelSupported === true, attempted: false }),
      journalReconciled,
      ...(responseHandlerSummary && typeof responseHandlerSummary === 'object'
        ? { responseHandlerCompleted: responseHandlerSummary.completed === true } : {}),
    };
    uploadBody.fill(0);
    return readback && sdkAttachmentRef
      ? withInternalAttachmentReference(result, sdkAttachmentRef)
      : Object.freeze(result);
  } catch (error) {
    if (activeTicket) {
      await settleMutationDispatch(activeTicket, {
        state: mutationDispatchConsumed(activeTicket) ? 'outcome_unknown' : 'preflight_failed',
        failureCode: typeof error?.code === 'string' ? error.code : 'ATTACHMENT_UPLOAD_FAILED',
      }).catch(() => {});
      activeTicket = null;
    }
    if (activeUploadUrl && !queryPerformed && contract.resumable.querySupported === true) {
      try {
        querySummary = await queryAttachmentUploadSession({ contract, uploadUrl: activeUploadUrl, fetchImpl, timeoutMs });
        httpRequestCount += 1;
        queryPerformed = true;
      } catch (queryError) {
        querySummary = Object.freeze({ status: 'failed', errorCode: queryError?.code === 'ATTACHMENT_UPLOAD_TRANSPORT_FAILED'
          ? queryError.code : 'ATTACHMENT_UPLOAD_QUERY_FAILED' });
      }
    }
    const queryProvesFinalFile = transferDispatchConsumed && querySummary?.httpStatus === 200
      && querySummary.uploadStatus === 'final' && querySummary.sizeReceived === file.body.length;
    if (queryProvesFinalFile && transferJob) {
      await markMutationReconciled(transferJob.jobPath, { found: true, resultCategory: 'attachment_upload_session_query_readback' });
      await markMutationReconciled(startJob.jobPath, { found: true, resultCategory: 'attachment_upload_session_query_readback' });
      return Object.freeze({
        status: 'verified',
        directDispatchCount: (startDispatchConsumed ? 1 : 0) + (transferDispatchConsumed ? 1 : 0),
        startDispatchCount: startDispatchConsumed ? 1 : 0,
        transferDispatchCount: transferDispatchConsumed ? 1 : 0,
        httpRequestCount,
        initBodyBytes: capture.body.length,
        initBodySha256: inspected.bodyDigest,
        fileName: file.name,
        fileMimeType: file.mimeType,
        fileBytes: file.body.length,
        fileSha256: inspected.fileDigest,
        start: startSummary,
        upload: null,
        query: querySummary,
        uploadedFileReadbackVerified: true,
        readbackSource: 'server_upload_session_query',
        cleanup: Object.freeze({ supported: false, attempted: false }),
        journalReconciled: true,
      });
    }
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
      ? error.code : 'ATTACHMENT_UPLOAD_FAILED';
    throw new GeminiClientError(code, 'The direct attachment upload did not reach a verified terminal state.', {
      directDispatchCount: (startDispatchConsumed ? 1 : 0) + (transferDispatchConsumed ? 1 : 0),
      startDispatchCount: startDispatchConsumed ? 1 : 0,
      transferDispatchCount: transferDispatchConsumed ? 1 : 0,
      httpRequestCount,
      stage,
      ...(Number.isInteger(lastHttpStatus) ? { httpStatus: lastHttpStatus } : {}),
      ...(querySummary && typeof querySummary === 'object' ? { queryReadback: {
        httpStatus: querySummary.httpStatus ?? null,
        uploadStatus: querySummary.uploadStatus ?? null,
        sizeReceived: querySummary.sizeReceived ?? null,
      } } : {}),
      ...safeCookieDiagnostics(error?.details),
      ...safeContinuationDiagnostics(error?.details),
      internalErrorClass: error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'InternalError',
      ...(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code) ? { internalErrorCode: error.code } : {}),
    });
  } finally {
    activeUploadUrl = null;
    if (continuationCapture && Buffer.isBuffer(continuationCapture.body)
        && continuationCapture.body !== file.body) continuationCapture.body.fill(0);
    if (observedContinuationCapture && Buffer.isBuffer(observedContinuationCapture.body)
        && observedContinuationCapture.body !== file.body && observedContinuationCapture.body !== continuationCapture?.body) {
      observedContinuationCapture.body.fill(0);
    }
    if (!startSettled && activeTicket !== startTicket) {
      await settleMutationDispatch(startTicket, {
        state: startDispatchConsumed ? 'outcome_unknown' : 'preflight_failed',
      }).catch(() => {});
    }
    if (transferTicket && !transferSettled && activeTicket !== transferTicket) {
      await settleMutationDispatch(transferTicket, {
        state: transferDispatchConsumed ? 'outcome_unknown' : 'preflight_failed',
      }).catch(() => {});
    }
  }
}

/** Query a returned resumable URL using only the documented query command; this sends no file bytes. */
export async function queryAttachmentUploadSession({ contract, uploadUrl, fetchImpl = globalThis.fetch, timeoutMs = 45_000 } = {}) {
  validateContract(contract);
  if (contract.resumable.querySupported !== true) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_QUERY_UNOBSERVED', 'The upload query step is not installed in the current source contract.');
  }
  const target = requireUploadUrl(uploadUrl, contract);
  const headers = new Headers({ [contract.resumable.commandHeader]: contract.resumable.queryCommand });
  const response = await callUploadServer(fetchImpl, target, {
    method: contract.resumable.queryMethod,
    headers,
    timeoutMs,
  });
  const body = await readBoundedBody(response);
  const result = Object.freeze({
    httpStatus: response.status,
    responseBytes: body.length,
    responseSha256: createHash('sha256').update(body).digest('hex'),
    responseHeaderNames: responseHeaderNames(response),
    uploadStatus: response.headers.get(contract.resumable.uploadStatusHeader)?.toLowerCase() ?? null,
    sizeReceived: numericHeader(response, contract.resumable.sizeReceivedHeader),
  });
  body.fill(0);
  uploadQueryTickets.set(result, Object.freeze({
    uploadUrlDigest: createHash('sha256').update(target.href).digest('hex'),
    uploadStatus: result.uploadStatus,
    sizeReceived: result.sizeReceived,
  }));
  return result;
}

/** Resume only from a server-reported active offset; this function never guesses or retries an offset. */
export async function resumeAttachmentUploadSession({
  contract, uploadUrl, file, query, fetchImpl = globalThis.fetch, timeoutMs = 45_000,
} = {}) {
  validateContract(contract);
  const queryTicket = query && typeof query === 'object' ? uploadQueryTickets.get(query) : null;
  let target;
  try { target = requireUploadUrl(uploadUrl, contract); }
  catch { throw new GeminiClientError('ATTACHMENT_UPLOAD_RESUME_UNOBSERVED', 'The resumable URL is outside the observed contract.'); }
  if (!contract.resumable.resumeSupported || !queryTicket
      || queryTicket.uploadUrlDigest !== createHash('sha256').update(target.href).digest('hex')
      || queryTicket.uploadStatus !== 'active' || !Number.isSafeInteger(queryTicket.sizeReceived)
      || !Buffer.isBuffer(file?.body) || queryTicket.sizeReceived < 0 || queryTicket.sizeReceived >= file.body.length) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_RESUME_UNOBSERVED', 'A server-reported active offset and observed resume contract are required.');
  }
  const offset = queryTicket.sizeReceived;
  const remaining = file.body.subarray(offset);
  const headers = new Headers();
  headers.set(contract.resumable.commandHeader, contract.resumable.finalizeCommand);
  headers.set(contract.resumable.offsetHeader, String(offset));
  const response = await callUploadServer(fetchImpl, target, {
    method: contract.resumable.uploadMethod,
    headers,
    body: remaining,
    timeoutMs,
  });
  const body = await readBoundedBody(response);
  const metadata = parseMetadata(body, mimeType(response.headers.get('content-type')), file.name, file.body.length);
  const result = Object.freeze({
    httpStatus: response.status,
    responseBytes: body.length,
    responseSha256: createHash('sha256').update(body).digest('hex'),
    responseHeaderNames: responseHeaderNames(response),
    uploadStatus: response.headers.get(contract.resumable.uploadStatusHeader)?.toLowerCase() ?? null,
    sizeReceived: numericHeader(response, contract.resumable.sizeReceivedHeader),
    metadata,
    offset,
    bodyBytesSent: remaining.length,
  });
  body.fill(0);
  return result;
}

/** Cancel one query-confirmed active session using the current SDK's observed command. */
export async function cancelAttachmentUploadSession({
  contract,
  uploadUrl,
  query,
  actor,
  callerIntent,
  journalRoot,
  fetchImpl = globalThis.fetch,
  timeoutMs = 45_000,
} = {}) {
  validateContract(contract);
  if (contract.resumable.cancelSupported !== true) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CANCEL_UNOBSERVED', 'The current Gemini upload UI/source contract does not establish a cancellation request.');
  }
  const ticket = query && typeof query === 'object' ? uploadQueryTickets.get(query) : null;
  let target;
  try { target = requireUploadUrl(uploadUrl, contract); }
  catch { throw new GeminiClientError('ATTACHMENT_UPLOAD_CANCEL_UNOBSERVED', 'The cancellation URL is outside the observed session contract.'); }
  if (!ticket || ticket.uploadUrlDigest !== createHash('sha256').update(target.href).digest('hex')
      || ticket.uploadStatus !== 'active' || typeof actor !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor)
      || typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)
      || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new GeminiClientError('ATTACHMENT_UPLOAD_CANCEL_INPUT_INVALID', 'Cancellation requires a current owner intent and a query-confirmed active session.');
  }
  const job = await createMutationJournal({
    capability: 'attachment_upload_cancel', body: Buffer.alloc(0), actor, callerIntent, root: journalRoot,
  });
  const dispatch = await reserveMutationDispatch(job);
  let consumed = false;
  let responseStatus = null;
  let queryAfter = null;
  try {
    consumeMutationDispatch(dispatch, 'attachment_upload_cancel', digestBody(Buffer.alloc(0)));
    consumed = true;
    const headers = new Headers({ [contract.resumable.commandHeader]: contract.resumable.cancelCommand });
    const response = await callUploadServer(fetchImpl, target, {
      method: contract.resumable.cancelMethod,
      headers,
      timeoutMs,
    });
    responseStatus = response.status;
    const body = await readBoundedBody(response);
    const responseSummary = Object.freeze({
      httpStatus: response.status,
      contentType: mimeType(response.headers.get('content-type')),
      responseBytes: body.length,
      responseSha256: createHash('sha256').update(body).digest('hex'),
      responseHeaderNames: responseHeaderNames(response),
    });
    body.fill(0);
    await settleMutationDispatch(dispatch, { state: 'response_received', httpStatus: response.status });
    try {
      queryAfter = await queryAttachmentUploadSession({ contract, uploadUrl: target.href, fetchImpl, timeoutMs });
    } catch (error) {
      queryAfter = Object.freeze({ status: 'failed', errorCode: error?.code === 'ATTACHMENT_UPLOAD_TRANSPORT_FAILED'
        ? error.code : 'ATTACHMENT_UPLOAD_QUERY_FAILED' });
    }
    const terminalCancelled = response.status >= 200 && response.status < 300
      && queryAfter.httpStatus === 200 && ['cancelled', 'canceled'].includes(queryAfter.uploadStatus);
    if (terminalCancelled) {
      await markMutationReconciled(job.jobPath, { found: true, resultCategory: 'attachment_upload_cancel_query_readback' });
    }
    return Object.freeze({
      status: terminalCancelled ? 'cancelled' : response.status < 200 || response.status >= 300
        ? 'cancel_rejected' : 'cancel_response_needs_readback',
      directDispatchCount: 1,
      httpRequestCount: 1 + (queryAfter.httpStatus ? 1 : 0),
      cancel: responseSummary,
      query: queryAfter,
      cancellationReadbackVerified: terminalCancelled,
      journalReconciled: terminalCancelled,
    });
  } catch (error) {
    await settleMutationDispatch(dispatch, {
      state: mutationDispatchConsumed(dispatch) ? 'outcome_unknown' : 'preflight_failed',
      ...(Number.isInteger(responseStatus) ? { httpStatus: responseStatus } : {}),
      failureCode: typeof error?.code === 'string' ? error.code : 'ATTACHMENT_UPLOAD_CANCEL_FAILED',
    }).catch(() => {});
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
      ? error.code : 'ATTACHMENT_UPLOAD_CANCEL_FAILED';
    throw new GeminiClientError(code, 'The direct upload cancellation did not reach a verified terminal state.', {
      directDispatchCount: consumed ? 1 : 0,
      ...(Number.isInteger(responseStatus) ? { httpStatus: responseStatus } : {}),
    });
  }
}

export function attachmentUploadUrlRef(value) {
  return urlRef(value);
}

export function attachmentUploadBodyDigest(body) {
  return digestBody(body);
}
