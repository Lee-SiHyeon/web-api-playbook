import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCandidates } from '../x-candidates.mjs';
import { discoverReplyCandidates } from '../x-reply-candidates.mjs';
import { readCooldown } from '../x-read-cooldown.mjs';

test('discovery retains only safe protected-store diagnostics across report rehydration', async () => {
  for (const timedOut of [true, false]) {
    let calls = 0;
    const search = async () => {
      calls++;
      throw Object.assign(new Error('synthetic secret'), {
        code: 'PROTECTED_STORE_READ_FAILED',
        detail: { stage: 'unprotect', timedOut, exitStatus: 1, stdout: 'synthetic secret' },
      });
    };
    const report = await discoverCandidates({ search });
    assert.equal(calls, 1);
    const error = Object.assign(new Error(), JSON.parse(JSON.stringify(report.failure)));
    assert.deepEqual(error.detail, { stage: 'unprotect', timedOut, exitStatus: 1 });
    assert.equal(JSON.stringify(report).includes('synthetic secret'), false);
    assert.deepEqual(readCooldown(error, 'read', 1000), timedOut ? { status: 'waiting_for_protected_store', retryAt: 61000 } : null);
    const replies = await discoverReplyCandidates([{ postId: '1', authorId: '2', author: 'example' }], { readConversation: search });
    assert.equal(calls, 2);
    assert.deepEqual(replies.failure.detail, error.detail);
    assert.equal(JSON.stringify(replies).includes('synthetic secret'), false);
  }
});
