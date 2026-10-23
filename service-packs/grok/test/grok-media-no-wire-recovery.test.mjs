import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { OperationJournal } from '../src/journal.mjs';
import { NonSecretJsonFileStore } from '../src/nonsecret-json-store.mjs';
import { GrokMediaIntentJournal } from '../src/grok-media-intent.mjs';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const OWNER = 'a'.repeat(64);
const INTENT_ID = '00000000-0000-4000-8000-000000000901';
const PROMPT = 'A private no-wire recovery test phrase';
const PROFILE = 'video-image-reference-6s-480p-no-audio';
const INTENT_DIGEST = sha(`media.video.create\n${OWNER}\n${INTENT_ID}`);

function noWireProof(requestDigest = 'b'.repeat(64)) {
  return {
    schemaVersion: 1,
    operation: 'media.video.create',
    ownerIdentityDigest: OWNER,
    intentIdSha256: sha(INTENT_ID),
    intentDigest: INTENT_DIGEST,
    requestDigest,
    payloadProfile: PROFILE,
    promptSha256: sha(PROMPT),
    stage: 'session_setup',
    requestStarted: false,
    responseReceived: false,
    httpStatus: null,
    contentType: null,
    httpVersion: 'other',
    responseBytesRead: 0,
    requestBodyBytes: 1024,
    cfMitigated: false,
    errorClass: 'TypeError',
    helperErrorCode: 'CFFI_SESSION_CREATE_FAILED',
    requestHeaderNames: ['accept', 'content-type', 'origin', 'referer', 'sec-ch-ua-platform', 'user-agent',
      'x-statsig-id', 'x-xai-request-id'],
    responseHeaderNames: [],
    cookieNamesUsed: [],
    source: 'curl_cffi-0.16.3-chrome150',
  };
}

async function makeDirectory() {
  const base = path.join(homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'grok-media-no-wire-'));
  await chmod(directory, 0o700);
  return directory;
}

test('operation journal atomically records typed no-wire evidence and permits only its same-intent recovery', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const journal = new OperationJournal({ store: new NonSecretJsonFileStore({ filePath }) });
  const firstDigest = 'b'.repeat(64);
  const first = await journal.begin({ contractId: 'media.video.create', requestDigest: firstDigest, intentDigest: INTENT_DIGEST });
  await assert.rejects(journal.transition(first.localOperationId, 'failed'), { code: 'JOURNAL_TRANSITION_INVALID' });
  await assert.rejects(journal.rejectMediaVideoNoWireAttempt(first.localOperationId, {
    ...noWireProof(firstDigest), responseReceived: true,
  }), { code: 'JOURNAL_VIDEO_NO_WIRE_PROOF_INVALID' });

  await journal.rejectMediaVideoNoWireAttempt(first.localOperationId, noWireProof(firstDigest));
  const afterProof = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(afterProof.entries[0].state, 'rejected');
  assert.equal(afterProof.entries[0].videoNoWireProof.stage, 'session_setup');
  assert.equal(afterProof.entries[0].videoNoWireProof.requestStarted, false);
  assert.equal(afterProof.entries[0].videoNoWireProof.responseReceived, false);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /private no-wire recovery test phrase|cookies|session-setup-only-test/);

  const secondDigest = firstDigest;
  await assert.rejects(journal.beginVerifiedNoWireVideoRecovery({
    requestDigest: secondDigest, intentDigest: INTENT_DIGEST, intentId: INTENT_ID, ownerIdentityDigest: OWNER,
    payloadProfile: 'video-6s-480p-no-audio', promptSha256: sha(PROMPT),
  }), { code: 'JOURNAL_VIDEO_NO_WIRE_RECOVERY_NOT_ALLOWED' });
  const second = await journal.beginVerifiedNoWireVideoRecovery({
    requestDigest: secondDigest, intentDigest: INTENT_DIGEST, intentId: INTENT_ID, ownerIdentityDigest: OWNER,
    payloadProfile: PROFILE, promptSha256: sha(PROMPT),
  });
  assert.equal(second.state, 'sending');
  assert.equal(second.videoNoWireRecovery.priorRequestDigest, firstDigest);
  assert.equal(second.videoNoWireRecovery.ownerIdentityDigest, OWNER);
  assert.equal((await journal.list()).length, 2);

  await journal.transition(second.localOperationId, 'outcome_unknown', { reasonCode: 'HTTP_TRANSPORT_FAILED' });
  await assert.rejects(journal.beginVerifiedNoWireVideoRecovery({
    requestDigest: 'd'.repeat(64), intentDigest: INTENT_DIGEST, intentId: INTENT_ID, ownerIdentityDigest: OWNER,
    payloadProfile: PROFILE, promptSha256: sha(PROMPT),
  }), { code: 'JOURNAL_VIDEO_NO_WIRE_RECOVERY_NOT_ALLOWED' });
  await assert.rejects(journal.begin({
    contractId: 'media.video.create', requestDigest: 'e'.repeat(64), intentDigest: INTENT_DIGEST,
  }), { code: 'OPERATION_ALREADY_HELD' });
});

