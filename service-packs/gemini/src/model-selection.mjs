import { GeminiClientError } from './errors.mjs';

const MODEL_ID = /^[0-9a-f]{16}$/;
const MODE_CATEGORIES = new Set([
  'MODE_CATEGORY_UNSPECIFIED', 'MODE_CATEGORY_FAST', 'MODE_CATEGORY_THINKING', 'MODE_CATEGORY_PRO',
  'MODE_CATEGORY_AUTO', 'MODE_CATEGORY_FAST_DYNAMIC_THINKING', 'MODE_CATEGORY_FLASH_LITE',
  'MODE_CATEGORY_FLASH_PLUS', 'MODE_CATEGORY_ULTRA',
]);
const THINKING_LEVELS = new Set([
  'THINKING_LEVEL_STANDARD', 'THINKING_LEVEL_EXTENDED', 'THINKING_LEVEL_DEEP_THINK', 'THINKING_LEVEL_MEDIUM',
]);
const MODE_CATEGORY_BY_WIRE_CODE = new Map([
  [0, 'MODE_CATEGORY_UNSPECIFIED'],
  [1, 'MODE_CATEGORY_FAST'],
  [2, 'MODE_CATEGORY_THINKING'],
  [3, 'MODE_CATEGORY_PRO'],
  [4, 'MODE_CATEGORY_AUTO'],
  [5, 'MODE_CATEGORY_FAST_DYNAMIC_THINKING'],
  [6, 'MODE_CATEGORY_FLASH_LITE'],
  [7, 'MODE_CATEGORY_FLASH_PLUS'],
  [8, 'MODE_CATEGORY_ULTRA'],
]);
const THINKING_LEVEL_BY_WIRE_CODE = new Map([
  [0, 'THINKING_LEVEL_UNSPECIFIED'],
  [1, 'THINKING_LEVEL_STANDARD'],
  [2, 'THINKING_LEVEL_EXTENDED'],
  [3, 'THINKING_LEVEL_DEEP_THINK'],
  [4, 'THINKING_LEVEL_MEDIUM'],
]);

