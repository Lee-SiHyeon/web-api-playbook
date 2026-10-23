import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { OperationJournal } from '../src/journal.mjs';
import { createGrokAttachmentPresignedUploadClient, GROK_ATTACHMENT_PRESIGNED_SOURCE_CAPABILITIES }
  from '../src/grok-attachment-presigned-upload.mjs';
import { executeGrokSignedStoragePut } from '../src/grok-attachment-presigned-upload.mjs';
import { createGrokUploadReferenceStore } from '../src/grok-upload-reference-store.mjs';

const OWNER_DIGEST = 'a'.repeat(64);
const SIGNED_QUERY = 'signature=private-signed-value';
const TASK_BYTES = Buffer.from('abcdefghij', 'utf8');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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

function metadata({ fileName = 'large-neutral.bin', sizeBytes = 10 } = {}) {
  return {
    fileMetadataId: 'private-file-metadata-id',
    fileName,
    fileMimeType: 'application/octet-stream',
    fileUri: 'users/private-owner/attachments/private-asset-key',
    sizeBytes,
  };
}

function initResponse({ method = 'UPLOAD_METHOD_SINGLE_PUT', fileName = 'large-neutral.bin', size = 10 } = {}) {
  const base = {
    uploadId: 'private-upload-id',
    assetId: 'private-asset-id',
    uploadMethod: method,
  };
  if (method === 'UPLOAD_METHOD_SINGLE_PUT') {
    return { ...base, singlePut: {
      url: `https://upload.example.test/object?${SIGNED_QUERY}`,
      requiredHeaders: { 'content-type': 'application/octet-stream', 'x-storage-mode': 'private' },
    } };
  }
  if (method === 'UPLOAD_METHOD_MULTIPART') {
    const partSize = 4;
    const count = Math.ceil(size / partSize);
    return { ...base, multipart: {
      partSize,
      parts: Array.from({ length: count }, (_, index) => ({
        partNumber: index + 1,
        url: `https://upload.example.test/part-${index + 1}?${SIGNED_QUERY}`,
      })),
    } };
  }
  return base;
}

function fakeRuntime({ init, complete, statuses = [], fileMetadataResponse,
  abortResponse = { abortedNow: true, finalStatus: 'ABORTED' } } = {}) {
  const calls = [];
  const privateResponses = new Map();
  const statusQueue = [...statuses];
  const stageReceiptStore = new Map();
  let currentOwnerDigest = OWNER_DIGEST;
  let nextLocalId = 1;
  const client = {
    async status() { return { session: { ownerVerified: true } }; },
    async submit(operationId, input, options) {
      calls.push({ type: 'submit', operationId, input: structuredClone(input), options });
      const localOperationId = `00000000-0000-4000-8000-${String(nextLocalId++).padStart(12, '0')}`;
      const data = operationId === 'attachment.upload.init' ? init
        : operationId === 'attachment.upload.complete' ? complete
          : operationId === 'attachment.upload.abort' ? abortResponse : null;
      privateResponses.set(localOperationId, structuredClone(data));
      return {
        localOperationId,
        state: 'needs_review',
        httpStatus: 200,
        responseReceipt: { responseBytes: 96, requestDigest: '1'.repeat(64), intentDigest: '2'.repeat(64),
          responseDigest: '3'.repeat(64), responseDigestKind: 'raw_http_body', responseStatus: 200,
          responseContentType: 'application/json', method: 'POST', requestHeaderNames: ['content-type'], cookieNames: ['sso'] },
      };
    },
    async read(operationId, input, options) {
      calls.push({ type: 'read', operationId, input: structuredClone(input), options });
      const data = operationId === 'attachment.file-metadata.read'
        ? fileMetadataResponse ?? { status: 'PROCESSING' }
        : statusQueue.shift() ?? { status: 'PROCESSING' };
      return { status: 200, responseBytes: 64, data };
    },
    async getInMemoryPrivateResponse(localOperationId) { return privateResponses.get(localOperationId) ?? null; },
    async clearInMemoryPrivateResponse(localOperationId) { privateResponses.delete(localOperationId); return { cleared: true }; },
    async clearInMemoryServiceJobId() { return { cleared: true }; },
  };
  const operationJournal = new OperationJournal({ store: new MemoryStore() });
  return {
    calls, client, operationJournal, privateResponses, stageReceiptStore,
    async getVerifiedOwnerScopeSha256() { return currentOwnerDigest; },
    async onStageReceipt(receipt) { stageReceiptStore.set(receipt.stageKey, structuredClone(receipt)); },
    changeOwner(digest) { currentOwnerDigest = digest; },
  };
}

function makeApi(runtime, { signedUrlPolicy, onStageReceipt, onCompleteResponse, getRequestMetadataHeaders,
  putImpl: suppliedPutImpl } = {}) {
  const putCalls = [];
  const defaultPutImpl = async request => {
    const body = Buffer.from(request.body);
    putCalls.push({ ...request, body });
    return { status: 200, headers: new Headers({ etag: '"etag-1"' }) };
  };
  const api = createGrokAttachmentPresignedUploadClient({
    ...runtime,
    putImpl: suppliedPutImpl ?? defaultPutImpl,
    signedUrlPolicy: signedUrlPolicy ?? (async (_url, context) => context.origin === 'https://upload.example.test'),
    onStageReceipt: onStageReceipt
      ? async receipt => { await runtime.onStageReceipt(receipt); await onStageReceipt(receipt); }
      : runtime.onStageReceipt,
    ...(getRequestMetadataHeaders ? { getRequestMetadataHeaders } : {}),
    ...(onCompleteResponse ? { onCompleteResponse } : {}),
  });
  return { api, putCalls };
}

