import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { GeminiWebClient } from '../src/client.mjs';
import { contract as makeContract, session as makeSession } from './helpers.mjs';
import {
  buildGeminiModelChoices,
  buildGeminiModelRequestMetadata,
  createGeminiModelSelectionController,
  createGeminiModelSelectionState,
  GEMINI_MODEL_SELECTION_SOURCE,
  readCapturedGeminiModelRequestMetadata,
  readGeminiModelChoices,
  readGeminiModelSelectionState,
  selectGeminiModelChoice,
} from '../src/model-selection.mjs';

const catalog = () => ({
  accountStatus: 'available',
  statusCode: 1000,
  models: [
    { modelId: '1111111111111111', modelName: 'gemini-flash-lite', displayName: '3.5 Flash-Lite', category: 'Flash-Lite', available: true },
    { modelId: '2222222222222222', modelName: 'gemini-flash', displayName: '3.8 Flash', category: 'Flash', available: true },
    { modelId: '3333333333333333', modelName: 'gemini-pro', displayName: '3.1 Pro', category: 'Pro', available: true },
  ],
});

test('preserves four UI choices as three exact catalog model IDs plus a separate thinking-level control', () => {
  const result = buildGeminiModelChoices(catalog());
  assert.equal(result.catalogModelCount, 3);
  assert.equal(result.uiChoiceCount, 4);
  assert.deepEqual(result.choices.slice(0, 3).map(choice => [choice.label, choice.modelId]), [
    ['3.5 Flash-Lite', '1111111111111111'],
    ['3.8 Flash', '2222222222222222'],
    ['3.1 Pro', '3333333333333333'],
  ]);
  assert.equal(result.choices[2].modeCategory, 'MODE_CATEGORY_PRO');
  assert.equal(result.choices[0].modeCategory, 'MODE_CATEGORY_FLASH_LITE');
  assert.equal(result.choices[0].modeCategoryMapping, 'guarded_sdk_request_capture');
  assert.equal(result.choices[1].modeCategory, null);
  assert.equal(result.choices[2].modeCategoryMapping, 'guarded_sdk_request_capture');
  assert.equal(result.choices[3].kind, 'thinking_level');
  assert.equal(result.choices[3].modelId, null);
  assert.equal(result.choices[3].thinkingLevel, 'THINKING_LEVEL_EXTENDED');
  assert.equal(result.accountStatusUsedAsPerModelEligibility, false);
  assert.ok(result.choices.every(choice => choice.availability === 'unknown'));
});

test('does not invent or guess a public model ID when the catalog name is missing or ambiguous', () => {
  const absent = buildGeminiModelChoices({ models: [catalog().models[0]] });
  assert.equal(absent.choices[0].modelId, '1111111111111111');
  assert.equal(absent.choices[1].modelId, null);
  assert.equal(absent.choices[1].mappingStatus, 'catalog_match_missing');

  const ambiguous = buildGeminiModelChoices({ models: [catalog().models[1], { ...catalog().models[1], modelId: '4444444444444444' }] });
  assert.equal(ambiguous.choices[1].modelId, null);
  assert.equal(ambiguous.choices[1].mappingStatus, 'ambiguous_catalog_match');
  const state = createGeminiModelSelectionState();
  assert.throws(() => selectGeminiModelChoice(state, ambiguous.choices[1]), { code: 'MODEL_CHOICE_MAPPING_UNRESOLVED' });
});

test('reads the direct model catalog through the existing owner-checked listModels adapter', async () => {
  const calls = [];
  const result = await readGeminiModelChoices({
    async listModels(options) { calls.push(options); return {
      ...catalog(), ownerMatched: true, anonymousOwnerAbsent: true, credentialPropagated: true,
      owner: 'private-owner', request: { values: 'private-value' },
    }; },
  }, { expectedOwner: 'fixture@example.com' });
  assert.deepEqual(calls, [{ expectedOwner: 'fixture@example.com' }]);
  assert.equal(result.operationId, 'model_list');
  assert.equal(result.choices.length, 4);
  assert.equal(Object.hasOwn(result, 'catalog'), false);
  assert.deepEqual(Object.keys(result.catalogRead).sort(), [
    'anonymousOwnerAbsent', 'contentType', 'credentialPropagated', 'httpStatus', 'modelCount', 'ownerMatched', 'responseBytes', 'responseSha256', 'rpcId',
  ].sort());
  assert.equal(JSON.stringify(result).includes('private-owner'), false);
  assert.equal(JSON.stringify(result).includes('private-value'), false);
});