export const GEMINI_MODEL_SELECTION_SOURCE = Object.freeze({
  catalogOperationId: 'model_list',
  catalogRpcId: 'otAQ7b',
  catalogModelIdField: 'modelId',
  modelSelectOperationId: 'model_select',
  selectionStateOperationId: 'selection_state',
  localControlContractFragment: 'discovery/gemini-model-selection-contract-fragment-2026-10-06.json',
  capturedRequestMetadata: Object.freeze({
    sourceModuleId: 'OpU7Tc',
    sourceModuleSha256: '6d6fac08f2db2cb171b2714c67032f44f8b5314ac246abb77d7d69af5830a415',
    sourceSerializer: 'getBardApplicationMetadataHeader',
    protoMessageType: 'Lt',
    sourceFields: Object.freeze(['modeId', 'modeCategory', 'thinkingLevel', 'isTemporaryChat']),
    protoFieldNumbers: Object.freeze({ modeId: 5, isTemporaryChat: 8, modeCategory: 15, thinkingLevel: 16 }),
    capturedHttpHeaderName: 'x-goog-ext-525001261-jspb',
    capturedArrayIndexes: Object.freeze({ modeId: 4, isTemporaryChat: 7, modeCategory: 14, thinkingLevel: 15 }),
    modeCategoryEnumCodes: Object.freeze({
      MODE_CATEGORY_UNSPECIFIED: 0, MODE_CATEGORY_FAST: 1, MODE_CATEGORY_THINKING: 2,
      MODE_CATEGORY_PRO: 3, MODE_CATEGORY_AUTO: 4, MODE_CATEGORY_FAST_DYNAMIC_THINKING: 5,
      MODE_CATEGORY_FLASH_LITE: 6, MODE_CATEGORY_FLASH_PLUS: 7, MODE_CATEGORY_ULTRA: 8,
    }),
    thinkingLevelEnumCodes: Object.freeze({
      THINKING_LEVEL_UNSPECIFIED: 0, THINKING_LEVEL_STANDARD: 1, THINKING_LEVEL_EXTENDED: 2,
      THINKING_LEVEL_DEEP_THINK: 3, THINKING_LEVEL_MEDIUM: 4,
    }),
  }),
  selectorMethod: 'D2d.selectModel(category)',
  selectorService: 'bardModeService',
  uiChoiceModeIdAttribute: 'data-mode-id',
  selectorCategoryMap: Object.freeze({
    pro: 'MODE_CATEGORY_PRO',
    fast: 'MODE_CATEGORY_FAST',
    auto: 'MODE_CATEGORY_AUTO',
  }),
  localModeIdSetterCallsite: 'bardModeService.RD(modeId)',
  menuModeIdField: 'data-mode-id',
  menuModeIdMatchesCatalogModelId: true,
  thinkingLevelSetterCallsite: '_.SE(...)->bardModeService.Dya(modeCategory, thinkingLevel)',
  outboundMetadataBuilder: 'getBardApplicationMetadataHeader',
  outboundMetadataFields: Object.freeze(['modeId', 'modeCategory', 'thinkingLevel', 'isTemporaryChat']),
  quotaReadRpcId: 'qpEbW',
  quotaReadMethod: '/BardFrontendService.CheckGeminiQuota',
  quotaReadRequestFields: Object.freeze(['mode', 'action']),
  quotaReadEffect: 'read_only_quota_check',
  quotaReadObserved: Object.freeze({
    requestContentType: 'application/x-www-form-urlencoded',
    requestFieldNames: Object.freeze(['f.req', 'at']),
    argumentShape: 'array of three mode/action numeric-enum pairs',
    argumentPairs: Object.freeze([[1, 4], [6, 6], [1, 15]].map((pair) => Object.freeze(pair))),
    httpStatus: 200,
    responseContentType: 'application/json',
    responseBytes: 215,
    matchingRpcPayloadCount: 1,
    responseShape: 'array with repeated quota entry context, numeric quota fields, and a 16-character summary string',
  }),
  quotaAvailabilityDecoder: 'unresolved_from_recorded_response_shape',
  persistedPreferenceRouteObserved: false,
  modelPreferenceWriteForwarded: false,
  selectionEffect: 'local_client_state_and_per_request_metadata',
  modeCategoryForCatalogRows: 'unknown',
  sourceModules: Object.freeze([
    Object.freeze({ moduleId: 'HwBxOc', sha256: 'd01b7d0af88adc4d498080b76ab1e1ff770dd9720b02d9f19f36ae69a6d6c364', sourceFunction: 'D2d.selectModel' }),
    Object.freeze({ moduleId: 'LQaXg', sha256: '3137eb01bfe212ddc5b7df423acd9c9633537f528a0cd13a07c25e075495e7aa', sourceFunction: 'bardModeService.PEd / _ .SE' }),
    Object.freeze({ moduleId: 'OpU7Tc', sha256: '6d6fac08f2db2cb171b2714c67032f44f8b5314ac246abb77d7d69af5830a415', sourceFunction: 'getBardApplicationMetadataHeader' }),
    Object.freeze({ moduleId: 'TRJwtb', sha256: '813451d8daabd1d9972ba4e7d4b277a59d6b7fc100863d27ff4e81c9a5ef57d1', sourceFunction: 'menu model and thinking-level mapper' }),
  ]),
});

const DEFAULT_UI_CHOICE_EVIDENCE = Object.freeze([
  Object.freeze({ kind: 'model', label: '3.5 Flash-Lite', modeCategory: 'MODE_CATEGORY_FLASH_LITE',
    uiEnabledObserved: true }),
  Object.freeze({ kind: 'model', label: '3.8 Flash', uiEnabledObserved: true }),
  Object.freeze({ kind: 'model', label: '3.1 Pro', modeCategory: 'MODE_CATEGORY_PRO', uiEnabledObserved: true }),
  Object.freeze({ kind: 'thinking_level', label: 'Extended Thinking', uiLabel: '확장된 사고 모델',
    thinkingLevel: 'THINKING_LEVEL_EXTENDED', uiEnabledObserved: true }),
]);

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLabel(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').split('\n', 1)[0].trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
    : '';
}

