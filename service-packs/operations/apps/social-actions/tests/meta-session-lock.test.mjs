import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createMetaSessionLock } from '../lib/meta-bootstrap.mjs';

test('independent service session operations never overlap and nested owner bootstrap does not reacquire', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meta-session-lock-'));
  const lock = createMetaSessionLock({ lockRoot: () => root });
  let active = 0, maxActive = 0;
  await Promise.all([1, 2, 3].map(() => lock('threads', async () => {
    active++; maxActive = Math.max(maxActive, active);
    await lock('threads', async () => { assert.equal(active, 1); await delay(5); });
    active--;
  })));
  assert.equal(maxActive, 1);
});

test('escaped asynchronous work cannot reuse an expired session lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meta-session-lock-escaped-'));
  let acquisitions = 0;
  const lock = createMetaSessionLock({ lockRoot: () => root,
    sessionLock: async fn => { acquisitions++; return fn(); } });
  let escaped;
  await lock('threads', async () => { escaped = delay(10).then(() => lock('threads', async () => {})); });
  await escaped;
  assert.equal(acquisitions, 2);
});

test('failed operations release the lease and a different service remains independently scoped', async () => {
  let acquisitions = 0;
  const lock = createMetaSessionLock({ sessionLock: async fn => { acquisitions++; return fn(); } });
  await assert.rejects(lock('threads', async () => { throw new Error('local failure'); }), /local failure/);
  await lock('threads', async () => lock('instagram', async () => {}));
  assert.equal(acquisitions, 3);
  await assert.rejects(lock('unknown', async () => {}), { code: 'META_ACTION_INPUT' });
});

test('Meta session contention allows slow bounded processing to finish on both services', async () => {
  const timeouts = [];
  const lock = createMetaSessionLock({ sessionLock: async (operation, options) => { timeouts.push(options.timeoutMs); return operation(); } });
  await lock('threads', async () => {}); await lock('instagram', async () => {});
  assert.deepEqual(timeouts, [600_000, 600_000]);
});
