import { createHash } from 'node:crypto';
import { GeminiClientError } from './errors.mjs';
import { parseBatchResponse, collectRpcResponses } from './batch-response.mjs';
import { makeCookieHeader } from './session.mjs';
import { saveVerifiedMedia, validateMedia } from './media.mjs';

export const GEMINI_ORIGINAL_IMAGE_RPC_ID = 'c8o8Fe';
export const GEMINI_ORIGINAL_IMAGE_PATH = '/_/BardChatUi/data/batchexecute';
export const GEMINI_ORIGINAL_IMAGE_C8_FRAME_LENGTH_UNIT = 'utf16_code_units';
export const GEMINI_ORIGINAL_IMAGE_C8_FRAME_LENGTH_OVERHEAD = 2;

const GEMINI_ORIGIN = 'https://gemini.google.com';
const ORIGINAL_IMAGE_HOST = 'https://lh3.googleusercontent.com';
const REQUIRED_QUERY_KEYS = Object.freeze(['_reqid', 'bl', 'f.sid', 'hl', 'rpcids', 'rt', 'source-path']);
const REQUIRED_BODY_FIELDS = Object.freeze(['f.req', 'at']);
const SAFE_C8_HEADERS = new Set([
  'accept', 'content-type', 'origin', 'referer', 'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
  'sec-ch-ua-form-factors', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile',
  'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64', 'user-agent',
  'x-goog-ext-525001261-jspb', 'x-goog-ext-73010989-jspb', 'x-same-domain',
]);
const SAFE_ASSET_HEADERS = new Set(['accept', 'accept-language', 'cache-control', 'pragma', 'referer', 'user-agent']);
const FORBIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length']);
const MAX_C8_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_HOPS = 10;

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mediaReference(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); }
  catch { fail('ORIGINAL_IMAGE_URL_INVALID', 'The observed original-image URL is invalid.'); }
  const dynamic = (segment) => segment.length > 40 || /^[0-9a-f-]{16,}$/i.test(segment);
  return Object.freeze({
    origin: url.origin,
    pathFamily: url.pathname.split('/').map((segment) => dynamic(segment) ? '{id}' : segment).join('/'),
    queryKeyNames: Object.freeze([...new Set([...url.searchParams.keys()])].sort()),
  });
}

function sameReference(left, right) {
  return left?.origin === right?.origin && left?.pathFamily === right?.pathFamily
    && JSON.stringify(left?.queryKeyNames) === JSON.stringify(right?.queryKeyNames);
}

function samePathFamily(left, right) {
  return left?.origin === right?.origin && left?.pathFamily === right?.pathFamily;
}

function visitValues(value, visitor, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 32) return;
  visitor(value);
  if (Array.isArray(value)) value.forEach((item) => visitValues(item, visitor, depth + 1, budget));
  else if (isRecord(value)) Object.values(value).forEach((item) => visitValues(item, visitor, depth + 1, budget));
}

function exactValuePresent(value, expected) {
  let found = false;
  visitValues(value, (candidate) => { if (candidate === expected) found = true; });
  return found;
}

function validateTaskReadback(client, taskReadback, {
  expectedOwner, apiConversationId, visibleRouteId, expectedIntent,
} = {}) {
  if (!client || !client.contract || !client.transport?.session
      || client.verifiedOwner !== String(expectedOwner || '').trim().toLowerCase()
      || typeof expectedOwner !== 'string' || !expectedOwner.trim()) {
    fail('ORIGINAL_IMAGE_OWNER_BINDING_REQUIRED', 'A verified owner-bound Gemini client is required.');
  }
  if (typeof apiConversationId !== 'string' || !/^c_[0-9a-f]{16}$/.test(apiConversationId)
      || typeof visibleRouteId !== 'string' || visibleRouteId !== apiConversationId.slice(2)) {
    fail('ORIGINAL_IMAGE_TASK_ID_BINDING_INVALID', 'The API conversation ID and visible route ID did not match.');
  }
  if (typeof expectedIntent !== 'string' || !expectedIntent.trim() || expectedIntent.length > 8_000) {
    fail('ORIGINAL_IMAGE_INTENT_REQUIRED', 'The exact task prompt is required for original-image binding.');
  }
  if (!taskReadback || taskReadback.httpStatus !== 200 || taskReadback.summary?.rpcMatchCount !== 1
      || taskReadback.summary?.taskIntentMatched !== true || taskReadback.summary?.apiConversationIdMatched !== true
      || taskReadback.binding?.bound !== true || !exactValuePresent(taskReadback.payload, apiConversationId)
      || !exactValuePresent(taskReadback.payload, expectedIntent)) {
    fail('ORIGINAL_IMAGE_TASK_READBACK_REQUIRED', 'A matching hNvQHb task readback is required before download.');
  }
}