async function configureReferenceFixture(t, runtime, { failResponseObservedOnce = false } = {}) {
  const base = path.join(homedir(), '.nad-scratch', 'tmp', `presigned-reference-integration-${randomUUID()}`);
  const checkpointRoot = path.join(base, 'grok-attachment-stage-audits');
  const referenceRoot = path.join(base, 'grok-upload-references');
  await mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
  await mkdir(referenceRoot, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  await chmod(checkpointRoot, 0o700);
  await chmod(referenceRoot, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));

  let failResponseCheckpoint = failResponseObservedOnce;
  runtime.onStageReceipt = async receipt => {
    runtime.stageReceiptStore.set(receipt.stageKey, structuredClone(receipt));
    if (failResponseCheckpoint && receipt.checkpoint === 'response_observed') {
      failResponseCheckpoint = false;
      throw Object.assign(new Error('injected response checkpoint sink failure'), { code: 'FIXTURE_CHECKPOINT_WRITE_FAILED' });
    }
    const fileName = `${sha256(receipt.stageKey)}-${receipt.checkpoint}-${randomUUID()}.json`;
    const filePath = path.join(checkpointRoot, fileName);
    await writeFile(filePath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return filePath;
  };
  const store = createGrokUploadReferenceStore({ rootDirectory: referenceRoot, checkpointRoot,
    getVerifiedOwnerScopeSha256: async () => OWNER_DIGEST });
  return { store, checkpointRoot };
}

async function persistReferenceFromUpload(api, store, result) {
  const ref = await api.describeUploadReference(result.uploadRef);
  assert.ok(ref.initCheckpointPath);
  const checkpointBytes = await readFile(ref.initCheckpointPath);
  try {
    const reference = await store.issueFromValidatedInit({
      callerIntentId: ref.intentId,
      fileName: ref.fileName,
      mimeType: ref.mimeType,
      fileBytes: ref.fileBytes,
      fileSha256: result.fileSha256,
      uploadId: ref.uploadId,
      assetId: ref.assetId,
      initialState: result.state,
      initCheckpointPath: ref.initCheckpointPath,
      initCheckpointSha256: sha256(checkpointBytes),
    });
    return { reference, ticket: await store.openForResume(reference.referenceKey), checkpoint: JSON.parse(checkpointBytes.toString('utf8')) };
  } finally {
    checkpointBytes.fill(0);
  }
}

function failFirstStageTransition(runtime, contractId, targetState = 'accepted') {
  const journal = runtime.operationJournal;
  const originalTransition = journal.transition.bind(journal);
  let failed = false;
  journal.transition = async (localOperationId, state, options) => {
    const entry = await journal.get(localOperationId);
    if (!failed && entry?.contractId === contractId && state === targetState) {
      failed = true;
      throw Object.assign(new Error('injected journal write failure'), { code: 'INJECTED_JOURNAL_WRITE_FAILURE' });
    }
    return originalTransition(localOperationId, state, options);
  };
  return () => failed;
}

const POLICY = Object.freeze({
  directUploadMaxSizeBytes: 0,
  maxUploadFileSizeBytes: 1024,
  multipartSupported: true,
  multipartConcurrency: 4,
  maxStatusReads: 3,
  statusPollIntervalMs: 0,
});

function uploadInput(overrides = {}) {
  return {
    fileName: 'large-neutral.bin',
    mimeType: 'application/octet-stream',
    bytes: TASK_BYTES,
    fileSource: 'SELF_UPLOAD_FILE_SOURCE',
    ownerIdentityDigest: OWNER_DIGEST,
    intentId: 'presigned-test-intent',
    confirm: true,
    policy: POLICY,
    ...overrides,
  };
}

test('single PUT uses exactly the returned signed URL/headers and keeps private response references non-enumerable', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const stageReceipts = [];
  const { api, putCalls } = makeApi(runtime, { onStageReceipt: receipt => stageReceipts.push(receipt) });
  const result = await api.upload(uploadInput());

  assert.equal(result.state, 'completed', JSON.stringify({ state: result.state, reasonCode: result.reasonCode, diagnostics: result.diagnostics }));
  assert.equal(result.signedPutRequestCount, 1);
  assert.equal(result.fileBytes, TASK_BYTES.length);
  assert.equal(putCalls.length, 1);
  assert.deepEqual(putCalls[0].body, TASK_BYTES);
  assert.equal(putCalls[0].url, `https://upload.example.test/object?${SIGNED_QUERY}`);
  assert.deepEqual(putCalls[0].headers, {
    'content-type': 'application/octet-stream',
    'x-storage-mode': 'private',
  });
  assert.equal(putCalls[0].credentials, 'omit');
  assert.equal(putCalls[0].redirect, 'error');
  assert.equal(Object.keys(putCalls[0].headers).some(name => /cookie|authorization/i.test(name)), false);

  const initCall = runtime.calls.find(call => call.type === 'submit' && call.operationId === 'attachment.upload.init');
  assert.deepEqual(initCall.input, {
    fileName: 'large-neutral.bin',
    fileMimeType: 'application/octet-stream',
    sizeBytes: '10',
    multipartSupported: true,
    fileSource: 'SELF_UPLOAD_FILE_SOURCE',
  });
  assert.equal(initCall.options.retainResponseInMemory, true);
  const completeCall = runtime.calls.find(call => call.type === 'submit' && call.operationId === 'attachment.upload.complete');
  assert.deepEqual(completeCall.input, { presigned: { uploadId: 'private-upload-id', completedParts: [] } });
  assert.equal(runtime.privateResponses.size, 0);
  assert.equal(result.attachmentRef.fileMetadataId, 'private-file-metadata-id');
  assert.equal(Object.keys(result).includes('attachmentRef'), false);
  assert.deepEqual(result.stageAuditPersistence, { state: 'stored', stageCount: 3 });
  assert.equal(stageReceipts.filter(item => item.checkpoint === 'response_observed').length, 3);
  assert.ok(stageReceipts.filter(item => item.checkpoint === 'response_observed' && ['init', 'complete'].includes(item.stage))
    .every(item => item.transportRequestDigest === '1'.repeat(64)));
  assert.ok(stageReceipts.filter(item => item.checkpoint === 'response_observed' && ['init', 'complete'].includes(item.stage))
    .every(item => item.responseDigest === '3'.repeat(64) && item.responseStatus === 200));
  assert.ok([...runtime.stageReceiptStore.values()].every(item => ['journal_state', 'init_resource_issued'].includes(item.checkpoint)));
  const issuance = [...runtime.stageReceiptStore.values()].find(item => item.checkpoint === 'init_resource_issued');
  assert.equal(issuance.sourceOperationId, 'attachment.upload.init');
  assert.equal(issuance.journalState, 'completed');
  assert.equal(issuance.journalStateWriteFailed, false);
  assert.equal(JSON.stringify(stageReceipts).includes(SIGNED_QUERY), false);
  assert.equal(JSON.stringify(stageReceipts).includes('private-upload-id'), false);
  const serialized = JSON.stringify(result);
  for (const secret of [SIGNED_QUERY, 'private-upload-id', 'private-asset-id', 'private-file-metadata-id', 'private-asset-key']) {
    assert.equal(serialized.includes(secret), false);
  }

  const entries = await runtime.operationJournal.list();
  assert.deepEqual(entries.map(entry => entry.contractId).sort(), [
    'attachment.upload.stage.complete',
    'attachment.upload.stage.init',
    'attachment.upload.stage.single-put',
  ]);
  assert.ok(entries.every(entry => entry.state === 'completed' && entry.attemptCount === 1));
  assert.equal(JSON.stringify(entries).includes(SIGNED_QUERY), false);
  assert.equal(JSON.stringify(entries).includes('private-upload-id'), false);
});

