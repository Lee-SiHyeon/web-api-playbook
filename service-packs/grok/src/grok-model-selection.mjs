import { fail } from './errors.mjs';

export const GROK_MODEL_MODE_OPERATION_ID = 'models.modes';

export const GROK_MODEL_SELECTION_SOURCE = Object.freeze({
  catalogOperationId: GROK_MODEL_MODE_OPERATION_ID,
  catalogMethod: 'POST',
  catalogPath: '/rest/modes',
  catalogRequestBody: Object.freeze({ locale: 'en' }),
  stateHook: 'useModesStore',
  selectedField: 'selectedModeId',
  setter: 'setSelectedModeId',
  setterOptions: Object.freeze({ source: 'user' }),
  storageKey: 'modes-selected-id',
  selectionEffect: 'local_sdk_state_and_local_storage',
});

const MODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MODES = 500;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, code, max = 2_000) {
  if (value !== undefined && (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value))) {
    throw fail(code);
  }
  return value;
}

function normalizeAvailability(value) {
  if (value === undefined) return { available: 'unknown' };
  if (!isObject(value)) throw fail('MODEL_MODES_RESPONSE_INVALID');
  const available = typeof value.available === 'boolean' ? value.available : 'unknown';
  const result = { available };
  if (isObject(value.unavailable)) {
    const message = boundedText(value.unavailable.message, 'MODEL_MODES_RESPONSE_INVALID');
    if (message !== undefined) result.unavailableMessage = message;
  }
  if (isObject(value.requiresUpgrade)) {
    const message = boundedText(value.requiresUpgrade.message, 'MODEL_MODES_RESPONSE_INVALID');
    const tier = boundedText(value.requiresUpgrade.minimumSubscriptionTier, 'MODEL_MODES_RESPONSE_INVALID', 128);
    result.requiresUpgrade = {
      ...(message !== undefined ? { message } : {}),
      ...(tier !== undefined ? { minimumSubscriptionTier: tier } : {}),
    };
  }
  if (isObject(value.comingSoon)) {
    const message = boundedText(value.comingSoon.message, 'MODEL_MODES_RESPONSE_INVALID');
    const eta = boundedText(value.comingSoon.eta, 'MODEL_MODES_RESPONSE_INVALID', 128);
    result.comingSoon = {
      ...(message !== undefined ? { message } : {}),
      ...(eta !== undefined ? { eta } : {}),
    };
  }
  return result;
}

function normalizeMode(value, index) {
  if (!isObject(value) || typeof value.id !== 'string' || !MODE_ID.test(value.id)) {
    throw fail('MODEL_MODES_RESPONSE_INVALID', { index });
  }
  const title = boundedText(value.title, 'MODEL_MODES_RESPONSE_INVALID', 512);
  if (title === undefined || !title.trim()) throw fail('MODEL_MODES_RESPONSE_INVALID', { index });
  const description = boundedText(value.description, 'MODEL_MODES_RESPONSE_INVALID');
  const badgeText = boundedText(value.badgeText, 'MODEL_MODES_RESPONSE_INVALID', 512);
  const iconHint = boundedText(value.iconHint, 'MODEL_MODES_RESPONSE_INVALID', 256);
  return {
    id: value.id,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(badgeText !== undefined ? { badgeText } : {}),
    ...(iconHint !== undefined ? { iconHint } : {}),
    availability: normalizeAvailability(value.availability),
  };
}

export function normalizeGrokModelModes(payload) {
  if (!isObject(payload) || !Array.isArray(payload.modes) || payload.modes.length > MAX_MODES) {
    throw fail('MODEL_MODES_RESPONSE_INVALID');
  }
  const modes = payload.modes.map(normalizeMode);
  const ids = new Set(modes.map(mode => mode.id));
  if (ids.size !== modes.length) throw fail('MODEL_MODES_RESPONSE_INVALID');
  if (payload.defaultModeId !== undefined && payload.defaultModeId !== null
    && (typeof payload.defaultModeId !== 'string' || !MODE_ID.test(payload.defaultModeId))) {
    throw fail('MODEL_MODES_RESPONSE_INVALID');
  }
  return {
    modes,
    defaultModeId: payload.defaultModeId ?? null,
  };
}

function catalogMode(catalog, modeId) {
  if (!isObject(catalog) || !Array.isArray(catalog.modes)) throw fail('MODEL_MODE_CATALOG_REQUIRED');
  const normalized = normalizeGrokModelModes(catalog);
  if (typeof modeId !== 'string' || !MODE_ID.test(modeId)) throw fail('MODEL_MODE_ID_INVALID');
  const mode = normalized.modes.find(item => item.id === modeId);
  if (!mode) throw fail('MODEL_MODE_NOT_AVAILABLE');
  return mode;
}

function readStoreState(modeStore) {
  if (typeof modeStore?.getState === 'function') {
    const state = modeStore.getState();
    if (isObject(state)) return state;
  }
  if (isObject(modeStore)) return modeStore;
  throw fail('MODEL_MODE_STORE_REQUIRED');
}

export function readGrokSelectedModeId(modeStore) {
  const value = readStoreState(modeStore).selectedModeId;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !MODE_ID.test(value)) throw fail('MODEL_MODE_STORE_INVALID');
  return value;
}

export function resolveGrokSelectedMode(modeStore, catalog) {
  const modeId = readGrokSelectedModeId(modeStore) ?? catalog?.defaultModeId ?? null;
  if (modeId === null) return { selectedModeId: null, selectedMode: null, selectionSource: 'catalog_default' };
  const mode = catalogMode(catalog, modeId);
  return { selectedModeId: mode.id, selectedMode: mode, selectionSource: 'sdk_state' };
}

export function selectGrokModelMode(modeStore, catalog, modeId) {
  const mode = catalogMode(catalog, modeId);
  if (mode.availability.available === false) throw fail('MODEL_MODE_NOT_SELECTABLE');
  const state = readStoreState(modeStore);
  const setter = state.setSelectedModeId;
  if (typeof setter !== 'function') throw fail('MODEL_MODE_SETTER_UNAVAILABLE');
  setter(mode.id, { source: 'user' });
  return {
    selectedModeId: mode.id,
    selectionSource: 'sdk_state',
    serverPreferenceWritePerformed: false,
  };
}

export function createGrokModelSelectionClient({ client, modeStore } = {}) {
  if (typeof client?.read !== 'function') throw fail('MODEL_SELECTION_CLIENT_REQUIRED');
  return Object.freeze({
    async modes(locale = 'en') {
      if (typeof locale !== 'string' || !locale.trim() || locale.length > 32 || /[\r\n\0]/.test(locale)) {
        throw fail('MODEL_MODE_LOCALE_INVALID');
      }
      const result = await client.read(GROK_MODEL_MODE_OPERATION_ID, { locale });
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) {
        throw fail('MODEL_MODES_READ_FAILED');
      }
      return { ...result, data: normalizeGrokModelModes(result.data) };
    },
    selected() {
      if (modeStore === undefined) throw fail('MODEL_MODE_STORE_REQUIRED');
      return readGrokSelectedModeId(modeStore);
    },
    select(catalog, modeId) {
      if (modeStore === undefined) throw fail('MODEL_MODE_STORE_REQUIRED');
      return selectGrokModelMode(modeStore, catalog, modeId);
    },
  });
}