function normalizeModel(model, index) {
  if (!isRecord(model) || typeof model.modelId !== 'string' || !MODEL_ID.test(model.modelId)
      || typeof model.displayName !== 'string' || !model.displayName.trim()) {
    fail('MODEL_CHOICE_CATALOG_INVALID', `Model catalog item ${index} is malformed.`);
  }
  const modeCategory = MODE_CATEGORIES.has(model.modeCategory) ? model.modeCategory : null;
  return Object.freeze({
    modelId: model.modelId,
    displayName: model.displayName.trim().slice(0, 160),
    modelName: typeof model.modelName === 'string' ? model.modelName.slice(0, 160) : null,
    modeCategory,
    // The current catalog exposes one account-level status. It does not prove
    // that each model or thinking level is within the current quota.
    availability: 'unknown',
  });
}

/** Keep UI choices separate from the model catalog; extended thinking is not a model ID. */
export function buildGeminiModelChoices(modelCatalog, uiChoiceEvidence = DEFAULT_UI_CHOICE_EVIDENCE) {
  const models = Array.isArray(modelCatalog) ? modelCatalog : modelCatalog?.models;
  if (!Array.isArray(models) || models.length > 256 || !Array.isArray(uiChoiceEvidence) || uiChoiceEvidence.length > 64) {
    fail('MODEL_CHOICE_CATALOG_INVALID', 'A bounded Gemini model catalog and UI choice list are required.');
  }
  const normalizedModels = models.map(normalizeModel);
  if (new Set(normalizedModels.map((model) => model.modelId)).size !== normalizedModels.length) {
    fail('MODEL_CHOICE_CATALOG_INVALID', 'The Gemini model catalog contains duplicate model IDs.');
  }
  const choices = uiChoiceEvidence.map((evidence, index) => {
    if (!isRecord(evidence) || typeof evidence.label !== 'string' || !evidence.label.trim()
        || !['model', 'thinking_level'].includes(evidence.kind)) {
      fail('MODEL_CHOICE_UI_EVIDENCE_INVALID', `UI choice ${index} is malformed.`);
    }
    if (evidence.kind === 'thinking_level') {
      if (typeof evidence.thinkingLevel !== 'string' || !THINKING_LEVELS.has(evidence.thinkingLevel)) {
        fail('MODEL_CHOICE_UI_EVIDENCE_INVALID', `Thinking control ${index} has an unknown source enum.`);
      }
      return Object.freeze({
        choiceId: `thinking:${evidence.thinkingLevel.toLocaleLowerCase('en-US').replaceAll('_', '-')}`,
        kind: 'thinking_level',
        label: evidence.label.trim().slice(0, 160),
        ...(typeof evidence.uiLabel === 'string' ? { uiLabel: evidence.uiLabel.slice(0, 160) } : {}),
        modelId: null,
        modeId: null,
        modeCategory: null,
        thinkingLevel: evidence.thinkingLevel,
        availability: 'unknown',
        uiEnabledObserved: evidence.uiEnabledObserved === true,
        mappingStatus: 'source_thinking_enum',
      });
    }
    const key = normalizeLabel(evidence.label);
    const matches = normalizedModels.filter((model) => normalizeLabel(model.displayName) === key
      || (model.modelName && normalizeLabel(model.modelName.replace(/^gemini-/, '').replaceAll('-', ' ')) === key));
    const model = matches.length === 1 ? matches[0] : null;
    return Object.freeze({
      choiceId: model ? `model:${model.modelId}` : `unresolved-ui-model:${index + 1}`,
      kind: 'model',
      label: evidence.label.trim().slice(0, 160),
      modelId: model?.modelId ?? null,
      modeId: model?.modelId ?? null,
        modelName: model?.modelName ?? null,
        displayName: model?.displayName ?? null,
        modeCategory: MODE_CATEGORIES.has(evidence.modeCategory) ? evidence.modeCategory : (model?.modeCategory ?? null),
        modeCategoryMapping: MODE_CATEGORIES.has(evidence.modeCategory) ? 'guarded_sdk_request_capture'
          : model?.modeCategory ? 'direct_catalog_field' : 'unknown',
      availability: 'unknown',
      uiEnabledObserved: evidence.uiEnabledObserved === true,
      mappingStatus: matches.length === 1 ? 'exact_otAQ7b_display_name_match'
        : matches.length > 1 ? 'ambiguous_catalog_match' : 'catalog_match_missing',
    });
  });
  if (new Set(choices.map((choice) => choice.choiceId)).size !== choices.length) {
    fail('MODEL_CHOICE_UI_EVIDENCE_INVALID', 'UI choice evidence contains duplicate selectable keys.');
  }
  return Object.freeze({
    choices: Object.freeze(choices),
    catalogModelCount: normalizedModels.length,
    uiChoiceCount: choices.length,
    accountStatusUsedAsPerModelEligibility: false,
    quotaEvidenceRequiredForAvailability: true,
  });
}

