import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { submitGrokImagineImage, submitGrokImagineVideo, submitProvisionalCapturedGrokVideoOnce,
  reconcileUnknownGrokVideoOnce } from '../src/grok-media-operations.mjs';
import {
  buildGrokImagineImageFrames,
  buildGrokImagineVideoCreateBody,
  GROK_MEDIA_PRIVATE_ASSET_DATA,
  GROK_MEDIA_PRIVATE_RESPONSE_IDS,
  GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS,
} from '../src/grok-media-api.mjs';
import { OperationJournal } from '../src/journal.mjs';
import { ProtectedJsonStore } from '../src/protected-json-store.mjs';
import { grokVideoNoWireProofDigest } from '../src/grok-media-no-wire-proof.mjs';

function memoryOperationJournal() {
  return new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
}

function fakeJournal() {
  const calls = [];
  return {
    calls,
    async begin(input) { calls.push({ kind: 'begin', input }); return { intentId: '00000000-0000-4000-8000-000000000001' }; },
    async transition(intentId, state, options) { calls.push({ kind: 'transition', intentId, state, options }); return { state }; },
  };
}

function fakeMediaApi({ type, count }) {
  const reads = [];
  const assets = Array.from({ length: count }, (_, index) => {
    const assetId = `private-id-${index}`;
  const asset = {
      mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
      name: type === 'image' ? `image-${index}.jpg` : 'generated_video.mp4',
      isPublic: false,
      isModelGenerated: true,
      createTime: new Date().toISOString(),
    };
    Object.defineProperty(asset, GROK_MEDIA_PRIVATE_ASSET_DATA, {
      enumerable: false,
      value: Object.freeze({
        assetId,
        responseId: 'private-assistant-response-0001',
        sourceConversationId: 'private-conversation-id-0001',
        rootAssetSourceConversationId: null,
        key: `users/owner/generated/${assetId}.jpg`,
        ownerUserId: null,
      }),
    });
    return asset;
  });
  return {
    reads,
    assets,
    async getImagineQuota() { return { modes: { imagePro: { available: true }, video: { available: true } } }; },
    async captureAssetSnapshot() { return { complete: true, assetIds: new Set(['old-id']), capturedAt: Date.now() }; },
    async readBackNewAssets(_snapshot, options = {}) {
      reads.push({ verifying: typeof options.verifyAsset === 'function' });
      const selected = options.assetIds
        ? assets.filter(asset => options.assetIds.includes(asset[GROK_MEDIA_PRIVATE_ASSET_DATA].assetId))
        : assets;
      if (options.assetIds && selected.length !== options.assetIds.length) return { verified: false, assets: selected };
      if (typeof options.verifyAsset === 'function') {
        const mediaVerifications = [];
        for (const asset of selected) mediaVerifications.push(await options.verifyAsset(asset));
        return {
          verified: true,
          assets: selected,
          mediaVerifications,
        };
      }
      return { verified: true, assets: selected };
    },
    async readConversationEvidence({ conversationId, expectedPrompt }) {
      const evidence = {
        conversationMatch: conversationId === 'private-conversation-id-0001',
        promptExactMatch: expectedPrompt === 'neutral geometric test',
        uniqueUserPromptCount: 1,
        promptSha256: 'a'.repeat(64),
        responseCount: 2,
      };
      Object.defineProperty(evidence, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
        enumerable: false,
        value: Object.freeze({ all: Object.freeze(['private-user-response-0001', 'private-assistant-response-0001']),
          matchingPrompt: Object.freeze(['private-user-response-0001', 'private-assistant-response-0001']) }),
      });
      return evidence;
    },
  };
}

function ownerClient(submit) {
  return {
    submit,
    async status() { return { session: { ownerVerified: true } }; },
  };
}

function ownerSessionPersistence() {
  return {
    async read() {
      return {
        kind: 'grok-session',
        session: {
          generation: 'gen-1',
          ownerBinding: { generation: 'gen-1', identityDigest: 'a'.repeat(64) },
        },
      };
    },
  };
}

function ownerAssetRequestContext(cookieValue = 'test-owner-cookie') {
  return {
    schemaVersion: 1,
    source: 'normal_ui_asset_request',
    ownerIdentityDigest: 'a'.repeat(64),
    assetOrigin: 'https://assets.grok.com',
    pathClass: '/users/*/generated/*',
    method: 'GET',
    observedCookieNames: ['sso'],
    cookies: [{ name: 'sso', value: cookieValue, domain: '.grok.com', path: '/', secure: true, httpOnly: true }],
    headers: {
      referer: 'https://grok.com/',
      'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
      'sec-ch-ua-platform': '"Linux"',
    },
  };
}

