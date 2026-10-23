import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FlowClient } from '../src/client.mjs';
import { FlowHttpTransport } from '../src/http-transport.mjs';
import { loadJournal } from '../src/journal.mjs';
import { bindCaptchaToken, buildTextVideoSubmission, CAPTCHA_SLOT, RPC } from '../src/protocol.mjs';
import { resetTestCredentialStore, writeCredential } from '../src/secure-credential-store.mjs';
import { FLOW_CREDENTIAL } from '../src/session-name.mjs';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_URL = `https://flow-content.google/video/${MEDIA_ID}?signature=synthetic-only`;
const MP4 = Buffer.from('000000186674797069736f6d', 'hex');
const ISSUER_ORIGIN = 'https://www.google.com';

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flow-generation-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function makeProvider({ token = `synthetic-${randomUUID()}`, makeResult } = {}) {
  let calls = 0;
  const provider = {
    mode: 'pure_http',
    issuerOrigin: ISSUER_ORIGIN,
    async acquire(request) {
      calls += 1;
      const now = Date.now();
      const result = {
        mode: 'pure_http',
        issuerOrigin: request.issuerOrigin,
        action: request.action,
        token,
        issuedAt: now,
        expiresAt: now + 110_000,
        oneTime: true,
        binding: request.binding,
      };
      return makeResult ? makeResult(result, request, calls) : result;
    },
  };
  return { provider, getCalls: () => calls };
}

function makeTransport({ createBehavior, mediaIds = [MEDIA_ID], onRpc } = {}) {
  const state = { createCalls: 0, rpcCalls: [], sawAcceptedCheckpointBeforeMediaRead: false };
  const transport = {
    getContext: () => ({ projectId: PROJECT_ID, documentCheckedAt: 'synthetic' }),
    async start() {},
    async createVideo(freq, options) {
      state.createCalls += 1;
      state.createOptions = options;
      state.submission = JSON.parse(freq);
      state.requestId = JSON.parse(state.submission[0][0][1])[2][0];
      if (createBehavior) return createBehavior(state, freq, options);
      return { payload: [null, null, null, [[MEDIA_ID]]] };
    },
    async rpc(rpcId) {
      state.rpcCalls.push(rpcId);
      if (onRpc) await onRpc(state, rpcId);
      if (rpcId === RPC.projectMedia) return { payload: [null, [], mediaIds.map(id => [id])] };
      if (rpcId === RPC.pollGeneration) {
        const details = [];
        details[8] = [3];
        details[13] = MP4.length;
        const record = [];
        record[0] = MEDIA_ID;
        record[5] = details;
        return { payload: [null, null, [record]] };
      }
      if (rpcId === RPC.getMedia) return { payload: [VIDEO_URL] };
      throw new Error('Unexpected synthetic RPC.');
    },
  };
  return { transport, state };
}

function clientFor({ directory, provider, transport, fetchImpl, clock } = {}) {
  return new FlowClient({
    transport,
    fetchImpl: fetchImpl ?? (async () => new Response(MP4, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) },
    })),
    generationInputProvider: provider,
    clock,
    jobDir: path.join(directory, 'jobs'),
  });
}

test('captured eight-second 720p contract keeps its observed model and leaves the issuer slot explicit', () => {
  const { freq } = buildTextVideoSubmission({
    prompt: 'calm origami boat on a sunrise pond',
    projectId: PROJECT_ID,
    aspect: '16:9',
    duration: 8,
    resolution: '720p',
  });
  const envelope = JSON.parse(freq);
  const payload = JSON.parse(envelope[0][0][1]);
  assert.equal(envelope[0][0][0], 'YhhmEf');
  assert.equal(payload[0][0][1], 'abra_t2v_8s');
  assert.equal(payload[0][0][2], 2);
  assert.equal(payload[1][5], PROJECT_ID);
  assert.deepEqual(payload[1][10], [CAPTCHA_SLOT, 1]);
  const bound = JSON.parse(bindCaptchaToken(freq, 'synthetic-one-time-input').freq);
  assert.equal(JSON.parse(bound[0][0][1])[1][10][0], 'synthetic-one-time-input');
});

