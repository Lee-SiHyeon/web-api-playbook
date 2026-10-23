import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryGrokAttachmentRuntime } from '../src/runtime.mjs';

test('attachment runtime exposes the reusable API with memory-only credentials and no eager requests', async () => {
  let networkCalls = 0;
  let downloadCalls = 0;
  const runtime = await createInMemoryGrokAttachmentRuntime({
    fetchImpl: async () => { networkCalls++; throw new Error('unexpected network'); },
    assetReader: async () => { downloadCalls++; throw new Error('unexpected download'); },
  });
  assert.equal(runtime.sessionPersistence.provider, 'process-memory-only');
  assert.equal(typeof runtime.attachments.uploadDirect, 'function');
  assert.equal(await runtime.client.status().then(value => value.session.available), false);
  await assert.rejects(runtime.attachments.uploadDirect({ cleanupTaskAsset: 'yes' }),
    error => error.code === 'ATTACHMENT_CLEANUP_OPTION_INVALID');
  assert.equal(networkCalls, 0);
  assert.equal(downloadCalls, 0);
});

test('presigned runtime is wired with its actual owner binding and makes no request without one', async () => {
  let networkCalls = 0;
  let putCalls = 0;
  const runtime = await createInMemoryGrokAttachmentRuntime({
    fetchImpl: async () => { networkCalls++; throw new Error('unexpected API request'); },
    assetReader: async () => { throw new Error('unexpected download'); },
    signedUrlPolicy: async () => true,
    signedPutImpl: async () => { putCalls++; throw new Error('unexpected PUT'); },
    onUploadStageReceipt: async () => {},
  });
  assert.equal(typeof runtime.presignedAttachments.upload, 'function');
  await assert.rejects(runtime.presignedAttachments.upload({
    fileName: 'fixture.txt', mimeType: 'text/plain', bytes: Buffer.from('42'),
    ownerIdentityDigest: 'a'.repeat(64), intentId: 'fixture-presigned-unowned', confirm: true,
    policy: { directUploadMaxSizeBytes: 0, maxUploadFileSizeBytes: 16,
      multipartSupported: true, multipartConcurrency: 2, maxStatusReads: 1, statusPollIntervalMs: 0 },
  }), error => ['OWNER_VERIFICATION_REQUIRED', 'ATTACHMENT_OWNER_BINDING_REQUIRED', 'ATTACHMENT_OWNER_SCOPE_MISMATCH'].includes(error.code));
  assert.equal(networkCalls, 0);
  assert.equal(putCalls, 0);
});
