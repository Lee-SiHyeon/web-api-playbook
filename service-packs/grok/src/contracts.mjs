import { fail } from './errors.mjs';
import { MAX_DIRECT_MULTIPART_BASE64_LENGTH, MAX_DIRECT_MULTIPART_BODY_BYTES } from './grok-attachment-constants.mjs';

const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const HEADER_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TOKEN_PATTERN = /^\{\{input\.([A-Za-z][A-Za-z0-9_.-]{0,127})\}\}$/;
const CONTROL_HEADER_PATTERN = /(?:signature|integrity|challenge|captcha|proof|hmac|attestation)/i;
const SECRET_QUERY_PATTERN = /(?:access.?token|refresh.?token|signature|sig|secret|session|cookie|auth|nonce|challenge|api.?key)/i;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_KINDS = new Set(['read', 'submit', 'poll', 'download']);
const ALLOWED_RESPONSE_MODES = new Set(['json', 'sse', 'ndjson', 'bytes']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verifiedUploadInitIssuance(operation) {
  const evidence = operation?.evidence;
  const proof = evidence?.resourceIssuance;
  return operation?.id === 'attachment.upload.init' && operation?.kind === 'submit'
    && operation?.effect === 'file_upload' && evidence?.source === 'first_party_sdk_contract'
    && evidence?.resourceIssuedResponseVerified === true
    && plainObject(proof) && proof.verificationKind === 'validated_init_resource_response'
    && typeof proof.proofPath === 'string' && proof.proofPath.startsWith('verification/')
    && /^[a-f0-9]{64}$/.test(proof.proofSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(proof.ownerScopeSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(proof.issuedUploadIdSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(proof.issuedAssetIdSha256 ?? '');
}

function validateOrigin(value, code = 'CONTRACT_ORIGIN_INVALID') {
  if (typeof value !== 'string') throw fail(code);
  let url;
  try { url = new URL(value); } catch { throw fail(code); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || url.origin !== value) throw fail(code);
  return url.origin;
}

function safeMethod(method) {
  return typeof method === 'string' && ALLOWED_METHODS.has(method.toUpperCase());
}

function templatePath(value) {
  return typeof value === 'string'
    ? value.replace(/\{\{input\.([A-Za-z][A-Za-z0-9_.-]{0,127})\}\}/g, '__grok_input_segment__')
    : value;
}

function validJsonPointer(value) {
  return typeof value === 'string' && (value === '' || (value.startsWith('/') && !/(~(?![01]))/.test(value)));
}

function validateInputSchema(schema, depth = 0) {
  if (depth > 8 || !plainObject(schema) || !plainObject(schema.properties)) throw fail('CONTRACT_INPUT_SCHEMA_INVALID');
  const allowedTypes = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);
  const validateRule = (rule, ruleDepth) => {
    if (!plainObject(rule) || !allowedTypes.has(rule.type)) throw fail('CONTRACT_INPUT_SCHEMA_INVALID');
    if (rule.type === 'object') validateInputSchema(rule, ruleDepth + 1);
    if (rule.type === 'array') {
      if (!plainObject(rule.items) || !allowedTypes.has(rule.items.type)) throw fail('CONTRACT_INPUT_SCHEMA_INVALID');
      if (rule.items.type === 'object') validateInputSchema(rule.items, ruleDepth + 1);
    }
    if (rule.enum && (!Array.isArray(rule.enum) || rule.enum.some(item => typeof item !== 'string' && typeof item !== 'number'))) {
      throw fail('CONTRACT_INPUT_SCHEMA_INVALID');
    }
  };
  for (const [name, rule] of Object.entries(schema.properties)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)) throw fail('CONTRACT_INPUT_SCHEMA_INVALID');
    validateRule(rule, depth);
  }
  if (schema.additionalProperties !== undefined) validateRule(schema.additionalProperties, depth);
  if (schema.required !== undefined && (!Array.isArray(schema.required)
    || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)))) {
    throw fail('CONTRACT_INPUT_SCHEMA_INVALID');
  }
}

function validateTemplate(template, depth = 0) {
  if (depth > 24) throw fail('CONTRACT_TEMPLATE_TOO_DEEP');
  if (typeof template === 'string') {
    if (template.includes('{{') || template.includes('}}')) {
      if (!TOKEN_PATTERN.test(template)) throw fail('CONTRACT_TEMPLATE_INVALID');
    }
    return;
  }
  if (Array.isArray(template)) {
    for (const item of template) validateTemplate(item, depth + 1);
    return;
  }
  if (plainObject(template)) {
    for (const [key, value] of Object.entries(template)) {
      if (key.length > 128 || /[\r\n\0]/.test(key)) throw fail('CONTRACT_TEMPLATE_INVALID');
      validateTemplate(value, depth + 1);
    }
    return;
  }
  if (template !== null && !['string', 'number', 'boolean'].includes(typeof template)) throw fail('CONTRACT_TEMPLATE_INVALID');
}

