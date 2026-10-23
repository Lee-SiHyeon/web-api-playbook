import { createHash } from 'node:crypto';
import { requireCapturedOperation } from './contract.mjs';
import { GeminiClientError } from './errors.mjs';
import { parseBatchResponse, requireRpcResponse } from './batch-response.mjs';
import { executeMutationOnce } from './mutation.mjs';
import { markMutationReconciled } from './journal.mjs';
import { GEMINI_PREFERENCE_FIELD_IDS } from './conversation-lifecycle.mjs';

export const GEMINI_UPDATE_USER_PREFERENCES_RPC = 'L5adhe';
export const GEMINI_SETTINGS_UPDATE_SOURCE_SHA256 = '3137eb01bfe212ddc5b7df423acd9c9633537f528a0cd13a07c25e075495e7aa';

// This is the only field enabled for controlled writes. It is a reversible,
// non-privacy UI preference. Activity, memory, personal-context, account, and
// security settings remain outside the update allowlist.
export const GEMINI_WRITABLE_PREFERENCE_KEYS = Object.freeze([
  'side_nav_open_by_default',
]);

const BATCH_PATH = '/_/BardChatUi/data/batchexecute';
const QUERY_KEYS = Object.freeze(['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt']);
const BODY_FIELDS = Object.freeze(['f.req', 'at']);
const OWNER_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireBooleanPreferenceKey(key) {
  if (!GEMINI_WRITABLE_PREFERENCE_KEYS.includes(key)
      || !Number.isSafeInteger(GEMINI_PREFERENCE_FIELD_IDS[key])) {
    fail('SETTINGS_UPDATE_KEY_UNSUPPORTED', 'The Gemini preference is outside the source-verified write allowlist.');
  }
  return GEMINI_PREFERENCE_FIELD_IDS[key];
}

function requireOwner(client, expectedOwner) {
  if (!client?.contract || !client?.transport || typeof client.transport.request !== 'function') {
    fail('SETTINGS_UPDATE_CLIENT_INVALID', 'A Gemini client with a protected direct HTTP transport is required.');
  }
  if (typeof expectedOwner !== 'string' || !OWNER_PATTERN.test(expectedOwner)) {
    fail('OWNER_EXPECTATION_INVALID', 'A valid expected Gemini account address is required.');
  }
  if (typeof client.verifyOwner !== 'function') {
    fail('OWNER_GATE_UNAVAILABLE', 'The direct Gemini owner check is unavailable.');
  }
}

function requireBatchOperation(client, operationName, rpcId, effect) {
  const operation = requireCapturedOperation(client.contract, operationName);
  if (operation.effect !== effect || operation.request.method !== 'POST'
      || operation.request.origin !== 'https://gemini.google.com'
      || operation.request.path !== BATCH_PATH
      || JSON.stringify(operation.request.queryKeys) !== JSON.stringify(QUERY_KEYS)
      || JSON.stringify(operation.request.bodyFieldNames) !== JSON.stringify(BODY_FIELDS)
      || operation.request.rpcId !== rpcId
      || operation.request.contentType?.toLowerCase() !== 'application/x-www-form-urlencoded;charset=utf-8'
      || operation.response?.contentType !== 'application/json'
      || operation.response?.framing !== 'batchexecute'
      || operation.response?.rpcId !== rpcId
      || operation.response?.frameLengthUnit !== 'utf16_code_units'
      || operation.response?.frameLengthOverheadUnits !== 2) {
    fail('SETTINGS_UPDATE_CONTRACT_INVALID', 'The observed Gemini preference operation does not match its captured batch contract.');
  }
  return operation;
}

function nextRequestId(client) {
  if (!Number.isSafeInteger(client.nextHistoryRequestId)
      || client.nextHistoryRequestId < 0 || client.nextHistoryRequestId > 999_999_999_999) {
    fail('SESSION_CONTEXT_REQUIRED', 'A current Gemini request sequence is required.');
  }
  const requestId = String(client.nextHistoryRequestId);
  client.nextHistoryRequestId += 1;
  return requestId;
}

