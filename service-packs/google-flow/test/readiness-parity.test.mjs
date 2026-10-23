import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FlowClient } from '../src/client.mjs';
import { findUnresolvedJournal, loadJournal } from '../src/journal.mjs';
import { RPC } from '../src/protocol.mjs';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MEDIA_ID = '22222222-2222-4222-8222-222222222222';
const URL = `https://flow-content.google/video/${MEDIA_ID}?signature=synthetic-only`;
const MP4 = Buffer.from('000000186674797069736f6d', 'hex');

function statePayload(mediaId, observedStateCode, videoBytes) {
  const details = [];
  details[8] = [observedStateCode];
  details[13] = videoBytes;
  const record = [];
  record[0] = mediaId;
  record[5] = details;
  return [null, 900, [record]];
}

function provider() {
  return {
    mode: 'pure_http',
    issuerOrigin: 'https://www.google.com',
    async acquire(request) {
      const now = Date.now();
      return {
        mode: 'pure_http', issuerOrigin: request.issuerOrigin, action: request.action,
        token: `synthetic-${randomUUID()}`, issuedAt: now, expiresAt: now + 110_000,
        oneTime: true, binding: request.binding,
      };
    },
  };
}

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flow-readiness-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function makeTransport({ states = [3], projectMedia = [MEDIA_ID], getMedia = [URL] } = {}) {
  const calls = [];
  let stateIndex = 0;
  const transport = {
    getContext: () => ({ projectId: PROJECT_ID, documentCheckedAt: 'synthetic' }),
    async start() {},
    async createVideo() { calls.push(RPC.generateTextVideo); return { payload: [null, null, null, [[MEDIA_ID]]] }; },
    async rpc(rpcId) {
      calls.push(rpcId);
      if (rpcId === RPC.projectMedia) return { payload: [null, [], projectMedia.map(id => [id])] };
      if (rpcId === RPC.pollGeneration) {
        const entry = states[Math.min(stateIndex, states.length - 1)];
        stateIndex += 1;
        if (entry?.raw !== undefined) return { payload: entry.raw };
        return { payload: statePayload(entry?.mediaId ?? MEDIA_ID, entry?.code ?? 3,
          entry?.bytes === undefined ? 4_385_072 : entry.bytes) };
      }
      if (rpcId === RPC.getMedia) return { payload: getMedia };
      throw new Error('Unexpected synthetic RPC.');
    },
  };
  return { transport, calls };
}

function makeClient({ transport, directory, clock, sleep, generationTimeoutMs, generationPollIntervalMs } = {}) {
  return new FlowClient({
    transport,
    fetchImpl: async () => new Response(MP4, { status: 200, headers: {
      'content-type': 'video/mp4', 'content-length': String(MP4.length),
    } }),
    generationInputProvider: provider(),
    clock,
    sleep,
    generationTimeoutMs,
    generationPollIntervalMs,
    jobDir: directory ? path.join(directory, 'jobs') : undefined,
  });
}

test('completion follows SDK state observations 6, 2, 3 before requesting download readiness', async t => {
  const directory = await tempDirectory(t);
  const { transport, calls } = makeTransport({
    states: [{ code: 6, bytes: null }, { code: 2, bytes: null }, { code: 3, bytes: 4_385_072 }],
  });
  const client = makeClient({ transport, directory });
  const observations = [];

  const videoUrl = await client.waitForVideo(MEDIA_ID, {
    timeoutMs: 10_000,
    pollIntervalMs: 0,
    onObservation: observation => observations.push(observation),
  });

  assert.equal(videoUrl.href, URL);
  assert.deepEqual(calls, [RPC.projectMedia, RPC.pollGeneration, RPC.pollGeneration,
    RPC.pollGeneration, RPC.getMedia]);
  assert.deepEqual(observations.map(item => item.observedStateCode), [6, 2, 3, 3]);
  assert.deepEqual(observations.map(item => item.phase), [
    'generation_state', 'generation_state', 'generation_state', 'download_ready',
  ]);
  assert.ok(observations.every(item => item.mediaId === MEDIA_ID && !JSON.stringify(item).includes('signature=')));
});

