import test from 'node:test';
import assert from 'node:assert/strict';
import { submitOnce, verifyOwnPostReadback } from '../lib/sns-submit.mjs';

const attemptedAt = Date.parse('2026-10-26T10:00:00.000Z');
const verified = (overrides = {}) => verifyOwnPostReadback({
  site: 'x', account: 'example_owner', expectedText: 'A new post\n#web', attemptedAt,
  checkedAt: attemptedAt + 5_000,
  candidates: [{
    url: 'https://x.com/example_owner/status/2114388219085394146',
    account: 'example_owner', text: 'A new post\n#web ',
    createdAt: '2026-10-26T10:00:01.000Z',
  }],
  ...overrides,
});

test('readback needs a recent exact post from the requested account and a canonical post URL', () => {
  assert.deepEqual(verified(), {
    outcome: 'verified', url: 'https://x.com/example_owner/status/2114388219085394146',
    account: 'example_owner', createdAt: '2026-10-26T10:00:01.000Z', textMatched: true,
  });
  assert.equal(verified({ candidates: [{
    account: 'example_owner', text: 'A new post\n#web', createdAt: '2026-10-26T10:00:01.000Z',
  }] }).reason, 'NO_EXACT_OWN_POST_READBACK');
  assert.equal(verified({ candidates: [{
    url: 'https://x.com/someone_else/status/2114388219085394146',
    text: 'A new post\n#web', createdAt: '2026-10-26T10:00:01.000Z',
  }] }).reason, 'NO_EXACT_OWN_POST_READBACK');
  assert.equal(verified({ candidates: [{
    url: 'https://x.com/example_owner/status/2114388219085394146',
    text: 'A new post\n#web', createdAt: '2026-10-26T09:58:00.000Z',
  }] }).reason, 'NO_EXACT_OWN_POST_READBACK');
  assert.equal(verified({
    beforeUrls: ['https://x.com/example_owner/status/2114388219085394146?s=20'],
  }).reason, 'NO_EXACT_OWN_POST_READBACK');
});

test('Threads readback also binds the profile owner and ignores non-identity tracking parameters', () => {
  const result = verifyOwnPostReadback({
    site: 'threads', account: '@example_owner', expectedText: 'A new post\n#web', attemptedAt,
    checkedAt: attemptedAt + 5_000,
    candidates: [{ url: 'https://www.threads.com/@example_owner/post/abc_123?share=1',
      text: 'A new post\n#web', createdAt: '2026-10-26T10:00:01.000Z' }],
  });
  assert.equal(result.outcome, 'verified');
  assert.equal(result.url, 'https://www.threads.com/@example_owner/post/abc_123');
});

test('delayed readback succeeds after one submit click and never repeats it', async () => {
  let clicks = 0, reads = 0, waits = 0;
  const state = { submissionAttempted: false, outcomeUnknown: false, needsReconciliation: false };
  const result = await submitOnce({
    state,
    preflight: async () => true,
    submit: async () => {
      clicks++;
      assert.equal(state.submissionAttempted, true, 'intent is recorded before the click callback');
      assert.equal(state.needsReconciliation, true, 'the result is uncertain until readback confirms it');
    },
    readback: async () => ++reads < 3 ? { outcome: 'outcome_unknown' } : verified(),
    wait: async () => { waits++; }, maxPolls: 5,
  });
  assert.equal(result.outcome, 'verified');
  assert.equal(result.submissionAttempted, true);
  assert.equal(state.outcome, 'verified');
  assert.equal(state.outcomeUnknown, false);
  assert.equal(clicks, 1);
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

test('missing URL or wrong-account readback ends unknown without a second click', async () => {
  for (const observation of [
    { outcome: 'outcome_unknown', reason: 'NO_EXACT_OWN_POST_READBACK' },
    verified({ candidates: [{
      url: 'https://x.com/another_owner/status/2114388219085394146',
      text: 'A new post\n#web', createdAt: '2026-10-26T10:00:01.000Z',
    }] }),
  ]) {
    let clicks = 0;
    const result = await submitOnce({
      preflight: async () => true,
      submit: async () => { clicks++; },
      readback: async () => observation,
      wait: async () => {}, maxPolls: 2,
    });
    assert.equal(result.outcome, 'outcome_unknown');
    assert.equal(result.needsReconciliation, true);
    assert.equal(clicks, 1);
  }
});

test('explicit preflight failure makes no click; explicit submit rejection is not retried', async () => {
  let clicks = 0;
  const blockedState = { submissionAttempted: false, outcomeUnknown: false, needsReconciliation: false };
  const blocked = await submitOnce({ state: blockedState,
    preflight: async () => ({ ok: false, reason: 'POST_BUTTON_COVERED' }),
    submit: async () => { clicks++; }, readback: async () => verified(), wait: async () => {} });
  assert.equal(blocked.outcome, 'not_submitted');
  assert.equal(blocked.submissionAttempted, false);
  assert.equal(blocked.reason, 'POST_BUTTON_COVERED');
  assert.equal(blockedState.submissionAttempted, false);
  assert.equal(blockedState.needsReconciliation, false);
  assert.equal(clicks, 0);

  let reads = 0;
  const rejected = await submitOnce({ preflight: async () => true, submit: async () => { clicks++; },
    readback: async () => { reads++; return { outcome: 'rejected', explicitlyRejected: true, reason: 'X_PROVIDER_REJECTED' }; },
    wait: async () => { assert.fail('an explicit rejection must stop reconciliation'); } });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.submissionAttempted, true);
  assert.equal(clicks, 1);
  assert.equal(reads, 1);
});

test('a failed or timed out submit result remains outcome-unknown and is never retried', async () => {
  let clicks = 0;
  const result = await submitOnce({
    preflight: async () => true,
    submit: async () => { clicks++; throw new Error('release acknowledgment lost'); },
    readback: async () => ({ outcome: 'outcome_unknown' }),
    wait: async () => {},
  });
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.needsReconciliation, true);
  assert.equal(clicks, 1);
});

test('a reconciliation wait failure after the click preserves attempted and unknown status without retry', async () => {
  let clicks = 0, reads = 0;
  const state = { submissionAttempted: false, outcomeUnknown: false, needsReconciliation: false };
  const result = await submitOnce({
    state,
    preflight: async () => true,
    submit: async () => { clicks++; },
    readback: async () => { reads++; return { outcome: 'outcome_unknown' }; },
    wait: async () => { throw new Error('poll interrupted'); },
    maxPolls: 5,
  });
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.submissionAttempted, true);
  assert.equal(result.needsReconciliation, true);
  assert.equal(result.reason, 'POST_RECONCILIATION_WAIT_FAILED');
  assert.equal(state.submissionAttempted, true);
  assert.equal(state.outcomeUnknown, true);
  assert.equal(state.needsReconciliation, true);
  assert.equal(clicks, 1);
  assert.equal(reads, 1);
});
