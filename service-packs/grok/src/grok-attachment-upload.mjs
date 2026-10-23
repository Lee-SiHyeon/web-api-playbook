import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';
import {
  GROK_ATTACHMENT_MULTIPART_BOUNDARY as BOUNDARY,
  MAX_DIRECT_MULTIPART_BODY_BYTES,
  MAX_NATIVE_DIRECT_UPLOAD_BYTES,
  MAX_NATIVE_UPLOAD_FILE_BYTES,
  LEGACY_UNVERIFIED_DIRECT_UPLOAD_BYTES,
} from './grok-attachment-constants.mjs';

export const GROK_ATTACHMENT_UPLOAD_OPERATION_IDS = Object.freeze({
  assetSearch: 'attachment.assets.search',
  direct: 'attachment.upload.direct',
  status: 'attachment.upload.status',
  abort: 'attachment.upload.abort',
  fileMetadata: 'attachment.file-metadata.read',
  assetMetadata: 'attachment.asset.read',
  assetDelete: 'attachment.asset.delete',
});

// Keep the legacy no-policy mode conservative. The native SDK's current
// captured policy is supplied explicitly by the caller and is bounded by the
// source-observed 16 MiB direct threshold / 150 MiB overall maximum.
const UPLOAD_POLL_TIMEOUT_MS = 120_000;
const UPLOAD_POLL_INTERVAL_MS = 300;
const FINAL_UPLOAD_STATES = new Set(['ERROR', 'ABORTED', 'EXPIRED']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, code, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) throw fail(code);
  return value;
}

function validateFileName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw fail('ATTACHMENT_FILE_NAME_INVALID');
  return value;
}

function validateMimeType(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9.+-]{1,80}\/[A-Za-z0-9.+-]{1,80}$/.test(value)) {
    throw fail('ATTACHMENT_MIME_TYPE_INVALID');
  }
  return value.toLowerCase();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function reportAuditOutcome(receipt, onSafeAudit) {
  if (!onSafeAudit) return receipt;
  try {
    await onSafeAudit(receipt);
    receipt.auditPersistence = { state: 'stored' };
  } catch (error) {
    // A failed audit sink must not overwrite the already observed business
    // result or imply that retrying the completed operation is appropriate.
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'ATTACHMENT_AUDIT_WRITE_FAILED';
    receipt.auditPersistence = { state: 'failed', errorCode: code, businessRetryAllowed: false };
  }
  return receipt;
}

function safeReadReceipt(operationId, result, extras = {}) {
  return {
    operationId,
    observedAt: new Date().toISOString(),
    source: 'direct_http',
    status: result.status,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    parsedData: true,
    requestDigest: result.requestDigest,
    responseDigestPersisted: false,
    requestHeaderNames: result.transportEvidence?.requestHeaderNames ?? [],
    cookieNames: result.transportEvidence?.cookieNames ?? [],
    httpVersion: result.transportEvidence?.httpVersion ?? null,
    tlsVerified: result.transportEvidence?.tlsVerified === true,
    trustEnv: result.transportEvidence?.trustEnv === false,
    redirectsFollowed: result.transportEvidence?.redirectsFollowed === false,
    explicitRetries: Number.isInteger(result.transportEvidence?.explicitRetries)
      ? result.transportEvidence.explicitRetries : null,
    attemptCount: 1,
    ownerVerified: true,
    ...extras,
  };
}

function asMetadata(value, { fileName, mimeType, bytes }) {
  if (!object(value) || typeof value.fileMetadataId !== 'string' || value.fileMetadataId.length < 16
    || value.fileName !== fileName || String(value.fileMimeType ?? '').toLowerCase() !== mimeType
    || typeof value.fileUri !== 'string' || !value.fileUri || value.fileUri.length > 16_384
    || /[\r\n\0]/.test(value.fileUri)) throw fail('ATTACHMENT_FILE_METADATA_MISMATCH');
  if (value.fileSource !== undefined && value.fileSource !== null
    && value.fileSource !== 'SELF_UPLOAD_FILE_SOURCE') throw fail('ATTACHMENT_FILE_SOURCE_MISMATCH');
  if (value.sizeBytes !== undefined && Number(value.sizeBytes) !== bytes) throw fail('ATTACHMENT_FILE_SIZE_MISMATCH');
  return value;
}

