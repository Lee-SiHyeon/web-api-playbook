import { GeminiClientError } from './errors.mjs';
import { parseCapturedStreamGenerateResponse, parseRequestOnlyStreamGenerateResponse } from './batch-response.mjs';

const STREAM_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

export function parseCapturedTextResponse(contract, body) {
  const operation = contract?.operations?.text;
  if (!operation || operation.observation?.requestResponse !== true
      || operation.request?.method !== 'POST' || operation.request?.path !== STREAM_GENERATE_PATH
      || operation.response?.selector !== 'null') {
    throw new GeminiClientError('TEXT_RESPONSE_CONTRACT_REQUIRED', 'Text output requires the paired StreamGenerate null-selector response contract.');
  }
  const batch = parseCapturedStreamGenerateResponse(body, {
    operation,
    lengthUnit: operation.response.frameLengthUnit,
    frameLengthOverheadUnits: operation.response.frameLengthOverheadUnits,
  });
  return inspectStreamGenerateBatch(batch);
}

export function parseRequestOnlyTextResponse(contract, body, { contentType } = {}) {
  const operation = contract?.operations?.text;
  if (!operation || operation.observation?.request !== true || operation.observation?.requestResponse !== false
      || operation.request?.method !== 'POST' || operation.request?.path !== STREAM_GENERATE_PATH
      || operation.response !== undefined) {
    throw new GeminiClientError('TEXT_RESPONSE_CONTRACT_REQUIRED', 'Text response decoding requires a request-only captured StreamGenerate contract.');
  }
  const batch = parseRequestOnlyStreamGenerateResponse(body, {
    operation,
    contentType,
    lengthUnit: 'utf16_code_units',
    frameLengthOverheadUnits: 2,
  });
  return inspectStreamGenerateBatch(batch);
}

function candidateText(data) {
  if (!Array.isArray(data) || !Array.isArray(data[4])) return null;
  // Gemini's observed main candidate is the first candidate entry; its text is
  // at inner[4][0][1][0]. Later entries are alternate candidates or metadata.
  const candidate = data[4][0];
  const text = candidate?.[1]?.[0];
  return typeof text === 'string' && text.trim() ? text : null;
}

function responseIdentifiers(data) {
  const metadata = Array.isArray(data) ? data[1] : null;
  return Object.freeze({
    conversationId: typeof metadata?.[0] === 'string' && metadata[0] ? metadata[0] : null,
    responseId: typeof metadata?.[1] === 'string' && metadata[1] ? metadata[1] : null,
  });
}

function mergeProgressChunks(chunks) {
  let text = '';
  let mode = 'empty';
  for (const chunk of chunks) {
    if (!text) {
      text = chunk;
      mode = 'ordered_chunks';
    } else if (chunk === text || text.endsWith(chunk)) {
      mode = 'repeated_or_cumulative';
    } else if (chunk.startsWith(text)) {
      text = chunk;
      mode = 'cumulative_updates';
    } else if (text.startsWith(chunk)) {
      mode = 'cumulative_updates';
    } else {
      text += chunk;
      mode = 'ordered_chunks';
    }
  }
  return Object.freeze({ text, mode });
}

/** Select the ordered main-candidate output while requiring stable response IDs. */
export function inspectStreamGenerateBatch(batch) {
  const responses = Array.isArray(batch?.responses) ? batch.responses : [];
  const chunks = [];
  const conversationIds = new Set();
  const responseIds = new Set();
  let selectedData = null;
  let selectedFrameIndex = null;
  for (let frameIndex = 0; frameIndex < responses.length; frameIndex += 1) {
    const response = responses[frameIndex];
    const { conversationId, responseId } = responseIdentifiers(response?.data);
    if (conversationId) conversationIds.add(conversationId);
    if (responseId) responseIds.add(responseId);
    const text = candidateText(response?.data);
    if (text) {
      chunks.push(text);
      selectedData = response.data;
      selectedFrameIndex = frameIndex;
    }
  }
  const stableIds = conversationIds.size <= 1 && responseIds.size <= 1;
  const merged = mergeProgressChunks(chunks);
  const metadataBound = conversationIds.size === 1 && responseIds.size === 1;
  const matched = Boolean(merged.text) && stableIds && metadataBound;
  return Object.freeze({
    matched,
    ...(matched ? { text: merged.text } : {}),
    reason: !chunks.length ? 'main_text_missing'
      : !stableIds ? 'response_identifier_conflict'
        : !metadataBound ? 'response_identifier_missing' : 'main_candidate_matched',
    framing: 'utf16_length_frames',
    nullSelectorFrameCount: responses.length,
    mainCandidateChunkCount: chunks.length,
    chunkAssembly: merged.mode,
    selectedFrameIndex,
    conversationId: stableIds ? (conversationIds.values().next().value ?? null) : null,
    responseId: stableIds ? (responseIds.values().next().value ?? null) : null,
    data: selectedData,
  });
}

export function extractObservedMainText(data) {
  const text = candidateText(data);
  return text ? Object.freeze({ matched: true, text })
    : Object.freeze({ matched: false, reason: 'main_text_missing' });
}
