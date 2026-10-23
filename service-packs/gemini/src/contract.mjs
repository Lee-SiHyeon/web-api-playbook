import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATION_NAMES, SERVICE_ID, SERVICE_ORIGIN } from './constants.mjs';
import { GeminiClientError } from './errors.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONTRACT_PATH = path.join(REPO_ROOT, 'discovery', 'observed-contract.json');
const METHODS = new Set(['GET', 'POST']);
const FRAMINGS = new Set(['json', 'batchexecute', 'text', 'binary']);
const FRAME_LENGTH_UNITS = new Set(['utf16_code_units', 'bytes']);
const GEMINI_UPLOAD_REQUIRED_START_MAP_HEADERS = Object.freeze(['push-id', 'x-client-pctx', 'x-tenant-id']);
const GEMINI_UPLOAD_SOURCE_EFFECTIVE_HEADER_NAMES = Object.freeze(['content-type']);
const GEMINI_UPLOAD_SOURCE_EFFECTIVE_HEADER_VALUES = Object.freeze({
  'content-type': 'application/x-www-form-urlencoded',
});
const GEMINI_UPLOAD_SOURCE_EFFECTIVE_HEADER_VALUE_SOURCE = 'xhr_transport_default_content_type';
const GEMINI_UPLOAD_OPTIONAL_BROWSER_HEADERS = Object.freeze([
  'accept', 'origin', 'referer', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
  'sec-ch-ua-form-factors', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile',
  'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
]);
const GEMINI_UPLOAD_SOURCE_BUNDLE_SHA256 = '3137eb01bfe212ddc5b7df423acd9c9633537f528a0cd13a07c25e075495e7aa';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/.test(value);
}

function validFieldName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.~-]{0,150}$/.test(value);
}

function validHeaderName(value) {
  return typeof value === 'string' && /^[!#$%&'*+.^_~0-9A-Za-z-]+$/.test(value);
}

function validRpcArgsTemplate(value, depth = 0) {
  if (depth > 16) return false;
  if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value)) return true;
  if (typeof value === 'string') return /^\{\{[A-Za-z][A-Za-z0-9]{0,63}\}\}$/.test(value);
  if (isRecord(value)) {
    return Object.keys(value).length === 1 && typeof value.$literal === 'string'
      && /^[A-Za-z0-9_-]{1,16}$/.test(value.$literal);
  }
  return Array.isArray(value) && value.length <= 128
    && value.every((child) => validRpcArgsTemplate(child, depth + 1));
}

function parseOrigin(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new GeminiClientError('CONTRACT_INVALID', label + ' is not a URL origin.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new GeminiClientError('CONTRACT_INVALID', label + ' must be an HTTPS origin without a path.');
  }
  return parsed.origin;
}

function uniqueNames(values, validator, label) {
  if (!Array.isArray(values)) throw new GeminiClientError('CONTRACT_INVALID', label + ' must be an array.');
  const normalized = values.map((value) => {
    if (!validator(value)) throw new GeminiClientError('CONTRACT_INVALID', label + ' contains an invalid name.');
    return value;
  });
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    throw new GeminiClientError('CONTRACT_INVALID', label + ' contains duplicate names.');
  }
  return normalized;
}

