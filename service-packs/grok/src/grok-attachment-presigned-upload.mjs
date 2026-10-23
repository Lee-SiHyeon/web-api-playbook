import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';
import { projectGrokUploadInitCheckpoint, isValidatedGrokUploadResumeTicket } from './grok-upload-reference-store.mjs';

// These names follow the generated SDK callsites. Their contracts remain
// source-described candidates until the registry records a live replay.
export const GROK_ATTACHMENT_PRESIGNED_OPERATION_IDS = Object.freeze({
  init: 'attachment.upload.init',
  complete: 'attachment.upload.complete',
  status: 'attachment.upload.status',
  abort: 'attachment.upload.abort',
  fileMetadata: 'attachment.file-metadata.read',
});
export const GROK_ATTACHMENT_PRESIGNED_SOURCE_CAPABILITIES = Object.freeze({
  directThreshold: 'supplied-by-current-web-file-upload-feature-policy',
  singlePut: 'source-described; server-returned-https-url-and-required-headers',
  multipart: 'source-described; server-returned-part-urls-and-part-size; sorted-etag-completion',
  resumable: 'source-described-but-current-uploader-throws-unsupported',
  patch: 'generated-sdk-method-exists; current-uploader-has-no-patch-callsite',
  abort: 'generated-sdk-method-exists; explicit-cleanup-only-in-this-client',
});

const STAGE_CONTRACTS = Object.freeze({
  init: 'attachment.upload.stage.init',
  singlePut: 'attachment.upload.stage.single-put',
  multipartPart: 'attachment.upload.stage.multipart-part',
  complete: 'attachment.upload.stage.complete',
  status: 'attachment.upload.stage.status',
  fileMetadata: 'attachment.upload.stage.file-metadata',
  abort: 'attachment.upload.stage.abort',
});
const MAX_SIGNED_URL_LENGTH = 32_768;
const MAX_REQUIRED_HEADERS = 64;
const MAX_HEADER_VALUE_LENGTH = 16_384;
const MAX_SIGNED_PUT_ACK_BYTES = 32 * 1024;
const MAX_MULTIPART_PARTS = 256;
const INTENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_SIGNED_HEADERS = /^(?:cookie|set-cookie|authorization|proxy-authorization|host|content-length|origin|referer|user-agent|connection|transfer-encoding|upgrade)$/i;
const KNOWN_PRE_DISPATCH_CODES = new Set([
  'OPERATION_NOT_READY', 'OPERATION_KIND_NOT_SUBMITTABLE', 'SOURCE_DISCOVERY_PERMIT_INVALID',
  'SOURCE_DISCOVERY_PERMIT_ALREADY_USED', 'SUBMIT_CONFIRM_REQUIRED', 'SUBMIT_INTENT_ID_REQUIRED',
  'OWNER_VERIFICATION_REQUIRED', 'CONTRACT_INPUT_INVALID', 'JOURNAL_INPUT_INVALID',
  'OPERATION_ALREADY_HELD', 'OPERATION_ALREADY_COMPLETED', 'OPERATION_ALREADY_ATTEMPTED',
  'OWNER_SCOPE_MISMATCH', 'ATTACHMENT_OWNER_SCOPE_CHANGED', 'REQUEST_METADATA_HEADERS_INVALID',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashJson(value) {
  return hash(Buffer.from(JSON.stringify(value), 'utf8'));
}

function safeReason(error, fallback = 'ATTACHMENT_UPLOAD_STAGE_FAILED') {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
    ? error.code : fallback;
}

function validText(value, code, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) throw fail(code);
  return value;
}

function validateFileName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw fail('ATTACHMENT_FILE_NAME_INVALID');
  }
  return value;
}

function validateMimeType(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9.+-]{1,80}\/[A-Za-z0-9.+-]{1,80}$/.test(value)) {
    throw fail('ATTACHMENT_MIME_TYPE_INVALID');
  }
  return value.toLowerCase();
}

function validatePolicy(policy, byteCount) {
  if (!object(policy)
    || !Number.isSafeInteger(policy.directUploadMaxSizeBytes) || policy.directUploadMaxSizeBytes < 0
    || !Number.isSafeInteger(policy.maxUploadFileSizeBytes) || policy.maxUploadFileSizeBytes < 1
    || typeof policy.multipartSupported !== 'boolean'
    || !Number.isInteger(policy.multipartConcurrency) || policy.multipartConcurrency < 1 || policy.multipartConcurrency > 4
    || !Number.isInteger(policy.maxStatusReads) || policy.maxStatusReads < 1 || policy.maxStatusReads > 100
    || !Number.isInteger(policy.statusPollIntervalMs) || policy.statusPollIntervalMs < 0 || policy.statusPollIntervalMs > 30_000) {
    throw fail('ATTACHMENT_UPLOAD_POLICY_REQUIRED');
  }
  if (byteCount > policy.maxUploadFileSizeBytes) throw fail('ATTACHMENT_SIZE_LIMIT_EXCEEDED');
  if (policy.directUploadMaxSizeBytes > 0 && byteCount <= policy.directUploadMaxSizeBytes) {
    throw fail('ATTACHMENT_SIZE_REQUIRES_DIRECT_PATH');
  }
  return Object.freeze({
    directUploadMaxSizeBytes: policy.directUploadMaxSizeBytes,
    maxUploadFileSizeBytes: policy.maxUploadFileSizeBytes,
    multipartSupported: policy.multipartSupported,
    multipartConcurrency: policy.multipartConcurrency,
    maxStatusReads: policy.maxStatusReads,
    statusPollIntervalMs: policy.statusPollIntervalMs,
  });
}

function validateIntent(intentId, confirm) {
  if (confirm !== true || typeof intentId !== 'string' || !INTENT_PATTERN.test(intentId)) {
    throw fail('ATTACHMENT_UPLOAD_INTENT_REQUIRED');
  }
  return intentId;
}

function validateOwnerDigest(ownerIdentityDigest) {
  if (typeof ownerIdentityDigest !== 'string' || !SHA256_PATTERN.test(ownerIdentityDigest)) {
    throw fail('ATTACHMENT_OWNER_BINDING_REQUIRED');
  }
  return ownerIdentityDigest;
}

function responseHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  if (object(headers)) {
    const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  }
  return null;
}

function validateRequiredHeaders(value, byteCount) {
  // The shipped web uploader parses singlePut.requiredHeaders with a zod
  // record default of {}. Preserve that source behavior when the server omits
  // the optional field; do not invent headers for it.
  if (value === undefined) return { headers: {}, transportManagedHeaderNames: [] };
  if (!object(value) || Object.keys(value).length > MAX_REQUIRED_HEADERS) {
    throw fail('ATTACHMENT_SIGNED_HEADERS_INVALID');
  }
  const headers = {};
  const transportManagedHeaderNames = [];
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
      || typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE_LENGTH
      || /[\r\n\0]/.test(headerValue)) throw fail('ATTACHMENT_SIGNED_HEADERS_INVALID');
    // Fetch forbids callers from setting Content-Length. A byte-buffer body
    // makes the transport generate it, so accept only an exact server-signed
    // size match and keep the header out of the explicit request map.
    if (name.toLowerCase() === 'content-length') {
      if (!Number.isSafeInteger(byteCount) || headerValue !== String(byteCount)) {
        throw fail('ATTACHMENT_SIGNED_HEADERS_INVALID');
      }
      transportManagedHeaderNames.push('content-length');
      continue;
    }
    if (FORBIDDEN_SIGNED_HEADERS.test(name) || /^sec-/i.test(name)
      || typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE_LENGTH
      || /[\r\n\0]/.test(headerValue)) throw fail('ATTACHMENT_SIGNED_HEADERS_INVALID');
    headers[name] = headerValue;
  }
  return { headers, transportManagedHeaderNames: [...new Set(transportManagedHeaderNames)].sort() };
}

