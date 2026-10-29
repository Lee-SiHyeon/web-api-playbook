import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperation, loadRegistry, materializeRequest, PRIMARY_ORIGIN, validateRegistry } from '../src/contracts.mjs';
import { ChatGPTWebError } from '../src/errors.mjs';
import { syntheticOperation, syntheticRegistry } from './helpers.mjs';

test('the checked-in registry holds only the captured read operations and blocks everything else explicitly', async () => {
  const registry = await loadRegistry();
  assert.deepEqual(registry.operations.map((operation) => operation.id).sort(),
    ['history.conversation.read', 'image.conversation.init', 'image.file.download']);
  assert.ok(registry.operations.every((operation) => operation.kind === 'read'));
  // the send call is recorded in discovery/ only, never registered for replay
  assert.equal(registry.operations.some((operation) => operation.pathTemplate.includes('/f/conversation')), false);
  assert.throws(() => getOperation(registry, 'text.send'), (error) => error.code === 'CONTRACT_NOT_CAPTURED');
  assert.throws(() => getOperation(registry, 'text.history'), (error) => error.code === 'CONTRACT_NOT_CAPTURED');
});

test('captured contracts bind named inputs without accepting arbitrary paths or origins', () => {
  const operation = syntheticOperation({ id: 'history.read.synthetic', kind: 'read', method: 'GET', encoding: 'none' });
  operation.pathTemplate = '/__synthetic__/{targetId}';
  operation.queryTemplate = [{ name: 'cursor', input: 'cursor' }];
  operation.inputSchema.cursor = { type: 'string', maxLength: 100 };
  const registry = syntheticRegistry([operation]);
  const bound = materializeRequest(registry.operations[0], { targetId: 'a/b', cursor: 'x y' });
  assert.equal(bound.url.origin, PRIMARY_ORIGIN);
  assert.equal(bound.url.pathname, '/__synthetic__/a%2Fb');
  assert.equal(bound.url.searchParams.get('cursor'), 'x y');
  assert.throws(() => materializeRequest(registry.operations[0], { targetId: 'x', cursor: 'y', extra: 'z' }),
    (error) => error.code === 'INPUT_UNKNOWN');
});

test('contract validation rejects unobserved origins and credential or challenge headers', () => {
  const base = syntheticOperation();
  const registry = { schemaVersion: 1, service: 'chatgpt-web', primaryOrigin: PRIMARY_ORIGIN,
    captured: true, captureReference: 'tests/fixtures/synthetic-capture.json', allowedOrigins: [PRIMARY_ORIGIN], operations: [base] };
  assert.throws(() => validateRegistry({ ...registry, allowedOrigins: [PRIMARY_ORIGIN, 'https://example.test'],
    operations: [{ ...base, origin: 'https://example.test' }] }), ChatGPTWebError);
  assert.throws(() => validateRegistry({ ...registry, operations: [{ ...base,
    request: { ...base.request, headers: { cookie: 'never-stored' } } }] }), ChatGPTWebError);
  assert.throws(() => validateRegistry({ ...registry, operations: [{ ...base,
    request: { ...base.request, headers: { 'x-captcha-token': 'never-stored' } } }] }), ChatGPTWebError);
  for (const header of ['x-session-token', 'x-auth-proof', 'x-csrf-token']) {
    assert.throws(() => validateRegistry({ ...registry, operations: [{ ...base,
      request: { ...base.request, headers: { [header]: 'never-static' } } }] }), ChatGPTWebError);
  }
  for (const queryName of ['signature', 'nonce', 'session_id']) {
    assert.throws(() => validateRegistry({ ...registry, operations: [{ ...base,
      queryTemplate: [{ name: queryName, value: 'never-static' }] }] }), ChatGPTWebError);
  }
  assert.throws(() => validateRegistry({ ...registry, operations: [{ ...base,
    request: { ...base.request, template: { message: { $input: 'text' }, metadata: { challengeToken: 'never-static' } } } }] }), ChatGPTWebError);
  assert.throws(() => validateRegistry({ ...registry, operations: [{ ...base,
    request: { ...base.request, template: { message: { $input: 'text' }, nested: { authorization: 'never-static' } } } }] }), ChatGPTWebError);
});