function validateOperation(name, operation, assets) {
  if (!OPERATION_NAMES.includes(name) || !isRecord(operation)) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The contract contains an unsupported capability.');
  }
  const pairedObservation = operation.observation?.requestResponse === true;
  const requestOnlyObservation = operation.observation?.request === true && operation.observation?.requestResponse === false;
  if (!pairedObservation && !requestOnlyObservation) {
    throw new GeminiClientError('CONTRACT_NOT_CAPTURED', 'Operation ' + name + ' lacks a paired browser request and response observation.');
  }
  const request = operation.request;
  const response = operation.response;
  if (!isRecord(request) || (pairedObservation && !isRecord(response)) || (requestOnlyObservation && response !== undefined)) {
    throw new GeminiClientError('CONTRACT_INVALID', 'Operation ' + name + ' is missing or prematurely includes response details.');
  }
  if (!METHODS.has(request.method)) throw new GeminiClientError('CONTRACT_UNSUPPORTED_METHOD', 'Operation ' + name + ' uses a method not enabled by this scaffold.');
  const origin = parseOrigin(request.origin, 'request.origin');
  if (origin !== SERVICE_ORIGIN) throw new GeminiClientError('CONTRACT_ORIGIN_MISMATCH', 'Gemini API requests must stay on the captured Gemini web origin.');
  if (typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//')
      || request.path.includes('#') || request.path.includes('?') || request.path.includes('\\')) {
    throw new GeminiClientError('CONTRACT_INVALID', 'Operation ' + name + ' must use an observed absolute path without query or fragment.');
  }
  const queryKeys = uniqueNames(request.queryKeys ?? [], validFieldName, 'request.queryKeys');
  const headerNames = uniqueNames(request.headerNames ?? [], validHeaderName, 'request.headerNames');
  const bodyFieldNames = request.bodyFieldNames === undefined
    ? undefined
    : uniqueNames(request.bodyFieldNames, validFieldName, 'request.bodyFieldNames');
  if (request.rpcId !== undefined && !/^[A-Za-z0-9_-]{3,24}$/.test(request.rpcId)) {
    throw new GeminiClientError('CONTRACT_INVALID', 'Operation ' + name + ' has an invalid captured RPC identifier.');
  }
  if (request.rpcArgsTemplate !== undefined
      && (!Array.isArray(request.rpcArgsTemplate) || !validRpcArgsTemplate(request.rpcArgsTemplate))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'Operation ' + name + ' has an invalid RPC argument template.');
  }
  if (headerNames.some((header) => ['cookie', 'authorization', 'proxy-authorization', 'host'].includes(header.toLowerCase()))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'Credential and routing headers cannot be supplied as static request headers.');
  }
  if (typeof request.contentType !== 'string' && request.method !== 'GET') {
    throw new GeminiClientError('CONTRACT_INVALID', 'A captured write request must include its observed content type.');
  }
  if (pairedObservation) {
    if (!FRAMINGS.has(response.framing) || typeof response.contentType !== 'string') {
      throw new GeminiClientError('CONTRACT_INVALID', 'Operation ' + name + ' is missing a supported observed response decoder.');
    }
    if (response.selector !== undefined && response.selector !== 'null') {
      throw new GeminiClientError('CONTRACT_INVALID', 'A batchexecute response selector must be an observed RPC identifier or the observed null selector.');
    }
    if (response.framing === 'batchexecute'
        && response.selector !== 'null'
        && (typeof response.rpcId !== 'string' || !response.rpcId)) {
      throw new GeminiClientError('CONTRACT_INVALID', 'A batchexecute response must name its observed RPC identifier or selector.');
    }
    if (response.selector === 'null' && response.rpcId !== undefined) {
      throw new GeminiClientError('CONTRACT_INVALID', 'A null-selector response cannot also declare an RPC identifier.');
    }
    if (response.framing === 'batchexecute'
        && (!FRAME_LENGTH_UNITS.has(response.frameLengthUnit)
          || !Number.isSafeInteger(response.frameLengthOverheadUnits) || response.frameLengthOverheadUnits < 0 || response.frameLengthOverheadUnits > 8
          || (response.frameLengthUnit === 'bytes' && response.frameLengthOverheadUnits !== 0))) {
      throw new GeminiClientError('CONTRACT_INVALID', 'A batchexecute response must declare its observed frame length unit and overhead.');
    }
    if (request.rpcId !== undefined && response.rpcId !== request.rpcId) {
      throw new GeminiClientError('CONTRACT_INVALID', 'The captured RPC request and response identifiers do not match.');
    }
  }
  if (!['read', 'mutation'].includes(operation.effect)) {
    throw new GeminiClientError('CONTRACT_INVALID', 'Operation ' + name + ' must declare its observed side-effect class.');
  }
  if (operation.effect === 'mutation' && operation.retryPolicy !== 'never') {
    throw new GeminiClientError('CONTRACT_INVALID', 'Mutating operations must explicitly disable automatic retries.');
  }
  if (operation.assetOrigin != null && !assets.includes(parseOrigin(operation.assetOrigin, 'assetOrigin'))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'An operation asset origin must appear in the observed asset origin allowlist.');
  }
  return Object.freeze({
    ...operation,
    request: Object.freeze({
      ...request,
      origin,
      queryKeys: Object.freeze(queryKeys),
      headerNames: Object.freeze(headerNames),
      ...(bodyFieldNames ? { bodyFieldNames: Object.freeze(bodyFieldNames) } : {}),
    }),
    ...(pairedObservation ? { response: Object.freeze({ ...response }) } : {}),
  });
}

