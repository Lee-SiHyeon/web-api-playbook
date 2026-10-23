import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationJournal } from '../src/journal.mjs';
import { createGrokUploadReferenceStore } from '../src/grok-upload-reference-store.mjs';

const OWNER_A = 'a'.repeat(64);
const OWNER_B = 'b'.repeat(64);
const INTENT = 'large-file-upload-intent-1';
const UPLOAD_ID = 'upload-issued-by-init-42';
const ASSET_ID = 'asset-issued-by-init-84';
const FILE_SHA = 'c'.repeat(64);

class MemoryStore {
  value = null;
  #pending = Promise.resolve();
  async read() { return structuredClone(this.value); }
  transact(callback) {
    const pending = this.#pending.then(async () => {
      const result = await callback(structuredClone(this.value));
      this.value = structuredClone(result.value);
      return result.result;
    });
    this.#pending = pending.catch(() => {});
    return pending;
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function abortRequestDigest() {
  return sha(JSON.stringify({ operationId: 'attachment.upload.abort', abortInput: { uploadId: UPLOAD_ID } }));
}

async function setupPreDispatchAbort(t, { ownerScopeSha256 = OWNER_A, stageState = 'rejected',
  stageHttpStatus = null, stageReasonCode = 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED', businessState = null,
  stageRequestDigestOverride = null } = {}) {
  const operationJournal = new OperationJournal({ store: new MemoryStore() });
  const f = await fixture(t, { ownerScopeSha256, operationJournal });
  const issued = await f.store.issueFromValidatedInit(issueInput(f));
  const abortIntentId = 'upload-abort-discovery-intent';
  const digest = abortRequestDigest();
  const stageDigest = stageRequestDigestOverride ?? digest;
  const stageIntent = sha(`attachment.upload.stage.abort\n${ownerScopeSha256}\n${abortIntentId}\n0`);
  const stage = await operationJournal.begin({ contractId: 'attachment.upload.stage.abort',
    requestDigest: stageDigest, intentDigest: stageIntent });
  if (stageState !== 'sending') {
    await operationJournal.transition(stage.localOperationId, stageState, {
      httpStatus: stageHttpStatus,
      reasonCode: stageReasonCode,
    });
  }
  if (businessState) {
    const businessIntent = sha(`attachment.upload.abort\n${ownerScopeSha256}\n${abortIntentId}/abort`);
    const business = await operationJournal.begin({ contractId: 'attachment.upload.abort',
      requestDigest: digest, intentDigest: businessIntent });
    if (businessState !== 'sending') {
      await operationJournal.transition(business.localOperationId, businessState, {
        httpStatus: businessState === 'accepted' ? 200 : null,
        reasonCode: businessState === 'outcome_unknown' ? 'HTTP_TRANSPORT_FAILED' : null,
      });
    }
  }
  await f.store.claimAbort(issued.referenceKey, abortIntentId);
  return { ...f, operationJournal, issued, abortIntentId, digest };
}

