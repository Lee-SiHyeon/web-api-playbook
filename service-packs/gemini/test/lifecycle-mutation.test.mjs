import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObservedContract } from '../src/contract.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';
import {
  buildCapturedLifecycleMutationRequest,
  createConversationShareOnce,
  installLifecycleMutationCapture,
  mutateConversationOnce,
  revokePublicShareLinkOnce,
} from '../src/lifecycle-mutation.mjs';

const QUERY_KEYS = ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'];
const BODY_FIELDS = ['f.req', 'at'];
const BASE_HEADERS = ['content-type', 'referer', 'x-same-domain'];
const TARGET = 'c_0123456789abcdef';
const OWNER = 'expected.user@example.com';

function baseContract() {
  return validateObservedContract({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    assetOrigins: [],
    operations: {
      identity: {
        observation: { requestResponse: true }, effect: 'read',
        request: { method: 'GET', origin: SERVICE_ORIGIN, path: '/app', queryKeys: [], headerNames: [] },
        response: { contentType: 'text/html', framing: 'text' },
      },
      history_list: {
        observation: { requestResponse: true }, effect: 'read',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
        },
        response: {
          contentType: 'application/json', framing: 'batchexecute', rpcId: 'MaZiqc',
          frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
        },
      },
      history_read: {
        observation: { requestResponse: true }, effect: 'read',
        request: {
          rpcId: 'hNvQHb', rpcArgsTemplate: ['{{apiConversationId}}', 10, null, 1, [1], [4], null, 1],
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
        },
        response: {
          contentType: 'application/json', framing: 'batchexecute', selectorMode: 'rpc_id', rpcId: 'hNvQHb',
          frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
        },
      },
    },
  });
}

function renameCapture() {
  return {
    rpcId: 'MUAZcd',
    rpcCallTail: [null, 'generic'],
    requestHeaderValues: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', referer: `${SERVICE_ORIGIN}/app`, 'x-same-domain': '1' },
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
      queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
    },
  };
}

function shareCapture() {
  return {
    rpcId: 'fuVx7',
    rpcCallTail: [null, 'generic'],
    requestHeaderValues: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      referer: `${SERVICE_ORIGIN}/app`,
      'x-same-domain': '1',
    },
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
      queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
    },
  };
}

function shareRevokeCapture() {
  return {
    rpcId: 'SgORbf',
    rpcCallTail: [null, 'generic'],
    requestHeaderValues: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      referer: `${SERVICE_ORIGIN}/app`,
      'x-same-domain': '1',
    },
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
      queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
      contentType: 'application/x-www-form-urlencoded;charset=utf-8', bodyFieldNames: BODY_FIELDS,
    },
  };
}

function deleteCapture() {
  return {
    rpcId: 'GzXR5e',
    rpcCallTail: [null, 'generic'],
    requestHeaderValues: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      referer: `${SERVICE_ORIGIN}/app`,
      'x-same-domain': '1',
    },
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
      queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
    },
  };
}

function fakeClient() {
  return {
    contract: baseContract(),
    nextHistoryRequestId: 200,
    transport: {
      fetch: async () => {},
      session: {
        version: 1,
        service: SERVICE_ID,
        origin: SERVICE_ORIGIN,
        capturedAt: '2026-10-06T00:00:00.000Z',
        cookies: [{ name: 'AUTH_COOKIE', value: 'memory-only' }],
        headers: {},
        requestHeaders: {},
        batchContext: {
          at: 'csrf-memory-only', fSid: 'sid-memory-only', buildLabel: 'build_1',
          locale: 'en', requestType: 'c', sourcePath: '/app', requestId: '200',
          historyListArgs: [28, null, [0, null, 1]],
        },
      },
    },
  };
}

test('installs only a request-only no-retry rename operation from a matching normal UI capture', () => {
  const contract = installLifecycleMutationCapture(baseContract(), { operationName: 'edit', capture: renameCapture() });
  assert.deepEqual(contract.operations.edit.observation, { request: true, requestResponse: false });
  assert.equal(contract.operations.edit.effect, 'mutation');
  assert.equal(contract.operations.edit.retryPolicy, 'never');
  assert.equal(contract.operations.edit.request.rpcId, 'MUAZcd');
});

