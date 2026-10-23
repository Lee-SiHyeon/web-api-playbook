import { createHash } from 'node:crypto';
import { requireCapturedOperation } from './contract.mjs';
import { GeminiClientError } from './errors.mjs';
import { parseBatchResponse, requireRpcResponse } from './batch-response.mjs';
import { historyListRpcId } from './rpc-adapters.mjs';

export const GEMINI_HISTORY_SEARCH_RPC = 'unqWSc';
export const GEMINI_MODEL_STATUS_RPC = 'otAQ7b';
export const GEMINI_READ_USER_PREFERENCES_RPC = 'ESY5D';
export const GEMINI_LIST_PUBLIC_SHARE_LINKS_RPC = 'OXxBcc';
export const GEMINI_PUBLIC_SHARED_CONVERSATION_RPC = 'ujx1Bf';
export const GEMINI_HISTORY_SEARCH_ARGS_TEMPLATE = Object.freeze(['{{searchQuery}}']);
export const GEMINI_HISTORY_LIST_ARGS = Object.freeze([28, null, Object.freeze([0, null, 1])]);

const HISTORY_PATH = '/_/BardChatUi/data/batchexecute';
const HISTORY_ID = /^c_[0-9a-f]{16}$/;
const MODEL_ID = /^[0-9a-f]{16}$/;
const MAX_SEARCH_LENGTH = 256;
const MAX_DETAIL_SEARCH_CONVERSATIONS = 40;
const MAX_DETAIL_STRINGS = 50_000;
const MAX_DETAIL_DEPTH = 24;

// These keys are read-only UI preferences named by the published Gemini web
// client. Callers may request a smaller set, never an arbitrary preference bag.
export const GEMINI_READABLE_PREFERENCE_KEYS = Object.freeze([
  'voice_language',
  'voice_name',
  'enable_advanced_mode',
  'enable_memory',
  'enable_personal_context',
  'web_and_app_activity_enabled',
  'side_nav_open_by_default',
]);

// Field numbers come from the current anonymous Gemini web client bundle's
// `_.mhc` preference-name map. The values are schema selectors for ESY5D;
// callers never supply raw numeric fields, only this named allowlist.
export const GEMINI_PREFERENCE_FIELD_IDS = Object.freeze({
  voice_language: 62,
  voice_name: 61,
  enable_advanced_mode: 39,
  enable_memory: 25,
  enable_personal_context: 77,
  web_and_app_activity_enabled: 93,
  side_nav_open_by_default: 41,
});

const BOOLEAN_PREFERENCE_KEYS = new Set([
  'enable_advanced_mode',
  'enable_memory',
  'enable_personal_context',
  'web_and_app_activity_enabled',
  'side_nav_open_by_default',
]);

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeResponseShape(value, depth = 0) {
  if (depth > 10) return 'depth_limit';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return Object.freeze({ type: 'string', length: value.length });
  if (Array.isArray(value)) {
    return Object.freeze({
      type: 'array', length: value.length,
      items: Object.freeze(value.slice(0, 24).map((item) => safeResponseShape(item, depth + 1))),
    });
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 48);
    return Object.freeze({
      type: 'object', fieldCount: Object.keys(value).length,
      fields: Object.freeze(Object.fromEntries(entries.map(([key, item]) => [
        /^\d{1,8}$/.test(key) ? `field_${key}` : key,
        safeResponseShape(item, depth + 1),
      ]))),
    });
  }
  return 'unsupported';
}

function requireClient(client) {
  if (!client?.contract || !client?.transport || typeof client.transport.request !== 'function') {
    fail('LIFECYCLE_CLIENT_INVALID', 'A Gemini web client with a protected HTTP transport is required.');
  }
  const base = requireCapturedOperation(client.contract, 'history_list');
  if (base.effect !== 'read' || base.request.method !== 'POST'
      || base.request.path !== HISTORY_PATH || base.response?.framing !== 'batchexecute'
      || base.response?.rpcId !== historyListRpcId()) {
    fail('LIFECYCLE_TRANSPORT_CONTRACT_INVALID', 'The captured read-only Gemini batch transport is unavailable.');
  }
  return base;
}

function nextRequestId(client) {
  const batchContext = client.transport.session?.batchContext;
  if (!batchContext || !Number.isSafeInteger(client.nextHistoryRequestId)
      || client.nextHistoryRequestId < 0 || client.nextHistoryRequestId > 999_999_999_999) {
    fail('SESSION_CONTEXT_REQUIRED', 'A fresh Gemini batch context is required for this read.');
  }
  const requestId = String(client.nextHistoryRequestId);
  client.nextHistoryRequestId += 1;
  return requestId;
}