function provisionalTransportOptions({ prompt, intentId, transportEvidence, mediaCount = 1 } = {}) {
  const bodyText = JSON.stringify(buildGrokImagineVideoCreateBody({ prompt }));
  let operationEntry;
  let intentState = 'prepared';
  let persistedProof = null;
  const intentSha = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const intentJournal = {
    async begin({ intentId: id }) { return { intentId: id, operation: 'media.video.create', state: 'prepared', attemptNumber: 1,
      payloadProfile: 'video-6s-480p-no-audio', promptLength: prompt.length, promptSha256: intentSha,
      ownerIdentityDigest: 'a'.repeat(64) }; },
    async get(id) {
      return { intentId: id, operation: 'media.video.create', state: intentState, attemptNumber: 1,
        payloadProfile: 'video-6s-480p-no-audio', promptLength: prompt.length, promptSha256: intentSha,
        ownerIdentityDigest: 'a'.repeat(64) };
    },
    async transition(_id, state) { intentState = state; return { state }; },
    async recoverVerifiedNoWire({ operationJournal: source, localOperationId }) {
      const entry = await source.get(localOperationId);
      assert.equal(entry.state, 'rejected');
      assert.equal(entry.videoNoWireProof.requestStarted, false);
      intentState = 'prepared';
      return { state: intentState, recoveryRecorded: true };
    },
  };
  const operationJournal = {
    async begin({ contractId, requestDigest, intentDigest }) {
      operationEntry = { localOperationId: '00000000-0000-4000-8000-000000000990', contractId,
        requestDigest, intentDigest, state: 'sending', attemptCount: 1 };
      return operationEntry;
    },
    async list() { return operationEntry ? [operationEntry] : []; },
    async get(id) { return operationEntry?.localOperationId === id ? operationEntry : null; },
    async transition(id, state) { operationEntry.state = state; return { state }; },
    async rejectMediaVideoNoWireAttempt(id, proof) {
      assert.equal(operationEntry.localOperationId, id);
      operationEntry.state = 'rejected';
      operationEntry.reasonCode = 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED';
      operationEntry.httpStatus = null;
      operationEntry.videoNoWireProof = proof;
      persistedProof = proof;
      return { noWireProofPersisted: true };
    },
  };
  return {
    operationJournal,
    intentJournal,
    get operationEntry() { return operationEntry; },
    get intentState() { return intentState; },
    get persistedProof() { return persistedProof; },
    options: {
      client: ownerClient(),
      sessionPersistence: { async read() {
        return { kind: 'grok-session', session: {
          generation: 'gen-1', ownerBinding: { generation: 'gen-1', identityDigest: 'a'.repeat(64) },
          origins: [{ origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'test-owner-cookie', origin: 'https://grok.com',
            domain: 'grok.com', path: '/', secure: true }], headers: [] }],
        } };
      } },
      mediaApi: fakeMediaApi({ type: 'video', count: mediaCount }),
      operationJournal,
      intentJournal,
      intentId,
      prompt,
      confirm: true,
      capturedRequest: {
        intentId, method: 'POST', path: '/rest/app-chat/conversations/new', browserAbortVerified: true,
        serverWritesDelivered: 0, ssoCookieObserved: true, bodyText,
        headers: { 'x-statsig-id': 'safe-statsig-id', 'x-xai-request-id': 'safe-request-id' },
        ordinaryHeaders: { accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
          referer: 'https://grok.com/imagine', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
          'sec-ch-ua-platform': '"Linux"' },
      },
      assetRequestContext: ownerAssetRequestContext('test-owner-cookie'),
      fetchImpl: async () => {
        throw Object.assign(new Error('private transport detail'), {
          code: 'MEDIA_VIDEO_CFFI_REQUEST_FAILED',
          details: { helperErrorCode: transportEvidence?.requestStarted === true ? 'CFFI_REQUEST_FAILED' : 'CFFI_SESSION_CREATE_FAILED', transportEvidence,
            partialResources: { requestIds: [], conversationIds: [], responseIds: [], assetIds: [], itemIds: [], postIds: [] } },
        });
      },
      readbackTimeoutMs: 1_000,
      readbackIntervalMs: 250,
    },
  };
}

test('video asset count plus magic cannot complete without direct resource correlation', async () => {
  let submits = 0;
  const journal = fakeJournal();
  const operationJournalCalls = [];
  const mediaApi = fakeMediaApi({ type: 'video', count: 1 });
  const result = await submitGrokImagineVideo({
    client: ownerClient(async (operationId, input, options) => {
      submits++;
      assert.equal(operationId, 'media.video.create');
      assert.equal(input.prompt, 'neutral geometric test');
      assert.equal(options.confirm, true);
      assert.equal(options.intentId, '00000000-0000-4000-8000-000000000001');
      return { localOperationId: 'local-operation-one', state: 'needs_review', httpStatus: 200 };
    }),
    mediaApi,
    sessionPersistence: ownerSessionPersistence(),
    intentJournal: journal,
    operationJournal: {
      async list() { return []; },
      async transition(...args) { operationJournalCalls.push(args); },
    },
    intentId: '00000000-0000-4000-8000-000000000001',
    prompt: 'neutral geometric test',
    confirm: true,
    readbackTimeoutMs: 1_000,
    readbackIntervalMs: 250,
    verifyAsset: async asset => ({ mimeType: asset.mimeType, bodyBytes: 4096, magicVerified: true }),
  });
  assert.equal(submits, 1);
  assert.equal(result.state, 'needs_review');
  assert.equal(result.writeRequestsSent, 1);
  assert.equal(result.readbackVerified, false);
  assert.equal(operationJournalCalls.length, 0);
  assert.equal(journal.calls.at(-1).state, 'needs_review');
});

test('video refuses a missing explicit confirmation before owner read or journal creation', async () => {
  let ownerReads = 0;
  const client = { async status() { ownerReads++; return { session: { ownerVerified: true } }; } };
  const journal = fakeJournal();
  await assert.rejects(submitGrokImagineVideo({
    client,
    mediaApi: fakeMediaApi({ type: 'video', count: 1 }),
    intentJournal: journal,
    prompt: 'neutral geometric test',
  }), { code: 'MEDIA_WRITE_CONFIRMATION_REQUIRED' });
  assert.equal(ownerReads, 0);
  assert.equal(journal.calls.length, 0);
});

test('video network uncertainty is held after one submit attempt with read-only reconciliation', async () => {
  const journal = fakeJournal();
  let journalListCalls = 0;
  const operationJournal = {
    async list() {
      journalListCalls++;
      return journalListCalls === 1 ? [] : [{ localOperationId: 'local-unknown', contractId: 'media.video.create', state: 'outcome_unknown' }];
    },
    async transition() { throw new Error('must not mark incomplete readback complete'); },
  };
  const mediaApi = {
    async getImagineQuota() { return { modes: { video: { available: true } } }; },
    async captureAssetSnapshot() { return { complete: true, assetIds: new Set(['old']) }; },
    async readBackNewAssets() { return { verified: false, assets: [] }; },
  };
  let submits = 0;
  const result = await submitGrokImagineVideo({
    client: ownerClient(async () => {
      submits++;
      throw Object.assign(new Error('transport'), { code: 'HTTP_TRANSPORT_FAILED' });
    }),
    mediaApi,
    sessionPersistence: ownerSessionPersistence(),
    intentJournal: journal,
    operationJournal,
    intentId: '00000000-0000-4000-8000-000000000002',
    prompt: 'neutral geometric test',
    confirm: true,
    readbackTimeoutMs: 1_000,
    readbackIntervalMs: 250,
  });
  assert.equal(submits, 1);
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.writeRequestsSent, 1);
  assert.equal(journal.calls.at(-1).state, 'outcome_unknown');
});

