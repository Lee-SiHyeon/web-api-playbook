import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FlowClient } from '../src/client.mjs';
import { createDownloadJournal, loadJournal } from '../src/journal.mjs';
import { RPC } from '../src/protocol.mjs';

const ACTIVE_PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEDIA_IN_PROJECT = '11111111-1111-4111-8111-111111111111';
const MEDIA_OUT_OF_PROJECT = '22222222-2222-4222-8222-222222222222';

function makeClient({ projectId = ACTIVE_PROJECT, responses = {} } = {}) {
  const calls = [];
  const transport = {
    async start() {},
    getContext() {
      return { projectId, documentCheckedAt: 'synthetic-test-time' };
    },
    async rpc(rpcId) {
      calls.push(rpcId);
      const configured = responses[rpcId];
      const payload = typeof configured === 'function' ? configured()
        : configured ?? (rpcId === RPC.pollGeneration ? completedGeneration() : undefined);
      return { payload, evidence: { browserUsed: false } };
    },
  };
  return { client: new FlowClient({ transport }), calls };
}

function projectListing(mediaIds = [MEDIA_IN_PROJECT]) {
  return [null, [], mediaIds.map(mediaId => [mediaId])];
}

function completedGeneration(mediaId = MEDIA_IN_PROJECT) {
  const details = [];
  details[8] = [3];
  details[13] = 4_385_072;
  const record = [];
  record[0] = mediaId;
  record[5] = details;
  return [null, 900, [record]];
}

async function withTempDir(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flow-client-reliability-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a different project is rejected before any RPC', async () => {
  const { client, calls } = makeClient();

  await assert.rejects(client.getProjectMedia(OTHER_PROJECT), /targets another project/);
  assert.deepEqual(calls, []);
});

test('getMedia and getGenerationState reject media outside the active project before that RPC', async () => {
  for (const operation of ['getMedia', 'getGenerationState']) {
    const { client, calls } = makeClient({
      responses: { [RPC.projectMedia]: projectListing() },
    });

    await assert.rejects(client[operation](MEDIA_OUT_OF_PROJECT), error =>
      error.code === 'FLOW_MEDIA_OUT_OF_SCOPE' && error.rpcId === RPC.projectMedia);
    assert.deepEqual(calls, [RPC.projectMedia]);
  }
});

test('a malformed project listing errors instead of appearing as an empty project', async () => {
  const { client, calls } = makeClient({
    responses: { [RPC.projectMedia]: [null, [], null] },
  });

  await assert.rejects(client.listMediaIds(), error =>
    error.code === 'FLOW_PROJECT_SCHEMA_CHANGED' && error.rpcId === RPC.projectMedia);
  assert.deepEqual(calls, [RPC.projectMedia]);
});

test('waitForVideo rejects a signed URL whose media id differs from the requested media', async () => {
  const otherMediaUrl = `https://flow-content.google/video/${MEDIA_OUT_OF_PROJECT}?signature=synthetic-only`;
  const { client, calls } = makeClient({
    responses: {
      [RPC.projectMedia]: projectListing([MEDIA_IN_PROJECT]),
      [RPC.getMedia]: [otherMediaUrl],
    },
  });

  await assert.rejects(client.waitForVideo(MEDIA_IN_PROJECT), error =>
    error.code === 'FLOW_MEDIA_RESPONSE_MISMATCH' && error.rpcId === RPC.getMedia);
  assert.deepEqual(calls, [RPC.projectMedia, RPC.pollGeneration, RPC.getMedia]);
});

test('waitForVideo returns a signed URL for the requested media id', async () => {
  const expectedMediaUrl = `https://flow-content.google/video/${MEDIA_IN_PROJECT}?signature=synthetic-only`;
  const { client, calls } = makeClient({
    responses: {
      [RPC.projectMedia]: projectListing([MEDIA_IN_PROJECT]),
      [RPC.getMedia]: [expectedMediaUrl],
    },
  });

  const result = await client.waitForVideo(MEDIA_IN_PROJECT);

  assert.equal(result.href, expectedMediaUrl);
  assert.deepEqual(calls, [RPC.projectMedia, RPC.pollGeneration, RPC.getMedia]);
});

test('download failure journals only safe error metadata', async () => withTempDir(async directory => {
  const outputPath = path.join(directory, 'result.mp4');
  const job = await createDownloadJournal({
    projectId: ACTIVE_PROJECT,
    mediaId: MEDIA_IN_PROJECT,
    outputPath,
  }, { jobDir: path.join(directory, 'jobs') });
  const { client } = makeClient();
  const signedUrl = 'https://flow-content.google/video/synthetic?signature=synthetic-only';
  const cause = Object.assign(new Error(`private download detail ${signedUrl}`), {
    code: 'FLOW_DOWNLOAD_HTTP_ERROR',
    httpStatus: 503,
    rpcId: RPC.getMedia,
  });
  client.waitForVideo = async () => { throw cause; };

  await assert.rejects(client.finishJob(job), error =>
    error.code === 'FLOW_DOWNLOAD_HTTP_ERROR'
      && error.httpStatus === 503
      && error.rpcId === RPC.getMedia);

  const rawJournal = await readFile(job.jobPath, 'utf8');
  const persisted = await loadJournal(job.jobPath);
  assert.deepEqual(Object.keys(persisted.lastError).sort(), ['at', 'code', 'httpStatus', 'rpcId']);
  assert.equal(persisted.lastError.code, 'FLOW_DOWNLOAD_HTTP_ERROR');
  assert.equal(persisted.lastError.httpStatus, 503);
  assert.equal(persisted.lastError.rpcId, RPC.getMedia);
  assert.doesNotMatch(rawJournal, /private download detail|flow-content\.google|signature=synthetic-only/);
}));

test('reconcile accepts an already completed valid MP4 without media RPCs', async () => withTempDir(async directory => {
  const outputPath = path.join(directory, 'completed.mp4');
  const bytes = Buffer.from('000000186674797069736f6d', 'hex');
  await writeFile(outputPath, bytes);
  const job = await createDownloadJournal({
    projectId: ACTIVE_PROJECT,
    mediaId: MEDIA_IN_PROJECT,
    outputPath,
  }, { jobDir: path.join(directory, 'jobs') });
  const { client, calls } = makeClient();

  const result = await client.reconcileJob(job);

  assert.equal(result.bytes, bytes.length);
  assert.equal((await loadJournal(job.jobPath)).state, 'downloaded');
  assert.deepEqual(calls, []);
}));