function buildReadRequest(client, operationName, rpcId, args, bindings = {}) {
  const transportContract = requireClient(client);
  const operation = operationName === 'history_list'
    ? transportContract : requireCapturedOperation(client.contract, operationName);
  if (operation.effect !== 'read' || operation.request.method !== transportContract.request.method
      || operation.request.origin !== transportContract.request.origin
      || operation.request.path !== transportContract.request.path
      || JSON.stringify(operation.request.queryKeys) !== JSON.stringify(transportContract.request.queryKeys)
      || JSON.stringify(operation.request.bodyFieldNames) !== JSON.stringify(transportContract.request.bodyFieldNames)
      || typeof operation.request.contentType !== 'string'
      || operation.request.contentType.toLowerCase() !== transportContract.request.contentType.toLowerCase()
      || operation.response?.contentType !== 'application/json'
      || operation.response?.framing !== 'batchexecute' || operation.response?.rpcId !== rpcId) {
    fail('LIFECYCLE_OPERATION_CONTRACT_INVALID', 'The selected Gemini read RPC does not match the captured batch transport.');
  }
  if (operationName !== 'history_list') {
    if (operation.request.rpcId !== rpcId || !Array.isArray(operation.request.rpcArgsTemplate)
        || !matchesRpcArgsTemplate(operation.request.rpcArgsTemplate, args, bindings)) {
      fail('LIFECYCLE_RPC_ARGUMENTS_MISMATCH', 'The Gemini RPC arguments do not match the operation-specific observed template.');
    }
  }
  const context = client.transport.session?.batchContext;
  if (!context) fail('SESSION_CONTEXT_REQUIRED', 'A fresh Gemini batch context is required for this read.');
  if (typeof rpcId !== 'string' || !/^[A-Za-z0-9_-]{3,24}$/.test(rpcId)
      || !Array.isArray(args)) {
    fail('LIFECYCLE_RPC_INPUT_INVALID', 'The Gemini read RPC input is invalid.');
  }
  const requestId = nextRequestId(client);
  const fReq = JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]);
  const values = {
    rpcids: rpcId,
    'source-path': context.sourcePath,
    bl: context.buildLabel,
    'f.sid': context.fSid,
    hl: context.locale,
    _reqid: requestId,
    rt: context.requestType,
  };
  const query = operation.request.queryKeys.map((name) => {
    if (!Object.hasOwn(values, name)) fail('LIFECYCLE_TRANSPORT_CONTRACT_INVALID', 'The captured batch query fields are unsupported.');
    return [name, values[name]];
  });
  const bodyValues = { 'f.req': fReq, at: context.at };
  const bodyFieldNames = operation.request.bodyFieldNames;
  if (!Array.isArray(bodyFieldNames) || bodyFieldNames.length !== 2
      || !bodyFieldNames.includes('f.req') || !bodyFieldNames.includes('at')) {
    fail('LIFECYCLE_TRANSPORT_CONTRACT_INVALID', 'The captured batch form fields are unavailable.');
  }
  return Object.freeze({
    method: operation.request.method,
    path: operation.request.path,
    query: Object.freeze(query.map((entry) => Object.freeze(entry))),
    headers: Object.freeze(client.transport.session.requestHeaders?.[operationName]
      ?? client.transport.session.requestHeaders?.history_list ?? {}),
    contentType: operation.request.contentType,
    body: new URLSearchParams(bodyFieldNames.map((name) => [name, bodyValues[name]])).toString(),
  });
}

function matchesRpcArgsTemplate(template, actual, bindings) {
  if (typeof template === 'string') {
    const placeholder = /^\{\{([A-Za-z][A-Za-z0-9]*)\}\}$/.exec(template);
    if (!placeholder) return template === actual;
    const expected = bindings[placeholder[1]];
    return expected !== undefined && JSON.stringify(actual) === JSON.stringify(expected);
  }
  if (isRecord(template) && Object.keys(template).length === 1 && typeof template.$literal === 'string') {
    return actual === template.$literal;
  }
  if (template === null || typeof template === 'boolean' || typeof template === 'number') return template === actual;
  if (!Array.isArray(template) || !Array.isArray(actual) || template.length !== actual.length) return false;
  return template.every((item, index) => matchesRpcArgsTemplate(item, actual[index], bindings));
}