function validateOperation(operation, allowedOrigins) {
  if (!plainObject(operation) || !ID_PATTERN.test(operation.id) || !ALLOWED_KINDS.has(operation.kind)
    || !safeMethod(operation.method) || operation.method !== operation.method.toUpperCase()) throw fail('CONTRACT_OPERATION_INVALID');
  const evidence = operation.evidence;
  const firstPartySourcePending = plainObject(evidence) && evidence.source === 'first_party_sdk_contract'
    && evidence.httpStatus === null && evidence.responseContentType === 'unknown'
    && ((operation.kind === 'submit' && evidence.firstLiveReplayPermit === true)
      || (operation.kind === 'read' && evidence.firstLiveReadPermit === true));
  if (!plainObject(evidence) || !['browser_network_capture', 'public_bundle_callsite', 'first_party_bundle_contract', 'first_party_sdk_contract'].includes(evidence.source)
    || typeof evidence.capturedAt !== 'string' || !Number.isFinite(Date.parse(evidence.capturedAt))
    || evidence.requestMethod !== operation.method || typeof evidence.requestPath !== 'string'
    || !evidence.requestPath.startsWith('/') || evidence.requestPath.includes('?') || evidence.requestPath.includes('#')
    || (!firstPartySourcePending && (!Number.isInteger(evidence.httpStatus) || evidence.httpStatus < 100 || evidence.httpStatus > 599))
    || (firstPartySourcePending && evidence.httpStatus !== null)
    || typeof evidence.responseContentType !== 'string'
    || !['unreviewed', 'normal_observed_xhr', 'security_boundary', 'not_applicable'].includes(evidence.securityBoundary)
    || !Array.isArray(evidence.securitySignals) || evidence.securitySignals.length > 32
    || evidence.securitySignals.some(signal => typeof signal !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(signal))) {
    throw fail('CONTRACT_EVIDENCE_INVALID');
  }

  if (typeof operation.urlTemplate !== 'string' || !operation.urlTemplate.startsWith('https://')) throw fail('CONTRACT_URL_INVALID');
  const normalizedTemplate = templatePath(operation.urlTemplate);
  let url;
  try { url = new URL(normalizedTemplate); } catch { throw fail('CONTRACT_URL_INVALID'); }
  if (url.username || url.password || url.hash || !allowedOrigins.includes(url.origin)
    || url.pathname !== evidence.requestPath) throw fail('CONTRACT_URL_SCOPE');
  const pathTemplate = operation.urlTemplate.split(/[?#]/, 1)[0];
  for (const segment of pathTemplate.split('/')) {
    if (segment.includes('{{input.') && !TOKEN_PATTERN.test(segment)) throw fail('CONTRACT_PATH_TEMPLATE_INVALID');
    if (!segment.includes('{{input.') && (segment === '.' || segment === '..')) throw fail('CONTRACT_PATH_TEMPLATE_INVALID');
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_PATTERN.test(key)) throw fail('CONTRACT_SENSITIVE_QUERY_IN_CONTRACT');
  }

  const request = operation.request;
  if (!plainObject(request)) throw fail('CONTRACT_REQUEST_INVALID');
  if (request.maxBodyBytes !== undefined
    && (!Number.isSafeInteger(request.maxBodyBytes) || request.maxBodyBytes < 1
      || request.maxBodyBytes > MAX_ARTIFACT_BYTES)) throw fail('CONTRACT_REQUEST_BODY_LIMIT_INVALID');
  if (request.streamBodyFile !== undefined && typeof request.streamBodyFile !== 'boolean') {
    throw fail('CONTRACT_REQUEST_BODY_MODE_INVALID');
  }
  if (request.streamBodyFile === true && operation.id !== 'attachment.upload.direct') {
    throw fail('CONTRACT_REQUEST_BODY_MODE_INVALID');
  }
  if (operation.id === 'attachment.upload.direct'
    && (operation.kind !== 'submit' || operation.method !== 'POST'
      || request.streamBodyFile !== true || request.maxBodyBytes !== MAX_DIRECT_MULTIPART_BODY_BYTES
      || request.bodyEncoding !== 'base64' || request.bodyTemplate !== '{{input.multipartBodyBase64}}'
      || request.inputSchema?.properties?.multipartBodyBase64?.maxLength !== MAX_DIRECT_MULTIPART_BASE64_LENGTH)) {
    throw fail('CONTRACT_DIRECT_UPLOAD_BODY_POLICY_INVALID');
  }
  if (!['none', 'session'].includes(operation.authMode)) throw fail('CONTRACT_AUTH_MODE_INVALID');
  if (request.inputSchema !== undefined) validateInputSchema(request.inputSchema);
  if (request.queryTemplate !== undefined) {
    if (!plainObject(request.queryTemplate)) throw fail('CONTRACT_QUERY_TEMPLATE_INVALID');
    for (const [key, value] of Object.entries(request.queryTemplate)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || SECRET_QUERY_PATTERN.test(key)) {
        throw fail('CONTRACT_QUERY_TEMPLATE_INVALID');
      }
      validateTemplate(value);
    }
  }
  if (request.bodyTemplate !== undefined && request.bodyTemplate !== null) validateTemplate(request.bodyTemplate);
  if (request.headers !== undefined) {
    if (!plainObject(request.headers)) throw fail('CONTRACT_HEADERS_INVALID');
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HEADER_PATTERN.test(name) || /^(?:authorization|cookie|set-cookie|host|content-length|user-agent)$/i.test(name)
        || /^sec-/i.test(name) || CONTROL_HEADER_PATTERN.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
        throw fail('CONTRACT_HEADERS_INVALID');
      }
      if (name.toLowerCase() === 'origin' && value !== url.origin) throw fail('CONTRACT_HEADERS_INVALID');
      if (name.toLowerCase() === 'referer') {
        let referer;
        try { referer = new URL(value); } catch { throw fail('CONTRACT_HEADERS_INVALID'); }
        if (!allowedOrigins.includes(referer.origin) || referer.protocol !== 'https:' || referer.username || referer.password
          || referer.search || referer.hash) throw fail('CONTRACT_HEADERS_INVALID');
      }
    }
  }
  const bindings = request.credentialBindings ?? { cookies: [], headers: [] };
  if (!plainObject(bindings) || !Array.isArray(bindings.cookies) || !Array.isArray(bindings.headers)) throw fail('CONTRACT_CREDENTIAL_BINDINGS_INVALID');
  if (bindings.cookies.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))) {
    throw fail('CONTRACT_CREDENTIAL_BINDINGS_INVALID');
  }
  if (bindings.headers.some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name) || CONTROL_HEADER_PATTERN.test(name)
    || /^(?:cookie|set-cookie|host|content-length|user-agent|origin|referer)$/i.test(name) || /^sec-/i.test(name))) {
    throw fail('CONTRACT_CREDENTIAL_BINDINGS_INVALID');
  }
  const uniqueBindings = [...bindings.cookies, ...bindings.headers.map(name => `header:${name.toLowerCase()}`)];
  if (new Set(uniqueBindings).size !== uniqueBindings.length) throw fail('CONTRACT_CREDENTIAL_BINDINGS_INVALID');
  const requestMetadataHeaders = request.perActionMetadataHeaders ?? [];
  const optionalMetadataHeaders = request.optionalPerActionMetadataHeaders ?? [];
  if (!Array.isArray(requestMetadataHeaders) || !Array.isArray(optionalMetadataHeaders)
    || requestMetadataHeaders.length + optionalMetadataHeaders.length > 16
    || [...requestMetadataHeaders, ...optionalMetadataHeaders].some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name)
      || CONTROL_HEADER_PATTERN.test(name)
      || /^(?:authorization|cookie|set-cookie|host|content-length|user-agent|origin|referer)$/i.test(name)
      || /^sec-/i.test(name))) throw fail('CONTRACT_REQUEST_METADATA_HEADERS_INVALID');
  const allCredentialHeaders = [...bindings.headers, ...requestMetadataHeaders, ...optionalMetadataHeaders];
  if (new Set(allCredentialHeaders.map(name => name.toLowerCase())).size !== allCredentialHeaders.length) {
    throw fail('CONTRACT_REQUEST_METADATA_HEADERS_INVALID');
  }
  if ((operation.authMode === 'none' && (bindings.cookies.length || bindings.headers.length))
    || (operation.authMode === 'session' && !bindings.cookies.length && !bindings.headers.length)) {
    throw fail('CONTRACT_AUTH_MODE_INVALID');
  }

  const response = operation.response;
  if (!plainObject(response) || !ALLOWED_RESPONSE_MODES.has(response.mode) || !Array.isArray(response.statuses)
    || !response.statuses.length || response.statuses.some(status => !Number.isInteger(status) || status < 200 || status > 299)
    || !Array.isArray(response.contentTypes) || !response.contentTypes.length
    || response.contentTypes.some(type => typeof type !== 'string' || !type.includes('/'))
    || !Number.isInteger(response.maxBytes) || response.maxBytes < 1 || response.maxBytes > MAX_RESPONSE_BYTES) {
    throw fail('CONTRACT_RESPONSE_INVALID');
  }
  if (response.setCookieNames !== undefined && (!Array.isArray(response.setCookieNames)
    || response.setCookieNames.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)))) {
    throw fail('CONTRACT_COOKIE_ROTATION_INVALID');
  }
  if (evidence.source === 'public_bundle_callsite') {
    const replay = evidence.directReplay;
    if (operation.authMode !== 'none' || evidence.securityBoundary !== 'not_applicable' || !plainObject(replay)
      || replay.source !== 'direct_http' || replay.status !== 200 || replay.parsedData !== true
      || typeof replay.observedAt !== 'string' || !Number.isFinite(Date.parse(replay.observedAt))
      || typeof evidence.sourceFile !== 'string' || typeof evidence.functionName !== 'string'
      || evidence.requestMethod !== operation.method) throw fail('CONTRACT_PUBLIC_REPLAY_EVIDENCE_INVALID');
  } else if (evidence.source === 'first_party_bundle_contract') {
    const replay = evidence.directReplay;
    let sourceUrl;
    try { sourceUrl = new URL(evidence.sourceUrl); } catch { throw fail('CONTRACT_FIRST_PARTY_SOURCE_INVALID'); }
    if (operation.authMode !== 'session' || evidence.securityBoundary !== 'not_applicable'
      || sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'cdn.grok.com' || !sourceUrl.pathname.startsWith('/_next/static/chunks/')
      || sourceUrl.username || sourceUrl.password
      || sourceUrl.search || sourceUrl.hash
      || typeof evidence.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sourceSha256)
      || typeof evidence.sourceFunctionName !== 'string' || !/^workspaceRepository[A-Za-z]+Raw$/.test(evidence.sourceFunctionName)
      || !Array.isArray(evidence.sourceDeclaredHeaders)
      || evidence.sourceDeclaredHeaders.some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name)
        || CONTROL_HEADER_PATTERN.test(name) || /^(?:authorization|cookie|set-cookie|host|content-length|user-agent)$/i.test(name))
      || evidence.browserWriteCapture !== false || evidence.clientCallsiteFabricated !== false
      || evidence.browserHeadersCaptured !== false || typeof evidence.directReplayReceipt !== 'string'
      || !evidence.directReplayReceipt.startsWith('verification/')
      || !plainObject(replay) || replay.source !== 'direct_http' || replay.status !== 200 || replay.parsedData !== true
      || typeof replay.observedAt !== 'string' || !Number.isFinite(Date.parse(replay.observedAt))
      || replay.ownerVerified !== true || replay.tlsVerified !== true || replay.trustEnv !== false
      || replay.redirectsFollowed !== false || replay.explicitRetries !== 0 || replay.attemptCountPerMutation !== 1
      || !Array.isArray(replay.requestHeaderNames) || replay.requestHeaderNames.some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name))
      || !Array.isArray(replay.cookieNames) || replay.cookieNames.some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name))) {
      throw fail('CONTRACT_FIRST_PARTY_REPLAY_EVIDENCE_INVALID');
    }
    if (operation.kind === 'submit'
      && (evidence.semanticReadbackVerified !== true
        || typeof evidence.observedResponseSubstantive !== 'boolean'
        || !Number.isInteger(replay.responseBytes) || replay.responseBytes < 1
        || typeof replay.responseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(replay.responseSha256)
        || typeof replay.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(replay.requestDigest)
        || typeof replay.intentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(replay.intentDigest)
        || (evidence.observedResponseSubstantive === false && evidence.responseMayBeEmptyObject !== true))) {
      throw fail('CONTRACT_FIRST_PARTY_SEMANTIC_READBACK_REQUIRED');
    }
  } else if (evidence.source === 'first_party_sdk_contract') {
    const replay = evidence.directReplay;
    let sourceUrl;
    try { sourceUrl = new URL(evidence.sourceUrl); } catch { throw fail('CONTRACT_FIRST_PARTY_SOURCE_INVALID'); }
    const pendingSourceWrite = !replay && operation.kind === 'submit'
      && evidence.firstLiveReplayPermit === true && evidence.httpStatus === null
      && evidence.responseContentType === 'unknown';
    const pendingSourceRead = !replay && operation.kind === 'read'
      && evidence.firstLiveReadPermit === true && evidence.httpStatus === null
      && evidence.responseContentType === 'unknown';
    const sourceFileResponseSizeOmitted = operation.effect === 'file_upload'
      && ['attachment.upload.direct', 'attachment.asset.delete'].includes(operation.id)
      && evidence.responseSizeRecorded === false && replay?.responseBytes === null;
    const validSdkFunction = typeof evidence.sourceFunctionName === 'string'
      && (/^[A-Za-z][A-Za-z0-9]+Raw$/.test(evidence.sourceFunctionName)
        || (operation.id === 'attachment.upload.direct' && evidence.sourceFunctionName === 'uploadFileV2'));
    if (operation.authMode !== 'session' || evidence.securityBoundary !== 'not_applicable' || evidence.securitySignals.length
      || sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'cdn.grok.com' || !sourceUrl.pathname.startsWith('/_next/static/chunks/')
      || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash
      || typeof evidence.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sourceSha256)
      || !validSdkFunction
      || !Array.isArray(evidence.sourceDeclaredHeaders)
      || evidence.sourceDeclaredHeaders.some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name)
        || CONTROL_HEADER_PATTERN.test(name) || /^(?:authorization|cookie|set-cookie|host|content-length|user-agent)$/i.test(name))
      || evidence.browserWriteCapture !== false || evidence.clientCallsiteFabricated !== false
      || evidence.browserHeadersCaptured !== false || typeof evidence.directReplayReceipt !== 'string'
      || !evidence.directReplayReceipt.startsWith('verification/')
      || (!pendingSourceWrite && !pendingSourceRead && (!plainObject(replay) || replay.source !== 'direct_http'
        || replay.status !== evidence.httpStatus || replay.parsedData !== true
        || typeof replay.observedAt !== 'string' || !Number.isFinite(Date.parse(replay.observedAt))
        || replay.ownerVerified !== true || replay.tlsVerified !== true || replay.trustEnv !== false
        || replay.redirectsFollowed !== false || replay.explicitRetries !== 0 || replay.attemptCountPerMutation !== 1
        || typeof replay.responseDigestPersisted !== 'boolean'
        || (replay.responseDigestPersisted === true && replay.responseBytes > 0
          && (typeof replay.responseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(replay.responseSha256)))
        || (replay.responseDigestPersisted === false && replay.responseSha256 !== undefined)
        || !Array.isArray(replay.requestHeaderNames) || replay.requestHeaderNames.some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name))
        || !Array.isArray(replay.cookieNames) || replay.cookieNames.some(name => typeof name !== 'string' || !HEADER_PATTERN.test(name))))) {
      throw fail('CONTRACT_FIRST_PARTY_SOURCE_INVALID');
    }
    if (pendingSourceWrite && evidence.firstLiveReplayPermit !== true) throw fail('CONTRACT_FIRST_LIVE_REPLAY_PERMIT_REQUIRED');
    if (pendingSourceRead && evidence.firstLiveReadPermit !== true) throw fail('CONTRACT_FIRST_LIVE_READ_PERMIT_REQUIRED');
    if (operation.kind === 'submit' && !pendingSourceWrite
      && ((evidence.semanticReadbackVerified !== true && !verifiedUploadInitIssuance(operation))
        || typeof evidence.observedResponseSubstantive !== 'boolean'
        || (!sourceFileResponseSizeOmitted && (!Number.isInteger(replay.responseBytes) || replay.responseBytes < 0))
        || !/^[a-f0-9]{64}$/.test(replay.requestDigest ?? '')
        || !/^[a-f0-9]{64}$/.test(replay.intentDigest ?? '')
        || (evidence.observedResponseSubstantive === false && evidence.responseMayBeEmptyObject !== true))) {
      throw fail('CONTRACT_FIRST_PARTY_SEMANTIC_READBACK_REQUIRED');
    }
  } else if (evidence.directReplay !== undefined) {
    throw fail('CONTRACT_EVIDENCE_INVALID');
  }
  if (operation.kind === 'submit') {
    if (!['chat_write', 'image_generation', 'video_generation', 'workspace_management', 'user_settings', 'file_upload'].includes(operation.effect)
      || (operation.responseJobIdPointer !== undefined && operation.responseJobIdPointer !== null
        && !validJsonPointer(operation.responseJobIdPointer))) throw fail('CONTRACT_MUTATION_INVALID');
    if (operation.reconciliation !== undefined && operation.reconciliation !== null) {
      const r = operation.reconciliation;
      if (!plainObject(r) || !ID_PATTERN.test(r.operationId) || typeof r.jobIdInputField !== 'string'
        || !validJsonPointer(r.statusPointer) || !Array.isArray(r.terminalValues) || !Array.isArray(r.failureValues)) {
        throw fail('CONTRACT_RECONCILIATION_INVALID');
      }
    }
  } else if (operation.effect !== undefined) {
    throw fail('CONTRACT_MUTATION_INVALID');
  }
  if (operation.role !== undefined && operation.role !== 'identity') throw fail('CONTRACT_OPERATION_ROLE_INVALID');
  if (operation.role === 'identity' && (operation.kind !== 'read' || !validJsonPointer(operation.identityJsonPointer))) {
    throw fail('CONTRACT_OPERATION_ROLE_INVALID');
  }
  if (operation.kind === 'download') {
    const artifact = operation.artifact;
    if (!plainObject(artifact) || !Array.isArray(artifact.allowedOrigins) || !artifact.allowedOrigins.length
      || artifact.allowedOrigins.some(origin => !allowedOrigins.includes(validateOrigin(origin)))
      || !ID_PATTERN.test(artifact.sourceOperationId) || !validJsonPointer(artifact.urlJsonPointer)
      || !Array.isArray(artifact.mimeTypes) || !artifact.mimeTypes.length
      || !Number.isInteger(artifact.maxBytes) || artifact.maxBytes < 1 || artifact.maxBytes > MAX_ARTIFACT_BYTES) {
      throw fail('CONTRACT_ARTIFACT_INVALID');
    }
  }
}