function validateAssetRef(input, label) {
  if (!isRecord(input) || typeof input.origin !== 'string' || typeof input.pathFamily !== 'string'
      || !input.pathFamily.startsWith('/') || input.pathFamily.includes('\\') || input.pathFamily.includes('?')
      || input.pathFamily.includes('#') || !Array.isArray(input.queryKeyNames)) {
    throw new GeminiClientError('CONTRACT_INVALID', `${label} is malformed.`);
  }
  const origin = parseOrigin(input.origin, `${label}.origin`);
  const queryKeyNames = uniqueNames(input.queryKeyNames, validFieldName, `${label}.queryKeyNames`);
  const segments = input.pathFamily.split('/').slice(1);
  if (segments.some((segment) => !segment || (segment !== '{id}' && !/^[A-Za-z0-9._~-]{1,80}$/.test(segment)))) {
    throw new GeminiClientError('CONTRACT_INVALID', `${label}.pathFamily is malformed.`);
  }
  return Object.freeze({ origin, pathFamily: input.pathFamily, queryKeyNames: Object.freeze(queryKeyNames) });
}

function validateMediaAssetDownload(input, assetOrigins) {
  if (input === undefined) return undefined;
  if (!isRecord(input) || input.version !== 1 || input.taskBinding !== 'hNvQHb_prompt_and_api_id'
      || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 4
      || !Array.isArray(input.redirectEdges) || input.redirectEdges.length > 3
      || !Array.isArray(input.cookieScopes) || !Array.isArray(input.excludedCandidates)) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The media asset download contract is malformed.');
  }
  const sources = input.sources.map((source) => {
    if (!isRecord(source) || !['image', 'video'].includes(source.capability)
        || !Array.isArray(source.mimeTypes) || source.mimeTypes.length < 1
        || source.mimeTypes.some((mime) => typeof mime !== 'string' || !/^(?:image|video)\/[a-z0-9.+-]+$/.test(mime))) {
      throw new GeminiClientError('CONTRACT_INVALID', 'A media asset source entry is malformed.');
    }
    const ref = validateAssetRef(source, 'mediaAssetDownload.sources[]');
    if (!assetOrigins.includes(ref.origin)) {
      throw new GeminiClientError('CONTRACT_INVALID', 'A media asset source origin is not in the observed asset allowlist.');
    }
    const headerNames = uniqueNames(source.headerNames ?? [], validHeaderName, 'mediaAssetDownload.sources[].headerNames');
    return Object.freeze({
      capability: source.capability,
      ...ref,
      mimeTypes: Object.freeze([...new Set(source.mimeTypes.map((mime) => mime.toLowerCase()))]),
      headerNames: Object.freeze(headerNames.map((name) => name.toLowerCase())),
    });
  });
  const redirectEdges = input.redirectEdges.map((edge) => {
    if (!isRecord(edge) || !Number.isInteger(edge.httpStatus) || edge.httpStatus < 300 || edge.httpStatus > 399
        || !['same_terminal_resource_segment_and_query', 'task_bound_source_reference_with_observed_path_family'].includes(edge.resourceIdentity)
        || !Array.isArray(edge.cookieNames) || !Array.isArray(edge.headerNames)) {
      throw new GeminiClientError('CONTRACT_INVALID', 'A media asset redirect edge is malformed.');
    }
    const from = validateAssetRef(edge.from, 'mediaAssetDownload.redirectEdges[].from');
    const to = validateAssetRef(edge.to, 'mediaAssetDownload.redirectEdges[].to');
    if (!assetOrigins.includes(from.origin) || !assetOrigins.includes(to.origin)) {
      throw new GeminiClientError('CONTRACT_INVALID', 'A media asset redirect origin is not in the observed asset allowlist.');
    }
    const cookieNames = uniqueNames(edge.cookieNames, validName, 'mediaAssetDownload.redirectEdges[].cookieNames');
    const headerNames = uniqueNames(edge.headerNames, validHeaderName, 'mediaAssetDownload.redirectEdges[].headerNames');
    return Object.freeze({
      httpStatus: edge.httpStatus, from, to, resourceIdentity: edge.resourceIdentity,
      cookieNames: Object.freeze(cookieNames), headerNames: Object.freeze(headerNames.map((name) => name.toLowerCase())),
    });
  });
  const cookieScopes = input.cookieScopes.map((scope) => {
    if (!isRecord(scope) || !validName(scope.name) || scope.domain !== '.google.com'
        || scope.path !== '/' || typeof scope.secure !== 'boolean') {
      throw new GeminiClientError('CONTRACT_INVALID', 'A media session cookie scope is malformed.');
    }
    return Object.freeze({ name: scope.name, domain: scope.domain, path: scope.path, secure: scope.secure });
  });
  if (new Set(cookieScopes.map((scope) => scope.name)).size !== cookieScopes.length) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The media session cookie contract contains duplicate names.');
  }
  const cookieNames = new Set(cookieScopes.map((scope) => scope.name));
  if (redirectEdges.some((edge) => edge.cookieNames.some((name) => !cookieNames.has(name)))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'A media redirect asks for a cookie without a scoped current-session rule.');
  }
  const excludedCandidates = input.excludedCandidates.map((entry) => {
    if (!isRecord(entry) || typeof entry.mimeType !== 'string') {
      throw new GeminiClientError('CONTRACT_INVALID', 'A media asset exclusion is malformed.');
    }
    return Object.freeze({ ...validateAssetRef(entry, 'mediaAssetDownload.excludedCandidates[]'), mimeType: entry.mimeType.toLowerCase() });
  });
  return Object.freeze({
    version: 1,
    taskBinding: input.taskBinding,
    sources: Object.freeze(sources),
    redirectEdges: Object.freeze(redirectEdges),
    cookieScopes: Object.freeze(cookieScopes),
    excludedCandidates: Object.freeze(excludedCandidates),
    resolution: Object.freeze({
      semantics: typeof input.resolution?.semantics === 'string' ? input.resolution.semantics : 'unverified',
      observedWidth: Number.isSafeInteger(input.resolution?.observedWidth) ? input.resolution.observedWidth : null,
      observedHeight: Number.isSafeInteger(input.resolution?.observedHeight) ? input.resolution.observedHeight : null,
    }),
  });
}

