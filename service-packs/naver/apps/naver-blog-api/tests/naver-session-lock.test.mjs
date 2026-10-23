import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireNaverSessionLock,
  getNaverSessionLockPath,
  NAVER_SESSION_LOCK_FILENAME,
  NAVER_SESSION_LOCK_MAX_WAIT_MS,
  withNaverSessionLock,
} from '../scripts/naver-session-lock.mjs';

const modulePath = fileURLToPath(new URL('../scripts/naver-session-lock.mjs', import.meta.url));

async function createLockPath(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'naver-session-lock-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, NAVER_SESSION_LOCK_FILENAME);
}

function spawnHolder(lockPath) {
  const source = `
    const { acquireNaverSessionLock } = await import(process.argv[1]);
    const release = await acquireNaverSessionLock({ lockPath: process.argv[2], waitMs: 1000 });
    console.log('ready');
    process.stdin.once('data', () => { release(); console.log('released'); process.exit(0); });
    process.stdin.resume();
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', source, pathToFileURL(modulePath).href, lockPath], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = chunk => {
      buffered += chunk.toString('utf8');
      const index = buffered.indexOf('\n');
      if (index < 0) return;
      const line = buffered.slice(0, index).trim();
      stream.off('data', onData);
      if (line === expected) resolve();
      else reject(new Error('LOCK_CHILD_PROTOCOL_FAILED'));
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('uses the same per-user lock path and a 30-second maximum wait', () => {
  const localAppData = path.join(os.tmpdir(), 'naver-lock-local-app-data');
  assert.equal(getNaverSessionLockPath({ localAppData }), path.join(localAppData, 'naver-publisher-session.lock'));
  assert.equal(NAVER_SESSION_LOCK_MAX_WAIT_MS, 30_000);
});

test('writes a valid record when the filesystem accepts only partial chunks', async t => {
  const lockPath = await createLockPath(t);
  let writeCalls = 0;
  const release = await acquireNaverSessionLock({ lockPath, waitMs: 0, testHooks: {
    writeSync: (fd, buffer, offset, length, position) => {
      writeCalls++;
      return writeSync(fd, buffer, offset, Math.min(length, 2), position);
    },
  } });

  const raw = await readFile(lockPath, 'utf8');
  const record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), ['at', 'pid']);
  assert.equal(record.pid, process.pid);
  assert.equal(JSON.stringify(record), raw);
  assert.ok(writeCalls > 1);
  release();
});

test('serializes two processes and allows the next caller after release', async t => {
  const lockPath = await createLockPath(t);
  const holder = spawnHolder(lockPath);
  t.after(() => { if (holder.exitCode == null) holder.kill(); });
  await waitForLine(holder.stdout, 'ready');

  const heldRecord = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.deepEqual(Object.keys(heldRecord).sort(), ['at', 'pid']);
  assert.equal(heldRecord.pid, holder.pid);
  await assert.rejects(acquireNaverSessionLock({ lockPath, waitMs: 30, retryIntervalMs: 5 }), error => error.code === 'NAVER_SESSION_BUSY');
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, holder.pid);

  const releasedLine = waitForLine(holder.stdout, 'released');
  const childExit = once(holder, 'exit');
  holder.stdin.end('release');
  await releasedLine;
  const [exitCode] = await childExit;
  assert.equal(exitCode, 0);

  const release = await acquireNaverSessionLock({ lockPath, waitMs: 0 });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
  release();
});

test('does not evict an old lock record while its process is alive', async t => {
  const lockPath = await createLockPath(t);
  const legacyRecord = JSON.stringify({ pid: process.pid, at: '2020-01-01T00:00:00.000Z' });
  await writeFile(lockPath, legacyRecord, 'utf8');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await utimes(lockPath, old, old);

  await assert.rejects(acquireNaverSessionLock({ lockPath, waitMs: 0 }), error => error.code === 'NAVER_SESSION_BUSY');
  assert.equal(await readFile(lockPath, 'utf8'), legacyRecord);
});

test('reclaims a legacy-format lock after its PID has exited', async t => {
  const lockPath = await createLockPath(t);
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  await once(exited, 'close');
  const legacyRecord = JSON.stringify({ pid: exited.pid, at: '2020-01-01T00:00:00.000Z' });
  await writeFile(lockPath, legacyRecord, 'utf8');

  const release = await acquireNaverSessionLock({ lockPath, waitMs: 0 });
  const replacement = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(replacement.pid, process.pid);
  assert.notEqual(JSON.stringify(replacement), legacyRecord);
  release();
});

test('serializes two stale reclaimers and preserves the first reclaimer live lock', async t => {
  const lockPath = await createLockPath(t);
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  await once(exited, 'close');
  const staleRecord = JSON.stringify({ pid: exited.pid, at: '2020-01-01T00:00:00.000Z' });
  await writeFile(lockPath, staleRecord, 'utf8');

  const firstHasGuard = deferred();
  const releaseFirstGuard = deferred();
  const secondFoundGuard = deferred();
  const first = acquireNaverSessionLock({ lockPath, waitMs: 1000, retryIntervalMs: 5, testHooks: {
    afterRecoveryGuardAcquired: async () => {
      firstHasGuard.resolve();
      await releaseFirstGuard.promise;
    },
  } });
  await firstHasGuard.promise;

  const second = acquireNaverSessionLock({ lockPath, waitMs: 300, retryIntervalMs: 5, testHooks: {
    onRecoveryGuardContended: () => secondFoundGuard.resolve(),
  } });
  // Handle the expected timeout immediately, even if the filesystem read below is delayed.
  const secondRejected = assert.rejects(second, error => error.code === 'NAVER_SESSION_BUSY');
  await secondFoundGuard.promise;

  releaseFirstGuard.resolve();
  const releasePrimary = await first;
  const firstOwnerRecord = await readFile(lockPath, 'utf8');
  assert.equal(JSON.parse(firstOwnerRecord).pid, process.pid);
  await secondRejected;
  assert.equal(await readFile(lockPath, 'utf8'), firstOwnerRecord);
  releasePrimary();
});

test('fails closed on an existing dead recovery guard instead of reclaiming it recursively', async t => {
  const lockPath = await createLockPath(t);
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  // Establish completed child cleanup before recording its PID as stale.
  await once(exited, 'close');
  const stalePrimary = JSON.stringify({ pid: exited.pid, at: '2020-01-01T00:00:00.000Z' });
  const staleRecoveryGuard = JSON.stringify({ pid: exited.pid, at: '2020-01-01T00:00:01.000Z' });
  const recoveryPath = `${lockPath}.recovery`;
  await writeFile(lockPath, stalePrimary, 'utf8');
  await writeFile(recoveryPath, staleRecoveryGuard, 'utf8');

  await assert.rejects(acquireNaverSessionLock({ lockPath, waitMs: 0 }), error => error.code === 'NAVER_SESSION_BUSY');
  assert.equal(await readFile(lockPath, 'utf8'), stalePrimary);
  assert.equal(await readFile(recoveryPath, 'utf8'), staleRecoveryGuard);
});

test('leaves an unreadable partial record alone because no dead PID was established', async t => {
  const lockPath = await createLockPath(t);
  await writeFile(lockPath, '{"pid":', 'utf8');

  await assert.rejects(acquireNaverSessionLock({ lockPath, waitMs: 0 }), error => error.code === 'NAVER_SESSION_BUSY');
  assert.equal(await readFile(lockPath, 'utf8'), '{"pid":');
});

test('release checks both the record and the file it created', async t => {
  const lockPath = await createLockPath(t);
  const release = await acquireNaverSessionLock({ lockPath, waitMs: 0 });
  const replacement = JSON.stringify({ pid: process.pid, at: '2030-01-01T00:00:00.000Z' });
  await writeFile(lockPath, replacement, 'utf8');

  assert.equal(release(), false);
  assert.equal(await readFile(lockPath, 'utf8'), replacement);
});

test('withNaverSessionLock releases after an operation throws', async t => {
  const lockPath = await createLockPath(t);

  await assert.rejects(withNaverSessionLock(async () => { throw new Error('FIXTURE_FAILURE'); }, { lockPath, waitMs: 0 }), /FIXTURE_FAILURE/);
  await assert.rejects(readFile(lockPath, 'utf8'), error => error.code === 'ENOENT');
});
