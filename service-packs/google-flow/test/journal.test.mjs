import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDownloadJournal, createGenerationIntent, createJournal, findUnresolvedJournal, loadJournal, updateJournal } from '../src/journal.mjs';

const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174000';
const MEDIA_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const KNOWN_STATES = ['intent_logged', 'accepted', 'needs_download', 'downloaded', 'rejected', 'preflight_failed'];

async function tempDirectory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flow-journal-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('createDownloadJournal persists an existing-media download job in its isolated directory', async (t) => {
  const jobDir = await tempDirectory(t);
  const outputPath = path.join(jobDir, 'video.mp4');
  const job = await createDownloadJournal({ projectId: PROJECT_ID, mediaId: MEDIA_ID, outputPath }, { jobDir });

  assert.equal(job.version, 1);
  assert.equal(job.operation, 'download_existing');
  assert.equal(job.state, 'needs_download');
  assert.equal(job.projectId, PROJECT_ID);
  assert.equal(job.mediaId, MEDIA_ID);
  assert.deepEqual(job.clientIds, []);
  assert.equal(job.outputPath, path.resolve(outputPath));
  assert.equal(path.dirname(job.jobPath), path.resolve(jobDir));

  const persisted = JSON.parse(await readFile(job.jobPath, 'utf8'));
  assert.equal(Object.hasOwn(persisted, 'jobPath'), false);
  assert.deepEqual(Object.keys(persisted).sort(), [
    'clientIds', 'createdAt', 'jobId', 'mediaId', 'operation', 'outputPath', 'projectId', 'state', 'updatedAt', 'version',
  ]);
  assert.equal((await readdir(jobDir)).length, 1);
});

test('download journal can be updated and loaded with its operation intact', async (t) => {
  const jobDir = await tempDirectory(t);
  const job = await createDownloadJournal({ projectId: PROJECT_ID, mediaId: MEDIA_ID, outputPath: 'video.mp4' }, { jobDir });
  const updated = await updateJournal(job, { state: 'downloaded', bytes: 4096 });
  const loaded = await loadJournal(job.jobPath);

  assert.equal(updated.state, 'downloaded');
  assert.equal(loaded.operation, 'download_existing');
  assert.equal(loaded.mediaId, MEDIA_ID);
  assert.equal(loaded.bytes, 4096);
  assert.equal(loaded.jobPath, path.resolve(job.jobPath));
});

test('createDownloadJournal rejects malformed IDs and empty output paths before writing', async (t) => {
  const jobDir = await tempDirectory(t);
  const invalidInputs = [
    { projectId: 'bad-id', mediaId: MEDIA_ID, outputPath: 'video.mp4' },
    { projectId: PROJECT_ID, mediaId: 'bad-id', outputPath: 'video.mp4' },
    { projectId: PROJECT_ID, mediaId: MEDIA_ID, outputPath: ' \t ' },
    { projectId: PROJECT_ID, mediaId: MEDIA_ID, outputPath: '\0video.mp4' },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(createDownloadJournal(input, { jobDir }), /Invalid Flow download journal input/);
  }
  assert.deepEqual(await readdir(jobDir), []);
});

test('loadJournal accepts legacy generation journals and all known states', async (t) => {
  const jobDir = await tempDirectory(t);
  for (const state of KNOWN_STATES) {
    const jobPath = path.join(jobDir, `${state}.json`);
    await writeFile(jobPath, JSON.stringify({
      version: 1,
      jobId: `legacy-${state}`,
      state,
      projectId: PROJECT_ID,
      promptHash: 'synthetic-hash',
      clientIds: ['synthetic-client-id'],
      outputPath: path.join(jobDir, 'generated.mp4'),
    }));

    const loaded = await loadJournal(jobPath);
    assert.equal(loaded.operation, undefined);
    assert.equal(loaded.state, state);
  }
});

test('loadJournal rejects malformed identifiers, client IDs, operations, and unknown states', async (t) => {
  const jobDir = await tempDirectory(t);
  const valid = {
    version: 1,
    jobId: 'synthetic-job',
    state: 'needs_download',
    projectId: PROJECT_ID,
    mediaId: MEDIA_ID,
    clientIds: [],
    outputPath: path.join(jobDir, 'video.mp4'),
    operation: 'download_existing',
  };
  const invalidJobs = [
    { ...valid, projectId: 'bad-id' },
    { ...valid, mediaId: 'bad-id' },
    { ...valid, requestId: 'bad-id' },
    { ...valid, clientIds: ['ok', 7] },
    { ...valid, operation: 'unexpected' },
    { ...valid, state: 'mystery' },
    { ...valid, inputMode: 'unknown-input-mode' },
    null,
  ];

  for (const [index, job] of invalidJobs.entries()) {
    const jobPath = path.join(jobDir, `invalid-${index}.json`);
    await writeFile(jobPath, JSON.stringify(job));
    await assert.rejects(loadJournal(jobPath), /Invalid Flow job journal/);
  }
});

test('completed SDK diagnostic journals remain readable without blocking subsequent journal scans', async t => {
  const jobDir = await tempDirectory(t);
  const job = await createJournal({
    projectId: PROJECT_ID, promptHash: 'synthetic-hash', clientIds: ['synthetic-client'],
    outputPath: path.join(jobDir, 'diagnostic.mp4'), inputMode: 'browser_sdk_diagnostic',
  }, { jobDir });
  await updateJournal(job, { state: 'downloaded', mediaId: MEDIA_ID, executionMode: 'captured_browser_request_over_node_http_diagnostic' });
  const loaded = await loadJournal(job.jobPath);
  assert.equal(loaded.inputMode, 'browser_sdk_diagnostic');
  assert.equal(loaded.state, 'downloaded');
  assert.equal(await findUnresolvedJournal(PROJECT_ID, undefined, { jobDir }), undefined);
  const next = await createGenerationIntent({
    projectId: PROJECT_ID, promptHash: 'next-hash', clientIds: [],
    outputPath: path.join(jobDir, 'next.mp4'), inputMode: 'verified_pure_http',
  }, { jobDir });
  assert.ok(next.job, 'finished diagnostic provenance must not corrupt the next intent scan');
});

test('uncertain SDK diagnostic journals still block another create intent', async t => {
  const jobDir = await tempDirectory(t);
  const job = await createJournal({
    projectId: PROJECT_ID, promptHash: 'synthetic-hash', clientIds: [],
    outputPath: path.join(jobDir, 'diagnostic.mp4'), inputMode: 'browser_sdk_diagnostic',
  }, { jobDir });
  await updateJournal(job, { state: 'needs_reconciliation' });
  const unresolved = await findUnresolvedJournal(PROJECT_ID, undefined, { jobDir });
  assert.equal(unresolved.jobId, job.jobId);
  const next = await createGenerationIntent({
    projectId: PROJECT_ID, promptHash: 'different-hash', clientIds: [],
    outputPath: path.join(jobDir, 'next.mp4'), inputMode: 'verified_pure_http',
  }, { jobDir });
  assert.equal(next.job, undefined);
  assert.equal(next.unresolved.jobId, job.jobId);
});

test('unknown generation input modes fail before creating an intent or fence', async t => {
  const jobDir = await tempDirectory(t);
  await assert.rejects(createGenerationIntent({
    projectId: PROJECT_ID, promptHash: 'synthetic-hash', clientIds: [],
    outputPath: path.join(jobDir, 'invalid.mp4'), inputMode: 'unknown-input-mode',
  }, { jobDir }), /Invalid Flow generation input mode/);
  assert.deepEqual(await readdir(jobDir), []);
});