function requestContext(client, operation, rpcId) {
  const context = client.transport.session?.batchContext;
  if (!context || typeof context.at !== 'string' || !context.at
      || typeof context.fSid !== 'string' || !context.fSid
      || typeof context.buildLabel !== 'string' || !context.buildLabel
      || typeof context.locale !== 'string' || !context.locale
      || typeof context.requestType !== 'string' || !context.requestType
      || typeof context.sourcePath !== 'string' || !context.sourcePath) {
    fail('SESSION_CONTEXT_REQUIRED', 'A fresh first-party Gemini batch context is required.');
  }
  const requestId = nextRequestId(client);
  const queryValues = {
    rpcids: rpcId,
    'source-path': context.sourcePath,
    bl: context.buildLabel,
    'f.sid': context.fSid,
    hl: context.locale,
    _reqid: requestId,
    rt: context.requestType,
  };
  const query = operation.request.queryKeys.map((name) => {
    if (!Object.hasOwn(queryValues, name)) {
      fail('SETTINGS_UPDATE_CONTRACT_INVALID', 'The captured preference query contains an unsupported field.');
    }
    return Object.freeze([name, queryValues[name]]);
  });
  return { context, query: Object.freeze(query) };
}

function requestHeaders(client, operationName) {
  const headers = client.transport.session?.requestHeaders ?? {};
  const selected = headers[operationName] ?? headers.settings_read ?? headers.history_list ?? {};
  if (!isRecord(selected)) fail('SETTINGS_UPDATE_HEADERS_INVALID', 'Current captured Gemini request headers are required.');
  return Object.freeze({ ...selected });
}

function batchForm(operation, rpcId, args, at) {
  if (!Array.isArray(operation.request.bodyFieldNames)
      || JSON.stringify(operation.request.bodyFieldNames) !== JSON.stringify(BODY_FIELDS)) {
    fail('SETTINGS_UPDATE_CONTRACT_INVALID', 'The captured preference form fields are unavailable.');
  }
  const call = [rpcId, JSON.stringify(args), null, 'generic'];
  const fReq = JSON.stringify([[call]]);
  const values = { 'f.req': fReq, at };
  return new URLSearchParams(operation.request.bodyFieldNames.map((name) => [name, values[name]])).toString();
}

function readRequest(client, key) {
  const fieldId = requireBooleanPreferenceKey(key);
  const operation = requireBatchOperation(client, 'settings_read', 'ESY5D', 'read');
  const { context, query } = requestContext(client, operation, 'ESY5D');
  const body = batchForm(operation, 'ESY5D', [null, [fieldId]], context.at);
  return Object.freeze({
    spec: Object.freeze({
      method: operation.request.method,
      path: operation.request.path,
      query,
      headers: requestHeaders(client, 'settings_read'),
      contentType: operation.request.contentType,
      body,
    }),
    operation,
    fieldId,
  });
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (value === 'true' || value === 'false') return value === 'true';
  return undefined;
}

/**
 * Extract the one requested typed value from observed ESY5D response forms.
 * The current minimal selector response is nested as [[{"41": true|false}]];
 * an older dense-vector response is also accepted. No other preference keys
 * are returned or inspected by callers.
 */
