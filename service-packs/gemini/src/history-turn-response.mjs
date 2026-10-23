import { createHash } from 'node:crypto';
import { GeminiClientError } from './errors.mjs';

/**
 * Source-bound hNvQHb turn paths observed from the current Gemini UI runtime.
 * These are JSON array paths, not protobuf field numbers. The mapping was
 * established by joining the exact prompt and value hashes from an hNvQHb
 * response to the live turn object and rendered `Ya.structuredContent` DOM.
 */
export const GEMINI_HNV_TURN_PATHS = Object.freeze({
  requestText: Object.freeze([2, 0, 0]),
  turnId: Object.freeze([0, 1]),
  draftId: Object.freeze([3, 0, 0, 0]),
  plainText: Object.freeze([3, 0, 0, 1, 0]),
  structuredContent: Object.freeze([3, 12]),
});

const MAX_NODES = 100_000;
const MAX_DEPTH = 32;
const MAX_STRING_BYTES = 2 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function valueAtPath(value, path) {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current) || !Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
    current = current[index];
  }
  return current;
}

function pathStartsWith(path, prefix) {
  return path.length >= prefix.length && prefix.every((part, index) => path[index] === part);
}

function scanPromptTurnPaths(payload, prompt) {
  const found = [];
  const pending = [{ value: payload, path: [], depth: 0 }];
  const seen = new WeakSet();
  let visited = 0;
  while (pending.length) {
    const { value, path, depth } = pending.pop();
    visited += 1;
    if (visited > MAX_NODES || depth > MAX_DEPTH) {
      throw new GeminiClientError('HISTORY_TURN_RESPONSE_TOO_COMPLEX', 'The history detail response exceeded the source-mapped turn scan limit.');
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      if (valueAtPath(value, GEMINI_HNV_TURN_PATHS.requestText) === prompt
          && typeof valueAtPath(value, GEMINI_HNV_TURN_PATHS.turnId) === 'string'
          && Array.isArray(value[3])) {
        found.push(path);
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const child = value[index];
        if (child && typeof child === 'object') pending.push({ value: child, path: [...path, index], depth: depth + 1 });
      }
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === 'object') pending.push({ value: child, path: [...path, key], depth: depth + 1 });
      }
    }
  }
  return found;
}

function summarizeString(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES
    ? Object.freeze({ present: true, utf8Bytes: Buffer.byteLength(value, 'utf8'), sha256: sha256(value) })
    : Object.freeze({ present: false, utf8Bytes: null, sha256: null });
}

function safeShape(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 4_000 || depth > 16) return 'limit';
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return Object.freeze({ type: 'array', length: value.length,
    items: Object.freeze(value.slice(0, 64).map((item) => safeShape(item, depth + 1, budget))) });
  if (value && typeof value === 'object') return Object.freeze({ type: 'object', fieldCount: Object.keys(value).length });
  return 'unsupported';
}

function resultWithInternal(summary, internal) {
  const result = { ...summary };
  Object.defineProperty(result, 'internal', { value: Object.freeze(internal), enumerable: false });
  return Object.freeze(result);
}

/**
 * Resolve one exact prompt to its hNvQHb turn and read the distinct source
 * fields `turnId`, `Ya.id` (draft ID), `Ya.vda`, and `Ya.structuredContent`.
 * Raw values are available only via the non-enumerable `internal` property.
 */
