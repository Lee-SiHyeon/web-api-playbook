import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  reconcileBrowserAssistedUpload,
  runBrowserAssistedUpload,
} from '../scripts/sns/video-upload/core.mjs';
import * as youtube from '../scripts/sns/video-upload/youtube.mjs';
import * as instagram from '../scripts/sns/video-upload/instagram.mjs';
import * as naverClip from '../scripts/sns/video-upload/naver-clip.mjs';

const OWNER = 'UCtLdZc1Ooz6KLbDNfo60E5A';
const BASE_INPUT = Object.freeze({
  title: '업로드 테스트', description: '오프라인 fixture', tags: ['test'], aiLabel: true,
});
const PHASES = ['upload_session', 'private_video_create'];

async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-upload-'));
  const file = path.join(directory, 'asset.mp4');
  await writeFile(file, Buffer.from('offline-video-fixture'));
  return { directory, file, journalDir: path.join(directory, 'journal'), input: { ...BASE_INPUT, file } };
}

async function cleanup(directory) {
  await rm(directory, { recursive: true, force: true });
}

function validReadback(postId, overrides = {}) {
  return { ownerVerified: true, ownerId: OWNER, postId, visibility: 'private', aiLabel: true,
    title: BASE_INPUT.title, description: BASE_INPUT.description, tags: [...BASE_INPUT.tags],
    url: `https://www.youtube.com/shorts/${postId}`, ...overrides };
}

async function simpleBrowserUpload({ onBeforeCreate, onCreated }) {
  for (const phase of PHASES) {
    await onBeforeCreate(phase);
    await onCreated(phase);
  }
  return { postId: 'short_123456', url: 'https://www.youtube.com/shorts/short_123456' };
}