export function inspectPreferenceValue(data, fieldId) {
  if (!Number.isSafeInteger(fieldId) || fieldId < 0 || fieldId > 1000) {
    fail('SETTINGS_FIELD_ID_INVALID', 'The source-mapped Gemini preference field is invalid.');
  }
  const queue = [{ value: data, depth: 0 }];
  const seen = new Set();
  const objectMatches = [];
  const vectorMatches = [];
  let visited = 0;
  while (queue.length && visited < 20_000) {
    const { value, depth } = queue.pop();
    visited += 1;
    if (depth > 16) continue;
    let current = value;
    if (typeof current === 'string' && current.length <= 2 * 1024 * 1024
        && /^[\s]*[\[{]/.test(current)) {
      try { current = JSON.parse(current); } catch { /* Keep non-JSON strings opaque. */ }
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > fieldId) {
        const normalized = normalizeBoolean(current[fieldId]);
        if (normalized !== undefined) vectorMatches.push(normalized);
      }
      for (const child of current) queue.push({ value: child, depth: depth + 1 });
      continue;
    }
    for (const name of [String(fieldId), `field_${fieldId}`]) {
      if (Object.hasOwn(current, name)) {
        const normalized = normalizeBoolean(current[name]);
        if (normalized !== undefined) objectMatches.push(normalized);
      }
    }
    for (const child of Object.values(current)) queue.push({ value: child, depth: depth + 1 });
  }
  const candidates = objectMatches.length ? objectMatches : vectorMatches;
  if (candidates.length !== 1) {
    return Object.freeze({ found: false, type: candidates.length ? 'ambiguous' : 'unreported' });
  }
  return Object.freeze({ found: true, type: 'boolean', value: candidates[0] });
}

function preferenceReadReceipt(read) {
  if (!read || typeof read !== 'object') return null;
  return Object.freeze({
    operation: 'settings_read',
    rpcId: read.rpcId,
    httpStatus: read.httpStatus,
    contentType: read.contentType,
    responseBytes: read.responseBytes,
    responseSha256: read.responseSha256,
    credentialPropagated: read.credentialPropagated === true,
    request: read.request,
    found: read.found === true,
    valueType: read.valueType,
    ...(read.found === true ? { value: read.value } : {}),
    identityRead: read.identityRead,
  });
}

/** Read one allowlisted non-privacy preference over direct HTTP. */
export async function readGeminiPreference(client, { expectedOwner, preferenceKey } = {}) {
  requireOwner(client, expectedOwner);
  const fieldId = requireBooleanPreferenceKey(preferenceKey);
  const identity = await client.verifyOwner(expectedOwner);
  if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
    fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
  }
  const built = readRequest(client, preferenceKey);
  const response = await client.read('settings_read', built.spec);
  const responseSha256 = createHash('sha256').update(response.body).digest('hex');
  let rpc;
  let setting;
  try {
    const frames = parseBatchResponse(response.body, {
      lengthUnit: built.operation.response.frameLengthUnit,
      frameLengthOverheadUnits: built.operation.response.frameLengthOverheadUnits,
    });
    rpc = requireRpcResponse(frames, 'ESY5D');
    setting = inspectPreferenceValue(rpc.data, fieldId);
  } finally {
    response.body.fill(0);
  }
  return Object.freeze({
    ...identity,
    httpStatus: response.httpStatus,
    contentType: response.contentType,
    responseBytes: response.responseBytes,
    responseSha256,
    credentialPropagated: response.credentialPropagated,
    rpcId: rpc.rpcId,
    request: Object.freeze({
      method: built.spec.method,
      origin: built.operation.request.origin,
      path: built.spec.path,
      queryKeys: Object.freeze(built.spec.query.map(([name]) => name)),
      headerNames: Object.freeze([...new Set([
        ...Object.keys(built.spec.headers).map((name) => name.toLowerCase()), 'content-type',
      ])].sort()),
      formFieldNames: Object.freeze([...new URLSearchParams(built.spec.body).keys()]),
      contentType: built.spec.contentType,
      bodyBytes: Buffer.byteLength(built.spec.body, 'utf8'),
      preferenceFieldIds: Object.freeze([fieldId]),
      valuesPersisted: false,
    }),
    preferenceKey,
    identityRead: Object.freeze({
      ownerMatched: identity.ownerMatched === true,
      anonymousOwnerAbsent: identity.anonymousOwnerAbsent === true,
      httpStatus: identity.httpStatus,
      responseBytes: identity.responseBytes,
      responseSha256: identity.responseSha256,
      anonymousHttpStatus: identity.anonymousHttpStatus,
      credentialPropagated: identity.credentialPropagated,
      request: identity.request,
    }),
    found: setting.found,
    valueType: setting.type,
    ...(setting.found ? { value: setting.value } : {}),
  });
}