/** Read the catalog through the existing owner-checked otAQ7b client adapter. */
export async function readGeminiModelChoices(client, { expectedOwner, uiChoiceEvidence = DEFAULT_UI_CHOICE_EVIDENCE } = {}) {
  if (typeof client?.listModels !== 'function') fail('MODEL_SELECTION_CLIENT_REQUIRED', 'A direct Gemini model catalog reader is required.');
  const catalog = await client.listModels({ expectedOwner });
  if (catalog?.ownerMatched !== true || catalog?.anonymousOwnerAbsent !== true) {
    fail('MODEL_SELECTION_OWNER_NOT_VERIFIED', 'The model catalog was not read under the expected authenticated owner.');
  }
  const modelRows = Array.isArray(catalog?.models) ? catalog.models : null;
  return Object.freeze({
    service: 'gemini-web',
    operationId: GEMINI_MODEL_SELECTION_SOURCE.catalogOperationId,
    catalogRead: Object.freeze({
      rpcId: GEMINI_MODEL_SELECTION_SOURCE.catalogRpcId,
      httpStatus: Number.isSafeInteger(catalog?.httpStatus) ? catalog.httpStatus : null,
      contentType: typeof catalog?.contentType === 'string' ? catalog.contentType : null,
      responseBytes: Number.isSafeInteger(catalog?.responseBytes) ? catalog.responseBytes : null,
      responseSha256: typeof catalog?.responseSha256 === 'string' ? catalog.responseSha256 : null,
      modelCount: modelRows?.length ?? 0,
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      credentialPropagated: catalog.credentialPropagated === true,
    }),
    ...buildGeminiModelChoices(modelRows, uiChoiceEvidence),
  });
}