function validateAttachmentUpload(input) {
  if (input === undefined) return undefined;
  if (!isRecord(input) || input.version !== 1 || input.capability !== 'attachment_upload'
      || !isRecord(input.source) || !isRecord(input.resumable)) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The attachment upload contract is malformed.');
  }
  const source = input.source;
  const origin = parseOrigin(source.origin, 'attachmentUpload.source.origin');
  const headerNames = uniqueNames(source.headerNames ?? [], validHeaderName, 'attachmentUpload.source.headerNames');
  const cookieNames = uniqueNames(source.cookieNames ?? [], validName, 'attachmentUpload.source.cookieNames');
  const queryKeyNames = uniqueNames(source.queryKeyNames ?? [], validFieldName, 'attachmentUpload.source.queryKeyNames');
  if (origin !== 'https://push.clients6.google.com' || source.method !== 'POST'
      || source.pathFamily !== '/upload/' || source.contentType !== 'application/x-www-form-urlencoded'
      || source.startProtocol !== 'resumable' || source.startCommand !== 'start'
      || source.fileLengthHeader !== 'x-goog-upload-header-content-length'
      || typeof source.metadataBodyPrefix !== 'string' || source.metadataBodyPrefix.length < 1 || source.metadataBodyPrefix.length > 80
      || !headerNames.some((name) => name.toLowerCase() === 'cookie')
      || !['accept', 'content-type', 'origin', 'referer', 'user-agent', 'push-id', 'x-client-pctx', 'x-tenant-id',
        'x-goog-upload-command', 'x-goog-upload-header-content-length', 'x-goog-upload-protocol']
        .every((name) => headerNames.some((actual) => actual.toLowerCase() === name))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The attachment upload start request does not match its captured source contract.');
  }
  const cookieScopes = source.cookieScopes;
  if (!Array.isArray(cookieScopes) || cookieScopes.length !== cookieNames.length) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The attachment upload cookie scopes are incomplete.');
  }
  const scopeByName = new Map();
  for (const scope of cookieScopes) {
    if (!isRecord(scope) || !cookieNames.includes(scope.name) || scope.domain !== '.google.com'
        || scope.path !== '/' || typeof scope.secure !== 'boolean' || scopeByName.has(scope.name)) {
      throw new GeminiClientError('CONTRACT_INVALID', 'An attachment upload cookie scope is malformed.');
    }
    scopeByName.set(scope.name, Object.freeze({
      name: scope.name, domain: scope.domain, path: scope.path, secure: scope.secure,
    }));
  }
  const resumable = input.resumable;
  if (resumable.startSuccessStatus !== 200 || resumable.uploadUrlHeader !== 'x-goog-upload-url'
      || !Array.isArray(resumable.uploadUrlOrigins) || !Array.isArray(resumable.uploadUrlPathPrefixes)
      || resumable.uploadMethod !== 'POST' || resumable.commandHeader !== 'x-goog-upload-command'
      || resumable.finalizeCommand !== 'upload, finalize' || resumable.querySupported !== true
      || resumable.queryMethod !== 'POST' || resumable.queryCommand !== 'query'
      || resumable.uploadStatusHeader !== 'x-goog-upload-status'
      || resumable.sizeReceivedHeader !== 'x-goog-upload-size-received'
      || resumable.chunkGranularityHeader !== 'x-goog-upload-chunk-granularity'
      || typeof resumable.resumeSupported !== 'boolean' || resumable.offsetHeader !== 'x-goog-upload-offset'
      || typeof resumable.cancelSupported !== 'boolean' || typeof resumable.protocolSource !== 'string'
      || (resumable.cancelSupported === true && (resumable.cancelMethod !== 'POST'
        || resumable.cancelCommand !== 'cancel'
        || !Array.isArray(resumable.cancelEligibleStates)
        || !resumable.cancelEligibleStates.includes('Upload')
        || !resumable.cancelEligibleStates.includes('Query')))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The attachment upload resumable protocol contract is malformed.');
  }
  const uploadUrlOrigins = uniqueNames(resumable.uploadUrlOrigins, (value) => {
    try { return parseOrigin(value, 'attachmentUpload.resumable.uploadUrlOrigins[]') === value; } catch { return false; }
  }, 'attachmentUpload.resumable.uploadUrlOrigins');
  if (!uploadUrlOrigins.includes(origin)) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The upload session URL origin is outside the captured upload origin.');
  }
  const uploadUrlPathPrefixes = resumable.uploadUrlPathPrefixes.map((prefix) => {
    if (typeof prefix !== 'string' || !prefix.startsWith('/') || prefix.includes('..') || prefix.includes('?') || prefix.includes('#')) {
      throw new GeminiClientError('CONTRACT_INVALID', 'An upload session path prefix is malformed.');
    }
    return prefix;
  });
  if (!uploadUrlPathPrefixes.length) throw new GeminiClientError('CONTRACT_INVALID', 'An upload session path prefix is required.');
  let nativeContinuation;
  if (resumable.nativeContinuation !== undefined) {
    const inputContinuation = resumable.nativeContinuation;
    if (!isRecord(inputContinuation) || inputContinuation.method !== 'POST'
        || inputContinuation.commandHeader !== resumable.commandHeader
        || inputContinuation.commandValue !== resumable.finalizeCommand
        || inputContinuation.offsetHeader !== resumable.offsetHeader
        || inputContinuation.initialOffset !== 0
        || inputContinuation.bodySemantics !== 'selected_file_bytes') {
      throw new GeminiClientError('CONTRACT_INVALID', 'The captured native upload continuation is malformed.');
    }
    if (inputContinuation.contentType !== undefined
        && (typeof inputContinuation.contentType !== 'string'
          || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=._-]+)*$/.test(inputContinuation.contentType))) {
      throw new GeminiClientError('CONTRACT_INVALID', 'The native upload continuation content type is malformed.');
    }
    if (inputContinuation.headerValueSource !== undefined
        && inputContinuation.headerValueSource !== 'start_request_custom_header_map') {
      throw new GeminiClientError('CONTRACT_INVALID', 'The native continuation header value source is unobserved.');
    }
    const continuationHeaderNames = uniqueNames(
      inputContinuation.headerNames ?? [], validHeaderName, 'attachmentUpload.resumable.nativeContinuation.headerNames',
    );
    const continuationCookieNames = uniqueNames(
      inputContinuation.cookieNames ?? [], validName, 'attachmentUpload.resumable.nativeContinuation.cookieNames',
    );
    if (!continuationHeaderNames.includes(inputContinuation.commandHeader)
        || !continuationHeaderNames.includes(inputContinuation.offsetHeader)
        || continuationCookieNames.some((name) => !cookieNames.includes(name))) {
      throw new GeminiClientError('CONTRACT_INVALID', 'The captured upload continuation fields are outside the source contract.');
    }
    let headerValuePolicy;
    if (inputContinuation.headerValuePolicy !== undefined) {
      const inputPolicy = inputContinuation.headerValuePolicy;
      if (!isRecord(inputPolicy) || inputPolicy.sourceBundleSha256 !== GEMINI_UPLOAD_SOURCE_BUNDLE_SHA256
          || inputPolicy.sourceFunction !== 'oF.Lsc' || inputPolicy.headerMapExpression !== 'a.Ja'
          || inputPolicy.optionalDirectValuePolicy !== 'current_start_request_custom_header_map_value'
          || inputPolicy.optionalNativeValuePolicy !== 'allow_captured_browser_variation'
          || inputPolicy.transportFunction !== 'Hsc.send'
          || inputPolicy.sourceEffectiveHeaderValueSource !== GEMINI_UPLOAD_SOURCE_EFFECTIVE_HEADER_VALUE_SOURCE
          || inputContinuation.contentType !== GEMINI_UPLOAD_SOURCE_EFFECTIVE_HEADER_VALUES['content-type']
          || !Array.isArray(inputPolicy.exactBindingFields)
          || inputPolicy.exactBindingFields.join(',') !== 'url,method,command,offset,selected_file_bytes') {
        throw new GeminiClientError('CONTRACT_INVALID', 'The native upload continuation header-value source policy is malformed.');
      }
      const requiredStartMapHeaderNames = uniqueNames(inputPolicy.requiredStartMapHeaderNames ?? [], validHeaderName,
        'attachmentUpload.resumable.nativeContinuation.headerValuePolicy.requiredStartMapHeaderNames')
        .map((name) => name.toLowerCase());
      const sourceEffectiveHeaderNames = uniqueNames(inputPolicy.sourceEffectiveHeaderNames ?? [], validHeaderName,
        'attachmentUpload.resumable.nativeContinuation.headerValuePolicy.sourceEffectiveHeaderNames')
        .map((name) => name.toLowerCase());
      const sourceEffectiveHeaderValues = inputPolicy.sourceEffectiveHeaderValues;
      if (!isRecord(sourceEffectiveHeaderValues)
          || JSON.stringify(Object.keys(sourceEffectiveHeaderValues).sort()) !== JSON.stringify([...sourceEffectiveHeaderNames].sort())
          || sourceEffectiveHeaderNames.some((name) => typeof sourceEffectiveHeaderValues[name] !== 'string'
            || sourceEffectiveHeaderValues[name] !== GEMINI_UPLOAD_SOURCE_EFFECTIVE_HEADER_VALUES[name])) {
        throw new GeminiClientError('CONTRACT_INVALID', 'The source-effective continuation header values are malformed.');
      }
      const optionalBrowserManagedHeaderNames = uniqueNames(inputPolicy.optionalBrowserManagedHeaderNames ?? [], validHeaderName,
        'attachmentUpload.resumable.nativeContinuation.headerValuePolicy.optionalBrowserManagedHeaderNames')
        .map((name) => name.toLowerCase());
      const protocolManagedHeaderNames = uniqueNames(inputPolicy.protocolManagedHeaderNames ?? [], validHeaderName,
        'attachmentUpload.resumable.nativeContinuation.headerValuePolicy.protocolManagedHeaderNames')
        .map((name) => name.toLowerCase());
      const expectedProtocolNames = [inputContinuation.commandHeader.toLowerCase(), inputContinuation.offsetHeader.toLowerCase()].sort();
      const classifiedHeaderNames = [...requiredStartMapHeaderNames, ...sourceEffectiveHeaderNames,
        ...optionalBrowserManagedHeaderNames, ...protocolManagedHeaderNames];
      const expectedClassifiedHeaderNames = continuationHeaderNames.filter((name) => name.toLowerCase() !== 'cookie').map((name) => name.toLowerCase()).sort();
      if (JSON.stringify([...protocolManagedHeaderNames].sort()) !== JSON.stringify(expectedProtocolNames)
          || new Set(classifiedHeaderNames).size !== classifiedHeaderNames.length
          || JSON.stringify([...classifiedHeaderNames].sort()) !== JSON.stringify(expectedClassifiedHeaderNames)
          || JSON.stringify(requiredStartMapHeaderNames)
            !== JSON.stringify([...GEMINI_UPLOAD_REQUIRED_START_MAP_HEADERS].sort())
          || JSON.stringify(sourceEffectiveHeaderNames)
            !== JSON.stringify([...GEMINI_UPLOAD_SOURCE_EFFECTIVE_HEADER_NAMES].sort())
          || JSON.stringify(optionalBrowserManagedHeaderNames)
            !== JSON.stringify([...GEMINI_UPLOAD_OPTIONAL_BROWSER_HEADERS].sort())) {
        throw new GeminiClientError('CONTRACT_INVALID', 'The source-required, source-effective, protocol-managed, and browser-managed upload header sets do not partition the captured continuation.');
      }
      headerValuePolicy = Object.freeze({
        sourceBundleSha256: inputPolicy.sourceBundleSha256,
        sourceFunction: inputPolicy.sourceFunction,
        headerMapExpression: inputPolicy.headerMapExpression,
        transportFunction: inputPolicy.transportFunction,
        requiredStartMapHeaderNames: Object.freeze(requiredStartMapHeaderNames),
        sourceEffectiveHeaderNames: Object.freeze(sourceEffectiveHeaderNames),
        sourceEffectiveHeaderValues: Object.freeze({ ...sourceEffectiveHeaderValues }),
        sourceEffectiveHeaderValueSource: inputPolicy.sourceEffectiveHeaderValueSource,
        protocolManagedHeaderNames: Object.freeze(protocolManagedHeaderNames),
        optionalBrowserManagedHeaderNames: Object.freeze(optionalBrowserManagedHeaderNames),
        optionalDirectValuePolicy: inputPolicy.optionalDirectValuePolicy,
        optionalNativeValuePolicy: inputPolicy.optionalNativeValuePolicy,
        exactBindingFields: Object.freeze([...inputPolicy.exactBindingFields]),
      });
    }
    nativeContinuation = Object.freeze({
      method: inputContinuation.method,
      headerNames: Object.freeze(continuationHeaderNames.map((name) => name.toLowerCase())),
      cookieNames: Object.freeze(continuationCookieNames),
      commandHeader: inputContinuation.commandHeader.toLowerCase(),
      commandValue: inputContinuation.commandValue,
      offsetHeader: inputContinuation.offsetHeader.toLowerCase(),
      initialOffset: 0,
      bodySemantics: inputContinuation.bodySemantics,
      ...(inputContinuation.headerValueSource === 'start_request_custom_header_map'
        ? { headerValueSource: inputContinuation.headerValueSource } : {}),
      ...(headerValuePolicy ? { headerValuePolicy } : {}),
      ...(inputContinuation.contentType !== undefined ? { contentType: inputContinuation.contentType } : {}),
    });
  }
  return Object.freeze({
    version: 1,
    capability: 'attachment_upload',
    source: Object.freeze({
      origin,
      method: source.method,
      pathFamily: source.pathFamily,
      queryKeyNames: Object.freeze(queryKeyNames),
      contentType: source.contentType,
      metadataBodyPrefix: source.metadataBodyPrefix,
      startProtocol: source.startProtocol,
      startCommand: source.startCommand,
      fileLengthHeader: source.fileLengthHeader,
      headerNames: Object.freeze(headerNames.map((name) => name.toLowerCase())),
      cookieNames: Object.freeze(cookieNames),
      cookieScopes: Object.freeze([...scopeByName.values()]),
    }),
    resumable: Object.freeze({
      ...resumable,
      uploadUrlOrigins: Object.freeze(uploadUrlOrigins),
      uploadUrlPathPrefixes: Object.freeze(uploadUrlPathPrefixes),
      ...(nativeContinuation ? { nativeContinuation } : {}),
    }),
  });
}