/** Build the captured L5adhe branch used by the current Gemini web client. */
export function buildPreferenceUpdateRequest(client, { preferenceKey, value } = {}) {
  const fieldId = requireBooleanPreferenceKey(preferenceKey);
  if (typeof value !== 'boolean') fail('SETTINGS_UPDATE_VALUE_INVALID', 'The selected Gemini preference requires a boolean value.');
  const operation = requireBatchOperation(client, 'settings_update', GEMINI_UPDATE_USER_PREFERENCES_RPC, 'mutation');
  if (operation.retryPolicy !== 'never'
      || operation.observation?.request !== true
      || operation.observation?.requestResponse !== true
      || !Array.isArray(operation.request.rpcArgsTemplate)
      || JSON.stringify(operation.request.rpcArgsTemplate) !== JSON.stringify([
        '{{preferenceValueVector}}', null, ['{{preferenceFieldId}}'],
      ])
      || operation.request.preferenceUpdateBranch !== 'field3'
      || operation.request.sourceBundleSha256 !== GEMINI_SETTINGS_UPDATE_SOURCE_SHA256) {
    fail('SETTINGS_UPDATE_CONTRACT_INVALID', 'The captured L5adhe field-3 request branch is unavailable.');
  }
  const { context, query } = requestContext(client, operation, GEMINI_UPDATE_USER_PREFERENCES_RPC);
  const vector = new Array(fieldId).fill(null);
  // First-party Nlc[id].Fd calls _.vi(message, id, value), whose dense jspb
  // array stores the one-based protobuf field at zero-based slot id - 1.
  // The captured field-3 selector remains the one-based id itself.
  vector[fieldId - 1] = value ? 1 : 0;
  const args = [vector, null, [fieldId]];
  return Object.freeze({
    method: operation.request.method,
    path: operation.request.path,
    query,
    headers: requestHeaders(client, 'settings_update'),
    contentType: operation.request.contentType,
    body: batchForm(operation, GEMINI_UPDATE_USER_PREFERENCES_RPC, args, context.at),
  });
}

