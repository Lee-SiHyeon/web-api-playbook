import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSessionLock } from '../lib/lock.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'tistory-lock-'));
}

function owner(pid = process.pid) {
  return { pid, startedAt: new Date().toISOString(), nonce: randomUUID() };
}

test('concurrent callbacks serialize through an exclusive protected lock file', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'nested', 'tistory.lock');
  let active = 0;
  let maximum = 0;
  const run = () => withSessionLock(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
  }, { lockPath, timeoutMs: 1000, pollMs: 2 });

  await Promise.all([run(), run(), run()]);
  assert.equal(maximum, 1);
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('a transient EPERM opening a lock is retried as bounded contention', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tistory.lock');
  let openAttempts = 0;
  let entered = false;

  await withSessionLock(async () => { entered = true; }, {
    lockPath,
    timeoutMs: 100,
    pollMs: 2,
    lockFileOpener: async (...args) => {
      openAttempts++;
      if (openAttempts === 1) throw Object.assign(new Error('transient Windows sharing denial'), { code: 'EPERM' });
      return open(...args);
    },
  });
  assert.ok(openAttempts >= 2);
  assert.equal(entered, true);
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('persistent EPERM times out safely without stale-lock recovery or deletion', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tistory.lock');
  const body = JSON.stringify(owner(999_999_991));
  await writeFile(lockPath, body, { mode: 0o600 });
  let aliveChecks = 0;

  await assert.rejects(withSessionLock(async () => assert.fail('callback must not run'), {
    lockPath,
    timeoutMs: 15,
    pollMs: 2,
    processAlive: () => { aliveChecks++; return false; },
    lockFileOpener: async () => { throw Object.assign(new Error('persistent Windows sharing denial'), { code: 'EPERM' }); },
  }), { code: 'TISTORY_SESSION_BUSY', message: 'TISTORY_SESSION_BUSY' });
  assert.equal(aliveChecks, 0);
  assert.equal(await readFile(lockPath, 'utf8'), body);
});

test('a valid lock owned by a confirmed-dead process is recovered', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tistory.lock');
  await writeFile(lockPath, JSON.stringify(owner(999_999_991)), { mode: 0o600 });
  let aliveChecks = 0;
  let entered = false;

  await withSessionLock(async () => { entered = true; }, {
    lockPath,
    timeoutMs: 200,
    pollMs: 2,
    processAlive: pid => { aliveChecks++; assert.equal(pid, 999_999_991); return false; },
  });
  assert.equal(entered, true);
  assert.ok(aliveChecks >= 1);
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('a live owner is never unlinked and contention times out with a sanitized error', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tistory.lock');
  const liveOwner = owner();
  const body = JSON.stringify(liveOwner);
  await writeFile(lockPath, body, { mode: 0o600 });

  await assert.rejects(withSessionLock(async () => assert.fail('callback must not run'), {
    lockPath, timeoutMs: 25, pollMs: 2,
  }), error => {
    assert.equal(error.code, 'TISTORY_SESSION_BUSY');
    assert.equal(error.message, 'TISTORY_SESSION_BUSY');
    assert.doesNotMatch(error.message, new RegExp(liveOwner.nonce));
    return true;
  });
  assert.equal(await readFile(lockPath, 'utf8'), body);
});

test('old malformed or empty lock files recover only after two minutes', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tistory.lock');
  await writeFile(lockPath, '');
  const recent = new Date(Date.now() - 30_000);
  await utimes(lockPath, recent, recent);
  await assert.rejects(withSessionLock(async () => assert.fail('recent malformed lock must remain busy'), {
    lockPath, timeoutMs: 10, pollMs: 2,
  }), { code: 'TISTORY_SESSION_BUSY' });
  assert.equal(await readFile(lockPath, 'utf8'), '');

  const old = new Date(Date.now() - 121_000);
  await utimes(lockPath, old, old);
  await withSessionLock(async () => {}, { lockPath, timeoutMs: 200, pollMs: 2 });
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('callback errors propagate and release only the matching owner nonce', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tistory.lock');
  const sentinel = new Error('synthetic callback failure');
  await assert.rejects(withSessionLock(async () => { throw sentinel; }, { lockPath }), error => error === sentinel);
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
  const collisionSentinel = Object.assign(new Error('callback reported a collision'), { code: 'EEXIST' });
  await assert.rejects(withSessionLock(async () => { throw collisionSentinel; }, { lockPath }), error => error === collisionSentinel);
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });

  const permissionSentinel = Object.assign(new Error('callback reported an OS permission error'), { code: 'EPERM' });
  await assert.rejects(withSessionLock(async () => { throw permissionSentinel; }, { lockPath }), error => error === permissionSentinel);
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });

  let replacement;
  await withSessionLock(async () => {
    await rm(lockPath);
    replacement = owner(999_999_991);
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(replacement));
    await handle.close();
  }, { lockPath });
  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), replacement);
});

test('created lock owner metadata contains no secret payload and uses restrictive mode', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'tistory.lock');
  await withSessionLock(async () => {
    const contents = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(contents);
    assert.deepEqual(Object.keys(parsed).sort(), ['nonce', 'pid', 'startedAt']);
    assert.doesNotMatch(contents, /cookie|token|secret/i);
    if (process.platform !== 'win32') assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  }, { lockPath });
});

test('an optional lock owner script is restricted to a safe basename and cannot override lease identity', async t => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'runtime-control.lock');
  await withSessionLock(async () => {
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.deepEqual(Object.keys(owner).sort(), ['nonce', 'pid', 'script', 'startedAt']);
    assert.equal(owner.script, 'threads-basic-reload.mjs');
    assert.equal(owner.pid, process.pid);
    assert.match(owner.nonce, /^[0-9a-f-]{36}$/i);
    assert.equal(typeof owner.startedAt, 'string');
  }, { lockPath, ownerScript: 'threads-basic-reload.mjs' });
  await assert.rejects(withSessionLock(async () => {}, { lockPath, ownerScript: '..\\threads-basic-reload.mjs' }), error => {
    assert.equal(error.message, 'TISTORY_SESSION_LOCK_OPTIONS_INVALID');
    return true;
  });
});
