import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasUnconfirmedAttempt, planShortSlot, snsAttemptRecord, snsOutcomeRecord } from '../lib/shorts-sns-dispatch.mjs';

const NOW = Date.parse('2026-10-26T00:00:00.000Z');

test('no slot and due slots remain immediate; a slot within the composer lead window defers', () => {
  assert.deepEqual(planShortSlot(undefined, NOW), { mode: 'immediate', scheduledFor: null, deferred: false });
  assert.equal(planShortSlot('2026-10-25T23:00:00Z', NOW).mode, 'immediate');
  const near = planShortSlot('2026-10-26T00:05:00Z', NOW);
  assert.equal(near.mode, 'deferred');
  assert.equal(near.scheduledFor, '2026-10-26T00:05:00.000Z');
  assert.equal(planShortSlot('2026-10-26T00:10:00Z', NOW).mode, 'schedule');
});

test('malformed calendar values, no-zone slots, and slots beyond the browser horizon fail closed', () => {
  for (const value of ['not-a-time', '', '2026-02-31T12:00:00Z', '2026-10-29T15:00:00', 1_798_275_600_000]) {
    assert.throws(() => planShortSlot(value, NOW), { code: 'SHORTS_SLOT_AT_INVALID' });
  }
  assert.throws(() => planShortSlot('2027-01-01T00:00:00Z', NOW), { code: 'SHORTS_SLOT_TOO_FAR' });
});

test('scheduled state is positive only when the child confirms the same schedule slot', () => {
  const plan = planShortSlot('2026-10-29T15:07:45+09:00', NOW);
  assert.equal(plan.scheduledFor, '2026-10-29T06:07:00.000Z');
  const intent = snsAttemptRecord('2026-10-26T00:00:01.000Z', plan);
  assert.equal(intent.status, 'attempted');
  assert.equal(intent.ok, false);
  assert.equal(hasUnconfirmedAttempt(intent), true);

  const confirmed = snsOutcomeRecord({ last: { scheduled: true,
    scheduledFor: plan.scheduledFor, line: 'will send at 3:07 PM' } },
  { channel: 'threads', plan, attemptedAt: intent.attemptedAt });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.scheduled, true);
  assert.equal(confirmed.scheduledFor, plan.scheduledFor);
  assert.equal(hasUnconfirmedAttempt(confirmed), false);
});

test('missing or mismatched acknowledgements remain reconciliation-pending and are not called scheduled', () => {
  const plan = planShortSlot('2026-10-29T15:07:00+09:00', NOW);
  const pending = snsOutcomeRecord({ last: { error: 'COMPOSER_STILL_OPEN' } },
    { channel: 'threads', plan, attemptedAt: '2026-10-26T00:00:01.000Z' });
  assert.equal(pending.status, 'needs_reconciliation');
  assert.equal(pending.ok, false);
  assert.equal(Object.hasOwn(pending, 'scheduled'), false);
  assert.equal(Object.hasOwn(pending, 'scheduledFor'), false);
  assert.equal(hasUnconfirmedAttempt(pending), true);

  const wrongTime = snsOutcomeRecord({ last: { scheduled: true,
    scheduledFor: '2026-10-29T15:08:00+09:00', line: 'different minute' } },
  { channel: 'x', plan, attemptedAt: '2026-10-26T00:00:01.000Z' });
  assert.equal(wrongTime.status, 'needs_reconciliation');
  assert.equal(Object.hasOwn(wrongTime, 'scheduled'), false);
});

test('dry execution has a plan but never claims completion or creates a retry-blocking attempt', () => {
  const plan = planShortSlot('2026-10-29T15:07:00+09:00', NOW);
  const result = snsOutcomeRecord({ dry: true }, { channel: 'x', plan, attemptedAt: 'unused' });
  assert.deepEqual(result, { status: 'dry_run', ok: false, dry: true,
    mode: 'schedule', requestedSchedule: plan.scheduledFor });
  assert.equal(hasUnconfirmedAttempt(result), false);
});

test('contradictory success flags stay uncertain, while a definite pre-submit rejection can be retried', () => {
  const plan = planShortSlot('2026-10-29T15:07:00+09:00', NOW);
  for (const extra of [{ needsReconciliation: true }, { outcomeUnknown: true }, { error: 'READBACK_MISSING' }]) {
    const outcome = snsOutcomeRecord({ status: 0, last: { scheduled: true, scheduledFor: plan.scheduledFor, ...extra } },
      { channel: 'x', plan, attemptedAt: '2026-10-26T00:00:01Z' });
    assert.equal(outcome.status, 'needs_reconciliation');
    assert.equal(outcome.ok, false);
  }
  const beforeClick = snsOutcomeRecord({ status: 1, last: { submissionAttempted: false,
    outcomeUnknown: false, needsReconciliation: false, error: 'SCHEDULE_SELECTION_CHANGED' } },
  { channel: 'threads', plan, attemptedAt: '2026-10-26T00:00:01Z' });
  assert.equal(beforeClick.status, 'not_submitted');
  assert.equal(hasUnconfirmedAttempt(beforeClick), false);
});

test('future slots are reclassified using the current time after an earlier social composer runs', () => {
  const slot = '2026-10-26T00:12:00Z';
  assert.equal(planShortSlot(slot, NOW).mode, 'schedule');
  assert.equal(planShortSlot(slot, NOW + 3 * 60_000).mode, 'deferred');
  assert.equal(planShortSlot(slot, NOW + 12 * 60_000).mode, 'immediate');
});

