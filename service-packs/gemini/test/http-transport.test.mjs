import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GeminiWebHttpTransport } from '../src/http-transport.mjs';
import { executeMutationOnce } from '../src/mutation.mjs';
import { digestBody, findUnresolvedMutation, mutationIntentDigest } from '../src/journal.mjs';
import { contract, operation, session } from './helpers.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

test('sends only the captured query shape and the Gemini-scoped protected cookie', async () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    operations: { history: operation({ queryKeys: ['f.sid'] }) },
  });
  let call;
  const transport = new GeminiWebHttpTransport({
    contract: observed,
    session: session({ cookieNames: ['AUTH_COOKIE'], cookieValue: 'never-print-this' }),
    fetchImpl: async (url, options) => {
      call = { url: new URL(url), options };
      return jsonResponse({ ok: true });
    },
  });
  const result = await transport.request('history', {
    method: 'GET',
    path: '/captured/operation',
    query: [['f.sid', 'transient-request-value']],
    headers: { accept: 'application/json' },
  });
  assert.equal(call.url.origin, 'https://gemini.google.com');
  assert.equal(call.url.searchParams.get('f.sid'), 'transient-request-value');
  assert.equal(call.options.headers.get('cookie'), 'AUTH_COOKIE=never-print-this');
  assert.equal(result.credentialPropagated, true);
  assert.equal(result.httpStatus, 200);
});

test('does not issue a request when contract path, method, or query keys differ', async () => {
  const observed = contract({ operations: { history: operation({ queryKeys: ['observed'] }) } });
  let calls = 0;
  const transport = new GeminiWebHttpTransport({ contract: observed, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  await assert.rejects(transport.request('history', {
    method: 'GET', path: '/other/path', query: [['observed', 'value']], headers: { accept: 'application/json' },
  }), { code: 'REQUEST_CONTRACT_MISMATCH' });
  await assert.rejects(transport.request('history', {
    method: 'GET', path: '/captured/operation', query: [['unobserved', 'value']], headers: { accept: 'application/json' },
  }), { code: 'REQUEST_CONTRACT_MISMATCH' });
  assert.equal(calls, 0);
});

test('requires a protected session when the observed contract has authentication fields', async () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    operations: { history: operation() },
  });
  const transport = new GeminiWebHttpTransport({ contract: observed, fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(transport.request('history', {
    method: 'GET', path: '/captured/operation', query: [], headers: { accept: 'application/json' },
  }), { code: 'REAUTH_REQUIRED' });
});

test('preserves HTTP rejection and never retries it', async () => {
  const observed = contract({ operations: { history: operation() } });
  let calls = 0;
  const transport = new GeminiWebHttpTransport({
    contract: observed,
    fetchImpl: async () => { calls += 1; return new Response('private error body', { status: 401, headers: { 'content-type': 'text/plain' } }); },
  });
  await assert.rejects(transport.request('history', {
    method: 'GET', path: '/captured/operation', query: [], headers: { accept: 'application/json' },
  }), (error) => error.code === 'HTTP_REJECTED' && error.details.httpStatus === 401 && !error.message.includes('private'));
  assert.equal(calls, 1);
});

test('mutation dispatch needs a one-shot journal and leaves an acknowledged response unresolved', async () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: [], headerNames: [] },
    operations: {
      text: operation({
        effect: 'mutation',
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        headerNames: ['accept', 'content-type'],
      }),
    },
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-jobs-'));
  let calls = 0;
  const transport = new GeminiWebHttpTransport({
    contract: observed,
    session: session(),
    fetchImpl: async () => { calls += 1; return jsonResponse({ accepted: true }); },
  });
  const requestSpec = {
    method: 'POST',
    path: '/captured/operation',
    query: [],
    contentType: 'application/x-www-form-urlencoded',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'observed-form-shape=synthetic-test',
  };
  try {
    const intent = { actor: 'owner@example.com', callerIntent: 'smoke-text-fixture-1' };
    const first = await executeMutationOnce({ transport, capability: 'text', requestSpec, root, ...intent });
    assert.equal(first.response.httpStatus, 200);
    assert.equal(calls, 1);
    const intentHash = mutationIntentDigest({ capability: 'text', ...intent });
    const pending = await findUnresolvedMutation('text', intentHash, { root });
    assert.equal(pending.state, 'response_received');
    assert.equal(pending.wireBodyDigest, digestBody(requestSpec.body));
    const persisted = await readFile(pending.jobPath, 'utf8');
    assert.equal(persisted.includes('observed-form-shape'), false);
    assert.equal(persisted.includes(intent.actor), false);
    const refreshedRequest = { ...requestSpec, body: 'observed-form-shape=synthetic-test&at=rotated-secret' };
    await assert.rejects(executeMutationOnce({ transport, capability: 'text', requestSpec: refreshedRequest, root, ...intent }), { code: 'MUTATION_PENDING' });
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
