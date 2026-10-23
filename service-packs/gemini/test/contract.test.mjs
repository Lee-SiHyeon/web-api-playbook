import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadObservedContract, requireCapturedOperation, validateObservedContract } from '../src/contract.mjs';
import { buildEvidenceMatrix } from '../src/evidence.mjs';
import { rawContract, operation, contract } from './helpers.mjs';

test('keeps every Gemini capability unverified before browser capture', () => {
  const matrix = buildEvidenceMatrix();
  for (const states of Object.values(matrix)) {
    assert.deepEqual(states, {
      captured: false,
      client_exists: false,
      remnant_free: false,
      credential_propagated: false,
      live_replay: false,
    });
  }
});

test('accepts only paired, operation-specific observations on the Gemini origin', () => {
  const observed = contract({
    operations: { history: operation({ queryKeys: ['f.sid'] }) },
  });
  assert.equal(requireCapturedOperation(observed, 'history').request.queryKeys[0], 'f.sid');
  assert.throws(() => requireCapturedOperation(observed, 'text'), { code: 'CONTRACT_NOT_CAPTURED' });
});

test('rejects contracts scoped to another Google product or an unsupported response operation', () => {
  const wrongOrigin = rawContract();
  wrongOrigin.origin = 'https://flow.google.com';
  assert.throws(() => validateObservedContract(wrongOrigin), { code: 'CONTRACT_ORIGIN_MISMATCH' });

  const unobserved = rawContract({ operations: { text: { ...operation(), observation: { requestResponse: false } } } });
  assert.throws(() => validateObservedContract(unobserved), { code: 'CONTRACT_NOT_CAPTURED' });
});

test('requires a no-retry declaration for captured mutations', () => {
  const mutation = operation({ effect: 'mutation', method: 'POST', contentType: 'application/x-www-form-urlencoded', retryPolicy: 'always' });
  assert.throws(() => validateObservedContract(rawContract({ operations: { text: mutation } })), { code: 'CONTRACT_INVALID' });
});

test('requires an explicit length unit and suffix for batchexecute framing', () => {
  const observedOperation = operation({ framing: 'batchexecute', rpcId: 'captured-rpc-id' });
  delete observedOperation.response.frameLengthUnit;
  delete observedOperation.response.frameLengthOverheadUnits;
  assert.throws(() => validateObservedContract(rawContract({ operations: { history_list: observedOperation } })), { code: 'CONTRACT_INVALID' });
});

test('binds read RPC templates to their captured response selector without storing input values', () => {
  const base = operation({
    method: 'POST', path: '/_/BardChatUi/data/batchexecute',
    queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
    contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    framing: 'batchexecute', rpcId: 'unqWSc',
  });
  base.request.bodyFieldNames = ['f.req', 'at'];
  base.request.rpcId = 'unqWSc';
  base.request.rpcArgsTemplate = ['{{searchQuery}}'];
  const observed = validateObservedContract(rawContract({ operations: { history_search: base } }));
  assert.equal(observed.operations.history_search.request.rpcArgsTemplate[0], '{{searchQuery}}');

  const mismatched = structuredClone(base);
  mismatched.response.rpcId = 'ESY5D';
  assert.throws(() => validateObservedContract(rawContract({ operations: { history_search: mismatched } })), { code: 'CONTRACT_INVALID' });

  const persistedQuery = structuredClone(base);
  persistedQuery.request.rpcArgsTemplate = ['private search query'];
  assert.throws(() => validateObservedContract(rawContract({ operations: { history_search: persistedQuery } })), { code: 'CONTRACT_INVALID' });
});

test('permits an explicitly marked bounded static protocol literal in a request-only mutation template', () => {
  const mutation = operation({
    method: 'POST', path: '/_/BardChatUi/data/batchexecute',
    queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
    contentType: 'application/x-www-form-urlencoded;charset=UTF-8', effect: 'mutation', retryPolicy: 'never',
  });
  mutation.observation = { request: true, requestResponse: false };
  delete mutation.response;
  mutation.request.bodyFieldNames = ['f.req', 'at'];
  mutation.request.rpcId = 'MUAZcd';
  mutation.request.rpcArgsTemplate = [null, [[{ $literal: 'field' }]], ['{{conversationId}}', '{{newTitle}}']];
  const observed = validateObservedContract(rawContract({ operations: { edit: mutation } }));
  assert.equal(observed.operations.edit.request.rpcArgsTemplate[1][0][0].$literal, 'field');

  const unsafe = structuredClone(mutation);
  unsafe.request.rpcArgsTemplate[1][0][0].$literal = 'private title text';
  assert.throws(() => validateObservedContract(rawContract({ operations: { edit: unsafe } })), { code: 'CONTRACT_INVALID' });
});

test('missing manifest remains CONTRACT_NOT_CAPTURED', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-contract-'));
  try {
    await assert.rejects(loadObservedContract(path.join(root, 'missing.json')), { code: 'CONTRACT_NOT_CAPTURED' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
