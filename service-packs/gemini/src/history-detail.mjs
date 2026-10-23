import { createHash } from 'node:crypto';
import { GeminiClientError } from './errors.mjs';
import { parseBatchResponse } from './batch-response.mjs';
import { decodeGeminiMediaResponse } from './media-response.mjs';

export const GEMINI_HISTORY_DETAIL_RPC = 'hNvQHb';
export const GEMINI_API_CONVERSATION_ID_PATTERN = /^c_[0-9a-f]{16}$/;
export const GEMINI_ROUTE_CONVERSATION_ID_PATTERN = /^[0-9a-f]{16}$/;
export const GEMINI_API_CONVERSATION_ID_TOKEN = '{{apiConversationId}}';

const REQUIRED_QUERY_KEYS = Object.freeze(['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt']);
const MAX_DETAIL_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 50_000;

function withInternal(summary, internal) {
  const result = { summary };
  Object.defineProperty(result, 'internal', { value: Object.freeze(internal), enumerable: false });
  return Object.freeze(result);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeField(value) {
  const key = String(value);
  if (/^\d{1,8}$/.test(key)) return `field_${key}`;
  if (/^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/.test(key)) return key;
  return '{dynamic_field}';
}

function typeShape(value, depth = 0) {
  if (depth > 12) return 'depth_limit';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return Object.freeze({ type: 'array', length: value.length, items: Object.freeze(value.slice(0, 32).map((item) => typeShape(item, depth + 1))) });
  if (isRecord(value)) {
    const keys = Object.keys(value).sort().slice(0, 100);
    return Object.freeze({
      type: 'object',
      fieldCount: Object.keys(value).length,
      fields: Object.freeze(Object.fromEntries(keys.map((key) => [safeField(key), typeShape(value[key], depth + 1)]))),
    });
  }
  return 'unsupported';
}

function decodeNestedJson(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return value;
  if (typeof value === 'string') {
    const candidate = value.trimStart();
    if (candidate.length > 2 * 1024 * 1024 || !['[', '{'].includes(candidate[0])) return value;
    try { return decodeNestedJson(JSON.parse(candidate), state, depth + 1); }
    catch { return value; }
  }
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => decodeNestedJson(item, state, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 2_000)
      .map(([key, item]) => [key, decodeNestedJson(item, state, depth + 1)]));
  }
  return value;
}

function replaceConversationId(template, rawConversationId) {
  let replacements = 0;
  const visit = (value, depth = 0) => {
    if (depth > 12) throw new GeminiClientError('HISTORY_DETAIL_TEMPLATE_INVALID', 'The observed detail argument template is too deeply nested.');
    if (value === GEMINI_API_CONVERSATION_ID_TOKEN) {
      replacements += 1;
      return rawConversationId;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)]));
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    throw new GeminiClientError('HISTORY_DETAIL_TEMPLATE_INVALID', 'The observed detail argument template contains an unsupported value.');
  };
  const result = visit(template);
  if (replacements !== 1) throw new GeminiClientError('HISTORY_DETAIL_TEMPLATE_INVALID', 'The observed detail template must contain one conversation ID slot.');
  return result;
}

/**
 * Bind the raw MaZiqc API conversation ID to the observed visible route ID.
 * The API ID is retained verbatim for hNvQHb; c_ removal is only used to verify
 * the separately observed /app/{id} route relationship.
 */
export function bindGeminiConversationIds(apiConversationId, visibleRouteId) {
  if (typeof apiConversationId !== 'string' || !GEMINI_API_CONVERSATION_ID_PATTERN.test(apiConversationId)
    || typeof visibleRouteId !== 'string' || !GEMINI_ROUTE_CONVERSATION_ID_PATTERN.test(visibleRouteId)) {
    throw new GeminiClientError('HISTORY_ID_BINDING_INVALID', 'The captured Gemini conversation identifier format was not observed.');
  }
  const expectedRouteId = apiConversationId.slice(2);
  if (visibleRouteId !== expectedRouteId) {
    throw new GeminiClientError('HISTORY_ID_BINDING_MISMATCH', 'The API conversation ID did not map to the observed route ID.');
  }
  const binding = {
    bound: true,
    apiConversationIdLength: apiConversationId.length,
    visibleRouteIdLength: visibleRouteId.length,
  };
  Object.defineProperties(binding, {
    apiConversationId: { value: apiConversationId, enumerable: false },
    visibleRouteId: { value: visibleRouteId, enumerable: false },
  });
  return Object.freeze(binding);
}