function validateNativeRequest(prepared, { apiConversationId, contract } = {}) {
  const capture = prepared?.nativeRequest;
  if (!isRecord(capture) || typeof capture.url !== 'string' || typeof capture.body !== 'string'
      || !isRecord(capture.headers) || typeof capture.contentType !== 'string') {
    fail('ORIGINAL_IMAGE_NATIVE_REQUEST_REQUIRED', 'A normal-SDK prepared c8o8Fe request is required.');
  }
  if (Buffer.byteLength(capture.body, 'utf8') > MAX_C8_REQUEST_BYTES) {
    fail('ORIGINAL_IMAGE_REQUEST_TOO_LARGE', 'The prepared c8o8Fe request exceeded its bounded size.');
  }
  const url = new URL(capture.url);
  if (url.origin !== GEMINI_ORIGIN || url.pathname !== GEMINI_ORIGINAL_IMAGE_PATH
      || url.searchParams.get('rpcids') !== GEMINI_ORIGINAL_IMAGE_RPC_ID) {
    fail('ORIGINAL_IMAGE_REQUEST_SCOPE_INVALID', 'The prepared c8o8Fe request escaped its observed endpoint.');
  }
  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.length !== REQUIRED_QUERY_KEYS.length
      || REQUIRED_QUERY_KEYS.some((key) => !queryKeys.includes(key))) {
    fail('ORIGINAL_IMAGE_QUERY_CONTRACT_MISMATCH', 'The c8o8Fe query keys did not match the observed contract.');
  }
  const form = new URLSearchParams(capture.body);
  const bodyFields = [...form.keys()];
  if (JSON.stringify(bodyFields) !== JSON.stringify(REQUIRED_BODY_FIELDS)
      || !form.get('at') || !form.get('f.req')) {
    fail('ORIGINAL_IMAGE_BODY_CONTRACT_MISMATCH', 'The c8o8Fe form fields did not match the observed contract.');
  }
  let envelope;
  let call;
  let args;
  try {
    envelope = JSON.parse(form.get('f.req'));
    call = envelope?.[0]?.[0];
    args = JSON.parse(call?.[1]);
  } catch {
    fail('ORIGINAL_IMAGE_ARGUMENTS_INVALID', 'The prepared c8o8Fe request arguments could not be decoded.');
  }
  if (!Array.isArray(envelope) || envelope.length !== 1 || !Array.isArray(envelope[0]) || envelope[0].length !== 1
      || !Array.isArray(call) || call[0] !== GEMINI_ORIGINAL_IMAGE_RPC_ID || call[2] !== null || call[3] !== 'generic'
      || !Array.isArray(args) || args.length !== 5) {
    fail('ORIGINAL_IMAGE_ARGUMENTS_UNOBSERVED', 'The c8o8Fe argument envelope did not match the source capture.');
  }
  const ids = [];
  visitValues(args, (value) => { if (typeof value === 'string' && /^c_[0-9a-f]{16}$/.test(value)) ids.push(value); });
  if (ids.length !== 1 || ids[0] !== apiConversationId) {
    fail('ORIGINAL_IMAGE_ARGUMENT_TASK_MISMATCH', 'The c8o8Fe arguments did not bind to the verified task.');
  }
  const headers = {};
  for (const [name, value] of Object.entries(capture.headers)) {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(normalized) || !SAFE_C8_HEADERS.has(normalized)
        || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      fail('ORIGINAL_IMAGE_REQUEST_HEADER_UNOBSERVED', 'The prepared c8o8Fe request contained an unobserved header.');
    }
    headers[normalized] = value;
  }
  if (!headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    fail('ORIGINAL_IMAGE_CONTENT_TYPE_MISMATCH', 'The c8o8Fe request did not use the captured form content type.');
  }
  if (!contract.assetOrigins.includes(ORIGINAL_IMAGE_HOST)) {
    fail('ORIGINAL_IMAGE_ASSET_ORIGIN_NOT_CAPTURED', 'The original image host is not in the observed asset allowlist.');
  }
  return Object.freeze({ url, body: capture.body, headers: Object.freeze(headers), bodyFields, args });
}