test('selection updates only the process-local model and thinking fields, without a server preference write', () => {
  const choices = buildGeminiModelChoices(catalog()).choices;
  const state = createGeminiModelSelectionState();
  const modelSelected = selectGeminiModelChoice(state, choices[2]);
  assert.equal(modelSelected.selectedModeId, '3333333333333333');
  assert.equal(modelSelected.modeCategory, 'MODE_CATEGORY_PRO');
  assert.equal(modelSelected.thinkingLevel, 'THINKING_LEVEL_STANDARD');
  assert.equal(modelSelected.serverPreferenceWritePerformed, false);
  assert.equal(modelSelected.selectionEffect, 'local_client_state_and_per_request_metadata');

  const thinkingSelected = selectGeminiModelChoice(state, choices[3]);
  assert.equal(thinkingSelected.selectedModeId, '3333333333333333');
  assert.equal(thinkingSelected.thinkingLevel, 'THINKING_LEVEL_EXTENDED');
  assert.equal(thinkingSelected.serverPreferenceWritePerformed, false);
  assert.deepEqual(readGeminiModelSelectionState(state), {
    selectedModeId: '3333333333333333',
    modeCategory: 'MODE_CATEGORY_PRO',
    thinkingLevel: 'THINKING_LEVEL_EXTENDED',
    selectedChoiceId: 'thinking:thinking-level-extended',
  });
  assert.deepEqual(buildGeminiModelRequestMetadata(state), {
    modeId: '3333333333333333',
    modeCategory: 'MODE_CATEGORY_PRO',
    thinkingLevel: 'THINKING_LEVEL_EXTENDED',
    isTemporaryChat: false,
  });
});

test('extended thinking is stored per selected mode and survives switching back', () => {
  const choices = buildGeminiModelChoices(catalog()).choices;
  const state = createGeminiModelSelectionState();
  selectGeminiModelChoice(state, choices[2]);
  selectGeminiModelChoice(state, choices[3]);
  selectGeminiModelChoice(state, choices[1]);
  assert.equal(readGeminiModelSelectionState(state).selectedModeId, '2222222222222222');
  assert.equal(readGeminiModelSelectionState(state).thinkingLevel, 'THINKING_LEVEL_STANDARD');
  selectGeminiModelChoice(state, choices[2]);
  assert.equal(readGeminiModelSelectionState(state).thinkingLevel, 'THINKING_LEVEL_EXTENDED');
});

test('builds source-shaped per-request metadata only when the actual mode category is known', () => {
  const state = createGeminiModelSelectionState({
    selectedModeId: '3333333333333333',
    modeCategory: 'MODE_CATEGORY_PRO',
    thinkingLevel: 'THINKING_LEVEL_EXTENDED',
  });
  assert.deepEqual(buildGeminiModelRequestMetadata(state), {
    modeId: '3333333333333333',
    modeCategory: 'MODE_CATEGORY_PRO',
    thinkingLevel: 'THINKING_LEVEL_EXTENDED',
    isTemporaryChat: false,
  });
  assert.throws(() => buildGeminiModelRequestMetadata(state, { isTemporaryChat: 'false' }), { code: 'MODEL_TEMPORARY_FLAG_INVALID' });
});

