import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiWebClient } from '../src/client.mjs';
import { validateObservedContract } from '../src/contract.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';
import {
  extractConversationSummaries,
  GEMINI_HISTORY_SEARCH_RPC,
  GEMINI_MODEL_STATUS_RPC,
  GEMINI_READ_USER_PREFERENCES_RPC,
  GEMINI_PUBLIC_SHARED_CONVERSATION_RPC,
  listConversations,
  parseModelStatus,
  parsePreferenceResponse,
  publicShareConversationRowCount,
  publicShareConversationRowHasId,
  publicShareMatchesConversationTitle,
  readConversation,
  readAnonymousSharedConversation,
  readModels,
  readPublicShareLinks,
  readSharedConversation,
  readSettings,
  searchConversations,
} from '../src/conversation-lifecycle.mjs';

const OWNER = 'owner@example.com';
const COOKIE_NAMES = ['AUTH_COOKIE'];
const QUERY_KEYS = ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'];
const BATCH_PATH = '/_/BardChatUi/data/batchexecute';

function rawContract() {
  const operation = (rpcId, rpcArgsTemplate, extraRequest = {}) => ({
    observation: { request: true, requestResponse: true }, effect: 'read',
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: BATCH_PATH,
      queryKeys: QUERY_KEYS, headerNames: ['content-type', 'referer', 'x-same-domain'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
      rpcId, rpcArgsTemplate, ...extraRequest,
    },
    response: {
      contentType: 'application/json', framing: 'batchexecute', rpcId,
      frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
    },
  });
  return validateObservedContract({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: COOKIE_NAMES, headerNames: [] },
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
          method: 'POST', origin: SERVICE_ORIGIN, path: BATCH_PATH,
          queryKeys: QUERY_KEYS, headerNames: ['content-type', 'referer', 'x-same-domain'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
          bodyFieldNames: ['f.req', 'at'],
        },
        response: {
          contentType: 'application/json', framing: 'batchexecute', rpcId: 'MaZiqc',
          frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
        },
      },
      history_search: operation('unqWSc', ['{{searchQuery}}']),
      history_read: {
        ...operation('hNvQHb', ['{{apiConversationId}}', 10, null, 1, [1], [4], null, 1]),
        response: {
          contentType: 'application/json', framing: 'batchexecute', selectorMode: 'rpc_id', rpcId: 'hNvQHb',
          frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
        },
      },
      model_list: operation('otAQ7b', []),
      settings_read: operation('ESY5D', [null, '{{preferenceFieldIds}}'], {
        allowlistedPreferenceKeys: [
          'voice_language', 'voice_name', 'enable_advanced_mode', 'enable_memory',
          'enable_personal_context', 'web_and_app_activity_enabled', 'side_nav_open_by_default',
        ],
        preferenceFieldIds: [62, 61, 39, 25, 77, 93, 41],
      }),
      share_read: operation('OXxBcc', []),
      share_public_read: operation('ujx1Bf', [null, '{{shareId}}', [4]]),
    },
  });
}

function makeSession() {
  return {
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    capturedAt: '2026-10-06T00:00:00.000Z',
    cookies: [{ name: 'AUTH_COOKIE', value: 'memory-only-cookie' }],
    headers: {},
    requestHeaders: {
      history_list: { referer: `${SERVICE_ORIGIN}/app`, 'x-same-domain': '1' },
    },
    batchContext: {
      at: 'memory-only-token', fSid: 'memory-only-sid', buildLabel: 'build_1',
      locale: 'en', requestType: 'c', sourcePath: '/app', requestId: '4120',
      historyListArgs: [28, null, [0, null, 1]],
    },
  };
}

function framed(rpcId, data) {
  const frame = JSON.stringify(['wrb.fr', rpcId, JSON.stringify(data), null, null]);
  const units = Buffer.byteLength(frame, 'utf16le') / 2;
  return Buffer.from(`)]}'\n${units + 2}\n${frame}\n`, 'utf8');
}