function validateSourceTransform(prepared, contract) {
  if (prepared?.source?.normalUiCaptureVerified !== true
      || prepared.source.downloadRpcId !== GEMINI_ORIGINAL_IMAGE_RPC_ID
      || prepared.source.originalSizeControlObserved !== true
      || prepared.source.originalSizeControlClicked !== true
      || prepared.source.browserDownloadEventObserved !== true
      || prepared.source.c8ResponseHttpStatus !== 200
      || prepared.source.c8ResponseRpcMatchCount !== 1) {
    fail('ORIGINAL_IMAGE_NATIVE_SOURCE_CAPTURE_REQUIRED', 'A matching normal-SDK original-size c8o8Fe capture is required.');
  }
  const baseValue = prepared?.source?.nativeDownloadUrl;
  const originalSizeValue = prepared?.source?.originalSizeUrl;
  if (typeof baseValue !== 'string' || typeof originalSizeValue !== 'string') {
    fail('ORIGINAL_IMAGE_SIZE_TRANSFORM_REQUIRED', 'The first-party vPd original-size URL transform is required.');
  }
  const base = new URL(baseValue);
  const transformed = new URL(originalSizeValue);
  const baseSegments = base.pathname.split('/');
  const transformedSegments = transformed.pathname.split('/');
  const baseTerminal = baseSegments.at(-1) ?? '';
  const transformedTerminal = transformedSegments.at(-1) ?? '';
  const baseStem = baseTerminal.split('=', 1)[0];
  const transformedStem = transformedTerminal.split('=', 1)[0];
  if (base.origin !== ORIGINAL_IMAGE_HOST || transformed.origin !== base.origin || !base.pathname.startsWith('/gg/')
      || baseSegments.length !== transformedSegments.length || baseStem !== transformedStem) {
    fail('ORIGINAL_IMAGE_SIZE_TRANSFORM_UNOBSERVED', 'The first-party size-zero URL transform did not match the captured c8o8Fe result.');
  }
  const suffix = transformedTerminal.slice(transformedStem.length);
  if (!/^=[A-Za-z0-9_-]{1,64}$/.test(suffix)) {
    fail('ORIGINAL_IMAGE_SIZE_SUFFIX_INVALID', 'The size-zero image path suffix was not observed.');
  }
  if (mediaReference(baseValue).pathFamily !== mediaReference(transformed).pathFamily) {
    fail('ORIGINAL_IMAGE_SIZE_PATH_FAMILY_MISMATCH', 'The source-size transform changed the observed asset path family.');
  }
  const assetRequests = prepared?.source?.observedAssetRequests;
  if (!Array.isArray(assetRequests) || assetRequests.length < 2 || assetRequests.length > 16) {
    fail('ORIGINAL_IMAGE_ASSET_REQUESTS_REQUIRED', 'The normal-SDK asset fetch chain is required to bind the direct HTTP path.');
  }
  const normalizedRequests = assetRequests.map((item) => {
    if (!isRecord(item) || typeof item.url !== 'string' || !isRecord(item.headers)
        || item.method !== 'GET' || item.requestExtraInfoObserved !== true || !Array.isArray(item.cookieNames)) {
      fail('ORIGINAL_IMAGE_ASSET_REQUEST_EVIDENCE_INVALID', 'An observed original-image GET entry was malformed.');
    }
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || !contract.assetOrigins.includes(url.origin)) {
      fail('ORIGINAL_IMAGE_ASSET_REQUEST_SCOPE_INVALID', 'An observed original-image GET escaped the asset origin allowlist.');
    }
    const headers = {};
    for (const [name, value] of Object.entries(item.headers)) {
      const normalized = name.toLowerCase();
      if (FORBIDDEN_HEADERS.has(normalized) || !SAFE_ASSET_HEADERS.has(normalized)
          || typeof value !== 'string' || /[\r\n\0]/.test(value)) continue;
      headers[normalized] = value;
    }
    return Object.freeze({
      url,
      reference: mediaReference(url),
      headers: Object.freeze(headers),
      cookieNames: Object.freeze([...new Set(item.cookieNames)].sort()),
      requestExtraInfoObserved: true,
    });
  });
  const baseReference = mediaReference(originalSizeValue);
  if (!normalizedRequests.some((item) => samePathFamily(item.reference, baseReference))) {
    fail('ORIGINAL_IMAGE_SIZE_GET_NOT_OBSERVED', 'The transformed original-size path was not used by the normal SDK.');
  }
  const allowedReferences = normalizedRequests.map((item) => item.reference);
  return Object.freeze({
    baseUrl: baseValue,
    originalSizeUrl: originalSizeValue,
    suffix,
    requests: Object.freeze(normalizedRequests),
    allowedReferences: Object.freeze(allowedReferences),
  });
}