function batchQueryValues(context, requestId) {
  return {
    rpcids: GEMINI_HISTORY_DETAIL_RPC,
    'source-path': context.sourcePath,
    bl: context.buildLabel,
    'f.sid': context.fSid,
    hl: context.locale,
    _reqid: String(requestId),
    rt: context.requestType,
  };
}

/** Build the hNvQHb request from its captured registry template and current session context. */
export function buildHistoryDetailRequest(contract, session, {
  apiConversationId,
  visibleRouteId,
  requestId,
} = {}) {
  const operation = contract?.operations?.history_read;
  if (!operation || (operation.observation?.request !== true && operation.observation?.requestResponse !== true)
    || operation.request?.rpcId !== GEMINI_HISTORY_DETAIL_RPC
    || operation.request?.method !== 'POST'
    || operation.request?.path !== '/_/BardChatUi/data/batchexecute') {
    throw new GeminiClientError('HISTORY_DETAIL_CONTRACT_NOT_CAPTURED', 'A captured hNvQHb detail-read contract is required.');
  }
  const batchContext = session?.batchContext;
  if (!batchContext) throw new GeminiClientError('SESSION_CONTEXT_REQUIRED', 'A fresh Gemini batch context is required for history detail reads.');
  const binding = bindGeminiConversationIds(apiConversationId, visibleRouteId);
  const template = operation.request.rpcArgsTemplate;
  if (!Array.isArray(template) || template.length !== 8 || template[0] !== GEMINI_API_CONVERSATION_ID_TOKEN) {
    throw new GeminiClientError('HISTORY_DETAIL_TEMPLATE_INVALID', 'The observed hNvQHb argument template is unavailable.');
  }
  const args = replaceConversationId(template, binding.apiConversationId);
  const sequence = requestId ?? batchContext.requestId;
  if (typeof sequence !== 'string' || !/^\d{1,12}$/.test(sequence)) {
    throw new GeminiClientError('SESSION_CONTEXT_REQUIRED', 'A numeric Gemini request sequence is required for history detail reads.');
  }
  const values = batchQueryValues(batchContext, sequence);
  const queryKeys = operation.request.queryKeys;
  if (!Array.isArray(queryKeys) || queryKeys.length !== REQUIRED_QUERY_KEYS.length
    || queryKeys.some((key, index) => key !== REQUIRED_QUERY_KEYS[index])) {
    throw new GeminiClientError('HISTORY_DETAIL_CONTRACT_INVALID', 'The hNvQHb query field order does not match the captured contract.');
  }
  const query = queryKeys.map((key) => [key, values[key]]);
  const bodyFields = operation.request.bodyFieldNames;
  if (!Array.isArray(bodyFields) || bodyFields.length !== 2
    || ![['at', 'f.req'], ['f.req', 'at']].some((expected) => expected.every((name, index) => bodyFields[index] === name))) {
    throw new GeminiClientError('HISTORY_DETAIL_CONTRACT_INVALID', 'The hNvQHb form field order does not match the captured contract.');
  }
  const fReq = JSON.stringify([[[GEMINI_HISTORY_DETAIL_RPC, JSON.stringify(args), null, 'generic']]]);
  const fields = { 'f.req': fReq, at: batchContext.at };
  const body = new URLSearchParams(bodyFields.map((name) => [name, fields[name]])).toString();
  return Object.freeze({
    requestSpec: Object.freeze({
      method: operation.request.method,
      path: operation.request.path,
      query: Object.freeze(query.map((entry) => Object.freeze(entry))),
      headers: Object.freeze({}),
      contentType: operation.request.contentType,
      body,
    }),
    binding: Object.freeze({
      bound: true,
      apiConversationIdLength: binding.apiConversationIdLength,
      visibleRouteIdLength: binding.visibleRouteIdLength,
      rawApiIdUsedInRequest: true,
      prefixRemovedFromRequest: false,
    }),
  });
}