async function fixture(t, { ownerScopeSha256 = OWNER_A, operationJournal } = {}) {
  const base = path.join(homedir(), '.nad-scratch', 'tmp', `upload-reference-test-${randomUUID()}`);
  const rootDirectory = path.join(base, 'grok-upload-references');
  const checkpointRoot = path.join(base, 'grok-attachment-stage-audits');
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  await mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  await chmod(rootDirectory, 0o700);
  await chmod(checkpointRoot, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));

  const stageKey = 'd'.repeat(64);
  const fileName = `${sha(stageKey)}-init_resource_issued-${randomUUID()}.json`;
  const checkpointPath = path.join(checkpointRoot, fileName);
  const checkpoint = {
    checkpoint: 'init_resource_issued',
    stage: 'init',
    ordinal: 0,
    state: 'completed',
    journalState: 'completed',
    journalStateWriteFailed: false,
    sourceOperationId: 'attachment.upload.init',
    stageKey,
    requestDigest: '1'.repeat(64),
    transportRequestDigest: '2'.repeat(64),
    transportIntentDigest: '3'.repeat(64),
    attemptCount: 1,
    ownerScopeSha256,
    callerIntentSha256: sha(INTENT),
    issuedUploadIdSha256: sha(UPLOAD_ID),
    issuedAssetIdSha256: sha(ASSET_ID),
    httpStatus: 200,
    responseStatus: 200,
    responseBytes: 224,
    responseDigest: '4'.repeat(64),
    responseDigestKind: 'raw_http_body',
    responseContentType: 'application/json',
    responseBodyTruncated: false,
  };
  const checkpointBytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`, 'utf8');
  await writeFile(checkpointPath, checkpointBytes, { mode: 0o600, flag: 'wx' });
  await chmod(checkpointPath, 0o600);
  const store = createGrokUploadReferenceStore({
    rootDirectory,
    checkpointRoot,
    getVerifiedOwnerScopeSha256: async () => ownerScopeSha256,
    operationJournal,
  });
  return { base, rootDirectory, checkpointRoot, checkpointPath, checkpoint, checkpointBytes,
    checkpointSha256: sha(checkpointBytes), store };
}

function issueInput(f, overrides = {}) {
  return {
    callerIntentId: INTENT,
    fileName: 'neutral-test.dat',
    mimeType: 'application/octet-stream',
    fileBytes: 1200,
    fileSha256: FILE_SHA,
    uploadId: UPLOAD_ID,
    assetId: ASSET_ID,
    initialState: 'processing',
    initCheckpointPath: f.checkpointPath,
    initCheckpointSha256: f.checkpointSha256,
    ...overrides,
  };
}

test('writes an owner-only opaque reference and reopens only its exact server-issued IDs for resume', async t => {
  const f = await fixture(t);
  const view = await f.store.issueFromValidatedInit(issueInput(f));
  assert.equal(view.state, 'processing');
  assert.match(view.referenceKey, /^[0-9a-f-]{36}$/i);
  assert.equal(path.dirname(view.referencePath), f.rootDirectory);
  assert.equal(Object.hasOwn(view, 'uploadId'), false);
  assert.equal(Object.hasOwn(view, 'assetId'), false);
  assert.equal(JSON.stringify(view).includes(UPLOAD_ID), false);
  assert.equal(JSON.stringify(view).includes(ASSET_ID), false);

  const directoryInfo = await lstat(f.rootDirectory);
  const fileInfo = await lstat(view.referencePath);
  assert.equal(directoryInfo.mode & 0o777, 0o700);
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.equal(fileInfo.nlink, 1);

  const stored = JSON.parse(await readFile(view.referencePath, 'utf8'));
  assert.equal(stored.ownerScopeSha256, OWNER_A);
  assert.equal(stored.callerIntentId, INTENT);
  assert.equal(stored.issued.uploadIdSha256, sha(UPLOAD_ID));
  assert.equal(stored.issued.assetIdSha256, sha(ASSET_ID));
  assert.equal(stored.initCheckpoint.fileSha256, f.checkpointSha256);
  assert.equal(JSON.stringify(stored).includes('cookieValue'), false);
  assert.equal(JSON.stringify(stored).includes('signedUrl'), false);

  const safeRead = await f.store.get(view.referenceKey);
  assert.equal(safeRead.referenceKey, view.referenceKey);
  assert.equal(JSON.stringify(safeRead).includes(UPLOAD_ID), false);
  assert.equal(JSON.stringify(safeRead).includes(ASSET_ID), false);

  const business = await f.store.openForResume(view.referenceKey);
  assert.equal(business.issued.uploadId, UPLOAD_ID);
  assert.equal(business.issued.assetId, ASSET_ID);
  assert.equal(business.ownerScopeSha256, OWNER_A);
  assert.equal(business.initCheckpoint.fileSha256, f.checkpointSha256);
});

test('supports response-observed recovery only when the server response and journal failure are explicit', async t => {
  const f = await fixture(t);
  const checkpoint = {
    ...f.checkpoint,
    state: 'response_observed',
    journalState: 'sending',
    journalStateWriteFailed: true,
    journalFailureCode: 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED',
    checkpointFailure: false,
    reasonCode: 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED',
  };
  const bytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`, 'utf8');
  await writeFile(f.checkpointPath, bytes, { mode: 0o600 });
  const view = await f.store.issueFromValidatedInit(issueInput(f, { initialState: 'response_observed',
    initCheckpointSha256: sha(bytes) }));
  assert.equal((await f.store.openForResume(view.referenceKey)).issued.uploadId, UPLOAD_ID);

  const unknown = { ...checkpoint, state: 'outcome_unknown' };
  await writeFile(f.checkpointPath, `${JSON.stringify(unknown)}\n`, { mode: 0o600 });
  await assert.rejects(f.store.issueFromValidatedInit(issueInput(f, { initialState: 'outcome_unknown',
    initCheckpointSha256: sha(Buffer.from(`${JSON.stringify(unknown)}\n`, 'utf8')) })),
  error => error.code === 'GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
});