function cookieHeaderForAsset(session, contract, url, observedNames) {
  const scopes = new Map((contract.mediaAssetDownload?.cookieScopes ?? []).map((scope) => [scope.name, scope]));
  const cookies = new Map((session.mediaCookies ?? []).map((cookie) => [cookie.name, cookie]));
  const pairs = [];
  for (const name of [...new Set(observedNames)].sort()) {
    const scope = scopes.get(name);
    const cookie = cookies.get(name);
    const domainMatches = scope && (url.hostname === scope.domain.replace(/^\./, '') || url.hostname.endsWith(scope.domain));
    if (!scope || !cookie || !domainMatches || cookie.domain !== scope.domain || cookie.path !== scope.path
        || cookie.secure !== scope.secure || !url.pathname.startsWith(scope.path)
        || (scope.secure && url.protocol !== 'https:')) {
      fail('ORIGINAL_IMAGE_COOKIE_SCOPE_INVALID', 'A required asset cookie lacked an observed current-session scope.');
    }
    pairs.push(`${name}=${cookie.value}`);
  }
  return pairs.join('; ');
}

async function readBoundedBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    response.body?.destroy?.();
    fail('ORIGINAL_IMAGE_RESPONSE_TOO_LARGE', 'An original-image response exceeded its size limit.');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        response.body?.destroy?.();
        fail('ORIGINAL_IMAGE_RESPONSE_TOO_LARGE', 'An original-image response exceeded its size limit.');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof GeminiClientError) throw error;
    fail('ORIGINAL_IMAGE_RESPONSE_READ_FAILED', 'An original-image response body could not be read.');
  }
  return Buffer.concat(chunks, size);
}

function c8ResponseFrames(body, operation = {}) {
  const unit = operation.frameLengthUnit ?? GEMINI_ORIGINAL_IMAGE_C8_FRAME_LENGTH_UNIT;
  const overhead = operation.frameLengthOverheadUnits ?? GEMINI_ORIGINAL_IMAGE_C8_FRAME_LENGTH_OVERHEAD;
  const frames = parseBatchResponse(body, { lengthUnit: unit, frameLengthOverheadUnits: overhead });
  const responses = collectRpcResponses(frames).filter((response) => response.rpcId === GEMINI_ORIGINAL_IMAGE_RPC_ID);
  if (responses.length !== 1) {
    fail('ORIGINAL_IMAGE_C8_RESPONSE_AMBIGUOUS', 'The c8o8Fe response did not contain exactly one result.');
  }
  return Object.freeze({ frames, response: responses[0], lengthUnit: unit, frameLengthOverheadUnits: overhead });
}