test('a signed URL returned while generation is pending is ignored', async t => {
  const directory = await tempDirectory(t);
  const { transport, calls } = makeTransport({
    states: [{ code: 6, bytes: null }],
    getMedia: [URL],
  });
  let now = Date.now();
  const client = makeClient({
    transport, directory,
    clock: () => now,
    sleep: async milliseconds => { now += Math.max(1, milliseconds); },
    generationTimeoutMs: 3,
    generationPollIntervalMs: 1,
  });

  await assert.rejects(client.waitForVideo(MEDIA_ID), error => error.code === 'FLOW_VIDEO_NOT_READY');
  assert.deepEqual(calls, [RPC.projectMedia, RPC.pollGeneration, RPC.pollGeneration, RPC.pollGeneration]);
  assert.equal(calls.includes(RPC.getMedia), false);
});

test('poll response without the requested media record fails closed before download lookup', async t => {
  const directory = await tempDirectory(t);
  const { transport, calls } = makeTransport({
    states: [{ mediaId: OTHER_MEDIA_ID, code: 3, bytes: 4_385_072 }],
  });
  const client = makeClient({ transport, directory });

  await assert.rejects(client.waitForVideo(MEDIA_ID), error =>
    error.code === undefined && error.rpcId === RPC.pollGeneration && /requested media id/.test(error.message));
  assert.deepEqual(calls, [RPC.projectMedia, RPC.pollGeneration]);
});

test('readiness timeout journals the last safe phase and keeps the project fence without a second create', async t => {
  const directory = await tempDirectory(t);
  const { transport, calls } = makeTransport({ states: [{ code: 6, bytes: 4_385_072 }], getMedia: [URL] });
  let now = Date.now();
  const client = makeClient({
    transport, directory,
    clock: () => now,
    sleep: async milliseconds => { now += Math.max(1, milliseconds); },
    generationTimeoutMs: 3,
    generationPollIntervalMs: 1,
  });
  const outputPath = path.join(directory, 'out.mp4');

  await assert.rejects(client.generateVideo({
    prompt: 'a small paper boat on a pond', outputPath, duration: 8, resolution: '720p', aspect: '16:9',
  }), error => error.code === 'FLOW_VIDEO_NOT_READY');

  const names = await readdir(path.join(directory, 'jobs'));
  const journalName = names.find(name => name.endsWith('.json'));
  assert.ok(journalName);
  const job = await loadJournal(path.join(directory, 'jobs', journalName));
  const raw = await readFile(job.jobPath, 'utf8');
  assert.equal(job.state, 'needs_download');
  assert.equal(job.mediaId, MEDIA_ID);
  assert.deepEqual(job.lastGenerationObservation, {
    phase: 'generation_state',
    mediaId: MEDIA_ID,
    observedStateCode: 6,
    videoBytes: 4_385_072,
    at: job.lastGenerationObservation.at,
  });
  assert.equal(await findUnresolvedJournal(PROJECT_ID, undefined, { jobDir: path.join(directory, 'jobs') }).then(Boolean), true);
  assert.equal(names.some(name => name.endsWith('.lock')), true);
  assert.doesNotMatch(raw, /signature=synthetic-only|a small paper boat/);
  assert.equal(calls.filter(call => call === RPC.generateTextVideo).length, 1);
  assert.equal(calls.includes(RPC.getMedia), false);

  await assert.rejects(client.generateVideo({
    prompt: 'a second request must stay blocked', outputPath: path.join(directory, 'second.mp4'),
  }), error => error.code === 'FLOW_GENERATION_UNRESOLVED');
  assert.equal(calls.filter(call => call === RPC.generateTextVideo).length, 1);
});