test('journals every planned create before callback work and accepts only private owner readback', async () => {
  const h = await harness();
  try {
    const result = await runBrowserAssistedUpload({
      platform: 'youtube', input: h.input, expectedOwner: OWNER, journalDir: h.journalDir,
      phasePlan: PHASES, contractVerified: true,
      browserUpload: async context => {
        assert.equal(context.visibility, 'private');
        assert.equal(context.expectedOwner, OWNER);
        for (const phase of PHASES) {
          await context.onBeforeCreate(phase);
          const files = (await readdir(h.journalDir)).filter(name => name.endsWith('.jsonl'));
          assert.equal(files.length, 1);
          const rows = (await readFile(path.join(h.journalDir, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
          assert.equal(rows.at(-1).type, 'create_intent');
          assert.equal(rows.at(-1).phaseIndex, PHASES.indexOf(phase));
          await context.onCreated(phase);
        }
        return { postId: 'short_123456', url: 'https://www.youtube.com/shorts/short_123456' };
      },
      readback: async ({ postId }) => validReadback(postId),
    });
    assert.deepEqual(result, { platform: 'youtube', postId: 'short_123456',
      url: 'https://www.youtube.com/shorts/short_123456', visibility: 'private' });

    let resent = false;
    const duplicate = await runBrowserAssistedUpload({
      platform: 'youtube', input: h.input, expectedOwner: OWNER, journalDir: h.journalDir,
      phasePlan: PHASES, contractVerified: true,
      browserUpload: async () => { resent = true; throw new Error('must not run'); },
      readback: async () => { throw new Error('must not run'); },
    });
    assert.deepEqual(duplicate, result);
    assert.equal(resent, false);

    const journal = (await readFile(path.join(h.journalDir, (await readdir(h.journalDir)).find(n => n.endsWith('.jsonl'))), 'utf8'));
    assert.match(journal, /"type":"readback_verified"/);
    assert.doesNotMatch(journal, /업로드 테스트|offline-video-fixture/);
  } finally { await cleanup(h.directory); }
});

test('private is the default and public visibility is rejected before any callback', async () => {
  const h = await harness();
  try {
    let calls = 0;
    await assert.rejects(runBrowserAssistedUpload({
      platform: 'youtube', input: { ...h.input, visibility: 'public' }, expectedOwner: OWNER,
      journalDir: h.journalDir, phasePlan: PHASES, contractVerified: true,
      browserUpload: async () => { calls += 1; }, readback: async () => ({}),
    }), error => error.code === 'VIDEO_UPLOAD_PUBLIC_VISIBILITY_FORBIDDEN');
    await assert.rejects(runBrowserAssistedUpload({
      platform: 'youtube', input: { file: h.file, title: 'test' }, expectedOwner: OWNER,
      journalDir: h.journalDir, phasePlan: PHASES, contractVerified: true,
      browserUpload: async () => { calls += 1; }, readback: async () => ({}),
    }), error => error.code === 'VIDEO_UPLOAD_AI_LABEL_REQUIRED');
    assert.equal(calls, 0);
  } finally { await cleanup(h.directory); }
});

test('only-me and draft stay nonpublic and must match the verified readback', async () => {
  const h = await harness();
  try {
    for (const [requested, normalized] of [['only-me', 'only_me'], ['draft', 'draft']]) {
      const result = await runBrowserAssistedUpload({
        platform: 'youtube', input: { ...h.input, visibility: requested }, expectedOwner: OWNER,
        operationId: `visibility-${normalized}`, journalDir: h.journalDir,
        phasePlan: ['private_video_create'], contractVerified: true,
        browserUpload: async context => {
          assert.equal(context.visibility, normalized);
          await context.onBeforeCreate('private_video_create');
          await context.onCreated('private_video_create');
          return { postId: normalized === 'draft' ? 'short_131313' : 'short_141414' };
        },
        readback: async ({ postId }) => validReadback(postId, { visibility: normalized }),
      });
      assert.equal(result.visibility, normalized);
    }
  } finally { await cleanup(h.directory); }
});

test('an uncertain write is secret-safe and never automatically retried', async () => {
  const h = await harness();
  try {
    let calls = 0;
    const options = {
      platform: 'instagram', input: h.input, expectedOwner: 'lifehack__ailab',
      operationId: 'uncertain-case', journalDir: h.journalDir, phasePlan: ['video_session'],
      contractVerified: true,
      browserUpload: async ({ onBeforeCreate }) => {
        calls += 1;
        await onBeforeCreate('video_session');
        throw new Error('Authorization: PRIVATE_SECRET_VALUE');
      },
      readback: async () => ({}),
    };
    await assert.rejects(runBrowserAssistedUpload(options), error => error.code === 'VIDEO_UPLOAD_OUTCOME_UNCERTAIN');
    await assert.rejects(runBrowserAssistedUpload(options), error => error.code === 'VIDEO_UPLOAD_RECONCILIATION_REQUIRED');
    assert.equal(calls, 1);
    const file = path.join(h.journalDir, `${(await readdir(h.journalDir)).find(name => name.endsWith('.jsonl')).slice(0, -6)}.jsonl`);
    const journal = await readFile(file, 'utf8');
    assert.match(journal, /"type":"create_uncertain"/);
    assert.doesNotMatch(journal, /PRIVATE_SECRET_VALUE|Authorization|업로드 테스트|asset\.mp4|video_session/);
  } finally { await cleanup(h.directory); }
});

test('a failed create-intent append latches even when the browser callback swallows it', async () => {
  const h = await harness();
  try {
    const operationId = 'journal-write-failure';
    const key = createHash('sha256').update(`youtube\0${operationId}`).digest('hex');
    const journalFile = path.join(h.journalDir, `${key}.jsonl`);
    let uploadCalls = 0;
    let createdHookCode = null;
    const shared = {
      platform: 'youtube', input: h.input, expectedOwner: OWNER, operationId,
      journalDir: h.journalDir, phasePlan: ['private_video_create'], contractVerified: true,
    };
    await assert.rejects(runBrowserAssistedUpload({
      ...shared,
      browserUpload: async context => {
        const priorJournal = await readFile(journalFile, 'utf8');
        await rm(journalFile);
        await mkdir(journalFile);
        try {
          await context.onBeforeCreate('private_video_create');
          uploadCalls += 1;
        } catch (error) {
          assert.equal(error.code, 'VIDEO_UPLOAD_JOURNAL_WRITE_FAILED');
        }
        try { await context.onCreated('private_video_create'); }
        catch (error) { createdHookCode = error.code; }
        await rm(journalFile, { recursive: true, force: true });
        await writeFile(journalFile, priorJournal, 'utf8');
        return { postId: 'short_919191' };
      },
      readback: async () => assert.fail('readback must not run after a journal failure'),
    }), error => error.code === 'VIDEO_UPLOAD_JOURNAL_WRITE_FAILED');

    assert.equal(uploadCalls, 0);
    assert.equal(createdHookCode, 'VIDEO_UPLOAD_JOURNAL_WRITE_FAILED');
    const contents = await readFile(journalFile, 'utf8');
    assert.equal(contents.trim().split('\n').map(JSON.parse).length, 1);
    assert.match(contents, /"type":"operation_intent"/);
    assert.doesNotMatch(contents, /create_intent|create_recorded|upload_result_received/);

    await assert.rejects(runBrowserAssistedUpload({
      ...shared,
      browserUpload: async () => { uploadCalls += 1; }, readback: async () => ({}),
    }), error => error.code === 'VIDEO_UPLOAD_RECONCILIATION_REQUIRED');
    assert.equal(uploadCalls, 0);
  } finally { await cleanup(h.directory); }
});

test('a returned post ID can be reconciled by owner readback without another create', async () => {
  const h = await harness();
  try {
    let uploadCalls = 0;
    const shared = {
      platform: 'youtube', input: h.input, expectedOwner: OWNER, operationId: 'readback-retry',
      journalDir: h.journalDir, phasePlan: ['private_video_create'], contractVerified: true,
    };
    await assert.rejects(runBrowserAssistedUpload({
      ...shared,
      browserUpload: async context => {
        uploadCalls += 1;
        await context.onBeforeCreate('private_video_create');
        await context.onCreated('private_video_create');
        return { postId: 'short_654321', url: 'https://www.youtube.com/shorts/short_654321?signature=DO_NOT_STORE' };
      },
      readback: async () => { throw new Error('temporary readback outage'); },
    }), error => error.code === 'VIDEO_UPLOAD_READBACK_UNAVAILABLE');

    const result = await reconcileBrowserAssistedUpload({
      ...shared, readback: async ({ postId }) => validReadback(postId,
        { url: 'https://www.youtube.com/shorts/short_654321?private=1' }),
    });
    assert.deepEqual(result, { platform: 'youtube', postId: 'short_654321', url: null, visibility: 'private' });
    assert.equal(uploadCalls, 1);
    const journal = await readFile(path.join(h.journalDir,
      (await readdir(h.journalDir)).find(name => name.endsWith('.jsonl'))), 'utf8');
    assert.doesNotMatch(journal, /signature=|DO_NOT_STORE|private=1/);
  } finally { await cleanup(h.directory); }
});

test('owner or metadata mismatch fails closed and cannot trigger another upload', async () => {
  const h = await harness();
  try {
    let calls = 0;
    const shared = {
      platform: 'youtube', input: h.input, expectedOwner: OWNER, operationId: 'mismatch-case',
      journalDir: h.journalDir, phasePlan: ['private_video_create'], contractVerified: true,
    };
    const options = {
      ...shared,
      browserUpload: async context => {
        calls += 1;
        await context.onBeforeCreate('private_video_create');
        await context.onCreated('private_video_create');
        return { postId: 'short_787878' };
      },
      readback: async ({ postId }) => validReadback(postId,
        { ownerId: 'another_account', description: 'different description' }),
    };
    await assert.rejects(runBrowserAssistedUpload(options), error => error.code === 'VIDEO_UPLOAD_READBACK_MISMATCH');
    await assert.rejects(runBrowserAssistedUpload(options), error => error.code === 'VIDEO_UPLOAD_RECONCILIATION_REQUIRED');
    assert.equal(calls, 1);
  } finally { await cleanup(h.directory); }
});

test('concurrent operations for the same intent allow at most one browser callback', async () => {
  const h = await harness();
  try {
    let calls = 0;
    let announceEntered;
    let releaseBrowser;
    const entered = new Promise(resolve => { announceEntered = resolve; });
    const blocked = new Promise(resolve => { releaseBrowser = resolve; });
    const shared = {
      platform: 'youtube', input: h.input, expectedOwner: OWNER, journalDir: h.journalDir,
      phasePlan: ['private_video_create'], contractVerified: true,
    };
    const first = runBrowserAssistedUpload({
      ...shared,
      browserUpload: async ({ onBeforeCreate, onCreated }) => {
        calls += 1;
        await onBeforeCreate('private_video_create');
        announceEntered();
        await blocked;
        await onCreated('private_video_create');
        return { postId: 'short_123123', url: 'https://www.youtube.com/shorts/short_123123' };
      },
      readback: async ({ postId }) => validReadback(postId),
    });
    await entered;
    await assert.rejects(runBrowserAssistedUpload({
      ...shared,
      browserUpload: async () => { calls += 1; }, readback: async () => ({}),
    }), error => error.code === 'VIDEO_UPLOAD_JOURNAL_BUSY');
    releaseBrowser();
    await first;
    assert.equal(calls, 1);
  } finally { await cleanup(h.directory); }
});

test('overlapping before-create and created hooks cannot journal duplicate phases', async () => {
  const h = await harness();
  try {
    const result = await runBrowserAssistedUpload({
      platform: 'youtube', input: h.input, expectedOwner: OWNER, journalDir: h.journalDir,
      phasePlan: ['private_video_create'], contractVerified: true,
      browserUpload: async context => {
        const firstBefore = context.onBeforeCreate('private_video_create');
        await assert.rejects(context.onBeforeCreate('private_video_create'),
          error => error.code === 'VIDEO_UPLOAD_PHASE_OUT_OF_ORDER');
        await firstBefore;
        const firstCreated = context.onCreated('private_video_create');
        await assert.rejects(context.onCreated('private_video_create'),
          error => error.code === 'VIDEO_UPLOAD_PHASE_OUT_OF_ORDER');
        await firstCreated;
        return { postId: 'short_121212' };
      },
      readback: async ({ postId }) => validReadback(postId),
    });
    assert.equal(result.postId, 'short_121212');
    const journal = await readFile(path.join(h.journalDir,
      (await readdir(h.journalDir)).find(name => name.endsWith('.jsonl'))), 'utf8');
    const rows = journal.trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.type === 'create_intent').length, 1);
    assert.equal(rows.filter(row => row.type === 'create_recorded').length, 1);
  } finally { await cleanup(h.directory); }
});

test('a lock held by another process blocks the create callback', async () => {
  const h = await harness();
  let child;
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(h.journalDir, { recursive: true }));
    const operationId = 'cross-process-lock';
    const key = createHash('sha256').update(`youtube\0${operationId}`).digest('hex');
    const lockFile = path.join(h.journalDir, `${key}.lock`);
    const source = "import('node:fs/promises').then(async ({open,rm})=>{const h=await open(process.argv[1],'wx',0o600);process.stdout.write('LOCKED\\n');setTimeout(async()=>{await h.close();await rm(process.argv[1],{force:true})},700)})";
    child = spawn(process.execPath, ['-e', source, lockFile], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('lock process did not start')), 5000);
      child.stdout.on('data', data => {
        output += data.toString('utf8');
        if (output.includes('LOCKED')) { clearTimeout(timeout); resolve(); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { if (!output.includes('LOCKED')) { clearTimeout(timeout); reject(new Error(`lock process exited ${code}`)); } });
    });
    let calls = 0;
    await assert.rejects(runBrowserAssistedUpload({
      platform: 'youtube', input: h.input, expectedOwner: OWNER, operationId,
      journalDir: h.journalDir, phasePlan: ['private_video_create'], contractVerified: true,
      browserUpload: async () => { calls += 1; }, readback: async () => ({}),
    }), error => error.code === 'VIDEO_UPLOAD_JOURNAL_BUSY');
    assert.equal(calls, 0);
  } finally {
    child?.kill();
    await cleanup(h.directory);
  }
});

test('platform entry points report their current blockers before reaching a callback', async () => {
  for (const adapter of [youtube, instagram, naverClip]) {
    assert.equal(adapter.capability.status, 'blocked');
    let calls = 0;
    await assert.rejects(adapter.uploadVideo({}, { browserUpload: async () => { calls += 1; } }), error => {
      assert.deepEqual(error.capability, adapter.capability);
      return error.code === 'VIDEO_UPLOAD_BLOCKED';
    });
    assert.equal(calls, 0);
  }
});
