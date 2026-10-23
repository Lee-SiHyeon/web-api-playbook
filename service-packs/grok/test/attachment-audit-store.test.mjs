import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistGrokAttachmentApiAudit } from '../src/attachment-audit-store.mjs';

const verificationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'verification');
const fileName = `grok-attachment-upload-api-test-${process.pid}.json`;
const filePath = path.join(verificationRoot, fileName);

test('safe attachment audit writes atomically and rejects server identifiers or URLs', async () => {
  try {
    const receipt = {
      operation: 'attachment.upload.direct',
      status: 200,
      requestDigest: 'a'.repeat(64),
      cookieNames: ['sso'],
      responseFieldNames: ['uploadId'],
      responseBytesRecorded: false,
    };
    assert.equal(await persistGrokAttachmentApiAudit(receipt, { fileName }), filePath);
    const info = await lstat(filePath);
    assert.equal(info.isFile(), true);
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), receipt);
    await assert.rejects(persistGrokAttachmentApiAudit(receipt, { fileName }), error => error.code === 'ATTACHMENT_AUDIT_ALREADY_EXISTS');
    await assert.rejects(persistGrokAttachmentApiAudit({ ...receipt, assetId: 'opaque-server-id' }, {
      fileName: `grok-attachment-upload-api-test-${process.pid + 1}.json`,
    }), error => error.code === 'ATTACHMENT_AUDIT_PRIVATE_FIELD_REJECTED');
    await assert.rejects(persistGrokAttachmentApiAudit({ ...receipt, reference: 'https://assets.grok.com/private' }, {
      fileName: `grok-attachment-upload-api-test-${process.pid + 2}.json`,
    }), error => error.code === 'ATTACHMENT_AUDIT_URL_REJECTED');
  } finally {
    await unlink(filePath).catch(() => {});
  }
});