/** Decode only source-defined fields from the SDK metadata header; callers leave its bytes untouched. */
export function readCapturedGeminiModelRequestMetadata(capturedRequest) {
  if (!isRecord(capturedRequest) || !isRecord(capturedRequest.headers)) {
    fail('MODEL_METADATA_CAPTURE_INVALID', 'A captured native Gemini request with metadata headers is required.');
  }
  const header = Object.entries(capturedRequest.headers)
    .find(([name]) => name.toLowerCase() === GEMINI_MODEL_SELECTION_SOURCE.capturedRequestMetadata.capturedHttpHeaderName);
  if (!header || typeof header[1] !== 'string' || Buffer.byteLength(header[1], 'utf8') > 64 * 1024) {
    fail('MODEL_METADATA_CAPTURE_INVALID', 'The captured request is missing the source metadata header.');
  }
  let fields;
  try { fields = JSON.parse(header[1]); }
  catch { fail('MODEL_METADATA_CAPTURE_INVALID', 'The captured source metadata header has an unsupported encoding.'); }
  const indexes = GEMINI_MODEL_SELECTION_SOURCE.capturedRequestMetadata.capturedArrayIndexes;
  if (!Array.isArray(fields) || fields.length <= indexes.thinkingLevel) {
    fail('MODEL_METADATA_CAPTURE_INVALID', 'The captured source metadata header has an unsupported field layout.');
  }
  const modeId = fields[indexes.modeId];
  if (typeof modeId !== 'string' || !MODEL_ID.test(modeId)) {
    fail('MODEL_METADATA_CAPTURE_INVALID', 'The captured source metadata header has no valid model ID.');
  }
  const modeCategoryCode = fields[indexes.modeCategory];
  const thinkingLevelCode = fields[indexes.thinkingLevel];
  const modeCategory = modeCategoryCode === null || modeCategoryCode === undefined
    ? null : MODE_CATEGORY_BY_WIRE_CODE.get(modeCategoryCode);
  const thinkingLevel = thinkingLevelCode === null || thinkingLevelCode === undefined
    ? null : THINKING_LEVEL_BY_WIRE_CODE.get(thinkingLevelCode);
  if ((modeCategoryCode !== null && modeCategoryCode !== undefined && !modeCategory)
      || (thinkingLevelCode !== null && thinkingLevelCode !== undefined && !thinkingLevel)) {
    fail('MODEL_METADATA_CAPTURE_INVALID', 'The captured source metadata contains an unknown model or thinking enum.');
  }
  const temporaryFlag = fields[indexes.isTemporaryChat];
  if (temporaryFlag !== undefined && temporaryFlag !== null
      && typeof temporaryFlag !== 'boolean' && temporaryFlag !== 0 && temporaryFlag !== 1) {
    fail('MODEL_METADATA_CAPTURE_INVALID', 'The captured source metadata has an unsupported temporary-chat flag.');
  }
  return Object.freeze({
    modeId,
    modeCategory,
    thinkingLevel,
    isTemporaryChat: temporaryFlag === true || temporaryFlag === 1,
    headerName: header[0].toLowerCase(),
    fieldPaths: Object.freeze({
      modeId: '[' + indexes.modeId + ']',
      modeCategory: '[' + indexes.modeCategory + ']',
      thinkingLevel: '[' + indexes.thinkingLevel + ']',
      isTemporaryChat: '[' + indexes.isTemporaryChat + ']',
    }),
  });
}

export function createGeminiModelSelectionState({
  selectedModeId = null,
  modeCategory = null,
  thinkingLevel = 'THINKING_LEVEL_STANDARD',
} = {}) {
  if (selectedModeId !== null && (typeof selectedModeId !== 'string' || !MODEL_ID.test(selectedModeId))) {
    fail('MODEL_SELECTION_STATE_INVALID', 'The selected model ID is malformed.');
  }
  if (modeCategory !== null && !MODE_CATEGORIES.has(modeCategory)) {
    fail('MODEL_SELECTION_STATE_INVALID', 'The selected mode category is unsupported.');
  }
  if (!THINKING_LEVELS.has(thinkingLevel)) fail('MODEL_SELECTION_STATE_INVALID', 'The selected thinking level is unsupported.');
  let currentModeId = selectedModeId;
  let currentModeCategory = modeCategory;
  let selectedChoiceId = null;
  const thinkingLevelByModeId = new Map();
  if (selectedModeId !== null) thinkingLevelByModeId.set(selectedModeId, thinkingLevel);
  const snapshot = () => Object.freeze({
    selectedModeId: currentModeId,
    modeCategory: currentModeCategory,
    thinkingLevel: currentModeId === null ? thinkingLevel : (thinkingLevelByModeId.get(currentModeId) ?? 'THINKING_LEVEL_STANDARD'),
    selectedChoiceId,
  });
  return Object.freeze({
    read() { return snapshot(); },
    select(choice) {
      if (!isRecord(choice) || typeof choice.choiceId !== 'string') {
        fail('MODEL_CHOICE_INVALID', 'A normalized Gemini model choice is required.');
      }
      if (choice.kind === 'model') {
        if (typeof choice.modeId !== 'string' || !MODEL_ID.test(choice.modeId)
            || choice.modelId !== choice.modeId
            || choice.choiceId !== `model:${choice.modeId}`
            || choice.mappingStatus !== 'exact_otAQ7b_display_name_match'
            || choice.uiEnabledObserved !== true) {
          fail('MODEL_CHOICE_MAPPING_UNRESOLVED', 'This UI label has no unique model ID in the current otAQ7b catalog.');
        }
        if (choice.availability === 'unavailable') fail('MODEL_CHOICE_UNAVAILABLE', 'The model is not selectable.');
        currentModeId = choice.modeId;
        currentModeCategory = MODE_CATEGORIES.has(choice.modeCategory) ? choice.modeCategory : null;
        if (!thinkingLevelByModeId.has(currentModeId)) thinkingLevelByModeId.set(currentModeId, 'THINKING_LEVEL_STANDARD');
        selectedChoiceId = choice.choiceId;
      } else if (choice.kind === 'thinking_level') {
        if (!THINKING_LEVELS.has(choice.thinkingLevel) || choice.uiEnabledObserved !== true) {
          fail('MODEL_CHOICE_INVALID', 'The thinking-level control is not an enabled source-observed choice.');
        }
        if (currentModeId === null) fail('MODEL_SELECTION_REQUIRED', 'Choose a model before changing its thinking level.');
        thinkingLevelByModeId.set(currentModeId, choice.thinkingLevel);
        selectedChoiceId = choice.choiceId;
      } else {
        fail('MODEL_CHOICE_INVALID', 'The Gemini model choice kind is unsupported.');
      }
      return Object.freeze({
        ...snapshot(),
        selectionEffect: GEMINI_MODEL_SELECTION_SOURCE.selectionEffect,
        serverPreferenceWritePerformed: false,
        quotaEligibility: choice.availability ?? 'unknown',
      });
    },
  });
}