function assetUrlFromSourceValue(assetServerOrigin, fileUri) {
  let base;
  try { base = new URL(assetServerOrigin); } catch { throw fail('ATTACHMENT_ASSET_ORIGIN_INVALID'); }
  if (base.protocol !== 'https:' || base.origin !== assetServerOrigin || base.origin !== 'https://assets.grok.com'
    || base.username || base.password || base.search || base.hash) throw fail('ATTACHMENT_ASSET_ORIGIN_INVALID');
  let url;
  try {
    if (/^https:\/\//i.test(fileUri)) url = new URL(fileUri);
    else if (/^(?:data:|blob:)/i.test(fileUri)) throw fail('ATTACHMENT_ASSET_URI_UNSUPPORTED');
    else {
      url = new URL(assetServerOrigin);
      url.pathname = fileUri;
    }
  } catch (error) {
    if (error?.code === 'ATTACHMENT_ASSET_URI_UNSUPPORTED') throw error;
    throw fail('ATTACHMENT_ASSET_URI_INVALID');
  }
  if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password || url.hash
    || !url.pathname.startsWith('/users/') || url.pathname.split('/').some(segment => segment === '.' || segment === '..')
    || [...url.searchParams.keys()].some(key => key !== 'cache')
    || (url.searchParams.has('cache') && url.searchParams.get('cache') !== '1')) {
    throw fail('ATTACHMENT_ASSET_URL_SCOPE');
  }
  if (!url.searchParams.has('cache')) url.searchParams.set('cache', '1');
  return url;
}

function multipartBody({ fileName, mimeType, bytes }) {
  const prefix = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8');
  if (bytes.includes(Buffer.from(`--${BOUNDARY}`, 'utf8'))) throw fail('ATTACHMENT_MULTIPART_BOUNDARY_COLLISION');
  const body = Buffer.concat([prefix, bytes, suffix]);
  if (body.length > MAX_DIRECT_MULTIPART_BODY_BYTES) {
    body.fill(0);
    throw fail('ATTACHMENT_REQUEST_SIZE_LIMIT');
  }
  return body;
}

function validatedDirectPolicy(policy) {
  if (policy === undefined) {
    return Object.freeze({
      directUploadMaxSizeBytes: LEGACY_UNVERIFIED_DIRECT_UPLOAD_BYTES,
      maxUploadFileSizeBytes: LEGACY_UNVERIFIED_DIRECT_UPLOAD_BYTES,
      policySupplied: false,
    });
  }
  if (!object(policy) || JSON.stringify(Object.keys(policy).sort())
    !== JSON.stringify(['directUploadMaxSizeBytes', 'maxUploadFileSizeBytes'])
    || !Number.isSafeInteger(policy.directUploadMaxSizeBytes) || policy.directUploadMaxSizeBytes < 1
    || policy.directUploadMaxSizeBytes > MAX_NATIVE_DIRECT_UPLOAD_BYTES
    || !Number.isSafeInteger(policy.maxUploadFileSizeBytes)
    || policy.maxUploadFileSizeBytes < policy.directUploadMaxSizeBytes
    || policy.maxUploadFileSizeBytes > MAX_NATIVE_UPLOAD_FILE_BYTES) {
    throw fail('ATTACHMENT_NATIVE_UPLOAD_POLICY_INVALID');
  }
  return Object.freeze({
    directUploadMaxSizeBytes: policy.directUploadMaxSizeBytes,
    maxUploadFileSizeBytes: policy.maxUploadFileSizeBytes,
    policySupplied: true,
  });
}

