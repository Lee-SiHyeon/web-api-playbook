import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdFor, assertNotHeld, setHold, clearHold, readHolds } from '../scripts/publish-hold.mjs';

const tmp = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'hold-')), 'publish-hold.json');

test('no file means no hold', () => {
  assert.equal(holdFor(['C:/x/run'], tmp()).held, false);
});

test('a match hold covers paths that contain the text, in any slash style and case', () => {
  const f = tmp();
  setHold({ match: 'daangn-q-26970994', reason: '수정본 대기' }, f);
  assert.deepEqual(holdFor(['C:\\Codex\\auto-briefs\\Daangn-Q-26970994\\run'], f), { held: true, reason: '수정본 대기', scope: 'daangn-q-26970994' });
  assert.equal(holdFor(['C:/Codex/auto-briefs/daangn-q-26971056/run'], f).held, false);
  assert.throws(() => assertNotHeld(['x/daangn-q-26970994'], f), e => e.code === 'PUBLISH_HELD' && e.reason === '수정본 대기');
});

test('an all-hold blocks everything until cleared; clear removes one match only', () => {
  const f = tmp();
  setHold({ match: 'a' }, f); setHold({ match: 'b' }, f);
  assert.equal(clearHold({ match: 'a' }, f).matches.length, 1);
  setHold({ all: true, reason: '점검' }, f);
  assert.equal(holdFor(['anything'], f).reason, '점검');
  clearHold({ all: true }, f);
  assert.equal(holdFor(['b/run'], f).held, false);
  assert.deepEqual(readHolds(f), { all: null, matches: [] });
});

test('an unreadable hold file fails closed', () => {
  const f = tmp();
  writeFileSync(f, '{broken');
  assert.equal(holdFor(['x'], f).held, true);
});

test('set without a target is refused', () => {
  assert.throws(() => setHold({}, tmp()), /HOLD_TARGET_REQUIRED/);
});