async function checkedSignedUrl(value, signedUrlPolicy, context) {
  if (typeof value !== 'string' || value.length > MAX_SIGNED_URL_LENGTH || /[\r\n\0]/.test(value)) {
    throw fail('ATTACHMENT_SIGNED_URL_INVALID');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw fail('ATTACHMENT_SIGNED_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw fail('ATTACHMENT_SIGNED_URL_INVALID');
  }
  if (typeof signedUrlPolicy !== 'function') throw fail('ATTACHMENT_SIGNED_URL_POLICY_REQUIRED');
  let allowed = false;
  try {
    allowed = await signedUrlPolicy(parsed.href, Object.freeze({
      kind: context.kind,
      partNumber: context.partNumber ?? null,
      origin: parsed.origin,
    }));
  } catch {
    throw fail('ATTACHMENT_SIGNED_URL_SCOPE');
  }
  if (allowed !== true) throw fail('ATTACHMENT_SIGNED_URL_SCOPE');
  return parsed.href;
}

function validateUploadMethod(value) {
  if (value === undefined || value === null || value === 'UPLOAD_METHOD_UNSPECIFIED'
    || value === 'UPLOAD_METHOD_SINGLE_PUT') return 'single_put';
  if (value === 'UPLOAD_METHOD_MULTIPART') return 'multipart';
  if (value === 'UPLOAD_METHOD_RESUMABLE') return 'resumable_unsupported';
  throw fail('ATTACHMENT_UPLOAD_METHOD_UNSUPPORTED');
}

function validateInitResponse(value) {
  if (!object(value)) throw fail('ATTACHMENT_UPLOAD_INIT_RESPONSE_INVALID');
  try {
    validText(value.uploadId, 'ATTACHMENT_UPLOAD_INIT_RESPONSE_INVALID', 512);
    validText(value.assetId, 'ATTACHMENT_UPLOAD_INIT_RESPONSE_INVALID', 512);
  } catch {
    throw fail('ATTACHMENT_UPLOAD_INIT_RESPONSE_INVALID');
  }
  return value;
}

function validateParts(value, byteCount) {
  let partSize = value?.partSize;
  // The current SDK validates this field with z.coerce.number().int().positive().
  // Accept its decimal-string JSON representation while rejecting broader JS coercions.
  if (typeof partSize === 'string' && /^\d{1,16}$/.test(partSize)) partSize = Number(partSize);
  if (!object(value) || !Array.isArray(value.parts) || value.parts.length < 1
    || value.parts.length > MAX_MULTIPART_PARTS || !Number.isSafeInteger(partSize) || partSize < 1) {
    throw fail('ATTACHMENT_MULTIPART_INIT_INVALID');
  }
  const expectedCount = Math.ceil(byteCount / partSize);
  if (expectedCount !== value.parts.length) throw fail('ATTACHMENT_MULTIPART_PART_COUNT_MISMATCH');
  const seen = new Set();
  for (let index = 0; index < value.parts.length; index += 1) {
    const part = value.parts[index];
    if (!object(part) || !Number.isInteger(part.partNumber) || part.partNumber !== index + 1
      || seen.has(part.partNumber) || typeof part.url !== 'string') {
      throw fail('ATTACHMENT_MULTIPART_PART_INVALID');
    }
    seen.add(part.partNumber);
  }
  return { ...value, partSize };
}

function validateMetadata(value, { fileName, mimeType, byteCount }) {
  if (!object(value) || typeof value.fileMetadataId !== 'string' || !value.fileMetadataId
    || value.fileName !== fileName || String(value.fileMimeType ?? '').toLowerCase() !== mimeType
    || typeof value.fileUri !== 'string' || !value.fileUri || value.fileUri.length > MAX_SIGNED_URL_LENGTH
    || /[\r\n\0]/.test(value.fileUri)
    || (value.sizeBytes !== undefined && Number(value.sizeBytes) !== byteCount)) {
    throw fail('ATTACHMENT_FILE_METADATA_MISMATCH');
  }
  return value;
}

function normalizedStatus(value) {
  if (typeof value !== 'string') return 'UNKNOWN';
  const normalized = value.toUpperCase().replace(/^.*(?:UPLOAD_JOB_STATUS_)/, '');
  return ['PROCESSING', 'RETRYING', 'SUCCESS', 'ERROR', 'ABORTED', 'EXPIRED'].includes(normalized)
    ? normalized : 'UNKNOWN';
}

function delay(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function readBoundedAcknowledgement(response, maxBytes = MAX_SIGNED_PUT_ACK_BYTES) {
  const digest = createHash('sha256');
  let responseBytes = 0;
  let truncated = false;
  const reader = response.body?.getReader?.();
  if (!reader) return {
    responseBytes: 0,
    responseDigest: digest.digest('hex'),
    responseDigestKind: 'raw_http_body',
    responseBodyTruncated: false,
  };
  try {
    while (responseBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value;
      const accepted = chunk.subarray(0, maxBytes - responseBytes);
      digest.update(accepted);
      responseBytes += accepted.length;
      if (accepted.length < chunk.length) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (!truncated && responseBytes === maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
    }
  } finally {
    reader.releaseLock?.();
  }
  return {
    responseBytes,
    responseDigest: digest.digest('hex'),
    responseDigestKind: truncated ? 'raw_http_body_prefix' : 'raw_http_body',
    responseBodyTruncated: truncated,
  };
}

async function defaultSignedPut({ url, body, headers, signal, transportManagedHeaderNames = [] }) {
  const response = await fetch(url, {
    method: 'PUT', body, headers, signal,
    credentials: 'omit', redirect: 'error',
  });
  const acknowledgement = await readBoundedAcknowledgement(response);
  return { status: response.status, headers: response.headers, ...acknowledgement,
    transportReceipt: { method: 'PUT', responseStatus: response.status, ...acknowledgement,
      requestHeaderNames: [...new Set([...Object.keys(headers), ...transportManagedHeaderNames,
        ...(body instanceof Uint8Array ? ['content-length'] : [])])].map(name => name.toLowerCase()).sort() } };
}

function safeStageReceipt(stage, ordinal, state, requestDigest, requestBytes, extras = {}) {
  return Object.freeze({
    stage,
    ordinal,
    state,
    requestDigest,
    requestBytes,
    attemptCount: 1,
    ...extras,
  });
}

function sanitizeTransportReceipt(value) {
  if (!object(value)) return {};
  const result = {};
  if (typeof value.method === 'string' && /^[A-Z]{3,8}$/.test(value.method)) result.transportMethod = value.method;
  if (typeof value.requestDigest === 'string' && SHA256_PATTERN.test(value.requestDigest)) {
    result.transportRequestDigest = value.requestDigest;
  }
  if (typeof value.intentDigest === 'string' && SHA256_PATTERN.test(value.intentDigest)) {
    result.transportIntentDigest = value.intentDigest;
  }
  const responseStatus = value.responseStatus ?? value.status;
  if (Number.isInteger(responseStatus) && responseStatus >= 100 && responseStatus <= 599) result.responseStatus = responseStatus;
  if (Number.isSafeInteger(value.responseBytes) && value.responseBytes >= 0) result.responseBytes = value.responseBytes;
  if (typeof value.responseDigest === 'string' && SHA256_PATTERN.test(value.responseDigest)) {
    result.responseDigest = value.responseDigest;
  }
  if (['raw_http_body', 'raw_http_body_prefix', 'parsed_json_data'].includes(value.responseDigestKind)) {
    result.responseDigestKind = value.responseDigestKind;
  }
  if (typeof value.responseBodyTruncated === 'boolean') result.responseBodyTruncated = value.responseBodyTruncated;
  if (typeof value.responseContentType === 'string' && value.responseContentType.length <= 256
    && !/[\r\n\0]/.test(value.responseContentType)) result.responseContentType = value.responseContentType;
  const names = (items, pattern) => Array.isArray(items)
    ? [...new Set(items.filter(item => typeof item === 'string' && pattern.test(item)))].sort().slice(0, 64) : [];
  const requestHeaderNames = names(value.requestHeaderNames, /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/);
  const cookieNames = names(value.cookieNames, /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/);
  if (requestHeaderNames.length) result.requestHeaderNames = requestHeaderNames;
  if (cookieNames.length) result.cookieNames = cookieNames;
  return result;
}

export function createGrokAttachmentPresignedUploadClient({
  client,
  operationJournal,
  signedUrlPolicy,
  putImpl = defaultSignedPut,
  operationIds = GROK_ATTACHMENT_PRESIGNED_OPERATION_IDS,
  discoveryPermits = {},
  onStageReceipt,
  getVerifiedOwnerScopeSha256,
  getRequestMetadataHeaders,
  onInitResponse,
  onCompleteResponse,
} = {}) {
  if (!client || typeof client.submit !== 'function' || typeof client.read !== 'function'
    || typeof client.status !== 'function' || typeof client.getInMemoryPrivateResponse !== 'function'
    || typeof client.clearInMemoryPrivateResponse !== 'function' || typeof operationJournal?.begin !== 'function'
    || typeof operationJournal?.transition !== 'function' || typeof operationJournal?.get !== 'function'
    || typeof putImpl !== 'function' || typeof signedUrlPolicy !== 'function'
    || typeof onStageReceipt !== 'function' || typeof getVerifiedOwnerScopeSha256 !== 'function'
    || (getRequestMetadataHeaders !== undefined && typeof getRequestMetadataHeaders !== 'function')
    || (onInitResponse !== undefined && typeof onInitResponse !== 'function')
    || (onCompleteResponse !== undefined && typeof onCompleteResponse !== 'function')
    || !object(operationIds) || !object(discoveryPermits)) {
    throw fail('ATTACHMENT_PRESIGNED_RUNTIME_REQUIRED');
  }

  const uploadRefs = new WeakMap();

  async function currentVerifiedOwner(expectedDigest = null) {
    let currentDigest;
    try { currentDigest = await getVerifiedOwnerScopeSha256(); }
    catch { throw fail('OWNER_VERIFICATION_REQUIRED'); }
    if (typeof currentDigest !== 'string' || !SHA256_PATTERN.test(currentDigest)) throw fail('OWNER_VERIFICATION_REQUIRED');
    if (expectedDigest !== null && expectedDigest !== currentDigest) throw fail('ATTACHMENT_OWNER_SCOPE_CHANGED');
    let status;
    try { status = await client.status(); }
    catch { throw fail('OWNER_VERIFICATION_REQUIRED'); }
    if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
    return currentDigest;
  }

  function stageIntentDigest({ contractId, ownerIdentityDigest, intentId, ordinal }) {
    return hash(Buffer.from(`${contractId}\n${ownerIdentityDigest}\n${intentId}\n${ordinal}`, 'utf8'));
  }

  async function beginStage({ stage, ordinal = 0, requestDigest, requestBytes, ownerIdentityDigest, intentId }) {
    await currentVerifiedOwner(ownerIdentityDigest);
    const contractId = STAGE_CONTRACTS[stage];
    if (!contractId) throw fail('ATTACHMENT_STAGE_NAME_INVALID');
    const intentDigest = stageIntentDigest({ contractId, ownerIdentityDigest, intentId, ordinal });
    const entry = await operationJournal.begin({
      contractId,
      requestDigest,
      intentDigest,
    });
    return {
      localOperationId: entry.localOperationId,
      ownerIdentityDigest,
      stageKey: hash(Buffer.from(`${contractId}\n${intentDigest}`, 'utf8')),
      receipt: safeStageReceipt(stage, ordinal, 'sending', requestDigest, requestBytes, {
        stageKey: hash(Buffer.from(`${contractId}\n${intentDigest}`, 'utf8')),
      }),
      requestBytes,
      auditPersistence: null,
      journalState: 'sending',
      responseObserved: false,
      journalStateWriteFailed: false,
    };
  }

  function trackStage(stageContext, diagnostics) {
    const index = diagnostics.length;
    diagnostics.push(stageContext.receipt);
    stageContext.updateDiagnostic = () => { diagnostics[index] = stageContext.receipt; };
    return index;
  }

  async function persistStageReceipt(stageContext, receipt, checkpoint) {
    const event = Object.freeze({ ...receipt, checkpoint });
    try {
      const storedPath = await onStageReceipt(event);
      stageContext.auditPersistence = 'stored';
      stageContext.receipt = Object.freeze({ ...receipt, auditPersistence: { state: 'stored' } });
      stageContext.updateDiagnostic?.();
      if (typeof storedPath === 'string') stageContext.lastCheckpointPath = storedPath;
      return storedPath;
    } catch {
      stageContext.auditPersistence = 'failed';
      stageContext.receipt = Object.freeze({ ...receipt,
        auditPersistence: { state: 'failed', errorCode: 'ATTACHMENT_STAGE_AUDIT_WRITE_FAILED' },
        businessRetryAllowed: false,
      });
      stageContext.updateDiagnostic?.();
      throw fail('ATTACHMENT_STAGE_AUDIT_CHECKPOINT_FAILED');
    }
  }

  function stageReceipt(stageContext, state, extras = {}) {
    return Object.freeze({
      ...safeStageReceipt(stageContext.receipt.stage, stageContext.receipt.ordinal, state,
        stageContext.receipt.requestDigest, stageContext.requestBytes, {
          stageKey: stageContext.stageKey,
          ...(stageContext.receipt.journalState ? { journalState: stageContext.receipt.journalState } : {}),
          ...extras,
        }),
    });
  }

  async function writeJournalState(stageContext, state, { httpStatus = null, reasonCode = null } = {}) {
    try {
      await operationJournal.transition(stageContext.localOperationId, state, { httpStatus, reasonCode });
      stageContext.journalState = state;
    } catch {
      stageContext.journalStateWriteFailed = true;
      const failed = Object.freeze({
        ...stageContext.receipt,
        state: stageContext.responseObserved ? 'response_observed' : stageContext.receipt.state,
        journalState: stageContext.journalState,
        journalStateWriteFailed: true,
        journalFailureCode: 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED',
        businessRetryAllowed: false,
        reasonCode: 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED',
      });
      stageContext.receipt = failed;
      stageContext.updateDiagnostic?.();
      try { await onStageReceipt(Object.freeze({ ...failed, checkpoint: 'journal_state_write_failed' })); } catch { /* checkpoint above remains authoritative */ }
      throw fail('ATTACHMENT_JOURNAL_STATE_WRITE_FAILED');
    }
    const nextReceipt = Object.freeze({
      ...stageContext.receipt,
      state,
      journalState: state,
      ...(httpStatus !== null ? { httpStatus } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
    stageContext.receipt = nextReceipt;
    stageContext.updateDiagnostic?.();
    try {
      await persistStageReceipt(stageContext, nextReceipt, 'journal_state');
    } catch {
      // The request result and response checkpoint are already durable. Stop
      // the workflow, but retain the known outcome and prohibit replay.
      throw fail('ATTACHMENT_STAGE_AUDIT_CHECKPOINT_FAILED');
    }
  }

  async function observeResponse(stageContext, { targetState = 'completed', httpStatus = null, responseBytes = null,
    reasonCode = null, transportReceipt = null, extra = {} } = {}) {
    const responseFields = {
      ...(httpStatus !== null ? { httpStatus } : {}),
      ...(responseBytes !== null ? { responseBytes } : {}),
      ...sanitizeTransportReceipt(transportReceipt),
      ...(reasonCode ? { reasonCode } : {}),
      ...extra,
      businessRetryAllowed: false,
    };
    const observed = stageReceipt(stageContext, 'response_observed', responseFields);
    stageContext.receipt = observed;
    stageContext.responseObserved = true;
    await persistStageReceipt(stageContext, observed, 'response_observed');

    if (targetState === 'completed') {
      await writeJournalState(stageContext, 'accepted', { httpStatus });
      await writeJournalState(stageContext, 'completed', { httpStatus });
    } else {
      await writeJournalState(stageContext, targetState, { httpStatus, reasonCode });
    }
    return stageContext.receipt;
  }

  async function transitionStage(stageContext, state, { httpStatus = null, reasonCode = null } = {}) {
    const observed = stageReceipt(stageContext, state, {
      ...(httpStatus !== null ? { httpStatus } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      businessRetryAllowed: false,
    });
    stageContext.receipt = observed;
    await persistStageReceipt(stageContext, observed, 'outcome_observed');
    await writeJournalState(stageContext, state, { httpStatus, reasonCode });
    return stageContext.receipt;
  }

  async function markStageComplete(stageContext, { httpStatus, responseBytes = null, transportReceipt = null, extra = {} } = {}) {
    return observeResponse(stageContext, { targetState: 'completed', httpStatus, responseBytes, transportReceipt, extra });
  }

  function makeReceipt({ state, reasonCode = null, uploadMethod = null, fileBytes, fileSha256,
    initHttpStatus = null, completeHttpStatus = null, signedPutRequestCount = 0,
    completedPartCount = 0, statusPollCount = 0, diagnostics, uploadRefData = null, attachmentRef = null }) {
    const result = {
      operation: 'attachment.upload.presigned',
      state,
      ownerVerified: true,
      browserRequestCount: 0,
      businessRetryAllowed: false,
      fileBytes,
      fileSha256,
      uploadMethod,
      initHttpStatus,
      signedPutRequestCount,
      completedPartCount,
      completeHttpStatus,
      statusPollCount,
      diagnostics: diagnostics.map(item => ({ ...item })),
      ...(diagnostics.some(item => item.auditPersistence?.state === 'failed')
        ? { stageAuditPersistence: { state: 'failed', failedStages: diagnostics.filter(item => item.auditPersistence?.state === 'failed').length,
          errorCode: 'ATTACHMENT_STAGE_AUDIT_WRITE_FAILED', businessRetryAllowed: false } }
        : { stageAuditPersistence: { state: 'stored', stageCount: diagnostics.length } }),
      ...(reasonCode ? { reasonCode } : {}),
    };
    if (uploadRefData) {
      const uploadRef = Object.freeze(Object.create(null));
      uploadRefs.set(uploadRef, uploadRefData);
      Object.defineProperty(result, 'uploadRef', { enumerable: false, value: uploadRef });
    }
    if (attachmentRef) {
      Object.defineProperty(result, 'attachmentRef', { enumerable: false,
        value: Object.freeze({ ...attachmentRef }) });
    }
    return result;
  }

  async function callSubmit(stageContext, operationId, input, { intentId, signal, retainResponseInMemory = false,
    requestMetadataHeaders = {}, sourceDiscoveryPermit = null } = {}) {
    const dynamicHeaders = getRequestMetadataHeaders
      ? await getRequestMetadataHeaders(Object.freeze({ operationId, input, ownerScopeSha256: stageContext.ownerIdentityDigest })) : {};
    await currentVerifiedOwner(stageContext.ownerIdentityDigest);
    const options = {
      confirm: true,
      intentId,
      signal,
      requestMetadataHeaders: { ...dynamicHeaders, ...requestMetadataHeaders },
      expectedOwnerScopeSha256: stageContext.ownerIdentityDigest,
      retainResponseInMemory,
      onResponseCheckpoint: async event => {
        const receipt = stageReceipt(stageContext, 'response_observed', {
          httpStatus: event.responseReceipt.responseStatus,
          ...sanitizeTransportReceipt(event.responseReceipt), responseBodyTruncated: false, businessRetryAllowed: false,
        });
        stageContext.responseObserved = true;
        await persistStageReceipt(stageContext, receipt, 'response_observed');
      },
      ...(sourceDiscoveryPermit ? { sourceDiscoveryPermit } : {}),
    };
    let submitted;
    try {
      submitted = await client.submit(operationId, input, options);
      if (submitted.journalPersistence?.state === 'failed' || submitted.responseCheckpoint?.state === 'failed') {
        throw fail('ATTACHMENT_INNER_JOURNAL_CHECKPOINT_FAILED');
      }
      await markStageComplete(stageContext, {
        httpStatus: submitted.httpStatus ?? null,
        responseBytes: submitted.responseReceipt?.responseBytes ?? null,
        transportReceipt: submitted.responseReceipt,
      });
      return submitted;
    } catch (error) {
      if (submitted) {
        try { Object.defineProperty(error, 'presignedSubmitResult', { enumerable: false, value: submitted }); } catch { /* keep safe error */ }
      }
      if (!stageContext.responseObserved && !stageContext.journalStateWriteFailed) {
        const current = await operationJournal.get(stageContext.localOperationId).catch(() => null);
        if (current?.state === 'sending') {
          const knownPreDispatch = KNOWN_PRE_DISPATCH_CODES.has(error?.code);
          await transitionStage(stageContext, knownPreDispatch ? 'rejected' : 'outcome_unknown', {
            reasonCode: knownPreDispatch ? safeReason(error) : 'ATTACHMENT_REQUEST_OUTCOME_UNKNOWN',
          }).catch(() => {});
        }
      }
      throw error;
    }
  }

  async function readStatus(uploadRefData, { intentId, ordinal, signal, diagnostics }) {
    const operationId = operationIds.status;
    const requestDigest = hashJson({ operationId, uploadId: uploadRefData.uploadId });
    const stageContext = await beginStage({ stage: 'status', ordinal, requestDigest, requestBytes: 0,
      ownerIdentityDigest: uploadRefData.ownerIdentityDigest, intentId });
    trackStage(stageContext, diagnostics);
    try {
      const result = await client.read(operationId, { uploadId: uploadRefData.uploadId }, {
        signal,
        expectedOwnerScopeSha256: uploadRefData.ownerIdentityDigest,
        ...(discoveryPermits.status ? { sourceDiscoveryPermit: discoveryPermits.status } : {}),
      });
      if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300 || !object(result.data)) {
        await observeResponse(stageContext, { targetState: 'rejected', httpStatus: result.status ?? null,
          responseBytes: result.responseBytes ?? null, reasonCode: 'ATTACHMENT_STATUS_RESPONSE_INVALID',
          transportReceipt: { method: 'GET', requestDigest: result.requestDigest, responseDigest: result.responseDigest,
            responseDigestKind: 'parsed_json_data', responseStatus: result.status, responseContentType: result.contentType,
            responseBytes: result.responseBytes, requestHeaderNames: result.transportEvidence?.requestHeaderNames,
            cookieNames: result.transportEvidence?.cookieNames } });
        diagnostics[diagnostics.length - 1] = stageContext.receipt;
        return { state: 'UNKNOWN', result: null, reasonCode: 'ATTACHMENT_STATUS_RESPONSE_INVALID' };
      }
      await markStageComplete(stageContext, { httpStatus: result.status, responseBytes: result.responseBytes ?? null,
        transportReceipt: { method: 'GET', requestDigest: result.requestDigest, responseDigest: result.responseDigest,
          responseDigestKind: 'parsed_json_data', responseStatus: result.status, responseContentType: result.contentType,
          responseBytes: result.responseBytes, requestHeaderNames: result.transportEvidence?.requestHeaderNames,
          cookieNames: result.transportEvidence?.cookieNames } });
      diagnostics[diagnostics.length - 1] = stageContext.receipt;
      uploadRefData.statusOrdinal = Math.max(uploadRefData.statusOrdinal, ordinal);
      return { state: normalizedStatus(result.data.status), result: result.data, reasonCode: null };
    } catch (error) {
      if (!stageContext.responseObserved && !stageContext.journalStateWriteFailed) {
        const current = await operationJournal.get(stageContext.localOperationId).catch(() => null);
        if (current?.state === 'sending') {
          await transitionStage(stageContext, 'rejected', { reasonCode: 'ATTACHMENT_STATUS_READ_FAILED' }).catch(() => {});
        }
      }
      diagnostics[diagnostics.length - 1] = stageContext.receipt;
      return { state: 'UNKNOWN', result: null, reasonCode: safeReason(error, 'ATTACHMENT_STATUS_READ_FAILED') };
    }
  }

  async function readFileMetadata(uploadRefData, fileMetadataId, { intentId, ordinal, signal, diagnostics }) {
    const operationId = operationIds.fileMetadata;
    const requestDigest = hashJson({ operationId, fileMetadataId });
    const stageContext = await beginStage({ stage: 'fileMetadata', ordinal, requestDigest, requestBytes: 0,
      ownerIdentityDigest: uploadRefData.ownerIdentityDigest, intentId });
    trackStage(stageContext, diagnostics);
    try {
      const result = await client.read(operationId, { fileMetadataId }, {
        signal,
        expectedOwnerScopeSha256: uploadRefData.ownerIdentityDigest,
        ...(discoveryPermits.fileMetadata ? { sourceDiscoveryPermit: discoveryPermits.fileMetadata } : {}),
      });
      if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300 || !object(result.data)) {
        await observeResponse(stageContext, { targetState: 'rejected', httpStatus: result.status ?? null,
          responseBytes: result.responseBytes ?? null, reasonCode: 'ATTACHMENT_METADATA_READBACK_INVALID',
          transportReceipt: { method: 'POST', requestDigest: result.requestDigest, responseDigest: result.responseDigest,
            responseDigestKind: 'parsed_json_data', responseStatus: result.status, responseContentType: result.contentType,
            responseBytes: result.responseBytes, requestHeaderNames: result.transportEvidence?.requestHeaderNames,
            cookieNames: result.transportEvidence?.cookieNames } });
        diagnostics[diagnostics.length - 1] = stageContext.receipt;
        throw fail('ATTACHMENT_METADATA_READBACK_INVALID');
      }
      await markStageComplete(stageContext, { httpStatus: result.status, responseBytes: result.responseBytes ?? null,
        transportReceipt: { method: 'POST', requestDigest: result.requestDigest, responseDigest: result.responseDigest,
          responseDigestKind: 'parsed_json_data', responseStatus: result.status, responseContentType: result.contentType,
          responseBytes: result.responseBytes, requestHeaderNames: result.transportEvidence?.requestHeaderNames,
          cookieNames: result.transportEvidence?.cookieNames } });
      diagnostics[diagnostics.length - 1] = stageContext.receipt;
      return result.data;
    } catch (error) {
      if (!stageContext.responseObserved && !stageContext.journalStateWriteFailed) {
        const current = await operationJournal.get(stageContext.localOperationId).catch(() => null);
        if (current?.state === 'sending') {
          await transitionStage(stageContext, 'rejected', { reasonCode: 'ATTACHMENT_METADATA_READBACK_FAILED' }).catch(() => {});
        }
      }
      diagnostics[diagnostics.length - 1] = stageContext.receipt;
      throw fail(safeReason(error, 'ATTACHMENT_METADATA_READBACK_FAILED'));
    }
  }

  async function finishFromMetadata(metadataValue, context) {
    const metadata = validateMetadata(metadataValue, context);
    const ref = {
      assetId: context.assetId ?? metadata.fileMetadataId,
      fileMetadataId: metadata.fileMetadataId,
      fileUri: metadata.fileUri,
      fileName: context.fileName,
      fileMimeType: context.mimeType,
      sizeBytes: context.byteCount,
    };
    return ref;
  }

  async function recordInitIssuance(init, stageContext, uploadRefData) {
    validateInitResponse(init);
    const receipt = Object.freeze(projectGrokUploadInitCheckpoint({ ...stageContext.receipt,
      sourceOperationId: operationIds.init,
      ownerScopeSha256: uploadRefData.ownerIdentityDigest,
      callerIntentSha256: hash(Buffer.from(uploadRefData.intentId, 'utf8')),
      issuedUploadIdSha256: hash(Buffer.from(init.uploadId, 'utf8')),
      issuedAssetIdSha256: hash(Buffer.from(init.assetId, 'utf8')),
      responseBodyTruncated: false,
      journalState: stageContext.journalState,
      journalStateWriteFailed: stageContext.journalStateWriteFailed,
    }));
    uploadRefData.initCheckpointPath = await persistStageReceipt(stageContext, receipt, 'init_resource_issued') ?? null;
  }

  async function upload({ fileName, mimeType, bytes: suppliedBytes, fileSource,
    sourceConversationId, ownerIdentityDigest: suppliedOwnerDigest, intentId: suppliedIntentId,
    confirm, policy: suppliedPolicy, requiredUploadMethod, signal } = {}) {
    const safeFileName = validateFileName(fileName);
    const safeMimeType = validateMimeType(mimeType);
    if (!Buffer.isBuffer(suppliedBytes) && !(suppliedBytes instanceof Uint8Array)) throw fail('ATTACHMENT_BYTES_INVALID');
    const bytes = Buffer.from(suppliedBytes);
    if (bytes.length < 1) {
      bytes.fill(0);
      throw fail('ATTACHMENT_BYTES_INVALID');
    }
    let policy;
    let intentId;
    let ownerIdentityDigest;
    try {
      policy = validatePolicy(suppliedPolicy, bytes.length);
      intentId = validateIntent(suppliedIntentId, confirm);
      ownerIdentityDigest = validateOwnerDigest(suppliedOwnerDigest);
      if (requiredUploadMethod !== undefined && requiredUploadMethod !== 'multipart') {
        throw fail('ATTACHMENT_REQUIRED_UPLOAD_METHOD_INVALID');
      }
      if (fileSource !== undefined) validText(fileSource, 'ATTACHMENT_FILE_SOURCE_INVALID', 128);
      if (sourceConversationId !== undefined) validText(sourceConversationId, 'ATTACHMENT_SOURCE_CONVERSATION_ID_INVALID', 512);
    } catch (error) {
      bytes.fill(0);
      throw error;
    }

    let verifiedOwnerDigest;
    try {
      verifiedOwnerDigest = await currentVerifiedOwner(ownerIdentityDigest);
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
    ownerIdentityDigest = verifiedOwnerDigest;

    const byteCount = bytes.length;
    const fileSha256 = hash(bytes);
    const diagnostics = [];
    const uploadRefData = {
      ownerIdentityDigest,
      uploadId: null,
      assetId: null,
      fileName: safeFileName,
      mimeType: safeMimeType,
      byteCount,
      intentId,
      statusOrdinal: 0,
      abortAttempted: false,
      terminal: false,
      policy,
    };
    let uploadMethod = null;
    let initHttpStatus = null;
    let completeHttpStatus = null;
    let signedPutRequestCount = 0;
    let completedPartCount = 0;
    let statusPollCount = 0;
    let attachmentRef = null;
    let overallState = 'needs_review';
    let reasonCode = null;
    let privateResponseOperation = null;
    let signedUrl = null;
    let signedHeaders = null;
    let transportManagedHeaderNames = [];
    const completedParts = [];

    try {
      if (signal?.aborted) throw fail('ATTACHMENT_UPLOAD_ABORTED_BEFORE_INIT');
      const initInput = {
        fileName: safeFileName,
        fileMimeType: safeMimeType,
        sizeBytes: String(byteCount),
        multipartSupported: policy.multipartSupported,
        ...(fileSource !== undefined ? { fileSource } : {}),
      };
      const initDigest = hashJson({ operationId: operationIds.init, initInput });
      const initStage = await beginStage({ stage: 'init', requestDigest: initDigest, requestBytes: 0,
        ownerIdentityDigest, intentId });
      trackStage(initStage, diagnostics);
      try {
        privateResponseOperation = await callSubmit(initStage, operationIds.init, initInput, {
          intentId: `${intentId}/init`, signal, retainResponseInMemory: true,
          sourceDiscoveryPermit: discoveryPermits.init ?? null,
        });
      } catch (error) {
        privateResponseOperation = error?.presignedSubmitResult ?? null;
        diagnostics[0] = initStage.receipt;
        throw error;
      }
      initHttpStatus = privateResponseOperation.httpStatus ?? null;
      diagnostics[0] = initStage.receipt;
      const init = await client.getInMemoryPrivateResponse(privateResponseOperation.localOperationId);
      const initLocalOperationId = privateResponseOperation.localOperationId;
      await client.clearInMemoryPrivateResponse(initLocalOperationId).catch(() => {});
      await client.clearInMemoryServiceJobId?.(initLocalOperationId).catch(() => {});
      privateResponseOperation = null;
      if (!object(init)) {
        overallState = 'needs_review';
        reasonCode = 'ATTACHMENT_INIT_PRIVATE_RESPONSE_MISSING';
        return makeReceipt({ state: overallState, reasonCode, uploadMethod, fileBytes: byteCount, fileSha256,
          initHttpStatus, completeHttpStatus, signedPutRequestCount, completedPartCount, statusPollCount,
          diagnostics, uploadRefData });
      }
      if (typeof init.uploadId === 'string' && init.uploadId && init.uploadId.length <= 512
        && !/[\r\n\0]/.test(init.uploadId)) uploadRefData.uploadId = init.uploadId;
      if (typeof init.assetId === 'string' && init.assetId && init.assetId.length <= 512
        && !/[\r\n\0]/.test(init.assetId)) uploadRefData.assetId = init.assetId;
      validateInitResponse(init);
      await recordInitIssuance(init, initStage, uploadRefData);
      // Only a real server reply is handed to an optional normal SDK producer.
      // The callback stays in memory; it must not record signed URLs or IDs.
      if (onInitResponse) await onInitResponse(init);
      uploadMethod = validateUploadMethod(init.uploadMethod);
      if (requiredUploadMethod && uploadMethod !== requiredUploadMethod) {
        overallState = 'needs_review';
        reasonCode = 'ATTACHMENT_REQUIRED_UPLOAD_METHOD_NOT_SELECTED';
        return makeReceipt({ state: overallState, reasonCode, uploadMethod, fileBytes: byteCount, fileSha256,
          initHttpStatus, completeHttpStatus, signedPutRequestCount, completedPartCount, statusPollCount,
          diagnostics, uploadRefData });
      }
      if (uploadMethod === 'resumable_unsupported') {
        uploadRefData.terminal = false;
        overallState = 'unsupported';
        reasonCode = 'ATTACHMENT_RESUMABLE_NOT_SUPPORTED';
        return makeReceipt({ state: overallState, reasonCode, uploadMethod, fileBytes: byteCount, fileSha256,
          initHttpStatus, completeHttpStatus, signedPutRequestCount, completedPartCount, statusPollCount,
          diagnostics, uploadRefData });
      }

      if (uploadMethod === 'single_put') {
        if (!object(init.singlePut) || typeof init.singlePut.url !== 'string') throw fail('ATTACHMENT_SINGLE_PUT_INIT_INVALID');
        signedUrl = await checkedSignedUrl(init.singlePut.url, signedUrlPolicy, { kind: 'single_put' });
        const validatedHeaders = validateRequiredHeaders(init.singlePut.requiredHeaders, byteCount);
        signedHeaders = validatedHeaders.headers;
        transportManagedHeaderNames = validatedHeaders.transportManagedHeaderNames;
        const stageDigest = hashJson({ stage: 'single-put', url: signedUrl, bodyDigest: fileSha256, byteCount });
        const stage = await beginStage({ stage: 'singlePut', requestDigest: stageDigest, requestBytes: byteCount,
          ownerIdentityDigest, intentId });
        trackStage(stage, diagnostics);
        signedPutRequestCount += 1;
        let putResult;
        try {
          await currentVerifiedOwner(ownerIdentityDigest);
          putResult = await putImpl({
            url: signedUrl,
            body: bytes,
            headers: { ...signedHeaders },
            transportManagedHeaderNames,
            signal,
            credentials: 'omit',
            redirect: 'error',
          });
        } catch {
          await transitionStage(stage, 'outcome_unknown', { reasonCode: 'ATTACHMENT_SIGNED_PUT_OUTCOME_UNKNOWN' });
          diagnostics[diagnostics.length - 1] = stage.receipt;
          throw fail('ATTACHMENT_SIGNED_PUT_OUTCOME_UNKNOWN');
        }
        const status = putResult?.status;
        if (!Number.isInteger(status) || status < 200 || status >= 300) {
          await observeResponse(stage, { targetState: 'rejected',
            httpStatus: Number.isInteger(status) ? status : null,
            responseBytes: putResult?.responseBytes ?? null,
            reasonCode: 'ATTACHMENT_SIGNED_PUT_REJECTED',
            transportReceipt: putResult?.transportReceipt ?? {
              method: 'PUT', responseStatus: status, responseDigest: putResult?.responseDigest,
              responseDigestKind: putResult?.responseDigestKind, responseBytes: putResult?.responseBytes,
              requestHeaderNames: [...Object.keys(signedHeaders), ...transportManagedHeaderNames],
            } });
          diagnostics[diagnostics.length - 1] = stage.receipt;
          throw fail('ATTACHMENT_SIGNED_PUT_REJECTED');
        }
        await markStageComplete(stage, { httpStatus: status, responseBytes: putResult.responseBytes ?? null,
          transportReceipt: putResult.transportReceipt ?? {
            method: 'PUT', responseStatus: status, responseDigest: putResult.responseDigest,
            responseDigestKind: putResult.responseDigestKind,
            responseBytes: putResult.responseBytes,
            requestHeaderNames: [...Object.keys(signedHeaders), ...transportManagedHeaderNames],
          } });
        diagnostics[diagnostics.length - 1] = stage.receipt;
      } else {
        if (!policy.multipartSupported) throw fail('ATTACHMENT_MULTIPART_DISABLED_BY_POLICY');
        const multipart = validateParts(init.multipart, byteCount);
        const signedParts = [];
        for (const part of multipart.parts) {
          signedParts.push({
            partNumber: part.partNumber,
            url: await checkedSignedUrl(part.url, signedUrlPolicy, { kind: 'multipart_part', partNumber: part.partNumber }),
          });
        }
        const parts = signedParts.map((part, index) => ({
          ...part,
          start: index * multipart.partSize,
          end: Math.min((index + 1) * multipart.partSize, byteCount),
        }));
        let nextIndex = 0;
        let stopScheduling = false;
        let firstFailure = null;
        const workers = Array.from({ length: Math.min(policy.multipartConcurrency, parts.length) }, async () => {
          while (!stopScheduling) {
            const index = nextIndex++;
            if (index >= parts.length) return;
            const part = parts[index];
            const partBytes = part.end - part.start;
            const partBody = bytes.subarray(part.start, part.end);
            const partDigest = hash(partBody);
            const stageDigest = hashJson({ stage: 'multipart-part', partNumber: part.partNumber,
              url: part.url, bodyDigest: partDigest, byteCount: partBytes });
            let stage;
            let diagnosticIndex = -1;
            try {
              stage = await beginStage({ stage: 'multipartPart', ordinal: part.partNumber,
                requestDigest: stageDigest, requestBytes: partBytes, ownerIdentityDigest, intentId });
              diagnosticIndex = trackStage(stage, diagnostics);
            } catch (error) {
              stopScheduling = true;
              firstFailure ??= error;
              return;
            }
            signedPutRequestCount += 1;
            let putResult;
            try {
              await currentVerifiedOwner(ownerIdentityDigest);
              putResult = await putImpl({
                url: part.url,
                body: partBody,
                headers: {},
                signal,
                credentials: 'omit',
                redirect: 'error',
              });
            } catch {
              await transitionStage(stage, 'outcome_unknown', { reasonCode: 'ATTACHMENT_MULTIPART_PART_OUTCOME_UNKNOWN' });
              diagnostics[diagnosticIndex] = stage.receipt;
              stopScheduling = true;
              firstFailure ??= fail('ATTACHMENT_MULTIPART_PART_OUTCOME_UNKNOWN');
              return;
            }
            const status = putResult?.status;
            if (!Number.isInteger(status) || status < 200 || status >= 300) {
              try {
                await observeResponse(stage, { targetState: 'rejected',
                  httpStatus: Number.isInteger(status) ? status : null,
                  responseBytes: putResult?.responseBytes ?? null,
                  reasonCode: 'ATTACHMENT_MULTIPART_PART_REJECTED',
                  transportReceipt: putResult?.transportReceipt ?? {
                    method: 'PUT', responseStatus: status, responseDigest: putResult?.responseDigest,
                    responseDigestKind: putResult?.responseDigestKind, responseBytes: putResult?.responseBytes,
                    requestHeaderNames: [],
                  } });
              } catch (error) {
                diagnostics[diagnosticIndex] = stage.receipt;
                stopScheduling = true;
                firstFailure ??= error;
                return;
              }
              diagnostics[diagnosticIndex] = stage.receipt;
              stopScheduling = true;
              firstFailure ??= fail('ATTACHMENT_MULTIPART_PART_REJECTED');
              return;
            }
            const etag = responseHeader(putResult.headers, 'etag') ?? putResult.etag ?? null;
            if (typeof etag !== 'string' || !etag || etag.length > 1024 || /[\r\n\0]/.test(etag)) {
              try {
                await observeResponse(stage, { targetState: 'needs_review', httpStatus: status,
                  responseBytes: putResult.responseBytes ?? null, reasonCode: 'ATTACHMENT_MULTIPART_ETAG_MISSING',
                  transportReceipt: putResult.transportReceipt ?? {
                    method: 'PUT', responseStatus: status, responseDigest: putResult.responseDigest,
                    responseDigestKind: putResult.responseDigestKind, responseBytes: putResult.responseBytes,
                    requestHeaderNames: [],
                  }, extra: { etagPresent: false } });
              } catch (error) {
                diagnostics[diagnosticIndex] = stage.receipt;
                stopScheduling = true;
                firstFailure ??= error;
                return;
              }
              diagnostics[diagnosticIndex] = stage.receipt;
              stopScheduling = true;
              firstFailure ??= fail('ATTACHMENT_MULTIPART_ETAG_MISSING');
              return;
            }
            try {
              await markStageComplete(stage, { httpStatus: status, responseBytes: putResult.responseBytes ?? null,
                transportReceipt: putResult.transportReceipt ?? {
                  method: 'PUT', responseStatus: status, responseDigest: putResult.responseDigest,
                  responseDigestKind: putResult.responseDigestKind,
                  responseBytes: putResult.responseBytes,
                  requestHeaderNames: [],
                }, extra: { etagPresent: true } });
            } catch (error) {
              diagnostics[diagnosticIndex] = stage.receipt;
              stopScheduling = true;
              firstFailure ??= error;
              return;
            }
            diagnostics[diagnosticIndex] = stage.receipt;
            completedParts.push({ partNumber: part.partNumber, etag });
            completedPartCount += 1;
          }
        });
        await Promise.all(workers);
        signedUrl = null;
        signedHeaders = null;
        if (firstFailure) throw firstFailure;
        completedParts.sort((a, b) => a.partNumber - b.partNumber);
      }
      signedUrl = null;
      signedHeaders = null;

      const completeInput = { presigned: { uploadId: uploadRefData.uploadId, completedParts } };
      const completeHeaders = sourceConversationId ? { 'x-source-conversation-id': sourceConversationId } : {};
      const completeDigest = hashJson({ operationId: operationIds.complete, completeInput,
        sourceConversationId: sourceConversationId ?? null });
      const completeStage = await beginStage({ stage: 'complete', requestDigest: completeDigest, requestBytes: 0,
        ownerIdentityDigest, intentId });
      trackStage(completeStage, diagnostics);
      let completeResult;
      try {
        completeResult = await callSubmit(completeStage, operationIds.complete, completeInput, {
          intentId: `${intentId}/complete`, signal, retainResponseInMemory: true,
          requestMetadataHeaders: completeHeaders,
          sourceDiscoveryPermit: discoveryPermits.complete ?? null,
        });
      } catch (error) {
        privateResponseOperation = error?.presignedSubmitResult ?? null;
        diagnostics[diagnostics.length - 1] = completeStage.receipt;
        throw error;
      }
      completeHttpStatus = completeResult.httpStatus ?? null;
      diagnostics[diagnostics.length - 1] = completeStage.receipt;
      privateResponseOperation = completeResult;
      const completed = await client.getInMemoryPrivateResponse(completeResult.localOperationId);
      if (!object(completed)) {
        overallState = 'needs_review';
        reasonCode = 'ATTACHMENT_COMPLETE_PRIVATE_RESPONSE_MISSING';
        return makeReceipt({ state: overallState, reasonCode, uploadMethod, fileBytes: byteCount, fileSha256,
          initHttpStatus, completeHttpStatus, signedPutRequestCount, completedPartCount, statusPollCount,
          diagnostics, uploadRefData });
      }
      // The paused first-party SDK request must receive the exact parsed reply
      // returned by this one direct API call. Keep the callback in-process; the
      // response may contain private upload identifiers or metadata.
      if (onCompleteResponse) await onCompleteResponse(completed);
      if (completed.terminalError !== undefined && completed.terminalError !== null) {
        overallState = 'failed';
        reasonCode = 'ATTACHMENT_SERVER_TERMINAL_ERROR';
        return makeReceipt({ state: overallState, reasonCode, uploadMethod, fileBytes: byteCount, fileSha256,
          initHttpStatus, completeHttpStatus, signedPutRequestCount, completedPartCount, statusPollCount,
          diagnostics, uploadRefData });
      }
      if (object(completed.fileMetadata)) {
        attachmentRef = await finishFromMetadata(completed.fileMetadata, {
          fileName: safeFileName, mimeType: safeMimeType, byteCount, assetId: uploadRefData.assetId,
        });
      } else {
        if (typeof completed.uploadId !== 'string' || !completed.uploadId) throw fail('ATTACHMENT_COMPLETE_RESPONSE_INVALID');
        uploadRefData.uploadId = completed.uploadId;
        let foundMetadata = null;
        let terminalStatus = null;
        for (let poll = 1; poll <= policy.maxStatusReads; poll += 1) {
          statusPollCount = poll;
          const statusResult = await readStatus(uploadRefData, {
            intentId: `${intentId}/status`, ordinal: poll, signal, diagnostics,
          });
          if (!statusResult.result) {
            overallState = 'needs_review';
            reasonCode = statusResult.reasonCode;
            break;
          }
          terminalStatus = statusResult.state;
          if (terminalStatus === 'SUCCESS') {
            if (typeof statusResult.result.assetId === 'string' && statusResult.result.assetId) {
              uploadRefData.assetId = statusResult.result.assetId;
            }
            if (object(statusResult.result.fileMetadata)) foundMetadata = statusResult.result.fileMetadata;
            else if (typeof statusResult.result.assetId === 'string' && statusResult.result.assetId) {
              foundMetadata = await readFileMetadata(uploadRefData, statusResult.result.assetId, {
                intentId: `${intentId}/metadata`, ordinal: poll, signal, diagnostics,
              });
              uploadRefData.assetId = statusResult.result.assetId;
            }
            if (!foundMetadata) {
              overallState = 'needs_review';
              reasonCode = 'ATTACHMENT_SUCCESS_METADATA_MISSING';
            }
            break;
          }
          if (['ERROR', 'ABORTED', 'EXPIRED'].includes(terminalStatus)) {
            overallState = terminalStatus === 'ERROR' ? 'failed' : terminalStatus.toLowerCase();
            reasonCode = `ATTACHMENT_UPLOAD_${terminalStatus}`;
            uploadRefData.terminal = true;
            break;
          }
          if (terminalStatus === 'UNKNOWN') {
            overallState = 'needs_review';
            reasonCode = 'ATTACHMENT_UPLOAD_STATUS_UNKNOWN';
            break;
          }
          if (poll < policy.maxStatusReads) await delay(policy.statusPollIntervalMs, signal);
        }
        if (foundMetadata) {
          attachmentRef = await finishFromMetadata(foundMetadata, {
            fileName: safeFileName, mimeType: safeMimeType, byteCount,
            assetId: uploadRefData.assetId,
          });
        } else if (!reasonCode) {
          overallState = 'processing';
          reasonCode = 'ATTACHMENT_UPLOAD_STILL_PROCESSING';
        }
      }
      if (attachmentRef) {
        overallState = 'completed';
        reasonCode = null;
        uploadRefData.terminal = true;
      }
      return makeReceipt({ state: overallState, reasonCode, uploadMethod, fileBytes: byteCount, fileSha256,
        initHttpStatus, completeHttpStatus, signedPutRequestCount, completedPartCount, statusPollCount,
        diagnostics, uploadRefData: overallState === 'completed' ? null : uploadRefData, attachmentRef });
    } catch (error) {
      if (privateResponseOperation?.localOperationId && !uploadRefData.uploadId) {
        const known = await client.getInMemoryPrivateResponse(privateResponseOperation.localOperationId).catch(() => null);
        if (object(known) && typeof known.uploadId === 'string' && known.uploadId && !/[\r\n\0]/.test(known.uploadId)) {
          uploadRefData.uploadId = known.uploadId;
          uploadRefData.assetId = typeof known.assetId === 'string' ? known.assetId : null;
          const initStage = diagnostics.find(item => item.stage === 'init');
          initHttpStatus = privateResponseOperation.httpStatus
            ?? privateResponseOperation.responseReceipt?.responseStatus
            ?? initStage?.httpStatus ?? initHttpStatus;
          const checkpointFailure = privateResponseOperation.responseCheckpoint?.state === 'failed';
          const innerJournalFailure = privateResponseOperation.journalPersistence?.state === 'failed';
          const outerJournalFailure = initStage?.journalStateWriteFailed === true
            || error?.code === 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED';
          const journalFailureCode = innerJournalFailure
            ? privateResponseOperation.journalPersistence.errorCode
            : initStage?.journalFailureCode ?? (outerJournalFailure ? 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED' : undefined);
          const failureCheckpoint = checkpointFailure
            ? {
              journalState: 'sending',
              journalStateWriteFailed: false,
              checkpointFailure: true,
              checkpointFailureCode: privateResponseOperation.responseCheckpoint.errorCode ?? 'RESPONSE_CHECKPOINT_FAILED',
            }
            : {
              journalState: initStage?.journalState ?? 'sending',
              journalStateWriteFailed: innerJournalFailure || outerJournalFailure,
              checkpointFailure: false,
              ...(journalFailureCode ? { journalFailureCode } : {}),
            };
          const issuance = Object.freeze(projectGrokUploadInitCheckpoint({ ...initStage, checkpoint: 'init_resource_issued',
            sourceOperationId: operationIds.init, ownerScopeSha256: uploadRefData.ownerIdentityDigest,
            callerIntentSha256: hash(Buffer.from(uploadRefData.intentId, 'utf8')),
            issuedUploadIdSha256: hash(Buffer.from(known.uploadId, 'utf8')),
            issuedAssetIdSha256: typeof known.assetId === 'string' ? hash(Buffer.from(known.assetId, 'utf8')) : null,
            responseBodyTruncated: false,
            ...failureCheckpoint,
            ...(checkpointFailure ? { reasonCode: 'RESPONSE_CHECKPOINT_FAILED' }
              : journalFailureCode ? { reasonCode: journalFailureCode }
                : { reasonCode: 'ATTACHMENT_INNER_JOURNAL_CHECKPOINT_FAILED' }),
          }));
          try { uploadRefData.initCheckpointPath = await onStageReceipt(issuance); } catch { /* preserve observed response without replay */ }
        }
      }
      if (['ATTACHMENT_JOURNAL_STATE_WRITE_FAILED', 'ATTACHMENT_STAGE_AUDIT_CHECKPOINT_FAILED', 'ATTACHMENT_INNER_JOURNAL_CHECKPOINT_FAILED'].includes(error?.code)) {
        overallState = diagnostics.some(item => item.state === 'response_observed') ? 'response_observed' : 'needs_review';
      } else {
        overallState = error?.code?.includes('OUTCOME_UNKNOWN') ? 'outcome_unknown' : 'needs_review';
      }
      reasonCode = safeReason(error);
      return makeReceipt({ state: overallState, reasonCode, uploadMethod, fileBytes: byteCount, fileSha256,
        initHttpStatus, completeHttpStatus, signedPutRequestCount, completedPartCount, statusPollCount,
        diagnostics, uploadRefData: uploadRefData.uploadId ? uploadRefData : null });
    } finally {
      signedUrl = null;
      signedHeaders = null;
      for (const part of completedParts) part.etag = '';
      completedParts.length = 0;
      bytes.fill(0);
      if (privateResponseOperation?.localOperationId) {
        await client.clearInMemoryPrivateResponse?.(privateResponseOperation.localOperationId).catch(() => {});
        await client.clearInMemoryServiceJobId?.(privateResponseOperation.localOperationId).catch(() => {});
      }
    }
  }

  async function status({ uploadRef, intentId: suppliedIntentId, signal } = {}) {
    const intentId = validateIntent(suppliedIntentId, true);
    const ref = uploadRefs.get(uploadRef);
    if (!ref || !ref.uploadId) throw fail('ATTACHMENT_UPLOAD_REF_INVALID');
    await currentVerifiedOwner(ref.ownerIdentityDigest);
    const ordinal = ++ref.statusOrdinal;
    const diagnostics = [];
    const result = await readStatus(ref, { intentId, ordinal, signal, diagnostics });
    if (['SUCCESS', 'ERROR', 'ABORTED', 'EXPIRED'].includes(result.state)) ref.terminal = true;
    return {
      operation: operationIds.status,
      state: result.state.toLowerCase(),
      httpReadCount: diagnostics.length,
      diagnostics: diagnostics.map(item => ({ ...item })),
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    };
  }

  async function abort({ uploadRef, intentId: suppliedIntentId, confirm, signal } = {}) {
    const intentId = validateIntent(suppliedIntentId, confirm);
    const ref = uploadRefs.get(uploadRef);
    if (!ref || !ref.uploadId) throw fail('ATTACHMENT_UPLOAD_REF_INVALID');
    if (ref.terminal) throw fail('ATTACHMENT_UPLOAD_ALREADY_TERMINAL');
    if (ref.abortAttempted) throw fail('OPERATION_ALREADY_ATTEMPTED');
    await currentVerifiedOwner(ref.ownerIdentityDigest);
    ref.abortAttempted = true;
    const diagnostics = [];
    const abortInput = { uploadId: ref.uploadId };
    const requestDigest = hashJson({ operationId: operationIds.abort, abortInput });
    const stage = await beginStage({ stage: 'abort', requestDigest, requestBytes: 0,
      ownerIdentityDigest: ref.ownerIdentityDigest, intentId });
    trackStage(stage, diagnostics);
    let submitted;
    try {
      submitted = await callSubmit(stage, operationIds.abort, abortInput, {
        intentId: `${intentId}/abort`, signal, retainResponseInMemory: true,
        sourceDiscoveryPermit: discoveryPermits.abort ?? null,
      });
      diagnostics[0] = stage.receipt;
    } catch (error) {
      if (error?.presignedSubmitResult?.localOperationId) {
        await client.clearInMemoryPrivateResponse(error.presignedSubmitResult.localOperationId).catch(() => {});
        await client.clearInMemoryServiceJobId?.(error.presignedSubmitResult.localOperationId).catch(() => {});
      }
      diagnostics[0] = stage.receipt;
      return {
        operation: operationIds.abort,
        state: stage.receipt.state === 'response_observed' ? 'response_observed' : 'outcome_unknown',
        abortRequestCount: 1,
        abortVerified: false,
        businessRetryAllowed: false,
        diagnostics: diagnostics.map(item => ({ ...item })),
        reasonCode: safeReason(error, 'ATTACHMENT_ABORT_OUTCOME_UNKNOWN'),
      };
    }
    let response = null;
    try { response = await client.getInMemoryPrivateResponse(submitted.localOperationId); } catch { response = null; }
    const finalStatus = normalizedStatus(response?.finalStatus);
    const abortVerified = response?.abortedNow === true || finalStatus === 'ABORTED';
    await client.clearInMemoryPrivateResponse?.(submitted.localOperationId).catch(() => {});
    await client.clearInMemoryServiceJobId?.(submitted.localOperationId).catch(() => {});
    if (abortVerified) ref.terminal = true;
    return {
      operation: operationIds.abort,
      state: abortVerified ? 'aborted' : 'abort_requested',
      httpStatus: submitted.httpStatus ?? null,
      abortRequestCount: 1,
      abortVerified,
      diagnostics: diagnostics.map(item => ({ ...item })),
      ...(!abortVerified ? { reasonCode: 'ATTACHMENT_ABORT_READBACK_INCOMPLETE' } : {}),
    };
  }

  async function describeUploadReference(uploadRef) {
    const ref = uploadRefs.get(uploadRef);
    if (!ref?.uploadId) throw fail('ATTACHMENT_UPLOAD_REF_INVALID');
    await currentVerifiedOwner(ref.ownerIdentityDigest);
    return Object.freeze({ uploadId: ref.uploadId, assetId: ref.assetId,
      ownerScopeSha256: ref.ownerIdentityDigest, intentId: ref.intentId,
      fileName: ref.fileName, mimeType: ref.mimeType, fileBytes: ref.byteCount,
      terminal: ref.terminal, abortAttempted: ref.abortAttempted,
      initCheckpointPath: ref.initCheckpointPath ?? null, policy: ref.policy });
  }

  async function restoreUploadReference(ticket) {
    if (!isValidatedGrokUploadResumeTicket(ticket)) throw fail('ATTACHMENT_UPLOAD_RESUME_PROOF_REQUIRED');
    await currentVerifiedOwner(ticket.ownerScopeSha256);
    const uploadRef = Object.freeze(Object.create(null));
    uploadRefs.set(uploadRef, {
      ownerIdentityDigest: ticket.ownerScopeSha256,
      uploadId: ticket.issued.uploadId, assetId: ticket.issued.assetId,
      fileName: ticket.file.fileName, mimeType: ticket.file.mimeType, byteCount: ticket.file.byteCount,
      intentId: ticket.callerIntentId, statusOrdinal: 0, terminal: false,
      abortAttempted: ticket.reference.abortAttempt?.attemptCount > 0,
    });
    return uploadRef;
  }

  return Object.freeze({ upload, status, abort, describeUploadReference, restoreUploadReference });
}

export { defaultSignedPut as executeGrokSignedStoragePut };