export function readGeminiHistoryTurnResponse(payload, { prompt } = {}) {
  if (!payload || typeof payload !== 'object' || typeof prompt !== 'string' || !prompt
      || Buffer.byteLength(prompt, 'utf8') > MAX_STRING_BYTES) {
    throw new GeminiClientError('HISTORY_TURN_RESPONSE_INPUT_INVALID', 'A bounded hNvQHb payload and exact task prompt are required.');
  }
  const matches = scanPromptTurnPaths(payload, prompt);
  if (matches.length !== 1) {
    return Object.freeze({
      matched: false,
      reason: matches.length ? 'task_turn_ambiguous' : 'task_turn_missing',
      exactPromptTurnCount: matches.length,
      source: 'hNvQHb_runtime_mapped_turn',
    });
  }

  const turnPath = matches[0];
  const turn = valueAtPath(payload, turnPath);
  const requestText = valueAtPath(turn, GEMINI_HNV_TURN_PATHS.requestText);
  const turnId = valueAtPath(turn, GEMINI_HNV_TURN_PATHS.turnId);
  const draftId = valueAtPath(turn, GEMINI_HNV_TURN_PATHS.draftId);
  const plainText = valueAtPath(turn, GEMINI_HNV_TURN_PATHS.plainText);
  const structuredContent = valueAtPath(turn, GEMINI_HNV_TURN_PATHS.structuredContent);
  const structuredText = readGeminiRawStructuredContentTextCandidates(structuredContent);
  const requestTextSummary = summarizeString(requestText);
  const turnIdSummary = summarizeString(turnId);
  const draftIdSummary = summarizeString(draftId);
  const plainTextSummary = summarizeString(plainText);
  const structuredContentPresent = structuredContent !== undefined && structuredContent !== null;

  return resultWithInternal({
    matched: true,
    reason: 'source_mapped_turn_matched',
    exactPromptTurnCount: 1,
    source: 'hNvQHb_runtime_mapped_turn',
    turnPath: Object.freeze([...turnPath]),
    requestText: requestTextSummary,
    turnId: turnIdSummary,
    draftId: draftIdSummary,
    plainTextCandidate: plainTextSummary,
    structuredContentPresent,
    structuredContentShape: structuredContentPresent ? safeShape(structuredContent) : null,
    structuredContentDecodeState: structuredContentPresent ? 'source_mapped_raw_subtree' : 'absent',
    structuredTextCandidateCount: structuredText.candidates?.length ?? 0,
    structuredUnclassifiedChildCount: structuredText.unclassifiedChildCount ?? null,
    structuredSourceShapeComplete: structuredText.sourceShapeComplete ?? false,
    rawTurnOrResponseIdentifiersPersisted: false,
  }, { turn, turnPath: Object.freeze([...turnPath]), requestText, turnId, draftId, plainText, structuredContent,
    structuredTextCandidates: structuredText.internal?.values ?? Object.freeze([]),
    structuredTextCandidateChildIndices: Object.freeze((structuredText.candidates ?? []).map((candidate) => candidate.childIndex)),
    structuredTextCandidatePaths: Object.freeze((structuredText.candidates ?? []).map((candidate) => candidate.path)) });
}

/** Compare the StreamGenerate metadata identifier with source-distinct hNv IDs. */
export function compareGeminiStreamResponseIdWithHistoryTurn(streamResponseId, historyTurn) {
  const turnId = historyTurn?.internal?.turnId;
  const draftId = historyTurn?.internal?.draftId;
  const validId = (value) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 512;
  const turnIdMatched = validId(streamResponseId) && validId(turnId) && streamResponseId === turnId;
  const draftIdMatched = validId(streamResponseId) && validId(draftId) && streamResponseId === draftId;
  const exactMatchKind = turnIdMatched && draftIdMatched ? 'exactly_matches_both_values'
    : turnIdMatched ? 'exactly_matches_turn_id_value' : draftIdMatched ? 'exactly_matches_draft_id_value'
      : validId(streamResponseId) ? 'no_exact_value_match' : 'comparison_unavailable';
  return Object.freeze({
    source: 'direct_stream_metadata_compared_with_hNvQHb',
    streamResponseIdAvailable: validId(streamResponseId),
    turnIdAvailable: validId(turnId),
    draftIdAvailable: validId(draftId),
    responseIdExactlyMatchedTurnId: turnIdMatched,
    responseIdExactlyMatchedDraftId: draftIdMatched,
    responseIdExactMatchKind: exactMatchKind,
    rawIdentifiersPersisted: false,
  });
}

/**
 * Read user-visible text from a source-decoded `Ya.structuredContent` object.
 * This adapter is intentionally for the first-party decoded object shape;
 * callers holding raw hNv arrays must first use the captured source decoder.
 */
