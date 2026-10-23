import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GeminiWebClient } from '../src/client.mjs';
import { buildHistoryListRequest } from '../src/rpc-adapters.mjs';
import { validateObservedContract } from '../src/contract.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';
import { findUnresolvedMutation, markMutationReconciled, mutationIntentDigest } from '../src/journal.mjs';

const queryKeys = ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'];

function observedContract({ requestOnlyText = false, requestOnlyDelete = false, requestOnlyEdit = false } = {}) {
  const operations = {
      identity: {
        observation: { requestResponse: true }, effect: 'read',
        request: { method: 'GET', origin: SERVICE_ORIGIN, path: '/app', queryKeys: [], headerNames: ['user-agent'] },
        response: { contentType: 'text/html', framing: 'text' },
      },
      history_list: {
        observation: { requestResponse: true }, effect: 'read',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute', queryKeys,
          headerNames: ['content-type', 'referer', 'x-goog-ext-525001261-jspb', 'x-goog-ext-73010989-jspb', 'x-same-domain'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
        },
        response: {
          contentType: 'application/json', framing: 'batchexecute', rpcId: 'MaZiqc',
          frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
        },
      },
      history_search: {
        observation: { request: true, requestResponse: true }, effect: 'read',
        request: {
          rpcId: 'unqWSc', rpcArgsTemplate: ['{{searchQuery}}'],
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute', queryKeys,
          headerNames: ['content-type', 'referer', 'x-goog-ext-525001261-jspb', 'x-goog-ext-73010989-jspb', 'x-same-domain'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
        },
        response: { contentType: 'application/json', framing: 'batchexecute', rpcId: 'unqWSc', frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2 },
      },
      model_list: {
        observation: { request: true, requestResponse: true }, effect: 'read',
        request: {
          rpcId: 'otAQ7b', rpcArgsTemplate: [],
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute', queryKeys,
          headerNames: ['content-type', 'referer', 'x-goog-ext-525001261-jspb', 'x-goog-ext-73010989-jspb', 'x-same-domain'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
        },
        response: { contentType: 'application/json', framing: 'batchexecute', rpcId: 'otAQ7b', frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2 },
      },
      settings_read: {
        observation: { request: true, requestResponse: true }, effect: 'read',
        request: {
          rpcId: 'ESY5D', rpcArgsTemplate: [null, '{{preferenceFieldIds}}'],
          allowlistedPreferenceKeys: ['voice_language', 'voice_name', 'enable_advanced_mode', 'enable_memory', 'enable_personal_context', 'web_and_app_activity_enabled', 'side_nav_open_by_default'],
          preferenceFieldIds: [62, 61, 39, 25, 77, 93, 41],
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute', queryKeys,
          headerNames: ['content-type', 'referer', 'x-goog-ext-525001261-jspb', 'x-goog-ext-73010989-jspb', 'x-same-domain'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
        },
        response: { contentType: 'application/json', framing: 'batchexecute', rpcId: 'ESY5D', frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2 },
      },
  };
  if (requestOnlyText) operations.text = {
    observation: { request: true, requestResponse: false },
    effect: 'mutation', retryPolicy: 'never',
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/captured/StreamGenerate', queryKeys: ['rpcids'],
      headerNames: ['content-type'], contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      bodyFieldNames: ['f.req', 'at'],
    },
  };
  if (requestOnlyDelete) operations.delete = {
    observation: { request: true, requestResponse: false },
    effect: 'mutation', retryPolicy: 'never',
    request: {
      rpcId: 'GzXR5e', rpcArgsTemplate: ['{{conversationId}}'], rpcCallTail: [null, 'generic'],
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute', queryKeys,
      headerNames: ['content-type', 'referer', 'x-same-domain'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
    },
  };
  if (requestOnlyEdit) operations.edit = {
    observation: { request: true, requestResponse: false },
    effect: 'mutation', retryPolicy: 'never',
    request: {
      rpcId: 'MUAZcd', rpcCallTail: [null, 'generic'],
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute', queryKeys,
      headerNames: ['content-type', 'referer', 'x-same-domain'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
    },
  };
  return validateObservedContract({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    assetOrigins: [],
    operations,
  });
}

function currentSession() {
  return {
    version: 1, service: SERVICE_ID, origin: SERVICE_ORIGIN, capturedAt: '2026-10-06T00:00:00.000Z',
    cookies: [{ name: 'AUTH_COOKIE', value: 'secret-memory-only' }], headers: {},
    requestHeaders: { history_list: {
      referer: 'https://gemini.google.com/app',
      'x-goog-ext-525001261-jspb': 'private-header-one',
      'x-goog-ext-73010989-jspb': 'private-header-two',
      'x-same-domain': '1',
    } },
    batchContext: {
      at: 'csrf-memory-only', fSid: 'session-memory-only', buildLabel: 'build_1', locale: 'ko',
      requestType: 'c', sourcePath: '/app', requestId: '1234', historyListArgs: [28, null, [0, null, 1]],
    },
  };
}

test('builds the captured ListConversations form and query field order', () => {
  const request = buildHistoryListRequest(observedContract(), currentSession());
  assert.deepEqual(request.query.map(([name]) => name), queryKeys);
  assert.equal(request.query[0][1], 'MaZiqc');
  assert.deepEqual([...new URLSearchParams(request.body).keys()], ['f.req', 'at']);
  const params = new URLSearchParams(request.body);
  const frames = JSON.parse(params.get('f.req'));
  assert.deepEqual(frames, [[['MaZiqc', '[28,null,[0,null,1]]', null, 'generic']]]);
  assert.equal(params.get('at'), 'csrf-memory-only');
});

test('journals one unpaired text write by stable actor intent before learning its response MIME', async () => {
  const contract = observedContract({ requestOnlyText: true });
  let calls = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-text-capture-'));
  const client = new GeminiWebClient({
    contract,
    session: currentSession(),
    fetchImpl: async () => {
      calls += 1;
      return new Response('captured response bytes', { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    },
  });
  const requestSpec = {
    method: 'POST', path: '/_/captured/StreamGenerate', query: [['rpcids', 'RxAFq']],
    headers: {}, contentType: 'application/x-www-form-urlencoded;charset=UTF-8', body: 'f.req=captured&at=rotating-token',
  };
  const intent = { actor: 'owner@example.com', callerIntent: 'core-text-smoke-20261006' };
  try {
    const captured = await client.captureMutationResponseOnce('text', requestSpec, { ...intent, journalRoot: root });
    assert.equal(captured.response.httpStatus, 200);
    assert.equal(captured.response.contentType, 'text/event-stream');
    assert.equal(captured.response.responseContractCaptured, false);
    const intentHash = mutationIntentDigest({ capability: 'text', ...intent });
    const pending = await findUnresolvedMutation('text', intentHash, { root });
    assert.equal(pending.state, 'response_received');
    const journal = await readFile(pending.jobPath, 'utf8');
    assert.equal(journal.includes('rotating-token'), false);
    assert.equal(journal.includes(intent.actor), false);
    await assert.rejects(client.captureMutationResponseOnce('text', { ...requestSpec, body: 'f.req=captured&at=refreshed-token' }, { ...intent, journalRoot: root }), { code: 'MUTATION_PENDING' });
    await markMutationReconciled(pending.jobPath, { found: true, resultCategory: 'history_readback' });
    await assert.rejects(client.captureMutationResponseOnce('text', requestSpec, { ...intent, journalRoot: root }), { code: 'MUTATION_INTENT_ALREADY_USED' });
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('direct history adapter sends only captured same-origin fields and parses UTF-16 frames', async () => {
  const contract = observedContract();
  let request;
  const data = { entries: [{ title: '한국어 🐈', id: 'private-id-memory-only' }] };
  const rpc = JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify(data)]]);
  const wire = Buffer.from(")]}'\n" + (rpc.length + 2) + '\n' + rpc + '\r\n', 'utf8');
  const splitStream = new ReadableStream({
    start(controller) {
      for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const client = new GeminiWebClient({
    contract,
    session: currentSession(),
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(splitStream, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    },
  });
  const result = await client.listHistory();
  assert.equal(request.url.origin, SERVICE_ORIGIN);
  assert.equal(request.url.pathname, '/_/BardChatUi/data/batchexecute');
  assert.equal(request.url.searchParams.get('rpcids'), 'MaZiqc');
  assert.equal(request.options.headers.get('cookie'), 'AUTH_COOKIE=secret-memory-only');
  assert.equal(request.options.headers.get('x-goog-ext-525001261-jspb'), 'private-header-one');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.rpcId, 'MaZiqc');
  assert.match(result.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.data.entries[0].title, '한국어 🐈');
  assert.equal(result.data.entries[0].id, 'private-id-memory-only');
  assert.equal(result.credentialPropagated, true);
});

test('direct identity adapter returns an owner match boolean without echoing the address', async () => {
  const expectedOwner = 'expected.user@example.com';
  let calls = 0;
  const client = new GeminiWebClient({
    contract: observedContract(), session: currentSession(),
    fetchImpl: async (url, options) => {
      calls += 1;
      const owner = options.headers.get('cookie') ? expectedOwner : '';
      return new Response(`<html><chat-app-orchestrator>${owner}</chat-app-orchestrator><script>WIZ_global_data=${JSON.stringify({ oPEP7c: owner })};</script></html>`, {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  const result = await client.verifyOwner(expectedOwner);
  assert.equal(result.ownerMatched, true);
  assert.equal(result.anonymousOwnerAbsent, true);
  assert.match(result.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(result).includes(expectedOwner), false);
});

test('account chooser text cannot authenticate a different active account and clears cached owner', async () => {
  const expectedOwner = 'expected.user@example.com';
  const client = new GeminiWebClient({ contract: observedContract(), session: currentSession(),
    fetchImpl: async (_url, options) => new Response(options.headers.get('cookie')
      ? `<chat-app-orchestrator>${expectedOwner}</chat-app-orchestrator><script>WIZ_global_data={"oPEP7c":"different@example.com"};</script>`
      : `<p>Saved account: ${expectedOwner}</p>`, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  client.verifiedOwner = expectedOwner;
  const result = await client.verifyOwner(expectedOwner);
  assert.equal(result.ownerMatched, false);
  assert.equal(result.anonymousOwnerAbsent, true);
  assert.equal(client.verifiedOwner, null);
});

test('binds installed identity, history, search, model, and settings handlers by observed operation name', async () => {
  const client = new GeminiWebClient({ contract: observedContract(), session: currentSession(), fetchImpl: async () => new Response('') });
  const evidence = client.operationEvidence();
  const expected = {
    identity: { handlerName: 'verifyOwner', installed: true, contractCaptured: true, requestCaptured: true },
    history_list: { handlerName: 'listHistory', installed: true, contractCaptured: true, requestCaptured: true },
    history_read: { handlerName: 'readHistoryDetail', installed: true, contractCaptured: false, requestCaptured: false },
    history_search: { handlerName: 'searchHistory', installed: true, contractCaptured: true, requestCaptured: true },
    model_list: { handlerName: 'listModels', installed: true, contractCaptured: true, requestCaptured: true },
    settings_read: { handlerName: 'readSettings', installed: true, contractCaptured: true, requestCaptured: true },
    share_read: { handlerName: 'readPublicShareLinks', installed: true, contractCaptured: false, requestCaptured: false },
    share_public_read: { handlerName: 'readSharedConversation', installed: true, contractCaptured: false, requestCaptured: false },
    edit: { handlerName: 'renameConversation', installed: true, contractCaptured: false, requestCaptured: false },
    delete: { handlerName: 'deleteConversation', installed: true, contractCaptured: false, requestCaptured: false },
    share_create: { handlerName: 'createConversationShare', installed: true, contractCaptured: false, requestCaptured: false },
    share_revoke: { handlerName: 'revokePublicShareLink', installed: true, contractCaptured: false, requestCaptured: false },
    image: { handlerName: 'generateImageOnce', installed: true, contractCaptured: false, requestCaptured: false },
    video: { handlerName: 'generateVideoOnce', installed: true, contractCaptured: false, requestCaptured: false },
    text: { handlerName: 'generateTextOnce', installed: true, contractCaptured: false, requestCaptured: false },
  };
  for (const [name, binding] of Object.entries(expected)) assert.deepEqual(evidence[name], binding);
  for (const [name, binding] of Object.entries(evidence)) {
    if (!client.contract.operations[name]) {
      assert.equal(binding.contractCaptured, false);
      assert.equal(binding.requestCaptured, false);
    }
  }
  await assert.rejects(client.invoke('history_read'), { code: 'CONTRACT_NOT_CAPTURED' });
  assert.equal(client.evidence().history.client_exists, true);
});

test('reports a captured batchexecute delete as request-only and keeps it distinct from text mutation transport', () => {
  const client = new GeminiWebClient({ contract: observedContract({ requestOnlyDelete: true }), session: currentSession() });
  assert.deepEqual(client.operationEvidence().delete, {
    handlerName: 'deleteConversation',
    installed: true,
    contractCaptured: true,
    requestCaptured: true,
    normalUiRequestCaptured: true,
    normalUiResponseCaptured: false,
    mutationContractType: 'request_only_batchexecute',
  });
  const textClient = new GeminiWebClient({ contract: observedContract({ requestOnlyText: true }), session: currentSession() });
  assert.equal(textClient.operationEvidence().text.mutationContractType, 'request_only_other_http');
});

test('reports a captured rename as a request-only batchexecute mutation without inventing an argument template', () => {
  const client = new GeminiWebClient({ contract: observedContract({ requestOnlyEdit: true }), session: currentSession() });
  assert.deepEqual(client.operationEvidence().edit, {
    handlerName: 'renameConversation',
    installed: true,
    contractCaptured: true,
    requestCaptured: true,
    normalUiRequestCaptured: true,
    normalUiResponseCaptured: false,
    mutationContractType: 'request_only_batchexecute',
  });
});