export function validateObservedContract(input) {
  if (!isRecord(input) || input.version !== 1 || input.service !== SERVICE_ID) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The captured contract has an unsupported service or version.');
  }
  if (input.origin !== SERVICE_ORIGIN) throw new GeminiClientError('CONTRACT_ORIGIN_MISMATCH', 'The captured contract is not scoped to Gemini web.');
  if (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The captured contract must include its observation time.');
  }
  const auth = input.auth;
  if (!isRecord(auth) || auth.origins?.length !== 1 || auth.origins[0] !== SERVICE_ORIGIN) {
    throw new GeminiClientError('CONTRACT_INVALID', 'Persisted credentials must be scoped to the observed Gemini web origin.');
  }
  const cookieNames = uniqueNames(auth.cookieNames ?? [], validName, 'auth.cookieNames');
  const headerNames = uniqueNames(auth.headerNames ?? [], validHeaderName, 'auth.headerNames');
  if (headerNames.some((name) => ['cookie', 'set-cookie', 'host', 'content-length'].includes(name.toLowerCase()))) {
    throw new GeminiClientError('CONTRACT_INVALID', 'The authentication header allowlist contains a forbidden transport header.');
  }
  const assets = uniqueNames(input.assetOrigins ?? [], (value) => {
    try { return parseOrigin(value, 'assetOrigins[]') === value; } catch { return false; }
  }, 'assetOrigins');
  const rawOperations = input.operations;
  if (!isRecord(rawOperations)) throw new GeminiClientError('CONTRACT_INVALID', 'The captured contract must contain an operations map.');
  const operations = {};
  for (const [name, operation] of Object.entries(rawOperations)) {
    operations[name] = validateOperation(name, operation, assets);
  }
  const mediaAssetDownload = validateMediaAssetDownload(input.mediaAssetDownload, assets);
  const attachmentUpload = validateAttachmentUpload(input.attachmentUpload);
  return Object.freeze({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: input.observedAt,
    auth: Object.freeze({
      origins: Object.freeze([SERVICE_ORIGIN]),
      cookieNames: Object.freeze(cookieNames),
      headerNames: Object.freeze(headerNames),
    }),
    assetOrigins: Object.freeze(assets),
    ...(mediaAssetDownload ? { mediaAssetDownload } : {}),
    ...(attachmentUpload ? { attachmentUpload } : {}),
    operations: Object.freeze(operations),
  });
}