test('complete response callback receives the actual parsed direct API reply exactly once', async () => {
  const completeReply = { fileMetadata: metadata(), opaquePrivateField: 'private-completion-value' };
  const runtime = fakeRuntime({ init: initResponse(), complete: completeReply });
  const delivered = [];
  const { api } = makeApi(runtime, { onCompleteResponse: async response => delivered.push(response) });

  const result = await api.upload(uploadInput());

  assert.equal(result.state, 'completed');
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], completeReply);
  assert.equal(runtime.privateResponses.size, 0);
  assert.equal(JSON.stringify(result).includes('private-completion-value'), false);
  assert.equal(JSON.stringify([...runtime.stageReceiptStore.values()]).includes('private-completion-value'), false);
});

test('captured SDK metadata headers are supplied to init only and stay out of receipts and journals', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const capturedValues = { 'x-statsig-id': 'ephemeral-statsig-value', 'x-xai-request-id': 'ephemeral-request-value' };
  const callbackOperations = [];
  const { api } = makeApi(runtime, {
    getRequestMetadataHeaders: async ({ operationId }) => {
      callbackOperations.push(operationId);
      return operationId === 'attachment.upload.init' ? capturedValues : {};
    },
  });

  const result = await api.upload(uploadInput({ intentId: 'metadata-header-stage-scope' }));

  const initCall = runtime.calls.find(call => call.type === 'submit' && call.operationId === 'attachment.upload.init');
  const completeCall = runtime.calls.find(call => call.type === 'submit' && call.operationId === 'attachment.upload.complete');
  assert.deepEqual(callbackOperations, ['attachment.upload.init', 'attachment.upload.complete']);
  assert.deepEqual(initCall.options.requestMetadataHeaders, capturedValues);
  assert.deepEqual(completeCall.options.requestMetadataHeaders, {});
  assert.equal(JSON.stringify(result).includes('ephemeral-'), false);
  assert.equal(JSON.stringify([...runtime.stageReceiptStore.values()]).includes('ephemeral-'), false);
  assert.equal(JSON.stringify(await runtime.operationJournal.list()).includes('ephemeral-'), false);
});

test('single PUT defaults omitted requiredHeaders to the SDK-defined empty record', async () => {
  const init = initResponse();
  delete init.singlePut.requiredHeaders;
  const runtime = fakeRuntime({ init, complete: { fileMetadata: metadata() } });
  const { api, putCalls } = makeApi(runtime);

  const result = await api.upload(uploadInput());

  assert.equal(result.state, 'completed');
  assert.equal(putCalls.length, 1);
  assert.deepEqual(putCalls[0].headers, {});
});

test('single PUT maps matching Content-Length to the transport and rejects mismatches before PUT', async () => {
  const init = initResponse();
  init.singlePut.requiredHeaders = {
    'Content-Length': String(TASK_BYTES.length),
    'Content-Type': 'application/octet-stream',
    'x-amz-meta-upload-id': 'private-server-header-value',
  };
  const runtime = fakeRuntime({ init, complete: { fileMetadata: metadata() } });
  const stageReceipts = [];
  const { api, putCalls } = makeApi(runtime, { onStageReceipt: receipt => stageReceipts.push(receipt) });
  const result = await api.upload(uploadInput());

  assert.equal(result.state, 'completed');
  assert.equal(putCalls.length, 1);
  assert.equal(Object.keys(putCalls[0].headers).some(name => name.toLowerCase() === 'content-length'), false);
  assert.deepEqual(putCalls[0].transportManagedHeaderNames, ['content-length']);
  const putReceipt = stageReceipts.find(item => item.stage === 'singlePut' && item.checkpoint === 'response_observed');
  assert.ok(putReceipt.requestHeaderNames.includes('content-length'));
  assert.equal(JSON.stringify(stageReceipts).includes('private-server-header-value'), false);

  const mismatch = initResponse();
  mismatch.singlePut.requiredHeaders = { 'Content-Length': String(TASK_BYTES.length - 1) };
  const mismatchRuntime = fakeRuntime({ init: mismatch, complete: { fileMetadata: metadata() } });
  const mismatchApi = makeApi(mismatchRuntime);
  const rejected = await mismatchApi.api.upload(uploadInput());
  assert.equal(rejected.state, 'needs_review');
  assert.equal(rejected.reasonCode, 'ATTACHMENT_SIGNED_HEADERS_INVALID');
  assert.equal(rejected.signedPutRequestCount, 0);
  assert.equal(mismatchApi.putCalls.length, 0);
});