test('immediate success requires an exact own-platform post URL, not a flag or owner substring', () => {
  const plan = planShortSlot(undefined, NOW);
  const context = { channel: 'x', plan, attemptedAt: '2026-10-26T00:00:01Z' };
  assert.equal(snsOutcomeRecord({ status: 0, last: { posted: true } }, context).status, 'needs_reconciliation');
  assert.equal(snsOutcomeRecord({ status: 0, last: { posted: true, account: 'owner',
    url: 'https://x.com/owner/status/12345' } }, context).status, 'posted');
  assert.equal(snsOutcomeRecord({ status: 0, last: { posted: true, account: '@owner',
    url: 'https://evil.invalid/@owner/post/abc' } }, { ...context, channel: 'threads' }).status, 'needs_reconciliation');
  assert.equal(snsOutcomeRecord({ status: 0, last: { posted: true, account: '@owner',
    url: 'https://www.threads.com/@owner/post/abc' } }, { ...context, channel: 'threads' }).status, 'posted');
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISTRIBUTE = path.join(REPO, 'scripts/shorts-distribute.mjs');
async function tempDirectory(t) {
  const root = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch/tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'shorts-sns-dispatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runDistributionDry(directory, { slotAt, existingState = {}, retryThreads = false, dry = true } = {}) {
  const manifestFile = path.join(directory, 'manifest.json');
  const stateFile = path.join(directory, 'manifest.state.json');
  const manifest = { videoDir: directory, thumbDir: directory, videoName: '{id}.mp4',
    common: { footer: '', tags: [], category: 'Education', socialNote: '' },
    shorts: [{ id: 's1', title: 'Synthetic short', desc: 'Dry-run only', question: '', hashtags: '#demo' }] };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const state = { shorts: { s1: { ...existingState, ...(slotAt === undefined ? {} : { slotAt }) } } };
  const originalState = JSON.stringify(state, null, 2) + '\n';
  await writeFile(stateFile, originalState);
  const args = [DISTRIBUTE, manifestFile, '--channels=threads,x', '--only=s1', ...(dry ? ['--dry'] : []),
    ...(retryThreads ? ['--retry-threads'] : [])];
  const result = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, TMPDIR: directory } });
  return { ...result, stateFile, originalState };
}

function parsedLines(stdout) {
  return String(stdout).split(/\r?\n/).flatMap(line => {
    if (!line.startsWith('{')) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

test('distribution dry run passes an eligible slot to both composers and preserves state byte for byte', async t => {
  const directory = await tempDirectory(t);
  const slotAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const run = await runDistributionDry(directory, { slotAt });
  assert.equal(run.status, 0, run.stderr);
  const calls = parsedLines(run.stdout).filter(line => line.dry === 'sns-web-post.mjs');
  assert.deepEqual(calls.map(line => line.args[0]), ['threads', 'x']);
  const scheduledFor = new Date(Math.floor(Date.parse(slotAt) / 60_000) * 60_000).toISOString();
  for (const call of calls) assert.ok(call.args.includes(`--schedule=${scheduledFor}`), JSON.stringify(call));
  assert.equal(await readFile(run.stateFile, 'utf8'), run.originalState);
});

test('a future slot within ten minutes is deferred by dry mode without invoking either composer', async t => {
  const directory = await tempDirectory(t);
  const slotAt = new Date(Date.now() + 5 * 60_000 + 45_000).toISOString();
  const run = await runDistributionDry(directory, { slotAt });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(parsedLines(run.stdout).filter(line => line.dry === 'sns-web-post.mjs'), []);
  assert.equal(parsedLines(run.stdout).filter(line => line.status === 'deferred').length, 2);
  assert.equal(await readFile(run.stateFile, 'utf8'), run.originalState);
});

test('malformed slots fail before any channel helper is dispatched', async t => {
  const directory = await tempDirectory(t);
  const run = await runDistributionDry(directory, { slotAt: 'not-a-date' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /SHORTS_SLOT_AT_INVALID/);
  assert.deepEqual(parsedLines(run.stdout).filter(line => line.dry === 'sns-web-post.mjs'), []);
  assert.equal(await readFile(run.stateFile, 'utf8'), run.originalState);
});

test('uncertain prior Threads attempts are not sent again without explicit reconciliation override', async t => {
  const directory = await tempDirectory(t);
  const run = await runDistributionDry(directory, { slotAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    existingState: { threads: { ok: false, status: 'needs_reconciliation', attemptedAt: '2026-10-26T00:00:00.000Z',
      requestedSchedule: '2026-10-26T02:00:00.000Z' } } });
  assert.equal(run.status, 0, run.stderr);
  const lines = parsedLines(run.stdout);
  assert.equal(lines.some(line => line.dry === 'sns-web-post.mjs' && line.args[0] === 'threads'), false, JSON.stringify(lines));
  assert.equal(lines.some(line => line.skipped?.includes('inspect Threads')), true);
  assert.equal(lines.some(line => line.dry === 'sns-web-post.mjs' && line.args[0] === 'x'), true);
  assert.equal(await readFile(run.stateFile, 'utf8'), run.originalState);
});