export function validateContractRegistry(registry) {
  if (!plainObject(registry) || registry.schemaVersion !== 1 || registry.serviceId !== 'grok-web'
    || validateOrigin(registry.serviceOrigin) !== 'https://grok.com' || !Array.isArray(registry.allowedOrigins)
    || !registry.allowedOrigins.includes(registry.serviceOrigin) || !Array.isArray(registry.operations)) {
    throw fail('CONTRACT_REGISTRY_INVALID');
  }
  const allowedOrigins = registry.allowedOrigins.map(origin => validateOrigin(origin));
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw fail('CONTRACT_ORIGINS_DUPLICATE');
  const ids = new Set();
  for (const operation of registry.operations) {
    if (ids.has(operation?.id)) throw fail('CONTRACT_OPERATION_DUPLICATE');
    validateOperation(operation, allowedOrigins);
    ids.add(operation.id);
  }
  for (const operation of registry.operations) {
    if (operation.reconciliation) {
      const pollOperation = registry.operations.find(item => item.id === operation.reconciliation.operationId);
      if (!pollOperation || pollOperation.kind !== 'poll' || pollOperation.authMode !== operation.authMode
        || !Object.hasOwn(pollOperation.request.inputSchema?.properties ?? {}, operation.reconciliation.jobIdInputField)) {
        throw fail('CONTRACT_RECONCILIATION_INVALID');
      }
    }
    if (operation.kind === 'download') {
      const source = registry.operations.find(item => item.id === operation.artifact.sourceOperationId);
      if (!source || !['read', 'poll'].includes(source.kind) || source.response.mode !== 'json') throw fail('CONTRACT_ARTIFACT_SOURCE_INVALID');
    }
  }
  if (registry.identityOperationId !== null && registry.identityOperationId !== undefined
    && !ids.has(registry.identityOperationId)) throw fail('CONTRACT_IDENTITY_OPERATION_MISSING');
  if (registry.identityOperationId) {
    const identityOperation = registry.operations.find(item => item.id === registry.identityOperationId);
    if (identityOperation.kind !== 'read' || identityOperation.role !== 'identity'
      || typeof identityOperation.identityJsonPointer !== 'string') throw fail('CONTRACT_IDENTITY_OPERATION_INVALID');
  }
  return registry;
}