export function readGeminiModelSelectionState(state) {
  if (typeof state?.read !== 'function') fail('MODEL_SELECTION_STATE_REQUIRED', 'A source-shaped process-local model state is required.');
  return state.read();
}

export function selectGeminiModelChoice(state, choice) {
  if (typeof state?.select !== 'function') fail('MODEL_SELECTION_STATE_REQUIRED', 'A source-shaped process-local model state is required.');
  return state.select(choice);
}

/** Build only the source-observed metadata fields; callers still need the first-party serializer. */
export function buildGeminiModelRequestMetadata(state, { isTemporaryChat = false } = {}) {
  const selected = readGeminiModelSelectionState(state);
  if (typeof selected.selectedModeId !== 'string' || !MODEL_ID.test(selected.selectedModeId)) {
    fail('MODEL_SELECTION_REQUIRED', 'A catalog-backed Gemini model choice is required.');
  }
  if (typeof isTemporaryChat !== 'boolean') fail('MODEL_TEMPORARY_FLAG_INVALID', 'A boolean temporary-chat flag is required.');
  return Object.freeze({
    modeId: selected.selectedModeId,
    ...(MODE_CATEGORIES.has(selected.modeCategory) ? { modeCategory: selected.modeCategory } : {}),
    thinkingLevel: selected.thinkingLevel,
    isTemporaryChat,
  });
}

export function createGeminiModelSelectionController({ client, state = createGeminiModelSelectionState() } = {}) {
  if (typeof client?.listModels !== 'function' || typeof state?.select !== 'function' || typeof state?.read !== 'function') {
    fail('MODEL_SELECTION_CLIENT_REQUIRED', 'A model-list client and process-local selection state are required.');
  }
  let currentChoices = new WeakSet();
  return Object.freeze({
    async choices(options = {}) {
      const result = await readGeminiModelChoices(client, options);
      currentChoices = new WeakSet();
      for (const choice of result.choices) currentChoices.add(choice);
      return result;
    },
    select(choice) {
      if (!currentChoices.has(choice)) fail('MODEL_CHOICE_NOT_FROM_CURRENT_CATALOG', 'Select a choice from this controller’s current model-list result.');
      return selectGeminiModelChoice(state, choice);
    },
    selected() { return readGeminiModelSelectionState(state); },
    requestMetadata(options = {}) { return buildGeminiModelRequestMetadata(state, options); },
  });
}
