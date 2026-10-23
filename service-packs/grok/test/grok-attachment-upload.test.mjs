import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { loadContractRegistry } from '../src/client.mjs';
import { ObservedHttpTransport, createRequestDigest } from '../src/transport.mjs';
import { MAX_DIRECT_MULTIPART_BASE64_LENGTH, MAX_DIRECT_MULTIPART_BODY_BYTES } from '../src/grok-attachment-constants.mjs';
import { createGrokAttachmentUploadClient } from '../src/grok-attachment-upload.mjs';

const TASK_NAME = 'codex-grok-upload-test-14b.txt';
const TASK_BYTES = Buffer.from('neutral-file-1', 'utf8');
const TASK_ASSET_ID = 'asset_task_only_20261006_0001';
const TASK_FILE_URI = 'users/task-owner/attachments/asset_task_only_20261006_0001';
const TASK_FILE_METADATA_ID = 'file_task_only_20261006_0001';

async function makeOutputRoot() {
  const root = path.join(homedir(), 'artifacts', `.grok-attachment-test-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

function fakeRuntime({ existingName = false, expectedBytes = TASK_BYTES.length } = {}) {
  const calls = [];
  const privateResponses = new Map([['upload-op', {
    fileMetadata: {
      fileMetadataId: TASK_FILE_METADATA_ID,
      fileName: TASK_NAME,
      fileMimeType: 'text/plain',
      fileUri: TASK_FILE_URI,
      fileSource: 'SELF_UPLOAD_FILE_SOURCE',
      sizeBytes: expectedBytes,
    },
  }]]);
  const states = new Map([
    ['upload-op', { localOperationId: 'upload-op', state: 'needs_review' }],
    ['delete-op', { localOperationId: 'delete-op', state: 'needs_review' }],
  ]);
  let assetReadCount = 0;
  const journal = {
    async get(id) { return states.get(id) ?? null; },
    async transition(id, state, options) {
      const old = states.get(id);
      assert.ok(old);
      states.set(id, { ...old, state, ...options });
      return states.get(id);
    },
  };
  const client = {
    async submit(id, input, options) {
      calls.push({ type: 'submit', id, input: { ...input }, options: { ...options } });
      if (id === 'attachment.upload.direct') {
        const requestBody = Buffer.from(input.multipartBodyBase64, 'base64');
        const requestBodySha256 = createHash('sha256').update(requestBody).digest('hex');
        const responseReceipt = {
          method: 'POST', pathTemplate: '/http/upload-file-v2/direct', requestDigest: '1'.repeat(64),
          intentDigest: '2'.repeat(64), responseStatus: 200, responseContentType: 'application/json',
          responseBytes: 240, responseTopLevelFieldNames: ['fileMetadata'], requestHeaderNames: ['content-length', 'content-type'],
          cookieNames: ['sso'], tlsVerified: true, redirectsFollowed: false, explicitRetries: 0, attemptCount: 1,
          requestBodyBytes: requestBody.length, requestBodySha256, requestBodyMode: 'private_file_stream',
          privateTempBodyCleanup: 'removed',
        };
        requestBody.fill(0);
        return { localOperationId: 'upload-op', state: 'needs_review', httpStatus: 200,
          responseReceipt,
          sourceDiscoveryReceipt: {
            method: 'POST', pathTemplate: '/http/upload-file-v2/direct', requestDigest: '1'.repeat(64),
            intentDigest: '2'.repeat(64), responseStatus: 200, responseContentType: 'application/json',
            responseBytes: 240, responseTopLevelFieldNames: ['fileMetadata'], requestHeaderNames: ['content-type'],
            cookieNames: ['sso'], tlsVerified: true, redirectsFollowed: false, explicitRetries: 0, attemptCount: 1,
          } };
      }
      if (id === 'attachment.asset.delete') {
        assert.equal(input.assetId, TASK_ASSET_ID);
        return { localOperationId: 'delete-op', state: 'needs_review', httpStatus: 204 };
      }
      throw new Error(`unexpected submit: ${id}`);
    },
    async read(id, input, options) {
      calls.push({ type: 'read', id, input, options });
      if (id === 'attachment.assets.search') {
        const uploadSent = calls.some(call => call.type === 'submit' && call.id === 'attachment.upload.direct');
        const assets = existingName ? [{ name: TASK_NAME }] : uploadSent ? [{
          assetId: TASK_ASSET_ID, name: TASK_NAME, mimeType: 'text/plain', sizeBytes: expectedBytes,
          createTime: new Date().toISOString(), fileSource: 'SELF_UPLOAD_FILE_SOURCE', isDeleted: false,
        }] : [];
        return { status: 200, data: { assets, nextPageToken: null } };
      }
      if (id === 'attachment.file-metadata.read') {
        return { status: 200, data: {
          fileMetadataId: TASK_FILE_METADATA_ID, fileName: TASK_NAME, fileMimeType: 'text/plain',
          fileUri: TASK_FILE_URI, fileSource: 'SELF_UPLOAD_FILE_SOURCE', sizeBytes: expectedBytes,
        } };
      }
      if (id === 'attachment.asset.read') {
        assetReadCount += 1;
        if (assetReadCount === 1) return { status: 200, data: {
          assetId: TASK_ASSET_ID, name: TASK_NAME, mimeType: 'text/plain', sizeBytes: expectedBytes,
          createTime: new Date().toISOString(), fileSource: 'SELF_UPLOAD_FILE_SOURCE', isDeleted: false,
        } };
        throw Object.assign(new Error('not found'), { code: 'HTTP_STATUS_UNEXPECTED', details: { status: 404 } });
      }
      throw new Error(`unexpected read: ${id}`);
    },
    async getInMemoryPrivateResponse(id) { return privateResponses.get(id) ?? null; },
    async clearInMemoryPrivateResponse(id) { privateResponses.delete(id); return { cleared: true }; },
    async clearInMemoryServiceJobId() { return { cleared: true }; },
  };
  return { calls, client, journal, privateResponses, states };
}

test('source-captured multipart upload preserves file bytes through the registered direct HTTP operation', async () => {
  const registry = await loadContractRegistry();
  const operation = registry.operations.find(item => item.id === 'attachment.upload.direct');
  assert.ok(operation);
  assert.equal(operation.request.maxBodyBytes, MAX_DIRECT_MULTIPART_BODY_BYTES);
  assert.equal(operation.request.inputSchema.properties.multipartBodyBase64.maxLength, MAX_DIRECT_MULTIPART_BASE64_LENGTH);
  const boundary = 'GrokWebAttachmentUploadV2Boundary';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${TASK_NAME}"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8');
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const fileBytes = Buffer.alloc(1024 * 1024 + 1, 0x41);
  const multipart = Buffer.concat([body, fileBytes, suffix]);
  assert.ok(multipart.length > 1024 * 1024);
  const transport = new ObservedHttpTransport({ registry, fetchImpl: async () => { throw new Error('unused'); } });
  const prepared = transport.prepare(operation, { multipartBodyBase64: multipart.toString('base64') }, {
    origins: [{ origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'test-cookie', domain: 'grok.com', path: '/' }], headers: [] }],
  }, {}, { sourceDiscoveryPermit: 'first-live:attachment.upload.direct' });
  assert.ok(Buffer.isBuffer(prepared.body));
  assert.deepEqual(prepared.body, multipart);
  assert.equal(prepared.headers.get('content-type'), `multipart/form-data; boundary=${boundary}`);
  assert.equal(prepared.requestDigest, createRequestDigest({ method: 'POST', url: prepared.url.href, body: multipart }));
  multipart.fill(0);
  fileBytes.fill(0);
});

test('upload checks marker absence, reads bytes back, deletes only the task asset, and emits no server ID or URL', async () => {
  const root = await makeOutputRoot();
  const { calls, client, journal, privateResponses, states } = fakeRuntime();
  let safeAuditWritten = false;
  const api = createGrokAttachmentUploadClient({
    client, journal,
    assetReader: async request => {
      assert.equal(request.assetUrl, `https://assets.grok.com/${TASK_FILE_URI}?cache=1`);
      assert.equal(request.ssoCookieValue, 'current-owner-sso');
      assert.equal(request.expectedBytes, 14);
      return { status: 200, mimeType: 'text/plain', bodyBytes: 14, sha256: 'ea625e61c345553c8460eb993d5cb6b9758e4b7768fc348a7f28580eb5c4bd4c',
        bytesMatch: true, artifactPath: path.join(root, 'roundtrip.txt'), headersSubmittedNames: ['referer', 'sec-ch-ua-platform', 'user-agent'],
        cookieNamesUsed: ['sso'], source: 'curl_cffi-0.16.3-chrome150', verified: true };
    },
  });
  try {
    const result = await api.uploadDirect({
      fileName: TASK_NAME, mimeType: 'text/plain', bytes: TASK_BYTES,
      assetServerOrigin: 'https://assets.grok.com', assetCookieScope: { domain: '.grok.com', path: '/', secure: true, httpOnly: true },
      assetSsoCookieValue: 'current-owner-sso', assetRequestHeaders: {
        referer: 'https://grok.com/', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0', 'sec-ch-ua-platform': '"Linux"',
      }, ownerIdentityDigest: 'a'.repeat(64), outputRoot: root, outputName: 'roundtrip.txt',
      intentId: 'attachment-upload-test-once', confirm: true,
      cleanupTaskAsset: true,
      onSafeAudit: async audit => {
        assert.ok(await client.getInMemoryPrivateResponse('upload-op'));
        assert.equal(JSON.stringify(audit).includes(TASK_ASSET_ID), false);
        safeAuditWritten = true;
      },
    });
    assert.equal(result.state, 'completed');
    assert.equal(result.uniqueMarkerAbsentBeforeWrite, true);
    assert.equal(result.metadataReadbackVerified, true);
    assert.equal(result.assetReadbackVerified, true);
    assert.equal(result.downloadVerified, true);
    assert.equal(result.cleanupVerified, true);
    assert.equal(safeAuditWritten, true);
    const direct = calls.find(call => call.type === 'submit' && call.id === 'attachment.upload.direct');
    assert.ok(direct);
    const raw = Buffer.from(direct.input.multipartBodyBase64, 'base64');
    assert.ok(raw.includes(TASK_BYTES));
    assert.ok(raw.includes(Buffer.from(`filename="${TASK_NAME}"`)));
    assert.equal(raw.includes(Buffer.from('file_source')), false);
    raw.fill(0);
    direct.input.multipartBodyBase64 = '';
    const deletion = calls.find(call => call.type === 'submit' && call.id === 'attachment.asset.delete');
    assert.equal(deletion.input.assetId, TASK_ASSET_ID);
    assert.equal(calls.filter(call => call.type === 'submit' && call.id === 'attachment.upload.direct').length, 1);
    assert.equal(privateResponses.size, 0);
    assert.equal(states.get('upload-op').state, 'completed');
    assert.equal(states.get('upload-op').httpStatus, 200);
    assert.equal(states.get('delete-op').state, 'completed');
    assert.equal(states.get('delete-op').httpStatus, 204);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(TASK_ASSET_ID), false);
    assert.equal(serialized.includes(TASK_FILE_METADATA_ID), false);
    assert.equal(serialized.includes(TASK_FILE_URI), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('normal uploads retain a usable hidden file reference even when audit persistence fails', async () => {
  const root = await makeOutputRoot();
  const { calls, client, journal, states } = fakeRuntime();
  const api = createGrokAttachmentUploadClient({ client, journal,
    assetReader: async () => ({ status: 200, verified: true, mimeType: 'text/plain', bodyBytes: 14,
      sha256: 'ea625e61c345553c8460eb993d5cb6b9758e4b7768fc348a7f28580eb5c4bd4c', bytesMatch: true }),
  });
  try {
    const result = await api.uploadDirect({ fileName: TASK_NAME, mimeType: 'text/plain', bytes: TASK_BYTES,
      assetServerOrigin: 'https://assets.grok.com', assetCookieScope: { domain: '.grok.com', path: '/', secure: true, httpOnly: true },
      assetSsoCookieValue: 'current-owner-sso', assetRequestHeaders: { referer: 'https://grok.com/' },
      ownerIdentityDigest: 'a'.repeat(64), outputRoot: root, outputName: 'retained.txt',
      intentId: 'retained-upload-test', confirm: true,
      onSafeAudit: async () => { throw Object.assign(new Error('private details must not escape'), { code: 'EIO' }); },
    });
    assert.equal(result.state, 'completed');
    assert.equal(result.retainedForReuse, true);
    assert.equal(result.cleanupRequested, false);
    assert.equal(result.cleanupVerified, false);
    assert.equal(result.attachmentRef.assetId, TASK_ASSET_ID);
    assert.equal(result.attachmentRef.fileMetadataId, TASK_FILE_METADATA_ID);
    assert.equal(result.attachmentRef.fileUri, TASK_FILE_URI);
    assert.equal(Object.isFrozen(result.attachmentRef), true);
    assert.deepEqual(result.auditPersistence, { state: 'failed', errorCode: 'EIO', businessRetryAllowed: false });
    assert.equal(calls.some(call => call.type === 'submit' && call.id === 'attachment.asset.delete'), false);
    assert.equal(states.get('upload-op').state, 'completed');
    assert.equal(calls.filter(call => call.type === 'submit' && call.id === 'attachment.upload.direct').length, 1);
    for (const value of [TASK_ASSET_ID, TASK_FILE_METADATA_ID, TASK_FILE_URI, 'private details']) {
      assert.equal(JSON.stringify(result).includes(value), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('captured native direct policy supports 1 MiB plus one byte through upload and byte readback', async () => {
  const root = await makeOutputRoot();
  const fileBytes = Buffer.alloc(1024 * 1024 + 1, 0x42);
  const fileSha256 = createHash('sha256').update(fileBytes).digest('hex');
  const { calls, client, journal } = fakeRuntime({ expectedBytes: fileBytes.length });
  const api = createGrokAttachmentUploadClient({ client, journal,
    assetReader: async request => {
      assert.equal(request.expectedBytes, fileBytes.length);
      assert.equal(request.expectedSha256, fileSha256);
      assert.equal(request.maxBytes, fileBytes.length);
      return { status: 200, verified: true, mimeType: 'text/plain', bodyBytes: fileBytes.length,
        sha256: fileSha256, bytesMatch: true, source: 'loopback-fixture' };
    },
  });
  try {
    const result = await api.uploadDirect({ fileName: TASK_NAME, mimeType: 'text/plain', bytes: fileBytes,
      policy: { directUploadMaxSizeBytes: 16 * 1024 * 1024, maxUploadFileSizeBytes: 150 * 1024 * 1024 },
      assetServerOrigin: 'https://assets.grok.com', assetCookieScope: { domain: '.grok.com', path: '/', secure: true, httpOnly: true },
      assetSsoCookieValue: 'current-owner-sso', assetRequestHeaders: { referer: 'https://grok.com/' },
      ownerIdentityDigest: 'a'.repeat(64), outputRoot: root, outputName: 'large-retained.bin',
      intentId: 'attachment-direct-policy-1mibplus1-test', confirm: true,
    });
    assert.equal(result.state, 'completed');
    assert.equal(result.fileBytes, fileBytes.length);
    assert.equal(result.fileSha256, fileSha256);
    assert.equal(result.directUploadMaxSizeBytes, 16 * 1024 * 1024);
    assert.equal(result.maxUploadFileSizeBytes, 150 * 1024 * 1024);
    assert.equal(result.nativePolicySupplied, true);
    assert.equal(result.multipartBodyIntegrity.expectedBytes, result.multipartBodyIntegrity.transportObservedBytes);
    assert.equal(result.multipartBodyIntegrity.expectedSha256, result.multipartBodyIntegrity.transportObservedSha256);
    assert.equal(result.multipartBodyIntegrity.digestMatched, true);
    assert.equal(result.multipartBodyIntegrity.tempFileCleanup, 'removed');
    const direct = calls.find(call => call.type === 'submit' && call.id === 'attachment.upload.direct');
    assert.ok(direct);
    const raw = Buffer.from(direct.input.multipartBodyBase64, 'base64');
    assert.ok(raw.length > 1024 * 1024);
    assert.ok(raw.includes(fileBytes));
    raw.fill(0);
    direct.input.multipartBodyBase64 = '';
  } finally {
    fileBytes.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test('direct upload keeps the legacy cap without policy and rejects files above the selected direct threshold without routing', async () => {
  const { calls, client, journal } = fakeRuntime();
  const api = createGrokAttachmentUploadClient({ client, journal, assetReader: async () => { throw new Error('unused'); } });
  const legacyOversize = Buffer.alloc(512 * 1024 + 1, 0x43);
  const thresholdOversize = Buffer.alloc(1024 * 1024 + 1, 0x44);
  try {
    await assert.rejects(api.uploadDirect({ fileName: TASK_NAME, mimeType: 'text/plain', bytes: legacyOversize }),
      { code: 'ATTACHMENT_SIZE_EXCEEDS_NATIVE_MAX' });
    await assert.rejects(api.uploadDirect({ fileName: TASK_NAME, mimeType: 'text/plain', bytes: thresholdOversize,
      policy: { directUploadMaxSizeBytes: 1024 * 1024, maxUploadFileSizeBytes: 150 * 1024 * 1024 } }),
    { code: 'ATTACHMENT_PRESIGNED_ROUTE_REQUIRED' });
    assert.equal(calls.length, 0);
  } finally {
    legacyOversize.fill(0);
    thresholdOversize.fill(0);
  }
});

test('existing unique marker blocks the upload before the business POST', async () => {
  const root = await makeOutputRoot();
  const { calls, client, journal } = fakeRuntime({ existingName: true });
  const api = createGrokAttachmentUploadClient({ client, journal, assetReader: async () => { throw new Error('must not download'); } });
  try {
    await assert.rejects(api.uploadDirect({
      fileName: TASK_NAME, mimeType: 'text/plain', bytes: TASK_BYTES,
      assetServerOrigin: 'https://assets.grok.com', assetCookieScope: { domain: '.grok.com', path: '/', secure: true, httpOnly: true },
      assetSsoCookieValue: 'current-owner-sso', assetRequestHeaders: { referer: 'https://grok.com/',
        'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0', 'sec-ch-ua-platform': '"Linux"' },
      ownerIdentityDigest: 'a'.repeat(64), outputRoot: root, outputName: 'roundtrip.txt',
      intentId: 'attachment-upload-test-once', confirm: true,
    }), error => error.code === 'ATTACHMENT_MARKER_ALREADY_EXISTS');
    assert.equal(calls.some(call => call.type === 'submit' && call.id === 'attachment.upload.direct'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
