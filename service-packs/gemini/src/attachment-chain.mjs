import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { DEFAULT_CONTRACT_PATH, loadObservedContract } from './contract.mjs';
import { GeminiClientError } from './errors.mjs';
import { readAttachmentUploadEnvelopeFromStdin } from './session.mjs';
import { GeminiWebClient } from './client.mjs';
import { parseCapturedTextResponse, parseRequestOnlyTextResponse } from './text-response.mjs';
import { inspectCapturedAttachmentReferenceBySourcePlan } from './text-adapter.mjs';
import { findUnresolvedMutation, markMutationReconciled, mutationIntentDigest } from './journal.mjs';
import { compareGeminiStreamResponseIdWithHistoryTurn, readGeminiHistoryTurnResponse } from './history-turn-response.mjs';

const MAX_LINE_BYTES = 48 * 1024 * 1024;

function clearStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else clearStrings(value[index], seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else clearStrings(value[key], seen);
  }
}

function readLine(iterator) {
  return iterator.next().then(({ value, done }) => {
    if (done || typeof value !== 'string' || Buffer.byteLength(value) > MAX_LINE_BYTES) {
      throw new GeminiClientError('ATTACHMENT_CHAIN_PROTOCOL_INPUT_INVALID', 'A bounded attachment-chain protocol line is required.');
    }
    return value;
  });
}

function parseJsonLine(line, code) {
  let value;
  try { value = JSON.parse(line); }
  catch { throw new GeminiClientError(code, 'An attachment-chain protocol line is not valid JSON.'); }
  line = '';
  return value;
}

function decodeBase64(value, maxBytes, code) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) + 16) {
    throw new GeminiClientError(code, 'An attachment-chain binary field exceeded its installed size bound.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) {
    bytes.fill(0);
    throw new GeminiClientError(code, 'An attachment-chain binary field is not bounded canonical base64.');
  }
  return bytes;
}

function parseContinuationEvent(line, maxFileBytes) {
  const raw = parseJsonLine(line, 'ATTACHMENT_CHAIN_CONTINUATION_INVALID');
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.event === 'continuation-not-captured'
      && Object.keys(raw).length === 1) {
    clearStrings(raw);
    throw new GeminiClientError('ATTACHMENT_CHAIN_NATIVE_CONTINUATION_NOT_CAPTURED',
      'The native continuation was not captured; the server-issued session is queried before the client releases it.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.event !== 'continuation-capture'
      || Object.keys(raw).some((key) => !['event', 'capture', 'uploadCookies'].includes(key))
      || !raw.capture || typeof raw.capture !== 'object' || Array.isArray(raw.capture)
      || !Array.isArray(raw.uploadCookies) || raw.uploadCookies.length < 1 || raw.uploadCookies.length > 64
      || raw.uploadCookies.some((cookie) => !cookie || typeof cookie !== 'object' || Array.isArray(cookie)
        || Object.keys(cookie).some((key) => !['name', 'value', 'domain', 'path', 'secure', 'expires'].includes(key))
        || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
        || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string' || typeof cookie.secure !== 'boolean'
        || (cookie.expires !== undefined && typeof cookie.expires !== 'number'))) {
    clearStrings(raw);
    throw new GeminiClientError('ATTACHMENT_CHAIN_CONTINUATION_INVALID', 'A native upload continuation capture is required.');
  }
  const input = raw.capture;
  const allowed = new Set(['url', 'method', 'headerNames', 'headers', 'bodyBase64']);
  if (Object.keys(input).some((key) => !allowed.has(key)) || typeof input.url !== 'string'
      || input.url.length > 8192 || input.method !== 'POST' || !Array.isArray(input.headerNames)
      || input.headerNames.length < 2 || input.headerNames.length > 96
      || input.headerNames.some((name) => typeof name !== 'string' || name.length > 128)
      || !input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)
      || Object.keys(input.headers).length > 96
      || Object.entries(input.headers).some(([name, value]) => typeof name !== 'string' || typeof value !== 'string'
        || name.length > 128 || value.length > 8192 || /[\r\n\0]/.test(value))) {
    clearStrings(raw);
    throw new GeminiClientError('ATTACHMENT_CHAIN_CONTINUATION_INVALID', 'The native upload continuation envelope is malformed.');
  }
  let body;
  try { body = decodeBase64(input.bodyBase64, maxFileBytes, 'ATTACHMENT_CHAIN_CONTINUATION_INVALID'); }
  catch (error) { clearStrings(raw); throw error; }
  const capture = { url: input.url, method: input.method, headerNames: [...input.headerNames],
    headers: { ...input.headers }, body };
  const uploadCookies = raw.uploadCookies.map((cookie) => ({ ...cookie }));
  clearStrings(raw);
  return { capture, uploadCookies };
}

function parseAttachmentMessageEvent(line) {
  const raw = parseJsonLine(line, 'ATTACHMENT_CHAIN_MESSAGE_CAPTURE_INVALID');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.event !== 'attachment-message'
      || Object.keys(raw).some((key) => !['event', 'capture'].includes(key))
      || !raw.capture || typeof raw.capture !== 'object' || Array.isArray(raw.capture)) {
    clearStrings(raw);
    throw new GeminiClientError('ATTACHMENT_CHAIN_MESSAGE_CAPTURE_INVALID', 'A captured Gemini attachment-message request is required.');
  }
  const input = raw.capture;
  const allowed = new Set(['url', 'method', 'bodyBase64', 'headers']);
  if (Object.keys(input).some((key) => !allowed.has(key)) || typeof input.url !== 'string'
      || input.url.length > 8192 || input.method !== 'POST' || !input.headers
      || typeof input.headers !== 'object' || Array.isArray(input.headers)
      || Object.keys(input.headers).length > 32
      || Object.entries(input.headers).some(([name, value]) => typeof name !== 'string' || typeof value !== 'string'
        || name.length > 128 || value.length > 8192 || /[\r\n\0]/.test(value))) {
    clearStrings(raw);
    throw new GeminiClientError('ATTACHMENT_CHAIN_MESSAGE_CAPTURE_INVALID', 'The captured Gemini text request is malformed.');
  }
  let body;
  try { body = decodeBase64(input.bodyBase64, 2 * 1024 * 1024, 'ATTACHMENT_CHAIN_MESSAGE_CAPTURE_INVALID'); }
  catch (error) { clearStrings(raw); throw error; }
  const capture = {
    url: input.url,
    method: input.method,
    body: body.toString('utf8'),
    headers: Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value])),
  };
  body.fill(0);
  clearStrings(raw);
  return capture;
}

function historyItems(data) {
  return Array.isArray(data?.[2]) ? data[2] : [];
}