export function operationReadiness(operation) {
  if (!operation) return { ready: false, reason: 'OPERATION_NOT_FOUND' };
  const evidence = operation.evidence;
  if (!evidence) return { ready: false, reason: 'CAPTURE_EVIDENCE_MISSING' };
  if (evidence.source === 'public_bundle_callsite') {
    if (operation.authMode !== 'none' || evidence.directReplay?.source !== 'direct_http' || evidence.directReplay?.status !== 200
      || evidence.directReplay?.parsedData !== true || evidence.securitySignals.length) {
      return { ready: false, reason: 'PUBLIC_DIRECT_READ_UNVERIFIED' };
    }
    return { ready: true, reason: null, sourceDerived: true, browserCapture: false, directReadVerified: true };
  }
  if (evidence.source === 'first_party_bundle_contract') {
    if (evidence.securityBoundary !== 'not_applicable' || evidence.securitySignals.length
      || evidence.browserWriteCapture !== false || evidence.clientCallsiteFabricated !== false
      || evidence.browserHeadersCaptured !== false || evidence.directReplay?.source !== 'direct_http'
      || evidence.directReplay.status !== 200 || evidence.directReplay.parsedData !== true
      || evidence.directReplay.ownerVerified !== true
      || (operation.kind === 'submit' && evidence.semanticReadbackVerified !== true)) {
      return { ready: false, reason: 'FIRST_PARTY_REPLAY_UNVERIFIED', sourceDerived: true, browserCapture: false };
    }
    return {
      ready: true, reason: null, sourceDerived: true, browserCapture: false,
      directReadVerified: operation.kind === 'read', directReplayVerified: true,
    };
  }
  if (evidence.source === 'first_party_sdk_contract') {
    const replay = evidence.directReplay;
    if (!replay || replay.source !== 'direct_http' || replay.status !== evidence.httpStatus
      || replay.parsedData !== true || replay.ownerVerified !== true || replay.tlsVerified !== true
      || replay.trustEnv !== false || replay.redirectsFollowed !== false || replay.explicitRetries !== 0) {
      return { ready: false, reason: 'FIRST_LIVE_REPLAY_REQUIRED', sourceDerived: true, browserCapture: false };
    }
    if (operation.kind === 'submit' && evidence.semanticReadbackVerified !== true && !verifiedUploadInitIssuance(operation)) {
      return { ready: false, reason: 'FIRST_PARTY_READBACK_REQUIRED', sourceDerived: true, browserCapture: false };
    }
    return { ready: true, reason: null, sourceDerived: true, browserCapture: false,
      directReadVerified: operation.kind === 'read', directReplayVerified: true };
  }
  if (evidence.source !== 'browser_network_capture') return { ready: false, reason: 'CAPTURE_EVIDENCE_MISSING' };
  if (evidence.securityBoundary !== 'normal_observed_xhr' || evidence.securitySignals.length) {
    return { ready: false, reason: 'SECURITY_BOUNDARY_UNRESOLVED', sourceDerived: false, browserCapture: true };
  }
  return { ready: true, reason: null, sourceDerived: false, browserCapture: true };
}