export async function loadObservedContract(contractPath = DEFAULT_CONTRACT_PATH) {
  let source;
  try { source = await readFile(contractPath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new GeminiClientError('CONTRACT_NOT_CAPTURED', 'No observed Gemini web contract is installed.');
    throw new GeminiClientError('CONTRACT_UNREADABLE', 'The observed Gemini web contract could not be read.');
  }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { throw new GeminiClientError('CONTRACT_INVALID', 'The observed Gemini web contract is not valid JSON.'); }
  return validateObservedContract(parsed);
}

export function requireCapturedOperation(contract, capability) {
  if (!OPERATION_NAMES.includes(capability)) {
    throw new GeminiClientError('OPERATION_UNSUPPORTED', 'The requested Gemini capability is not in the client catalog.');
  }
  const operation = contract?.operations?.[capability];
  if (!operation || operation.observation?.requestResponse !== true) {
    throw new GeminiClientError('CONTRACT_NOT_CAPTURED', 'No observed Gemini contract is installed for ' + capability + '.');
  }
  return operation;
}

export function requireCapturedRequestOperation(contract, operationName) {
  if (!OPERATION_NAMES.includes(operationName)) {
    throw new GeminiClientError('OPERATION_UNSUPPORTED', 'The requested Gemini operation is not in the client catalog.');
  }
  const operation = contract?.operations?.[operationName];
  if (!operation || operation.observation?.request !== true) {
    throw new GeminiClientError('CONTRACT_NOT_CAPTURED', 'No current browser request capture is installed for ' + operationName + '.');
  }
  return operation;
}
