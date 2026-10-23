import test from 'node:test';
import assert from 'node:assert/strict';
import { withXWriteProgress, publishThread } from '../../affiliate-api-hub/scripts/sns/writers/x.mjs';

test('QuickFact writer forwards scoped wait, ready and STOP hooks before taking a session', async () => {
  const wait = async () => {};
  const ready = async () => {};
  const stopped = async () => true;
  const sentinel = new Error('fixture gate ends before authentication');
  await assert.rejects(withXWriteProgress({onWait:wait,onReady:ready,isStopped:stopped}, () => publishThread(['fixture'], {
    runKey:'fixture',journalDir:'unused',writeGate:async hooks => {
      assert.equal(hooks.onWait,wait);
      assert.equal(hooks.onReady,ready);
      assert.equal(hooks.isStopped,stopped);
      throw sentinel;
    }
  })), error => error === sentinel);
});