export function findOperation(registry, id) {
  validateContractRegistry(registry);
  const operation = registry.operations.find(item => item.id === id);
  if (!operation) throw fail('OPERATION_NOT_FOUND');
  return operation;
}

export function validateOperationInput(operation, input = {}) {
  if (!plainObject(input)) throw fail('OPERATION_INPUT_INVALID');
  const schema = operation.request.inputSchema ?? { properties: {}, required: [] };
  validateValue(input, { type: 'object', ...schema }, 'input', 0);
  return input;
}

function validateValue(value, rule, path, depth) {
  if (depth > 12) throw fail('OPERATION_INPUT_TOO_DEEP');
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const matched = rule.type === 'integer' ? Number.isInteger(value) : rule.type === 'number' ? Number.isFinite(value) : type === rule.type;
  if (!matched) throw fail('OPERATION_INPUT_TYPE_INVALID', { field: path });
  if (typeof value === 'string' && ((rule.maxLength !== undefined && value.length > rule.maxLength)
    || (rule.minLength !== undefined && value.length < rule.minLength))) throw fail('OPERATION_INPUT_LENGTH_INVALID', { field: path });
  if (typeof value === 'number' && ((rule.maximum !== undefined && value > rule.maximum)
    || (rule.minimum !== undefined && value < rule.minimum))) throw fail('OPERATION_INPUT_RANGE_INVALID', { field: path });
  if (rule.enum && !rule.enum.includes(value)) throw fail('OPERATION_INPUT_ENUM_INVALID', { field: path });
  if (rule.type === 'object') {
    const properties = rule.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateValue(child, properties[key], `${path}.${key}`, depth + 1);
      else if (rule.additionalProperties) validateValue(child, rule.additionalProperties, `${path}.${key}`, depth + 1);
      else throw fail('OPERATION_INPUT_UNKNOWN_FIELD', { field: `${path}.${key}` });
    }
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) throw fail('OPERATION_INPUT_REQUIRED_FIELD', { field: `${path}.${key}` });
  }
  if (rule.type === 'array') {
    if (rule.maxItems !== undefined && value.length > rule.maxItems) throw fail('OPERATION_INPUT_LENGTH_INVALID', { field: path });
    if (rule.minItems !== undefined && value.length < rule.minItems) throw fail('OPERATION_INPUT_LENGTH_INVALID', { field: path });
    for (let index = 0; index < value.length; index++) validateValue(value[index], rule.items, `${path}[${index}]`, depth + 1);
  }
}

