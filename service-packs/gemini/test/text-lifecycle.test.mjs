import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMutationJournal, consumeMutationDispatch, reserveMutationDispatch, settleMutationDispatch } from '../src/journal.mjs';
import { GeminiClientError } from '../src/errors.mjs';
import { clearTextActionEnvelope, readTextActionEnvelopeFromStdin, submitGeminiTextActionOnce } from '../src/text-lifecycle.mjs';
import { Readable } from 'node:stream';

const OWNER = 'owner@example.test';
const OWNER_SHA = createHash('sha256').update(OWNER).digest('hex');
const CID = 'c_0123456789abcdef';
const ROUTE = CID.slice(2);
const BASE_PROMPT = 'Base task prompt MODELBOUND';

function textContract() {
  return { operations: { text: { observation: { request: true, requestResponse: false }, effect: 'mutation', retryPolicy: 'never',
    request: { method: 'POST', origin: 'https://gemini.google.com', path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      queryKeys: ['bl', 'f.sid', 'hl', '_reqid', 'rt'], headerNames: ['content-type'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'] } } } };
}

function capture(prompt, targetId = CID) {
  const inner = Array(99).fill(null);
  inner[0] = [prompt];
  inner[71] = [targetId];
  inner[59] = '00000000-0000-4000-8000-000000000099';
  const form = new URLSearchParams();
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  form.set('at', 'fresh-in-memory-token');
  return { method: 'POST', url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=b&f.sid=f&hl=en&_reqid=123&rt=c',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: form.toString() };
}

function streamBody({ prompt, responseId, conversationId = CID }) {
  const data = [null, [conversationId, responseId], null, null, [[0, [prompt]]]];
  const value = ['wrb.fr', null, JSON.stringify(data)];
  const frame = JSON.stringify(value);
  return Buffer.from(")]}'\n" + `${frame.length + 2}\n${frame}\n`, 'utf8');
}

function detailPayload({ prompt, marker, responseId, draftId = 'draft_0000000000000002', includeBase = false }) {
  const turn = (userText, assistantText, turnId, draftId, plainText = 'Plain candidate fallback.') => {
    const value = [];
    value[0] = [null, turnId];
    value[2] = [[userText]];
    value[3] = [];
    value[3][0] = [[draftId, [plainText]]];
    value[3][12] = [[[
      [{ 39: ['source code', 'text', 1, null, 2] }],
      [{ 39: ['other code', 'txt', 1, null, 2] }],
      [null, [null, 18, assistantText]],
    ]]];
    return value;
  };
  const turns = [];
  if (includeBase) turns.push(turn(BASE_PROMPT, 'MODELBOUND: 42',
    'r_0000000000000001', 'draft_0000000000000001'));
  turns.push(turn(prompt, marker, responseId, draftId));
  return [[...turns], { conversationId: CID }];
}

async function fixture(t, { action, beforePrompt = BASE_PROMPT, afterPrompt, marker,
  directMarker = marker, readbackMarker = marker, responseId = 'r_0000000000000002',
  beforeTurnId = 'r_0000000000000001', beforeDraftId = 'draft_0000000000000001' }) {
  const journalRoot = path.join(os.homedir(), '.nad-scratch', 'tmp', `text-action-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  t.after(() => rm(journalRoot, { recursive: true, force: true }));
  const directBody = streamBody({ prompt: directMarker, responseId });
  const beforePayload = detailPayload({ prompt: beforePrompt,
    marker: action === 'regenerate' ? marker : 'old marker', responseId: beforeTurnId, draftId: beforeDraftId });
  const afterPayload = detailPayload({ prompt: afterPrompt, marker: readbackMarker, responseId, includeBase: action === 'continue' });
  let detailCount = 0;
  let generateCount = 0;
  const client = {
    contract: textContract(),
    transport: { session: { batchContext: { at: 'token' } } },
    verifiedOwner: OWNER.toLowerCase(),
    async refreshSession(owner) { return { ownerMatched: owner === OWNER, anonymousOwnerAbsent: true }; },
    async readHistoryDetail({ apiConversationId, visibleRouteId, expectedIntent }) {
      detailCount += 1;
      const before = detailCount === 1;
      const payload = structuredClone(before ? beforePayload : afterPayload);
      const expected = before ? beforePrompt : afterPrompt;
      return { httpStatus: 200, responseBytes: 123, responseSha256: 'a'.repeat(64),
        binding: { bound: apiConversationId === CID && visibleRouteId === ROUTE },
        summary: { rpcMatchCount: 1, apiConversationIdMatched: apiConversationId === CID, taskIntentMatched: expectedIntent === expected },
        payload };
    },
    async generateTextOnce(capturedRequest, prompt, options) {
      generateCount += 1;
      assert.equal(capturedRequest.body.includes('fresh-in-memory-token'), true);
      const job = await createMutationJournal({ capability: 'text', body: capturedRequest.body,
        actor: options.actor, callerIntent: options.callerIntent, root: journalRoot });
      const ticket = await reserveMutationDispatch(job);
      consumeMutationDispatch(ticket, 'text', job.wireBodyDigest);
      const responseSha256 = createHash('sha256').update(directBody).digest('hex');
      await settleMutationDispatch(ticket, { state: 'response_received', httpStatus: 200, responseBytes: directBody.length, responseSha256 });
      return { jobPath: job.jobPath, httpStatus: 200, responseSha256,
        response: { httpStatus: 200, contentType: 'application/json', responseBytes: directBody.length,
          responseSha256, credentialPropagated: true, body: Buffer.from(directBody) } };
    },
  };
  return { client, journalRoot, counts: () => ({ detailCount, generateCount }) };
}

const proof = action => ({ action, registeredTargetMatched: true, routeConversationMatched: true,
  nativeActionConfirmed: true, streamGenerateObserved: true, streamGenerateAbortConfirmed: true,
  browserBusinessRequestCount: 1, browserBusinessRequestAbortCount: 1, browserBusinessRequestsDelivered: 0,
  unclassifiedBusinessPostCount: 0, unclassifiedBusinessPostAbortCount: 0, unclassifiedBusinessPostsDelivered: 0 });

test('edit performs one direct captured request and exact hNv readback for the same conversation', async t => {
  const f = await fixture(t, { action: 'edit', beforePrompt: BASE_PROMPT, afterPrompt: 'Edited request', marker: 'EDIT_OK' });
  const result = await submitGeminiTextActionOnce({ client: f.client, action: 'edit', capturedRequest: capture('Edited request'),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt: 'Edited request', expectedAssistantMarker: 'EDIT_OK',
    callerIntent: 'text-action-test-edit', journalRoot: f.journalRoot, nativeActionCapture: proof('edit') });
  assert.equal(result.state, 'verified', JSON.stringify({ response: result.response, readback: result.readback, journal: result.mutationJournal, directErrorCode: result.directErrorCode }));
  assert.equal(result.directDispatchCount, 1);
  assert.equal(result.readback.sameConversationMatched, true);
  assert.equal(result.readback.semanticVerified, true);
  assert.equal(result.readback.hNvAnswerExactMatched, true);
  assert.equal(result.readback.hNvAnswerSource, 'hNvQHb_turn.response.Ya.structuredContent');
  assert.equal(result.readback.streamResponseIdExactlyMatchedTurnId, true);
  assert.equal(result.readback.streamResponseIdExactlyMatchedDraftId, false);
  assert.equal(result.readback.streamResponseIdExactMatchKind, 'exactly_matches_turn_id_value');
  assert.equal(result.capture.targetIdOccurrenceCount, 1);
  assert.deepEqual(result.capture.targetIdPath, [71, 0]);
  assert.equal(result.readback.beforeTurnAndDraftIdsDistinct, true);
  assert.equal(result.readback.afterTurnAndDraftIdsDistinct, true);
  assert.equal(f.counts().generateCount, 1);
  for (const privateValue of [CID, 'Edited request', 'EDIT_OK', 'r_0000000000000002']) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('continuation retains prior prompt and exact task binding', async t => {
  const f = await fixture(t, { action: 'continue', beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', marker: 'CONTINUE_OK' });
  const result = await submitGeminiTextActionOnce({ client: f.client, action: 'continue', capturedRequest: capture('Follow-up request'),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', expectedAssistantMarker: 'CONTINUE_OK',
    callerIntent: 'text-action-test-continue', journalRoot: f.journalRoot, nativeActionCapture: proof('continue') });
  assert.equal(result.state, 'verified', JSON.stringify({ response: result.response, readback: result.readback, journal: result.mutationJournal, directErrorCode: result.directErrorCode }));
  assert.equal(result.readback.priorPromptPreservedForContinuation, true);
});

test('regeneration requires a fresh response ID in the exact-task readback', async t => {
  const f = await fixture(t, { action: 'regenerate', beforePrompt: BASE_PROMPT, afterPrompt: BASE_PROMPT, marker: 'REGENERATE_OK' });
  const result = await submitGeminiTextActionOnce({ client: f.client, action: 'regenerate', capturedRequest: capture(BASE_PROMPT),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt: BASE_PROMPT, expectedAssistantMarker: 'REGENERATE_OK',
    callerIntent: 'text-action-test-regenerate', journalRoot: f.journalRoot, nativeActionCapture: proof('regenerate') });
  assert.equal(result.state, 'verified', JSON.stringify({ response: result.response, readback: result.readback, journal: result.mutationJournal, directErrorCode: result.directErrorCode }));
  assert.equal(result.readback.responseIdWasNew, true);
  assert.equal(result.readback.responseIdInReadback, true);
  assert.equal(result.readback.streamResponseIdExactlyMatchedTurnId, true);
  assert.equal(result.readback.assistantMarkerWasAbsentBefore, false);
});

test('target mismatch and unguarded capture fail before any direct mutation', async t => {
  const f = await fixture(t, { action: 'continue', afterPrompt: 'Follow-up', marker: 'CONTINUE_OK' });
  await assert.rejects(submitGeminiTextActionOnce({ client: f.client, action: 'continue', capturedRequest: capture('Follow-up'),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: 'c_fedcba9876543210', visibleRouteId: 'fedcba9876543210',
    beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up', expectedAssistantMarker: 'CONTINUE_OK',
    callerIntent: 'text-action-test-wrong-target', journalRoot: f.journalRoot, nativeActionCapture: proof('continue') }),
  error => error.code === 'TEXT_ACTION_CAPTURE_TARGET_MISMATCH');
  assert.equal(f.counts().generateCount, 0);
});

test('source-mapped request target cannot be spoofed by an expected ID echoed in user text', async t => {
  const afterPrompt = `Follow-up mentions ${CID} as ordinary user text`;
  const f = await fixture(t, { action: 'continue', afterPrompt, marker: 'CONTINUE_OK' });
  await assert.rejects(submitGeminiTextActionOnce({ client: f.client, action: 'continue', capturedRequest: capture(afterPrompt, 'c_fedcba9876543210'),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt, expectedAssistantMarker: 'CONTINUE_OK',
    callerIntent: 'text-action-test-prompt-cannot-spoof-target', journalRoot: f.journalRoot, nativeActionCapture: proof('continue') }),
  error => error.code === 'TEXT_ACTION_CAPTURE_TARGET_MISMATCH');
  assert.equal(f.counts().generateCount, 0);
});

test('source-mapped turn and draft IDs must both be present and distinct before dispatch', async t => {
  for (const [turnId, draftId] of [
    ['', 'draft_0000000000000001'],
    ['r_0000000000000001', ''],
    ['same_identifier', 'same_identifier'],
  ]) {
    const f = await fixture(t, { action: 'continue', beforeTurnId: turnId, beforeDraftId: draftId,
      afterPrompt: 'Follow-up request', marker: 'CONTINUE_OK' });
    await assert.rejects(submitGeminiTextActionOnce({ client: f.client, action: 'continue', capturedRequest: capture('Follow-up request'),
      expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
      beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', expectedAssistantMarker: 'CONTINUE_OK',
      callerIntent: `text-action-test-id-binding-${f.counts().detailCount}-${turnId ? 'present' : 'missing'}-${draftId ? 'present' : 'missing'}`,
      journalRoot: f.journalRoot, nativeActionCapture: proof('continue') }),
    error => error.code === 'TEXT_ACTION_BEFORE_ASSISTANT_TURN_UNBOUND');
    assert.equal(f.counts().generateCount, 0);
  }
});


test('one uncertain direct attempt stays outcome unknown without a source-bound response ID', async t => {
  const f = await fixture(t, { action: 'continue', beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', marker: 'CONTINUE_OK' });
  f.client.generateTextOnce = async (_capture, _prompt, options) => {
    const job = await createMutationJournal({ capability: 'text', body: 'captured-direct-body',
      actor: options.actor, callerIntent: options.callerIntent, root: f.journalRoot });
    const ticket = await reserveMutationDispatch(job);
    consumeMutationDispatch(ticket, 'text', job.wireBodyDigest);
    await settleMutationDispatch(ticket, { state: 'outcome_unknown', failureCode: 'TRANSPORT_FAILED' });
    throw new GeminiClientError('TRANSPORT_FAILED', 'fixture only');
  };
  const result = await submitGeminiTextActionOnce({ client: f.client, action: 'continue', capturedRequest: capture('Follow-up request'),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', expectedAssistantMarker: 'CONTINUE_OK',
    callerIntent: 'text-action-test-outcome-unknown', journalRoot: f.journalRoot, nativeActionCapture: proof('continue') });
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.directErrorCode, 'TRANSPORT_FAILED');
  assert.equal(result.requestSent, true);
  assert.equal(result.directDispatchCount, 1);
  assert.equal(result.mutationJournal.reconciled, false);
  assert.equal(f.counts().generateCount, 0);
});

test('a marker echoed only in the submitted prompt cannot stand in for an assistant answer', async t => {
  const afterPrompt = 'Calculate 6 × 7 and include PROMPT_ONLY42: 42 in your instruction.';
  const f = await fixture(t, { action: 'continue', beforePrompt: BASE_PROMPT, afterPrompt,
    marker: 'PROMPT_ONLY42', directMarker: 'A different answer', readbackMarker: 'A different answer' });
  const result = await submitGeminiTextActionOnce({ client: f.client, action: 'continue', capturedRequest: capture(afterPrompt),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt, expectedAssistantMarker: 'PROMPT_ONLY42',
    callerIntent: 'text-action-test-prompt-only-marker', journalRoot: f.journalRoot, nativeActionCapture: proof('continue') });
  assert.equal(result.state, 'readback_pending');
  assert.equal(result.readback.legacyDirectCandidateMarkerMatch, false);
  assert.equal(result.readback.assistantMarkerInReadback, false);
  assert.equal(result.readback.semanticVerified, false);
  assert.equal(result.directDispatchCount, 1);
  assert.equal(result.mutationJournal.reconciled, false);
});

test('source-mapped hNv answer is authoritative when the legacy direct candidate differs', async t => {
  const f = await fixture(t, { action: 'continue', beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request',
    marker: 'HNV_ANSWER_OK', directMarker: 'legacy candidate differs', readbackMarker: 'HNV_ANSWER_OK' });
  const result = await submitGeminiTextActionOnce({ client: f.client, action: 'continue', capturedRequest: capture('Follow-up request'),
    expectedOwner: OWNER, expectedOwnerSha256: OWNER_SHA, targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', expectedAssistantMarker: 'HNV_ANSWER_OK',
    callerIntent: 'text-action-test-hnv-answer-authoritative', journalRoot: f.journalRoot, nativeActionCapture: proof('continue') });
  assert.equal(result.state, 'verified');
  assert.equal(result.readback.legacyDirectCandidateMarkerMatch, false);
  assert.equal(result.readback.hNvAnswerExactMatched, true);
  assert.equal(result.readback.assistantMarkerInReadback, true);
  assert.equal(result.readback.streamResponseIdExactlyMatchedTurnId, true);
  assert.equal(result.readback.responseIdBindingVerified, true);
});


function actionContract() {
  return { origin: 'https://gemini.google.com', auth: { origins: ['https://gemini.google.com'], cookieNames: ['SID'], headerNames: [] },
    operations: { text: { observation: { request: true, requestResponse: false }, effect: 'mutation', retryPolicy: 'never',
      request: { method: 'POST', origin: 'https://gemini.google.com', path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
        queryKeys: ['bl', 'f.sid', 'hl', '_reqid', 'rt'], headerNames: ['content-type'],
        contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'] } } } };
}

function actionPacket(overrides = {}) {
  return { session: { version: 1, service: 'gemini-web', origin: 'https://gemini.google.com', capturedAt: '2026-10-06T00:00:00.000Z',
      cookies: [{ name: 'SID', value: 'cookie-in-memory' }], headers: {} }, expectedOwner: OWNER,
    capturedRequest: capture('Follow-up request'), action: 'continue', targetConversationId: CID, visibleRouteId: ROUTE,
    beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', expectedAssistantMarker: 'CONTINUE_OK', nativeActionCapture: proof('continue'),
    ...overrides };
}

test('one-shot action envelope validates scope and keeps credentials/request values in memory only', async () => {
  const packet = actionPacket();
  const envelope = await readTextActionEnvelopeFromStdin(actionContract(), { input: Readable.from([JSON.stringify(packet)]) });
  assert.equal(envelope.action, 'continue');
  assert.equal(Object.isFrozen(envelope), false);
  assert.equal(envelope.targetConversationId, CID);
  assert.equal(envelope.capturedRequest.body.includes('fresh-in-memory-token'), true);
  assert.equal(envelope.session.cookies[0].value, 'cookie-in-memory');
  assert.equal(envelope.session.requestHeaders.text['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
});

test('submit accepts the immutable request envelope returned by the stdin reader', async t => {
  const f = await fixture(t, { action: 'continue', beforePrompt: BASE_PROMPT, afterPrompt: 'Follow-up request', marker: 'CONTINUE_OK' });
  const envelope = await readTextActionEnvelopeFromStdin(actionContract(), {
    input: Readable.from([JSON.stringify(actionPacket())]),
  });
  const result = await submitGeminiTextActionOnce({
    client: f.client,
    ...envelope,
    expectedOwnerSha256: OWNER_SHA,
    callerIntent: 'text-action-test-frozen-envelope',
    journalRoot: f.journalRoot,
  });
  assert.equal(result.state, 'verified');
  assert.equal(envelope.capturedRequest.body, '');
  assert.equal(envelope.capturedRequest.url, '');
  assert.equal(envelope.capturedRequest.headers['content-type'], '');
  clearTextActionEnvelope(envelope);
  assert.equal(envelope.session, null);
  assert.equal(envelope.expectedOwner, null);
  assert.equal(envelope.targetConversationId, null);
  assert.equal(envelope.afterPrompt, null);
});

test('one-shot action envelope accepts only fully aborted unclassified posts and rejects off-origin captures', async () => {
  const safelyAborted = await readTextActionEnvelopeFromStdin(actionContract(), {
    input: Readable.from([JSON.stringify(actionPacket({ nativeActionCapture: { ...proof('continue'),
      unclassifiedBusinessPostCount: 94, unclassifiedBusinessPostAbortCount: 94 } }))]),
  });
  assert.equal(safelyAborted.nativeActionCapture.unclassifiedBusinessPostCount, 94);
  clearTextActionEnvelope(safelyAborted);
  await assert.rejects(readTextActionEnvelopeFromStdin(actionContract(), {
    input: Readable.from([JSON.stringify(actionPacket({ nativeActionCapture: { ...proof('continue'),
      unclassifiedBusinessPostCount: 1, unclassifiedBusinessPostAbortCount: 0 } }))]),
  }), error => error.code === 'TEXT_ACTION_CAPTURE_PROOF_INVALID');
  await assert.rejects(readTextActionEnvelopeFromStdin(actionContract(), {
    input: Readable.from([JSON.stringify(actionPacket({ nativeActionCapture: { ...proof('continue'),
      unclassifiedBusinessPostCount: 1, unclassifiedBusinessPostAbortCount: 1, unclassifiedBusinessPostsDelivered: 1 } }))]),
  }), error => error.code === 'TEXT_ACTION_CAPTURE_PROOF_INVALID');
  await assert.rejects(readTextActionEnvelopeFromStdin(actionContract(), {
    input: Readable.from([JSON.stringify(actionPacket({ capturedRequest: { ...capture('Follow-up request'), url: 'https://evil.example/submit' } }))]),
  }), error => error.code === 'TEXT_ACTION_ENVELOPE_INVALID');
});