function bindRpcArgsTemplate(template, bindings, depth = 0) {
  if (depth > 24) fail('LIFECYCLE_RPC_TEMPLATE_INVALID', 'The observed Gemini RPC argument template is too deeply nested.');
  if (typeof template === 'string') {
    const placeholder = /^\{\{([A-Za-z][A-Za-z0-9]*)\}\}$/.exec(template);
    return placeholder ? bindings[placeholder[1]] : template;
  }
  if (isRecord(template) && Object.keys(template).length === 1 && typeof template.$literal === 'string') {
    return template.$literal;
  }
  if (Array.isArray(template)) return template.map((item) => bindRpcArgsTemplate(item, bindings, depth + 1));
  if (isRecord(template)) return Object.fromEntries(Object.entries(template)
    .map(([key, value]) => [key, bindRpcArgsTemplate(value, bindings, depth + 1)]));
  return template;
}

function countRpcPlaceholder(template, name, depth = 0) {
  if (depth > 24) return 0;
  if (typeof template === 'string') return template === `{{${name}}}` ? 1 : 0;
  if (Array.isArray(template)) return template.reduce((sum, item) => sum + countRpcPlaceholder(item, name, depth + 1), 0);
  if (isRecord(template)) return Object.values(template).reduce((sum, item) => sum + countRpcPlaceholder(item, name, depth + 1), 0);
  return 0;
}

async function verifyOwner(client, expectedOwner) {
  if (typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    fail('OWNER_EXPECTATION_INVALID', 'A valid expected Gemini account address is required.');
  }
  if (typeof client.verifyOwner !== 'function') fail('OWNER_GATE_UNAVAILABLE', 'The Gemini owner identity check is unavailable.');
  const identity = await client.verifyOwner(expectedOwner);
  if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
    fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
  }
  return Object.freeze({ ownerMatched: true, anonymousOwnerAbsent: true, httpStatus: identity.httpStatus });
}

async function executeReadRpc(client, operationName, rpcId, args, bindings = {}) {
  const operation = operationName === 'history_list'
    ? requireClient(client) : requireCapturedOperation(client.contract, operationName);
  const requestSpec = buildReadRequest(client, operationName, rpcId, args, bindings);
  const response = await client.transport.request(operationName, requestSpec);
  const responseSha256 = createHash('sha256').update(response.body).digest('hex');
  let rpc;
  try {
    const frames = parseBatchResponse(response.body, {
      lengthUnit: operation.response.frameLengthUnit,
      frameLengthOverheadUnits: operation.response.frameLengthOverheadUnits,
    });
    rpc = requireRpcResponse(frames, rpcId);
  } finally {
    response.body.fill(0);
  }
  return Object.freeze({
    request: Object.freeze({
      method: requestSpec.method,
      origin: operation.request.origin,
      path: requestSpec.path,
      queryKeys: Object.freeze(requestSpec.query.map(([name]) => name)),
      headerNames: Object.freeze([...new Set([
        ...Object.keys(requestSpec.headers).map((name) => name.toLowerCase()),
        'content-type',
      ])].sort()),
      formFieldNames: Object.freeze([...new URLSearchParams(requestSpec.body).keys()]),
      contentType: requestSpec.contentType,
      bodyBytes: Buffer.byteLength(requestSpec.body, 'utf8'),
      valuesPersisted: false,
    }),
    httpStatus: response.httpStatus,
    contentType: response.contentType,
    responseBytes: response.responseBytes,
    responseSha256,
    credentialPropagated: response.credentialPropagated,
    rpcId,
    dataShape: safeResponseShape(rpc.data),
    data: rpc.data,
  });
}

async function executeAnonymousShareReadRpc(client, rpcId, args, bindings = {}) {
  const operationName = 'share_public_read';
  const operation = requireCapturedOperation(client.contract, operationName);
  const requestSpec = buildReadRequest(client, operationName, rpcId, args, bindings);
  const response = await client.transport.request(operationName, requestSpec, { omitCredentials: true });
  const responseSha256 = createHash('sha256').update(response.body).digest('hex');
  let rpc;
  try {
    const frames = parseBatchResponse(response.body, {
      lengthUnit: operation.response.frameLengthUnit,
      frameLengthOverheadUnits: operation.response.frameLengthOverheadUnits,
    });
    rpc = requireRpcResponse(frames, rpcId);
  } finally {
    response.body.fill(0);
  }
  return Object.freeze({
    request: Object.freeze({
      method: requestSpec.method,
      origin: operation.request.origin,
      path: requestSpec.path,
      queryKeys: Object.freeze(requestSpec.query.map(([name]) => name)),
      headerNames: Object.freeze([...new Set([
        ...Object.keys(requestSpec.headers).map((name) => name.toLowerCase()),
        'content-type',
      ])].sort()),
      formFieldNames: Object.freeze([...new URLSearchParams(requestSpec.body).keys()]),
      contentType: requestSpec.contentType,
      bodyBytes: Buffer.byteLength(requestSpec.body, 'utf8'),
      valuesPersisted: false,
    }),
    httpStatus: response.httpStatus,
    contentType: response.contentType,
    responseBytes: response.responseBytes,
    responseSha256,
    credentialPropagated: response.credentialPropagated,
    rpcId,
    responseRpcDecoded: true,
    dataShape: safeResponseShape(rpc.data),
    data: rpc.data,
  });
}