test('default signed PUT lets fetch generate matching Content-Length for a byte buffer', async t => {
  const body = Buffer.from('signed-body');
  let observed = null;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const received = Buffer.concat(chunks);
      observed = { contentLength: request.headers['content-length'], byteCount: received.length,
        cookiePresent: Object.hasOwn(request.headers, 'cookie'),
        authorizationPresent: Object.hasOwn(request.headers, 'authorization') };
      response.writeHead(200, { etag: '"local-ack"' });
      response.end('ok');
      received.fill(0);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const result = await executeGrokSignedStoragePut({
    url: `http://127.0.0.1:${address.port}/signed-local-test`,
    body,
    headers: { 'Content-Type': 'application/octet-stream', 'x-amz-meta-upload-id': 'synthetic-local-value' },
    transportManagedHeaderNames: ['content-length'],
    credentials: 'omit', redirect: 'error',
  });
  assert.equal(result.status, 200);
  assert.equal(observed.contentLength, String(body.length));
  assert.equal(observed.byteCount, body.length);
  assert.equal(observed.cookiePresent, false);
  assert.equal(observed.authorizationPresent, false);
  assert.ok(result.transportReceipt.requestHeaderNames.includes('content-length'));
  assert.ok(result.transportReceipt.requestHeaderNames.includes('x-amz-meta-upload-id'));
  body.fill(0);
});

test('direct-size boundary rejects bytes at threshold and accepts the first byte above it up to configured max', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata({ sizeBytes: 9 }) } });
  const { api, putCalls } = makeApi(runtime);
  const policy = { ...POLICY, directUploadMaxSizeBytes: 8, maxUploadFileSizeBytes: 9 };
  await assert.rejects(api.upload(uploadInput({ bytes: Buffer.alloc(8), policy })),
    error => error.code === 'ATTACHMENT_SIZE_REQUIRES_DIRECT_PATH');
  const result = await api.upload(uploadInput({ bytes: Buffer.from('123456789'), policy, intentId: 'size-boundary-intent' }));
  assert.equal(result.state, 'completed');
  assert.equal(result.fileBytes, 9);
  assert.deepEqual(putCalls[0].body, Buffer.from('123456789'));
  await assert.rejects(api.upload(uploadInput({ bytes: Buffer.alloc(10), policy, intentId: 'over-limit-intent' })),
    error => error.code === 'ATTACHMENT_SIZE_LIMIT_EXCEEDED');
  assert.equal(runtime.calls.filter(call => call.type === 'submit' && call.operationId === 'attachment.upload.init').length, 1);
});

test('required multipart precondition stops after server-selected single_put without sending bytes', async () => {
  const runtime = fakeRuntime({ init: initResponse({ method: 'UPLOAD_METHOD_SINGLE_PUT' }),
    complete: { fileMetadata: metadata() } });
  const { api, putCalls } = makeApi(runtime);

  const result = await api.upload(uploadInput({ intentId: 'require-multipart-server-choice', requiredUploadMethod: 'multipart' }));

  assert.equal(result.state, 'needs_review');
  assert.equal(result.reasonCode, 'ATTACHMENT_REQUIRED_UPLOAD_METHOD_NOT_SELECTED');
  assert.equal(result.uploadMethod, 'single_put');
  assert.equal(result.signedPutRequestCount, 0);
  assert.equal(result.completedPartCount, 0);
  assert.equal(putCalls.length, 0);
  assert.equal(runtime.calls.filter(call => call.type === 'submit' && call.operationId === 'attachment.upload.init').length, 1);
  assert.equal(runtime.calls.filter(call => call.type === 'submit' && call.operationId === 'attachment.upload.complete').length, 0);
  const privateRef = await api.describeUploadReference(result.uploadRef);
  assert.equal(privateRef.uploadId, 'private-upload-id');
  assert.equal(privateRef.assetId, 'private-asset-id');
});

test('unsupported required upload-method precondition fails before any server request', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const { api } = makeApi(runtime);
  await assert.rejects(api.upload(uploadInput({ requiredUploadMethod: 'single_put' })),
    error => error.code === 'ATTACHMENT_REQUIRED_UPLOAD_METHOD_INVALID');
  assert.equal(runtime.calls.length, 0);
});