test('builds the direct rename request with a fresh sequence and captured call tail', () => {
  const contract = installLifecycleMutationCapture(baseContract(), { operationName: 'edit', capture: renameCapture() });
  const client = fakeClient();
  client.transport.session.requestHeaders = { edit: renameCapture().requestHeaderValues };
  const request = buildCapturedLifecycleMutationRequest(contract, client, {
    operationName: 'edit', rpcId: 'MUAZcd', args: [null, [[['title-field']]], [TARGET, 'Codex API verified text 20261006']],
  });
  assert.equal(request.path, '/_/BardChatUi/data/batchexecute');
  assert.deepEqual(request.query.map(([name]) => name), QUERY_KEYS);
  assert.equal(request.query.find(([name]) => name === '_reqid')[1], '200');
  assert.deepEqual([...new URLSearchParams(request.body).keys()], BODY_FIELDS);
  const fReq = JSON.parse(new URLSearchParams(request.body).get('f.req'));
  const call = fReq[0][0];
  assert.equal(call[0], 'MUAZcd');
  assert.deepEqual(JSON.parse(call[1]), [null, [[['title-field']]], [TARGET, 'Codex API verified text 20261006']]);
  assert.deepEqual(call.slice(2), [null, 'generic']);
  assert.equal(client.nextHistoryRequestId, 201);
});

test('installs and builds a request-only share creation from its normal UI capture', () => {
  const capture = shareCapture();
  const contract = installLifecycleMutationCapture(baseContract(), { operationName: 'share_create', capture });
  assert.deepEqual(contract.operations.share_create.observation, { request: true, requestResponse: false });
  assert.equal(contract.operations.share_create.effect, 'mutation');
  assert.equal(contract.operations.share_create.retryPolicy, 'never');
  assert.equal(contract.operations.share_create.request.rpcId, 'fuVx7');
  const client = fakeClient();
  client.transport.session.requestHeaders = { share_create: capture.requestHeaderValues };
  const args = [null, TARGET, null, 'share context', [1, 'task share', null, null, null, null, null, null], null, null, null, null];
  const request = buildCapturedLifecycleMutationRequest(contract, client, {
    operationName: 'share_create', rpcId: 'fuVx7', args,
  });
  const fReq = JSON.parse(new URLSearchParams(request.body).get('f.req'));
  assert.deepEqual(JSON.parse(fReq[0][0][1]), args);
  assert.deepEqual(fReq[0][0].slice(2), [null, 'generic']);
  assert.deepEqual(request.query.map(([name]) => name), QUERY_KEYS);
  assert.equal(client.nextHistoryRequestId, 201);
});

test('accepts the browser-captured media type with case-insensitive charset spelling', () => {
  const capture = shareCapture();
  capture.request.contentType = 'application/x-www-form-urlencoded;charset=utf-8';
  const contract = installLifecycleMutationCapture(baseContract(), { operationName: 'share_create', capture });
  assert.equal(contract.operations.share_create.request.contentType, 'application/x-www-form-urlencoded;charset=utf-8');
});

test('installs and builds a request-only share revoke from its normal UI capture', () => {
  const capture = shareRevokeCapture();
  const contract = installLifecycleMutationCapture(baseContract(), { operationName: 'share_revoke', capture });
  assert.deepEqual(contract.operations.share_revoke.observation, { request: true, requestResponse: false });
  assert.equal(contract.operations.share_revoke.effect, 'mutation');
  assert.equal(contract.operations.share_revoke.retryPolicy, 'never');
  assert.equal(contract.operations.share_revoke.request.rpcId, 'SgORbf');
  const client = fakeClient();
  client.transport.session.requestHeaders = { share_revoke: capture.requestHeaderValues };
  const shareId = 'PublicLinkId123456';
  const args = [null, shareId];
  const request = buildCapturedLifecycleMutationRequest(contract, client, {
    operationName: 'share_revoke', rpcId: 'SgORbf', args,
  });
  const fReq = JSON.parse(new URLSearchParams(request.body).get('f.req'));
  assert.deepEqual(JSON.parse(fReq[0][0][1]), args);
  assert.deepEqual(fReq[0][0].slice(2), [null, 'generic']);
  assert.deepEqual(request.query.map(([name]) => name), QUERY_KEYS);
  assert.equal(client.nextHistoryRequestId, 201);
});

