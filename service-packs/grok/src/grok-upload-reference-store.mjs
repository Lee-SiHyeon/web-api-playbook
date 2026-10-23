import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const INTENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REFERENCE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._~:/+-=]{0,511}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIME = /^[A-Za-z0-9.+-]{1,80}\/[A-Za-z0-9.+-]{1,80}$/;
const CHECKPOINT_FILE = /^[a-f0-9]{64}-init_resource_issued-[0-9a-f-]{36}\.json$/i;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_CHECKPOINT_BYTES = 128 * 1024;
const UNRESOLVED_STATES = new Set(['processing', 'needs_review', 'unsupported', 'outcome_unknown', 'response_observed']);
const CHECKPOINT_FIELDS = new Set([
  'checkpoint', 'stage', 'ordinal', 'state', 'journalState', 'journalStateWriteFailed', 'journalFailureCode',
  'checkpointFailure', 'checkpointFailureCode',
  'sourceOperationId', 'stageKey', 'requestDigest', 'transportRequestDigest', 'transportIntentDigest',
  'attemptCount', 'requestBytes', 'ownerScopeSha256', 'callerIntentSha256', 'issuedUploadIdSha256', 'issuedAssetIdSha256',
  'httpStatus', 'responseStatus', 'responseBytes', 'responseDigest', 'responseDigestKind',
  'responseContentType', 'responseBodyTruncated', 'reasonCode', 'businessRetryAllowed',
  'auditPersistence', 'auditFailureCode', 'auditPersistenceErrorCode',
]);

export function projectGrokUploadInitCheckpoint(receipt) {
  return Object.fromEntries(Object.entries(receipt).filter(([key]) => CHECKPOINT_FIELDS.has(key)));
}
const RECORD_FIELDS = new Set([
  'schemaVersion', 'serviceId', 'referenceKey', 'createdAt', 'updatedAt', 'state', 'ownerScopeSha256', 'callerIntentId',
  'callerIntentSha256', 'file', 'issued', 'initCheckpoint', 'abort',
]);
const validatedResumeTickets = new WeakSet();

export function isValidatedGrokUploadResumeTicket(value) {
  return value && typeof value === 'object' && validatedResumeTickets.has(value);
}
const FILE_FIELDS = new Set(['fileName', 'mimeType', 'byteCount', 'sha256']);
const ISSUED_FIELDS = new Set(['uploadId', 'uploadIdSha256', 'assetId', 'assetIdSha256']);
const CHECKPOINT_LINK_FIELDS = new Set([
  'fileName', 'fileSha256', 'checkpoint', 'stageKey', 'sourceOperationId', 'requestDigest',
  'transportRequestDigest', 'transportIntentDigest', 'responseStatus', 'responseBytes', 'responseDigest',
  'responseDigestKind', 'ownerScopeSha256', 'callerIntentSha256', 'issuedUploadIdSha256', 'issuedAssetIdSha256',
]);
const ABORT_FIELDS = new Set([
  'state', 'attemptCount', 'intentSha256', 'attemptedAt', 'completedAt', 'requestDigest',
  'responseStatus', 'responseBytes', 'responseDigest', 'responseDigestKind', 'reasonCode', 'preDispatchRecovery',
]);
const PRE_DISPATCH_ABORT_RECOVERY_FIELDS = new Set([
  'kind', 'recoveredAt', 'priorAttemptedAt', 'priorIntentSha256', 'priorRequestDigest',
  'stageOperationIdSha256', 'stageRequestDigest', 'stageIntentDigest', 'stageReasonCode',
  'stageHttpStatus', 'businessAbortRowsAbsent',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function failWith(code) {
  throw fail(code);
}

function assertOnlyKeys(value, allowed, code) {
  if (!object(value) || Object.keys(value).some(key => !allowed.has(key))) failWith(code);
}

function validateId(value, code) {
  if (typeof value !== 'string' || !ID.test(value) || /^(?:https?|data|blob):/i.test(value)
    || value.includes('://') || /[?#&%\s\0\r\n]/.test(value)) failWith(code);
  return value;
}

function validateIntent(value) {
  if (typeof value !== 'string' || !INTENT.test(value)) failWith('GROK_UPLOAD_REFERENCE_INTENT_INVALID');
  return value;
}

function validateScope(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) failWith('GROK_UPLOAD_REFERENCE_OWNER_REQUIRED');
  return value;
}

function validateReferenceKey(value) {
  if (typeof value !== 'string' || !REFERENCE_KEY.test(value)) failWith('GROK_UPLOAD_REFERENCE_KEY_INVALID');
  return value;
}

function validateTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value);
}

function abortRequestDigest(uploadId) {
  const abortInput = { uploadId };
  return hash(Buffer.from(JSON.stringify({ operationId: 'attachment.upload.abort', abortInput }), 'utf8'));
}

function abortStageIntentDigest(ownerScopeSha256, abortIntentId) {
  return hash(Buffer.from(`attachment.upload.stage.abort\n${ownerScopeSha256}\n${abortIntentId}\n0`, 'utf8'));
}

function validatePreDispatchAbortRecovery(value, record) {
  assertOnlyKeys(value, PRE_DISPATCH_ABORT_RECOVERY_FIELDS, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  if (value.kind !== 'source_discovery_permit_already_used'
    || !validateTime(value.recoveredAt) || !validateTime(value.priorAttemptedAt)
    || !SHA256.test(value.priorIntentSha256 ?? '')
    || !SHA256.test(value.priorRequestDigest ?? '') || value.priorRequestDigest !== record.abort.requestDigest
    || !SHA256.test(value.stageOperationIdSha256 ?? '')
    || !SHA256.test(value.stageRequestDigest ?? '') || value.stageRequestDigest !== record.abort.requestDigest
    || !SHA256.test(value.stageIntentDigest ?? '') || value.stageReasonCode !== 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED'
    || value.stageHttpStatus !== null || value.businessAbortRowsAbsent !== true) {
    failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  }
}

function assertNoPrivateCheckpointValues(value, depth = 0) {
  if (depth > 16) failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateCheckpointValues(item, depth + 1);
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:cookie|cookies|cookieValue|sso|token|accessToken|refreshToken|authorization|secret|signature|signedUrl|url|etag|uploadId|assetId|fileMetadataId|fileUri|requestBody|responseBody)$/i.test(key)) {
        failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_PRIVATE_FIELD');
      }
      if (key === 'issuedUploadIdSha256' || key === 'issuedAssetIdSha256') {
        if (typeof child !== 'string' || !SHA256.test(child)) failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
      }
      assertNoPrivateCheckpointValues(child, depth + 1);
    }
  } else if (typeof value === 'string' && /https?:\/\//i.test(value)) {
    failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_PRIVATE_VALUE');
  }
}