export function readGeminiStructuredContentTextCandidates(structuredContent) {
  const children = structuredContent?.children;
  if (!Array.isArray(children)) return Object.freeze({ matched: false, reason: 'structured_children_unavailable', candidates: Object.freeze([]) });
  const candidates = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child || typeof child !== 'object' || Array.isArray(child) || typeof child.text !== 'string') continue;
    if (Buffer.byteLength(child.text, 'utf8') > MAX_STRING_BYTES) continue;
    candidates.push(Object.freeze({
      childIndex: index,
      utf8Bytes: Buffer.byteLength(child.text, 'utf8'),
      sha256: sha256(child.text),
      textNode: true,
    }));
  }
  return resultWithInternal({ matched: true, reason: 'source_decoded_structured_text_children',
    candidates: Object.freeze(candidates), rawTextPersisted: false }, {
    values: Object.freeze(children
      .map((child) => child && typeof child === 'object' && !Array.isArray(child) && typeof child.text === 'string' ? child.text : null)),
  });
}

function isObservedRichSourceMetadata(value) {
  if (!Array.isArray(value) || value.length !== 32 || value.slice(0, 31).some((item) => item !== null)) return false;
  const metadataList = value[31];
  if (!Array.isArray(metadataList) || metadataList.length !== 1) return false;
  const metadata = metadataList[0];
  if (!Array.isArray(metadata) || metadata.length !== 3) return false;
  const pair = metadata[0];
  const fileWrapper = metadata[1];
  const tail = metadata[2];
  if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'number'
      || !Array.isArray(tail) || tail.length !== 2 || typeof tail[0] !== 'string' || typeof tail[1] !== 'number'
      || !Array.isArray(fileWrapper) || fileWrapper.length !== 1) return false;
  const wrappedFile = fileWrapper[0];
  if (!Array.isArray(wrappedFile) || wrappedFile.length !== 2 || wrappedFile[0] !== null
      || !Array.isArray(wrappedFile[1]) || wrappedFile[1].length !== 7) return false;
  const file = wrappedFile[1][0];
  if (!Array.isArray(file) || file.length !== 12 || file[0] !== null || typeof file[1] !== 'number'
      || typeof file[2] !== 'string' || file[3] !== null || !Array.isArray(file[4]) || file[4].length !== 3
      || typeof file[4][0] !== 'number' || file[4][1] !== null || typeof file[4][2] !== 'string'
      || file[5] !== null || file[6] !== null || file[7] !== null || typeof file[8] !== 'number'
      || file[9] !== null || file[10] !== null || typeof file[11] !== 'string') return false;
  const fileTail = wrappedFile[1];
  return fileTail[1] === null && fileTail[2] === null && fileTail[3] === null
    && fileTail[4] === null && fileTail[5] === null && typeof fileTail[6] === 'string';
}

function readObservedRichTextStructuredContent(structuredContent, root) {
  const empty = (reason) => resultWithInternal({
      matched: true,
      reason,
      childrenCount: root.filter((item) => item !== null).length,
      codeChildCount: 0,
      textChildCount: 0,
      candidates: Object.freeze([]),
      unclassifiedChildCount: 1,
      sourceShapeComplete: false,
      rawTextPersisted: false,
    }, { values: Object.freeze([]), childIndices: Object.freeze([]), paths: Object.freeze([]) });
  if (root.slice(0, 13).some((item) => item !== null)) return empty('structured_content_rich_root_has_unknown_siblings');
  const variantList = root[13];
  if (!Array.isArray(variantList) || variantList.length !== 1 || !Array.isArray(variantList[0])
      || variantList[0].length !== 2) return empty('structured_content_rich_variant_unclassified');
  const [textNode, sourceMetadata] = variantList[0];
  if (!Array.isArray(textNode) || textNode.length !== 2 || textNode[0] !== null
      || !Array.isArray(textNode[1]) || textNode[1].length !== 3 || textNode[1][0] !== null
      || typeof textNode[1][1] !== 'number' || typeof textNode[1][2] !== 'string'
      || !isObservedRichSourceMetadata(sourceMetadata)) {
    return empty('structured_content_rich_text_or_source_shape_unclassified');
  }
  const text = textNode[1][2];
  if (Buffer.byteLength(text, 'utf8') > MAX_STRING_BYTES) return empty('structured_content_rich_text_exceeds_limit');
  const candidate = Object.freeze({
    childIndex: 13,
    path: Object.freeze([0, 0, 0, 13, 0, 0, 1, 2]),
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text),
    renderedTextNode: true,
    sourceShape: 'observed_nested_rich_text_with_source_metadata',
  });
  return resultWithInternal({
    matched: true,
    reason: 'source_observed_hnv_nested_rich_text_shape',
    childrenCount: 1,
    codeChildCount: 0,
    sourceMetadataBranchCount: 1,
    textChildCount: 1,
    candidates: Object.freeze([candidate]),
    unclassifiedChildCount: 0,
    sourceShapeComplete: true,
    rawTextPersisted: false,
  }, { values: Object.freeze([text]), childIndices: Object.freeze([13]),
    paths: Object.freeze([candidate.path]) });
}

