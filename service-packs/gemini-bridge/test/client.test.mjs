import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationListRequest, buildConversationReadRequest, GEMINI_ORIGIN, GEMINI_RPC } from '../src/protocol.mjs';
import { GeminiWebClient, GEMINI_SESSION_CREDENTIAL } from '../src/client.mjs';

const ID = 'c_0123456789abcdef0123456789abcdef';
const OTHER_ID = 'c_fedcba9876543210fedcba9876543210';
const NOW = 1_800_000_000_000;
const DOCUMENT = '<html><script>window.data={"SNlM0e":"synthetic-at","FdrFJe":"synthetic-sid","cfb2h":"synthetic-build"}</script></html>';
const ROWS = [['synthetic user text', [1, 'synthetic assistant text']]];

function responseFrame(rpcId, payload) {
  const entry = ['wrb.fr', rpcId, JSON.stringify(payload), null, null, null];
  return ")]}'\n" + JSON.stringify([entry]);
}

function response(body, { status = 200, mime = 'application/json', url = GEMINI_ORIGIN + '/app', setCookies = [] } = {}) {
  const native = new Response(body, { status, headers: { 'content-type': mime } });
  return {
    status,
    url,
    headers: {
      get: (name) => native.headers.get(name),
      getSetCookie: () => setCookies,
    },
    body: native.body,
  };
}

function sessionBundle(cookies = [
  { name: 'SID', value: 'synthetic-sid-cookie', domain: '.google.com', path: '/', secure: true, httpOnly: true, expires: -1 },
  { name: '__Secure-1PSID', value: 'synthetic-secure-cookie', domain: '.google.com', path: '/', secure: true, httpOnly: true, expires: -1 },
  { name: 'APP_ONLY', value: 'synthetic-app-only', domain: 'gemini.google.com', path: '/app', secure: false, httpOnly: false, expires: -1 },
  { name: 'EXPIRED', value: 'synthetic-expired', domain: '.google.com', path: '/', secure: true, httpOnly: false, expires: NOW / 1000 - 1 },
  { name: 'HOST_ONLY_OTHER', value: 'synthetic-other-host', domain: 'google.com', path: '/', secure: true, httpOnly: false, expires: -1 },
  { name: 'OTHER_PATH', value: 'synthetic-other-path', domain: '.google.com', path: '/outside', secure: true, httpOnly: false, expires: -1 },
]) {
  return JSON.stringify({ version: 1, origin: GEMINI_ORIGIN, cookies, capturedAt: '2026-01-01T00:00:00.000Z' });
}

function makeClient({ fetchImpl, bundle = sessionBundle(), writeSession = () => {}, reqId = () => 1_234_567 } = {}) {
  return new GeminiWebClient({
    fetchImpl,
    readSession: () => bundle,
    writeSession,
    reqId,
    now: () => NOW,
  });
}

function conversationFetch(calls, { listRows = [[ID, '  synthetic title  ']], detailRows = ROWS, listResponse } = {}) {
  return async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (init.method === 'GET') return response(DOCUMENT, { mime: 'text/html', url: url.href });
    if (listResponse && url.searchParams.get('rpcids') === GEMINI_RPC.listConversations) return listResponse(url);
    const rpcId = url.searchParams.get('rpcids');
    if (rpcId === GEMINI_RPC.listConversations) {
      return response(responseFrame(rpcId, [null, null, listRows]), { url: url.href });
    }
    if (rpcId === GEMINI_RPC.readConversation) {
      return response(responseFrame(rpcId, [detailRows]), { url: url.href });
    }
    throw new Error('Synthetic test received an unrecognized RPC.');
  };
}