test('provisional captured video forwards the exact aborted body and only the two fresh SDK headers once', async () => {
  const prompt = 'neutral geometric test';
  const intentTransitions = [];
  const intentJournal = {
    async get(intentId) {
      return {
        intentId, operation: 'media.video.create', state: 'prepared', attemptNumber: 1,
        payloadProfile: 'video-6s-480p-no-audio', promptLength: prompt.length,
        promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'), ownerIdentityDigest: 'a'.repeat(64),
      };
    },
    async begin() { throw new Error('must consume the existing prepared intent'); },
    async transition(_intentId, state, options) { intentTransitions.push({ state, options }); return { state }; },
  };
  const operationJournalCalls = [];
  const operationJournal = {
    async begin(input) {
      assert.equal(input.contractId, 'media.video.create');
      assert.match(input.requestDigest, /^[a-f0-9]{64}$/);
      assert.match(input.intentDigest, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(input), /neutral geometric test|fresh-statsig-value|fresh-xai-request-value/);
      return { localOperationId: 'provisional-local-operation', state: 'sending' };
    },
    async transition(...args) { operationJournalCalls.push(args); },
    async list() { return []; },
  };
  const capturedBody = buildGrokImagineVideoCreateBody({ prompt });
  const capturedBodyText = JSON.stringify(capturedBody);
  const sessionPersistence = {
    async read() {
      return {
        kind: 'grok-session',
        session: {
          generation: 'gen-1',
          ownerBinding: { generation: 'gen-1', identityDigest: 'a'.repeat(64) },
          origins: [{
            origin: 'https://grok.com',
            cookies: [{ name: 'sso', value: 'ephemeral-sso-test-value', origin: 'https://grok.com', domain: 'grok.com', path: '/', secure: true }],
            headers: [],
          }],
        },
      };
    },
  };
  let fetchCalls = 0;
  let forwardedBody;
  let forwardedHeaders;
  const result = await submitProvisionalCapturedGrokVideoOnce({
    client: ownerClient(),
    sessionPersistence,
    mediaApi: fakeMediaApi({ type: 'video', count: 1 }),
    operationJournal,
    intentJournal,
    intentId: '00000000-0000-4000-8000-000000000501',
    prompt,
    confirm: true,
    capturedRequest: {
      intentId: '00000000-0000-4000-8000-000000000501',
      method: 'POST',
      path: '/rest/app-chat/conversations/new',
      browserAbortVerified: true,
      serverWritesDelivered: 0,
      ssoCookieObserved: true,
      bodyText: capturedBodyText,
      headers: { 'x-statsig-id': 'fresh-statsig-value', 'x-xai-request-id': 'fresh-xai-request-value' },
      ordinaryHeaders: {
        accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
        referer: 'https://grok.com/imagine', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
        'sec-ch-ua-platform': '"Linux"',
      },
    },
    assetRequestContext: ownerAssetRequestContext('ephemeral-sso-test-value'),
    fetchImpl: async (_url, options) => {
      fetchCalls++;
      forwardedBody = options.body;
      forwardedHeaders = options.headers;
      return new Response(JSON.stringify({ conversationId: 'private-conversation-id', status: 'accepted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    readbackTimeoutMs: 1_000,
    readbackIntervalMs: 250,
    verifyAsset: async asset => ({ mimeType: asset.mimeType, bodyBytes: 3072, magicVerified: true }),
  });
  assert.equal(fetchCalls, 1);
  assert.equal(forwardedBody, capturedBodyText);
  assert.equal(forwardedHeaders.get('x-statsig-id'), 'fresh-statsig-value');
  assert.equal(forwardedHeaders.get('x-xai-request-id'), 'fresh-xai-request-value');
  assert.equal(forwardedHeaders.get('cookie'), 'sso=ephemeral-sso-test-value');
  assert.equal(result.state, 'needs_review');
  assert.equal(result.readbackVerified, false);
  assert.deepEqual(intentTransitions.map(item => item.state), ['sending', 'accepted', 'needs_review']);
  assert.deepEqual(result.responseShape.topLevelFieldNames, ['status']);
  assert.doesNotMatch(JSON.stringify(result), /private-conversation-id|fresh-statsig-value|fresh-xai-request-value|ephemeral-sso-test-value/);
  assert.notEqual(operationJournalCalls.at(-1)?.[1], 'completed');
});

test('image-reference video uses its distinct prepared profile, exact owner image, and history input link once', async () => {
  const prompt = 'A teal sphere rolls slowly beside a still white cube in a quiet studio.';
  const intentId = '00000000-0000-4000-8000-000000000550';
  const referenceAssetId = 'private-source-image-0001';
  const referencePromptSha256 = 'c'.repeat(64);
  const outputConversationId = 'private-conversation-id-0001';
  const outputResponseId = 'private-assistant-response-0001';
  const outputAssetId = 'private-id-0';
  const body = {
    enableImageStreaming: true,
    enableSideBySide: true,
    kind: 'CONVERSATION_KIND_IMAGINE',
    mediaGenInput: { imageToVideo: {
      prompt, inputAssets: [referenceAssetId], aspectRatio: '2:3', duration: 6,
      resolutionName: '480p', mode: 'custom', skipAudio: true,
    } },
    message: `${prompt} --mode=custom`,
    modelName: 'imagine-video-gen',
    responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } },
    sendFinalMetadata: true,
  };
  const intentTransitions = [];
  const intentJournal = {
    async get(id) {
      return { intentId: id, operation: 'media.video.create', state: 'prepared', attemptNumber: 1,
        payloadProfile: 'video-image-reference-6s-480p-no-audio', promptLength: prompt.length,
        promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'), ownerIdentityDigest: 'a'.repeat(64) };
    },
    async transition(_id, state, options) { intentTransitions.push({ state, options }); return { state }; },
    async begin() { throw new Error('prepared image-reference intent must be reused'); },
  };
  const operationTransitions = [];
  const operationJournal = {
    async begin(input) {
      assert.equal(input.contractId, 'media.video.create');
      return { localOperationId: 'image-reference-video-operation', state: 'sending' };
    },
    async transition(...args) { operationTransitions.push(args); return { state: args[1] }; },
    async list() { return []; },
  };
  const mediaApi = fakeMediaApi({ type: 'video', count: 1 });
  const captureAssetSnapshot = mediaApi.captureAssetSnapshot.bind(mediaApi);
  mediaApi.captureAssetSnapshot = async () => ({ ...(await captureAssetSnapshot()), assetIds: new Set(['old-id', referenceAssetId]) });
  mediaApi.verifyOwnedGeneratedImageReference = async ({ assetId, expectedPromptSha256 }) => ({
    verified: assetId === referenceAssetId && expectedPromptSha256 === referencePromptSha256,
    mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true,
    asset: { mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true },
  });
  const readConversationEvidence = mediaApi.readConversationEvidence.bind(mediaApi);
  mediaApi.readConversationEvidence = async input => {
    const evidence = await readConversationEvidence(input);
    const linked = { ...evidence,
      promptExactMatch: input.expectedPrompt === prompt,
      promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
      referenceAssetMatched: input.expectedReferenceAssetId === referenceAssetId };
    Object.defineProperty(linked, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
      enumerable: false, value: evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS],
    });
    Object.defineProperty(linked, GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS, {
      enumerable: false, value: Object.freeze([referenceAssetId]),
    });
    return linked;
  };
  const sessionPersistence = {
    async read() {
      return { kind: 'grok-session', session: {
        generation: 'gen-1', ownerBinding: { generation: 'gen-1', identityDigest: 'a'.repeat(64) },
        origins: [{ origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'ephemeral-sso-test-value',
          origin: 'https://grok.com', domain: 'grok.com', path: '/', secure: true }], headers: [] }],
      } };
    },
  };
  let calls = 0;
  const result = await submitProvisionalCapturedGrokVideoOnce({
    client: ownerClient(), sessionPersistence, mediaApi, operationJournal, intentJournal,
    intentId, prompt, generationMode: 'image_reference', referenceAssetId, referencePromptSha256,
    confirm: true, capturedRequest: {
      intentId, method: 'POST', path: '/rest/app-chat/conversations/new', browserAbortVerified: true,
      serverWritesDelivered: 0, ssoCookieObserved: true, bodyText: JSON.stringify(body),
      headers: { 'x-statsig-id': 'fresh-statsig-value', 'x-xai-request-id': 'fresh-xai-request-value' },
      ordinaryHeaders: { accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
        referer: 'https://grok.com/imagine/post/private-post-001?scope=asset&conversation=private-conversation-id-0001',
        'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36', 'sec-ch-ua-platform': '"Linux"' },
    },
    assetRequestContext: ownerAssetRequestContext('ephemeral-sso-test-value'),
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.body, JSON.stringify(body));
      return new Response(JSON.stringify({ conversationId: outputConversationId, responseId: outputResponseId,
        assetId: outputAssetId, status: 'accepted' }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    readbackTimeoutMs: 1_000, readbackIntervalMs: 250,
    verifyAsset: async asset => ({ mimeType: asset.mimeType, bodyBytes: 8192, magicVerified: true, sha256: 'b'.repeat(64) }),
  });
  assert.equal(calls, 1);
  assert.equal(result.state, 'completed');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.correlation.referenceInputLinked, true);
  assert.equal(result.correlation.writerResponseIdComparatorAvailable, true);
  assert.deepEqual(intentTransitions.map(item => item.state), ['sending', 'accepted', 'completed']);
  assert.equal(operationTransitions.at(-1)?.[1], 'completed');
  assert.doesNotMatch(JSON.stringify(result), /private-source-image|private-conversation-id|private-assistant-response|ephemeral-sso|fresh-statsig|fresh-xai/);
});