/**
 * Decode the hNvQHb JSON representation of the source-rendered
 * `Ya.structuredContent.children` nodes. Runtime hash correlation proved the
 * wrapper path `[3][12][0][0]`, the code/language branch, and the text branch
 * `[3][12][0][0][n][1][2]`; this is an observed JSON layout, not a protobuf
 * field-number declaration. Unknown child shapes fail closed for answer proof.
 */
export function readGeminiRawStructuredContentTextCandidates(structuredContent) {
  const richRoot = valueAtPath(structuredContent, [0, 0, 0]);
  if (Array.isArray(richRoot) && richRoot.length === 14) {
    return readObservedRichTextStructuredContent(structuredContent, richRoot);
  }
  const children = Array.isArray(structuredContent) && structuredContent.length === 1
    && Array.isArray(structuredContent[0]) && structuredContent[0].length === 1
    && Array.isArray(structuredContent[0][0]) ? structuredContent[0][0] : null;
  if (!children) return Object.freeze({
    matched: false,
    reason: 'structured_content_source_shape_unavailable',
    candidates: Object.freeze([]),
    unclassifiedChildCount: null,
    sourceShapeComplete: false,
  });

  const candidates = [];
  const values = [];
  let unclassifiedChildCount = 0;
  let codeChildCount = 0;
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    const field39 = Array.isArray(child) && child.length === 1 && child[0]
      && typeof child[0] === 'object' && !Array.isArray(child[0])
      && Object.keys(child[0]).length === 1 ? child[0]['39'] : undefined;
    if (Array.isArray(field39) && field39.length === 5
        && typeof field39[0] === 'string' && typeof field39[1] === 'string'
        && typeof field39[2] === 'number' && field39[3] === null && typeof field39[4] === 'number') {
      codeChildCount += 1;
      continue;
    }
    const text = Array.isArray(child) && child.length === 2 && child[0] === null
      && Array.isArray(child[1]) && child[1].length === 3 && child[1][0] === null
      && typeof child[1][1] === 'number' && typeof child[1][2] === 'string'
      ? child[1][2] : null;
    if (text !== null && Buffer.byteLength(text, 'utf8') <= MAX_STRING_BYTES) {
      candidates.push(Object.freeze({
        childIndex,
      path: Object.freeze([0, 0, childIndex, 1, 2]),
        utf8Bytes: Buffer.byteLength(text, 'utf8'),
        sha256: sha256(text),
        renderedTextNode: true,
      }));
      values.push(text);
      continue;
    }
    unclassifiedChildCount += 1;
  }

  return resultWithInternal({
    matched: true,
    reason: 'source_observed_hnv_structured_content_shape',
    childrenCount: children.length,
    codeChildCount,
    textChildCount: candidates.length,
    candidates: Object.freeze(candidates),
    unclassifiedChildCount,
    sourceShapeComplete: unclassifiedChildCount === 0,
    rawTextPersisted: false,
  }, { values: Object.freeze(values), childIndices: Object.freeze(candidates.map((candidate) => candidate.childIndex)),
    paths: Object.freeze(candidates.map((candidate) => candidate.path)) });
}