test('multipart splits on server partSize and completes with ETags sorted by part number', async () => {
  const init = initResponse({ method: 'UPLOAD_METHOD_MULTIPART', size: TASK_BYTES.length });
  init.multipart.partSize = String(init.multipart.partSize);
  const runtime = fakeRuntime({
    init,
    complete: { fileMetadata: metadata() },
  });
  const putCalls = [];
  let active = 0;
  let maximumActive = 0;
  const api = createGrokAttachmentPresignedUploadClient({
    ...runtime,
    signedUrlPolicy: async (_url, context) => context.origin === 'https://upload.example.test',
    putImpl: async request => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const body = Buffer.from(request.body);
      const partNumber = Number(new URL(request.url).pathname.split('-').at(-1));
      putCalls.push({ partNumber, body, credentials: request.credentials, redirect: request.redirect, headers: request.headers });
      await new Promise(resolve => setTimeout(resolve, partNumber === 1 ? 8 : 1));
      active -= 1;
      return { status: 200, headers: new Headers({ etag: `"etag-${partNumber}"` }) };
    },
  });
  const result = await api.upload(uploadInput({ requiredUploadMethod: 'multipart' }));

  assert.equal(result.state, 'completed', JSON.stringify({ state: result.state, reasonCode: result.reasonCode, diagnostics: result.diagnostics }));
  assert.equal(result.signedPutRequestCount, 3);
  assert.equal(result.completedPartCount, 3);
  assert.ok(maximumActive <= POLICY.multipartConcurrency);
  assert.deepEqual(putCalls.map(item => [item.partNumber, item.body.toString()]).sort((a, b) => a[0] - b[0]), [
    [1, 'abcd'], [2, 'efgh'], [3, 'ij'],
  ]);
  assert.ok(putCalls.every(item => item.credentials === 'omit' && item.redirect === 'error'));
  assert.ok(putCalls.every(item => Object.keys(item.headers).length === 0));
  const completeCall = runtime.calls.find(call => call.type === 'submit' && call.operationId === 'attachment.upload.complete');
  assert.deepEqual(completeCall.input.presigned.completedParts, [
    { partNumber: 1, etag: '"etag-1"' },
    { partNumber: 2, etag: '"etag-2"' },
    { partNumber: 3, etag: '"etag-3"' },
  ]);
  assert.equal(JSON.stringify(result).includes('etag-1'), false);
});

test('uncertain multipart part is never retried and the same semantic intent is deduplicated', async () => {
  const runtime = fakeRuntime({
    init: initResponse({ method: 'UPLOAD_METHOD_MULTIPART', size: 8 }),
    complete: { fileMetadata: metadata({ sizeBytes: 8 }) },
  });
  let putCount = 0;
  const api = createGrokAttachmentPresignedUploadClient({
    ...runtime,
    signedUrlPolicy: async (_url, context) => context.origin === 'https://upload.example.test',
    putImpl: async request => {
      putCount += 1;
      if (request.url.includes('/part-1?')) throw new Error('private network details');
      return { status: 200, headers: new Headers({ etag: '"etag-2"' }) };
    },
  });
  const first = await api.upload(uploadInput({ bytes: Buffer.from('abcdefgh') }));
  assert.equal(first.state, 'outcome_unknown');
  assert.equal(first.reasonCode, 'ATTACHMENT_MULTIPART_PART_OUTCOME_UNKNOWN');
  assert.equal(runtime.calls.some(call => call.operationId === 'attachment.upload.complete'), false);
  assert.equal(putCount, 2);
  const entries = await runtime.operationJournal.list();
  assert.ok(entries.some(entry => entry.contractId === 'attachment.upload.stage.multipart-part' && entry.state === 'outcome_unknown'));

  const second = await api.upload(uploadInput({ bytes: Buffer.from('abcdefgh') }));
  assert.equal(second.state, 'needs_review');
  assert.equal(second.reasonCode, 'OPERATION_ALREADY_COMPLETED');
  assert.equal(putCount, 2);
  assert.equal(runtime.calls.filter(call => call.operationId === 'attachment.upload.init').length, 1);
  assert.equal(JSON.stringify(first).includes('private network details'), false);
});

test('server-returned URL outside the caller-owned origin policy is rejected before PUT', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const { api, putCalls } = makeApi(runtime, { signedUrlPolicy: async () => false });
  const result = await api.upload(uploadInput());
  assert.equal(result.state, 'needs_review');
  assert.equal(result.reasonCode, 'ATTACHMENT_SIGNED_URL_SCOPE');
  assert.equal(putCalls.length, 0);
  assert.equal(runtime.calls.some(call => call.operationId === 'attachment.upload.complete'), false);
  assert.equal(JSON.stringify(result).includes('upload.example.test'), false);
  assert.equal(JSON.stringify(result).includes(SIGNED_QUERY), false);
});

test('complete processing uses bounded status reads; resumable remains unsupported and abort is explicit once', async () => {
  const runtime = fakeRuntime({
    init: initResponse(),
    complete: { uploadId: 'completed-job-id' },
    statuses: [
      { status: 'PROCESSING' },
      { status: 'SUCCESS', fileMetadata: metadata() },
      { status: 'PROCESSING' },
    ],
  });
  const { api } = makeApi(runtime);
  const result = await api.upload(uploadInput());
  assert.equal(result.state, 'completed');
  assert.equal(result.statusPollCount, 2);
  assert.equal(runtime.calls.filter(call => call.type === 'read' && call.operationId === 'attachment.upload.status').length, 2);

  const resumableRuntime = fakeRuntime({
    init: initResponse({ method: 'UPLOAD_METHOD_RESUMABLE' }),
    complete: null,
    statuses: [{ status: 'PROCESSING' }],
  });
  const { api: resumableApi } = makeApi(resumableRuntime);
  const unsupported = await resumableApi.upload(uploadInput({ intentId: 'resumable-source-candidate' }));
  assert.equal(unsupported.state, 'unsupported');
  assert.equal(unsupported.reasonCode, 'ATTACHMENT_RESUMABLE_NOT_SUPPORTED');
  assert.equal(resumableRuntime.calls.some(call => call.operationId === 'attachment.upload.complete'), false);
  assert.equal(resumableRuntime.calls.some(call => call.operationId === 'attachment.upload.abort'), false);
  const uploadRef = unsupported.uploadRef;
  assert.ok(uploadRef);

  const observed = await resumableApi.status({ uploadRef, intentId: 'resumable-status-read' });
  assert.equal(observed.state, 'processing');
  assert.equal(observed.httpReadCount, 1);
  assert.equal(resumableRuntime.calls.filter(call => call.operationId === 'attachment.upload.status').length, 1);
  const aborted = await resumableApi.abort({ uploadRef, intentId: 'resumable-explicit-abort', confirm: true });
  assert.equal(aborted.state, 'aborted');
  assert.equal(aborted.abortVerified, true);
  assert.equal(aborted.abortRequestCount, 1);
  assert.equal(resumableRuntime.calls.filter(call => call.operationId === 'attachment.upload.abort').length, 1);
  await assert.rejects(resumableApi.abort({ uploadRef, intentId: 'resumable-repeat-abort', confirm: true }),
    error => error.code === 'ATTACHMENT_UPLOAD_ALREADY_TERMINAL');
  assert.equal(resumableRuntime.calls.filter(call => call.operationId === 'attachment.upload.abort').length, 1);
  assert.equal(JSON.stringify(unsupported).includes('private-upload-id'), false);
});