test('provisional video atomically records exact helper no-wire evidence and restores the same intent to prepared', async () => {
  const prompt = 'neutral setup failure test';
  const intentId = '00000000-0000-4000-8000-000000000991';
  const requestBodyBytes = Buffer.byteLength(JSON.stringify(buildGrokImagineVideoCreateBody({ prompt })));
  const transportEvidence = {
    stage: 'session_setup', requestStarted: false, responseReceived: false, httpStatus: null,
    contentType: null, httpVersion: 'other', responseBytesRead: 0, requestBodyBytes,
    cfMitigated: false, errorClass: 'TypeError', requestHeaderNames: ['accept','content-type','origin','referer',
      'sec-ch-ua-platform','user-agent','x-statsig-id','x-xai-request-id'], responseHeaderNames: [], cookieNamesUsed: [],
    source: 'curl_cffi-0.16.3-chrome150',
  };
  const setup = provisionalTransportOptions({ prompt, intentId, transportEvidence });
  const result = await submitProvisionalCapturedGrokVideoOnce(setup.options);
  assert.equal(result.state, 'pre_dispatch_failed');
  assert.equal(result.writeRequestsSent, 0);
  assert.equal(result.noWireProofPersisted, true);
  assert.equal(result.intentRecoveryRecorded, true);
  assert.deepEqual(result.transportEvidence, transportEvidence);
  assert.equal(setup.persistedProof.helperErrorCode, 'CFFI_SESSION_CREATE_FAILED');
  assert.equal(setup.persistedProof.requestDigest, setup.operationEntry.requestDigest);
  assert.equal(setup.persistedProof.intentDigest, setup.operationEntry.intentDigest);
  assert.equal(setup.persistedProof.responseReceived, false);
  assert.equal(setup.intentState, 'prepared');
  assert.equal(setup.operationEntry.state, 'rejected');
  assert.doesNotMatch(JSON.stringify(result), /private transport detail|test-owner-cookie|safe-statsig-id|neutral setup failure test/);
});

test('missing or post-start transport diagnostics stay outcome-unknown and never enter no-wire recovery', async () => {
  const prompt = 'neutral unknown transport test';
  const intentId = '00000000-0000-4000-8000-000000000992';
  const bodyBytes = Buffer.byteLength(JSON.stringify(buildGrokImagineVideoCreateBody({ prompt })));
  const cases = [
    { transportEvidence: null, expectedWrites: null },
    { transportEvidence: {
      stage: 'request', requestStarted: true, responseReceived: false, httpStatus: null,
      contentType: null, httpVersion: 'other', responseBytesRead: 0, requestBodyBytes: bodyBytes,
      cfMitigated: false, errorClass: 'ConnectionError', requestHeaderNames: ['accept','content-type','origin',
        'referer','sec-ch-ua-platform','user-agent','x-statsig-id','x-xai-request-id'], responseHeaderNames: [],
      cookieNamesUsed: ['sso'], source: 'curl_cffi-0.16.3-chrome150',
    }, expectedWrites: 1 },
  ];
  for (const [index, item] of cases.entries()) {
    const setup = provisionalTransportOptions({ prompt, intentId: `00000000-0000-4000-8000-00000000099${3 + index}`,
      transportEvidence: item.transportEvidence, mediaCount: 0 });
    const result = await submitProvisionalCapturedGrokVideoOnce(setup.options);
    assert.equal(result.state, 'outcome_unknown');
    assert.equal(result.writeRequestsSent, item.expectedWrites);
    assert.equal(result.transportEvidence?.requestStarted ?? null, item.transportEvidence?.requestStarted ?? null);
    assert.equal(setup.persistedProof, null);
    assert.equal(setup.operationEntry.state, 'outcome_unknown');
    assert.equal(setup.intentState, 'outcome_unknown');
  }
});