function parseTimestamp(row) {
  const time = row?.[5];
  if (!Array.isArray(time) || time.length < 2) return null;
  const seconds = Number(time[0]);
  const nanos = Number(time[1]);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)
      || seconds < 0 || seconds > 4_102_444_800 || nanos < 0 || nanos >= 1_000_000_000) return null;
  return new Date((seconds * 1000) + (nanos / 1_000_000)).toISOString();
}

function decodeNestedJson(value, depth = 0) {
  if (depth > 12 || typeof value !== 'string' || value.length > 2 * 1024 * 1024) return value;
  const trimmed = value.trimStart();
  if (trimmed[0] !== '[' && trimmed[0] !== '{') return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

/** Extract only stable conversation metadata from the observed MaZiqc payload. */
export function extractConversationSummaries(data, { maxItems = 500 } = {}) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 2_000) {
    fail('HISTORY_LIMIT_INVALID', 'The conversation summary limit is outside the supported range.');
  }
  const summaries = [];
  const seen = new Set();
  const pending = [{ value: data, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 100_000 && summaries.length < maxItems) {
    const { value: item, depth } = pending.pop();
    visited += 1;
    if (depth > 24) continue;
    const decoded = decodeNestedJson(item, depth);
    if (decoded !== item) {
      pending.push({ value: decoded, depth: depth + 1 });
      continue;
    }
    if (Array.isArray(item)) {
      for (const row of item) {
        if (Array.isArray(row) && row.length > 1 && typeof row[0] === 'string'
            && HISTORY_ID.test(row[0]) && typeof row[1] === 'string' && !seen.has(row[0])) {
          seen.add(row[0]);
          summaries.push(Object.freeze({
            conversationId: row[0],
            title: row[1].slice(0, 1_000),
            pinned: Boolean(row[2]),
            updatedAt: parseTimestamp(row),
          }));
        }
      }
      for (let index = item.length - 1; index >= 0; index -= 1) pending.push({ value: item[index], depth: depth + 1 });
    } else if (isRecord(item)) {
      for (const child of Object.values(item)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return Object.freeze(summaries);
}

export async function listConversations(client, { expectedOwner, maxItems = 500 } = {}) {
  requireClient(client);
  const identity = await verifyOwner(client, expectedOwner);
  const listed = await executeReadRpc(client, 'history_list', historyListRpcId(), [
    GEMINI_HISTORY_LIST_ARGS[0],
    null,
    [GEMINI_HISTORY_LIST_ARGS[2][0], null, GEMINI_HISTORY_LIST_ARGS[2][2]],
  ]);
  return Object.freeze({
    ...identity,
    httpStatus: listed.httpStatus,
    contentType: listed.contentType,
    responseBytes: listed.responseBytes,
    responseSha256: listed.responseSha256,
    dataShape: safeResponseShape(listed.data),
    credentialPropagated: listed.credentialPropagated,
    rpcId: listed.rpcId,
    conversations: extractConversationSummaries(listed.data, { maxItems }),
    data: listed.data,
  });
}

export async function readConversation(client, {
  expectedOwner,
  conversationId,
  expectedIntent,
} = {}) {
  requireClient(client);
  const identity = await verifyOwner(client, expectedOwner);
  if (typeof conversationId !== 'string' || !HISTORY_ID.test(conversationId)) {
    fail('HISTORY_ID_INVALID', 'A captured Gemini API conversation ID is required.');
  }
  const detail = await client.readHistoryDetail({
    apiConversationId: conversationId,
    visibleRouteId: conversationId.slice(2),
    expectedIntent,
  });
  const result = {
    ownerMatched: identity.ownerMatched,
    anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
    ...detail,
  };
  Object.defineProperties(result, {
    payload: { value: detail.payload, enumerable: false },
    media: { value: detail.media, enumerable: false },
  });
  return Object.freeze(result);
}

export async function searchConversations(client, {
  expectedOwner,
  query,
} = {}) {
  requireClient(client);
  const identity = await verifyOwner(client, expectedOwner);
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_SEARCH_LENGTH || /[\0\r\n]/.test(query)) {
    fail('HISTORY_SEARCH_QUERY_INVALID', 'A non-empty Gemini conversation search query of at most 256 characters is required.');
  }
  const result = await executeReadRpc(client, 'history_search', GEMINI_HISTORY_SEARCH_RPC, [query], {
    searchQuery: query,
  });
  return Object.freeze({
    ...identity,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    responseSha256: result.responseSha256,
    request: result.request,
    dataShape: result.dataShape,
    credentialPropagated: result.credentialPropagated,
    rpcId: result.rpcId,
    queryLength: query.length,
    data: result.data,
  });
}

function numberList(value) {
  return Array.isArray(value) ? value.filter((item) => Number.isSafeInteger(item)) : [];
}

function computeModelCapacity(tierFlags, capabilityFlags) {
  if (tierFlags.includes(21)) return { capacity: 1, capacityField: 13 };
  if (tierFlags.includes(22)) return { capacity: 2, capacityField: 13 };
  if (capabilityFlags.includes(115)) return { capacity: 4, capacityField: 12 };
  if (tierFlags.includes(16) || capabilityFlags.includes(106)) return { capacity: 3, capacityField: 12 };
  if (tierFlags.includes(8) || capabilityFlags.includes(19)) return { capacity: 2, capacityField: 12 };
  return { capacity: 1, capacityField: 12 };
}

function toModelName(category, display, modelId) {
  const source = category.trim() || display.trim() || modelId;
  const slug = source.toLocaleLowerCase('en-US').replace(/\s+/g, '-');
  return slug.startsWith('gemini-') ? slug : `gemini-${slug}`;
}

function parseModel(model, availability) {
  if (!Array.isArray(model)) return null;
  const modelId = model[0];
  if (typeof modelId !== 'string' || !MODEL_ID.test(modelId)) return null;
  const category = typeof model[1] === 'string' ? model[1] : typeof model[10] === 'string' ? model[10] : '';
  const display = [model[11], model[19], model[1]].find((value) => typeof value === 'string' && value.trim()) ?? '';
  const description = [model[12], model[2]].find((value) => typeof value === 'string' && value.trim()) ?? '';
  const modelNumber = Number.isSafeInteger(model[17]) ? model[17] : Number.isSafeInteger(model[9]) ? model[9] : 1;
  return Object.freeze({
    modelId,
    modelName: toModelName(category, display, modelId),
    displayName: String(display || category || modelId).slice(0, 160),
    description: String(description).slice(0, 500),
    capacity: availability.capacity,
    capacityField: availability.capacityField,
    modelNumber,
    available: true,
  });
}

export function parseModelStatus(data) {
  if (!Array.isArray(data)) fail('MODEL_STATUS_RESPONSE_INVALID', 'The Gemini model status payload was not an array.');
  const statusCode = data[14] === null || data[14] === undefined ? 1000 : data[14];
  if (!Number.isSafeInteger(statusCode) || statusCode < 0 || statusCode > 65_535) {
    fail('MODEL_STATUS_RESPONSE_INVALID', 'The Gemini account status field was outside the supported range.');
  }
  const rawModels = data[15];
  if (!Array.isArray(rawModels)) fail('MODEL_STATUS_RESPONSE_INVALID', 'The Gemini model list was absent from the status payload.');
  const tierFlags = numberList(data[16]);
  const capabilityFlags = numberList(data[17]);
  const capacity = computeModelCapacity(tierFlags, capabilityFlags);
  const available = statusCode === 1000;
  const guestSession = statusCode === 1016;
  const models = rawModels.map((model) => parseModel(model, capacity)).filter(Boolean)
    .map((model, index) => available || (guestSession && index === 0)
      ? model : Object.freeze({ ...model, available: false }));
  return Object.freeze({
    accountStatus: available ? 'available' : guestSession ? 'guest' : 'restricted',
    statusCode,
    models: Object.freeze(models),
  });
}

export async function readModels(client, { expectedOwner } = {}) {
  requireClient(client);
  const identity = await verifyOwner(client, expectedOwner);
  const result = await executeReadRpc(client, 'model_list', GEMINI_MODEL_STATUS_RPC, []);
  const parsed = parseModelStatus(result.data);
  return Object.freeze({
    ...identity,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    responseSha256: result.responseSha256,
    request: result.request,
    dataShape: result.dataShape,
    credentialPropagated: result.credentialPropagated,
    rpcId: result.rpcId,
    ...parsed,
  });
}

function preferenceVectorFromResponse(data) {
  const decoded = decodeNestedJson(data);
  if (Array.isArray(decoded)) {
    const fieldOne = decodeNestedJson(decoded[0]);
    return Array.isArray(fieldOne) || isRecord(fieldOne) ? fieldOne : null;
  }
  if (isRecord(decoded)) {
    const fieldOne = decodeNestedJson(decoded['0'] ?? decoded['1']);
    return Array.isArray(fieldOne) || isRecord(fieldOne) ? fieldOne : null;
  }
  return null;
}

function vectorValue(vector, fieldId) {
  return Array.isArray(vector) ? vector[fieldId] : vector[String(fieldId)];
}

function safePreferenceValue(key, value) {
  if (BOOLEAN_PREFERENCE_KEYS.has(key)) {
    if (typeof value === 'boolean') return Object.freeze({ found: true, type: 'boolean', value });
    if (value === 'true' || value === 'false') {
      return Object.freeze({ found: true, type: 'boolean', value: value === 'true' });
    }
    return Object.freeze({ found: false, type: 'unsupported' });
  }
  if (value === null) return Object.freeze({ found: true, type: 'null', value });
  if (typeof value === 'string' && value.length <= 256 && !/[\0\r\n]/.test(value)) {
    return Object.freeze({ found: true, type: 'string', value });
  }
  return Object.freeze({ found: false, type: 'unsupported' });
}

export function parsePreferenceResponse(data, keys = GEMINI_READABLE_PREFERENCE_KEYS) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > GEMINI_READABLE_PREFERENCE_KEYS.length
      || keys.some((key) => !GEMINI_READABLE_PREFERENCE_KEYS.includes(key))
      || new Set(keys).size !== keys.length) {
    fail('SETTINGS_KEYS_INVALID', 'The preference key list contains an unsupported setting.');
  }
  const fieldIds = keys.map((key) => GEMINI_PREFERENCE_FIELD_IDS[key]);
  if (fieldIds.some((fieldId) => !Number.isSafeInteger(fieldId))) {
    fail('SETTINGS_KEYS_INVALID', 'The preference key list contains an unsupported setting.');
  }
  const vector = preferenceVectorFromResponse(data);
  const values = {};
  for (const key of keys) {
    const candidate = vector ? vectorValue(vector, GEMINI_PREFERENCE_FIELD_IDS[key]) : undefined;
    values[key] = candidate === undefined || candidate === null
      ? Object.freeze({ found: false, type: 'unreported' })
      : safePreferenceValue(key, candidate);
  }
  return Object.freeze(values);
}

