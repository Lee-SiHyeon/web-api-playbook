import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runSnsPublish } from '../scripts/sns-publish.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sns-reservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'sns'));
  const cover = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(cover, 0);
  cover.writeUInt32BE(1080, 16);
  cover.writeUInt32BE(1350, 20);
  await writeFile(path.join(root, 'sns', 'instagram-01.png'), cover);
  for (const [name, value] of Object.entries({
    'final-verification.json': { status: 'published_verified' },
    'sns/versions.json': { threads: { posts: ['A'] }, x: { posts: ['A'] } },
    'sns/sns-manifest.json': { schemaVersion: 1, outputs: {} },
  })) await writeFile(path.join(root, name), JSON.stringify(value));
  return root;
}

test('a completed writer cannot be invoked again with freshly allocated post IDs', async t => {
  const runDir = await fixture(t); let calls = 0;
  const options = { runDir, channel: 'threads', approvalId: 'approved', journalDir: path.join(runDir, 'journal'),
    writers: { publishChain: async () => { calls++; return { ids: ['1'], readbackVerified: false }; } } };
  await runSnsPublish(options);
  await assert.rejects(runSnsPublish(options), { code: 'SNS_RUN_RECONCILIATION_REQUIRED' });
  assert.equal(calls, 1);
  const guard = JSON.parse(await readFile(path.join(runDir, 'sns/.publish-threads-intent.json'), 'utf8'));
  assert.equal(guard.automaticRetry, false);
});

test('an uncertain writer leaves its run reserved instead of resending', async t => {
  const runDir = await fixture(t); let calls = 0;
  const options = { runDir, channel: 'threads', approvalId: 'approved', journalDir: path.join(runDir, 'journal'),
    writers: { publishChain: async () => { calls++; throw Object.assign(new Error('unknown'), { code: 'WRITE_UNKNOWN' }); } } };
  await assert.rejects(runSnsPublish(options), { code: 'WRITE_UNKNOWN' });
  await assert.rejects(runSnsPublish(options), { code: 'SNS_RUN_RECONCILIATION_REQUIRED' });
  assert.equal(calls, 1);
});

test('concurrent invocations reserve one run and invoke one writer', async t => {
  const runDir = await fixture(t); let calls = 0;
  const options = { runDir, channel: 'threads', approvalId: 'approved', journalDir: path.join(runDir, 'journal'),
    writers: { publishChain: async () => { calls++; return { ids: ['1'] }; } } };
  const results = await Promise.allSettled([runSnsPublish(options), runSnsPublish(options)]);
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SNS_RUN_RECONCILIATION_REQUIRED');
});

test('dry-run neither reserves a run nor consumes an existing reservation', async t => {
  const runDir = await fixture(t);
  const guard = path.join(runDir, 'sns/.publish-threads-intent.json');
  const options = { runDir, channel: 'threads', dryRun: true };
  assert.equal((await runSnsPublish(options)).dryRun, true);
  await assert.rejects(readFile(guard), { code: 'ENOENT' });
  await writeFile(guard, '{"state":"published_reference"}\n');
  assert.equal((await runSnsPublish(options)).dryRun, true);
  assert.equal(await readFile(guard, 'utf8'), '{"state":"published_reference"}\n');
});