async function markCompleted(journal, localOperationId, { httpStatus, reconciledBy, reasonCode }) {
  const entry = await journal.get(localOperationId);
  if (!entry || !['accepted', 'processing', 'outcome_unknown', 'needs_review'].includes(entry.state)) {
    throw fail('ATTACHMENT_JOURNAL_STATE_INVALID');
  }
  await journal.transition(localOperationId, 'completed', {
    httpStatus,
    reasonCode,
    reconciledBy,
  });
}

async function markFailed(journal, localOperationId, { httpStatus = null, reasonCode }) {
  const entry = await journal.get(localOperationId);
  if (!entry || !['sending', 'accepted', 'processing', 'outcome_unknown', 'needs_review'].includes(entry.state)) return;
  await journal.transition(localOperationId, 'failed', { httpStatus, reasonCode, reconciledBy: entry.state === 'needs_review' ? 'attachment.upload.status' : null });
}

async function statOutputTarget(outputRoot, outputName) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)
    || typeof outputName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(outputName)) {
    throw fail('ATTACHMENT_OUTPUT_TARGET_INVALID');
  }
  const root = path.resolve(outputRoot);
  const artifactsRoot = path.resolve(path.join(process.env.HOME ?? '/home/worker', 'artifacts'));
  if (root !== artifactsRoot && !root.startsWith(`${artifactsRoot}${path.sep}`)) throw fail('ATTACHMENT_OUTPUT_SCOPE');
  try { await lstat(path.join(root, outputName)); throw fail('ATTACHMENT_OUTPUT_ALREADY_EXISTS'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return { root, outputName };
}

async function searchExactAssetName(client, fileName, receipts = []) {
  const matches = [];
  const seenTokens = new Set();
  let pageToken;
  for (let page = 0; page < 20; page++) {
    const result = await client.read(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetSearch, {
      query: fileName, pageSize: 20, ...(pageToken ? { pageToken } : {}),
    }, { sourceDiscoveryPermit: 'first-read:attachment.assets.search' });
    if (!object(result.data) || !Array.isArray(result.data.assets)) throw fail('ATTACHMENT_MARKER_SEARCH_INVALID');
    const pageMatches = result.data.assets.filter(asset => object(asset) && asset.name === fileName);
    matches.push(...pageMatches);
    const next = result.data.nextPageToken;
    receipts.push(safeReadReceipt(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetSearch, result, {
      assetResultCount: result.data.assets.length,
      exactNameMatchCount: pageMatches.length,
      nextPagePresent: typeof next === 'string' && Boolean(next),
    }));
    if (typeof next !== 'string' || !next) return matches;
    requiredText(next, 'ATTACHMENT_SEARCH_CURSOR_INVALID', 8192);
    if (seenTokens.has(next)) throw fail('ATTACHMENT_SEARCH_CURSOR_CYCLE');
    seenTokens.add(next);
    pageToken = next;
  }
  throw fail('ATTACHMENT_MARKER_SEARCH_INCOMPLETE');
}

export function createGrokAttachmentUploadClient({ client, journal, assetReader } = {}) {
  if (!client || typeof client.submit !== 'function' || typeof client.read !== 'function'
    || typeof client.getInMemoryPrivateResponse !== 'function' || typeof journal?.get !== 'function'
    || typeof journal?.transition !== 'function' || typeof assetReader !== 'function') {
    throw fail('ATTACHMENT_UPLOAD_RUNTIME_REQUIRED');
  }

  async function abortUpload(uploadId, { intentId, confirm }) {
    const id = requiredText(uploadId, 'ATTACHMENT_UPLOAD_ID_INVALID');
    const result = await client.submit(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.abort, { uploadId: id }, {
      confirm, intentId: `${intentId}/abort`, sourceDiscoveryPermit: 'first-live:attachment.upload.abort',
    });
    return { localOperationId: result.localOperationId, httpStatus: result.httpStatus };
  }

  return Object.freeze({
    async uploadDirect({ fileName, mimeType, bytes: suppliedBytes, policy, assetServerOrigin, assetCookieScope,
      assetSsoCookieValue, assetRequestHeaders, ownerIdentityDigest, outputRoot, outputName, intentId, confirm,
      onSafeAudit, cleanupTaskAsset = false } = {}) {
      if (onSafeAudit !== undefined && typeof onSafeAudit !== 'function') throw fail('ATTACHMENT_AUDIT_CALLBACK_INVALID');
      if (typeof cleanupTaskAsset !== 'boolean') throw fail('ATTACHMENT_CLEANUP_OPTION_INVALID');
      const safeFileName = validateFileName(fileName);
      const safeMimeType = validateMimeType(mimeType);
      if (!Buffer.isBuffer(suppliedBytes) && !(suppliedBytes instanceof Uint8Array)) throw fail('ATTACHMENT_BYTES_INVALID');
      const directPolicy = validatedDirectPolicy(policy);
      const bytes = Buffer.from(suppliedBytes);
      if (bytes.length < 1 || bytes.length > directPolicy.maxUploadFileSizeBytes) {
        bytes.fill(0);
        throw fail('ATTACHMENT_SIZE_EXCEEDS_NATIVE_MAX');
      }
      if (bytes.length > directPolicy.directUploadMaxSizeBytes) {
        bytes.fill(0);
        throw fail('ATTACHMENT_PRESIGNED_ROUTE_REQUIRED');
      }
      if (confirm !== true || typeof intentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intentId)) {
        bytes.fill(0);
        throw fail('ATTACHMENT_UPLOAD_INTENT_REQUIRED');
      }
      if (typeof ownerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ownerIdentityDigest)) {
        bytes.fill(0);
        throw fail('ATTACHMENT_OWNER_BINDING_REQUIRED');
      }
      const outputTarget = await statOutputTarget(outputRoot, outputName);
      const sourceBufferHash = sha256(bytes);
      const formBytes = multipartBody({ fileName: safeFileName, mimeType: safeMimeType, bytes });
      const multipartBodySha256 = sha256(formBytes);
      const directAttempt = { localOperationId: null, httpStatus: null };
      let uploadResponse;
      let uploadId = null;
      let fileMetadata = null;
      let assetId = null;
      let assetReadStatus = null;
      let assetReadVerified = false;
      let downloadReceipt = null;
      let cleanupStatus = null;
      let cleanupVerified = false;
      let abortReceipt = null;
      let uploadState = 'needs_review';
      let directSourceReceipt = null;
      let cleanupSourceReceipt = null;
      const sourceReadReceipts = [];
      const startedAtMs = Date.now();

      try {
        const beforeMatches = await searchExactAssetName(client, safeFileName, sourceReadReceipts);
        if (beforeMatches.length) throw fail('ATTACHMENT_MARKER_ALREADY_EXISTS');

        const directInput = { multipartBodyBase64: formBytes.toString('base64') };
        let submitted;
        try {
          submitted = await client.submit(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.direct, directInput, {
            confirm: true,
            intentId,
            sourceDiscoveryPermit: 'first-live:attachment.upload.direct',
            retainResponseInMemory: true,
          });
        } finally { directInput.multipartBodyBase64 = ''; }
        directAttempt.localOperationId = submitted.localOperationId;
        directAttempt.httpStatus = submitted.httpStatus;
        directSourceReceipt = submitted.responseReceipt ?? submitted.sourceDiscoveryReceipt ?? null;
        uploadResponse = await client.getInMemoryPrivateResponse(submitted.localOperationId);
        if (!object(uploadResponse)) throw fail('ATTACHMENT_UPLOAD_RESPONSE_INVALID');
        if (object(uploadResponse.fileMetadata)) fileMetadata = uploadResponse.fileMetadata;
        if (typeof uploadResponse.uploadId === 'string' && uploadResponse.uploadId.length >= 16) uploadId = uploadResponse.uploadId;
        if (typeof uploadResponse.assetId === 'string' && uploadResponse.assetId.length >= 16) assetId = uploadResponse.assetId;
        if (uploadResponse.terminalError !== undefined && uploadResponse.terminalError !== null) {
          if (uploadId) {
            try { abortReceipt = await abortUpload(uploadId, { intentId, confirm: true }); }
            catch { abortReceipt = null; }
          }
          await markFailed(journal, submitted.localOperationId, {
            httpStatus: submitted.httpStatus, reasonCode: 'ATTACHMENT_SERVER_TERMINAL_ERROR',
          });
          const failureReceipt = {
            operation: GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.direct,
            state: 'failed', ownerVerified: true, browserBusinessWritesDelivered: 0,
            uniqueMarkerAbsentBeforeWrite: true,
            uploadRequestCount: 1, uploadHttpStatus: submitted.httpStatus,
            fileBytes: bytes.length, fileSha256: sourceBufferHash,
            abortAttempted: Boolean(abortReceipt), abortHttpStatus: abortReceipt?.httpStatus ?? null,
            downloadVerified: false, cleanupVerified: false, reasonCode: 'ATTACHMENT_SERVER_TERMINAL_ERROR',
          };
          return await reportAuditOutcome(failureReceipt, onSafeAudit);
        }

        if (!fileMetadata && uploadId) {
          const deadline = Date.now() + UPLOAD_POLL_TIMEOUT_MS;
          while (Date.now() < deadline) {
            const poll = await client.read(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.status, { uploadId }, {
              sourceDiscoveryPermit: 'first-read:attachment.upload.status',
            });
            sourceReadReceipts.push(safeReadReceipt(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.status, poll, {
              responseFieldNames: object(poll.data) ? Object.keys(poll.data).sort() : [],
            }));
            if (!object(poll.data)) throw fail('ATTACHMENT_UPLOAD_STATUS_INVALID');
            const status = String(poll.data.status ?? '').toUpperCase();
            if (status === 'SUCCESS') {
              assetId = typeof poll.data.assetId === 'string' ? poll.data.assetId : assetId;
              if (object(poll.data.fileMetadata)) fileMetadata = poll.data.fileMetadata;
              uploadState = 'uploaded';
              break;
            }
            if (FINAL_UPLOAD_STATES.has(status)) {
              if (status !== 'ABORTED' && status !== 'EXPIRED') {
                try { abortReceipt = await abortUpload(uploadId, { intentId, confirm: true }); }
                catch { abortReceipt = null; }
              }
              uploadState = status.toLowerCase();
              break;
            }
            await new Promise(resolve => setTimeout(resolve, UPLOAD_POLL_INTERVAL_MS));
          }
        }
        if (!fileMetadata && uploadId && uploadState === 'needs_review') {
          try { abortReceipt = await abortUpload(uploadId, { intentId, confirm: true }); }
          catch { abortReceipt = null; }
          uploadState = abortReceipt ? 'aborted_after_timeout' : 'outcome_unknown';
        }
        if (!fileMetadata && assetId && ['needs_review', 'uploaded'].includes(uploadState)) {
          const metadata = await client.read(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.fileMetadata,
            { fileMetadataId: assetId }, { sourceDiscoveryPermit: 'first-read:attachment.file-metadata.read' });
          if (object(metadata.data)) fileMetadata = metadata.data;
        }
        if (!fileMetadata) {
          if (directAttempt.localOperationId && uploadState !== 'outcome_unknown') {
            await markFailed(journal, directAttempt.localOperationId, {
              httpStatus: directAttempt.httpStatus, reasonCode: 'ATTACHMENT_UPLOAD_NOT_COMPLETED',
            });
          }
          const incompleteReceipt = {
            operation: GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.direct,
            state: uploadState, ownerVerified: true, browserBusinessWritesDelivered: 0,
            uniqueMarkerAbsentBeforeWrite: true,
            uploadRequestCount: 1, uploadHttpStatus: directAttempt.httpStatus,
            abortAttempted: Boolean(abortReceipt), abortHttpStatus: abortReceipt?.httpStatus ?? null,
            fileBytes: bytes.length, fileSha256: sourceBufferHash,
            downloadVerified: false, cleanupVerified: false,
            reasonCode: uploadState === 'outcome_unknown' ? 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN' : 'ATTACHMENT_UPLOAD_NOT_COMPLETED',
          };
          return await reportAuditOutcome(incompleteReceipt, onSafeAudit);
        }

        const checkedMetadata = asMetadata(fileMetadata, { fileName: safeFileName, mimeType: safeMimeType, bytes: bytes.length });
        const metadataRead = await client.read(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.fileMetadata,
          { fileMetadataId: checkedMetadata.fileMetadataId }, { sourceDiscoveryPermit: 'first-read:attachment.file-metadata.read' });
        const metadataReadReceipt = safeReadReceipt(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.fileMetadata, metadataRead, {
          responseFieldNames: object(metadataRead.data) ? Object.keys(metadataRead.data).sort() : [],
        });
        if (!object(metadataRead.data) || metadataRead.data.fileMetadataId !== checkedMetadata.fileMetadataId
          || metadataRead.data.fileName !== safeFileName
          || String(metadataRead.data.fileMimeType ?? '').toLowerCase() !== safeMimeType) {
          throw fail('ATTACHMENT_METADATA_READBACK_MISMATCH');
        }
        fileMetadata = asMetadata(metadataRead.data, { fileName: safeFileName, mimeType: safeMimeType, bytes: bytes.length });
        const afterMatches = await searchExactAssetName(client, safeFileName, sourceReadReceipts);
        if (afterMatches.length > 1) throw fail('ATTACHMENT_TASK_ASSET_AMBIGUOUS');
        if (afterMatches.length === 1) {
          const candidate = afterMatches[0];
          const createdAt = Date.parse(candidate.createTime ?? '');
          if (typeof candidate.assetId !== 'string' || candidate.assetId.length < 16
            || String(candidate.mimeType ?? '').toLowerCase() !== safeMimeType
            || Number(candidate.sizeBytes) !== bytes.length || candidate.isDeleted === true
            || !Number.isFinite(createdAt) || createdAt < startedAtMs - 60_000 || createdAt > Date.now() + 30_000
            || (candidate.fileSource !== undefined && candidate.fileSource !== 'SELF_UPLOAD_FILE_SOURCE')) {
            throw fail('ATTACHMENT_TASK_ASSET_MISMATCH');
          }
          assetId = candidate.assetId;
        }
        assetId ??= fileMetadata.fileMetadataId;

        const assetRead = await client.read(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetMetadata, { assetId }, {
          sourceDiscoveryPermit: 'first-read:attachment.asset.read',
        });
        const assetReadReceipt = safeReadReceipt(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetMetadata, assetRead, {
          responseFieldNames: object(assetRead.data) ? Object.keys(assetRead.data).sort() : [],
        });
        assetReadStatus = assetRead.status;
        const asset = assetRead.data;
        const assetName = asset?.name ?? asset?.fileName;
        const assetMime = String(asset?.mimeType ?? asset?.fileMimeType ?? '').toLowerCase();
        const assetBytes = Number(asset?.sizeBytes);
        const assetCreatedAt = Date.parse(asset?.createTime ?? '');
        const createdDuringTask = Number.isFinite(assetCreatedAt)
          && assetCreatedAt >= startedAtMs - 60_000 && assetCreatedAt <= Date.now() + 30_000;
        assetReadVerified = object(asset) && asset.assetId === assetId && assetName === safeFileName
          && assetMime === safeMimeType && assetBytes === bytes.length && asset.isDeleted !== true
          && createdDuringTask
          && (asset.fileSource === undefined || asset.fileSource === 'SELF_UPLOAD_FILE_SOURCE');
        if (!assetReadVerified) throw fail('ATTACHMENT_ASSET_OWNER_READBACK_MISMATCH');

        let assetUrl;
        let assetFailure = null;
        try {
          assetUrl = assetUrlFromSourceValue(assetServerOrigin, fileMetadata.fileUri);
          downloadReceipt = await assetReader({
            assetUrl: assetUrl.href,
            assetOrigin: new URL(assetServerOrigin).origin,
            mimeType: safeMimeType,
            expectedBytes: bytes.length,
            expectedSha256: sourceBufferHash,
            assetCookieScope,
            ssoCookieValue: assetSsoCookieValue,
            headers: assetRequestHeaders,
            ownerIdentityDigest,
            outputRoot: outputTarget.root,
            outputName: outputTarget.outputName,
            maxBytes: bytes.length,
          });
        } catch (error) {
          assetFailure = typeof error?.code === 'string' ? error.code : 'ATTACHMENT_ASSET_DOWNLOAD_FAILED';
        }
        const downloadVerified = downloadReceipt?.verified === true;
        let cleanupLocalOperationId = null;
        if (cleanupTaskAsset) {
        try {
          const deleted = await client.submit(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetDelete, { assetId }, {
            confirm: true,
            intentId: `${intentId}/cleanup`,
            sourceDiscoveryPermit: 'first-live:attachment.asset.delete',
          });
          cleanupLocalOperationId = deleted.localOperationId;
          cleanupStatus = deleted.httpStatus;
          cleanupSourceReceipt = deleted.sourceDiscoveryReceipt ?? null;
        } catch (error) {
          cleanupStatus = Number.isInteger(error?.details?.status) ? error.details.status : null;
          throw error;
        }
        try {
          const afterDelete = await client.read(GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetMetadata, { assetId }, {
            sourceDiscoveryPermit: 'first-read:attachment.asset.read',
          });
          cleanupVerified = afterDelete.data?.assetId === assetId && afterDelete.data?.isDeleted === true;
        } catch (error) {
          cleanupVerified = error?.code === 'HTTP_STATUS_UNEXPECTED' && error?.details?.status === 404;
        }
        if (!cleanupVerified) throw fail('ATTACHMENT_TASK_CLEANUP_UNVERIFIED');
        if (cleanupLocalOperationId) {
          await markCompleted(journal, cleanupLocalOperationId, {
            httpStatus: cleanupStatus, reconciledBy: GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetMetadata,
            reasonCode: 'ATTACHMENT_TASK_CLEANUP_VERIFIED',
          });
        }
        }
        await markCompleted(journal, directAttempt.localOperationId, {
          httpStatus: directAttempt.httpStatus,
          reconciledBy: GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.assetMetadata,
          reasonCode: cleanupTaskAsset
            ? downloadVerified ? 'ATTACHMENT_READBACK_AND_CLEANUP_VERIFIED' : 'ATTACHMENT_CLEANUP_VERIFIED_DOWNLOAD_INCOMPLETE'
            : downloadVerified ? 'ATTACHMENT_METADATA_AND_BYTES_VERIFIED' : 'ATTACHMENT_METADATA_VERIFIED_DOWNLOAD_INCOMPLETE',
        });
        uploadState = downloadVerified ? 'completed' : 'completed_download_incomplete';
        const finalReceipt = {
          operation: GROK_ATTACHMENT_UPLOAD_OPERATION_IDS.direct,
          state: uploadState, ownerVerified: true, browserBusinessWritesDelivered: 0,
          uniqueMarkerAbsentBeforeWrite: true,
          uploadRequestCount: 1, uploadHttpStatus: directAttempt.httpStatus,
          uploadSourceReceipt: directSourceReceipt ? {
            method: directSourceReceipt.method, path: directSourceReceipt.pathTemplate,
            requestDigest: directSourceReceipt.requestDigest, intentDigest: directSourceReceipt.intentDigest,
            responseStatus: directSourceReceipt.responseStatus,
            responseContentType: directSourceReceipt.responseContentType,
            responseBytes: directSourceReceipt.responseBytes,
            responseFieldNames: directSourceReceipt.responseTopLevelFieldNames,
            requestHeaderNames: directSourceReceipt.requestHeaderNames,
            cookieNames: directSourceReceipt.cookieNames,
            tlsVerified: directSourceReceipt.tlsVerified, redirectsFollowed: directSourceReceipt.redirectsFollowed,
            explicitRetries: directSourceReceipt.explicitRetries, attemptCount: directSourceReceipt.attemptCount,
          } : null,
          cleanupSourceReceipt: cleanupSourceReceipt ? {
            method: cleanupSourceReceipt.method, path: cleanupSourceReceipt.pathTemplate,
            requestDigest: cleanupSourceReceipt.requestDigest, intentDigest: cleanupSourceReceipt.intentDigest,
            responseStatus: cleanupSourceReceipt.responseStatus,
            responseContentType: cleanupSourceReceipt.responseContentType,
            responseBytes: cleanupSourceReceipt.responseBytes,
            requestHeaderNames: cleanupSourceReceipt.requestHeaderNames,
            cookieNames: cleanupSourceReceipt.cookieNames,
            tlsVerified: cleanupSourceReceipt.tlsVerified, redirectsFollowed: cleanupSourceReceipt.redirectsFollowed,
            explicitRetries: cleanupSourceReceipt.explicitRetries, attemptCount: cleanupSourceReceipt.attemptCount,
          } : null,
          sourceReadReceipts: [...sourceReadReceipts, metadataReadReceipt, assetReadReceipt],
          exactTaskAssetMatchesAfterWrite: afterMatches.length,
          fileBytes: bytes.length, fileSha256: sourceBufferHash,
          multipartBodyIntegrity: {
            expectedBytes: formBytes.length,
            expectedSha256: multipartBodySha256,
            transportObservedBytes: Number.isSafeInteger(directSourceReceipt?.requestBodyBytes)
              ? directSourceReceipt.requestBodyBytes : null,
            transportObservedSha256: typeof directSourceReceipt?.requestBodySha256 === 'string'
              && /^[a-f0-9]{64}$/.test(directSourceReceipt.requestBodySha256)
              ? directSourceReceipt.requestBodySha256 : null,
            transportMode: directSourceReceipt?.requestBodyMode === 'private_file_stream'
              ? 'private_file_stream' : null,
            tempFileCleanup: ['removed', 'remove_failed'].includes(directSourceReceipt?.privateTempBodyCleanup)
              ? directSourceReceipt.privateTempBodyCleanup : null,
            digestMatched: directSourceReceipt?.requestBodyBytes === formBytes.length
              && directSourceReceipt?.requestBodySha256 === multipartBodySha256,
          },
          directUploadMaxSizeBytes: directPolicy.directUploadMaxSizeBytes,
          maxUploadFileSizeBytes: directPolicy.maxUploadFileSizeBytes,
          nativePolicySupplied: directPolicy.policySupplied,
          metadataReadbackVerified: true, assetReadbackVerified: assetReadVerified,
          download: downloadReceipt ? {
            status: downloadReceipt.status, mimeType: downloadReceipt.mimeType,
            bodyBytes: downloadReceipt.bodyBytes, sha256: downloadReceipt.sha256,
            bytesMatch: downloadReceipt.bytesMatch, artifactPath: downloadReceipt.artifactPath,
            headersSubmittedNames: downloadReceipt.headersSubmittedNames,
            cookieNamesUsed: downloadReceipt.cookieNamesUsed,
          } : { verified: false, reasonCode: assetFailure },
          downloadVerified, cleanupHttpStatus: cleanupStatus, cleanupVerified,
          cleanupRequested: cleanupTaskAsset, retainedForReuse: !cleanupTaskAsset,
          browserRequestCount: 0,
        };
        if (!cleanupTaskAsset) {
          Object.defineProperty(finalReceipt, 'attachmentRef', { enumerable: false,
            value: Object.freeze({ assetId, fileMetadataId: checkedMetadata.fileMetadataId,
              fileName: safeFileName, fileMimeType: safeMimeType, fileUri: checkedMetadata.fileUri,
              sizeBytes: bytes.length }),
          });
        }
        return await reportAuditOutcome(finalReceipt, onSafeAudit);
      } finally {
        formBytes.fill(0);
        bytes.fill(0);
        if (directAttempt.localOperationId) {
          await client.clearInMemoryPrivateResponse(directAttempt.localOperationId).catch(() => {});
          await client.clearInMemoryServiceJobId(directAttempt.localOperationId).catch(() => {});
        }
      }
    },
  });
}