test('status success can resolve metadata through the registered POST read contract', async () => {
  const runtime = fakeRuntime({
    init: initResponse(),
    complete: { uploadId: 'completed-job-id' },
    statuses: [{ status: 'SUCCESS', assetId: 'completed-asset-id' }],
    fileMetadataResponse: metadata(),
  });
  const { api } = makeApi(runtime);
  const result = await api.upload(uploadInput({ intentId: 'metadata-post-readback' }));
  assert.equal(result.state, 'completed');
  const metadataStage = result.diagnostics.find(item => item.stage === 'fileMetadata');
  assert.equal(metadataStage.transportMethod, 'POST');
  assert.equal(metadataStage.responseStatus, 200);
  const read = runtime.calls.find(call => call.type === 'read' && call.operationId === 'attachment.file-metadata.read');
  assert.deepEqual(read.input, { fileMetadataId: 'completed-asset-id' });
});

test('source-returned cookie or authorization headers are refused and never reach signed storage', async () => {
  const unsafeInit = initResponse();
  unsafeInit.singlePut.requiredHeaders = { cookie: 'must-not-forward' };
  const runtime = fakeRuntime({ init: unsafeInit, complete: { fileMetadata: metadata() } });
  const { api, putCalls } = makeApi(runtime);
  const result = await api.upload(uploadInput());
  assert.equal(result.state, 'needs_review');
  assert.equal(result.reasonCode, 'ATTACHMENT_SIGNED_HEADERS_INVALID');
  assert.equal(putCalls.length, 0);
});

test('source candidate boundaries keep PATCH and resumable explicitly unsupported and require actual feature policy', async () => {
  assert.equal(GROK_ATTACHMENT_PRESIGNED_SOURCE_CAPABILITIES.resumable,
    'source-described-but-current-uploader-throws-unsupported');
  assert.equal(GROK_ATTACHMENT_PRESIGNED_SOURCE_CAPABILITIES.patch,
    'generated-sdk-method-exists; current-uploader-has-no-patch-callsite');
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const { api, putCalls } = makeApi(runtime);
  await assert.rejects(api.upload(uploadInput({ policy: undefined })),
    error => error.code === 'ATTACHMENT_UPLOAD_POLICY_REQUIRED');
  assert.equal(runtime.calls.some(call => call.operationId === 'attachment.upload.init'), false);
  assert.equal(putCalls.length, 0);
});

test('unready source contract fails before dispatch and records a preflight rejection, not an unknown write', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  runtime.client.submit = async (operationId, input, options) => {
    runtime.calls.push({ type: 'submit', operationId, input, options });
    throw Object.assign(new Error('preflight only'), { code: 'OPERATION_NOT_READY' });
  };
  const { api, putCalls } = makeApi(runtime);
  const result = await api.upload(uploadInput({ intentId: 'unready-init-preflight' }));
  assert.equal(result.state, 'needs_review');
  assert.equal(result.reasonCode, 'OPERATION_NOT_READY');
  assert.equal(result.diagnostics[0].state, 'rejected');
  assert.equal(putCalls.length, 0);
  assert.equal(runtime.calls.filter(call => call.type === 'submit').length, 1);
  const entries = await runtime.operationJournal.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'rejected');
});

test('submit response is checkpointed before stage journal transition failure and cannot be replayed', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const failed = failFirstStageTransition(runtime, 'attachment.upload.stage.init');
  const { api, putCalls } = makeApi(runtime);
  const result = await api.upload(uploadInput({ intentId: 'submit-transition-failure' }));

  assert.equal(failed(), true);
  assert.equal(result.state, 'response_observed');
  assert.equal(result.reasonCode, 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED');
  assert.equal(result.businessRetryAllowed, false);
  assert.equal(result.diagnostics[0].state, 'response_observed');
  assert.equal(result.diagnostics[0].httpStatus, 200);
  assert.equal(result.diagnostics[0].responseDigest, '3'.repeat(64));
  assert.equal(result.diagnostics[0].journalStateWriteFailed, true);
  assert.equal(putCalls.length, 0);
  assert.equal(runtime.calls.filter(call => call.operationId === 'attachment.upload.init').length, 1);
  const durableStage = [...runtime.stageReceiptStore.values()].find(item => item.stage === 'init');
  assert.equal(durableStage.checkpoint, 'init_resource_issued');
  assert.equal(durableStage.journalStateWriteFailed, true);
  assert.equal(durableStage.responseStatus, 200);
  assert.equal(durableStage.responseDigest, '3'.repeat(64));
  const entries = await runtime.operationJournal.list();
  assert.equal(entries.find(item => item.contractId === 'attachment.upload.stage.init').state, 'sending');

  const repeated = await api.upload(uploadInput({ intentId: 'submit-transition-failure' }));
  assert.equal(repeated.reasonCode, 'OPERATION_ALREADY_HELD');
  assert.equal(runtime.calls.filter(call => call.operationId === 'attachment.upload.init').length, 1);
});