test('client uses only observed read RPCs and scopes cookies to each request path', async () => {
  const calls = [];
  const client = makeClient({ fetchImpl: conversationFetch(calls) });
  const started = await client.start();
  assert.equal(started.httpStatus, 200);
  assert.equal(started.path, '/app');

  const listed = await client.listConversations();
  assert.deepEqual(listed, [{ id: ID, title: '  synthetic title  ' }]);
  const read = await client.readConversation(ID);
  assert.deepEqual(read, { id: ID, title: '  synthetic title  ', rows: ROWS });

  const getCall = calls[0];
  assert.equal(getCall.url.origin, GEMINI_ORIGIN);
  assert.equal(getCall.url.pathname, '/app');
  assert.equal(getCall.init.redirect, 'manual');
  assert.match(getCall.init.headers.cookie, /SID=synthetic-sid-cookie/);
  assert.match(getCall.init.headers.cookie, /APP_ONLY=synthetic-app-only/);
  assert.doesNotMatch(getCall.init.headers.cookie, /EXPIRED|HOST_ONLY_OTHER|OTHER_PATH/);

  const posts = calls.filter((call) => call.init.method === 'POST');
  assert.equal(posts.length, 3);
  for (const call of posts) {
    assert.equal(call.url.origin, GEMINI_ORIGIN);
    assert.equal(call.url.pathname, '/_/BardChatUi/data/batchexecute');
    assert.deepEqual([...call.url.searchParams.keys()], ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt']);
    assert.equal(call.url.searchParams.get('source-path'), '/app');
    assert.equal(call.url.searchParams.get('hl'), 'ko');
    assert.equal(call.url.searchParams.get('rt'), 'c');
    assert.match(call.url.searchParams.get('_reqid'), /^\d{7}$/);
    assert.equal(call.init.headers.origin, GEMINI_ORIGIN);
    assert.equal(call.init.headers.referer, GEMINI_ORIGIN + '/');
    assert.equal(call.init.headers['x-same-domain'], '1');
    assert.equal(call.init.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.doesNotMatch(call.init.headers.cookie, /APP_ONLY|EXPIRED|HOST_ONLY_OTHER|OTHER_PATH/);
    assert.deepEqual([...call.init.body.keys()], ['f.req', 'at']);
    assert.equal(call.init.body.get('at'), 'synthetic-at');
  }
  assert.equal(posts[0].url.searchParams.get('rpcids'), GEMINI_RPC.listConversations);
  assert.equal(posts[0].init.body.get('f.req'), buildConversationListRequest());
  assert.equal(posts[2].url.searchParams.get('rpcids'), GEMINI_RPC.readConversation);
  assert.equal(posts[2].init.body.get('f.req'), buildConversationReadRequest(ID));

  assert.deepEqual(client.evidence.map((item) => item.operation), [
    'document', GEMINI_RPC.listConversations, GEMINI_RPC.listConversations, GEMINI_RPC.readConversation,
  ]);
  for (const item of client.evidence) {
    assert.equal(Object.hasOwn(item, 'title'), false);
    assert.equal(Object.hasOwn(item, 'rows'), false);
    assert.equal(Object.hasOwn(item, 'cookie'), false);
    assert.equal(Object.hasOwn(item, 'body'), false);
  }
  assert.equal(GEMINI_SESSION_CREDENTIAL, 'google-gemini-session-v1');
});

test('readConversation checks current list ownership before requesting hNvQHb', async () => {
  const calls = [];
  const client = makeClient({ fetchImpl: conversationFetch(calls, { listRows: [[OTHER_ID, 'other conversation']] }) });
  await client.start();
  await assert.rejects(client.readConversation(ID), (error) => error.code === 'GEMINI_CONVERSATION_OUT_OF_SCOPE');
  assert.deepEqual(calls.filter((call) => call.init.method === 'POST').map((call) => call.url.searchParams.get('rpcids')),
    [GEMINI_RPC.listConversations]);
});

test('observed Set-Cookie rotation is persisted before an HTTP rejection is surfaced', async () => {
  const calls = [];
  let persisted;
  const fetchImpl = conversationFetch(calls, {
    listResponse: (url) => response('', {
      status: 403,
      mime: 'application/json',
      url: url.href,
      setCookies: ['SID=synthetic-rotated-sid; Domain=.google.com; Path=/; Secure; HttpOnly'],
    }),
  });
  const client = makeClient({ fetchImpl, writeSession: (value) => { persisted = value; } });
  await client.start();
  await assert.rejects(client.listConversations(), (error) => error.code === 'GEMINI_RPC_HTTP_ERROR' && error.httpStatus === 403);
  assert.equal(JSON.parse(persisted).cookies.find((cookie) => cookie.name === 'SID').value, 'synthetic-rotated-sid');
});

test('client rejects empty or out-of-scope sessions before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not be called'); };
  const empty = makeClient({ fetchImpl, bundle: sessionBundle([]) });
  await assert.rejects(empty.start(), (error) => error.code === 'GEMINI_SESSION_SCOPE_INVALID');

  const wrongOrigin = makeClient({
    fetchImpl,
    bundle: JSON.stringify({ version: 1, origin: 'https://example.com', cookies: [] }),
  });
  await assert.rejects(wrongOrigin.start(), (error) => error.code === 'GEMINI_SESSION_SCOPE_INVALID');
  assert.equal(calls, 0);
});

test('document transport failure preserves only the safe nested network error code', async () => {
  const networkCause = Object.assign(new Error('synthetic transport detail'), { code: 'UND_ERR_HEADERS_OVERFLOW' });
  const fetchImpl = async () => { throw new TypeError('synthetic private request detail', { cause: networkCause }); };
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.start(), (error) => error.code === 'GEMINI_DOCUMENT_TRANSPORT'
    && error.transportCode === 'UND_ERR_HEADERS_OVERFLOW'
    && !error.message.includes('synthetic private request detail')
    && !error.message.includes('synthetic transport detail'));
  assert.equal(client.evidence.length, 1);
  const attempt = client.evidence[0];
  assert.deepEqual(Object.keys(attempt).sort(), [
    'bytes', 'checkedAt', 'httpStatus', 'method', 'mime', 'operation', 'origin', 'path', 'transportCode',
  ]);
  assert.equal(attempt.transportCode, 'UND_ERR_HEADERS_OVERFLOW');
  assert.equal(attempt.httpStatus, null);
  assert.equal(attempt.mime, null);
  assert.match(attempt.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('client rejects MIME and unexpected RPC framing without returning response text', async () => {
  const calls = [];
  const badMimeFetch = conversationFetch(calls, {
    listResponse: (url) => response('<html>synthetic private response</html>', {
      mime: 'text/html', url: url.href,
    }),
  });
  const badMimeClient = makeClient({ fetchImpl: badMimeFetch });
  await badMimeClient.start();
  await assert.rejects(badMimeClient.listConversations(), (error) => error.code === 'GEMINI_RPC_MIME'
    && !error.message.includes('synthetic private response'));

  const wrongRpcCalls = [];
  const wrongRpcFetch = conversationFetch(wrongRpcCalls, {
    listResponse: (url) => response(responseFrame('UnexpectedRpc', ['synthetic private response']), { url: url.href }),
  });
  const wrongRpcClient = makeClient({ fetchImpl: wrongRpcFetch });
  await wrongRpcClient.start();
  await assert.rejects(wrongRpcClient.listConversations(), (error) => error.code === 'GEMINI_RPC_RESULT_MISSING'
    && !error.message.includes('synthetic private response'));
});