test('provisional video refuses an incomplete header capture or an added token field before any intent or HTTP call', async () => {
  const prompt = 'neutral geometric test';
  const journal = fakeJournal();
  let fetchCalls = 0;
  const base = {
    client: ownerClient(),
    sessionPersistence: { async read() { throw new Error('must not read session'); } },
    mediaApi: fakeMediaApi({ type: 'video', count: 1 }),
    operationJournal: { async begin() { throw new Error('must not write journal'); }, async transition() {}, async list() { return []; } },
    intentJournal: journal,
    intentId: '00000000-0000-4000-8000-000000000502',
    prompt,
    confirm: true,
    capturedRequest: {
      intentId: '00000000-0000-4000-8000-000000000502',
      method: 'POST', path: '/rest/app-chat/conversations/new',
      browserAbortVerified: true, serverWritesDelivered: 0, ssoCookieObserved: true,
      bodyText: JSON.stringify({ ...buildGrokImagineVideoCreateBody({ prompt }), castle_request_token: 'must-not-accept' }),
      headers: { 'x-statsig-id': 'fresh-statsig-value' },
      ordinaryHeaders: {
        accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
        referer: 'https://grok.com/imagine', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
        'sec-ch-ua-platform': '"Linux"',
      },
    },
    assetRequestContext: ownerAssetRequestContext(),
    fetchImpl: async () => { fetchCalls++; return new Response(); },
  };
  await assert.rejects(submitProvisionalCapturedGrokVideoOnce(base), { code: 'MEDIA_CAPTURE_HEADERS_INVALID' });
  assert.equal(fetchCalls, 0);
  assert.equal(journal.calls.length, 0);

  base.capturedRequest.headers['x-xai-request-id'] = 'fresh-xai-request-value';
  await assert.rejects(submitProvisionalCapturedGrokVideoOnce(base), { code: 'MEDIA_CAPTURE_BODY_SCHEMA_INVALID' });
  assert.equal(fetchCalls, 0);
  assert.equal(journal.calls.length, 0);
});

test('provisional video preserves safe CFFI response-stage telemetry and reconciles without retry', async () => {
  const prompt = 'neutral geometric test';
  const intentId = '00000000-0000-4000-8000-000000000601';
  const intentTransitions = [];
  const operationTransitions = [];
  const operationJournal = {
    async begin() { return { localOperationId: 'video-transport-unknown', state: 'sending' }; },
    async transition(...args) { operationTransitions.push(args); return { state: args[1] }; },
    async list() { return []; },
  };
  const intentJournal = {
    async begin() { return { intentId }; },
    async transition(_id, state, options) { intentTransitions.push({ state, options }); return { state }; },
  };
  const transportEvidence = {
    stage: 'response_body', requestStarted: true, responseReceived: true, httpStatus: 200,
    contentType: 'application/json', httpVersion: 'h2', responseBytesRead: 17, requestBodyBytes: 586,
    cfMitigated: false, errorClass: 'ConnectionError',
    requestHeaderNames: ['accept','content-type','origin','referer','sec-ch-ua-platform','user-agent','x-statsig-id','x-xai-request-id'],
    responseHeaderNames: ['content-length','content-type'], cookieNamesUsed: ['sso'],
    source: 'curl_cffi-0.16.3-chrome150',
  };
  const result = await submitProvisionalCapturedGrokVideoOnce({
    client: ownerClient(),
    sessionPersistence: {
      async read() {
        return { kind: 'grok-session', session: {
          generation: 'gen-1', ownerBinding: { generation: 'gen-1', identityDigest: 'a'.repeat(64) },
          origins: [{ origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'transport-test-sso',
            origin: 'https://grok.com', domain: 'grok.com', path: '/', secure: true }], headers: [] }],
        } };
      },
    },
    mediaApi: fakeMediaApi({ type: 'video', count: 1 }),
    operationJournal,
    intentJournal,
    intentId,
    prompt,
    confirm: true,
    capturedRequest: {
      intentId,
      method: 'POST',
      path: '/rest/app-chat/conversations/new',
      browserAbortVerified: true,
      serverWritesDelivered: 0,
      ssoCookieObserved: true,
      bodyText: JSON.stringify(buildGrokImagineVideoCreateBody({ prompt })),
      headers: { 'x-statsig-id': 'safe-statsig', 'x-xai-request-id': 'safe-request' },
      ordinaryHeaders: {
        accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
        referer: 'https://grok.com/imagine', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
        'sec-ch-ua-platform': '"Linux"',
      },
    },
    assetRequestContext: ownerAssetRequestContext('transport-test-sso'),
    fetchImpl: async () => {
      throw Object.assign(new Error('private exception details omitted'), {
        code: 'MEDIA_VIDEO_CFFI_REQUEST_FAILED',
        details: { helperErrorCode: 'CFFI_RESPONSE_STREAM_FAILED', transportEvidence,
          partialResources: { requestIds: [], conversationIds: ['private-conversation-id-0001'],
            responseIds: ['private-assistant-response-0001'], assetIds: [], itemIds: [], postIds: [] } },
      });
    },
    readbackTimeoutMs: 1_000,
    readbackIntervalMs: 250,
    verifyAsset: async asset => ({ mimeType: asset.mimeType, bodyBytes: 3072, magicVerified: true, sha256: 'c'.repeat(64) }),
  });
  assert.equal(result.writeRequestsSent, 1);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.transportEvidence, transportEvidence);
  assert.equal(result.correlation.writerResponseIdComparatorAvailable, true);
  assert.equal(result.correlation.directResourceLinkCount, 1);
  assert.equal(operationTransitions[0][2].httpStatus, 200);
  assert.equal(intentTransitions.at(-1).state, 'completed');
  assert.equal(JSON.stringify(result).includes('private exception details omitted'), false);
  assert.equal(JSON.stringify(result).includes('private-conversation-id-0001'), false);
  assert.equal(JSON.stringify(result).includes('private-assistant-response-0001'), false);
});

test('outcome-unknown video reconciles from unique prompt history and bytes when the writer response comparator is unavailable', async () => {
  const prompt = 'neutral geometric test';
  const intentId = '00000000-0000-4000-8000-000000000701';
  const ownerDigest = 'a'.repeat(64);
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const intentTransitions = [];
  const intentJournal = {
    async get(id) {
      return { intentId: id, operation: 'media.video.create', state: 'outcome_unknown', attemptNumber: 1,
        payloadProfile: 'video-6s-480p-no-audio', promptLength: prompt.length,
        promptSha256, ownerIdentityDigest: ownerDigest };
    },
    async transition(id, state, options) { intentTransitions.push({ id, state, options }); return { state }; },
  };
  const operationId = '00000000-0000-4000-8000-000000000702';
  const intentDigest = createHash('sha256').update(`media.video.create\n${ownerDigest}\n${intentId}`, 'utf8').digest('hex');
  const operationTransitions = [];
  const operationJournal = {
    async list() {
      return [{ localOperationId: operationId, contractId: 'media.video.create', state: 'outcome_unknown',
        attemptCount: 1, createdAt: new Date(Date.now() - 1_000).toISOString(), intentDigest }];
    },
    async transition(...args) { operationTransitions.push(args); return { state: args[1] }; },
  };
  const mediaApi = fakeMediaApi({ type: 'video', count: 1 });
  const readConversationEvidence = mediaApi.readConversationEvidence.bind(mediaApi);
  mediaApi.readConversationEvidence = async input => {
    const evidence = await readConversationEvidence(input);
    const adjusted = { ...evidence, promptSha256 };
    Object.defineProperty(adjusted, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
      enumerable: false,
      value: evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS],
    });
    return adjusted;
  };
  let downloads = 0;
  const result = await reconcileUnknownGrokVideoOnce({
    client: ownerClient(),
    sessionPersistence: ownerSessionPersistence(),
    mediaApi,
    operationJournal,
    intentJournal,
    intentId,
    prompt,
    assetRequestContext: ownerAssetRequestContext(),
    verifyAsset: async asset => {
      downloads++;
      return { mimeType: asset.mimeType, bodyBytes: 4096, magicVerified: true, sha256: 'b'.repeat(64) };
    },
  });
  assert.equal(downloads, 1);
  assert.equal(result.state, 'completed');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.directHttpStatus, null);
  assert.equal(result.reconciliationReadMethod, 'media.assets.list');
  assert.equal(result.correlation.writerResponseIdComparatorAvailable, false);
  assert.equal(result.correlation.assetResponseIdsMatchPrompt, true);
  assert.equal(result.correlation.createTimeBounded, true);
  assert.equal(operationTransitions.at(-1)[1], 'completed');
  assert.equal(operationTransitions.at(-1)[2].reconciledBy, 'media.assets.list');
  assert.equal(intentTransitions.at(-1).state, 'completed');
  assert.equal(JSON.stringify(result).includes('private-conversation-id-0001'), false);
});