function responseFieldOne(data) {
  const queue = [{ value: data, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 10_000) {
    const { value, depth } = queue.pop();
    visited += 1;
    if (depth > 12) continue;
    let current = value;
    if (typeof current === 'string' && /^[\s]*[\[{]/.test(current)) {
      try { current = JSON.parse(current); } catch { /* Keep opaque. */ }
    }
    if (Array.isArray(current)) {
      if (current.length > 1 && Number.isSafeInteger(current[1])) return current[1];
      for (const child of current) queue.push({ value: child, depth: depth + 1 });
    } else if (isRecord(current)) {
      for (const key of ['1', 'field_1']) {
        if (Number.isSafeInteger(current[key])) return current[key];
      }
      for (const child of Object.values(current)) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

/** Send one confirmed L5adhe request and independently read back its state. */
export async function updateGeminiPreferenceOnce(client, {
  expectedOwner,
  preferenceKey,
  value,
  baselineValue,
  confirmed,
  callerIntent,
  journalRoot,
} = {}) {
  requireOwner(client, expectedOwner);
  requireBooleanPreferenceKey(preferenceKey);
  if (typeof value !== 'boolean' || typeof baselineValue !== 'boolean'
      || confirmed !== true || typeof callerIntent !== 'string' || !INTENT_PATTERN.test(callerIntent)) {
    fail('SETTINGS_UPDATE_CONFIRMATION_REQUIRED', 'A caller-confirmed boolean value, baseline, and stable intent are required.');
  }
  const before = await readGeminiPreference(client, { expectedOwner, preferenceKey });
  if (before.found !== true || before.valueType !== 'boolean') {
    fail('SETTINGS_BASELINE_UNAVAILABLE', 'The current preference value was not returned as a boolean; no write was sent.');
  }
  if (before.value !== baselineValue) {
    fail('SETTINGS_BASELINE_CHANGED', 'The live preference no longer matches the caller-provided baseline; no write was sent.');
  }
  if (value === baselineValue) {
    fail('SETTINGS_UPDATE_NO_CHANGE', 'The requested test value must differ from its verified baseline.');
  }
  const requestSpec = buildPreferenceUpdateRequest(client, { preferenceKey, value });
  let dispatch;
  let dispatchErrorCode = null;
  try {
    dispatch = await executeMutationOnce({
      transport: client.transport,
      capability: 'settings_update',
      requestSpec,
      actor: expectedOwner,
      callerIntent,
      root: journalRoot,
    });
  } catch (error) {
    dispatchErrorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : 'UNCLASSIFIED';
  }

  let responseRpcMatched = false;
  let providerErrorFieldOne = null;
  let responseContractError = null;
  let responseMetadata = null;
  if (dispatch?.response?.body) {
    const body = dispatch.response.body;
    try {
      const operation = requireCapturedOperation(client.contract, 'settings_update');
      const frames = parseBatchResponse(body, {
        lengthUnit: operation.response.frameLengthUnit,
        frameLengthOverheadUnits: operation.response.frameLengthOverheadUnits,
      });
      const rpc = requireRpcResponse(frames, GEMINI_UPDATE_USER_PREFERENCES_RPC);
      responseRpcMatched = true;
      providerErrorFieldOne = responseFieldOne(rpc.data);
      responseMetadata = Object.freeze({
        httpStatus: dispatch.httpStatus,
        contentType: dispatch.response.contentType,
        responseBytes: dispatch.responseBytes,
        responseSha256: dispatch.responseSha256,
        framing: operation.response.frameLengthUnit,
        frameCount: frames.length,
      });
    } catch (error) {
      responseContractError = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'UNCLASSIFIED';
    } finally {
      body.fill(0);
    }
  }

  let readback;
  let readbackErrorCode = null;
  try {
    readback = await readGeminiPreference(client, { expectedOwner, preferenceKey });
  } catch (error) {
    readbackErrorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : 'UNCLASSIFIED';
  }
  const stateReadbackMatched = readback?.found === true
    && readback.valueType === 'boolean' && readback.value === value;
  const stateReadbackStillBaseline = readback?.found === true
    && readback.valueType === 'boolean' && readback.value === baselineValue;
  let journalState = null;
  if (dispatch?.journalPath && readback?.found === true && readback.valueType === 'boolean') {
    try {
      const settled = await markMutationReconciled(dispatch.journalPath, {
        found: true,
        resultCategory: stateReadbackMatched ? 'preference_value_applied' : 'preference_state_unchanged',
      });
      journalState = settled.state;
    } catch {
      journalState = 'reconciliation_record_failed';
    }
  }
  const outcome = stateReadbackMatched ? 'state_readback_verified'
    : stateReadbackStillBaseline ? 'state_unchanged'
      : 'needs_review';
  return Object.freeze({
    outcome,
    callerIntent,
    preferenceKey,
    valueType: 'boolean',
    ownerMatched: before.ownerMatched === true && (readback?.ownerMatched ?? true) === true,
    anonymousOwnerAbsent: before.anonymousOwnerAbsent === true && (readback?.anonymousOwnerAbsent ?? true) === true,
    baselineMatchedBeforeDispatch: true,
    baselineRead: preferenceReadReceipt(before),
    request: Object.freeze({
      method: requestSpec.method,
      origin: 'https://gemini.google.com',
      path: requestSpec.path,
      queryKeys: Object.freeze(requestSpec.query.map(([name]) => name)),
      headerNames: Object.freeze([...new Set([
        ...Object.keys(requestSpec.headers).map((name) => name.toLowerCase()), 'content-type',
      ])].sort()),
      formFieldNames: Object.freeze([...new URLSearchParams(requestSpec.body).keys()]),
      contentType: requestSpec.contentType,
      bodyBytes: Buffer.byteLength(requestSpec.body, 'utf8'),
      rpcId: GEMINI_UPDATE_USER_PREFERENCES_RPC,
      preferenceFieldIds: Object.freeze([GEMINI_PREFERENCE_FIELD_IDS[preferenceKey]]),
      preferenceArrayIndex: GEMINI_PREFERENCE_FIELD_IDS[preferenceKey] - 1,
      preferenceVectorLength: GEMINI_PREFERENCE_FIELD_IDS[preferenceKey],
      valuesPersisted: false,
    }),
    dispatch: Object.freeze({
      attempted: dispatch !== undefined || dispatchErrorCode !== null,
      httpStatus: dispatch?.httpStatus ?? null,
      responseBytes: dispatch?.responseBytes ?? null,
      responseSha256: dispatch?.responseSha256 ?? null,
      dispatchCount: dispatch?.jobId ? 1 : dispatchErrorCode ? null : 0,
      dispatchErrorCode,
      responseRpcMatched,
      providerErrorFieldOne,
      responseContractError,
      response: responseMetadata,
      journalState,
    }),
    readback: Object.freeze({
      attempted: true,
      httpStatus: readback?.httpStatus ?? null,
      contentType: readback?.contentType ?? null,
      responseBytes: readback?.responseBytes ?? null,
      responseSha256: readback?.responseSha256 ?? null,
      rpcId: readback?.rpcId ?? null,
      request: readback?.request ?? null,
      found: readback?.found === true,
      valueType: readback?.valueType ?? null,
      value: readback?.found === true ? readback.value : undefined,
      identityRead: readback?.identityRead ?? null,
      matchedRequestedValue: stateReadbackMatched,
      matchedBaselineValue: stateReadbackStillBaseline,
      errorCode: readbackErrorCode,
    }),
    automaticRetry: false,
  });
}

/** Flip the allowlisted display preference once, then restore its verified baseline. */
export async function testAndRestoreGeminiPreference(client, {
  expectedOwner,
  preferenceKey = 'side_nav_open_by_default',
  expectedBaselineValue,
  callerIntent,
  confirmed,
  journalRoot,
} = {}) {
  requireBooleanPreferenceKey(preferenceKey);
  if (confirmed !== true || typeof callerIntent !== 'string' || !INTENT_PATTERN.test(callerIntent)
      || callerIntent.length > 100) {
    fail('SETTINGS_UPDATE_CONFIRMATION_REQUIRED', 'A caller-confirmed stable test intent is required.');
  }
  const baseline = await readGeminiPreference(client, { expectedOwner, preferenceKey });
  if (baseline.found !== true || baseline.valueType !== 'boolean') {
    return Object.freeze({
      outcome: 'baseline_unavailable', preferenceKey, ownerMatched: baseline.ownerMatched === true,
      anonymousOwnerAbsent: baseline.anonymousOwnerAbsent === true, writesSent: 0, restored: false,
      callerIntentCorrelationId: callerIntent,
      baselineRead: preferenceReadReceipt(baseline),
    });
  }
  if (expectedBaselineValue !== undefined && typeof expectedBaselineValue !== 'boolean') {
    fail('SETTINGS_UPDATE_VALUE_INVALID', 'The expected reversible-test baseline must be boolean.');
  }
  if (expectedBaselineValue !== undefined && baseline.value !== expectedBaselineValue) {
    return Object.freeze({
      outcome: 'baseline_mismatch', preferenceKey, ownerMatched: baseline.ownerMatched === true,
      anonymousOwnerAbsent: baseline.anonymousOwnerAbsent === true, writesSent: 0, restored: false,
      callerIntentCorrelationId: callerIntent,
      baselineValue: baseline.value,
      baselineRead: preferenceReadReceipt(baseline),
      expectedBaselineMatched: false,
    });
  }
  const testValue = !baseline.value;
  const applied = await updateGeminiPreferenceOnce(client, {
    expectedOwner, preferenceKey, value: testValue, baselineValue: baseline.value,
    confirmed: true, callerIntent: `${callerIntent}.apply`, journalRoot,
  });
  if (applied.readback.matchedRequestedValue !== true) {
    return Object.freeze({
      outcome: applied.readback.matchedBaselineValue === true ? 'unchanged_after_test_write' : 'needs_review',
      preferenceKey,
      callerIntentCorrelationId: callerIntent,
      ownerMatched: applied.ownerMatched,
      anonymousOwnerAbsent: applied.anonymousOwnerAbsent,
      baselineValue: baseline.value,
      baselineRead: preferenceReadReceipt(baseline),
      applied,
      writesSent: applied.dispatch.dispatchCount,
      restored: applied.readback.matchedBaselineValue === true,
      automaticRetry: false,
    });
  }
  const restored = await updateGeminiPreferenceOnce(client, {
    expectedOwner, preferenceKey, value: baseline.value, baselineValue: testValue,
    confirmed: true, callerIntent: `${callerIntent}.restore`, journalRoot,
  });
  const restoredOk = restored.readback.matchedRequestedValue === true;
  return Object.freeze({
    outcome: restoredOk ? 'verified_and_restored' : 'restore_needs_review',
    preferenceKey,
    callerIntentCorrelationId: callerIntent,
    expectedBaselineMatched: expectedBaselineValue === undefined || baseline.value === expectedBaselineValue,
    ownerMatched: applied.ownerMatched && restored.ownerMatched,
    anonymousOwnerAbsent: applied.anonymousOwnerAbsent && restored.anonymousOwnerAbsent,
    baselineValue: baseline.value,
    testValue,
    baselineRead: preferenceReadReceipt(baseline),
    applied,
    restored,
    writesSent: applied.dispatch.dispatchCount + restored.dispatch.dispatchCount,
    restoredToBaseline: restoredOk,
    automaticRetry: false,
  });
}