function makeClient(onRead) {
  const client = new GeminiWebClient({
    contract: rawContract(),
    session: makeSession(),
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/app') {
        const html = init.headers.get('cookie')
          ? `<chat-app-orchestrator>${OWNER}</chat-app-orchestrator><script>WIZ_global_data=${JSON.stringify({ oPEP7c: OWNER })};</script>`
          : '<chat-app-orchestrator>signed out</chat-app-orchestrator>';
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      assert.equal(parsed.pathname, BATCH_PATH);
      const form = new URLSearchParams(String(init.body));
      const outer = JSON.parse(form.get('f.req'));
      const call = outer[0][0];
      const args = JSON.parse(call[1]);
      const request = Object.freeze({ url: parsed, form, rpcId: call[0], args });
      const data = await onRead(request);
      return new Response(framed(call[0], data), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });
  return client;
}

test('extracts bounded conversation metadata from the captured list payload', () => {
  const data = [null, null, JSON.stringify([
    ['c_0123456789abcdef', 'Protocol discussion', true, null, null, [1_800_000_000, 250_000_000]],
    ['c_fedcba9876543210', 'Second conversation', false, null, null, [1_800_000_001, 0]],
    ['not-an-api-id', 'Ignore this row'],
  ])];
  const rows = extractConversationSummaries(data);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    conversationId: 'c_0123456789abcdef',
    title: 'Protocol discussion',
    pinned: true,
    updatedAt: '2027-01-15T08:00:00.250Z',
  });
  assert.equal(rows[1].pinned, false);
});

test('searches through the captured normal Gemini SearchConversations RPC', async () => {
  const query = 'PROTOCOL42';
  const client = makeClient(async ({ rpcId, args, url, form }) => {
    assert.equal(rpcId, GEMINI_HISTORY_SEARCH_RPC);
    assert.deepEqual(args, [query]);
    assert.deepEqual([...url.searchParams.keys()], QUERY_KEYS);
    assert.deepEqual([...form.keys()], ['f.req', 'at']);
    return ['result-count', 2];
  });
  const result = await searchConversations(client, { expectedOwner: OWNER, query });
  assert.equal(result.ownerMatched, true);
  assert.equal(result.anonymousOwnerAbsent, true);
  assert.equal(result.rpcId, GEMINI_HISTORY_SEARCH_RPC);
  assert.equal(result.queryLength, query.length);
  assert.deepEqual(result.request.queryKeys, QUERY_KEYS);
  assert.deepEqual(result.request.formFieldNames, ['f.req', 'at']);
  assert.equal(result.request.valuesPersisted, false);
  assert.equal(JSON.stringify(result.request).includes(query), false);
  assert.deepEqual(result.data, ['result-count', 2]);
  assert.equal(JSON.stringify(result).includes(query), false);
});

test('lists the observed MaZiqc first page with its captured bounded arguments', async () => {
  const row = ['c_0123456789abcdef', 'PROTOCOL42 task', false, null, null, [1_800_000_000, 0]];
  const client = makeClient(async ({ rpcId, args }) => {
    assert.equal(rpcId, 'MaZiqc');
    assert.deepEqual(args, [28, null, [0, null, 1]]);
    return [null, null, JSON.stringify([row])];
  });
  const result = await listConversations(client, { expectedOwner: OWNER });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].title, 'PROTOCOL42 task');
  assert.equal(Array.isArray(result.data), true);
  assert.ok(result.dataShape);
});

test('reads available models from the source-backed GetUserStatus RPC and types account data', async () => {
  const modelRow = [];
  modelRow[0] = 'fbb127bbb056c959';
  modelRow[1] = 'Flash';
  modelRow[2] = 'Fast answers';
  modelRow[11] = 'Gemini Flash';
  modelRow[12] = 'Answers quickly';
  modelRow[17] = 1;
  const status = [];
  status[14] = 1000;
  status[15] = [modelRow];
  status[16] = [];
  status[17] = [];
  const client = makeClient(async ({ rpcId, args }) => {
    assert.equal(rpcId, GEMINI_MODEL_STATUS_RPC);
    assert.deepEqual(args, []);
    return status;
  });
  const result = await readModels(client, { expectedOwner: OWNER });
  assert.equal(result.accountStatus, 'available');
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.models[0], {
    modelId: 'fbb127bbb056c959', modelName: 'gemini-flash', displayName: 'Gemini Flash',
    description: 'Answers quickly', capacity: 1, capacityField: 12, modelNumber: 1, available: true,
  });
});