test('HTTP 200 held video reconciliation accepts accepted intent and needs-review operation without inventing response IDs', async () => {
  const prompt = 'neutral geometric test';
  const intentId = '00000000-0000-4000-8000-000000000731';
  const ownerDigest = 'a'.repeat(64);
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const intentStates = [];
  const intentJournal = {
    async get(id) { return { intentId: id, operation: 'media.video.create', state: 'accepted', attemptNumber: 1,
      payloadProfile: 'video-6s-480p-no-audio', promptLength: prompt.length, promptSha256, ownerIdentityDigest: ownerDigest }; },
    async transition(_id, state, options) { intentStates.push({ state, options }); return { state }; },
  };
  const intentDigest = createHash('sha256').update(`media.video.create\n${ownerDigest}\n${intentId}`, 'utf8').digest('hex');
  const promptIdSha256 = createHash('sha256').update(intentId, 'utf8').digest('hex');
  const requestDigest = 'd'.repeat(64);
  const priorOperationId = '00000000-0000-4000-8000-000000000733';
  const priorProof = {
    schemaVersion: 1, operation: 'media.video.create', ownerIdentityDigest: ownerDigest,
    intentIdSha256: promptIdSha256, intentDigest, requestDigest,
    payloadProfile: 'video-6s-480p-no-audio', promptSha256,
    stage: 'validation', requestStarted: false, responseReceived: false,
    httpStatus: null, contentType: null, httpVersion: 'other', responseBytesRead: 0,
    requestBodyBytes: 700, cfMitigated: false, errorClass: null,
    helperErrorCode: 'TIMEOUT_INVALID', requestHeaderNames: [], responseHeaderNames: [], cookieNamesUsed: [],
    source: 'curl_cffi-0.16.3-chrome150',
  };
  const noWireRecovery = {
    schemaVersion: 1,
    priorOperationIdSha256: createHash('sha256').update(priorOperationId, 'utf8').digest('hex'),
    priorRequestDigest: requestDigest,
    priorProofDigest: grokVideoNoWireProofDigest(priorProof),
    ownerIdentityDigest: ownerDigest,
    intentIdSha256: promptIdSha256,
    payloadProfile: 'video-6s-480p-no-audio',
    promptSha256,
  };
  const operationTransitions = [];
  const operationJournal = {
    async list() { return [
      { localOperationId: priorOperationId, contractId: 'media.video.create', state: 'rejected',
        httpStatus: null, reasonCode: 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED', attemptCount: 1,
        createdAt: new Date(Date.now() - 2_000).toISOString(), intentDigest, requestDigest, videoNoWireProof: priorProof },
      { localOperationId: '00000000-0000-4000-8000-000000000732', contractId: 'media.video.create',
        state: 'needs_review', httpStatus: 200, reasonCode: 'CAPTURED_RESPONSE_SCHEMA_UNKNOWN',
        attemptCount: 1, createdAt: new Date(Date.now() - 1_000).toISOString(), intentDigest, requestDigest,
        videoNoWireRecovery: noWireRecovery },
    ]; },
    async transition(...args) { operationTransitions.push(args); return { state: args[1] }; },
  };
  const mediaApi = fakeMediaApi({ type: 'video', count: 1 });
  const readConversationEvidence = mediaApi.readConversationEvidence.bind(mediaApi);
  mediaApi.readConversationEvidence = async input => {
    const evidence = await readConversationEvidence(input);
    const adjusted = { ...evidence, promptSha256 };
    Object.defineProperty(adjusted, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
      enumerable: false, value: evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS],
    });
    return adjusted;
  };
  const result = await reconcileUnknownGrokVideoOnce({
    client: ownerClient(), sessionPersistence: ownerSessionPersistence(), mediaApi, operationJournal, intentJournal,
    intentId, prompt, assetRequestContext: ownerAssetRequestContext(),
    verifyAsset: async asset => ({ mimeType: asset.mimeType, bodyBytes: 4096, magicVerified: true, sha256: 'b'.repeat(64) }),
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.writeRequestsSent, 1);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.directHttpStatus, 200);
  assert.equal(result.reconciliationReadMethod, 'media.assets.list');
  assert.equal(result.correlation.writerResponseIdComparatorAvailable, false);
  assert.match(result.correlation.writerResponseIdComparatorReason, /HTTP success was journaled/);
  assert.equal(operationTransitions.at(-1)[1], 'completed');
  assert.equal(operationTransitions.at(-1)[2].httpStatus, 200);
  assert.equal(operationTransitions.at(-1)[2].reconciledBy, 'media.assets.list');
  assert.equal(intentStates.at(-1).state, 'completed');
  assert.equal(JSON.stringify(result).includes('private-assistant-response-0001'), false);
});