test('media intent returns to prepared only after matching operation-journal no-wire proof is durable', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intentPath = path.join(directory, 'intents.json');
  const operationPath = path.join(directory, 'operations.json');
  const intentJournal = new GrokMediaIntentJournal({ filePath: intentPath });
  const operationJournal = new OperationJournal({ store: new NonSecretJsonFileStore({ filePath: operationPath }) });
  await intentJournal.prepare({
    operation: 'media.video.create', prompt: PROMPT, payloadProfile: PROFILE,
    ownerIdentityDigest: OWNER, intentId: INTENT_ID,
  });
  await intentJournal.transition(INTENT_ID, 'sending');
  const requestDigest = 'f'.repeat(64);
  const operation = await operationJournal.begin({ contractId: 'media.video.create', requestDigest, intentDigest: INTENT_DIGEST });
  await operationJournal.rejectMediaVideoNoWireAttempt(operation.localOperationId, noWireProof(requestDigest));

  const recovered = await intentJournal.recoverVerifiedNoWire({
    intentId: INTENT_ID, prompt: PROMPT, payloadProfile: PROFILE, ownerIdentityDigest: OWNER,
    operationJournal, localOperationId: operation.localOperationId,
  });
  assert.equal(recovered.state, 'prepared');
  assert.equal(recovered.attemptNumber, 1);
  assert.equal((await intentJournal.get(INTENT_ID)).state, 'prepared');
  const document = JSON.parse(await readFile(intentPath, 'utf8'));
  assert.equal(document.verifiedNoWireRecoveries.length, 1);
  assert.equal(document.verifiedNoWireRecoveries[0].stage, 'session_setup');
  assert.equal(document.verifiedNoWireRecoveries[0].requestStarted, false);
  assert.equal(document.verifiedNoWireRecoveries[0].responseReceived, false);
  assert.equal(document.verifiedNoWireRecoveries[0].requestDigest, requestDigest);
  assert.doesNotMatch(await readFile(intentPath, 'utf8'), /private no-wire recovery test phrase|CFFI_SESSION_CREATE_FAILED.*cookie/);

  const idempotent = await intentJournal.recoverVerifiedNoWire({
    intentId: INTENT_ID, prompt: PROMPT, payloadProfile: PROFILE, ownerIdentityDigest: OWNER,
    operationJournal, localOperationId: operation.localOperationId,
  });
  assert.equal(idempotent.recoveryRecorded, true);
  assert.equal(JSON.parse(await readFile(intentPath, 'utf8')).verifiedNoWireRecoveries.length, 1);
  await assert.rejects(intentJournal.recoverVerifiedNoWire({
    intentId: INTENT_ID, prompt: `${PROMPT} changed`, payloadProfile: PROFILE, ownerIdentityDigest: OWNER,
    operationJournal, localOperationId: operation.localOperationId,
  }), { code: 'MEDIA_INTENT_NO_WIRE_RECOVERY_UNVERIFIED' });
});