test('reads only source-mapped numeric preference fields and returns typed values', async () => {
  const keys = ['enable_memory', 'voice_language'];
  const preferenceVector = [];
  preferenceVector[25] = 'true';
  preferenceVector[62] = 'ko';
  const data = [preferenceVector];
  const client = makeClient(async ({ rpcId, args }) => {
    assert.equal(rpcId, GEMINI_READ_USER_PREFERENCES_RPC);
    assert.deepEqual(args, [null, [62, 61, 39, 25, 77, 93, 41]]);
    return data;
  });
  const result = await readSettings(client, { expectedOwner: OWNER, keys });
  assert.deepEqual(result.settings, {
    enable_memory: { found: true, type: 'boolean', value: true },
    voice_language: { found: true, type: 'string', value: 'ko' },
  });
  assert.deepEqual(result.requestedKeys, keys);
});

test('rejects unsupported preference names before any request is sent', async () => {
  let requestCount = 0;
  const client = makeClient(async () => { requestCount += 1; return []; });
  await assert.rejects(readSettings(client, { expectedOwner: OWNER, keys: ['arbitrary_private_key'] }), {
    code: 'SETTINGS_KEYS_INVALID',
  });
  assert.equal(requestCount, 0);
});

test('decodes by the published preference field IDs and rejects non-primitive values', () => {
  const preferenceVector = [];
  preferenceVector[25] = { nested: 'value' };
  preferenceVector[62] = 'ko';
  assert.deepEqual(parsePreferenceResponse([preferenceVector], ['enable_memory', 'voice_language']), {
    enable_memory: { found: false, type: 'unsupported' },
    voice_language: { found: true, type: 'string', value: 'ko' },
  });
  assert.throws(() => parsePreferenceResponse([], ['password']), { code: 'SETTINGS_KEYS_INVALID' });
  assert.deepEqual(parseModelStatus([,,,,,,,,,,,,,,1000,[],[],[]]), {
    accountStatus: 'available', statusCode: 1000, models: [],
  });
});

test('uses only the captured ESY5D response field-one vector and preserves unset preferences as unreported', () => {
  const fieldOne = [];
  fieldOne[25] = 'false';
  fieldOne[61] = 'Default voice';
  fieldOne[41] = null;
  const decoy = [];
  decoy[25] = true;
  decoy[61] = 'Decoy voice';
  assert.deepEqual(parsePreferenceResponse([fieldOne, decoy], [
    'enable_memory', 'voice_name', 'side_nav_open_by_default',
  ]), {
    enable_memory: { found: true, type: 'boolean', value: false },
    voice_name: { found: true, type: 'string', value: 'Default voice' },
    side_nav_open_by_default: { found: false, type: 'unreported' },
  });
});

test('reads the owner public-link list through the captured OXxBcc RPC and matches only an exact title in memory', async () => {
  const client = makeClient(async ({ rpcId, args }) => {
    assert.equal(rpcId, 'OXxBcc');
    assert.deepEqual(args, []);
    return [[
      [null, null, [true, 'Unrelated link', null, null, null, null, null], 'share_0001', [1, 2]],
      [null, null, [true, 'Codex API verified text 20261006', null, null, null, null, null], 'share_0002', [3, 4]],
      [null, null, [true, 'Codex API verified text 20261006', null, null, null, null, null], 'share_0003', [5, 6]],
    ]];
  });
  const result = await readPublicShareLinks(client, { expectedOwner: OWNER });
  assert.equal(result.rpcId, 'OXxBcc');
  assert.equal(result.shareCount, 3);
  assert.equal(publicShareMatchesConversationTitle(result.internal.data, 'Codex API verified text 20261006'), true);
  assert.equal(publicShareConversationRowCount(result.internal.data, 'Codex API verified text 20261006'), 2);
  assert.equal(publicShareConversationRowCount(result.internal.data, 'absent task title'), 0);
  assert.equal(publicShareMatchesConversationTitle(result.internal.data, 'absent task title'), false);
  assert.equal(publicShareConversationRowHasId(result.internal.data, 'Codex API verified text 20261006', 'share_0002'), 1);
  assert.equal(publicShareConversationRowHasId(result.internal.data, 'Unrelated link', 'share_0003'), 0);
  assert.equal(JSON.stringify(result).includes('share_0001'), false);
});

