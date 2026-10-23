import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadContractRegistry, readinessMatrix } from '../src/client.mjs';
import { validateContractRegistry } from '../src/contracts.mjs';
import {
  buildCapturedGrokConversationCreateOperation,
  buildSourceGrokConversationCreateOperation,
  finalizeCapturedGrokConversationCreateOperation,
  installCapturedGrokConversationCreate,
  runGrokConversationCrudOnce,
} from '../src/grok-conversation-crud-once.mjs';

const createCapture = () => ({
  method: 'POST',
  origin: 'https://grok.com',
  path: '/rest/app-chat/conversations',
  contentType: 'application/json',
  sourceUrl: 'https://cdn.grok.com/_next/static/chunks/27akar72ihacg.js',
  sourceSha256: '8dcfb562e2b3f83f866c23c82f73503c52a409620c8830697d6cade848644759',
  sourceFunctionName: 'chatCreateConversationRaw',
  normalUiAdapterMatched: true,
  requestHeaderNames: ['content-type', 'cookie'],
  cookieNames: ['sso'],
  browserRequestAbortConfirmed: true,
  browserRequestReachedProvider: false,
  body: { systemPromptName: '', temporary: false },
  requestBodySha256: createHash('sha256').update('{"systemPromptName":"","temporary":false}', 'utf8').digest('hex'),
});

const createSource = () => ({
  sourceMode: 'first_party_sdk_contract',
  normalUiRequestObserved: false,
  normalUiAdapterMatched: true,
  sourceUrl: 'https://cdn.grok.com/_next/static/chunks/27akar72ihacg.js',
  sourceSha256: '8dcfb562e2b3f83f866c23c82f73503c52a409620c8830697d6cade848644759',
  sourceFunctionName: 'chatCreateConversationRaw',
  adapterSourceUrl: 'https://cdn.grok.com/_next/static/chunks/205b03gn_m2ip.js',
  adapterSourceSha256: '45e567d74dfd50b5a111359914000af956061ada3dc9e76531eec31c1c4dfeec',
  body: { systemPromptName: '', temporary: false },
  sourceBodySha256: createHash('sha256').update('{"systemPromptName":"","temporary":false}', 'utf8').digest('hex'),
});

const responseCheckpoint = operationId => ({
  operationId,
  requestDigest: 'a'.repeat(64),
  intentDigest: 'b'.repeat(64),
  serviceJobIdObserved: operationId === 'conversation.create',
  responseReceipt: {
    responseStatus: 200,
    responseContentType: 'application/json',
    responseBytes: 80,
    responseDigest: 'c'.repeat(64),
    responseDigestKind: 'raw_http_body',
    responseTopLevelFieldNames: ['conversationId'],
    requestHeaderNames: ['content-type', 'cookie'],
    cookieNames: ['sso'],
    transportHttpVersion: 'h2',
    tlsVerified: true,
    trustEnv: false,
    redirectsFollowed: false,
    explicitRetries: 0,
    attemptCount: 1,
    ownerVerified: true,
  },
});

