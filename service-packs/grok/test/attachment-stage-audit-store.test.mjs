import assert from 'node:assert/strict';
import { readFile, stat, unlink } from 'node:fs/promises';
import test from 'node:test';
import { persistGrokAttachmentStageAudit } from '../src/attachment-stage-audit-store.mjs';

test('stage checkpoints preserve safe response metadata in distinct immutable files', async () => {
  const receipt = { stageKey: 'a'.repeat(64), checkpoint: 'response_observed',
    httpStatus: 200, responseBytes: 0, responseDigest: 'b'.repeat(64), businessRetryAllowed: false };
  const first = await persistGrokAttachmentStageAudit(receipt);
  const second = await persistGrokAttachmentStageAudit(receipt);
  try {
    assert.notEqual(first, second);
    assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), receipt);
    assert.equal((await stat(first)).mode & 0o777, 0o600);
  } finally { await Promise.all([unlink(first), unlink(second)]); }
});

test('stage checkpoints reject signed URLs and resource identifiers before creating a file', async () => {
  for (const unsafe of [{ uploadId: 'private-ref' }, { nested: { other: 'https://example.com/?signature=private' } }]) {
    await assert.rejects(persistGrokAttachmentStageAudit({ stageKey: 'a'.repeat(64), checkpoint: 'response_observed', ...unsafe }),
      { code: 'ATTACHMENT_STAGE_AUDIT_PRIVATE_FIELD' });
  }
});