function resolveInputPath(input, path) {
  const parts = path.split('.');
  let value = input;
  for (const part of parts) {
    if (!plainObject(value) || !Object.hasOwn(value, part)) throw fail('OPERATION_INPUT_REQUIRED_FIELD', { field: path });
    value = value[part];
  }
  return value;
}

function assertSafePathValue(value) {
  let decoded = String(value);
  for (let depth = 0; depth <= 8; depth++) {
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw fail('OPERATION_PATH_VALUE_INVALID');
    }
    if (!/%[0-9a-f]{2}/i.test(decoded)) return;
    let next;
    try { next = decodeURIComponent(decoded); } catch { return; }
    if (next === decoded) return;
    decoded = next;
  }
  throw fail('OPERATION_PATH_VALUE_INVALID');
}

export function resolveTemplate(template, input) {
  if (typeof template === 'string') {
    const match = TOKEN_PATTERN.exec(template);
    return match ? resolveInputPath(input, match[1]) : template;
  }
  if (Array.isArray(template)) return template.map(item => resolveTemplate(item, input));
  if (plainObject(template)) return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolveTemplate(value, input)]));
  return template;
}

export function materializeOperationUrl(operation, input) {
  validateOperationInput(operation, input);
  const queryIndex = operation.urlTemplate.indexOf('?');
  const pathTemplate = operation.urlTemplate.split(/[?#]/, 1)[0];
  const templateOrigin = new URL(pathTemplate).origin;
  const pathSegments = pathTemplate.slice(templateOrigin.length).split('/');
  for (const segment of pathSegments) {
    if (segment.includes('{{input.') && !TOKEN_PATTERN.test(segment)) throw fail('CONTRACT_PATH_TEMPLATE_INVALID');
  }
  const url = operation.urlTemplate.replace(/\{\{input\.([A-Za-z][A-Za-z0-9_.-]{0,127})\}\}/g, (token, path, offset) => {
    if (queryIndex >= 0 && offset >= queryIndex) return token;
    const value = resolveInputPath(input, path);
    if (typeof value === 'object' || value === null || /[\r\n\0]/.test(String(value))) throw fail('OPERATION_PATH_VALUE_INVALID');
    assertSafePathValue(value);
    if (token.includes('/')) throw fail('OPERATION_PATH_TEMPLATE_INVALID');
    return encodeURIComponent(String(value));
  });
  let parsed;
  try { parsed = new URL(url); } catch { throw fail('CONTRACT_URL_INVALID'); }
  const hasInputPath = path => {
    let value = input;
    for (const part of path.split('.')) {
      if (!plainObject(value) || !Object.hasOwn(value, part)) return false;
      value = value[part];
    }
    return true;
  };
  for (const [key, template] of Object.entries(operation.request.queryTemplate ?? {})) {
    let value = template;
    if (typeof template === 'string') {
      const match = TOKEN_PATTERN.exec(template);
      if (match) {
        if (!hasInputPath(match[1])) continue;
        value = resolveInputPath(input, match[1]);
      }
    }
    if (value === undefined) {
      parsed.searchParams.delete(key);
      continue;
    }
    if (value === null || typeof value === 'object' || /[\r\n\0]/.test(String(value))) {
      throw fail('OPERATION_QUERY_VALUE_INVALID');
    }
    parsed.searchParams.set(key, String(value));
  }
  const original = new URL(templatePath(operation.urlTemplate));
  if (parsed.origin !== original.origin || parsed.username || parsed.password || parsed.hash) throw fail('CONTRACT_URL_SCOPE');
  const templateSegments = new URL(templatePath(operation.urlTemplate)).pathname.split('/');
  const finalSegments = parsed.pathname.split('/');
  if (templateSegments.length !== finalSegments.length) throw fail('CONTRACT_URL_SCOPE');
  for (let i = 0; i < templateSegments.length; i++) {
    if (!pathSegments[i]?.includes('{{input.') && templateSegments[i] !== finalSegments[i]) throw fail('CONTRACT_URL_SCOPE');
    let decoded;
    try { decoded = decodeURIComponent(finalSegments[i]); } catch { throw fail('CONTRACT_URL_SCOPE'); }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) throw fail('OPERATION_PATH_VALUE_INVALID');
  }
  for (const key of parsed.searchParams.keys()) if (SECRET_QUERY_PATTERN.test(key)) throw fail('CONTRACT_SENSITIVE_QUERY_IN_CONTRACT');
  return parsed;
}

export function materializeTemplate(template, input) {
  return resolveTemplate(template, input);
}
