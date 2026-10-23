import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGrokModelSelectionClient,
  GROK_MODEL_MODE_OPERATION_ID,
  GROK_MODEL_SELECTION_SOURCE,
  normalizeGrokModelModes,
  readGrokSelectedModeId,
  resolveGrokSelectedMode,
  selectGrokModelMode,
} from '../src/grok-model-selection.mjs';

const catalog = {
  defaultModeId: 'mode-auto',
  modes: [
    { id: 'mode-auto', title: 'Auto', availability: { available: true }, tags: ['ignored safely'] },
    { id: 'mode-expert', title: 'Expert', description: 'Reasoning mode', availability: { available: true } },
    { id: 'mode-locked', title: 'Heavy', availability: { available: false, requiresUpgrade: { minimumSubscriptionTier: 'TIER_SUPERGROK' } } },
  ],
};

test('normalizes the source mode catalog into safe selectable choices', () => {
  assert.deepEqual(normalizeGrokModelModes(catalog), {
    defaultModeId: 'mode-auto',
    modes: [
      { id: 'mode-auto', title: 'Auto', availability: { available: true } },
      { id: 'mode-expert', title: 'Expert', description: 'Reasoning mode', availability: { available: true } },
      { id: 'mode-locked', title: 'Heavy',
        availability: { available: false, requiresUpgrade: { minimumSubscriptionTier: 'TIER_SUPERGROK' } } },
    ],
  });
});

test('reads and selects through the first-party SDK store control only', () => {
  const calls = [];
  const store = {
    getState() {
      return {
        selectedModeId: 'mode-auto',
        setSelectedModeId(...args) { calls.push(args); },
      };
    },
  };
  assert.equal(readGrokSelectedModeId(store), 'mode-auto');
  assert.equal(resolveGrokSelectedMode(store, catalog).selectedMode.title, 'Auto');
  assert.deepEqual(selectGrokModelMode(store, catalog, 'mode-expert'), {
    selectedModeId: 'mode-expert',
    selectionSource: 'sdk_state',
    serverPreferenceWritePerformed: false,
  });
  assert.deepEqual(calls, [['mode-expert', { source: 'user' }]]);
  assert.equal(GROK_MODEL_SELECTION_SOURCE.setter, 'setSelectedModeId');
  assert.equal(GROK_MODEL_SELECTION_SOURCE.selectionEffect, 'local_sdk_state_and_local_storage');
});

test('allows a source-listed mode with unknown availability when the catalog omits that field', () => {
  const calls = [];
  const store = { setSelectedModeId: (...args) => calls.push(args) };
  const catalogWithoutAvailability = { defaultModeId: 'auto', modes: [{ id: 'auto', title: 'Auto' }] };
  assert.deepEqual(selectGrokModelMode(store, catalogWithoutAvailability, 'auto'), {
    selectedModeId: 'auto',
    selectionSource: 'sdk_state',
    serverPreferenceWritePerformed: false,
  });
  assert.deepEqual(calls, [['auto', { source: 'user' }]]);
});

test('refuses missing, duplicate, malformed, and unavailable mode selections before touching state', () => {
  const calls = [];
  const store = { selectedModeId: null, setSelectedModeId: (...args) => calls.push(args) };
  assert.throws(() => normalizeGrokModelModes({ modes: [{ id: 'mode-auto', title: '' }] }), { code: 'MODEL_MODES_RESPONSE_INVALID' });
  assert.throws(() => normalizeGrokModelModes({ modes: [catalog.modes[0], catalog.modes[0]] }), { code: 'MODEL_MODES_RESPONSE_INVALID' });
  assert.throws(() => selectGrokModelMode(store, catalog, 'mode-locked'), { code: 'MODEL_MODE_NOT_SELECTABLE' });
  assert.throws(() => selectGrokModelMode(store, catalog, 'not-listed'), { code: 'MODEL_MODE_NOT_AVAILABLE' });
  assert.deepEqual(calls, []);
});

test('mode reader delegates to the existing authenticated read operation and normalizes its response', async () => {
  const calls = [];
  const api = createGrokModelSelectionClient({
    client: {
      async read(operationId, input) {
        calls.push({ operationId, input });
        return { status: 200, data: catalog };
      },
    },
  });
  const result = await api.modes('en');
  assert.deepEqual(calls, [{ operationId: GROK_MODEL_MODE_OPERATION_ID, input: { locale: 'en' } }]);
  assert.equal(result.data.modes.length, 3);
  await assert.rejects(api.modes('bad\nlocale'), { code: 'MODEL_MODE_LOCALE_INVALID' });
  assert.equal(calls.length, 1);
});