export async function readSettings(client, {
  expectedOwner,
  keys = GEMINI_READABLE_PREFERENCE_KEYS,
} = {}) {
  requireClient(client);
  // Validate before network dispatch so an unsupported name cannot be submitted.
  parsePreferenceResponse([], keys);
  const identity = await verifyOwner(client, expectedOwner);
  const operation = requireCapturedOperation(client.contract, 'settings_read');
  const fieldIds = operation.request.preferenceFieldIds;
  const requestedFieldIds = keys.map((key) => GEMINI_PREFERENCE_FIELD_IDS[key]);
  if (!Array.isArray(fieldIds) || fieldIds.length < requestedFieldIds.length || fieldIds.length > 512
      || fieldIds.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1000)
      || new Set(fieldIds).size !== fieldIds.length
      || requestedFieldIds.some((value) => !fieldIds.includes(value))) {
    fail('SETTINGS_SELECTOR_SCHEMA_INVALID', 'The captured Gemini settings selector vector is unavailable or incomplete.');
  }
  const result = await executeReadRpc(client, 'settings_read', GEMINI_READ_USER_PREFERENCES_RPC, [null, [...fieldIds]], {
    allowlistedPreferenceKeys: [...keys],
    preferenceFieldIds: [...fieldIds],
  });
  return Object.freeze({
    ...identity,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    responseSha256: result.responseSha256,
    request: result.request,
    dataShape: result.dataShape,
    credentialPropagated: result.credentialPropagated,
    rpcId: result.rpcId,
    requestedKeys: Object.freeze([...keys]),
    settings: parsePreferenceResponse(result.data, keys),
  });
}