test('outer init journal failure checkpoint can be issued and reopened as an owner-bound reference', async t => {
  const runtime = fakeRuntime({ init: initResponse({ method: 'UPLOAD_METHOD_RESUMABLE' }) });
  failFirstStageTransition(runtime, 'attachment.upload.stage.init');
  const { store } = await configureReferenceFixture(t, runtime);
  const { api, putCalls } = makeApi(runtime);
  const result = await api.upload(uploadInput({ intentId: 'outer-journal-reference-intent' }));

  assert.equal(result.state, 'response_observed');
  assert.equal(putCalls.length, 0);
  const { checkpoint, ticket } = await persistReferenceFromUpload(api, store, result);
  assert.equal(result.initHttpStatus, 200);
  assert.equal(checkpoint.httpStatus, 200);
  assert.equal(checkpoint.responseStatus, 200);
  assert.equal(checkpoint.responseBodyTruncated, false);
  assert.equal(checkpoint.responseContentType, 'application/json');
  assert.equal(checkpoint.journalStateWriteFailed, true);
  assert.equal(checkpoint.journalFailureCode, 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED');
  assert.equal(checkpoint.checkpointFailure, false);
  assert.equal(ticket.issued.uploadId, 'private-upload-id');
  assert.equal(ticket.issued.assetId, 'private-asset-id');
});

test('inner client journal failure is distinct from outer stage and remains resumable', async t => {
  const runtime = fakeRuntime({ init: initResponse({ method: 'UPLOAD_METHOD_RESUMABLE' }) });
  const { store } = await configureReferenceFixture(t, runtime);
  const submit = runtime.client.submit.bind(runtime.client);
  runtime.client.submit = async (operationId, input, options) => {
    const submitted = await submit(operationId, input, options);
    if (operationId !== 'attachment.upload.init') return submitted;
    await options.onResponseCheckpoint({ operationId, localOperationId: submitted.localOperationId,
      requestDigest: submitted.responseReceipt.requestDigest, intentDigest: submitted.responseReceipt.intentDigest,
      responseReceipt: submitted.responseReceipt, serviceJobIdObserved: false });
    return { ...submitted, state: 'response_observed', responseCheckpoint: { state: 'stored' },
      journalPersistence: { state: 'failed', errorCode: 'JOURNAL_TRANSITION_FAILED', businessRetryAllowed: false } };
  };
  const { api, putCalls } = makeApi(runtime);
  const result = await api.upload(uploadInput({ intentId: 'inner-journal-reference-intent' }));

  assert.equal(result.state, 'response_observed');
  assert.equal(putCalls.length, 0);
  const { checkpoint, ticket } = await persistReferenceFromUpload(api, store, result);
  assert.equal(result.initHttpStatus, 200);
  assert.equal(checkpoint.httpStatus, 200);
  assert.equal(checkpoint.responseBodyTruncated, false);
  assert.equal(checkpoint.journalState, 'sending');
  assert.equal(checkpoint.journalStateWriteFailed, true);
  assert.equal(checkpoint.journalFailureCode, 'JOURNAL_TRANSITION_FAILED');
  assert.equal(checkpoint.checkpointFailure, false);
  assert.equal(ticket.issued.uploadId, 'private-upload-id');
  assert.equal(ticket.issued.assetId, 'private-asset-id');
});

test('response checkpoint sink failure records no journal transition and still preserves validated init IDs', async t => {
  const runtime = fakeRuntime({ init: initResponse({ method: 'UPLOAD_METHOD_RESUMABLE' }) });
  const { store } = await configureReferenceFixture(t, runtime, { failResponseObservedOnce: true });
  const submit = runtime.client.submit.bind(runtime.client);
  runtime.client.submit = async (operationId, input, options) => {
    const submitted = await submit(operationId, input, options);
    if (operationId !== 'attachment.upload.init') return submitted;
    try {
      await options.onResponseCheckpoint({ operationId, localOperationId: submitted.localOperationId,
        requestDigest: submitted.responseReceipt.requestDigest, intentDigest: submitted.responseReceipt.intentDigest,
        responseReceipt: submitted.responseReceipt, serviceJobIdObserved: false });
      return { ...submitted, responseCheckpoint: { state: 'stored' } };
    } catch {
      return { ...submitted, state: 'response_observed',
        responseCheckpoint: { state: 'failed', errorCode: 'RESPONSE_CHECKPOINT_FAILED', businessRetryAllowed: false },
        journalPersistence: { state: 'not_attempted', errorCode: 'RESPONSE_CHECKPOINT_FAILED', businessRetryAllowed: false },
        businessRetryAllowed: false };
    }
  };
  const { api, putCalls } = makeApi(runtime);
  const result = await api.upload(uploadInput({ intentId: 'checkpoint-sink-reference-intent' }));

  assert.equal(result.state, 'response_observed');
  assert.equal(putCalls.length, 0);
  const { checkpoint, ticket } = await persistReferenceFromUpload(api, store, result);
  assert.equal(result.initHttpStatus, 200);
  assert.equal(checkpoint.httpStatus, 200);
  assert.equal(checkpoint.responseStatus, 200);
  assert.equal(checkpoint.responseBodyTruncated, false);
  assert.equal(checkpoint.responseContentType, 'application/json');
  assert.equal(checkpoint.journalState, 'sending');
  assert.equal(checkpoint.journalStateWriteFailed, false);
  assert.equal(checkpoint.checkpointFailure, true);
  assert.equal(checkpoint.checkpointFailureCode, 'RESPONSE_CHECKPOINT_FAILED');
  assert.equal(Object.hasOwn(checkpoint, 'journalFailureCode'), false);
  assert.equal(ticket.issued.uploadId, 'private-upload-id');
  assert.equal(ticket.issued.assetId, 'private-asset-id');
});

test('signed PUT response hash/status is durable before a failed state transition and the part is not resent', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const failed = failFirstStageTransition(runtime, 'attachment.upload.stage.single-put');
  let putCount = 0;
  const { api } = makeApi(runtime, { putImpl: async request => {
    putCount += 1;
    return {
      status: 201,
      headers: new Headers({ etag: '"etag-task"' }),
      responseBytes: 5,
      responseDigest: 'b'.repeat(64),
      responseDigestKind: 'raw_http_body',
      transportReceipt: {
        method: 'PUT', responseStatus: 201, responseBytes: 5,
        responseDigest: 'b'.repeat(64), responseDigestKind: 'raw_http_body',
        requestHeaderNames: Object.keys(request.headers),
      },
    };
  } });
  const result = await api.upload(uploadInput({ intentId: 'put-transition-failure' }));

  assert.equal(failed(), true);
  assert.equal(result.state, 'response_observed');
  assert.equal(result.reasonCode, 'ATTACHMENT_JOURNAL_STATE_WRITE_FAILED');
  assert.equal(result.businessRetryAllowed, false);
  const putStage = result.diagnostics.find(item => item.stage === 'singlePut');
  assert.equal(putStage.state, 'response_observed');
  assert.equal(putStage.httpStatus, 201);
  assert.equal(putStage.responseDigest, 'b'.repeat(64));
  assert.equal(putStage.journalStateWriteFailed, true);
  assert.equal(runtime.calls.some(call => call.operationId === 'attachment.upload.complete'), false);
  assert.equal(putCount, 1);
  const durableStage = [...runtime.stageReceiptStore.values()].find(item => item.stage === 'singlePut');
  assert.equal(durableStage.checkpoint, 'journal_state_write_failed');
  assert.equal(durableStage.responseStatus, 201);
  assert.equal(durableStage.responseDigest, 'b'.repeat(64));

  const repeated = await api.upload(uploadInput({ intentId: 'put-transition-failure' }));
  assert.equal(repeated.reasonCode, 'OPERATION_ALREADY_COMPLETED');
  assert.equal(putCount, 1);
});

