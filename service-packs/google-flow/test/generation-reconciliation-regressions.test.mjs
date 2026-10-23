import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FlowClient } from '../src/client.mjs';
import { acquireGenerationFence, createGenerationIntent, createJournal, loadJournal, releaseGenerationFence, updateJournal } from '../src/journal.mjs';
import { hashGenerationPrompt } from '../src/generation-input.mjs';
import { findProjectMediaByClientIds, findProjectMediaByGenerationRequest, RPC } from '../src/protocol.mjs';

const PROJECT = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_PROJECT = '223e4567-e89b-42d3-a456-426614174000';
const PROMPT = 'A red paper boat on a calm pond.';
const MEDIA = '323e4567-e89b-42d3-a456-426614174000';
const REQUEST_ID = '423e4567-e89b-42d3-a456-426614174000';
const CLIENT_IDS = [
  '523e4567-e89b-42d3-a456-426614174000',
  '623e4567-e89b-42d3-a456-426614174000',
];
const VIDEO_URL = `https://flow-content.google/video/${MEDIA}?signature=synthetic-only`;
const MP4 = Buffer.from('000000186674797069736f6d', 'hex');
async function workspace(t) {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = await mkdtemp(path.join(tmpRoot, 'flow-generation-regression-'));
  assert.ok(path.resolve(dir).toLowerCase().startsWith((tmpRoot + path.sep).toLowerCase()));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, jobDir: path.join(dir, 'jobs'), outputPath: path.join(dir, 'video.mp4') };
}
async function intent(w, overrides = {}) {
  return createJournal({ projectId: PROJECT, promptHash: hashGenerationPrompt(PROMPT),
    clientIds: ['123e4567-e89b-42d3-a456-426614174001', '123e4567-e89b-42d3-a456-426614174002'],
    aspect: '16:9', duration: 8, resolution: '720p', outputPath: w.outputPath, ...overrides,
  }, { jobDir: w.jobDir });
}
function fakeClient(w, { projectPayload = [null, [], []] } = {}) {
  const writes = [];
  const reads = [];
  const client = new FlowClient({ jobDir: w.jobDir, transport: {
    getContext: () => ({ projectId: PROJECT }),
    rpc: async (rpcId) => {
      reads.push(rpcId);
      if (rpcId === RPC.projectMedia) return { payload: projectPayload };
      if (rpcId === RPC.pollGeneration) {
        const details = [];
        details[8] = [3];
        details[13] = 4_385_072;
        const record = [];
        record[0] = MEDIA;
        record[5] = details;
        return { payload: [null, 900, [record]] };
      }
      if (rpcId === RPC.getMedia) return { payload: [VIDEO_URL] };
      throw new Error('Unexpected synthetic read RPC.');
    },
    createVideo: async (...args) => { writes.push(args); throw new Error('Synthetic unexpected create'); },
  }, fetchImpl: async () => new Response(MP4, {
    status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) },
  }) });
  return { client, writes, reads };
}

function sceneListing({ projectId = PROJECT, mediaId = MEDIA, requestId = REQUEST_ID } = {}) {
  const scene = [
    '723e4567-e89b-42d3-a456-426614174000', null, null,
    [null, null, null, null, mediaId, requestId],
    projectId,
  ];
  return [null, [scene], [[mediaId]]];
}

test('an uppercase project UUID cannot bypass an orphan generation intent', async t => {
  const w = await workspace(t);
  const job = await intent(w);
  const { client, writes } = fakeClient(w);
  await assert.rejects(client.generateVideo({ prompt: PROMPT, outputPath: w.outputPath,
    projectId: PROJECT.toUpperCase(), duration: 8, resolution: '720p',
  }), error => error.code === 'FLOW_GENERATION_UNRESOLVED');
  assert.equal(writes.length, 0);
  assert.equal((await loadJournal(job.jobPath)).state, 'intent_logged');
});