function fakeRuntime({ completeList = true, ownerVerified = true, detailReadableAfterSoftDelete = false } = {}) {
  const state = {
    rows: new Map([
      ['conversation_prior_0000000001', { conversationId: 'conversation_prior_0000000001', title: 'Prior', viewerIsOwner: true }],
      ['conversation_prior_0000000002', { conversationId: 'conversation_prior_0000000002', title: 'Other', viewerIsOwner: true }],
    ]),
    calls: [],
    checkpoints: [],
    nextId: 0,
    lastDeleted: null,
  };
  const client = {
    async status() { return { session: { ownerVerified } }; },
    async read(operationId, input) {
      state.calls.push(['detail', operationId]);
      if (operationId !== 'conversation.read') throw new Error('unexpected read');
      return state.rows.has(input.conversationId)
        ? { status: 200, data: { conversation: { ...state.rows.get(input.conversationId) } } }
        : detailReadableAfterSoftDelete && state.lastDeleted?.conversationId === input.conversationId
          ? { status: 200, data: { conversation: { ...state.lastDeleted, isDeleted: true } } }
          : { status: 404, data: {} };
    },
    async clearInMemoryServiceJobId() { return { cleared: true }; },
  };
  const checkpoint = async receipt => state.checkpoints.push(structuredClone(receipt));
  const conversations = {
    async list() {
      state.calls.push(['list']);
      return { status: 200, data: {
        conversations: [...state.rows.values()].map(row => ({ ...row })),
        nextPageToken: completeList ? '' : 'more',
      } };
    },
    async search() {
      state.calls.push(['search']);
      return { status: 200, data: { conversations: [], textSearchMatches: [] } };
    },
    async create(body, options) {
      state.calls.push(['create', structuredClone(body)]);
      assert.equal(options.confirm, true);
      assert.equal(options.sourceDiscoveryPermit, 'first-live:conversation.create');
      const conversationId = `conversation_new_${String(++state.nextId).padStart(10, '0')}`;
      state.rows.set(conversationId, {
        conversationId, title: null, viewerIsOwner: true, mediaTypes: [], workspaces: [], taskResult: null,
      });
      await options.onResponseCheckpoint(responseCheckpoint('conversation.create'));
      return {
        localOperationId: 'local_create_1', state: 'completed', verified: true,
        httpStatus: 200, readbackStatus: 200, conversationId,
        sourceDiscoveryReceipt: {
          operationId: 'conversation.create', sourceFunctionName: 'chatCreateConversationRaw',
          method: 'POST', pathTemplate: '/rest/app-chat/conversations', responseStatus: 200,
          responseContentType: 'application/json', responseBytes: 80,
          requestDigest: 'a'.repeat(64), intentDigest: 'b'.repeat(64), responseJobIdObserved: true,
          tlsVerified: true, trustEnv: false, redirectsFollowed: false, explicitRetries: 0,
          attemptCount: 1, ownerVerified: true,
        },
      };
    },
    async read(conversationId) {
      const row = state.rows.get(conversationId);
      return row ? { status: 200, data: { conversation: { ...row } } } : { status: 404, data: {} };
    },
    async responseNodes() {
      return { status: 200, data: { responseNodes: [], inflightResponses: [] } };
    },
    async update(conversationId, body, options) {
      state.calls.push(['update', { ...body }]);
      assert.equal(options.confirm, true);
      Object.assign(state.rows.get(conversationId), body);
      await options.onResponseCheckpoint(responseCheckpoint('conversation.update'));
      return { localOperationId: 'local_update_1', state: 'completed', verified: true, httpStatus: 200, readbackStatus: 200 };
    },
    async delete(conversationId, options) {
      state.calls.push(['delete']);
      assert.equal(options.confirm, true);
      state.lastDeleted = { ...state.rows.get(conversationId) };
      state.rows.delete(conversationId);
      await options.onResponseCheckpoint(responseCheckpoint('conversation.soft-delete'));
      return { localOperationId: 'local_delete_1', state: 'completed', verified: true, conversationAbsent: true, httpStatus: 200 };
    },
  };
  const journal = { async list() { return []; } };
  return { runtime: { client, conversations, journal }, state, checkpoint };
}

test('source-captured empty-chat request builds a first-live SDK contract and finalizes only from verified semantic readback', async () => {
  const capture = createCapture();
  const registry = await loadContractRegistry();
  const base = { ...registry, operations: registry.operations.filter(operation => operation.id !== 'conversation.create') };
  const overlay = installCapturedGrokConversationCreate(base, capture, { capturedAt: '2026-10-06T00:00:00Z' });
  const create = overlay.operations.find(operation => operation.id === 'conversation.create');
  assert.equal(create.method, 'POST');
  assert.equal(create.evidence.requestPath, '/rest/app-chat/conversations');
  assert.equal(create.responseJobIdPointer, '/conversationId');
  assert.deepEqual(create.request.bodyTemplate, { systemPromptName: '', temporary: false });
  assert.equal(readinessMatrix(overlay).operations.find(item => item.operationId === 'conversation.create').ready, false);

  const finalized = finalizeCapturedGrokConversationCreateOperation(create, {
    semanticReadbackVerified: true,
    observedAt: '2026-10-06T00:00:01Z',
    directReplay: {
      source: 'direct_http', status: 200, parsedData: true, ownerVerified: true,
      tlsVerified: true, trustEnv: false, redirectsFollowed: false, explicitRetries: 0,
      attemptCountPerMutation: 1, responseDigestPersisted: false, responseBytes: 80,
      requestDigest: 'a'.repeat(64), intentDigest: 'b'.repeat(64), responseJobIdObserved: true,
      requestHeaderNames: ['content-type', 'cookie'], cookieNames: ['sso'],
    },
  });
  const finalRegistry = structuredClone(overlay);
  finalRegistry.operations = finalRegistry.operations.map(operation => operation.id === 'conversation.create' ? finalized : operation);
  validateContractRegistry(finalRegistry);
  assert.equal(readinessMatrix(finalRegistry).operations.find(item => item.operationId === 'conversation.create').ready, true);
});

test('source-only SDK empty-chat values are normalized without claiming a native UI request capture', async () => {
  const registry = await loadContractRegistry();
  const operation = buildSourceGrokConversationCreateOperation(createSource(), { capturedAt: '2026-10-06T00:00:00Z' });
  const overlay = structuredClone({ ...registry, operations: registry.operations.filter(item => item.id !== 'conversation.create') });
  overlay.operations.push(operation);
  validateContractRegistry(overlay);
  assert.equal(operation.evidence.source, 'first_party_sdk_contract');
  assert.equal(operation.evidence.browserWriteCapture, false);
  assert.equal(operation.evidence.firstLiveReplayPermit, true);
  assert.equal(readinessMatrix(overlay).operations.find(item => item.operationId === 'conversation.create').ready, false);
});