test('video byte readback failure retains only safe HTTP status and cause code', async () => {
  const prompt = 'neutral geometric test';
  const intentId = '00000000-0000-4000-8000-000000000741';
  const ownerDigest = 'a'.repeat(64);
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const intentStates = [];
  const intentJournal = {
    async get(id) { return { intentId: id, operation: 'media.video.create', state: 'accepted', attemptNumber: 1,
      payloadProfile: 'video-6s-480p-no-audio', promptLength: prompt.length, promptSha256, ownerIdentityDigest: ownerDigest }; },
    async transition(_id, state) { intentStates.push(state); return { state }; },
  };
  const intentDigest = createHash('sha256').update(`media.video.create\n${ownerDigest}\n${intentId}`, 'utf8').digest('hex');
  const operationJournal = {
    async list() { return [{ localOperationId: '00000000-0000-4000-8000-000000000742',
      contractId: 'media.video.create', state: 'needs_review', httpStatus: 200, attemptCount: 1,
      createdAt: new Date(Date.now() - 1_000).toISOString(), intentDigest }]; },
    async transition(_id, state) { return { state }; },
  };
  const mediaApi = fakeMediaApi({ type: 'video', count: 1 });
  const originalReadBack = mediaApi.readBackNewAssets.bind(mediaApi);
  let calls = 0;
  mediaApi.readBackNewAssets = async (snapshot, options) => {
    calls += 1;
    if (calls === 1) return originalReadBack(snapshot, options);
    throw Object.assign(new Error('private details omitted'), { code: 'MEDIA_MAGIC_CHECK_FAILED', details: {
      failureCode: 'MEDIA_ASSET_STATUS_UNEXPECTED', status: 403, contentType: 'text/html',
    } });
  };
  const originalEvidence = mediaApi.readConversationEvidence.bind(mediaApi);
  mediaApi.readConversationEvidence = async input => {
    const evidence = await originalEvidence(input);
    const adjusted = { ...evidence, promptSha256 };
    Object.defineProperty(adjusted, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
      enumerable: false, value: evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS],
    });
    return adjusted;
  };
  const result = await reconcileUnknownGrokVideoOnce({
    client: ownerClient(), sessionPersistence: ownerSessionPersistence(), mediaApi, operationJournal, intentJournal,
    intentId, prompt, assetRequestContext: ownerAssetRequestContext(),
  });
  assert.equal(calls, 2);
  assert.equal(result.state, 'needs_review');
  assert.equal(result.writeRequestsSent, 1);
  assert.deepEqual(result.readbackFailure, {
    errorCode: 'MEDIA_MAGIC_CHECK_FAILED', causeCode: 'MEDIA_ASSET_STATUS_UNEXPECTED',
    httpStatus: 403, contentType: 'text/html', errorClass: null,
  });
  assert.deepEqual(intentStates, ['needs_review']);
  assert.doesNotMatch(JSON.stringify(result), /private details omitted|private-conversation-id/);
});

test('outcome-unknown image-reference video reconciles from the exact owner image input link and bytes', async () => {
  const prompt = 'The teal sphere rolls beside the still white cube.';
  const sourcePromptSha256 = 'c'.repeat(64);
  const ownerDigest = 'a'.repeat(64);
  const intentId = '00000000-0000-4000-8000-000000000801';
  const sourceAssetId = 'private-source-image-for-video-0001';
  const outputAssetId = 'private-output-video-for-image-reference-0001';
  const sourceConversationId = 'private-source-image-conversation-0001';
  const outputConversationId = 'private-output-video-conversation-0001';
  const sourceResponseId = 'private-source-image-response-0001';
  const outputResponseId = 'private-output-video-response-0001';
  const createdAt = new Date().toISOString();
  const makeAsset = (fields, privateData) => {
    const asset = { isPublic: false, isModelGenerated: true, createTime: createdAt, ...fields };
    Object.defineProperty(asset, GROK_MEDIA_PRIVATE_ASSET_DATA, { enumerable: false, value: Object.freeze(privateData) });
    return asset;
  };
  const sourceAsset = makeAsset({ mimeType: 'image/jpeg', sizeBytes: 1024 }, {
    assetId: sourceAssetId, responseId: sourceResponseId, sourceConversationId, key: 'users/owner/generated/source.jpg',
    ownerUserId: 'private-owner-user', mediaGenInput: null,
  });
  const outputAsset = makeAsset({ mimeType: 'video/mp4', sizeBytes: 8192 }, {
    assetId: outputAssetId, responseId: outputResponseId, sourceConversationId: outputConversationId,
    key: 'users/owner/generated/video.mp4', ownerUserId: 'private-owner-user',
    mediaGenInput: { imageToVideo: { inputAssets: [sourceAssetId] } },
  });
  const assets = [sourceAsset, outputAsset];
  const mediaApi = {
    async readBackNewAssets() { throw new Error('exact asset path must not read the full list'); },
    async readAssetMetadata({ assetId }) { return assets.find(asset => asset[GROK_MEDIA_PRIVATE_ASSET_DATA].assetId === assetId); },
    async verifyExactAssets({ assets: selected, verifyAsset }) {
      const mediaVerifications = [];
      if (verifyAsset) for (const asset of selected) mediaVerifications.push(await verifyAsset(asset));
      return { verified: selected.length > 0, assets: selected, mediaVerifications };
    },
    async verifyOwnedGeneratedImageReference() { throw new Error('prior task receipt should avoid a redundant history read'); },
    async readConversationEvidence({ conversationId, expectedPrompt, expectedReferenceAssetId }) {
      if (conversationId === sourceConversationId) {
        const evidence = { conversationMatch: true, promptExactMatch: true, uniqueUserPromptCount: 1,
          promptSha256: sourcePromptSha256, responseCount: 1 };
        Object.defineProperty(evidence, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
          enumerable: false, value: Object.freeze({ all: Object.freeze([sourceResponseId]), matchingPrompt: Object.freeze([sourceResponseId]) }),
        });
        return evidence;
      }
      const evidence = { conversationMatch: conversationId === outputConversationId, promptExactMatch: expectedPrompt === prompt,
        uniqueUserPromptCount: 1, matchingUserPromptCount: 1,
        promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'), responseCount: 2,
        referenceAssetCount: 1, referenceAssetMatched: expectedReferenceAssetId === sourceAssetId };
      Object.defineProperty(evidence, GROK_MEDIA_PRIVATE_RESPONSE_IDS, {
        enumerable: false, value: Object.freeze({ all: Object.freeze(['private-user-response-0001', outputResponseId]),
          matchingPrompt: Object.freeze(['private-user-response-0001', outputResponseId]) }),
      });
      Object.defineProperty(evidence, GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS, {
        enumerable: false, value: Object.freeze([sourceAssetId]),
      });
      return evidence;
    },
  };
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const intentTransitions = [];
  const intentJournal = {
    async get() { return { operation: 'media.video.create', state: 'outcome_unknown', attemptNumber: 1,
      payloadProfile: 'video-image-reference-6s-480p-no-audio', promptLength: prompt.length,
      promptSha256, ownerIdentityDigest: ownerDigest }; },
    async transition(_id, state) { intentTransitions.push(state); return { state }; },
  };
  const intentDigest = createHash('sha256').update(`media.video.create\n${ownerDigest}\n${intentId}`, 'utf8').digest('hex');
  const operationTransitions = [];
  const operationJournal = {
    async list() { return [{ localOperationId: '00000000-0000-4000-8000-000000000802',
      contractId: 'media.video.create', state: 'outcome_unknown', createdAt,
      requestDigest: 'd'.repeat(64), intentDigest, attemptCount: 1 }]; },
    async transition(...args) { operationTransitions.push(args); return { state: args[1] }; },
  };
  const result = await reconcileUnknownGrokVideoOnce({
    client: ownerClient(), sessionPersistence: { async read() { return { kind: 'grok-session', session: {
      generation: 'g1', ownerBinding: { generation: 'g1', identityDigest: ownerDigest },
    } }; } },
    mediaApi, operationJournal, intentJournal, intentId, prompt, generationMode: 'image_reference',
    referenceAssetIdSha256: createHash('sha256').update(sourceAssetId, 'utf8').digest('hex'),
    referenceAssetId: sourceAssetId,
    referencePromptSha256: sourcePromptSha256, assetRequestContext: ownerAssetRequestContext(),
    candidateAssetId: outputAssetId,
    candidateAssetIdSha256: createHash('sha256').update(outputAssetId, 'utf8').digest('hex'),
    verifiedReferenceImageProof: {
      schemaVersion: 1, ownerIdentityDigest: ownerDigest,
      assetIdSha256: createHash('sha256').update(sourceAssetId, 'utf8').digest('hex'),
      promptSha256: sourcePromptSha256, artifactSha256: 'f'.repeat(64), bodyBytes: 1024,
      mimeType: 'image/jpeg', privateGenerated: true, sourceTaskHistoryVerified: true, sourceBytesVerified: true,
    },
    verifyAsset: async asset => ({ mimeType: asset.mimeType, bodyBytes: 8192, magicVerified: true, sha256: 'e'.repeat(64) }),
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.generationMode, 'image_reference');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.writeRequestsSent, null);
  assert.equal(result.reconciliationReadMethod, 'attachment.asset.read');
  assert.equal(result.correlation.writerResponseIdComparatorAvailable, false);
  assert.equal(result.correlation.referenceInputLinked, true);
  assert.equal(result.referenceImageProofSource, 'verified_prior_image_readback');
  assert.deepEqual(intentTransitions, ['completed']);
  assert.equal(operationTransitions.at(-1)[1], 'completed');
  assert.equal(operationTransitions.at(-1)[2].reconciledBy, 'attachment.asset.read');
  assert.doesNotMatch(JSON.stringify(result), /private-source-image|private-output-video|private-owner-user|private-conversation/);
});

