import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLatestCompletedVideo } from '../src/verify.mjs';

const makeMedia = (id, stateCode, bytes) => {
  const details = [];
  details[8] = [stateCode];
  details[13] = bytes;
  const record = [];
  record[0] = id;
  record[5] = details;
  return record;
};

test('verifier skips newer pending records even when they report positive bytes', () => {
  const pending = makeMedia('11111111-1111-4111-8111-111111111111', 6, 4_385_072);
  const olderPending = makeMedia('22222222-2222-4222-8222-222222222222', 2, 120);
  const latestCompleted = makeMedia('33333333-3333-4333-8333-333333333333', 3, 4_000_000);
  const olderCompleted = makeMedia('44444444-4444-4444-8444-444444444444', 3, 3_000_000);

  assert.equal(selectLatestCompletedVideo([
    pending, olderPending, latestCompleted, olderCompleted,
  ]), latestCompleted);
});

test('verifier reports no completed candidate for empty, pending, malformed, or empty files', () => {
  assert.equal(selectLatestCompletedVideo([]), null);
  assert.equal(selectLatestCompletedVideo(null), null);
  assert.equal(selectLatestCompletedVideo([
    makeMedia('11111111-1111-4111-8111-111111111111', 6, 4_385_072),
    makeMedia('22222222-2222-4222-8222-222222222222', 2, 120),
    makeMedia('33333333-3333-4333-8333-333333333333', 3, 0),
    makeMedia('not-a-media-id', 3, 4_000_000),
  ]), null);
});