test('create, independent read, title update, and soft-delete preserve unrelated owner history', async () => {
  const { runtime, state } = fakeRuntime();
  const title = 'Codex Grok CRUD task 20261006-unique';
  const checkpoints = [];
  const result = await runGrokConversationCrudOnce({
    runtime,
    createSource: createSource(),
    title,
    createIntentId: 'crud-create-test-once',
    updateIntentId: 'crud-title-test-once',
    deleteIntentId: 'crud-delete-test-once',
    onCheckpoint: async value => checkpoints.push(structuredClone(value)),
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.operations.create.state, 'completed');
  assert.equal(result.operations.update.state, 'completed');
  assert.equal(result.operations.delete.state, 'completed');
  assert.equal(result.readback.create.exactlyOneNewConversation, true);
  assert.equal(result.readback.create.responseNodeCount, 0);
  assert.equal(result.readback.create.unrelatedConversationIdSetMatchesBaseline, true);
  assert.equal(result.readback.titleUpdate.exactTitleMatched, true);
  assert.equal(result.readback.delete.detailStatus, 404);
  assert.equal(result.readback.delete.unrelatedConversationSetPreserved, true);
  assert.equal(result.readback.delete.baselineConversationIdSetSha256, result.readback.delete.listConversationIdSetSha256);
  assert.equal(result.task.conversationIdSha256, result.readback.create.conversationIdSha256);
  assert.equal(result.task.conversationIdSha256, result.readback.titleUpdate.conversationIdSha256);
  assert.equal(result.task.conversationIdSha256, result.readback.delete.conversationIdSha256);
  assert.equal(state.rows.size, 2);
  assert.ok(checkpoints.length >= 8);
  const persistedText = JSON.stringify(result);
  assert.doesNotMatch(persistedText, /conversation_new_|Prior|Other|crud-create-test-once|Codex Grok CRUD task/);
});

test('soft-delete verification follows complete history-list absence even if the detail route remains readable', async () => {
  const { runtime, state } = fakeRuntime({ detailReadableAfterSoftDelete: true });
  const result = await runGrokConversationCrudOnce({
    runtime, createSource: createSource(), title: 'Codex Grok CRUD task detail-readable',
    createIntentId: 'detail-readable-create', updateIntentId: 'detail-readable-update', deleteIntentId: 'detail-readable-delete',
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.readback.delete.targetAbsent, true);
  assert.equal(result.readback.delete.detailStatus, 200);
  assert.equal(result.readback.delete.detailAbsent, false);
  assert.equal(result.readback.delete.detailAbsenceRequiredBySoftDeleteContract, false);
  assert.equal(state.rows.size, 2);
});

test('owner gate and incomplete baseline stop before create with no business call', async () => {
  const ownerMismatch = fakeRuntime({ ownerVerified: false });
  const common = {
    createSource: createSource(), title: 'unique test title',
    createIntentId: 'owner-create', updateIntentId: 'owner-update', deleteIntentId: 'owner-delete',
  };
  const ownerResult = await runGrokConversationCrudOnce({ ...common, runtime: ownerMismatch.runtime });
  assert.equal(ownerResult.status, 'needs_review');
  assert.equal(ownerResult.errorCode, 'OWNER_VERIFICATION_REQUIRED');
  assert.equal(ownerMismatch.state.calls.length, 0);

  const incomplete = fakeRuntime({ completeList: false });
  const listResult = await runGrokConversationCrudOnce({ ...common, runtime: incomplete.runtime });
  assert.equal(listResult.status, 'needs_review');
  assert.equal(listResult.errorCode, 'CONVERSATION_CRUD_CURSOR_CYCLE');
  assert.equal(incomplete.state.calls.some(call => call[0] === 'create'), false);
});

test('unbound UI create captures, business-reaching browser captures, and body extras are rejected', () => {
  const base = createCapture();
  const registry = { schemaVersion: 1, serviceId: 'grok-web', serviceOrigin: 'https://grok.com', allowedOrigins: ['https://grok.com'], operations: [] };
  assert.throws(() => buildCapturedGrokConversationCreateOperation({ ...base, browserRequestAbortConfirmed: false }), { code: 'CONVERSATION_CREATE_CAPTURE_INVALID' });
  assert.throws(() => buildCapturedGrokConversationCreateOperation({ ...base, browserRequestReachedProvider: true }), { code: 'CONVERSATION_CREATE_CAPTURE_INVALID' });
  assert.throws(() => buildCapturedGrokConversationCreateOperation({ ...base, body: { ...base.body, addResponseRequest: { query: 'not empty' } } }), { code: 'CONVERSATION_CREATE_CAPTURE_INVALID' });
  const overlay = installCapturedGrokConversationCreate(registry, base);
  assert.ok(overlay.operations.some(operation => operation.id === 'conversation.create'));
});