function c8DownloadUrl(responseData) {
  const urls = [];
  visitValues(responseData, (value) => {
    if (typeof value !== 'string') return;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) urls.push(value);
    } catch { /* Not a URL field. */ }
  });
  const unique = [...new Set(urls)];
  if (unique.length !== 1) fail('ORIGINAL_IMAGE_C8_URL_AMBIGUOUS', 'The c8o8Fe result did not contain one download URL.');
  const url = new URL(unique[0]);
  if (url.origin !== ORIGINAL_IMAGE_HOST || !url.pathname.startsWith('/gg/')) {
    fail('ORIGINAL_IMAGE_C8_URL_SCOPE_INVALID', 'The c8o8Fe result URL did not match the captured image host and path.');
  }
  return unique[0];
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24
      || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return Object.freeze({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
}

function safeFetchHeaders(observedRequest) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(observedRequest.headers)) {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(normalized) || !SAFE_ASSET_HEADERS.has(normalized)
        || typeof value !== 'string' || /[\r\n\0]/.test(value)) continue;
    if (normalized === 'referer') {
      let referer;
      try { referer = new URL(value); } catch { fail('ORIGINAL_IMAGE_REFERER_INVALID', 'An observed asset referer was invalid.'); }
      if (referer.origin !== GEMINI_ORIGIN) fail('ORIGINAL_IMAGE_REFERER_SCOPE_INVALID', 'The observed asset referer escaped Gemini.');
    }
    headers.set(normalized, value);
  }
  if (!headers.has('accept')) headers.set('accept', '*/*');
  return headers;
}

function observedAssetRequest(source, url) {
  const reference = mediaReference(url);
  return source.requests.find((item) => sameReference(item.reference, reference))
    ?? source.requests.find((item) => samePathFamily(item.reference, reference));
}

/**
 * Validate a source-prepared request from the normal Gemini SDK. The raw URLs,
 * request body, and header values remain non-enumerable in the returned object.
 */
export function prepareGeminiOriginalImageDownload({
  client,
  taskReadback,
  expectedOwner,
  apiConversationId,
  visibleRouteId,
  expectedIntent,
  preparedRequest,
} = {}) {
  validateTaskReadback(client, taskReadback, { expectedOwner, apiConversationId, visibleRouteId, expectedIntent });
  const nativeRequest = validateNativeRequest(preparedRequest, { apiConversationId, contract: client.contract });
  const source = validateSourceTransform(preparedRequest, client.contract);
  const summary = Object.freeze({
    operation: 'c8o8Fe',
    sideEffect: 'read',
    taskBinding: 'hNvQHb_prompt_api_id_route',
    taskPromptMatched: true,
    apiConversationIdMatched: true,
    routeBound: true,
    request: Object.freeze({
      method: 'POST', origin: nativeRequest.url.origin, path: nativeRequest.url.pathname,
      rpcId: GEMINI_ORIGINAL_IMAGE_RPC_ID, bodyFieldNames: nativeRequest.bodyFields,
      argsTopLevelCount: nativeRequest.args.length,
    }),
    originalSizeTransform: Object.freeze({ sourceFunction: 'vPd', setSize: 0, observedPathSuffixLength: source.suffix.length }),
    observedAssetReferenceCount: source.requests.length,
  });
  const result = { summary };
  Object.defineProperty(result, 'internal', {
    value: Object.freeze({ nativeRequest, source, apiConversationId, expectedIntent }),
    enumerable: false,
  });
  return Object.freeze(result);
}