test('installs and builds a request-only no-retry conversation delete from its normal UI capture', () => {
  const capture = deleteCapture();
  const contract = installLifecycleMutationCapture(baseContract(), { operationName: 'delete', capture });
  assert.deepEqual(contract.operations.delete.observation, { request: true, requestResponse: false });
  assert.equal(contract.operations.delete.effect, 'mutation');
  assert.equal(contract.operations.delete.retryPolicy, 'never');
  assert.equal(contract.operations.delete.request.rpcId, 'GzXR5e');
  const client = fakeClient();
  client.transport.session.requestHeaders = { delete: capture.requestHeaderValues };
  const request = buildCapturedLifecycleMutationRequest(contract, client, {
    operationName: 'delete', rpcId: 'GzXR5e', args: [TARGET],
  });
  const form = new URLSearchParams(request.body);
  assert.deepEqual([...form.keys()], BODY_FIELDS);
  const call = JSON.parse(form.get('f.req'))[0][0];
  assert.equal(call[0], 'GzXR5e');
  assert.deepEqual(JSON.parse(call[1]), [TARGET]);
  assert.deepEqual(call.slice(2), [null, 'generic']);
  assert.deepEqual(request.query.map(([name]) => name), QUERY_KEYS);
  assert.equal(client.nextHistoryRequestId, 201);
});

test('builds the captured conversation delete from the installed request-only contract', () => {
  const base = baseContract();
  const contract = validateObservedContract({
    ...base,
    operations: {
      ...base.operations,
      delete: {
    observation: { request: true, requestResponse: false },
    effect: 'mutation',
    retryPolicy: 'never',
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
      queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
      rpcId: 'GzXR5e', rpcArgsTemplate: ['{{conversationId}}'], rpcCallTail: [null, 'generic'],
    },
      },
    },
  });
  const client = fakeClient();
  client.transport.session.requestHeaders = { history_list: renameCapture().requestHeaderValues };
  const request = buildCapturedLifecycleMutationRequest(contract, client, {
    operationName: 'delete', rpcId: 'GzXR5e', args: [TARGET],
  });
  const call = JSON.parse(new URLSearchParams(request.body).get('f.req'))[0][0];
  assert.equal(call[0], 'GzXR5e');
  assert.deepEqual(JSON.parse(call[1]), [TARGET]);
  assert.deepEqual(call.slice(2), [null, 'generic']);
  assert.deepEqual(request.query.map(([name]) => name), QUERY_KEYS);
});

test('binds a delete from its installed request-only contract without a per-call UI capture', async () => {
  const base = baseContract();
  const contract = validateObservedContract({
    ...base,
    operations: {
      ...base.operations,
      delete: {
        observation: { request: true, requestResponse: false },
        effect: 'mutation', retryPolicy: 'never',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
          rpcId: 'GzXR5e', rpcArgsTemplate: ['{{conversationId}}'], rpcCallTail: [null, 'generic'],
        },
      },
    },
  });
  const client = fakeClient();
  client.contract = contract;
  client.transport.session.requestHeaders = { history_list: renameCapture().requestHeaderValues };
  await assert.rejects(mutateConversationOnce(client, {
    operationName: 'delete', targetConversationId: TARGET, requiredPayloadValues: [],
    expectedOwner: OWNER, confirmed: false, callerIntent: 'delete-contract-test-v1',
  }), { code: 'LIFECYCLE_MUTATION_CONFIRMATION_REQUIRED' });
});

test('does not invent rename arguments when the request-only contract lacks a persisted argument template', async () => {
  const base = baseContract();
  const contract = validateObservedContract({
    ...base,
    operations: {
      ...base.operations,
      edit: {
        observation: { request: true, requestResponse: false },
        effect: 'mutation', retryPolicy: 'never',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
          rpcId: 'MUAZcd', rpcCallTail: [null, 'generic'],
        },
      },
    },
  });
  const client = fakeClient();
  client.contract = contract;
  client.transport.session.requestHeaders = { history_list: renameCapture().requestHeaderValues };
  await assert.rejects(mutateConversationOnce(client, {
    operationName: 'edit', targetConversationId: TARGET, requiredPayloadValues: ['New verified title'],
    expectedOwner: OWNER, confirmed: true, callerIntent: 'rename-contract-test-v1',
  }), { code: 'LIFECYCLE_MUTATION_CONTRACT_REQUIRED' });
});