test('reads a public share through the captured ujx1Bf args template without serializing its ID or content', async () => {
  const shareId = 'PublicLinkId123456';
  const client = makeClient(async ({ rpcId, args, url, form }) => {
    assert.equal(rpcId, GEMINI_PUBLIC_SHARED_CONVERSATION_RPC);
    assert.deepEqual(args, [null, shareId, [4]]);
    assert.deepEqual([...url.searchParams.keys()], QUERY_KEYS);
    assert.deepEqual([...form.keys()], ['f.req', 'at']);
    return [null, 'Codex API verified text 20261006', 'PROTOCOL42'];
  });
  const result = await readSharedConversation(client, { shareId, expectedOwner: OWNER });
  assert.equal(result.rpcId, 'ujx1Bf');
  assert.equal(result.ownerMatched, true);
  assert.equal(result.shareIdLength, shareId.length);
  assert.equal(JSON.stringify(result).includes(shareId), false);
  assert.equal(JSON.stringify(result).includes('PROTOCOL42'), false);
  assert.deepEqual(result.internal.data, [null, 'Codex API verified text 20261006', 'PROTOCOL42']);
});

test('anonymous public-share RPC omits cookies and authorization while parsing the captured response', async () => {
  const shareId = 'LifecycleLink123456';
  const client = makeClient(async ({ rpcId, args, url, form }) => {
    assert.equal(rpcId, GEMINI_PUBLIC_SHARED_CONVERSATION_RPC);
    assert.deepEqual(args, [null, shareId, [4]]);
    assert.deepEqual([...url.searchParams.keys()], QUERY_KEYS);
    assert.deepEqual([...form.keys()], ['f.req', 'at']);
    return [null, 'LIFECYCLE42'];
  });
  const originalFetch = client.transport.fetch;
  client.transport.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === BATCH_PATH) {
      assert.equal(init.headers.get('cookie'), null);
      assert.equal(init.headers.get('authorization'), null);
      assert.equal(init.headers.get('proxy-authorization'), null);
    }
    return originalFetch(url, init);
  };
  const result = await readAnonymousSharedConversation(client, { shareId });
  assert.equal(result.anonymousRequest, true);
  assert.equal(result.ownerMatched, null);
  assert.equal(result.credentialPropagated, false);
  assert.equal(JSON.stringify(result).includes(shareId), false);
  assert.deepEqual(result.internal.data, [null, 'LIFECYCLE42']);
});

test('preserves direct history detail payload only on a non-enumerable in-memory property', async () => {
  const conversationId = 'c_0123456789abcdef';
  const payload = [conversationId, 'Protocol42 exact user task', 'PROTOCOL42'];
  const client = makeClient(async ({ rpcId, args }) => {
    assert.equal(rpcId, 'hNvQHb');
    assert.equal(args[0], conversationId);
    return payload;
  });
  const detail = await readConversation(client, {
    expectedOwner: OWNER,
    conversationId,
    expectedIntent: 'PROTOCOL42',
  });
  assert.equal(detail.binding.bound, true);
  assert.equal(detail.summary.apiConversationIdMatched, true);
  assert.equal(detail.summary.taskIntentMatched, true);
  assert.deepEqual(detail.payload, payload);
  assert.equal(Object.keys(detail).includes('payload'), false);
  assert.equal(JSON.stringify(detail).includes(conversationId), false);
  assert.equal(JSON.stringify(detail).includes('PROTOCOL42'), false);
});
