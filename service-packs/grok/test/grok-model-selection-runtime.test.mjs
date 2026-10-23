import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryGrokModelSelectionRuntime } from '../src/runtime.mjs';
import {
  createInMemoryGrokModeStore,
} from '../src/runtime.mjs';

const catalog = {
  defaultModeId: 'auto',
  modes: [
    { id: 'auto', title: 'Auto', availability: { available: true } },
    { id: 'fast', title: 'Fast', availability: { available: true } },
  ],
};

test('process-memory mode store keeps the first-party selectedModeId and user setter semantics', () => {
  const store = createInMemoryGrokModeStore();
  assert.equal(store.getState().selectedModeId, null);
  store.getState().setSelectedModeId('fast', { source: 'user' });
  assert.equal(store.getState().selectedModeId, 'fast');
  assert.throws(() => store.getState().setSelectedModeId('auto', { source: 'sync' }), { code: 'MODEL_MODE_SOURCE_INVALID' });
  assert.throws(() => createInMemoryGrokModeStore({ selectedModeId: 'invalid id' }), { code: 'MODEL_MODE_STORE_INVALID' });
});

test('model-selection runtime wires its private mode reader and local selector without a browser dependency', async () => {
  let networkCalls = 0;
  const runtime = await createInMemoryGrokModelSelectionRuntime({
    fetchImpl: async () => { networkCalls++; throw new Error('network_not_expected'); },
  });
  assert.equal(runtime.sessionPersistence.provider, 'process-memory-only');
  assert.equal(runtime.modelSelection.selected(), null);
  const selected = runtime.modelSelection.select(catalog, 'fast');
  assert.equal(selected.selectedModeId, 'fast');
  assert.equal(selected.serverPreferenceWritePerformed, false);
  assert.equal(runtime.modelSelection.selected(), 'fast');
  assert.equal(networkCalls, 0);
});

test('runtime selected-mode text method reads a fresh catalog and rejects a mismatched native session model before dispatch', async () => {
  const owner = 'owner@example.test';
  const calls = [];
  const runtime = await createInMemoryGrokModelSelectionRuntime({
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push([parsed.pathname, init.method]);
      if (parsed.pathname === '/api/auth/session') {
        return new Response(JSON.stringify({ session: { email: owner } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (parsed.pathname === '/rest/modes') {
        return new Response(JSON.stringify({ defaultModeId: 'auto', modes: catalog.modes }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('unexpected_test_request');
    },
  });
  await runtime.client.importSession({
    schemaVersion: 1, serviceId: 'grok-web', origin: 'https://grok.com',
    capturedAt: new Date().toISOString(), sourceObservationId: 'runtime-mode-test',
    origins: [{ origin: 'https://grok.com', headers: [], cookies: [{ name: 'sso', value: 'test-value',
      domain: '.grok.com', path: '/', secure: true, httpOnly: true }] }],
  });
  await runtime.client.verifyOwner(owner);
  const state = await runtime.sessionPersistence.read();
  const role = 'codex-grok-model-current-validation-20261006';
  let dispatchCount = 0;
  await assert.rejects(runtime.submitTextInSelectedMode({
    modeId: 'fast', expectedPageRole: role,
    selectionEvidence: { source: 'normal_sdk_mode_menu', pageRole: role, selectedModeId: 'fast',
      visibleSelectedTitle: 'Fast', visibleSelectedMode: true, controlEnabled: true, userSelectionClicked: true,
      sourceSetterCallsiteVerified: true, preferenceWriteForwarded: false },
    capture: { sourcePageRole: role, browserWriteAbortVerified: true, browserBusinessFramesCaptured: 1,
      browserBusinessWritesDelivered: 0, browserControlFramesForwarded: 1,
      socketUrl: 'wss://grok.com/ws/mgw/?uid=test-connection',
      controlFrameText: JSON.stringify({ event: { event_id: 'evt', type: 'session.create', session: { model: 'expert' } } }),
      frameText: '{}' },
    expectedPrompt: 'What is 21 + 21? Reply with only its decimal result.',
    expectedAssistantText: '42', intentId: 'runtime-selected-mode-mismatch', confirm: true,
    dispatchImpl: async () => { dispatchCount++; return {}; },
  }), { code: 'MODEL_TEXT_SESSION_MODE_MISMATCH' });
  assert.equal(state.session.ownerBinding.identityDigest.length, 64);
  assert.deepEqual(calls, [['/api/auth/session', 'GET'], ['/rest/modes', 'POST']]);
  assert.equal(dispatchCount, 0);
  assert.equal(runtime.modelSelection.submitTextInSelectedMode, runtime.submitTextInSelectedMode);
  await runtime.client.clearSession();
});
