import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindGeminiConversationIds,
  buildHistoryDetailRequest,
  inspectHistoryDetailResponse,
} from '../src/history-detail.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { validateObservedContract } from '../src/contract.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';

const API_ID = 'c_0123456789abcdef';
const ROUTE_ID = '0123456789abcdef';

function operation() {
  return {
    observation: { request: true, requestResponse: true },
    effect: 'read',
    request: {
      rpcId: 'hNvQHb',
      method: 'POST',
      origin: SERVICE_ORIGIN,
      path: '/_/BardChatUi/data/batchexecute',
      queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
      bodyFieldNames: ['f.req', 'at'],
      headerNames: ['content-type', 'origin', 'referer', 'x-same-domain'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      rpcArgsTemplate: ['{{apiConversationId}}', 10, null, 1, [1], [4], null, 1],
    },
    response: {
      framing: 'batchexecute',
      contentType: 'application/json',
      frameLengthUnit: 'utf16_code_units',
      frameLengthOverheadUnits: 2,
      selectorMode: 'rpc_id',
      rpcId: 'hNvQHb',
    },
  };
}

function contract() {
  return { operations: { history_read: operation() }, assetOrigins: ['https://gemini.gstatic.com'] };
}

function session() {
  return { batchContext: {
    at: 'csrf-in-memory',
    fSid: 'sid-in-memory',
    buildLabel: 'build_1',
    locale: 'ko',
    requestType: 'c',
    sourcePath: '/app',
    requestId: '4100',
  } };
}

function framed(value) {
  const payload = JSON.stringify(value);
  const utf16Units = Buffer.byteLength(payload, 'utf16le') / 2;
  return Buffer.from(`)]}'\n${utf16Units + 2}\n${payload}\n`, 'utf8');
}

function liveReadContract() {
  return validateObservedContract({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    assetOrigins: ['https://gemini.gstatic.com'],
    operations: {
      identity: {
        observation: { requestResponse: true }, effect: 'read',
        request: { method: 'GET', origin: SERVICE_ORIGIN, path: '/app', queryKeys: [], headerNames: ['user-agent'] },
        response: { contentType: 'text/html', framing: 'text' },
      },
      history_list: {
        observation: { requestResponse: true }, effect: 'read',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
          headerNames: ['content-type', 'referer', 'x-same-domain'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
        },
        response: { contentType: 'application/json', framing: 'batchexecute', rpcId: 'MaZiqc', frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2 },
      },
      history_read: operation(),
    },
  });
}

function liveSession() {
  return {
    version: 1, service: SERVICE_ID, origin: SERVICE_ORIGIN, capturedAt: '2026-10-06T00:00:00.000Z',
    cookies: [{ name: 'AUTH_COOKIE', value: 'cookie-memory-only' }], headers: {},
    requestHeaders: { history_read: { referer: `${SERVICE_ORIGIN}/app/${ROUTE_ID}`, 'x-same-domain': '1' } },
    batchContext: {
      at: 'csrf-in-memory', fSid: 'sid-in-memory', buildLabel: 'build_1', locale: 'en',
      requestType: 'c', sourcePath: `/app/${ROUTE_ID}`, requestId: '4100', historyListArgs: [20, null, [0, null, 1]],
    },
  };
}

test('keeps the raw c_-prefixed API ID in hNvQHb arguments and binds the visible route separately', () => {
  const bound = bindGeminiConversationIds(API_ID, ROUTE_ID);
  assert.equal(bound.bound, true);
  assert.equal(bound.apiConversationIdLength, 18);
  assert.equal(bound.visibleRouteIdLength, 16);
  assert.equal(JSON.stringify(bound).includes(API_ID), false);

  const built = buildHistoryDetailRequest(contract(), session(), {
    apiConversationId: API_ID,
    visibleRouteId: ROUTE_ID,
    requestId: '4101',
  });
  const params = new URLSearchParams(built.requestSpec.body);
  assert.deepEqual([...params.keys()], ['f.req', 'at']);
  assert.equal(params.get('at'), 'csrf-in-memory');
  const outer = JSON.parse(params.get('f.req'));
  const args = JSON.parse(outer[0][0][1]);
  assert.equal(args[0], API_ID);
  assert.deepEqual(args.slice(1), [10, null, 1, [1], [4], null, 1]);
  assert.equal(built.binding.rawApiIdUsedInRequest, true);
  assert.equal(built.binding.prefixRemovedFromRequest, false);
});

test('rejects mismatched or malformed API-to-route ID bindings before building a request', () => {
  assert.throws(() => bindGeminiConversationIds(API_ID, 'fedcba9876543210'), { code: 'HISTORY_ID_BINDING_MISMATCH' });
  assert.throws(() => bindGeminiConversationIds('0123456789abcdef', ROUTE_ID), { code: 'HISTORY_ID_BINDING_INVALID' });
});

test('summarizes a captured hNvQHb detail response without persisting IDs, text or signed URLs', () => {
  const content = {
    conversationId: API_ID,
    messages: [
      { role: 'user', text: 'Neutral geometry prompt' },
      { role: 'model', text: 'Neutral geometry result' },
      { role: 'thought', thought: 'Do not expose this internal text.' },
    ],
    artifact: { url: 'https://gemini.gstatic.com/gg-dl/task/output.png?signature=memory-only' },
  };
  const body = framed([['wrb.fr', 'hNvQHb', JSON.stringify(content)]]);
  const result = inspectHistoryDetailResponse(body, operation(), {
    expectedIntent: 'Neutral geometry prompt',
    assetOrigins: ['https://gemini.gstatic.com'],
    capability: 'image',
  });
  assert.equal(result.summary.framing, 'utf16_length_frames');
  assert.equal(result.summary.rpcMatchCount, 1);
  assert.equal(result.summary.taskIntentMatched, true);
  assert.equal(result.summary.mediaSummary.allowedAssetUrlCandidateCount, 1);
  const audit = JSON.stringify(result.summary);
  assert.equal(audit.includes(API_ID), false);
  assert.equal(audit.includes('Neutral geometry'), false);
  assert.equal(audit.includes('memory-only'), false);
  assert.equal(result.internal.payload.conversationId, API_ID);
  assert.equal(result.internal.media.assetCandidates[0].url, 'https://gemini.gstatic.com/gg-dl/task/output.png?signature=memory-only');
});

test('stops when the hNvQHb response selector does not match the captured contract', () => {
  const body = framed([['wrb.fr', null, JSON.stringify({ messages: [] })]]);
  const result = inspectHistoryDetailResponse(body, operation(), { expectedIntent: 'absent' });
  assert.equal(result.summary.rpcMatchCount, 0);
  assert.equal(result.summary.taskIntentMatched, false);
});

test('routes history detail through the client using the captured template and raw API ID', async () => {
  const prompt = 'Reply with the sum of 17 + 25 and the label PROTOCOL42.';
  const payload = { conversationId: API_ID, messages: [{ role: 'user', text: prompt }, { role: 'model', text: '42 PROTOCOL42' }] };
  const body = framed([['wrb.fr', 'hNvQHb', JSON.stringify(payload)]]);
  let sent;
  const client = new GeminiWebClient({
    contract: liveReadContract(),
    session: liveSession(),
    fetchImpl: async (url, options) => {
      sent = { url: new URL(url), options };
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    },
  });
  const result = await client.readHistoryDetail({ apiConversationId: API_ID, visibleRouteId: ROUTE_ID, expectedIntent: prompt });
  const form = new URLSearchParams(Buffer.from(sent.options.body).toString('utf8'));
  const outer = JSON.parse(form.get('f.req'));
  const args = JSON.parse(outer[0][0][1]);
  assert.equal(sent.url.origin, SERVICE_ORIGIN);
  assert.equal(sent.url.searchParams.get('rpcids'), 'hNvQHb');
  assert.equal(args[0], API_ID);
  assert.deepEqual(args.slice(1), [10, null, 1, [1], [4], null, 1]);
  assert.equal(result.summary.taskIntentMatched, true);
  assert.equal(result.summary.apiConversationIdMatched, true);
  assert.equal(result.payload.messages[1].text, '42 PROTOCOL42');
  assert.equal(result.credentialPropagated, true);
});