test('binds the marked static rename protocol literal with conversation and title placeholders', async () => {
  const base = baseContract();
  const contract = validateObservedContract({
    ...base,
    operations: {
      ...base.operations,
      edit: {
        observation: { request: true, requestResponse: false },
        effect: 'mutation', retryPolicy: 'never',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
          rpcId: 'MUAZcd', rpcArgsTemplate: [null, [[{ $literal: 'field' }]], ['{{conversationId}}', '{{newTitle}}']],
          rpcCallTail: [null, 'generic'],
        },
      },
    },
  });
  const client = fakeClient();
  client.contract = contract;
  client.transport.session.requestHeaders = { history_list: renameCapture().requestHeaderValues };
  await assert.rejects(mutateConversationOnce(client, {
    operationName: 'edit', targetConversationId: TARGET, requiredPayloadValues: ['New verified title'],
    expectedOwner: OWNER, confirmed: false, callerIntent: 'rename-contract-test-v2',
  }), { code: 'LIFECYCLE_MUTATION_CONFIRMATION_REQUIRED' });
});

test('binds share revoke from its installed request-only contract without a per-call UI capture', async () => {
  const base = baseContract();
  const contract = validateObservedContract({
    ...base,
    operations: {
      ...base.operations,
      share_revoke: {
        observation: { request: true, requestResponse: false },
        effect: 'mutation', retryPolicy: 'never',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: QUERY_KEYS, headerNames: BASE_HEADERS,
          contentType: 'application/x-www-form-urlencoded;charset=utf-8', bodyFieldNames: BODY_FIELDS,
          rpcId: 'SgORbf', rpcArgsTemplate: [null, '{{shareId}}'], rpcCallTail: [null, 'generic'],
        },
      },
    },
  });
  const client = fakeClient();
  client.contract = contract;
  client.transport.session.requestHeaders = { history_list: shareRevokeCapture().requestHeaderValues };
  await assert.rejects(revokePublicShareLinkOnce(client, {
    targetShareId: 'PublicLinkId123456', targetConversationTitle: 'Codex API verified text 20261006',
    expectedRemainingTaskLinkCount: 1, expectedOwner: OWNER, confirmed: false,
    callerIntent: 'share-revoke-contract-test-v1',
  }), { code: 'SHARE_REVOKE_CONFIRMATION_REQUIRED' });
});

test('rejects an unknown RPC, a mismatched request envelope, and unconfirmed mutation before dispatch', async () => {
  assert.throws(() => installLifecycleMutationCapture(baseContract(), {
    operationName: 'edit', capture: { ...renameCapture(), rpcId: 'wrong' },
  }), { code: 'LIFECYCLE_MUTATION_CAPTURE_INVALID' });
  assert.throws(() => installLifecycleMutationCapture(baseContract(), {
    operationName: 'edit', capture: { ...renameCapture(), request: { ...renameCapture().request, path: '/wrong' } },
  }), { code: 'LIFECYCLE_MUTATION_CAPTURE_INVALID' });
  await assert.rejects(mutateConversationOnce(fakeClient(), {
    operationName: 'edit', requestCapture: renameCapture(), rpcId: 'MUAZcd',
    args: [TARGET, 'Codex API verified text 20261006'], targetConversationId: TARGET,
    requiredPayloadValues: ['Codex API verified text 20261006'], expectedOwner: 'owner@example.com',
    confirmed: false, callerIntent: 'lifecycle:rename:protocol42:20261006',
  }), { code: 'LIFECYCLE_MUTATION_CONFIRMATION_REQUIRED' });
  await assert.rejects(createConversationShareOnce(fakeClient(), {
    requestCapture: shareCapture(), rpcId: 'fuVx7', args: [null, TARGET], targetConversationId: TARGET,
    expectedOwner: 'owner@example.com', confirmed: false, callerIntent: 'lifecycle:share:protocol42:20261006',
  }), { code: 'SHARE_MUTATION_CONFIRMATION_REQUIRED' });
  await assert.rejects(revokePublicShareLinkOnce(fakeClient(), {
    requestCapture: shareRevokeCapture(), rpcId: 'SgORbf', args: [null, 'PublicLinkId123456'],
    targetShareId: 'PublicLinkId123456', targetConversationTitle: 'Codex API verified text 20261006',
    expectedRemainingTaskLinkCount: 2, expectedOwner: 'owner@example.com',
    confirmed: false, callerIntent: 'lifecycle:share:revoke:protocol42:20261006:1',
  }), { code: 'SHARE_REVOKE_CONFIRMATION_REQUIRED' });
});