test('expired, mismatched, and browser-mode inputs stop before any create or journal write', async (t) => {
  for (const kind of ['expired', 'mismatched', 'request-id-mismatched', 'browser', 'third-party', 'wrong-action']) {
    await t.test(kind, async t2 => {
      const directory = await tempDirectory(t2);
      const { transport, state } = makeTransport();
      const { provider } = makeProvider({ makeResult(result) {
        if (kind === 'expired') return { ...result, issuedAt: Date.now() - 130_000, expiresAt: Date.now() - 1 };
        if (kind === 'mismatched') return { ...result, binding: { ...result.binding, duration: 6 } };
        if (kind === 'request-id-mismatched') {
          return { ...result, binding: { ...result.binding, requestId: randomUUID().toUpperCase() } };
        }
        if (kind === 'browser') return { ...result, mode: 'browser_automation' };
        if (kind === 'third-party') return { ...result, issuerOrigin: 'https://attacker.example' };
        return { ...result, action: 'OTHER_ACTION' };
      } });
      const client = clientFor({ directory, provider, transport });
      await assert.rejects(client.generateVideo({ prompt: 'test prompt', outputPath: path.join(directory, 'out.mp4') }));
      assert.equal(state.createCalls, 0);
      await assert.rejects(readdir(path.join(directory, 'jobs')), error => error.code === 'ENOENT');
    });
  }
});

test('a slow provider is checked against the clock after it returns', async t => {
  const directory = await tempDirectory(t);
  let now = Date.now();
  const { transport, state } = makeTransport();
  const { provider } = makeProvider({ makeResult: async (result) => {
    const output = { ...result, issuedAt: now, expiresAt: now + 60_000 };
    await new Promise(resolve => setTimeout(resolve, 5));
    now += 130_000;
    return output;
  } });
  const client = clientFor({ directory, provider, transport, clock: () => now });
  await assert.rejects(client.generateVideo({ prompt: 'test prompt', outputPath: path.join(directory, 'out.mp4') }), error =>
    error.serverCode === 'FLOW_GENERATION_INPUT_EXPIRED');
  assert.equal(state.createCalls, 0);
  await assert.rejects(readdir(path.join(directory, 'jobs')), error => error.code === 'ENOENT');
});

test('the one-time input is revalidated after intent I/O immediately before send', async t => {
  const directory = await tempDirectory(t);
  const base = Date.now();
  let clockReads = 0;
  const clock = () => (++clockReads < 3 ? base : base + 130_000);
  const { transport, state } = makeTransport();
  const { provider } = makeProvider({ makeResult(result) {
    return { ...result, issuedAt: base, expiresAt: base + 110_000 };
  } });
  const client = clientFor({ directory, provider, transport, clock });
  await assert.rejects(client.generateVideo({ prompt: 'test prompt', outputPath: path.join(directory, 'out.mp4') }), error =>
    error.serverCode === 'FLOW_GENERATION_INPUT_EXPIRED');
  assert.equal(state.createCalls, 0);
  const names = await readdir(path.join(directory, 'jobs'));
  assert.equal(names.filter(name => name.endsWith('.json')).length, 1);
  assert.equal((await loadJournal(path.join(directory, 'jobs', names.find(name => name.endsWith('.json'))))).state, 'preflight_failed');
});