function homeScratchRoot() {
  return path.resolve(homedir(), '.nad-scratch');
}

function resolveScratchChild(candidate, code) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) failWith(code);
  const base = homeScratchRoot();
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) failWith(code);
  if (relative.split(path.sep).some(part => !part || part === '.' || part === '..')) failWith(code);
  return resolved;
}

async function ensurePrivateDirectory(directory, { create = false } = {}) {
  const base = homeScratchRoot();
  const baseInfo = await lstat(base).catch(error => {
    if (error?.code === 'ENOENT' && create) return null;
    failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
  });
  if (baseInfo && (baseInfo.isSymbolicLink() || !baseInfo.isDirectory())) failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
  if (!baseInfo && create) {
    await mkdir(base, { mode: 0o700 }).catch(error => {
      if (error?.code !== 'EEXIST') failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
    });
  }

  const relative = path.relative(base, directory);
  let current = base;
  const segments = relative.split(path.sep);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
    current = path.join(current, segment);
    let info = await lstat(current).catch(error => {
      if (error?.code === 'ENOENT' && create) return null;
      failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
    });
    if (!info && create) {
      await mkdir(current, { mode: 0o700 }).catch(error => {
        if (error?.code !== 'EEXIST') failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
      });
      info = await lstat(current).catch(() => failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID'));
    }
    if (info.isSymbolicLink() || !info.isDirectory()) failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
    if ((info.mode & 0o777) !== 0o700) failWith('GROK_UPLOAD_REFERENCE_PERMISSIONS_INVALID');
  }
  const real = await realpath(directory).catch(() => failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID'));
  if (real !== directory) failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID');
  return real;
}

async function readPrivateFile(filePath, rootDirectory, maxBytes, invalidCode) {
  const rootReal = await realpath(rootDirectory).catch(() => failWith('GROK_UPLOAD_REFERENCE_PATH_INVALID'));
  const info = await lstat(filePath).catch(() => failWith(invalidCode));
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (info.mode & 0o777) !== 0o600 || info.size < 2 || info.size > maxBytes) failWith(invalidCode);
  const real = await realpath(filePath).catch(() => failWith(invalidCode));
  const relative = path.relative(rootReal, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) failWith(invalidCode);
  let bytes;
  try { bytes = await readFile(real); } catch { failWith(invalidCode); }
  if (bytes.length !== info.size || bytes.length > maxBytes) failWith(invalidCode);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { failWith(invalidCode); }
  return { bytes, data, fileSha256: hash(bytes), realPath: real };
}