test('missing proof and unknown intent states remain held without no-wire recovery', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intentPath = path.join(directory, 'intents.json');
  const operationPath = path.join(directory, 'operations.json');
  const intentJournal = new GrokMediaIntentJournal({ filePath: intentPath });
  const operationJournal = new OperationJournal({ store: new NonSecretJsonFileStore({ filePath: operationPath }) });
  await intentJournal.prepare({
    operation: 'media.video.create', prompt: PROMPT, payloadProfile: PROFILE,
    ownerIdentityDigest: OWNER, intentId: INTENT_ID,
  });
  await intentJournal.transition(INTENT_ID, 'sending');
  const requestDigest = '9'.repeat(64);
  const operation = await operationJournal.begin({ contractId: 'media.video.create', requestDigest, intentDigest: INTENT_DIGEST });
  await operationJournal.transition(operation.localOperationId, 'outcome_unknown', { reasonCode: 'HTTP_TRANSPORT_FAILED' });
  await intentJournal.transition(INTENT_ID, 'outcome_unknown', { reasonCode: 'HTTP_TRANSPORT_FAILED' });
  await assert.rejects(intentJournal.recoverVerifiedNoWire({
    intentId: INTENT_ID, prompt: PROMPT, payloadProfile: PROFILE, ownerIdentityDigest: OWNER,
    operationJournal, localOperationId: operation.localOperationId,
  }), { code: 'MEDIA_INTENT_NO_WIRE_RECOVERY_UNVERIFIED' });
  await assert.rejects(operationJournal.beginVerifiedNoWireVideoRecovery({
    requestDigest: 'a'.repeat(64), intentDigest: INTENT_DIGEST, intentId: INTENT_ID, ownerIdentityDigest: OWNER,
    payloadProfile: PROFILE, promptSha256: sha(PROMPT),
  }), { code: 'JOURNAL_VIDEO_NO_WIRE_RECOVERY_NOT_ALLOWED' });
  assert.equal((await intentJournal.get(INTENT_ID)).state, 'outcome_unknown');
});

test('same-intent recovery records a local operation-journal failure only when the writer was never reached', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intentPath = path.join(directory, 'intents.json');
  const operationPath = path.join(directory, 'operations.json');
  const intentJournal = new GrokMediaIntentJournal({ filePath: intentPath });
  const operationJournal = new OperationJournal({ store: new NonSecretJsonFileStore({ filePath: operationPath }) });
  await intentJournal.prepare({ operation: 'media.video.create', prompt: PROMPT, payloadProfile: PROFILE,
    ownerIdentityDigest: OWNER, intentId: INTENT_ID });
  await intentJournal.transition(INTENT_ID, 'sending');
  const requestDigest = '7'.repeat(64);
  const operation = await operationJournal.begin({ contractId: 'media.video.create', requestDigest, intentDigest: INTENT_DIGEST });
  await operationJournal.rejectMediaVideoNoWireAttempt(operation.localOperationId, noWireProof(requestDigest));
  await intentJournal.recoverVerifiedNoWire({ intentId: INTENT_ID, prompt: PROMPT, payloadProfile: PROFILE,
    ownerIdentityDigest: OWNER, operationJournal, localOperationId: operation.localOperationId });

  await intentJournal.transition(INTENT_ID, 'sending');
  await intentJournal.transition(INTENT_ID, 'failed', { reasonCode: 'JOURNAL_STATE_INVALID' });
  const recovered = await intentJournal.recoverVerifiedNoWire({
    intentId: INTENT_ID, prompt: PROMPT, payloadProfile: PROFILE, ownerIdentityDigest: OWNER,
    operationJournal, localOperationId: operation.localOperationId,
    preDispatchFailure: { stage: 'operation_journal_begin', mainFetchCallCount: 0,
      requestStarted: false, responseReceived: false, errorCode: 'JOURNAL_STATE_INVALID' },
  });
  assert.equal(recovered.state, 'prepared');
  assert.equal((await intentJournal.get(INTENT_ID)).reasonCode, null);
  const events = JSON.parse(await readFile(intentPath, 'utf8')).verifiedNoWireRecoveries;
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].preDispatchFailure, { stage: 'operation_journal_begin', mainFetchCallCount: 0,
    requestStarted: false, responseReceived: false, errorCode: 'JOURNAL_STATE_INVALID' });
  await assert.rejects(intentJournal.recoverVerifiedNoWire({
    intentId: INTENT_ID, prompt: PROMPT, payloadProfile: PROFILE, ownerIdentityDigest: OWNER,
    operationJournal, localOperationId: operation.localOperationId,
    preDispatchFailure: { stage: 'operation_journal_begin', mainFetchCallCount: 1,
      requestStarted: false, responseReceived: false, errorCode: 'JOURNAL_STATE_INVALID' },
  }), { code: 'MEDIA_INTENT_NO_WIRE_RECOVERY_UNVERIFIED' });
});