test('a successful one-shot response is checkpointed before readback and downloaded without persisting the input', async t => {
  const directory = await tempDirectory(t);
  const outputPath = path.join(directory, 'out.mp4');
  const { transport, state } = makeTransport({ onRpc: async (capture, rpcId) => {
    if (rpcId !== RPC.projectMedia || capture.sawAcceptedCheckpointBeforeMediaRead) return;
    const jobs = (await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.json'));
    const stored = JSON.parse(await readFile(path.join(directory, 'jobs', jobs[0]), 'utf8'));
    capture.sawAcceptedCheckpointBeforeMediaRead = stored.state === 'accepted' && stored.mediaId === MEDIA_ID;
  }, createBehavior: async (capture, freq) => {
    const envelope = JSON.parse(freq);
    const payload = JSON.parse(envelope[0][0][1]);
    capture.requestId = payload[2][0];
    assert.equal(envelope[0][0][0], RPC.generateTextVideo);
    assert.equal(payload[0][0][1], 'abra_t2v_8s');
    assert.equal(payload[1][10][0], 'transient-input-never-journaled');
    assert.equal(capture.createCalls, 1);
    return { payload: [null, null, null, [[MEDIA_ID]]] };
  } });
  const { provider } = makeProvider({ token: 'transient-input-never-journaled' });
  const client = clientFor({ directory, provider, transport });
  const result = await client.generateVideo({
    prompt: 'calm origami boat on a sunrise pond', outputPath, aspect: '16:9', duration: 8, resolution: '720p',
  });

  assert.equal(result.status, 'downloaded');
  assert.equal(result.mediaId, MEDIA_ID);
  assert.equal(result.bytes, MP4.length);
  assert.equal(state.createCalls, 1);
  assert.equal(state.sawAcceptedCheckpointBeforeMediaRead, true);
  assert.deepEqual(state.rpcCalls, [RPC.projectMedia, RPC.pollGeneration, RPC.getMedia]);
  const jobs = (await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.json'));
  assert.equal(jobs.length, 1);
  const raw = await readFile(path.join(directory, 'jobs', jobs[0]), 'utf8');
  const journal = JSON.parse(raw);
  assert.equal(journal.state, 'downloaded');
  assert.equal(journal.mediaId, MEDIA_ID);
  assert.equal(journal.requestId, state.requestId);
  assert.equal(journal.clientIds.length, 2);
  assert.ok(state.requestId);
  assert.doesNotMatch(raw, /transient-input-never-journaled|calm origami boat/);
  assert.equal(await readFile(outputPath).then(bytes => bytes.toString('hex')), MP4.toString('hex'));
});

test('an ambiguous server reply retains its fence and a local MP4 cannot resolve the create', async t => {
  const directory = await tempDirectory(t);
  const outputPath = path.join(directory, 'out.mp4');
  const { transport, state } = makeTransport({ createBehavior: async () => {
    throw Object.assign(new Error('remote RPC returned an uncertain result'), { ambiguous: true });
  }, mediaIds: [] });
  const { provider } = makeProvider();
  const client = clientFor({ directory, provider, transport });
  let firstJobPath;
  await assert.rejects(client.generateVideo({ prompt: 'test prompt', outputPath }), error => {
    firstJobPath = error.jobPath;
    return error.ambiguous === true && error.code === 'FLOW_GENERATION_OUTCOME_UNKNOWN';
  });
  await writeFile(outputPath, MP4);
  await assert.rejects(client.reconcileJob(firstJobPath), error => error.ambiguous === true);
  const job = await loadJournal(firstJobPath);
  assert.equal(job.state, 'needs_reconciliation');
  assert.equal(job.mediaId, undefined);
  await assert.rejects(client.generateVideo({ prompt: 'test prompt', outputPath: path.join(directory, 'second.mp4') }), error =>
    error.code === 'FLOW_GENERATION_UNRESOLVED');
  assert.equal(state.createCalls, 1);
  const lockFiles = (await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.lock'));
  assert.equal(lockFiles.length, 1);
});

test('concurrent same-project callers pass through one atomic reservation and issue at most one create', async t => {
  const directory = await tempDirectory(t);
  const { transport, state } = makeTransport({ createBehavior: async () => new Promise(() => {}) });
  let count = 0;
  let releaseBoth;
  const bothArrived = new Promise(resolve => { releaseBoth = resolve; });
  const { provider } = makeProvider({ makeResult: async (result, request) => {
    count += 1;
    if (count === 2) releaseBoth();
    await bothArrived;
    return { ...result, token: `parallel-${count}-${randomUUID()}`, binding: request.binding };
  } });
  const client = clientFor({ directory, provider, transport });
  const first = client.generateVideo({ prompt: 'same prompt', outputPath: path.join(directory, 'first.mp4') });
  const second = client.generateVideo({ prompt: 'same prompt', outputPath: path.join(directory, 'second.mp4') });
  const loser = await Promise.race([
    first.then(() => ({ ok: true }), error => ({ error })),
    second.then(() => ({ ok: true }), error => ({ error })),
  ]);
  first.catch(() => {});
  second.catch(() => {});
  assert.ok(loser.error, 'one same-project caller must fail closed');
  assert.ok(['FLOW_GENERATION_UNRESOLVED', 'FLOW_GENERATION_IN_PROGRESS'].includes(loser.error.code));
  for (let attempt = 0; attempt < 50 && state.createCalls === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.createCalls, 1, `${loser.error.code}: ${loser.error.message}`);
  // The first synthetic create is deliberately left pending to keep its unresolved intent observable.
});

test('a consumed one-time input cannot be reused for a later create', async t => {
  const directory = await tempDirectory(t);
  const { transport, state } = makeTransport();
  const { provider } = makeProvider({ token: `one-use-${randomUUID()}` });
  const client = clientFor({ directory, provider, transport });
  await client.generateVideo({ prompt: 'test prompt', outputPath: path.join(directory, 'first.mp4') });
  await assert.rejects(client.generateVideo({ prompt: 'test prompt', outputPath: path.join(directory, 'second.mp4') }), error =>
    error.serverCode === 'FLOW_GENERATION_INPUT_REUSED');
  assert.equal(state.createCalls, 1);
});

test('the explicit missing-input probe sends one scoped absent-field request, journals its mode, and downloads', async t => {
  const directory = await tempDirectory(t);
  const outputPath = path.join(directory, 'probe.mp4');
  const { transport, state } = makeTransport({ onRpc: async (capture, rpcId) => {
    if (rpcId !== RPC.projectMedia || capture.sawAcceptedCheckpointBeforeMediaRead) return;
    const jobs = (await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.json'));
    const stored = JSON.parse(await readFile(path.join(directory, 'jobs', jobs[0]), 'utf8'));
    capture.sawAcceptedCheckpointBeforeMediaRead = stored.state === 'accepted' && stored.mediaId === MEDIA_ID;
  }, createBehavior: async (capture, freq, options) => {
    capture.inputMode = options.inputMode;
    const envelope = JSON.parse(freq);
    const payload = JSON.parse(envelope[0][0][1]);
    assert.equal(envelope[0][0][0], RPC.generateTextVideo);
    assert.equal(payload[0][0][1], 'abra_t2v_8s');
    assert.equal(payload[0][0][2], 2);
    assert.equal(payload[1][5], PROJECT_ID);
    assert.equal(payload[1].length, 10);
    assert.equal(Object.hasOwn(payload[1], 10), false);
    assert.doesNotMatch(freq, /__CAPTCHA__|synthetic-one-time-input/);
    assert.equal(options.inputMode, 'absent_probe');
    assert.equal(capture.createCalls, 1);
    return { payload: [null, null, null, [[MEDIA_ID]]] };
  } });
  const client = clientFor({ directory, transport });
  const result = await client.generateVideo({
    prompt: 'calm origami boat on a sunrise pond', outputPath,
    aspect: '16:9', duration: 8, resolution: '720p', probeMissingInput: true,
  });

  assert.equal(result.status, 'downloaded');
  assert.equal(result.inputMode, 'absent_probe');
  assert.equal(state.inputMode, 'absent_probe');
  assert.equal(state.createCalls, 1);
  assert.equal(state.sawAcceptedCheckpointBeforeMediaRead, true);
  assert.deepEqual(state.rpcCalls, [RPC.projectMedia, RPC.pollGeneration, RPC.getMedia]);
  const jobs = (await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.json'));
  assert.equal(jobs.length, 1);
  const raw = await readFile(path.join(directory, 'jobs', jobs[0]), 'utf8');
  const journal = JSON.parse(raw);
  assert.equal(journal.state, 'downloaded');
  assert.equal(journal.inputMode, 'absent_probe');
  assert.equal(journal.requestId, state.requestId);
  assert.doesNotMatch(raw, /calm origami boat|CAPTCHA|input token/i);
  assert.equal(await readFile(outputPath).then(bytes => bytes.toString('hex')), MP4.toString('hex'));
});

test('the missing-input option cannot change project, duration, resolution, or aspect scope', async t => {
  const directory = await tempDirectory(t);
  const { transport, state } = makeTransport();
  const client = clientFor({ directory, transport });
  const common = { prompt: 'test prompt', probeMissingInput: true };
  const rejected = [
    { duration: 6 },
    { resolution: '360p' },
    { aspect: '9:16' },
    { projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  ];
  for (let index = 0; index < rejected.length; index += 1) {
    await assert.rejects(client.generateVideo({ ...common, ...rejected[index],
      outputPath: path.join(directory, `rejected-${index}.mp4`) }));
  }
  assert.equal(state.createCalls, 0);
  await assert.rejects(readdir(path.join(directory, 'jobs')), error => error.code === 'ENOENT');
});

test('an unknown missing-input probe response keeps its journal and project fence for reconciliation', async t => {
  const directory = await tempDirectory(t);
  const outputPath = path.join(directory, 'probe.mp4');
  const { transport, state } = makeTransport({ createBehavior: async (_capture, freq, options) => {
    const payload = JSON.parse(JSON.parse(freq)[0][0][1]);
    assert.equal(options.inputMode, 'absent_probe');
    assert.equal(payload[1].length, 10);
    throw Object.assign(new Error('synthetic ambiguous response'), { ambiguous: true, serverCode: 'SERVER_ERROR' });
  }, mediaIds: [] });
  const client = clientFor({ directory, transport });
  let jobPath;
  await assert.rejects(client.generateVideo({ prompt: 'test prompt', outputPath, probeMissingInput: true }), error => {
    jobPath = error.jobPath;
    return error.ambiguous === true && error.code === 'SERVER_ERROR';
  });
  const job = await loadJournal(jobPath);
  assert.equal(job.inputMode, 'absent_probe');
  assert.equal(job.state, 'needs_reconciliation');
  await assert.rejects(client.generateVideo({ prompt: 'retry forbidden', outputPath: path.join(directory, 'retry.mp4'),
    probeMissingInput: true }), error => error.code === 'FLOW_GENERATION_UNRESOLVED');
  assert.equal(state.createCalls, 1);
  assert.equal((await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.lock')).length, 1);
});

test('an HTTP 200 response with an invalid media id preserves status in the uncertain journal', async t => {
  const directory = await tempDirectory(t);
  const { transport, state } = makeTransport({ createBehavior: async (_capture, _freq, options) => {
    assert.equal(options.inputMode, 'absent_probe');
    return { payload: [null, null, null, [['not-a-valid-media-id']]],
      evidence: { operation: RPC.generateTextVideo, httpStatus: 200 } };
  }, mediaIds: [] });
  const client = clientFor({ directory, transport });
  let jobPath;
  await assert.rejects(client.generateVideo({ prompt: 'test prompt',
    outputPath: path.join(directory, 'malformed.mp4'), probeMissingInput: true }), error => {
    jobPath = error.jobPath;
    return error.ambiguous === true && error.httpStatus === 200;
  });
  const job = await loadJournal(jobPath);
  assert.equal(job.inputMode, 'absent_probe');
  assert.equal(job.state, 'needs_reconciliation');
  assert.equal(job.lastError.httpStatus, 200);
  assert.equal(state.createCalls, 1);
  assert.equal((await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.lock')).length, 1);
});

test('an HTTP 200 RPC status 7 and safe public error enum survive into the unresolved journal', async t => {
  const directory = await tempDirectory(t);
  const { transport, state } = makeTransport({ createBehavior: async () => {
    throw Object.assign(new Error('safe synthetic RPC diagnostic'), {
      serverCode: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', rpcStatus: 7, httpStatus: 200, ambiguous: true,
    });
  }, mediaIds: [] });
  const client = clientFor({ directory, transport });
  let jobPath;
  await assert.rejects(client.generateVideo({ prompt: 'test prompt',
    outputPath: path.join(directory, 'rpc-error.mp4'), probeMissingInput: true }), error => {
    jobPath = error.jobPath;
    return error.ambiguous === true && error.code === 'PUBLIC_ERROR_UNUSUAL_ACTIVITY'
      && error.httpStatus === 200 && error.rpcStatus === 7;
  });
  const job = await loadJournal(jobPath);
  assert.equal(job.state, 'needs_reconciliation');
  assert.deepEqual({ code: job.lastError.code, httpStatus: job.lastError.httpStatus, rpcStatus: job.lastError.rpcStatus }, {
    code: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', httpStatus: 200, rpcStatus: 7,
  });
  assert.equal(job.inputMode, 'absent_probe');
  assert.equal(state.createCalls, 1);
  assert.equal((await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.lock')).length, 1);
});

test('candidate HTTP ErrorInfo stays outcome-unknown while safe diagnostics reach the journal', async t => {
  resetTestCredentialStore();
  t.after(() => resetTestCredentialStore());
  writeCredential(FLOW_CREDENTIAL, JSON.stringify({
    version: 1, origin: 'https://flow.google.com', projectId: PROJECT_ID,
    cookieHeader: 'SID=synthetic; __Secure-1PSID=synthetic-secure',
  }));
  const directory = await tempDirectory(t);
  const privateMessage = 'raw-private-error-message';
  const privateDomain = 'private.internal.example';
  const privateMetadataKey = 'private_meta_key';
  const privateMetadataValue = 'raw-private-metadata-value';
  const responseBody = JSON.stringify([['wrb.fr', RPC.generateTextVideo, null, null, null, [7, privateMessage, [
    ['type.googleapis.com/google.rpc.ErrorInfo', [
      'PUBLIC_ERROR_UNUSUAL_ACTIVITY', privateDomain,
      { [privateMetadataKey]: privateMetadataValue },
    ]],
  ]]]]);
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') {
      const response = new Response('<script>{"SNlM0e":"synthetic-at","FdrFJe":"synthetic-sid","cfb2h":"synthetic-bl"}</script>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      Object.defineProperty(response, 'url', { value: url.toString() });
      Object.defineProperty(response.headers, 'getSetCookie', { value: () => [] });
      return response;
    }
    const response = new Response(responseBody, {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    Object.defineProperty(response, 'url', { value: url.toString() });
    Object.defineProperty(response.headers, 'getSetCookie', { value: () => [] });
    return response;
  };
  const transport = new FlowHttpTransport({ fetchImpl });
  const client = new FlowClient({ transport, jobDir: path.join(directory, 'jobs') });
  await client.start();
  let jobPath;
  await assert.rejects(client.generateVideo({ prompt: 'synthetic diagnostic', outputPath: path.join(directory, 'diagnostic.mp4'),
    duration: 8, resolution: '720p', probeMissingInput: true }), error => {
    jobPath = error.jobPath;
    assert.equal(error.code, 'FLOW_GENERATION_OUTCOME_UNKNOWN');
    assert.equal(error.serverCode, undefined);
    assert.equal(error.errorCandidateReason, 'PUBLIC_ERROR_UNUSUAL_ACTIVITY');
    assert.equal(error.errorInfoSchemaVerified, false);
    assert.equal(error.errorReasonConflict, false);
    return true;
  });
  const job = await loadJournal(jobPath);
  assert.equal(job.state, 'needs_reconciliation');
  assert.deepEqual({
    code: job.lastError.code,
    errorCandidateReason: job.lastError.errorCandidateReason,
    errorInfoSchemaVerified: job.lastError.errorInfoSchemaVerified,
    httpStatus: job.lastError.httpStatus,
    rpcStatus: job.lastError.rpcStatus,
    errorMessagePresent: job.lastError.errorMessagePresent,
    errorInfoPresent: job.lastError.errorInfoPresent,
    errorInfoCount: job.lastError.errorInfoCount,
    errorDomainPresent: job.lastError.errorDomainPresent,
    errorMetadataPresent: job.lastError.errorMetadataPresent,
    errorMetadataCount: job.lastError.errorMetadataCount,
    errorReasonConflict: job.lastError.errorReasonConflict,
  }, {
    code: 'FLOW_GENERATION_OUTCOME_UNKNOWN',
    errorCandidateReason: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', errorInfoSchemaVerified: false,
    httpStatus: 200, rpcStatus: 7,
    errorMessagePresent: true, errorInfoPresent: true, errorInfoCount: 1,
    errorDomainPresent: true, errorMetadataPresent: true, errorMetadataCount: 1, errorReasonConflict: false,
  });
  const persisted = JSON.stringify(job);
  for (const forbidden of [privateMessage, privateDomain, privateMetadataKey, privateMetadataValue]) {
    assert.equal(persisted.includes(forbidden), false, `raw RPC error content reached journal: ${forbidden}`);
  }
  assert.equal((await readdir(path.join(directory, 'jobs'))).filter(name => name.endsWith('.lock')).length, 1,
    'uncertain create must keep its existing project fence');
});