test('binds references to current owner, intent, and field-specific issued-ID hashes', async t => {
  const f = await fixture(t);
  const view = await f.store.issueFromValidatedInit(issueInput(f));
  const wrongOwnerStore = createGrokUploadReferenceStore({
    rootDirectory: f.rootDirectory,
    checkpointRoot: f.checkpointRoot,
    getVerifiedOwnerScopeSha256: async () => OWNER_B,
  });
  await assert.rejects(wrongOwnerStore.get(view.referenceKey), error => error.code === 'GROK_UPLOAD_REFERENCE_OWNER_MISMATCH');
  await assert.rejects(f.store.get('../escape'), error => error.code === 'GROK_UPLOAD_REFERENCE_KEY_INVALID');
  await assert.rejects(f.store.issueFromValidatedInit(issueInput(f, { callerIntentId: 'different-intent' })),
    error => error.code === 'GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
  await assert.rejects(f.store.issueFromValidatedInit(issueInput(f, { uploadId: 'not-the-issued-id' })),
    error => error.code === 'GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');
  await assert.rejects(f.store.issueFromValidatedInit(issueInput(f, { initCheckpointPath: '../outside.json' })),
    error => error.code === 'GROK_UPLOAD_REFERENCE_CHECKPOINT_PATH_INVALID');
});

test('rejects symlinked reference roots, checkpoint files, and tampered persisted IDs', async t => {
  const f = await fixture(t);
  const view = await f.store.issueFromValidatedInit(issueInput(f));

  const linkedCheckpoint = path.join(f.checkpointRoot, `${'e'.repeat(64)}-init_resource_issued-${randomUUID()}.json`);
  await symlink(f.checkpointPath, linkedCheckpoint);
  await assert.rejects(f.store.issueFromValidatedInit(issueInput(f, { initCheckpointPath: linkedCheckpoint })),
    error => error.code === 'GROK_UPLOAD_REFERENCE_CHECKPOINT_INVALID');

  const realRoot = path.join(f.base, 'real-reference-dir');
  const linkRoot = path.join(f.base, 'symlink-reference-dir');
  await mkdir(realRoot, { mode: 0o700 });
  await symlink(realRoot, linkRoot);
  const symlinkStore = createGrokUploadReferenceStore({ rootDirectory: linkRoot, checkpointRoot: f.checkpointRoot,
    getVerifiedOwnerScopeSha256: async () => OWNER_A });
  await assert.rejects(symlinkStore.issueFromValidatedInit(issueInput(f)),
    error => error.code === 'GROK_UPLOAD_REFERENCE_PATH_INVALID');

  const stored = JSON.parse(await readFile(view.referencePath, 'utf8'));
  stored.issued.uploadId = 'tampered-upload-id';
  await writeFile(view.referencePath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  await chmod(view.referencePath, 0o600);
  await assert.rejects(f.store.openForResume(view.referenceKey),
    error => error.code === 'GROK_UPLOAD_REFERENCE_RECORD_INVALID');
});

test('rejects incomplete, retryable, or non-JSON init checkpoints', async t => {
  const f = await fixture(t);
  for (const patch of [
    { responseStatus: 500 },
    { responseDigestKind: 'raw_http_body_prefix' },
    { responseContentType: 'text/plain' },
    { responseBodyTruncated: true },
    { attemptCount: 2 },
    { issuedAssetIdSha256: 'f'.repeat(64) },
    { signedUrl: 'https://storage.invalid/signed?token=x' },
  ]) {
    const checkpoint = { ...f.checkpoint, ...patch };
    const bytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`, 'utf8');
    await writeFile(f.checkpointPath, bytes, { mode: 0o600 });
    await assert.rejects(f.store.issueFromValidatedInit(issueInput(f, { initCheckpointSha256: sha(bytes) })));
  }
});

test('durably claims the single abort before dispatch and keeps that claim across store instances', async t => {
  const f = await fixture(t);
  const issued = await f.store.issueFromValidatedInit(issueInput(f));
  const [first, second] = await Promise.allSettled([
    f.store.claimAbort(issued.referenceKey, 'abort-intent-first'),
    createGrokUploadReferenceStore({ rootDirectory: f.rootDirectory, checkpointRoot: f.checkpointRoot,
      getVerifiedOwnerScopeSha256: async () => OWNER_A }).claimAbort(issued.referenceKey, 'abort-intent-second'),
  ]);
  assert.equal([first, second].filter(result => result.status === 'fulfilled').length, 1);
  const claimed = first.status === 'fulfilled' ? first.value : second.value;
  assert.equal(claimed.abortAttempt.state, 'sending');
  assert.equal(claimed.abortAttempt.attemptCount, 1);
  const otherStore = createGrokUploadReferenceStore({ rootDirectory: f.rootDirectory, checkpointRoot: f.checkpointRoot,
    getVerifiedOwnerScopeSha256: async () => OWNER_A });
  await assert.rejects(otherStore.claimAbort(issued.referenceKey, 'abort-intent-third'),
    error => error.code === 'GROK_UPLOAD_REFERENCE_ABORT_ALREADY_ATTEMPTED'
      || error.code === 'GROK_UPLOAD_REFERENCE_ABORT_IN_PROGRESS');
  const finished = await otherStore.finishAbort(issued.referenceKey, {
    state: 'aborted', httpStatus: 200, responseBytes: 2, responseDigest: '5'.repeat(64),
    responseDigestKind: 'raw_http_body',
  });
  assert.equal(finished.abortAttempt.state, 'aborted');
  assert.equal(finished.abortAttempt.attemptCount, 1);
  await assert.rejects(otherStore.claimAbort(issued.referenceKey, 'abort-intent-fourth'),
    error => error.code === 'GROK_UPLOAD_REFERENCE_ABORT_ALREADY_ATTEMPTED');
});

test('recovers one abort claim only from its exact rejected no-wire stage row and preserves history', async t => {
  const f = await setupPreDispatchAbort(t);
  const recovered = await f.store.recoverPreDispatchAbortClaim(f.issued.referenceKey, f.abortIntentId);
  assert.equal(recovered.abortAttempt.state, 'not_attempted');
  assert.equal(recovered.abortAttempt.attemptCount, 0);
  assert.deepEqual(recovered.abortAttempt.preDispatchRecovery, {
    kind: 'source_discovery_permit_already_used',
    recoveredAt: recovered.updatedAt,
    reasonCode: 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED',
    stageHttpStatus: null,
    businessAbortRowsAbsent: true,
  });
  assert.equal(JSON.stringify(recovered).includes(UPLOAD_ID), false);

  const retry = await f.store.claimAbort(f.issued.referenceKey, 'upload-abort-final-intent');
  assert.equal(retry.abortAttempt.state, 'sending');
  assert.equal(retry.abortAttempt.attemptCount, 1);
  assert.equal(retry.abortAttempt.preDispatchRecovery.reasonCode, 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED');
  const finished = await f.store.finishAbort(f.issued.referenceKey, {
    state: 'aborted', httpStatus: 200, responseBytes: 2, responseDigest: '5'.repeat(64),
    responseDigestKind: 'raw_http_body',
  });
  assert.equal(finished.abortAttempt.state, 'aborted');
  assert.equal(finished.abortAttempt.preDispatchRecovery.businessAbortRowsAbsent, true);
  const entries = await f.operationJournal.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].contractId, 'attachment.upload.stage.abort');
  assert.equal(entries[0].state, 'rejected');
  assert.equal(entries[0].reasonCode, 'SOURCE_DISCOVERY_PERMIT_ALREADY_USED');
});

test('no-wire abort recovery rejects wrong owner, caller intent, request digest, or error cause', async t => {
  const wrongOwner = await setupPreDispatchAbort(t);
  const otherOwnerStore = createGrokUploadReferenceStore({
    rootDirectory: wrongOwner.rootDirectory,
    checkpointRoot: wrongOwner.checkpointRoot,
    getVerifiedOwnerScopeSha256: async () => OWNER_B,
    operationJournal: wrongOwner.operationJournal,
  });
  await assert.rejects(otherOwnerStore.recoverPreDispatchAbortClaim(wrongOwner.issued.referenceKey, wrongOwner.abortIntentId),
    error => error.code === 'GROK_UPLOAD_REFERENCE_OWNER_MISMATCH');
  await assert.rejects(wrongOwner.store.recoverPreDispatchAbortClaim(wrongOwner.issued.referenceKey, 'different-abort-intent'),
    error => error.code === 'GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');

  const wrongReason = await setupPreDispatchAbort(t, { stageReasonCode: 'HTTP_TRANSPORT_FAILED' });
  await assert.rejects(wrongReason.store.recoverPreDispatchAbortClaim(wrongReason.issued.referenceKey, wrongReason.abortIntentId),
    error => error.code === 'GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');

  const wrongDigest = await setupPreDispatchAbort(t, { stageRequestDigestOverride: 'f'.repeat(64) });
  await assert.rejects(wrongDigest.store.recoverPreDispatchAbortClaim(wrongDigest.issued.referenceKey, wrongDigest.abortIntentId),
    error => error.code === 'GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');
});

test('no-wire abort recovery rejects accepted, sending, and unknown stage journal rows', async t => {
  for (const stageState of ['accepted', 'sending', 'outcome_unknown']) {
    const f = await setupPreDispatchAbort(t, { stageState,
      stageHttpStatus: stageState === 'accepted' ? 200 : null,
      stageReasonCode: stageState === 'outcome_unknown' ? 'HTTP_TRANSPORT_FAILED' : null });
    await assert.rejects(f.store.recoverPreDispatchAbortClaim(f.issued.referenceKey, f.abortIntentId),
      error => error.code === 'GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');
  }
});

test('no-wire abort recovery rejects any matching submitted business abort row', async t => {
  for (const businessState of ['accepted', 'sending', 'outcome_unknown']) {
    const f = await setupPreDispatchAbort(t, { businessState });
    await assert.rejects(f.store.recoverPreDispatchAbortClaim(f.issued.referenceKey, f.abortIntentId),
      error => error.code === 'GROK_UPLOAD_REFERENCE_ABORT_RECOVERY_NOT_ALLOWED');
  }
});