test('image submit uses one direct WebSocket batch and completes only after readback and magic', async () => {
  const journal = fakeJournal();
  const mediaApi = fakeMediaApi({ type: 'image', count: 4 });
  const prompt = 'neutral geometric test';
  const frames = buildGrokImagineImageFrames({
    prompt,
    requestId: () => '00000000-0000-4000-8000-000000000303',
  });
  const requestId = frames[0].item.content[0].requestId;
  const sent = [];
  let closes = 0;
  const serverMessages = [{
    type: 'conversation.item.created',
    requestId,
    conversationId: 'private-conversation-id-0001',
    responseId: 'private-assistant-response-0001',
  }];
  const result = await submitGrokImagineImage({
    client: ownerClient(),
    operationJournal: memoryOperationJournal(),
    mediaApi,
    sessionPersistence: ownerSessionPersistence(),
    assetRequestContext: ownerAssetRequestContext(),
    cookieNames: ['sso'],
    intentJournal: journal,
    intentId: '00000000-0000-4000-8000-000000000003',
    prompt,
    capturedFrames: {
      frames,
      intentId: '00000000-0000-4000-8000-000000000003',
      serverForwarded: false,
      source: 'normal_ui_network_capture',
    },
    confirm: true,
    readbackTimeoutMs: 1_000,
    readbackIntervalMs: 250,
    verifyAsset: async asset => ({ mimeType: asset.mimeType, bodyBytes: 2048, magicVerified: true }),
    webSocketFactory: async options => {
      assert.equal(options.sessionPersistence !== undefined, true);
      return {
        sendJson(frame) { sent.push(frame); },
        async nextMessage() {
          if (serverMessages.length) return serverMessages.shift();
          throw Object.assign(new Error('timeout'), { code: 'MEDIA_WS_READ_TIMEOUT' });
        },
        close() { closes++; },
      };
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].item.content[0].properties.num_generations, 4);
  assert.equal(result.writeRequestsSent, 1);
  assert.equal(result.protocolFramesSent, 1);
  assert.equal(result.state, 'completed');
  assert.equal(result.assets.length, 4);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.correlation.verified, true);
  assert.equal(result.correlation.requestIdEchoed, true);
  assert.equal(result.correlation.assetResponseIdsMatchPrompt, true);
  assert.doesNotMatch(JSON.stringify(result), /private-conversation-id|private-assistant-response|neutral geometric test/);
  assert.equal(closes, 1);
  assert.equal(journal.calls.at(-1).state, 'completed');
});

test('image holds an unknown outcome after one attempted send and never resubmits', async () => {
  const journal = fakeJournal();
  const mediaApi = {
    async getImagineQuota() { return { modes: { imagePro: { available: true } } }; },
    async captureAssetSnapshot() { return { complete: true, assetIds: new Set() }; },
    async readBackNewAssets() { return { verified: false, assets: [] }; },
  };
  let sends = 0;
  const result = await submitGrokImagineImage({
    client: ownerClient(), operationJournal: memoryOperationJournal(), mediaApi, sessionPersistence: ownerSessionPersistence(),
    assetRequestContext: ownerAssetRequestContext(), cookieNames: ['sso'], intentJournal: journal,
    intentId: '00000000-0000-4000-8000-000000000004',
    prompt: 'neutral geometric test', capturedFrames: {
      frames: buildGrokImagineImageFrames({ prompt: 'neutral geometric test' }),
      intentId: '00000000-0000-4000-8000-000000000004',
      serverForwarded: false,
      source: 'normal_ui_network_capture',
    },
    confirm: true, readbackTimeoutMs: 1_000, readbackIntervalMs: 250,
    webSocketFactory: async () => ({
      sendJson() { sends++; }, async nextMessage() { throw Object.assign(new Error('timeout'), { code: 'MEDIA_WS_READ_TIMEOUT' }); }, close() {},
    }),
  });
  assert.equal(sends, 1);
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.writeRequestsSent, 1);
  assert.equal(journal.calls.at(-1).state, 'outcome_unknown');
});