/** Directly replay c8o8Fe and follow Gemini's observed size-zero text/plain URL chain. */
export async function downloadGeminiOriginalImageOnce({
  client,
  taskReadback,
  expectedOwner,
  apiConversationId,
  visibleRouteId,
  expectedIntent,
  preparedRequest,
  artifactRoot,
  artifactName,
  expectedArtifactPath = null,
  fetchImpl = client?.transport?.fetch,
} = {}) {
  if (!client?.contract || !client?.transport?.session || typeof fetchImpl !== 'function') {
    fail('ORIGINAL_IMAGE_CLIENT_REQUIRED', 'A Gemini client with a verified session and HTTPS transport is required.');
  }
  const prepared = prepareGeminiOriginalImageDownload({
    client, taskReadback, expectedOwner, apiConversationId, visibleRouteId, expectedIntent, preparedRequest,
  });
  const { nativeRequest, source } = prepared.internal;
  const c8Headers = new Headers(nativeRequest.headers);
  c8Headers.set('cookie', makeCookieHeader(client.transport.session, nativeRequest.url));
  let c8Response;
  try {
    c8Response = await fetchImpl(nativeRequest.url, {
      method: 'POST', headers: c8Headers, body: nativeRequest.body, timeoutMs: 60_000, redirect: 'manual',
    });
  } catch {
    fail('ORIGINAL_IMAGE_C8_TRANSPORT_FAILED', 'The direct c8o8Fe request failed before a response was available.');
  }
  if (c8Response.status !== 200) {
    await c8Response.body?.destroy?.();
    fail('ORIGINAL_IMAGE_C8_HTTP_REJECTED', 'The direct c8o8Fe request returned a non-success status.');
  }
  const c8Mime = String(c8Response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (c8Mime !== 'application/json') {
    await c8Response.body?.destroy?.();
    fail('ORIGINAL_IMAGE_C8_CONTENT_TYPE_MISMATCH', 'The direct c8o8Fe response did not match the captured JSON content type.');
  }
  const c8Body = await readBoundedBody(c8Response, 4 * 1024 * 1024);
  let downloadUrl;
  let parsedC8;
  try {
    parsedC8 = c8ResponseFrames(c8Body);
    downloadUrl = c8DownloadUrl(parsedC8.response.data);
  } catch (error) {
    c8Body.fill(0);
    throw error;
  }
  const directBase = new URL(downloadUrl);
  const nativeBase = new URL(source.baseUrl);
  const directSegments = directBase.pathname.split('/');
  const nativeSegments = nativeBase.pathname.split('/');
  const directStem = (directSegments.at(-1) ?? '').split('=', 1)[0];
  const nativeStem = (nativeSegments.at(-1) ?? '').split('=', 1)[0];
  if (directBase.origin !== nativeBase.origin || directSegments.length !== nativeSegments.length
      || directStem !== nativeStem || mediaReference(directBase).pathFamily !== mediaReference(nativeBase).pathFamily) {
    c8Body.fill(0);
    fail('ORIGINAL_IMAGE_C8_TASK_ASSET_MISMATCH', 'The direct c8o8Fe result did not match the source-prepared task asset family.');
  }
  const current = new URL(directBase);
  directSegments[directSegments.length - 1] = directStem + source.suffix;
  current.pathname = directSegments.join('/');
  current.search = new URL(source.originalSizeUrl).search;
  current.searchParams.set('alr', 'yes');
  const hops = [];
  let finalBody = null;
  let finalMime = '';
  let finalStatus = 0;
  for (let hopIndex = 0; hopIndex < MAX_TEXT_HOPS; hopIndex += 1) {
    if (!client.contract.assetOrigins.includes(current.origin)) {
      c8Body.fill(0);
      fail('ORIGINAL_IMAGE_ASSET_ORIGIN_BLOCKED', 'The original-image URL chain escaped the captured Gemini asset origins.');
    }
    const reference = mediaReference(current);
    const allowedReference = source.allowedReferences.some((item) => sameReference(item, reference)
      || samePathFamily(item, reference));
    if (!allowedReference) {
      c8Body.fill(0);
      fail('ORIGINAL_IMAGE_ASSET_REFERENCE_UNOBSERVED', 'The original-image URL chain used an unobserved path family.');
    }
    const observed = observedAssetRequest(source, current);
    if (!observed) {
      c8Body.fill(0);
      fail('ORIGINAL_IMAGE_ASSET_HEADERS_UNOBSERVED', 'The original-image URL had no normal-SDK request metadata.');
    }
    const headers = safeFetchHeaders(observed);
    const cookieHeader = cookieHeaderForAsset(client.transport.session, client.contract, current, observed.cookieNames);
    if (cookieHeader) headers.set('cookie', cookieHeader);
    let response;
    try {
      response = await fetchImpl(current, { method: 'GET', headers, timeoutMs: 60_000, redirect: 'manual' });
    } catch {
      c8Body.fill(0);
      fail('ORIGINAL_IMAGE_ASSET_TRANSPORT_FAILED', 'A source-observed asset request failed before a response was available.');
    }
    const mime = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    const body = await readBoundedBody(response);
    hops.push(Object.freeze({
      reference,
      httpStatus: response.status,
      contentType: mime,
      responseBytes: body.length,
      cookieNames: observed.cookieNames,
      requestExtraInfoObserved: observed.requestExtraInfoObserved,
    }));
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      body.fill(0);
      if (!location) {
        c8Body.fill(0);
        fail('ORIGINAL_IMAGE_ASSET_REDIRECT_MISSING', 'The original-image redirect omitted its location.');
      }
      const redirected = new URL(location, current);
      if (!source.allowedReferences.some((item) => sameReference(item, mediaReference(redirected))
        || samePathFamily(item, mediaReference(redirected)))) {
        c8Body.fill(0);
        fail('ORIGINAL_IMAGE_ASSET_REDIRECT_UNOBSERVED', 'The original-image redirect target was not captured from the normal SDK.');
      }
      current.href = redirected.href;
      continue;
    }
    if (response.status !== 200) {
      body.fill(0);
      c8Body.fill(0);
      fail('ORIGINAL_IMAGE_ASSET_HTTP_REJECTED', 'An original-image response returned a non-success status.');
    }
    if (mime.startsWith('text/plain')) {
      const nextText = body.toString('utf8').trim();
      body.fill(0);
      let next;
      try { next = new URL(nextText); }
      catch { c8Body.fill(0); fail('ORIGINAL_IMAGE_TEXT_URL_INVALID', 'A source text/plain response did not contain an HTTPS URL.'); }
      if (next.protocol !== 'https:') {
        c8Body.fill(0);
        fail('ORIGINAL_IMAGE_TEXT_URL_SCHEME_BLOCKED', 'The original-image text chain tried a non-HTTPS URL.');
      }
      next.searchParams.set('alr', 'yes');
      current.href = next.href;
      continue;
    }
    const media = validateMedia(body, mime, 'image');
    finalBody = body;
    finalMime = media.mime;
    finalStatus = response.status;
    break;
  }
  if (!finalBody) {
    c8Body.fill(0);
    fail('ORIGINAL_IMAGE_FETCH_CHAIN_EXHAUSTED', 'The original-image URL chain exceeded its source-observed hop limit.');
  }
  const dimensions = pngDimensions(finalBody);
  const bodySha256 = createHash('sha256').update(finalBody).digest('hex');
  let expected = null;
  if (expectedArtifactPath) {
    const expectedBytes = await (await import('node:fs/promises')).readFile(expectedArtifactPath);
    expected = Object.freeze({
      bytes: expectedBytes.length,
      sha256: createHash('sha256').update(expectedBytes).digest('hex'),
      dimensions: pngDimensions(expectedBytes),
    });
    expectedBytes.fill(0);
  }
  const bytesMatchedExpected = expected === null ? null
    : expected.bytes === finalBody.length && expected.sha256 === bodySha256
      && JSON.stringify(expected.dimensions) === JSON.stringify(dimensions);
  const safeName = typeof artifactName === 'string' && /^[A-Za-z0-9._-]{1,160}\.png$/.test(artifactName);
  if (typeof artifactRoot !== 'string' || !artifactRoot || !safeName) {
    finalBody.fill(0);
    c8Body.fill(0);
    fail('ORIGINAL_IMAGE_OUTPUT_INVALID', 'A bounded output directory and PNG filename are required.');
  }
  const artifact = await saveVerifiedMedia(`${artifactRoot}/${artifactName}`, { body: finalBody, mime: finalMime, kind: 'image' });
  const { readFile } = await import('node:fs/promises');
  const saved = await readFile(artifact.path);
  const independentFileReadback = saved.length === finalBody.length
    && createHash('sha256').update(saved).digest('hex') === bodySha256;
  saved.fill(0);
  const result = Object.freeze({
    outcome: bytesMatchedExpected === true && independentFileReadback ? 'fullsize_direct_http_verified' : 'direct_http_image_downloaded',
    taskBinding: 'hNvQHb_prompt_api_id_route',
    taskPromptMatched: true,
    apiConversationIdMatched: true,
    routeBound: true,
    c8: Object.freeze({
      rpcId: GEMINI_ORIGINAL_IMAGE_RPC_ID,
      httpStatus: c8Response.status,
      contentType: c8Mime,
      responseBytes: c8Body.length,
      xssiPrefix: c8Body.subarray(0, 4).toString('utf8') === ")]}'",
      framing: Object.freeze({
        lengthUnit: parsedC8.lengthUnit,
        frameLengthOverheadUnits: parsedC8.frameLengthOverheadUnits,
        frameCount: parsedC8.frames.length,
      }),
      returnedUrlReference: mediaReference(downloadUrl),
    }),
    originalSizeTransform: Object.freeze({ sourceFunction: 'vPd', setSize: 0, suffixLength: source.suffix.length }),
    asset: Object.freeze({
      hops: Object.freeze(hops), httpStatus: finalStatus, contentType: finalMime,
      bytes: finalBody.length, sha256: bodySha256, dimensions,
      mimeMagicMatched: true, bytesMatchedExpected,
      expectedArtifactBytes: expected?.bytes ?? null,
      expectedArtifactSha256: expected?.sha256 ?? null,
      independentFileReadback,
      artifact,
    }),
    credentialBinding: Object.freeze({
      c8CredentialPropagated: true,
      assetCookieNames: Object.freeze([...new Set(hops.flatMap((hop) => hop.cookieNames))].sort()),
      assetCookieScopesValidated: true,
    }),
    rawValuesPersistedOrPrinted: false,
  });
  finalBody.fill(0);
  c8Body.fill(0);
  downloadUrl = '';
  return result;
}

export function originalImageDownloadContractSummary() {
  return Object.freeze({
    rpcId: GEMINI_ORIGINAL_IMAGE_RPC_ID,
    effect: 'read',
    request: Object.freeze({
      method: 'POST', origin: GEMINI_ORIGIN, path: GEMINI_ORIGINAL_IMAGE_PATH,
      queryKeys: REQUIRED_QUERY_KEYS, bodyFieldNames: REQUIRED_BODY_FIELDS,
    }),
    response: Object.freeze({
      contentType: 'application/json', xssiPrefix: true, framing: 'batchexecute',
      frameLengthUnit: GEMINI_ORIGINAL_IMAGE_C8_FRAME_LENGTH_UNIT,
      frameLengthOverheadUnits: GEMINI_ORIGINAL_IMAGE_C8_FRAME_LENGTH_OVERHEAD,
      data: 'one https download URL, followed by normal-SDK vPd size-zero transform and dO text/plain URL chain',
    }),
    taskBinding: 'hNvQHb_prompt_api_id_route',
    sourcePreparationRequired: true,
  });
}