function validateCheckpointDocument(checkpoint, { ownerScopeSha256, callerIntentSha256, uploadId, assetId }) {
  assertOnlyKeys(checkpoint, CHECKPOINT_FIELDS, 'GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
  assertNoPrivateCheckpointValues(checkpoint);
  const responseObservedFailureValid = checkpoint.state !== 'response_observed'
    || (checkpoint.checkpointFailure === true
      ? checkpoint.checkpointFailureCode === 'RESPONSE_CHECKPOINT_FAILED'
        && checkpoint.journalState === 'sending'
        && checkpoint.journalStateWriteFailed === false
        && checkpoint.journalFailureCode === undefined
      : checkpoint.checkpointFailure === false
        && checkpoint.journalStateWriteFailed === true
        && ['ATTACHMENT_JOURNAL_STATE_WRITE_FAILED', 'JOURNAL_TRANSITION_FAILED'].includes(checkpoint.journalFailureCode)
        && checkpoint.checkpointFailureCode === undefined);
  if (checkpoint.checkpoint !== 'init_resource_issued' || checkpoint.stage !== 'init'
    || checkpoint.sourceOperationId !== 'attachment.upload.init'
    || !['completed', 'response_observed'].includes(checkpoint.state)
    || !['completed', 'accepted', 'sending', 'outcome_unknown', 'needs_review'].includes(checkpoint.journalState)
    || typeof checkpoint.journalStateWriteFailed !== 'boolean'
    || (checkpoint.checkpointFailure !== undefined && typeof checkpoint.checkpointFailure !== 'boolean')
    || (checkpoint.state === 'completed' && (checkpoint.journalState !== 'completed'
      || checkpoint.journalStateWriteFailed || checkpoint.journalFailureCode !== undefined))
    || !responseObservedFailureValid
    || (checkpoint.state !== 'response_observed'
      && (checkpoint.checkpointFailure === true || checkpoint.checkpointFailureCode !== undefined))
    || checkpoint.attemptCount !== 1
    || !SHA256.test(checkpoint.stageKey ?? '') || !SHA256.test(checkpoint.requestDigest ?? '')
    || !SHA256.test(checkpoint.transportRequestDigest ?? '') || !SHA256.test(checkpoint.transportIntentDigest ?? '')
    || checkpoint.ownerScopeSha256 !== ownerScopeSha256 || checkpoint.callerIntentSha256 !== callerIntentSha256
    || checkpoint.issuedUploadIdSha256 !== hash(Buffer.from(uploadId, 'utf8'))
    || checkpoint.issuedAssetIdSha256 !== hash(Buffer.from(assetId, 'utf8'))
    || !Number.isInteger(checkpoint.httpStatus) || checkpoint.httpStatus < 200 || checkpoint.httpStatus > 299
    || checkpoint.responseStatus !== checkpoint.httpStatus
    || !Number.isSafeInteger(checkpoint.responseBytes) || checkpoint.responseBytes < 1
    || !SHA256.test(checkpoint.responseDigest ?? '')
    || !['raw_http_body', 'parsed_json_data'].includes(checkpoint.responseDigestKind)
    || checkpoint.responseBodyTruncated !== false
    || typeof checkpoint.responseContentType !== 'string'
    || !/^application\/json(?:\s*;|$)/i.test(checkpoint.responseContentType)
    || (checkpoint.journalFailureCode !== undefined
      && !/^[A-Z][A-Z0-9_]{1,79}$/.test(checkpoint.journalFailureCode))
    || (checkpoint.reasonCode !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(checkpoint.reasonCode))) {
    failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
  }
  return checkpoint;
}

function validateRecord(record, referenceKey) {
  assertOnlyKeys(record, RECORD_FIELDS, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  if (record.schemaVersion !== 1 || record.serviceId !== 'grok-web' || record.referenceKey !== referenceKey
    || !validateTime(record.createdAt) || !validateTime(record.updatedAt) || !UNRESOLVED_STATES.has(record.state)
    || !SHA256.test(record.ownerScopeSha256 ?? '') || typeof record.callerIntentId !== 'string'
    || !INTENT.test(record.callerIntentId) || record.callerIntentSha256 !== hash(Buffer.from(record.callerIntentId, 'utf8'))) {
    failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  }
  assertOnlyKeys(record.file, FILE_FIELDS, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  if (typeof record.file.fileName !== 'string' || !FILE_NAME.test(record.file.fileName)
    || typeof record.file.mimeType !== 'string' || !MIME.test(record.file.mimeType)
    || !Number.isSafeInteger(record.file.byteCount) || record.file.byteCount < 1
    || !SHA256.test(record.file.sha256 ?? '')) failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  assertOnlyKeys(record.issued, ISSUED_FIELDS, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  validateId(record.issued.uploadId, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  validateId(record.issued.assetId, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  if (!SHA256.test(record.issued.uploadIdSha256 ?? '')
    || record.issued.uploadIdSha256 !== hash(Buffer.from(record.issued.uploadId, 'utf8'))
    || !SHA256.test(record.issued.assetIdSha256 ?? '')
    || record.issued.assetIdSha256 !== hash(Buffer.from(record.issued.assetId, 'utf8'))) {
    failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  }
  assertOnlyKeys(record.initCheckpoint, CHECKPOINT_LINK_FIELDS, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  if (typeof record.initCheckpoint.fileName !== 'string' || !CHECKPOINT_FILE.test(record.initCheckpoint.fileName)
    || !SHA256.test(record.initCheckpoint.fileSha256 ?? '') || record.initCheckpoint.checkpoint !== 'init_resource_issued'
    || !SHA256.test(record.initCheckpoint.stageKey ?? '') || record.initCheckpoint.sourceOperationId !== 'attachment.upload.init'
    || !SHA256.test(record.initCheckpoint.requestDigest ?? '') || !SHA256.test(record.initCheckpoint.transportRequestDigest ?? '')
    || !SHA256.test(record.initCheckpoint.transportIntentDigest ?? '')
    || !Number.isInteger(record.initCheckpoint.responseStatus) || record.initCheckpoint.responseStatus < 200
    || record.initCheckpoint.responseStatus > 299 || !Number.isSafeInteger(record.initCheckpoint.responseBytes)
    || record.initCheckpoint.responseBytes < 1 || !SHA256.test(record.initCheckpoint.responseDigest ?? '')
    || !['raw_http_body', 'parsed_json_data'].includes(record.initCheckpoint.responseDigestKind)
    || record.initCheckpoint.ownerScopeSha256 !== record.ownerScopeSha256
    || record.initCheckpoint.callerIntentSha256 !== record.callerIntentSha256
    || record.initCheckpoint.issuedUploadIdSha256 !== record.issued.uploadIdSha256
    || record.initCheckpoint.issuedAssetIdSha256 !== record.issued.assetIdSha256) {
    failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  }
  assertOnlyKeys(record.abort, ABORT_FIELDS, 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  if (!object(record.abort) || !['not_attempted', 'sending', 'outcome_unknown', 'abort_requested', 'aborted', 'rejected'].includes(record.abort.state)
    || ![0, 1].includes(record.abort.attemptCount)) failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  if (record.abort.state === 'not_attempted') {
    const allowedNotAttemptedKeys = record.abort.preDispatchRecovery
      ? new Set(['state', 'attemptCount', 'intentSha256', 'attemptedAt', 'requestDigest', 'preDispatchRecovery'])
      : new Set(['state', 'attemptCount']);
    if (record.abort.attemptCount !== 0 || Object.keys(record.abort).some(key => !allowedNotAttemptedKeys.has(key))) {
      failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
    }
    if (record.abort.preDispatchRecovery) {
      if (!SHA256.test(record.abort.intentSha256 ?? '') || !validateTime(record.abort.attemptedAt)
        || record.abort.requestDigest !== abortRequestDigest(record.issued.uploadId)
        || record.abort.intentSha256 !== record.abort.preDispatchRecovery.priorIntentSha256
        || record.abort.attemptedAt !== record.abort.preDispatchRecovery.priorAttemptedAt) {
        failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
      }
      validatePreDispatchAbortRecovery(record.abort.preDispatchRecovery, record);
    }
  } else if (record.abort.attemptCount !== 1 || !SHA256.test(record.abort.intentSha256 ?? '')
    || !validateTime(record.abort.attemptedAt) || record.abort.requestDigest !== abortRequestDigest(record.issued.uploadId)
    || (record.abort.completedAt !== undefined && !validateTime(record.abort.completedAt))
    || (record.abort.responseStatus !== undefined && (!Number.isInteger(record.abort.responseStatus)
      || record.abort.responseStatus < 100 || record.abort.responseStatus > 599))
    || (record.abort.responseBytes !== undefined && (!Number.isSafeInteger(record.abort.responseBytes) || record.abort.responseBytes < 0))
    || (record.abort.responseDigest !== undefined && !SHA256.test(record.abort.responseDigest))
    || (record.abort.responseDigestKind !== undefined && !['raw_http_body', 'parsed_json_data'].includes(record.abort.responseDigestKind))
    || (record.abort.reasonCode !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(record.abort.reasonCode))) {
    failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
  } else if (record.abort.preDispatchRecovery) {
    validatePreDispatchAbortRecovery(record.abort.preDispatchRecovery, record);
  }
  return record;
}

function publicView(record, referencePath) {
  return Object.freeze({
    referenceKey: record.referenceKey,
    referencePath,
    state: record.state,
    abortAttemptState: record.abort.state,
    ownerScopeSha256: record.ownerScopeSha256,
    callerIntentId: record.callerIntentId,
    callerIntentSha256: record.callerIntentSha256,
    fileName: record.file.fileName,
    mimeType: record.file.mimeType,
    fileBytes: record.file.byteCount,
    fileSha256: record.file.sha256,
    initCheckpointSha256: record.initCheckpoint.fileSha256,
    abortAttempt: Object.freeze({
      state: record.abort.state,
      attemptCount: record.abort.attemptCount,
      ...(record.abort.attemptedAt ? { attemptedAt: record.abort.attemptedAt } : {}),
      ...(record.abort.completedAt ? { completedAt: record.abort.completedAt } : {}),
      ...(record.abort.responseStatus !== undefined ? { responseStatus: record.abort.responseStatus } : {}),
      ...(record.abort.reasonCode ? { reasonCode: record.abort.reasonCode } : {}),
      ...(record.abort.preDispatchRecovery ? { preDispatchRecovery: Object.freeze({
        kind: record.abort.preDispatchRecovery.kind,
        recoveredAt: record.abort.preDispatchRecovery.recoveredAt,
        reasonCode: record.abort.preDispatchRecovery.stageReasonCode,
        stageHttpStatus: record.abort.preDispatchRecovery.stageHttpStatus,
        businessAbortRowsAbsent: record.abort.preDispatchRecovery.businessAbortRowsAbsent,
      }) } : {}),
    }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export const GROK_UPLOAD_REFERENCE_DEFAULT_ROOT = path.join(homedir(), '.nad-scratch', 'grok-upload-references');
export const GROK_UPLOAD_REFERENCE_DEFAULT_CHECKPOINT_ROOT = path.join(homedir(), '.nad-scratch', 'grok-attachment-stage-audits');

/**
 * Stores only server-issued upload/asset IDs and nonsecret linkage needed to resume status/abort.
 * The default output is opaque; IDs are available only from the explicitly named openForResume call.
 */
export function createGrokUploadReferenceStore({
  rootDirectory = GROK_UPLOAD_REFERENCE_DEFAULT_ROOT,
  checkpointRoot = GROK_UPLOAD_REFERENCE_DEFAULT_CHECKPOINT_ROOT,
  getVerifiedOwnerScopeSha256,
  operationJournal,
  now = () => new Date(),
} = {}) {
  const root = resolveScratchChild(rootDirectory, 'GROK_UPLOAD_REFERENCE_PATH_INVALID');
  const auditRoot = resolveScratchChild(checkpointRoot, 'GROK_UPLOAD_REFERENCE_PATH_INVALID');
  if (typeof getVerifiedOwnerScopeSha256 !== 'function' || typeof now !== 'function') {
    throw fail('GROK_UPLOAD_REFERENCE_STORE_REQUIRED');
  }

  async function currentOwnerScope() {
    let value;
    try { value = await getVerifiedOwnerScopeSha256(); } catch { failWith('OWNER_VERIFICATION_REQUIRED'); }
    return validateScope(value);
  }

  async function checkpointPath(inputPath) {
    if (typeof inputPath !== 'string' || inputPath.includes('\0')) failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_PATH_INVALID');
    const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(auditRoot, inputPath);
    const relative = path.relative(auditRoot, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || relative.includes(path.sep) || !CHECKPOINT_FILE.test(relative)) failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_PATH_INVALID');
    return { absolute, fileName: relative };
  }

  async function readCheckpoint({ inputPath, sha256: expectedSha256, ownerScopeSha256, callerIntentId, uploadId, assetId }) {
    await ensurePrivateDirectory(auditRoot);
    const { absolute, fileName } = await checkpointPath(inputPath);
    const { bytes, data, fileSha256 } = await readPrivateFile(absolute, auditRoot, MAX_CHECKPOINT_BYTES,
      'GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
    if (!SHA256.test(expectedSha256 ?? '') || expectedSha256 !== fileSha256) {
      failWith('GROK_UPLOAD_REFERENCE_CHECKPOINT_DIGEST_MISMATCH');
    }
    const intentSha = hash(Buffer.from(callerIntentId, 'utf8'));
    validateCheckpointDocument(data, { ownerScopeSha256, callerIntentSha256: intentSha, uploadId, assetId });
    return {
      fileName,
      fileSha256,
      checkpoint: data.checkpoint,
      stageKey: data.stageKey,
      sourceOperationId: data.sourceOperationId,
      requestDigest: data.requestDigest,
      transportRequestDigest: data.transportRequestDigest,
      transportIntentDigest: data.transportIntentDigest,
      responseStatus: data.responseStatus,
      responseBytes: data.responseBytes,
      responseDigest: data.responseDigest,
      responseDigestKind: data.responseDigestKind,
      ownerScopeSha256: data.ownerScopeSha256,
      callerIntentSha256: data.callerIntentSha256,
      issuedUploadIdSha256: data.issuedUploadIdSha256,
      issuedAssetIdSha256: data.issuedAssetIdSha256,
    };
  }

  async function readReference(referenceKey) {
    validateReferenceKey(referenceKey);
    await ensurePrivateDirectory(root);
    const filePath = path.join(root, `${referenceKey}.json`);
    const { data } = await readPrivateFile(filePath, root, MAX_RECORD_BYTES, 'GROK_UPLOAD_REFERENCE_NOT_FOUND');
    validateRecord(data, referenceKey);
    const ownerScopeSha256 = await currentOwnerScope();
    if (ownerScopeSha256 !== data.ownerScopeSha256) failWith('GROK_UPLOAD_REFERENCE_OWNER_MISMATCH');
    const checkpoint = await readCheckpoint({
      inputPath: path.join(auditRoot, data.initCheckpoint.fileName),
      sha256: data.initCheckpoint.fileSha256,
      ownerScopeSha256,
      callerIntentId: data.callerIntentId,
      uploadId: data.issued.uploadId,
      assetId: data.issued.assetId,
    });
    if (canonicalJson(checkpoint) !== canonicalJson(data.initCheckpoint)) {
      failWith('GROK_UPLOAD_REFERENCE_PROVENANCE_INVALID');
    }
    return { record: data, referencePath: filePath };
  }

  async function writeReference(record) {
    await ensurePrivateDirectory(root, { create: true });
    validateRecord(record, record.referenceKey);
    const target = path.join(root, `${record.referenceKey}.json`);
    const temporary = path.join(root, `.${record.referenceKey}.${randomUUID()}.partial`);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (bytes.length > MAX_RECORD_BYTES) failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await link(temporary, target);
      await unlink(temporary);
      const dir = await open(root, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if (error?.code === 'EEXIST') failWith('GROK_UPLOAD_REFERENCE_KEY_COLLISION');
      throw error;
    } finally {
      bytes.fill(0);
    }
    return publicView(record, target);
  }

  async function withAbortLock(referenceKey, action) {
    await ensurePrivateDirectory(root);
    const lockPath = path.join(root, `.${referenceKey}.abort.lock`);
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
      const timestamp = now();
      const createdAt = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
      if (!validateTime(createdAt)) failWith('GROK_UPLOAD_REFERENCE_CLOCK_INVALID');
      await lock.writeFile(`${JSON.stringify({ referenceKey, createdAt })}\n`);
      await lock.sync();
    } catch (error) {
      const createdLock = Boolean(lock);
      await lock?.close().catch(() => {});
      if (createdLock) await unlink(lockPath).catch(() => {});
      if (error?.code === 'EEXIST') failWith('GROK_UPLOAD_REFERENCE_ABORT_IN_PROGRESS');
      failWith('GROK_UPLOAD_REFERENCE_ABORT_LOCK_FAILED');
    }
    try {
      return await action();
    } finally {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }

  async function replaceReference(record) {
    validateRecord(record, record.referenceKey);
    const target = path.join(root, `${record.referenceKey}.json`);
    await readPrivateFile(target, root, MAX_RECORD_BYTES, 'GROK_UPLOAD_REFERENCE_NOT_FOUND');
    const temporary = path.join(root, `.${record.referenceKey}.${randomUUID()}.partial`);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (bytes.length > MAX_RECORD_BYTES) failWith('GROK_UPLOAD_REFERENCE_RECORD_INVALID');
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
      const dir = await open(root, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      failWith('GROK_UPLOAD_REFERENCE_WRITE_FAILED');
    } finally {
      bytes.fill(0);
    }
  }

  return Object.freeze({
    async issueFromValidatedInit({
      callerIntentId,
      fileName,
      mimeType,
      fileBytes,
      fileSha256,
      uploadId,
      assetId,
      initialState,
      initCheckpointPath,
      initCheckpointSha256,
    } = {}) {
      const ownerScopeSha256 = await currentOwnerScope();
      validateIntent(callerIntentId);
      if (typeof fileName !== 'string' || !FILE_NAME.test(fileName)
        || typeof mimeType !== 'string' || !MIME.test(mimeType)
        || !Number.isSafeInteger(fileBytes) || fileBytes < 1
        || !SHA256.test(fileSha256 ?? '')
        || !UNRESOLVED_STATES.has(initialState)) failWith('GROK_UPLOAD_REFERENCE_INPUT_INVALID');
      validateId(uploadId, 'GROK_UPLOAD_REFERENCE_ID_INVALID');
      validateId(assetId, 'GROK_UPLOAD_REFERENCE_ID_INVALID');
      const initCheckpoint = await readCheckpoint({
        inputPath: initCheckpointPath,
        sha256: initCheckpointSha256,
        ownerScopeSha256,
        callerIntentId,
        uploadId,
        assetId,
      });
      const timestamp = now();
      const createdAt = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
      if (!validateTime(createdAt)) failWith('GROK_UPLOAD_REFERENCE_CLOCK_INVALID');
      const callerIntentSha256 = hash(Buffer.from(callerIntentId, 'utf8'));
      const referenceKey = randomUUID();
      const record = {
        schemaVersion: 1,
        serviceId: 'grok-web',
        referenceKey,
        createdAt,
        updatedAt: createdAt,
        state: initialState,
        ownerScopeSha256,
        callerIntentId,
        callerIntentSha256,
        file: { fileName, mimeType: mimeType.toLowerCase(), byteCount: fileBytes, sha256: fileSha256 },
        issued: {
          uploadId,
          uploadIdSha256: hash(Buffer.from(uploadId, 'utf8')),
          assetId,
          assetIdSha256: hash(Buffer.from(assetId, 'utf8')),
        },
        initCheckpoint,
        abort: { state: 'not_attempted', attemptCount: 0 },
      };
      return writeReference(record);
    },

    async get(referenceKey) {
      const { record, referencePath } = await readReference(referenceKey);
      return publicView(record, referencePath);
    },

    async openForResume(referenceKey) {
      const { record, referencePath } = await readReference(referenceKey);
      const ticket = Object.freeze({
        reference: publicView(record, referencePath),
        ownerScopeSha256: record.ownerScopeSha256,
        callerIntentId: record.callerIntentId,
        file: Object.freeze({ ...record.file }),
        issued: Object.freeze({ uploadId: record.issued.uploadId, assetId: record.issued.assetId }),
        initCheckpoint: Object.freeze({ ...record.initCheckpoint }),
      });
      validatedResumeTickets.add(ticket);
      return ticket;
    },

    async claimAbort(referenceKey, callerAbortIntentId) {
      validateReferenceKey(referenceKey);
      const abortIntentId = validateIntent(callerAbortIntentId);
      return withAbortLock(referenceKey, async () => {
        const { record, referencePath } = await readReference(referenceKey);
        if (record.abort.state !== 'not_attempted' || record.abort.attemptCount !== 0) {
          failWith('GROK_UPLOAD_REFERENCE_ABORT_ALREADY_ATTEMPTED');
        }
        const timestamp = now();
        const attemptedAt = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
        if (!validateTime(attemptedAt)) failWith('GROK_UPLOAD_REFERENCE_CLOCK_INVALID');
        const updated = {
          ...record,
          updatedAt: attemptedAt,
          abort: {
            state: 'sending',
            attemptCount: 1,
            intentSha256: hash(Buffer.from(abortIntentId, 'utf8')),
            attemptedAt,
            requestDigest: abortRequestDigest(record.issued.uploadId),
            ...(record.abort.preDispatchRecovery ? { preDispatchRecovery: record.abort.preDispatchRecovery } : {}),
          },
        };
        await replaceReference(updated);
        return publicView(updated, referencePath);
      });
    },

    async recoverPreDispatchAbortClaim(referenceKey, priorAbortIntentId) {
      validateReferenceKey(referenceKey);
      const abortIntentId = validateIntent(priorAbortIntentId);
      if (typeof operationJournal?.list !== 'function') failWith('GROK_UPLOAD_REFERENCE_JOURNAL_REQUIRED');
      return withAbortLock(referenceKey, async () => {
        const { record, referencePath } = await readReference(referenceKey);
        const abortIntentSha256 = hash(Buffer.from(abortIntentId, 'utf8'));
        const abortDigest = abortRequestDigest(record.issued.uploadId);
        if (record.abort.preDispatchRecovery || !['sending', 'rejected', 'outcome_unknown'].includes(record.abort.state)
          || record.abort.attemptCount !== 1 || record.abort.intentSha256 !== abortIntentSha256
          || record.abort.requestDigest !== abortDigest || record.abort.responseStatus !== undefined) {
          failWith('GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');
        }

        const expectedStageIntent = abortStageIntentDigest(record.ownerScopeSha256, abortIntentId);
        let entries;
        try { entries = await operationJournal.list(); }
        catch { failWith('GROK_UPLOAD_REFERENCE_JOURNAL_READ_FAILED'); }
        if (!Array.isArray(entries)) failWith('GROK_UPLOAD_REFERENCE_JOURNAL_READ_FAILED');
        const stageMatches = entries.filter(entry => entry?.contractId === 'attachment.upload.stage.abort'
          && entry.requestDigest === abortDigest && entry.intentDigest === expectedStageIntent);
        const businessAbortRows = entries.filter(entry => entry?.contractId === 'attachment.upload.abort'
          && entry.requestDigest === abortDigest);
        if (stageMatches.length !== 1 || businessAbortRows.length !== 0) {
          failWith('GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');
        }
        const stage = stageMatches[0];
        if (stage.state !== 'rejected' || stage.httpStatus !== null
          || stage.reasonCode !== 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED' || stage.attemptCount !== 1) {
          failWith('GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');
        }

        const timestamp = now();
        const recoveredAt = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
        if (!validateTime(recoveredAt)) failWith('GROK_UPLOAD_REFERENCE_CLOCK_INVALID');
        const preDispatchRecovery = {
          kind: 'source_discovery_permit_already_used',
          recoveredAt,
          priorAttemptedAt: record.abort.attemptedAt,
          priorIntentSha256: record.abort.intentSha256,
          priorRequestDigest: record.abort.requestDigest,
          stageOperationIdSha256: hash(Buffer.from(stage.localOperationId, 'utf8')),
          stageRequestDigest: stage.requestDigest,
          stageIntentDigest: stage.intentDigest,
          stageReasonCode: stage.reasonCode,
          stageHttpStatus: stage.httpStatus,
          businessAbortRowsAbsent: true,
        };
        const updated = {
          ...record,
          updatedAt: recoveredAt,
          abort: {
            state: 'not_attempted',
            attemptCount: 0,
            intentSha256: record.abort.intentSha256,
            attemptedAt: record.abort.attemptedAt,
            requestDigest: record.abort.requestDigest,
            preDispatchRecovery,
          },
        };
        await replaceReference(updated);
        return publicView(updated, referencePath);
      });
    },

    async finishAbort(referenceKey, outcome = {}) {
      validateReferenceKey(referenceKey);
      const allowed = new Set(['state', 'httpStatus', 'responseBytes', 'responseDigest', 'responseDigestKind', 'reasonCode']);
      assertOnlyKeys(outcome, allowed, 'GROK_UPLOAD_REFERENCE_ABORT_OUTCOME_INVALID');
      if (!['aborted', 'abort_requested', 'outcome_unknown', 'rejected'].includes(outcome.state)
        || (outcome.httpStatus !== undefined && (!Number.isInteger(outcome.httpStatus)
          || outcome.httpStatus < 100 || outcome.httpStatus > 599))
        || (outcome.responseBytes !== undefined && (!Number.isSafeInteger(outcome.responseBytes) || outcome.responseBytes < 0))
        || (outcome.responseDigest !== undefined && !SHA256.test(outcome.responseDigest))
        || (outcome.responseDigestKind !== undefined && !['raw_http_body', 'parsed_json_data'].includes(outcome.responseDigestKind))
        || (outcome.reasonCode !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(outcome.reasonCode))) {
        failWith('GROK_UPLOAD_REFERENCE_ABORT_OUTCOME_INVALID');
      }
      return withAbortLock(referenceKey, async () => {
        const { record, referencePath } = await readReference(referenceKey);
        if (record.abort.state !== 'sending' || record.abort.attemptCount !== 1) {
          failWith('GROK_UPLOAD_REFERENCE_ABORT_NOT_CLAIMED');
        }
        const timestamp = now();
        const completedAt = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
        if (!validateTime(completedAt)) failWith('GROK_UPLOAD_REFERENCE_CLOCK_INVALID');
        const updated = {
          ...record,
          updatedAt: completedAt,
          abort: {
            ...record.abort,
            state: outcome.state,
            completedAt,
            ...(outcome.httpStatus !== undefined ? { responseStatus: outcome.httpStatus } : {}),
            ...(outcome.responseBytes !== undefined ? { responseBytes: outcome.responseBytes } : {}),
            ...(outcome.responseDigest !== undefined ? { responseDigest: outcome.responseDigest } : {}),
            ...(outcome.responseDigestKind !== undefined ? { responseDigestKind: outcome.responseDigestKind } : {}),
            ...(outcome.reasonCode !== undefined ? { reasonCode: outcome.reasonCode } : {}),
          },
        };
        await replaceReference(updated);
        return publicView(updated, referencePath);
      });
    },
  });
}
