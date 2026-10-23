import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryGrokConversationRuntime } from '../src/runtime.mjs';
import { loadContractRegistry } from '../src/client.mjs';

test('in-memory runtime wires the conversation facade to the same client and journal', async () => {
  const registry = await loadContractRegistry();
  const runtime = await createInMemoryGrokConversationRuntime({ registry, fetchImpl: async () => new Response('{}') });
  assert.equal(typeof runtime.conversations.list, 'function');
  assert.equal(typeof runtime.conversations.search, 'function');
  assert.equal(typeof runtime.conversations.read, 'function');
  assert.equal(typeof runtime.conversations.responseNodes, 'function');
  assert.equal(typeof runtime.conversations.loadResponses, 'function');
  assert.equal(typeof runtime.conversations.taskResponses, 'function');
  assert.equal(typeof runtime.conversations.settings, 'function');
  assert.equal(typeof runtime.conversations.update, 'function');
  assert.equal(typeof runtime.conversations.delete, 'function');
  assert.equal(await runtime.client.status().then(status => status.session.available), false);
});