test('verified owner binding rejects a mismatched upload digest and makes old refs unusable after owner rotation', async () => {
  const preflightRuntime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const { api: preflightApi, putCalls } = makeApi(preflightRuntime);
  await assert.rejects(preflightApi.upload(uploadInput({ ownerIdentityDigest: 'b'.repeat(64) })),
    error => error.code === 'ATTACHMENT_OWNER_SCOPE_CHANGED');
  assert.equal(preflightRuntime.calls.some(call => call.type === 'submit'), false);
  assert.equal(putCalls.length, 0);

  const runtime = fakeRuntime({ init: initResponse({ method: 'UPLOAD_METHOD_RESUMABLE' }), complete: null });
  const { api } = makeApi(runtime);
  const unsupported = await api.upload(uploadInput({ intentId: 'owner-bound-resumable-ref' }));
  const uploadRef = unsupported.uploadRef;
  const readsBeforeSwitch = runtime.calls.filter(call => call.type === 'read').length;
  const abortsBeforeSwitch = runtime.calls.filter(call => call.operationId === 'attachment.upload.abort').length;
  runtime.changeOwner('c'.repeat(64));
  await assert.rejects(api.status({ uploadRef, intentId: 'old-owner-status-read' }),
    error => error.code === 'ATTACHMENT_OWNER_SCOPE_CHANGED');
  await assert.rejects(api.abort({ uploadRef, intentId: 'old-owner-abort', confirm: true }),
    error => error.code === 'ATTACHMENT_OWNER_SCOPE_CHANGED');
  assert.equal(runtime.calls.filter(call => call.type === 'read').length, readsBeforeSwitch);
  assert.equal(runtime.calls.filter(call => call.operationId === 'attachment.upload.abort').length, abortsBeforeSwitch);
});

test('default signed PUT consumes only a bounded acknowledgement prefix and omits credentials and redirects', async () => {
  const runtime = fakeRuntime({ init: initResponse(), complete: { fileMetadata: metadata() } });
  const originalFetch = globalThis.fetch;
  let requestOptions;
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024 + 1).fill(65));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { etag: '"etag-1"' } });
  };
  try {
    const api = createGrokAttachmentPresignedUploadClient({
      client: runtime.client,
      operationJournal: runtime.operationJournal,
      signedUrlPolicy: async (_url, context) => context.origin === 'https://upload.example.test',
      onStageReceipt: runtime.onStageReceipt,
      getVerifiedOwnerScopeSha256: runtime.getVerifiedOwnerScopeSha256,
    });
    const result = await api.upload(uploadInput({ intentId: 'bounded-put-ack' }));
    assert.equal(result.state, 'completed');
    assert.equal(requestOptions.method, 'PUT');
    assert.equal(requestOptions.credentials, 'omit');
    assert.equal(requestOptions.redirect, 'error');
    const putStage = result.diagnostics.find(item => item.stage === 'singlePut');
    assert.equal(putStage.responseBytes, 32 * 1024);
    assert.equal(putStage.responseBodyTruncated, true);
    assert.equal(putStage.responseDigestKind, 'raw_http_body_prefix');
    assert.equal(JSON.stringify(result).includes('AAAA'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