test('decodes and binds model category and thinking level from the source-defined SDK header positions', () => {
  const header = Array(20).fill(null);
  header[4] = '3333333333333333';
  header[7] = false;
  header[14] = 3;
  header[15] = 1;
  assert.deepEqual(readCapturedGeminiModelRequestMetadata({
    headers: { 'X-Goog-Ext-525001261-JSPB': JSON.stringify(header) },
  }), {
    modeId: '3333333333333333',
    modeCategory: 'MODE_CATEGORY_PRO',
    thinkingLevel: 'THINKING_LEVEL_STANDARD',
    isTemporaryChat: false,
    headerName: 'x-goog-ext-525001261-jspb',
    fieldPaths: { modeId: '[4]', modeCategory: '[14]', thinkingLevel: '[15]', isTemporaryChat: '[7]' },
  });
  header[7] = 0;
  assert.equal(readCapturedGeminiModelRequestMetadata({
    headers: { 'x-goog-ext-525001261-jspb': JSON.stringify(header) },
  }).isTemporaryChat, false);
  header[14] = 99;
  assert.throws(() => readCapturedGeminiModelRequestMetadata({
    headers: { 'x-goog-ext-525001261-jspb': JSON.stringify(header) },
  }), { code: 'MODEL_METADATA_CAPTURE_INVALID' });
});

test('Flash-Lite selection matches its native category 6 without inferring the Flash category', () => {
  const choices = buildGeminiModelChoices(catalog()).choices;
  const state = createGeminiModelSelectionState();
  selectGeminiModelChoice(state, choices[0]);
  const nativeHeader = Array(20).fill(null);
  nativeHeader[4] = choices[0].modelId;
  nativeHeader[7] = false;
  nativeHeader[14] = 6;
  nativeHeader[15] = 1;
  const native = readCapturedGeminiModelRequestMetadata({ headers: {
    'x-goog-ext-525001261-jspb': JSON.stringify(nativeHeader),
  } });
  const prepared = buildGeminiModelRequestMetadata(state);
  assert.equal(native.modeId, prepared.modeId);
  assert.equal(native.modeCategory, prepared.modeCategory);
  assert.equal(native.thinkingLevel, prepared.thinkingLevel);
  assert.equal(prepared.isTemporaryChat, native.isTemporaryChat);
  selectGeminiModelChoice(state, choices[1]);
  assert.equal(Object.hasOwn(buildGeminiModelRequestMetadata(state), 'modeCategory'), false);
});

test('controller combines the direct catalog reader with an injectable process-local selection state', async () => {
  const calls = [];
  const state = createGeminiModelSelectionState();
  const controller = createGeminiModelSelectionController({
    client: { async listModels(options) {
      calls.push(options);
      return { ...catalog(), ownerMatched: true, anonymousOwnerAbsent: true };
    } },
    state,
  });
  const choices = await controller.choices({ expectedOwner: 'fixture@example.com' });
  const selected = controller.select(choices.choices[1]);
  assert.equal(calls.length, 1);
  assert.equal(selected.selectedModeId, '2222222222222222');
  assert.equal(controller.selected().selectedModeId, '2222222222222222');
  assert.throws(() => controller.select({ ...choices.choices[2] }), { code: 'MODEL_CHOICE_NOT_FROM_CURRENT_CATALOG' });
  assert.equal(GEMINI_MODEL_SELECTION_SOURCE.catalogRpcId, 'otAQ7b');
  assert.equal(GEMINI_MODEL_SELECTION_SOURCE.quotaReadRpcId, 'qpEbW');
  assert.equal(GEMINI_MODEL_SELECTION_SOURCE.modeCategoryForCatalogRows, 'unknown');
});