function publicShareCount(data) {
  const decoded = decodeNestedJson(data);
  if (Array.isArray(decoded) && Array.isArray(decoded[0])) return decoded[0].length;
  return 0;
}

function exactTextCount(root, expected, { maxNodes = 100_000 } = {}) {
  const pending = [{ value: root, depth: 0 }];
  let visited = 0;
  let matches = 0;
  while (pending.length && visited < maxNodes) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > 24) continue;
    const decoded = decodeNestedJson(value, depth);
    if (decoded !== value) {
      pending.push({ value: decoded, depth: depth + 1 });
      continue;
    }
    if (typeof value === 'string') {
      if (value === expected) matches += 1;
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (isRecord(value)) {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return matches;
}

/** Read the signed-in owner's public-link list. Values stay in memory so the
 * caller can correlate a task title without persisting other link records. */
export async function readPublicShareLinks(client, { expectedOwner } = {}) {
  requireClient(client);
  const operation = requireCapturedOperation(client.contract, 'share_read');
  if (operation.effect !== 'read' || operation.request.rpcId !== GEMINI_LIST_PUBLIC_SHARE_LINKS_RPC
      || !Array.isArray(operation.request.rpcArgsTemplate) || operation.request.rpcArgsTemplate.length !== 0) {
    fail('SHARE_LIST_CONTRACT_INVALID', 'The captured owner public-link list read is unavailable.');
  }
  const identity = await verifyOwner(client, expectedOwner);
  const result = await executeReadRpc(client, 'share_read', GEMINI_LIST_PUBLIC_SHARE_LINKS_RPC, []);
  const summary = {
    ...identity,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    responseSha256: result.responseSha256,
    request: result.request,
    dataShape: result.dataShape,
    credentialPropagated: result.credentialPropagated,
    rpcId: result.rpcId,
    shareCount: publicShareCount(result.data),
  };
  Object.defineProperty(summary, 'internal', {
    value: { data: result.data },
    enumerable: false,
  });
  return Object.freeze(summary);
}

/** Read a public shared conversation with its source-observed share ID argument. */
export async function readSharedConversation(client, { shareId, expectedOwner, anonymous = false } = {}) {
  requireClient(client);
  if (typeof shareId !== 'string' || !/^[A-Za-z0-9._~-]{8,256}$/.test(shareId)) {
    fail('SHARE_ID_INVALID', 'A bounded public share identifier is required.');
  }
  const operation = requireCapturedOperation(client.contract, 'share_public_read');
  const template = operation.request.rpcArgsTemplate;
  if (operation.effect !== 'read' || operation.request.rpcId !== GEMINI_PUBLIC_SHARED_CONVERSATION_RPC
      || countRpcPlaceholder(template, 'shareId') !== 1) {
    fail('SHARED_CONVERSATION_CONTRACT_INVALID', 'The captured public-share read contract is unavailable.');
  }
  if (typeof anonymous !== 'boolean') fail('SHARE_READ_MODE_INVALID', 'The public-share credential mode must be explicit.');
  const identity = anonymous
    ? Object.freeze({ ownerMatched: null, anonymousOwnerAbsent: null, httpStatus: null })
    : await verifyOwner(client, expectedOwner);
  const args = bindRpcArgsTemplate(template, { shareId });
  if (!matchesRpcArgsTemplate(template, args, { shareId })) {
    fail('LIFECYCLE_RPC_ARGUMENTS_MISMATCH', 'The public-share ID did not bind to the captured RPC arguments.');
  }
  const result = anonymous
    ? await executeAnonymousShareReadRpc(client, GEMINI_PUBLIC_SHARED_CONVERSATION_RPC, args, { shareId })
    : await executeReadRpc(client, 'share_public_read', GEMINI_PUBLIC_SHARED_CONVERSATION_RPC, args, { shareId });
  const summary = {
    ...identity,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    responseSha256: result.responseSha256,
    request: result.request,
    dataShape: result.dataShape,
    credentialPropagated: result.credentialPropagated,
    anonymousRequest: anonymous,
    responseRpcDecoded: result.responseRpcDecoded === true,
    rpcId: result.rpcId,
    shareIdLength: shareId.length,
  };
  Object.defineProperty(summary, 'internal', {
    value: { data: result.data },
    enumerable: false,
  });
  return Object.freeze(summary);
}

export async function readAnonymousSharedConversation(client, { shareId } = {}) {
  return readSharedConversation(client, { shareId, anonymous: true });
}

export function publicShareMatchesConversationTitle(data, title) {
  return publicShareConversationRowCount(data, title) > 0;
}

/** Count owner-list rows for an exact title without exposing IDs or link URLs. */
export function publicShareConversationRowCount(data, title) {
  if (typeof title !== 'string' || !title.trim() || title.length > 160 || /[\0\r\n]/.test(title)) {
    fail('SHARE_TITLE_INVALID', 'A bounded conversation title is required for public-link matching.');
  }
  const decoded = decodeNestedJson(data);
  if (!Array.isArray(decoded) || !Array.isArray(decoded[0])) return 0;
  if (decoded[0].length > 500) fail('SHARE_LIST_SIZE_UNSUPPORTED', 'The public-link list exceeds the bounded matching limit.');
  return decoded[0].filter((row) => exactTextCount(row, title, { maxNodes: 10_000 }) > 0).length;
}

/** Return how many owner-list rows bind one exact share ID to one exact title. */
export function publicShareConversationRowHasId(data, title, shareId) {
  if (typeof title !== 'string' || !title.trim() || title.length > 160 || /[\0\r\n]/.test(title)
      || typeof shareId !== 'string' || !/^[A-Za-z0-9._~-]{8,256}$/.test(shareId)) {
    fail('SHARE_ROW_BINDING_INPUT_INVALID', 'A bounded task title and public share identifier are required.');
  }
  const decoded = decodeNestedJson(data);
  if (!Array.isArray(decoded) || !Array.isArray(decoded[0])) return 0;
  if (decoded[0].length > 500) fail('SHARE_LIST_SIZE_UNSUPPORTED', 'The public-link list exceeds the bounded matching limit.');
  return decoded[0].filter((row) => exactTextCount(row, title, { maxNodes: 10_000 }) > 0
    && exactTextCount(row, shareId, { maxNodes: 10_000 }) > 0).length;
}

function normalizedSearch(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function scanStrings(root, needle, { maxStrings = MAX_DETAIL_STRINGS } = {}) {
  const pending = [{ value: root, depth: 0 }];
  let inspected = 0;
  while (pending.length && inspected < maxStrings) {
    const { value, depth } = pending.pop();
    inspected += 1;
    if (depth > MAX_DETAIL_DEPTH) continue;
    const decoded = decodeNestedJson(value, depth);
    if (decoded !== value) {
      pending.push({ value: decoded, depth: depth + 1 });
      continue;
    }
    if (typeof value === 'string') {
      if (normalizedSearch(value).includes(needle)) return true;
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push({ value: value[index], depth: depth + 1 });
    } else if (isRecord(value)) {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Local bounded convenience search. It lists the currently returned history
 * window and searches details for at most 40 listed conversations. Gemini's
 * remote SearchConversations operation is exposed separately by
 * searchConversations().
 */
export async function searchListedConversationDetails(client, {
  expectedOwner,
  query,
  maxConversations = 20,
} = {}) {
  if (!Number.isSafeInteger(maxConversations) || maxConversations < 1 || maxConversations > MAX_DETAIL_SEARCH_CONVERSATIONS) {
    fail('HISTORY_SEARCH_LIMIT_INVALID', 'The bounded history detail search limit must be from 1 to 40.');
  }
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_SEARCH_LENGTH || /[\0\r\n]/.test(query)) {
    fail('HISTORY_SEARCH_QUERY_INVALID', 'A non-empty Gemini conversation search query of at most 256 characters is required.');
  }
  const listing = await listConversations(client, { expectedOwner });
  const target = normalizedSearch(query.trim());
  const candidates = listing.conversations.slice(0, maxConversations);
  const matches = [];
  let readCount = 0;
  for (const summary of candidates) {
    if (normalizedSearch(summary.title).includes(target)) {
      matches.push(Object.freeze({ ...summary, matchSource: 'title' }));
      continue;
    }
    const detail = await client.readHistoryDetail({
      apiConversationId: summary.conversationId,
      visibleRouteId: summary.conversationId.slice(2),
    });
    readCount += 1;
    if (scanStrings(detail.payload, target)) matches.push(Object.freeze({ ...summary, matchSource: 'conversation_content' }));
  }
  return Object.freeze({
    queryLength: query.length,
    searchScope: 'current_history_window_and_bounded_details',
    historyWindowCount: listing.conversations.length,
    conversationDetailsRead: readCount,
    conversationDetailsLimit: maxConversations,
    truncated: listing.conversations.length > candidates.length,
    matches: Object.freeze(matches),
  });
}
