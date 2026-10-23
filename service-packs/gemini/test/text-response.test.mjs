import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestOnlyTextResponse } from '../src/text-response.mjs';
import { validateObservedContract } from '../src/contract.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';

const cid = 'c_0123456789abcdef';
const rid = 'abcdef0123456789';

function contract() {
  return validateObservedContract({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    assetOrigins: [],
    operations: {
      text: {
        observation: { request: true, requestResponse: false },
        effect: 'mutation',
        retryPolicy: 'never',
        request: {
          method: 'POST',
          origin: SERVICE_ORIGIN,
          path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
          queryKeys: ['bl', 'f.sid', 'hl', '_reqid', 'rt'],
          headerNames: ['content-type'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
          bodyFieldNames: ['f.req', 'at'],
        },
      },
    },
  });
}

function wire(values) {
  return Buffer.from(")]}'\n" + values.map((value) => {
    const json = JSON.stringify(value);
    return `${json.length + 2}\n${json}\n`;
  }).join(''), 'utf8');
}

function response(data) {
  return [['wrb.fr', null, JSON.stringify(data)]];
}

test('decodes ordered progressive StreamGenerate frames and binds stable metadata IDs', () => {
  const body = wire([
    response([null, [cid, rid], null, null, []]),
    response([null, [cid, rid], null, null, [[0, ['The answer is ']], [1, ['ignore alternate']]]]),
    response([null, [cid, rid], null, null, [[0, ['The answer is 42. Label: PROTOCOL42.']]]]),
  ]);
  const result = parseRequestOnlyTextResponse(contract(), body, { contentType: 'application/json' });
  assert.equal(result.matched, true);
  assert.equal(result.text, 'The answer is 42. Label: PROTOCOL42.');
  assert.equal(result.nullSelectorFrameCount, 3);
  assert.equal(result.mainCandidateChunkCount, 2);
  assert.equal(result.chunkAssembly, 'cumulative_updates');
  assert.equal(result.conversationId, cid);
  assert.equal(result.responseId, rid);
});

test('preserves the exact decoded main-candidate text including a trailing newline', () => {
  const candidate = 'MIME49:OK!!!\n';
  const data = [null, [cid, rid], null, null, [[0, [candidate]]]];
  const body = wire([response(data)]);
  const result = parseRequestOnlyTextResponse(contract(), body, { contentType: 'application/json' });

  assert.equal(result.matched, true);
  assert.equal(result.text, candidate);
  assert.equal(result.text.endsWith('\n'), true);
  assert.equal(result.chunkAssembly, 'ordered_chunks');
});

test('keeps a missing or conflicting response ID from becoming a false decoded success', () => {
  const conflict = wire([
    response([null, [cid, rid], null, null, [[0, ['first']]]]),
    response([null, [cid, 'different-response-id'], null, null, [[0, ['second']]]]),
  ]);
  const result = parseRequestOnlyTextResponse(contract(), conflict, { contentType: 'application/json' });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'response_identifier_conflict');
  assert.equal(result.text, undefined);
});

test('does not parse a request-only contract as a browser-paired response or accept a different MIME', () => {
  const observed = contract();
  assert.throws(() => parseRequestOnlyTextResponse({ operations: {
    text: { ...observed.operations.text, response: { framing: 'batchexecute', selector: 'null' } },
  } }, wire([]), { contentType: 'application/json' }), { code: 'TEXT_RESPONSE_CONTRACT_REQUIRED' });
  assert.throws(() => parseRequestOnlyTextResponse(observed, wire([response([null, [cid, rid], null, null, [[0, ['x']]]])]), {
    contentType: 'text/html',
  }), { code: 'TEXT_RESPONSE_CONTRACT_REQUIRED' });
});