test('source contract distinguishes local request selection from the direct read-only catalog', async () => {
  const fragment = JSON.parse(await readFile(new URL('../discovery/gemini-model-selection-contract-fragment-2026-10-06.json', import.meta.url), 'utf8'));
  assert.equal(fragment.schema, 'gemini-local-control-contract-fragment-v1');
  assert.equal(fragment.catalog.operationId, 'model_list');
  assert.equal(fragment.catalog.transport, 'direct_http');
  assert.equal(fragment.catalog.rpcId, 'otAQ7b');
  assert.equal(fragment.catalog.perModelAvailability, 'unknown_without_a_decoded_model_specific_quota_mapping');
  assert.equal(fragment.controls[0].operationId, 'model_select');
  assert.equal(fragment.controls[0].transport, 'local_process_state');
  assert.equal(fragment.controls[0].serverPreferenceEndpoint, null);
  assert.equal(fragment.controls[0].serverPreferenceWriteObserved, false);
  assert.equal(fragment.controls[1].operationId, 'selection_state');
  assert.equal(fragment.controls[1].requestDispatchRequiredForReadback, false);
  assert.equal(fragment.thinkingLevel.controlKind, 'separate_mode_parameter');
  assert.equal(fragment.mapping.modeCategoryForCatalogRows, 'unknown');
  assert.equal(fragment.mapping.modeCategoryForGuardedProChoice, 'MODE_CATEGORY_PRO');
  assert.equal(fragment.mapping.quotaResponseDecodedToPerModelEligibility, false);
  assert.deepEqual(fragment.requestMetadataSerialization.capturedArrayIndexes, {
    modeId: 4, isTemporaryChat: 7, modeCategory: 14, thinkingLevel: 15,
  });
  assert.equal(fragment.requestMetadataSerialization.capturedModeCategoryAndThinkingValueReadbackPending, false);
});

test('GeminiWebClient exposes a process-local select and prepared-metadata readback without dispatch', async () => {
  const client = new GeminiWebClient({ contract: makeContract(), session: makeSession(), fetchImpl: async () => {
    throw new Error('the local selection test must not make an HTTP request');
  } });
  client.listModels = async () => ({ ...catalog(), ownerMatched: true, anonymousOwnerAbsent: true });
  try {
    const listed = await client.listModelChoices({ expectedOwner: 'owner@example.com' });
    const selectedChoice = listed.choices.find((choice) => choice.choiceId === 'model:3333333333333333');
    const selected = client.selectModelChoice(selectedChoice);
    const readback = client.getSelectedModelChoice({ isTemporaryChat: false });
    assert.equal(selected.selectedModeId, '3333333333333333');
    assert.equal(readback.selectedModeId, selected.selectedModeId);
    assert.deepEqual(readback.preparedRequestMetadata, {
      modeId: selected.selectedModeId,
      modeCategory: 'MODE_CATEGORY_PRO',
      thinkingLevel: 'THINKING_LEVEL_STANDARD',
      isTemporaryChat: false,
    });
    assert.equal(readback.serverPreferenceWritePerformed, false);
    assert.equal(readback.businessRequestDispatched, false);
    const handlers = client.operationEvidence();
    assert.equal(handlers.model_select.installed, true);
    assert.equal(handlers.model_select.contractCaptured, false);
    assert.equal(handlers.model_select.requestCaptured, false);
    assert.equal(handlers.model_select.sourceControlCaptured, true);
    assert.equal(handlers.selection_state.sourceControlContractPath, GEMINI_MODEL_SELECTION_SOURCE.localControlContractFragment);
  } finally {
    client.transport.session = null;
  }
});

test('selected local metadata rejects a captured text request for another model before fetch', async () => {
  let fetchCount = 0;
  const client = new GeminiWebClient({
    contract: makeContract(),
    session: makeSession(),
    fetchImpl: async () => { fetchCount += 1; throw new Error('mismatched metadata must fail before fetch'); },
  });
  client.listModels = async () => ({ ...catalog(), ownerMatched: true, anonymousOwnerAbsent: true });
  try {
    const listed = await client.listModelChoices({ expectedOwner: 'owner@example.com' });
    const proChoice = listed.choices.find((choice) => choice.choiceId === 'model:3333333333333333');
    client.selectModelChoice(proChoice);
    const capturedHeader = Array(20).fill(null);
    capturedHeader[4] = '2222222222222222';
    capturedHeader[7] = false;
    capturedHeader[14] = 3;
    capturedHeader[15] = 1;
    await assert.rejects(client.generateTextOnce({
      headers: { 'x-goog-ext-525001261-jspb': JSON.stringify(capturedHeader) },
    }, 'neutral prompt', { actor: 'owner@example.com', callerIntent: 'model-binding-test-v1' }), {
      code: 'MODEL_SELECTION_CAPTURE_MISMATCH',
    });
    assert.equal(fetchCount, 0);
  } finally {
    client.transport.session = null;
  }
});