test('an old journal without requestId cannot reconcile by client IDs or an unrelated local MP4', async t => {
  const w = await workspace(t);
  let job = await intent(w);
  assert.equal((await acquireGenerationFence(job)).acquired, true);
  job = await updateJournal(job, { state: 'needs_reconciliation' });
  const unrelated = Buffer.alloc(24);
  unrelated.write('ftyp', 4, 'ascii');
  await writeFile(w.outputPath, unrelated);
  const { client, writes, reads } = fakeClient(w, { projectPayload: sceneListing() });
  await assert.rejects(client.reconcileJob(job.jobPath), error => error.ambiguous === true);
  assert.ok(reads.includes('Zzl0ze'));
  assert.equal(writes.length, 0);
  assert.equal((await loadJournal(job.jobPath)).state, 'needs_reconciliation');
  await assert.rejects(client.generateVideo({ prompt: PROMPT, outputPath: path.join(w.dir, 'retry.mp4') }), error =>
    error.code === 'FLOW_GENERATION_UNRESOLVED');
  assert.equal(writes.length, 0, 'a request without matching persisted requestId must not be resubmitted');
  const other = await intent(w, { promptHash: hashGenerationPrompt(PROMPT + ' different'),
    outputPath: path.join(w.dir, 'second.mp4') });
  assert.equal((await acquireGenerationFence(other)).acquired, false);
  assert.deepEqual(await readFile(w.outputPath), unrelated);
});

test('a previous job cannot release the current project fence owned by another job', async t => {
  const w = await workspace(t);
  const previous = await intent(w);
  const next = await intent(w, { promptHash: hashGenerationPrompt(PROMPT + ' next'),
    outputPath: path.join(w.dir, 'next.mp4') });
  assert.equal((await acquireGenerationFence(previous)).acquired, true);
  assert.equal(await releaseGenerationFence(previous), true);
  assert.equal((await acquireGenerationFence(next)).acquired, true);
  await Promise.all([releaseGenerationFence(previous), releaseGenerationFence(previous)]);
  const contender = await intent(w, { promptHash: hashGenerationPrompt(PROMPT + ' contender'),
    outputPath: path.join(w.dir, 'contender.mp4') });
  assert.equal((await acquireGenerationFence(contender)).acquired, false);
});

test('generation reconciliation matches the persisted server request id in the active-project scene', async t => {
  const w = await workspace(t);
  const intentResult = await createGenerationIntent({
    projectId: PROJECT,
    promptHash: hashGenerationPrompt(PROMPT),
    clientIds: CLIENT_IDS,
    requestId: REQUEST_ID,
    aspect: '16:9',
    duration: 8,
    resolution: '720p',
    outputPath: w.outputPath,
  }, { jobDir: w.jobDir });
  assert.ok(intentResult.job);
  const job = await updateJournal(intentResult.job, { state: 'needs_reconciliation' });
  const projectPayload = sceneListing();

  assert.deepEqual(findProjectMediaByGenerationRequest(projectPayload, PROJECT, REQUEST_ID), { mediaId: MEDIA });
  assert.equal(findProjectMediaByGenerationRequest(projectPayload, OTHER_PROJECT, REQUEST_ID), undefined,
    'the same request id must not cross the active-project boundary');
  assert.equal(findProjectMediaByGenerationRequest(projectPayload, PROJECT, OTHER_PROJECT), undefined,
    'a different request id must not match this scene');
  assert.equal(findProjectMediaByGenerationRequest(projectPayload, PROJECT, undefined), undefined,
    'legacy client IDs are not an observed project-scene correlation contract');
  assert.equal(findProjectMediaByClientIds(projectPayload, PROJECT, CLIENT_IDS), undefined,
    'the deprecated client-ID-only helper must fail closed');

  const { client, writes, reads } = fakeClient(w, { projectPayload });
  const result = await client.reconcileJob(job.jobPath);
  const reconciled = await loadJournal(job.jobPath);

  assert.equal(result.bytes, MP4.length);
  assert.equal(reconciled.state, 'downloaded');
  assert.equal(reconciled.mediaId, MEDIA);
  assert.equal(reconciled.requestId, REQUEST_ID);
  assert.deepEqual(reconciled.clientIds, CLIENT_IDS);
  assert.deepEqual(reads, [RPC.projectMedia, RPC.pollGeneration, RPC.getMedia]);
  assert.equal(writes.length, 0, 'reconciliation and download must not resubmit generation');
});