function findHistoryDetailResponses(frames, selectorMode, expectedRpcId) {
  const matches = [];
  const pending = [];
  for (let index = frames.length - 1; index >= 0; index -= 1) pending.push(frames[index]);
  let visited = 0;
  while (pending.length && visited < MAX_JSON_NODES) {
    const value = pending.pop();
    visited += 1;
    if (Array.isArray(value)) {
      if (value.length >= 3 && value[0] === 'wrb.fr'
        && ((selectorMode === 'rpc_id' && value[1] === expectedRpcId)
          || (selectorMode === 'null' && value[1] === null))) {
        matches.push(decodeNestedJson(value[2]));
      }
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push(value[index]);
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return matches;
}

function exactValuePresent(value, expected, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (typeof value === 'string') return value === expected;
  if (Array.isArray(value)) return value.some((item) => exactValuePresent(item, expected, depth + 1, budget));
  if (isRecord(value)) return Object.values(value).some((item) => exactValuePresent(item, expected, depth + 1, budget));
  return false;
}

/** Decode only task-scoped detail metadata; message values remain in memory and are not returned. */
export function inspectHistoryDetailResponse(responseBody, operation, {
  expectedIntent,
  expectedApiConversationId,
  assetOrigins = [],
  capability = 'image',
} = {}) {
  if (!Buffer.isBuffer(responseBody) && !(responseBody instanceof Uint8Array)) {
    throw new GeminiClientError('HISTORY_DETAIL_RESPONSE_INVALID', 'The captured detail response must be bytes.');
  }
  const body = Buffer.from(responseBody);
  if (body.length > MAX_DETAIL_RESPONSE_BYTES) throw new GeminiClientError('HISTORY_DETAIL_RESPONSE_TOO_LARGE', 'The captured detail response exceeded its size limit.');
  const framing = operation?.response?.framing;
  const frameLengthUnit = operation?.response?.frameLengthUnit;
  const frameLengthOverheadUnits = operation?.response?.frameLengthOverheadUnits;
  const inspectMedia = ['image', 'video'].includes(capability);
  const emptyMediaSummary = Object.freeze({
    responseShape: Object.freeze([]), rpcIds: Object.freeze([]), nullSelectorResponseCount: 0,
    allowedAssetUrlCandidateCount: 0, blockedAssetUrlCandidateCount: 0,
    assetCandidates: Object.freeze([]), inlineMediaCandidates: Object.freeze([]),
    mediaMagicMatched: false, statusErrorFieldPaths: Object.freeze([]),
    namedTaskIdentifierFieldPaths: Object.freeze([]), expectedIntentMatched: false,
  });
  let frames;
  try { frames = parseBatchResponse(body, { lengthUnit: frameLengthUnit, frameLengthOverheadUnits }); }
  catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'HISTORY_DETAIL_RESPONSE_UNCLASSIFIED';
    return withInternal(Object.freeze({
      responseBytes: body.length,
      responseSha256: createHash('sha256').update(body).digest('hex'),
      framing: 'unclassified',
      parseErrorCode: code,
      frameCount: 0,
      rpcMatchCount: 0,
      responseShape: Object.freeze([]),
      taskIntentMatched: false,
      apiConversationIdMatched: false,
      mediaSummary: inspectMedia
        ? inspectGeminiMediaResponse(body, { capability, contentType: operation?.response?.contentType ?? 'application/json', assetOrigins })
        : emptyMediaSummary,
    }), { payload: null, media: Object.freeze({}) });
  }
  const selectorMode = operation?.response?.selectorMode;
  const expectedRpcId = operation?.response?.rpcId;
  if (!['rpc_id', 'null'].includes(selectorMode) || (selectorMode === 'rpc_id' && expectedRpcId !== GEMINI_HISTORY_DETAIL_RPC)) {
    throw new GeminiClientError('HISTORY_DETAIL_RESPONSE_CONTRACT_INVALID', 'The captured hNvQHb response selector mode is unavailable.');
  }
  const matches = findHistoryDetailResponses(frames, selectorMode, expectedRpcId);
  const exactOne = matches.length === 1;
  const payload = exactOne ? matches[0] : null;
  const media = inspectMedia
    ? decodeGeminiMediaResponse(body, {
      capability,
      contentType: operation.response.contentType,
      assetOrigins,
      expectedIntent,
    })
    : { summary: emptyMediaSummary, internal: Object.freeze({}) };
  const summary = Object.freeze({
    responseBytes: body.length,
    responseSha256: createHash('sha256').update(body).digest('hex'),
    framing: framing === 'batchexecute' ? 'utf16_length_frames' : 'captured_response_framing',
    frameCount: frames.length,
    rpcMatchCount: matches.length,
    rpcSelectorMode: selectorMode,
    responseShape: Object.freeze(matches.slice(0, 2).map((item) => typeShape(item))),
    taskIntentMatched: Boolean(expectedIntent && exactOne && exactValuePresent(payload, expectedIntent)),
    apiConversationIdMatched: Boolean(expectedApiConversationId && exactOne && exactValuePresent(payload, expectedApiConversationId)),
    mediaSummary: media.summary,
  });
  return withInternal(summary, {
      payload,
      media: media.internal,
  });
}