function expectedTextVariants(value, expected) {
  const matches = [];
  if (value === expected) matches.push('raw');
  if (value.trim() === expected) matches.push('trim');
  const trimmed = value.trim();
  let match = /^```(?:text|txt)?\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (match && match[1] === expected) matches.push('anchored_fence');
  match = /^"([\s\S]*)"$/.exec(trimmed);
  if (match && match[1] === expected) matches.push('anchored_double_quote');
  match = /^'([\s\S]*)'$/.exec(trimmed);
  if (match && match[1] === expected) matches.push('anchored_single_quote');
  return matches;
}

/** Keep the decoded candidate text in memory; persist only length, hash, and exact normalization labels. */
export function summarizeAttachmentReplyText(value, expectedFileText) {
  if (typeof value !== 'string' || typeof expectedFileText !== 'string' || !expectedFileText) {
    return Object.freeze({ decodedTextPresent: false, rawExactMatch: false, normalizedMatch: false,
      rawUtf8Bytes: null, rawCharLength: null, rawSha256: null, normalizedMatchVariants: Object.freeze([]) });
  }
  const normalizedMatchVariants = expectedTextVariants(value, expectedFileText);
  return Object.freeze({
    decodedTextPresent: true,
    rawExactMatch: value === expectedFileText,
    normalizedMatch: normalizedMatchVariants.length > 0,
    rawUtf8Bytes: Buffer.byteLength(value, 'utf8'),
    rawCharLength: value.length,
    rawSha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    normalizedMatchVariants: Object.freeze(normalizedMatchVariants),
  });
}

function safeReadbackPath(path) {
  return path.map((part) => typeof part === 'number' ? part
    : /^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/.test(part) ? part : '{field}');
}

/** Bind one exact hNvQHb task turn to source-mapped rendered text and separate IDs. */
export function inspectAttachmentTaskAssistantReply(payload, {
  prompt, expectedFileText, responseId,
} = {}) {
  if (!payload || typeof payload !== 'object' || typeof prompt !== 'string' || !prompt
      || typeof expectedFileText !== 'string' || !expectedFileText) {
    throw new GeminiClientError('ATTACHMENT_CHAIN_READBACK_INPUT_INVALID', 'A task detail payload, prompt, and expected file text are required.');
  }
  const turn = readGeminiHistoryTurnResponse(payload, { prompt });
  if (!turn.matched) {
    return Object.freeze({
      source: turn.source ?? 'hNvQHb_runtime_mapped_turn',
      promptPathCount: turn.exactPromptTurnCount ?? 0,
      taskTurnMatchCount: turn.exactPromptTurnCount ?? 0,
      assistantNodePresent: false,
      assistantPath: null,
      assistantStringCount: 0,
      exactAnswerPathCount: 0,
      exactAnswerMatched: false,
      normalizedAnswerPaths: Object.freeze([]),
      structuredContentPresent: false,
      structuredSourceShapeComplete: false,
      responseIdExactlyMatchedTurnId: false,
      responseIdExactlyMatchedDraftId: false,
      responseIdExactMatchKind: turn.reason,
    });
  }

  const turnPath = turn.internal.turnPath;
  const structuredPresent = turn.structuredContentPresent;
  const structuredComplete = turn.structuredSourceShapeComplete === true;
  const structuredValues = turn.internal.structuredTextCandidates;
  const candidateValues = structuredPresent ? structuredValues
    : (typeof turn.internal.plainText === 'string' ? [turn.internal.plainText] : []);
  const assistantPath = structuredPresent ? [...turnPath, 3, 12] : [...turnPath, 3, 0, 0, 1, 0];
  const exactAnswerPaths = [];
  const normalizedAnswerPaths = [];
  candidateValues.forEach((value, index) => {
    const variants = expectedTextVariants(value, expectedFileText);
    const structuredChildIndex = turn.internal.structuredTextCandidateChildIndices?.[index];
    const structuredTextPath = turn.internal.structuredTextCandidatePaths?.[index];
    const path = structuredPresent
      ? [...turnPath, 3, 12, ...(Array.isArray(structuredTextPath)
        ? structuredTextPath : [0, 0, structuredChildIndex, 1, 2])]
      : [...turnPath, 3, 0, 0, 1, 0];
    if (variants.includes('raw')) exactAnswerPaths.push(safeReadbackPath(path));
    else if (variants.length) normalizedAnswerPaths.push({ path: safeReadbackPath(path), variants, candidateIndex: index });
  });
  const idBinding = compareGeminiStreamResponseIdWithHistoryTurn(responseId, turn);
  const exactAnswerPathCount = exactAnswerPaths.length;
  const exactAnswerMatched = structuredPresent
    ? structuredComplete && exactAnswerPathCount === 1
    : exactAnswerPathCount === 1;
  const textCandidateCount = candidateValues.length;
  const assistantPathSafe = safeReadbackPath(assistantPath);
  return Object.freeze({
    source: 'hNvQHb_runtime_mapped_turn',
    promptPathCount: 1,
    taskTurnMatchCount: 1,
    assistantNodePresent: structuredPresent || candidateValues.length > 0,
    assistantPath: assistantPathSafe,
    assistantStringCount: textCandidateCount,
    exactAnswerPathCount,
    exactAnswerMatched,
    exactAnswerPaths: Object.freeze(exactAnswerPaths),
    normalizedAnswerPaths: Object.freeze(normalizedAnswerPaths),
    structuredContentPresent: structuredPresent,
    structuredTextCandidateCount: turn.structuredTextCandidateCount,
    structuredUnclassifiedChildCount: turn.structuredUnclassifiedChildCount,
    structuredSourceShapeComplete: structuredComplete,
    plainTextCandidatePresent: turn.plainTextCandidate.present,
    responseIdExactlyMatchedTurnId: idBinding.responseIdExactlyMatchedTurnId,
    responseIdExactlyMatchedDraftId: idBinding.responseIdExactlyMatchedDraftId,
    responseIdExactMatchKind: idBinding.responseIdExactMatchKind,
    turnIdPresent: idBinding.turnIdAvailable,
    draftIdPresent: idBinding.draftIdAvailable,
    rawIdentifiersOrContentPersisted: false,
  });
}

function safeResponseParse(contract, response) {
  try {
    return contract.operations.text.observation.requestResponse === true
      ? parseCapturedTextResponse(contract, response.body)
      : parseRequestOnlyTextResponse(contract, response.body, { contentType: response.contentType });
  } catch (error) {
    return { matched: false, parseErrorCode: error instanceof GeminiClientError ? error.code : 'TEXT_RESPONSE_UNCLASSIFIED' };
  }
}

function emit(output, value) {
  output.write(JSON.stringify(value) + '\n');
}

function safeAttachmentBindingDetails(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const output = {};
  const counts = ['sourceShapeMatchCount', 'responsePayloadMatchCount', 'filenameMatchCount', 'mimeTypeMatchCount',
    'fileSizeMatchCount', 'uploadedFilesArrayCount', 'candidateCount', 'sourceTupleMatchCount', 'sourceProtoTupleMatchCount',
    'sourceParentValueMatchCount',
    'expectedFileSizeBytes', 'capturedRequestBodyBytes', 'expectedFilenameBytes', 'expectedResponsePayloadBytes'];
  for (const key of counts) if (Number.isInteger(input[key]) && input[key] >= 0) output[key] = input[key];
  for (const key of ['fileIdPresent', 'expectedFileTypePresent', 'sourceValueCorrelationMatch',
    'capturedPromptContainsReferenceValue']) {
    if (typeof input[key] === 'boolean') output[key] = input[key];
  }
  for (const key of ['capturedRequestBodySha256', 'expectedFilenameSha256', 'expectedResponsePayloadSha256']) {
    if (typeof input[key] === 'string' && /^[a-f0-9]{64}$/i.test(input[key])) output[key] = input[key].toLowerCase();
  }
  for (const key of ['expectedMimeType']) {
    if (typeof input[key] === 'string') {
      const value = input[key].split(';', 1)[0].trim().toLowerCase();
      if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)) output[key] = value;
    }
  }
  if (Number.isSafeInteger(input.expectedFileType) && input.expectedFileType >= 0) output.expectedFileType = input.expectedFileType;
  const allowedFields = new Set(['filename', 'name', 'mimeType', 'mime_type', 'dh', 'fileType', 'file_type',
    'gN', 'xl', 'yj', 'QG', 'fileId', 'file_id', 'uploadedFiles', 'uri', 'url']);
  if (Array.isArray(input.candidates)) {
    output.candidates = input.candidates.slice(0, 32).filter((candidate) => candidate && typeof candidate === 'object'
      && !Array.isArray(candidate)).map((candidate) => {
      const item = {};
      if (candidate.kind === 'object' || candidate.kind === 'array') item.kind = candidate.kind;
      if (Array.isArray(candidate.fieldNames) && candidate.fieldNames.every((name) => allowedFields.has(name))) {
        item.fieldNames = [...candidate.fieldNames];
      }
      if (Array.isArray(candidate.elementTypes) && candidate.elementTypes.every((type) =>
        ['string', 'number', 'boolean', 'object', 'array', 'null'].includes(type))) {
        item.elementTypes = [...candidate.elementTypes];
      }
      for (const key of ['length', 'filenameBytes', 'dhBytes', 'fileIdLength']) {
        if (Number.isSafeInteger(candidate[key]) && candidate[key] >= 0) item[key] = candidate[key];
      }
      for (const key of ['filenameMatched', 'mimeTypeMatched', 'dhMatched', 'fileIdPresent', 'gNPresent', 'xlPresent',
        'yjPresent', 'QGPresent', 'uploadedFilesPresent', 'uriPresent', 'urlPresent']) {
        if (typeof candidate[key] === 'boolean') item[key] = candidate[key];
      }
      if (Number.isSafeInteger(candidate.fileType) && candidate.fileType >= 0) item.fileType = candidate.fileType;
      if (typeof candidate.mimeType === 'string') {
        const value = candidate.mimeType.split(';', 1)[0].trim().toLowerCase();
        if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)) item.mimeType = value;
      }
      if (typeof candidate.dhSha256 === 'string' && /^[a-f0-9]{64}$/i.test(candidate.dhSha256)) {
        item.dhSha256 = candidate.dhSha256.toLowerCase();
      }
      if (typeof candidate.filenameSha256 === 'string' && /^[a-f0-9]{64}$/i.test(candidate.filenameSha256)) {
        item.filenameSha256 = candidate.filenameSha256.toLowerCase();
      }
      return item;
    });
  }
  if (Array.isArray(input.sourceProtoCandidates)) {
    output.sourceProtoCandidates = input.sourceProtoCandidates.slice(0, 32)
      .filter((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate))
      .map((candidate) => {
        const item = {};
        for (const key of ['vePath', 'dqcPath']) {
          if (Array.isArray(candidate[key]) && candidate[key].length <= 32
              && candidate[key].every((part) => (Number.isSafeInteger(part) && part >= 0) || part === 'object')) {
            item[key] = [...candidate[key]];
          }
        }
        for (const key of ['veLength', 'tupleLength', 'filenameBytes', 'dhBytes', 'sizeBytes',
          'dhArrayIndex', 'sizeArrayIndex', 'contextArrayIndex', 'mimeArrayIndex']) {
          if (Number.isSafeInteger(candidate[key]) && candidate[key] >= 0) item[key] = candidate[key];
        }
        for (const key of ['filenameSha256', 'dhSha256']) {
          if (typeof candidate[key] === 'string' && /^[a-f0-9]{64}$/i.test(candidate[key])) {
            item[key] = candidate[key].toLowerCase();
          }
        }
        for (const key of ['filenameMatched', 'dhMatched', 'sizeMatched', 'mimeTypeMatched', 'sourceParentValueMatch',
          'contextValueIsNumber', 'contextEqualsFileSize', 'matched']) {
          if (typeof candidate[key] === 'boolean' || candidate[key] === null) item[key] = candidate[key];
        }
        if (['observed_dqc_dh_context_null_mime', 'unclassified_nested_array', 've_parent_values_only']
          .includes(candidate.tupleLayout)) item.tupleLayout = candidate.tupleLayout;
        if (Array.isArray(candidate.tupleElementTypes) && candidate.tupleElementTypes.every((type) =>
          ['string', 'number', 'boolean', 'object', 'array', 'null'].includes(type))) {
          item.tupleElementTypes = [...candidate.tupleElementTypes];
        }
        if (typeof candidate.mimeType === 'string') {
          const value = candidate.mimeType.split(';', 1)[0].trim().toLowerCase();
          if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)) item.mimeType = value;
        }
        return item;
      });
  }
  if (Array.isArray(input.uploadedFilesTupleCandidates)) {
    output.uploadedFilesTupleCandidates = input.uploadedFilesTupleCandidates.slice(0, 32)
      .filter((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate))
      .map((candidate) => {
        const item = {};
        for (const key of ['index', 'responsePayloadMatchCount', 'filenameMatchCount', 'mimeTypeMatchCount',
          'sourceShapeMatchCount']) {
          if (Number.isSafeInteger(candidate[key]) && candidate[key] >= 0) item[key] = candidate[key];
        }
        if (Array.isArray(candidate.fieldShapes)) {
          item.fieldShapes = candidate.fieldShapes.slice(0, 8).filter((shape) => shape && typeof shape === 'object'
            && !Array.isArray(shape)).map((shape) => {
            const safeShape = {};
            if (shape.kind === 'object' || shape.kind === 'array') safeShape.kind = shape.kind;
            if (Array.isArray(shape.fieldNames) && shape.fieldNames.every((name) => allowedFields.has(name))) {
              safeShape.fieldNames = [...shape.fieldNames];
            }
            if (Array.isArray(shape.elementTypes) && shape.elementTypes.every((type) =>
              ['string', 'number', 'boolean', 'object', 'array', 'null'].includes(type))) {
              safeShape.elementTypes = [...shape.elementTypes];
            }
            for (const key of ['length', 'filenameBytes', 'dhBytes', 'fileIdLength']) {
              if (Number.isSafeInteger(shape[key]) && shape[key] >= 0) safeShape[key] = shape[key];
            }
            for (const key of ['filenameMatched', 'mimeTypeMatched', 'dhMatched', 'fileIdPresent', 'gNPresent',
              'xlPresent', 'yjPresent', 'QGPresent', 'uploadedFilesPresent', 'uriPresent', 'urlPresent']) {
              if (typeof shape[key] === 'boolean') safeShape[key] = shape[key];
            }
            if (Number.isSafeInteger(shape.fileType) && shape.fileType >= 0) safeShape.fileType = shape.fileType;
            if (typeof shape.mimeType === 'string') {
              const value = shape.mimeType.split(';', 1)[0].trim().toLowerCase();
              if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)) safeShape.mimeType = value;
            }
            for (const key of ['dhSha256', 'filenameSha256']) {
              if (typeof shape[key] === 'string' && /^[a-f0-9]{64}$/i.test(shape[key])) {
                safeShape[key] = shape[key].toLowerCase();
              }
            }
            return safeShape;
          });
        }
        return item;
      });
  }
  return Object.freeze(output);
}

export async function requestAttachmentMessageRecapture(iterator, output, { attempt = 1, attachmentBinding } = {}) {
  if (!iterator || typeof iterator.next !== 'function' || !output || typeof output.write !== 'function'
      || attempt !== 1) {
    throw new GeminiClientError('ATTACHMENT_CHAIN_RECOVERY_OPTIONS_INVALID', 'One bounded attachment-message recapture is required.');
  }
  emit(output, { event: 'attachment-binding-recapture-needed', attempt,
    attachmentBinding: safeAttachmentBindingDetails(attachmentBinding) });
  let line = await readLine(iterator);
  try {
    const control = parseJsonLine(line, 'ATTACHMENT_CHAIN_RECOVERY_EVENT_INVALID');
    if (control && control.event === 'attachment-recovery-abandon'
        && Object.keys(control).length === 1) {
      clearStrings(control);
      line = '';
      return null;
    }
    if (control && control.event === 'attachment-binding-resolution'
        && Object.keys(control).length === 2 && control.plan && typeof control.plan === 'object'
        && !Array.isArray(control.plan)) {
      const plan = control.plan;
      if (Object.keys(plan).some((key) => !['vePath', 'dqcPath', 'tupleLayout'].includes(key))) {
        clearStrings(control);
        throw new GeminiClientError('ATTACHMENT_CHAIN_RECOVERY_EVENT_INVALID', 'A source-binding plan contains unsupported fields.');
      }
      const result = Object.freeze({ kind: 'binding-resolution', plan: Object.freeze({
        vePath: Array.isArray(plan.vePath) ? [...plan.vePath] : plan.vePath,
        dqcPath: Array.isArray(plan.dqcPath) ? [...plan.dqcPath] : plan.dqcPath,
        tupleLayout: plan.tupleLayout,
      }) });
      clearStrings(control);
      line = '';
      return result;
    }
    if (!control || control.event !== 'attachment-message' || Object.keys(control).some((key) => key !== 'event' && key !== 'capture')) {
      clearStrings(control);
      throw new GeminiClientError('ATTACHMENT_CHAIN_RECOVERY_EVENT_INVALID', 'A fresh captured SDK attachment-message request is required.');
    }
    clearStrings(control);
    return Object.freeze({ kind: 'message-recapture', capture: parseAttachmentMessageEvent(line) });
  } finally {
    line = '';
  }
}

export async function sendTextWithOneAttachmentMessageRecapture({
  client, capture, prompt, attachmentRef, textOptions, iterator, output, onRecaptured = () => {},
} = {}) {
  if (!client || typeof client.generateTextWithAttachmentOnce !== 'function'
      || !capture || typeof capture !== 'object' || !attachmentRef || typeof attachmentRef !== 'object'
      || !textOptions || typeof textOptions !== 'object' || typeof onRecaptured !== 'function') {
    throw new GeminiClientError('ATTACHMENT_CHAIN_RECOVERY_OPTIONS_INVALID', 'The same client, upload reference, captured request, and text intent are required for recovery.');
  }
  try {
    return Object.freeze({
      result: await client.generateTextWithAttachmentOnce(capture, prompt, attachmentRef, textOptions),
      capture,
      recaptureCount: 0,
      bindingResolutionCount: 0,
      firstBindingDiagnostics: null,
    });
  } catch (error) {
    if (error?.code !== 'TEXT_ATTACHMENT_CAPTURE_MISMATCH') throw error;
    const firstBindingDiagnostics = safeProtocolErrorDetails(error.details).attachmentBinding ?? Object.freeze({});
    const recaptured = await requestAttachmentMessageRecapture(iterator, output, {
      attempt: 1, attachmentBinding: firstBindingDiagnostics,
    });
    if (!recaptured) throw error;
    if (recaptured.kind === 'binding-resolution') {
      const attachmentBinding = inspectCapturedAttachmentReferenceBySourcePlan(capture, attachmentRef, recaptured.plan);
      const result = await client.generateTextOnce(capture, prompt, textOptions);
      return Object.freeze({
        result: Object.freeze({ ...result, attachmentBinding }),
        capture,
        recaptureCount: 0,
        bindingResolutionCount: 1,
        firstBindingDiagnostics,
      });
    }
    if (recaptured.kind !== 'message-recapture' || !recaptured.capture) {
      throw new GeminiClientError('ATTACHMENT_CHAIN_RECOVERY_EVENT_INVALID', 'A source-bound message recovery event is required.');
    }
    onRecaptured(recaptured.capture);
    if (typeof capture.body === 'string') capture.body = '';
    for (const name of Object.keys(capture.headers ?? {})) capture.headers[name] = '';
    try {
      return Object.freeze({
        result: await client.generateTextWithAttachmentOnce(recaptured.capture, prompt, attachmentRef, textOptions),
        capture: recaptured.capture,
        recaptureCount: 1,
        bindingResolutionCount: 0,
        firstBindingDiagnostics,
      });
    } catch (secondError) {
      if (secondError?.code === 'TEXT_ATTACHMENT_CAPTURE_MISMATCH') {
        try { Object.defineProperty(secondError, 'attachmentMessageCapture', { value: recaptured.capture, enumerable: false }); }
        catch { /* Preserve the original binding error if the error object is immutable. */ }
      }
      throw secondError;
    }
  }
}

export function attachInternalAttachmentRecovery(output, attachmentRef, capturedRequest, client = null) {
  if (!output || typeof output !== 'object' || Array.isArray(output)
      || !attachmentRef || typeof attachmentRef !== 'object'
      || !capturedRequest || typeof capturedRequest !== 'object'
      || (client !== null && typeof client !== 'object')) {
    throw new GeminiClientError('ATTACHMENT_CHAIN_RECOVERY_INVALID', 'An attachment reference and captured request are required for in-process recovery.');
  }
  const release = () => {
    if (client?.transport) client.transport.session = null;
    if (client) client.verifiedOwner = null;
    if (typeof capturedRequest.body === 'string') capturedRequest.body = '';
    for (const name of Object.keys(capturedRequest.headers ?? {})) capturedRequest.headers[name] = '';
  };
  Object.defineProperty(output, 'internal', {
    value: Object.freeze({ attachmentRef, capturedRequest, client, release }),
    enumerable: false,
  });
  return Object.freeze(output);
}

export function assertPromptDoesNotContainFileContent(prompt, fileBody) {
  if (typeof prompt !== 'string' || !Buffer.isBuffer(fileBody) || fileBody.length === 0) {
    throw new GeminiClientError('ATTACHMENT_CHAIN_FILE_CONTENT_INVALID', 'A non-empty text prompt and bounded file body are required.');
  }
  const decoded = fileBody.toString('utf8');
  if (decoded && Buffer.from(decoded, 'utf8').equals(fileBody) && prompt.includes(decoded)) {
    throw new GeminiClientError('ATTACHMENT_CHAIN_PROMPT_CONTAINS_FILE_CONTENT', 'The task prompt must not contain the expected file answer.');
  }
  return true;
}

export function requireAttachmentUploadQueryReadback(query, expectedFileBytes) {
  if (!query || typeof query !== 'object' || !Number.isSafeInteger(expectedFileBytes)
      || expectedFileBytes < 1 || query.httpStatus !== 200 || query.uploadStatus !== 'final'
      || query.sizeReceived !== expectedFileBytes) {
    throw new GeminiClientError('ATTACHMENT_CHAIN_UPLOAD_QUERY_READBACK_REQUIRED', 'A final same-session upload query with the exact file size is required.');
  }
  return true;
}

export function safeProtocolErrorDetails(input) {
  if (!input || typeof input !== 'object') return Object.freeze({});
  const output = {};
  for (const key of ['directDispatchCount', 'startDispatchCount', 'transferDispatchCount', 'httpRequestCount', 'httpStatus']) {
    if (Number.isInteger(input[key])) output[key] = input[key];
  }
  if (typeof input.stage === 'string' && /^[a-z_]{1,40}$/.test(input.stage)) output.stage = input.stage;
  if (typeof input.internalErrorCode === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(input.internalErrorCode)) {
    output.internalErrorCode = input.internalErrorCode;
  }
  if (typeof input.internalErrorClass === 'string' && /^[A-Za-z]+Error$/.test(input.internalErrorClass)) {
    output.internalErrorClass = input.internalErrorClass;
  }
  const attachmentBinding = safeAttachmentBindingDetails(input.attachmentBinding);
  if (attachmentBinding) output.attachmentBinding = attachmentBinding;
  for (const key of ['selectedFileMimeType', 'nativeTransferMimeType', 'expectedTransferMimeType']) {
    if (typeof input[key] !== 'string') continue;
    const normalized = input[key].split(';', 1)[0].trim().toLowerCase();
    if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized)) output[key] = normalized;
  }
  if (input.fileMimeHeaderName === 'content-type') output.fileMimeHeaderName = input.fileMimeHeaderName;
  if (input.sourceEffectiveHeaderName === 'content-type') output.sourceEffectiveHeaderName = input.sourceEffectiveHeaderName;
  if (input.sourceEffectiveHeaderValueSource === 'xhr_transport_default_content_type') {
    output.sourceEffectiveHeaderValueSource = input.sourceEffectiveHeaderValueSource;
  }
  if (input.queryReadback && typeof input.queryReadback === 'object') {
    output.queryReadback = {
      httpStatus: Number.isInteger(input.queryReadback.httpStatus) ? input.queryReadback.httpStatus : null,
      uploadStatus: typeof input.queryReadback.uploadStatus === 'string' ? input.queryReadback.uploadStatus : null,
      sizeReceived: Number.isInteger(input.queryReadback.sizeReceived) ? input.queryReadback.sizeReceived : null,
    };
  }
  const cookieKeys = ['expectedCookieNames', 'actualCookieNames', 'missingCookieNames', 'unexpectedCookieNames', 'valueMismatchCookieNames'];
  for (const key of cookieKeys) {
    if (Array.isArray(input[key]) && input[key].every((name) => typeof name === 'string' && /^[A-Za-z0-9_.$-]{1,128}$/.test(name))) {
      output[key] = [...input[key]];
    }
  }
  for (const key of ['nativeHeaderNames', 'installedHeaderNames', 'continuationHeaderValueMismatchNames',
    'requiredHeaderValueMismatchNames', 'unknownHeaderValueMismatchNames', 'optionalBrowserHeaderVariationNames',
    'sourceRequiredHeaderNames', 'sourceEffectiveHeaderValueMismatchNames', 'sourceEffectiveHeaderNames',
    'fileMimeHeaderMismatchNames', 'fileMimeHeaderNames', 'optionalBrowserHeaderNames']) {
    if (Array.isArray(input[key]) && input[key].every((name) => typeof name === 'string' && /^[a-z0-9-]{1,128}$/.test(name))) {
      output[key] = [...input[key]];
    }
  }
  for (const key of ['expectedCookieCount', 'actualCookieCount']) {
    if (Number.isInteger(input[key])) output[key] = input[key];
  }
  for (const key of ['expectedCookieScopes', 'currentCookieScopes']) {
    if (Array.isArray(input[key]) && input[key].every((scope) => scope && typeof scope === 'object'
        && typeof scope.name === 'string' && typeof scope.domain === 'string'
        && typeof scope.path === 'string' && typeof scope.secure === 'boolean')) {
      output[key] = input[key].map(({ name, domain, path, secure }) => ({ name, domain, path, secure }));
    }
  }
  for (const key of ['headerNamesMatched', 'urlMatched', 'methodMatched', 'bodyMatched']) {
    if (typeof input[key] === 'boolean') output[key] = input[key];
  }
  return Object.freeze(output);
}

function protocolError(error) {
  return new GeminiClientError(error?.code && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code : 'ATTACHMENT_CHAIN_FAILED', 'The Gemini attachment chain did not reach a verified terminal state.',
  safeProtocolErrorDetails(error?.details));
}

/** One confirmed upload followed by one captured SDK attachment message and direct text readback. */
export async function runAttachmentChainOnce(options, {
  input = stdin,
  output = stdout,
  contract = null,
  journalRoot,
} = {}) {
  if (!options || options.confirmed !== true || typeof options.expectedOwner !== 'string'
      || typeof options.uploadCallerIntent !== 'string' || typeof options.messageCallerIntent !== 'string'
      || typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 8000
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.uploadCallerIntent)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.messageCallerIntent)
      || options.uploadCallerIntent === options.messageCallerIntent || input.isTTY === true
      || !output || typeof output.write !== 'function') {
    throw new GeminiClientError('ATTACHMENT_CHAIN_OPTIONS_INVALID', 'Confirmed separate upload and message intents, a bounded prompt, and a piped protocol are required.');
  }
  const installedContract = contract ?? await loadObservedContract(options.contractPath ?? DEFAULT_CONTRACT_PATH);
  if (!installedContract.operations?.text || !installedContract.attachmentUpload) {
    throw new GeminiClientError('ATTACHMENT_CHAIN_CONTRACT_REQUIRED', 'Observed upload and text contracts are both required for an attachment chain.');
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let initialLine = '';
  let initial;
  let envelope;
  let client;
  let uploadResult;
  let attachmentMessageCapture;
  let textResponse;
  let capturedUploadContinuation = null;
  let refreshedUploadCookies = null;
  let preserveAttachmentRecovery = false;
  try {
    initialLine = await readLine(iterator);
    initial = parseJsonLine(initialLine, 'ATTACHMENT_CHAIN_ENVELOPE_INVALID');
    initialLine = '';
    if (!initial || typeof initial !== 'object' || Array.isArray(initial)
        || Object.keys(initial).some((key) => !['session', 'capture', 'uploadCookies', 'file'].includes(key))) {
      clearStrings(initial);
      throw new GeminiClientError('ATTACHMENT_CHAIN_ENVELOPE_INVALID', 'The initial attachment-chain envelope has unsupported fields.');
    }
    const normalized = { session: initial.session, capture: initial.capture,
      uploadCookies: initial.uploadCookies, file: initial.file };
    const wire = Buffer.from(JSON.stringify(normalized));
    try { envelope = await readAttachmentUploadEnvelopeFromStdin(installedContract, { input: Readable.from([wire]) }); }
    finally { wire.fill(0); clearStrings(normalized); clearStrings(initial); initial = null; }
    assertPromptDoesNotContainFileContent(options.prompt, envelope.file.body);
    client = new GeminiWebClient({ contract: installedContract, session: envelope.session });
    const identity = await client.refreshSession(options.expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
      throw new GeminiClientError('ATTACHMENT_CHAIN_OWNER_GATE_FAILED', 'The current Gemini owner gate did not match the expected account.');
    }
    const before = await client.listHistory();
    uploadResult = await client.uploadAttachmentOnce({
      expectedOwner: options.expectedOwner,
      callerIntent: options.uploadCallerIntent,
      capture: envelope.capture,
      uploadCookies: envelope.uploadCookies,
      file: envelope.file,
      journalRoot,
      useInstalledContinuationTemplate: true,
      uploadCookieRefreshProvider: async () => refreshedUploadCookies,
      continuationCaptureProvider: async (start) => {
        const event = {
          event: 'start-response',
          httpStatus: start.httpStatus,
          uploadUrl: start.uploadUrl,
          responseHeaders: start.responseHeaders,
          responseBodyBase64: start.responseBody.toString('base64'),
        };
        emit(output, event);
        clearStrings(event);
        let line = await readLine(iterator);
        try {
          const parsedContinuation = parseContinuationEvent(line, envelope.file.body.length);
          capturedUploadContinuation = parsedContinuation.capture;
          refreshedUploadCookies = parsedContinuation.uploadCookies;
          return capturedUploadContinuation;
        } finally { line = ''; }
      },
      uploadResponseHandler: async (response) => {
        const event = {
          event: 'transfer-response',
          httpStatus: response.httpStatus,
          responseHeaders: response.responseHeaders,
          responseBodyBase64: response.responseBody.toString('base64'),
        };
        emit(output, event);
        clearStrings(event);
        const ackLine = await readLine(iterator);
        const ack = parseJsonLine(ackLine, 'ATTACHMENT_CHAIN_TRANSFER_ACK_INVALID');
        if (!ack || ack.event !== 'transfer-fulfilled' || Object.keys(ack).some((key) => key !== 'event')) {
          clearStrings(ack);
          throw new GeminiClientError('ATTACHMENT_CHAIN_TRANSFER_ACK_INVALID', 'The native UI did not confirm the actual server response was forwarded.');
        }
        clearStrings(ack);
        let messageLine = await readLine(iterator);
        attachmentMessageCapture = parseAttachmentMessageEvent(messageLine);
        messageLine = '';
        return { completed: true };
      },
    });
    if (uploadResult.status !== 'verified' || uploadResult.uploadedFileReadbackVerified !== true
        || !uploadResult.internal?.attachmentRef || !attachmentMessageCapture) {
      throw new GeminiClientError('ATTACHMENT_CHAIN_UPLOAD_OR_CAPTURE_UNVERIFIED', 'The direct upload or normal SDK attachment-message capture did not verify.');
    }
    requireAttachmentUploadQueryReadback(uploadResult.query, envelope.file.body.length);
    const attachmentRef = uploadResult.internal.attachmentRef;
    const textOptions = {
      actor: options.expectedOwner,
      callerIntent: options.messageCallerIntent,
      preserveClientRequestId: true,
      preserveCapturedToken: true,
      journalRoot,
    };
    const recoveryResult = await sendTextWithOneAttachmentMessageRecapture({
      client,
      capture: attachmentMessageCapture,
      prompt: options.prompt,
      attachmentRef,
      textOptions,
      iterator,
      output,
      onRecaptured: (recaptured) => { attachmentMessageCapture = recaptured; },
    }).catch((error) => {
      if (error?.attachmentMessageCapture) attachmentMessageCapture = error.attachmentMessageCapture;
      throw error;
    });
    const textResult = recoveryResult.result;
    attachmentMessageCapture = recoveryResult.capture;
    textResponse = textResult.response;
    const decoded = safeResponseParse(installedContract, textResponse);
    const expectedFileText = envelope.file.body.toString('utf8');
    const directReplySummary = summarizeAttachmentReplyText(decoded.matched === true ? decoded.text : null, expectedFileText);
    const directReplyMatchedFile = directReplySummary.rawExactMatch === true;
    const directReplyNormalizedFileMatch = directReplySummary.normalizedMatch === true;
    const after = await client.listHistory();
    const beforeIds = new Set(historyItems(before.data)
      .map((item) => Array.isArray(item) && typeof item[0] === 'string' ? item[0] : null).filter(Boolean));
    const newItems = historyItems(after.data).filter((item) => Array.isArray(item) && typeof item[0] === 'string'
      && !beforeIds.has(item[0]));
    const historySummaryPromptAvailable = newItems.some((item) => JSON.stringify(item).includes(options.prompt));
    const conversationIdMatched = newItems.some((item) => item[0] === decoded.conversationId);
    let detail = null;
    let detailPromptMatched = false;
    let detailFileTextMatched = false;
    let detailResponseIdMatched = false;
    let detailAssistantReadback = null;
    if (decoded.matched === true && /^c_[0-9a-f]{16}$/.test(decoded.conversationId ?? '')) {
      detail = await client.readHistoryDetail({
        apiConversationId: decoded.conversationId,
        visibleRouteId: decoded.conversationId.slice(2),
        expectedIntent: options.prompt,
      });
      detailAssistantReadback = inspectAttachmentTaskAssistantReply(detail.payload, {
        prompt: options.prompt,
        expectedFileText,
        responseId: decoded.responseId,
      });
      detailPromptMatched = detail.summary.taskIntentMatched === true
        && detailAssistantReadback.promptPathCount === 1 && detailAssistantReadback.taskTurnMatchCount === 1;
      detailFileTextMatched = detailAssistantReadback.exactAnswerMatched === true;
      detailResponseIdMatched = detailAssistantReadback.responseIdExactlyMatchedTurnId === true;
    }
    const answerMatched = directReplyMatchedFile || detailFileTextMatched;
    const verified = uploadResult.status === 'verified' && textResponse.httpStatus >= 200 && textResponse.httpStatus < 300
      && textResult.attachmentBinding.matched === true && conversationIdMatched
      && answerMatched && detail?.httpStatus === 200 && detail.binding?.bound === true
      && detailPromptMatched && detailFileTextMatched && detailResponseIdMatched;
    let messageJournalReconciled = false;
    if (verified) {
      const intentKeyHash = mutationIntentDigest({ capability: 'text', actor: options.expectedOwner,
        callerIntent: options.messageCallerIntent });
      const pending = await findUnresolvedMutation('text', intentKeyHash, { root: journalRoot });
      if (pending) {
        await markMutationReconciled(pending.jobPath, { found: true, resultCategory: 'attachment_message_history_detail_readback' });
        messageJournalReconciled = true;
      }
    }
    const outputResult = {
      service: installedContract.service,
      operation: 'attachment_chain',
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      upload: {
        status: uploadResult.status,
        directDispatchCount: uploadResult.directDispatchCount,
        httpRequestCount: uploadResult.httpRequestCount,
        uploadedFileReadbackVerified: uploadResult.uploadedFileReadbackVerified,
        transferHttpStatus: uploadResult.upload?.httpStatus ?? null,
        transferUploadStatus: uploadResult.upload?.uploadStatus ?? null,
        transferContentType: uploadResult.upload?.contentType ?? null,
        transferResponseHeaderNames: uploadResult.upload?.responseHeaderNames ?? [],
        transferMetadata: uploadResult.upload?.metadata ? {
          fileNameMatched: uploadResult.upload.metadata.fileNameMatched,
          fileSizeMatched: uploadResult.upload.metadata.fileSizeMatched,
          fileMimeMatched: uploadResult.upload.metadata.fileMimeMatched,
          fileIdPresent: uploadResult.upload.metadata.fileIdPresent,
          fileIdLength: uploadResult.upload.metadata.fileIdLength,
        } : null,
        query: uploadResult.query ? {
          httpStatus: uploadResult.query.httpStatus ?? null,
          uploadStatus: uploadResult.query.uploadStatus ?? null,
          sizeReceived: uploadResult.query.sizeReceived ?? null,
          responseHeaderNames: uploadResult.query.responseHeaderNames ?? [],
        } : null,
        fileBytes: uploadResult.fileBytes,
        fileSha256: uploadResult.fileSha256,
        responseContentType: uploadResult.upload?.contentType ?? null,
        responseBytes: uploadResult.upload?.responseBytes ?? null,
        responseSha256: uploadResult.upload?.responseSha256 ?? null,
        attachmentReferenceAvailable: uploadResult.attachmentReferenceAvailable === true,
        freshUploadCookieOwnerVerified: uploadResult.freshUploadCookieOwnerVerified === true,
        continuationTemplate: uploadResult.continuationTemplate ?? null,
        journalReconciled: uploadResult.journalReconciled === true,
        sourceRequiredMapValuesMatched: uploadResult.continuationTemplate?.sourceRequiredHeadersMatched === true,
        protocolHeadersMatched: uploadResult.continuationTemplate?.protocolHeadersMatched === true,
        sourceEffectiveHeadersMatched: uploadResult.continuationTemplate?.sourceEffectiveHeadersMatched === true,
      },
        attachmentMessage: {
          nativeCaptureBoundToUploadResponse: textResult.attachmentBinding.matched,
          sdkSourceShapeMatchCount: textResult.attachmentBinding.sourceShapeMatchCount,
          sourceProtoTupleMatchCount: textResult.attachmentBinding.sourceTupleMatchCount,
          sourceValueCorrelationMatch: textResult.attachmentBinding.sourceValueCorrelationMatch,
          sourceParentValueMatchCount: textResult.attachmentBinding.sourceParentValueMatchCount,
          responsePayloadMatchCount: textResult.attachmentBinding.responsePayloadMatchCount,
          uploadedFilesArrayCount: textResult.attachmentBinding.uploadedFilesArrayCount,
          fileSizeMatchCount: textResult.attachmentBinding.fileSizeMatchCount,
          localFileIdPresent: textResult.attachmentBinding.fileIdPresent,
          recaptureCount: recoveryResult.recaptureCount,
          firstBindingDiagnostics: recoveryResult.firstBindingDiagnostics,
          bindingResolutionCount: recoveryResult.bindingResolutionCount,
          sourceLayout: textResult.attachmentBinding.sourceLayout ?? null,
      },
      text: {
        directDispatchCount: 1,
        httpStatus: textResponse.httpStatus,
        responseContentType: textResponse.contentType,
        responseBytes: textResponse.responseBytes,
        responseSha256: createHash('sha256').update(textResponse.body).digest('hex'),
        wireBodySha256: textResult.wireBodyDigest,
        responseDecoded: decoded.matched === true,
        directReplyMatchedFile,
        directReplyNormalizedFileMatch,
        directReplyRawUtf8Bytes: directReplySummary.rawUtf8Bytes,
        directReplyRawCharLength: directReplySummary.rawCharLength,
        directReplyRawSha256: directReplySummary.rawSha256,
        directReplyNormalizationMatches: directReplySummary.normalizedMatchVariants,
        answerMatched,
        historySummaryPromptAvailable,
        conversationIdMatched,
        historyDetailHttpStatus: detail?.httpStatus ?? null,
        historyDetailPromptMatched: detailPromptMatched,
        historyDetailFileTextMatched: detailFileTextMatched,
        historyDetailAssistantPath: detailAssistantReadback?.assistantPath ?? null,
        historyDetailAssistantStringCount: detailAssistantReadback?.assistantStringCount ?? 0,
        historyDetailExactAnswerPathCount: detailAssistantReadback?.exactAnswerPathCount ?? 0,
        historyDetailNormalizedAnswerPaths: detailAssistantReadback?.normalizedAnswerPaths ?? [],
        historyDetailStructuredContentPresent: detailAssistantReadback?.structuredContentPresent ?? false,
        historyDetailStructuredTextCandidateCount: detailAssistantReadback?.structuredTextCandidateCount ?? 0,
        historyDetailStructuredUnclassifiedChildCount: detailAssistantReadback?.structuredUnclassifiedChildCount ?? null,
        historyDetailStructuredSourceShapeComplete: detailAssistantReadback?.structuredSourceShapeComplete ?? false,
        historyDetailPlainTextCandidatePresent: detailAssistantReadback?.plainTextCandidatePresent ?? false,
        historyDetailResponseIdExactMatchKind: detailAssistantReadback?.responseIdExactMatchKind ?? 'unavailable',
        historyDetailResponseIdExactlyMatchedTurnId: detailAssistantReadback?.responseIdExactlyMatchedTurnId ?? false,
        historyDetailResponseIdExactlyMatchedDraftId: detailAssistantReadback?.responseIdExactlyMatchedDraftId ?? false,
        historyDetailResponseIdExactlyMatchedTurnIdForReconciliation: detailResponseIdMatched,
        journalReconciled: messageJournalReconciled,
      },
      outputStatus: verified ? 'verified' : 'needs_review_unverified_attachment_chain',
      rawResponseBodiesPersisted: false,
      rawAttachmentReferencePersisted: false,
      rawSessionOrContinuationUrlPersisted: false,
      rawPromptOrFileContentsPersisted: false,
      nativeBrowserUploadBytesDispatched: 0,
      nativeBrowserTextRequestDispatched: 0,
    };
    if (Buffer.isBuffer(textResponse.body)) textResponse.body.fill(0);
    return outputResult;
  } catch (error) {
    if (error?.code === 'TEXT_ATTACHMENT_CAPTURE_MISMATCH' && uploadResult?.status === 'verified'
        && uploadResult.uploadedFileReadbackVerified === true && uploadResult.internal?.attachmentRef
        && attachmentMessageCapture) {
      const diagnostics = safeProtocolErrorDetails(error.details).attachmentBinding ?? Object.freeze({});
      const partial = {
        service: installedContract.service,
        operation: 'attachment_chain',
        ownerMatched: true,
        anonymousOwnerAbsent: true,
        upload: {
          status: uploadResult.status,
          directDispatchCount: uploadResult.directDispatchCount,
          startDispatchCount: uploadResult.startDispatchCount,
          transferDispatchCount: uploadResult.transferDispatchCount,
          uploadedFileReadbackVerified: uploadResult.uploadedFileReadbackVerified,
          transferHttpStatus: uploadResult.upload?.httpStatus ?? null,
          transferContentType: uploadResult.upload?.contentType ?? null,
          transferResponseBytes: uploadResult.upload?.responseBytes ?? null,
          transferResponseSha256: uploadResult.upload?.responseSha256 ?? null,
          query: uploadResult.query ?? null,
          fileMimeType: uploadResult.fileMimeType,
          fileBytes: uploadResult.fileBytes,
          fileSha256: uploadResult.fileSha256,
          attachmentReferenceAvailable: true,
          journalReconciled: uploadResult.journalReconciled === true,
          continuationTemplate: uploadResult.continuationTemplate ?? null,
        },
        attachmentMessage: {
          nativeCaptureObserved: true,
          nativeCaptureBoundToUploadResponse: false,
          bodyBytes: Buffer.byteLength(attachmentMessageCapture.body, 'utf8'),
          bodySha256: createHash('sha256').update(attachmentMessageCapture.body, 'utf8').digest('hex'),
          contentType: attachmentMessageCapture.headers?.['content-type'] ?? null,
          headerNames: Object.keys(attachmentMessageCapture.headers ?? {}).sort(),
          bindingDiagnostics: diagnostics,
        },
        text: { directDispatchCount: 0, requestDispatched: false },
        directMutationDispatchCount: uploadResult.directDispatchCount,
        outputStatus: 'upload_verified_attachment_message_unbound',
        failureCode: error.code,
        attachmentReferenceRecovery: {
          referenceAvailableNonEnumerably: true,
          capturedRequestAvailableNonEnumerably: true,
          clientAvailableNonEnumerably: true,
          sessionRetainedUntilRelease: true,
          releaseAvailableNonEnumerably: true,
          rawReferencePersisted: false,
          rawCapturePersisted: false,
          directTextDispatchCount: 0,
        },
        rawResponseBodiesPersisted: false,
        rawAttachmentReferencePersisted: false,
        rawSessionOrContinuationUrlPersisted: false,
        rawPromptOrFileContentsPersisted: false,
      };
      preserveAttachmentRecovery = true;
      return attachInternalAttachmentRecovery(partial, uploadResult.internal.attachmentRef, attachmentMessageCapture, client);
    }
    throw protocolError(error);
  } finally {
    lines.close();
    if (!preserveAttachmentRecovery) {
      if (client?.transport) client.transport.session = null;
      if (client) client.verifiedOwner = null;
    }
    if (Buffer.isBuffer(envelope?.capture?.body)) envelope.capture.body.fill(0);
    if (Buffer.isBuffer(envelope?.file?.body)) envelope.file.body.fill(0);
    for (const cookie of envelope?.uploadCookies ?? []) cookie.value = '';
    for (const name of Object.keys(envelope?.capture?.headers ?? {})) envelope.capture.headers[name] = '';
    if (attachmentMessageCapture && !preserveAttachmentRecovery) {
      attachmentMessageCapture.body = '';
      for (const name of Object.keys(attachmentMessageCapture.headers ?? {})) attachmentMessageCapture.headers[name] = '';
    }
    if (Buffer.isBuffer(textResponse?.body)) textResponse.body.fill(0);
    if (Buffer.isBuffer(capturedUploadContinuation?.body)) capturedUploadContinuation.body.fill(0);
    clearStrings(initial);
    initialLine = '';
  }
}
