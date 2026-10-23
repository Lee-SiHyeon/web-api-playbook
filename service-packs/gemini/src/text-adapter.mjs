import { createHash, randomUUID } from 'node:crypto';
import { GeminiClientError } from './errors.mjs';
import { requireCapturedRequestOperation } from './contract.mjs';
import { SERVICE_ORIGIN } from './constants.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCapturedForm(body, expectedNames) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) {
    throw new GeminiClientError('TEXT_TEMPLATE_INVALID', 'The captured Gemini text request body is invalid.');
  }
  const pairs = [...new URLSearchParams(body).entries()];
  if (pairs.map(([name]) => name).join('\0') !== expectedNames.join('\0')) {
    throw new GeminiClientError('REQUEST_CONTRACT_MISMATCH', 'The captured text form does not match its observed field order.');
  }
  return new URLSearchParams(body);
}

function textDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedMimeType(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized) ? normalized : null;
}

function parseCapturedInnerPayload(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) {
    throw new GeminiClientError('TEXT_ATTACHMENT_CAPTURE_INVALID', 'The captured attachment-message body is invalid.');
  }
  try {
    const form = new URLSearchParams(body);
    const outer = JSON.parse(form.get('f.req'));
    if (!Array.isArray(outer) || outer.length !== 2 || outer[0] !== null || typeof outer[1] !== 'string') throw new Error();
    return JSON.parse(outer[1]);
  } catch {
    throw new GeminiClientError('TEXT_ATTACHMENT_CAPTURE_INVALID', 'The captured attachment-message request has an unsupported Gemini payload shape.');
  }
}

function referenceCandidateFromObject(value, expected) {
  const safeFields = ['filename', 'name', 'mimeType', 'mime_type', 'dh', 'fileType', 'file_type', 'gN', 'xl', 'yj', 'QG', 'fileId', 'file_id', 'uploadedFiles', 'uri', 'url'];
  const fieldNames = Object.keys(value).filter((name) => safeFields.includes(name)).sort();
  if (!fieldNames.length) return null;
  const result = { kind: 'object', fieldNames };
  const filename = typeof value.filename === 'string' ? value.filename : typeof value.name === 'string' ? value.name : null;
  if (filename !== null) {
    result.filenameMatched = filename === expected.filename;
    result.filenameBytes = Buffer.byteLength(filename, 'utf8');
    result.filenameSha256 = textDigest(filename);
  }
  const mime = normalizedMimeType(typeof value.mimeType === 'string' ? value.mimeType : value.mime_type);
  if (mime !== null) {
    result.mimeType = mime;
    result.mimeTypeMatched = mime === normalizedMimeType(expected.mimeType);
  }
  if (typeof value.dh === 'string') {
    result.dhBytes = Buffer.byteLength(value.dh, 'utf8');
    result.dhSha256 = textDigest(value.dh);
    result.dhMatched = value.dh === expected.dh;
  }
  const fileType = Number.isSafeInteger(value.fileType) ? value.fileType
    : Number.isSafeInteger(value.file_type) ? value.file_type : null;
  if (fileType !== null) result.fileType = fileType;
  if (typeof value.fileId === 'string' || typeof value.file_id === 'string') {
    const fileId = typeof value.fileId === 'string' ? value.fileId : value.file_id;
    result.fileIdPresent = fileId.length > 0;
    result.fileIdLength = fileId.length;
  }
  for (const name of ['gN', 'xl', 'yj', 'QG', 'uploadedFiles', 'uri', 'url']) {
    if (Object.hasOwn(value, name)) result[`${name}Present`] = true;
  }
  return result;
}

function referenceCandidateFromArray(value, expected) {
  const strings = value.filter((child) => typeof child === 'string');
  const filenameMatched = strings.includes(expected.filename);
  const mimeTypeMatched = strings.some((child) => normalizedMimeType(child) === normalizedMimeType(expected.mimeType));
  const dhMatched = strings.includes(expected.dh);
  if (!filenameMatched && !mimeTypeMatched && !dhMatched) return null;
  return {
    kind: 'array',
    length: value.length,
    elementTypes: value.slice(0, 24).map((child) => Array.isArray(child) ? 'array'
      : child === null ? 'null' : typeof child),
    filenameMatched,
    mimeTypeMatched,
    dhMatched,
  };
}

function emptyReferenceScanState() {
  return { dhMatches: 0, filenameMatches: 0, mimeTypeMatches: 0, sourceShapeMatches: 0,
    fileSizeMatches: 0, uploadedFilesArrayCount: 0, fileIdPresent: false, candidates: [] };
}

function findSourceVeTuples(value, expected) {
  const arrays = [];
  let nodes = 0;
  const walk = (current, path, depth) => {
    nodes += 1;
    if (depth > 24 || nodes > 100_000) return;
    if (Array.isArray(current)) {
      arrays.push({ value: current, path });
      current.forEach((child, index) => walk(child, [...path, index], depth + 1));
    } else if (current && typeof current === 'object') {
      Object.values(current).forEach((child, index) => walk(child, [...path, 'object', index], depth + 1));
    }
  };
  walk(value, [], 0);
  if (arrays.length > 50_000) return { candidates: [], valueCorrelationMatchCount: 0 };
  const isPathPrefix = (prefix, path) => prefix.length < path.length
    && prefix.every((part, index) => part === path[index]);
  const classifyDqc = (tuple) => {
    // Aqc sets dh with Di(field 1), context Gl with Fi(field 3), and MIME with Di(field 4).
    // The live JSON tuple is [dh, context-number, null, MIME]; the numeric value is not file size.
    if (tuple.length === 4 && typeof tuple[0] === 'string' && Number.isSafeInteger(tuple[1])
        && tuple[2] === null && typeof tuple[3] === 'string') {
      return { layout: 'observed_dqc_dh_context_null_mime', dhIndex: 0, contextIndex: 1, mimeIndex: 3 };
    }
    return null;
  };
  const out = [];
  let valueCorrelationMatchCount = 0;
  const veParents = arrays.filter(({ value: ve }) => typeof ve[1] === 'string');
  if (veParents.length > 1024) return { candidates: [], valueCorrelationMatchCount: 0 };
  const parentKeys = new Map(veParents.map((parent) => [JSON.stringify(parent.path), parent]));
  const nestedByParent = new Map(veParents.map((parent) => [JSON.stringify(parent.path), []]));
  for (const entry of arrays) {
    for (let prefixLength = entry.path.length - 1; prefixLength >= 0; prefixLength -= 1) {
      const key = JSON.stringify(entry.path.slice(0, prefixLength));
      if (parentKeys.has(key)) {
        nestedByParent.get(key).push(entry);
        break;
      }
    }
  }
  for (const { value: ve, path: vePath } of veParents) {
    const scoped = emptyReferenceScanState();
    collectAttachmentReferenceValues(ve, expected, scoped);
    const filenameMatched = ve[1] === expected.filename;
    const sourceValuesMatched = filenameMatched && scoped.dhMatches === 1
      && scoped.filenameMatches === 1 && scoped.mimeTypeMatches === 1;
    if (sourceValuesMatched) valueCorrelationMatchCount += 1;
    const nestedArrays = nestedByParent.get(JSON.stringify(vePath)) ?? [];
    let relevantNestedCount = 0;
    for (const { value: dqc, path: dqcPath } of nestedArrays) {
      const classification = classifyDqc(dqc);
      const hasExpectedValue = dqc.some((item) => typeof item === 'string'
        && (item === expected.dh || item === expected.filename
          || normalizedMimeType(item) === normalizedMimeType(expected.mimeType)))
        || (Number.isSafeInteger(expected.fileSizeBytes) && dqc.some((item) => item === expected.fileSizeBytes));
      if (!classification && !hasExpectedValue) continue;
      relevantNestedCount += 1;
      const layout = classification?.layout ?? 'unclassified_nested_array';
      const dhIndex = classification?.dhIndex ?? (typeof dqc[0] === 'string' ? 0 : null);
      const sizeIndex = classification?.sizeIndex ?? null;
      const contextIndex = classification?.contextIndex ?? null;
      const mimeIndex = classification?.mimeIndex ?? null;
      const dh = dhIndex === null ? null : dqc[dhIndex];
      const size = sizeIndex === null ? null : dqc[sizeIndex];
      const contextValue = contextIndex === null ? null : dqc[contextIndex];
      const mime = mimeIndex === null ? null : dqc[mimeIndex];
      const normalizedMime = normalizedMimeType(mime);
      const dhMatched = dh === expected.dh;
      const sizeMatched = sizeIndex === null ? null
        : Number.isSafeInteger(expected.fileSizeBytes) ? size === expected.fileSizeBytes : null;
      const mimeTypeMatched = normalizedMime === normalizedMimeType(expected.mimeType);
      const contextEqualsFileSize = Number.isSafeInteger(contextValue) && Number.isSafeInteger(expected.fileSizeBytes)
        ? contextValue === expected.fileSizeBytes : null;
      const matched = filenameMatched && classification !== null && dhMatched && mimeTypeMatched
        && (sizeIndex === null || sizeMatched === true);
      out.push({
        vePath: [...vePath], dqcPath: [...dqcPath], veLength: ve.length,
        tupleLength: dqc.length, tupleElementTypes: dqc.map((item) => Array.isArray(item) ? 'array'
          : item === null ? 'null' : typeof item), tupleLayout: layout,
        dhArrayIndex: dhIndex, sizeArrayIndex: sizeIndex, contextArrayIndex: contextIndex, mimeArrayIndex: mimeIndex,
        filenameBytes: Buffer.byteLength(ve[1], 'utf8'), filenameSha256: textDigest(ve[1]),
        filenameMatched, ...(typeof dh === 'string' ? {
          dhBytes: Buffer.byteLength(dh, 'utf8'), dhSha256: textDigest(dh),
        } : {}),
        dhMatched, ...(Number.isSafeInteger(size) ? { sizeBytes: size } : {}), sizeMatched,
        ...(Number.isSafeInteger(contextValue) ? { contextValueIsNumber: true, contextEqualsFileSize } : {}),
        mimeType: normalizedMime, mimeTypeMatched, sourceParentValueMatch: sourceValuesMatched, matched,
      });
      if (out.length >= 32) break;
    }
    if (relevantNestedCount === 0 && (filenameMatched || scoped.dhMatches > 0 || scoped.mimeTypeMatches > 0)) {
      out.push({
        vePath: [...vePath], dqcPath: null, veLength: ve.length, tupleLength: 0,
        tupleElementTypes: ve.map((item) => Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item),
        tupleLayout: 've_parent_values_only', dhArrayIndex: null, sizeArrayIndex: null, mimeArrayIndex: null,
        filenameBytes: Buffer.byteLength(ve[1], 'utf8'), filenameSha256: textDigest(ve[1]),
        filenameMatched, dhMatched: scoped.dhMatches === 1, sizeMatched: scoped.fileSizeMatches >= 1,
        mimeTypeMatched: scoped.mimeTypeMatches === 1, sourceParentValueMatch: sourceValuesMatched, matched: false,
      });
    }
    if (out.length >= 32) break;
  }
  return { candidates: out, valueCorrelationMatchCount };
}

function findUploadedFilesTupleMatches(value, expected, matches = [], depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 24 || budget.nodes > 100_000) return matches;
  if (Array.isArray(value)) {
    for (const child of value) findUploadedFilesTupleMatches(child, expected, matches, depth + 1, budget);
    return matches;
  }
  if (!value || typeof value !== 'object') return matches;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uploadedFiles' && Array.isArray(child)) {
      child.forEach((entry, index) => {
        const scoped = emptyReferenceScanState();
        collectAttachmentReferenceValues(entry, expected, scoped);
        if (scoped.dhMatches === 1 && scoped.filenameMatches === 1 && scoped.mimeTypeMatches === 1) {
          matches.push({
            index,
            responsePayloadMatchCount: scoped.dhMatches,
            filenameMatchCount: scoped.filenameMatches,
            mimeTypeMatchCount: scoped.mimeTypeMatches,
            sourceShapeMatchCount: scoped.sourceShapeMatches,
            fieldShapes: scoped.candidates.slice(0, 8),
          });
        }
      });
    }
    findUploadedFilesTupleMatches(child, expected, matches, depth + 1, budget);
  }
  return matches.slice(0, 32);
}

function collectAttachmentReferenceValues(value, expected, state, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 24 || budget.nodes > 100_000) return;
  if (typeof value === 'string') {
    if (value === expected.dh) state.dhMatches += 1;
    if (value === expected.filename) state.filenameMatches += 1;
    if (value.toLowerCase() === expected.mimeType.toLowerCase()) state.mimeTypeMatches += 1;
    return;
  }
  if (Number.isSafeInteger(value)) {
    if (Number.isSafeInteger(expected.fileSizeBytes) && value === expected.fileSizeBytes) state.fileSizeMatches += 1;
    return;
  }
  if (Array.isArray(value)) {
    const candidate = referenceCandidateFromArray(value, expected);
    if (candidate && state.candidates.length < 32) state.candidates.push(candidate);
    for (const child of value) collectAttachmentReferenceValues(child, expected, state, depth + 1, budget);
    return;
  }
  if (value && typeof value === 'object') {
    const candidate = referenceCandidateFromObject(value, expected);
    if (candidate && state.candidates.length < 32) state.candidates.push(candidate);
    if (value.filename === expected.filename && value.mimeType === expected.mimeType && value.dh === expected.dh
        && (expected.fileType === undefined || value.fileType === expected.fileType)) {
      state.sourceShapeMatches += 1;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uploadedFiles' && Array.isArray(child)) state.uploadedFilesArrayCount += 1;
      if (key === 'fileId' && typeof child === 'string' && child.length > 0) state.fileIdPresent = true;
      collectAttachmentReferenceValues(child, expected, state, depth + 1, budget);
    }
  }
}

/** Bind a native SDK attachment-message capture to the opaque response payload returned by upload. */
export function inspectCapturedAttachmentReference(capturedRequest, attachmentRef) {
  if (!capturedRequest || typeof capturedRequest.body !== 'string'
      || !attachmentRef || typeof attachmentRef !== 'object'
      || typeof attachmentRef.filename !== 'string' || typeof attachmentRef.mimeType !== 'string'
      || typeof attachmentRef.dh !== 'string' || !attachmentRef.dh) {
    throw new GeminiClientError('TEXT_ATTACHMENT_REFERENCE_INVALID', 'A source-shaped uploaded-file reference and native text capture are required.');
  }
  const inner = parseCapturedInnerPayload(capturedRequest.body);
  const state = emptyReferenceScanState();
  collectAttachmentReferenceValues(inner, attachmentRef, state);
  const uploadedFilesTupleMatches = findUploadedFilesTupleMatches(inner, attachmentRef);
  const sourceTupleMatchCount = uploadedFilesTupleMatches.length;
  const sourceScan = findSourceVeTuples(inner, attachmentRef);
  const sourceProtoCandidates = sourceScan.candidates;
  const matchedSourceCandidates = sourceProtoCandidates.filter((candidate) => candidate.matched);
  const sourceProtoTupleMatchCount = matchedSourceCandidates.length;
  const matchedSourceCandidate = matchedSourceCandidates[0] ?? null;
  const sourceParentValueMatchCount = sourceScan.valueCorrelationMatchCount;
  const capturedPrompt = Array.isArray(inner[0]) && typeof inner[0][0] === 'string' ? inner[0][0] : null;
  const capturedPromptContainsReferenceValue = capturedPrompt !== null
    && [attachmentRef.filename, attachmentRef.dh, attachmentRef.mimeType]
      .some((value) => value.length > 0 && capturedPrompt.includes(value));
  const sourceValueCorrelationMatch = sourceParentValueMatchCount === 1
    && state.dhMatches === 1 && state.filenameMatches === 1 && state.mimeTypeMatches === 1
    && !capturedPromptContainsReferenceValue;
  const uniqueSourceValues = state.dhMatches === 1 && state.filenameMatches === 1 && state.mimeTypeMatches === 1;
  const matchedObject = state.sourceShapeMatches === 1 && uniqueSourceValues;
  const matchedTuple = sourceProtoTupleMatchCount === 1 && uniqueSourceValues && sourceParentValueMatchCount === 1;
  const matched = matchedObject || matchedTuple || sourceValueCorrelationMatch;
  if (!matched) {
    throw new GeminiClientError('TEXT_ATTACHMENT_CAPTURE_MISMATCH', 'The captured SDK text request does not carry the uploaded file response and local file metadata.', {
      attachmentBinding: {
        sourceShapeMatchCount: state.sourceShapeMatches,
        responsePayloadMatchCount: state.dhMatches,
        filenameMatchCount: state.filenameMatches,
        mimeTypeMatchCount: state.mimeTypeMatches,
        fileSizeMatchCount: state.fileSizeMatches,
        uploadedFilesArrayCount: state.uploadedFilesArrayCount,
        fileIdPresent: state.fileIdPresent,
        capturedRequestBodyBytes: Buffer.byteLength(capturedRequest.body, 'utf8'),
        capturedRequestBodySha256: textDigest(capturedRequest.body),
        expectedFilenameBytes: Buffer.byteLength(attachmentRef.filename, 'utf8'),
        expectedFilenameSha256: textDigest(attachmentRef.filename),
        expectedMimeType: normalizedMimeType(attachmentRef.mimeType),
        expectedResponsePayloadBytes: Buffer.byteLength(attachmentRef.dh, 'utf8'),
        expectedResponsePayloadSha256: textDigest(attachmentRef.dh),
        expectedFileTypePresent: Number.isSafeInteger(attachmentRef.fileType),
        ...(Number.isSafeInteger(attachmentRef.fileType) ? { expectedFileType: attachmentRef.fileType } : {}),
        expectedFileSizeBytes: Number.isSafeInteger(attachmentRef.fileSizeBytes) ? attachmentRef.fileSizeBytes : null,
        candidateCount: state.candidates.length,
        candidates: state.candidates,
        sourceTupleMatchCount,
        uploadedFilesTupleCandidates: uploadedFilesTupleMatches,
        sourceProtoTupleMatchCount,
        sourceParentValueMatchCount,
        sourceProtoCandidates,
        sourceValueCorrelationMatch,
        capturedPromptContainsReferenceValue,
      },
    });
  }
  return Object.freeze({
    matched,
    sourceShapeMatchCount: state.sourceShapeMatches,
    sourceTupleMatchCount: sourceProtoTupleMatchCount,
    uploadedFilesTupleMatchCount: sourceTupleMatchCount,
    sourceValueCorrelationMatch,
    sourceParentValueMatchCount,
    sourceLayout: matchedSourceCandidate?.tupleLayout ?? null,
    contextValueIsNumber: matchedSourceCandidate?.contextValueIsNumber ?? false,
    contextEqualsFileSize: matchedSourceCandidate?.contextEqualsFileSize ?? null,
    responsePayloadMatchCount: state.dhMatches,
    filenameMatchCount: state.filenameMatches,
    mimeTypeMatchCount: state.mimeTypeMatches,
    fileSizeMatchCount: state.fileSizeMatches,
    uploadedFilesArrayCount: state.uploadedFilesArrayCount,
    fileIdPresent: state.fileIdPresent,
  });
}

function valueAtSourceArrayPath(root, path) {
  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    if (part === 'object') {
      const objectIndex = path[++index];
      if (!current || typeof current !== 'object' || Array.isArray(current)
          || !Number.isSafeInteger(objectIndex) || objectIndex < 0) return undefined;
      const values = Object.values(current);
      if (objectIndex >= values.length) return undefined;
      current = values[objectIndex];
    } else {
      if (!Array.isArray(current) || !Number.isSafeInteger(part) || part < 0 || part >= current.length) return undefined;
      current = current[part];
    }
  }
  return current;
}

function isSourcePathPrefix(prefix, path) {
  return Array.isArray(prefix) && Array.isArray(path) && prefix.length < path.length
    && prefix.every((part, index) => part === path[index]);
}

/** Validate the live source-reviewed VE/dqc context layout against the still-live native capture. */
export function inspectCapturedAttachmentReferenceBySourcePlan(capturedRequest, attachmentRef, plan) {
  if (!capturedRequest || typeof capturedRequest.body !== 'string'
      || !attachmentRef || typeof attachmentRef !== 'object'
      || typeof attachmentRef.filename !== 'string' || typeof attachmentRef.mimeType !== 'string'
      || typeof attachmentRef.dh !== 'string' || !attachmentRef.dh
      || !Number.isSafeInteger(attachmentRef.fileSizeBytes) || attachmentRef.fileSizeBytes < 0
      || !plan || typeof plan !== 'object' || Array.isArray(plan)
      || Object.keys(plan).some((key) => !['vePath', 'dqcPath', 'tupleLayout'].includes(key))
      || plan.tupleLayout !== 'observed_dqc_dh_context_null_mime'
      || !Array.isArray(plan.vePath) || !Array.isArray(plan.dqcPath)
      || plan.vePath.length > 32 || plan.dqcPath.length > 32
      || [...plan.vePath, ...plan.dqcPath].some((part) =>
        !((Number.isSafeInteger(part) && part >= 0) || part === 'object'))
      || !isSourcePathPrefix(plan.vePath, plan.dqcPath)) {
    throw new GeminiClientError('TEXT_ATTACHMENT_SOURCE_PLAN_INVALID', 'A bounded source-shaped attachment path plan is required.');
  }
  const inner = parseCapturedInnerPayload(capturedRequest.body);
  const ve = valueAtSourceArrayPath(inner, plan.vePath);
  const dqc = valueAtSourceArrayPath(inner, plan.dqcPath);
  if (!Array.isArray(ve) || ve[1] !== attachmentRef.filename || !Array.isArray(dqc)) {
    throw new GeminiClientError('TEXT_ATTACHMENT_SOURCE_PLAN_MISMATCH', 'The source-selected VE filename path did not match this request.');
  }
  let dh;
  let mime;
  if (dqc.length !== 4 || typeof dqc[0] !== 'string' || !Number.isSafeInteger(dqc[1])
      || dqc[2] !== null || typeof dqc[3] !== 'string') {
    throw new GeminiClientError('TEXT_ATTACHMENT_SOURCE_PLAN_MISMATCH', 'The observed dqc context tuple shape changed.');
  }
  [dh, , , mime] = dqc;
  if (dh !== attachmentRef.dh
      || normalizedMimeType(mime) !== normalizedMimeType(attachmentRef.mimeType)) {
    throw new GeminiClientError('TEXT_ATTACHMENT_SOURCE_PLAN_MISMATCH', 'The source-selected dqc reference and MIME did not match this upload.');
  }
  const state = emptyReferenceScanState();
  collectAttachmentReferenceValues(inner, attachmentRef, state);
  const prompt = Array.isArray(inner[0]) && typeof inner[0][0] === 'string' ? inner[0][0] : null;
  const promptContainsReference = prompt !== null
    && [attachmentRef.filename, attachmentRef.dh, attachmentRef.mimeType].some((value) => prompt.includes(value));
  const sourceScan = findSourceVeTuples(inner, attachmentRef);
  const candidateMatched = sourceScan.candidates.some((candidate) => candidate.sourceParentValueMatch === true
    && JSON.stringify(candidate.vePath) === JSON.stringify(plan.vePath)
    && JSON.stringify(candidate.dqcPath) === JSON.stringify(plan.dqcPath)
    && (candidate.tupleLayout === plan.tupleLayout || candidate.tupleLayout === 'unclassified_nested_array'));
  if (!candidateMatched || sourceScan.valueCorrelationMatchCount !== 1
      || state.dhMatches !== 1 || state.filenameMatches !== 1 || state.mimeTypeMatches !== 1
      || promptContainsReference) {
    throw new GeminiClientError('TEXT_ATTACHMENT_SOURCE_PLAN_MISMATCH', 'The captured request did not uniquely bind the source-selected file values.');
  }
  return Object.freeze({
    matched: true,
    sourceShapeMatchCount: state.sourceShapeMatches,
    sourceTupleMatchCount: 1,
    sourceValueCorrelationMatch: true,
    sourceParentValueMatchCount: sourceScan.valueCorrelationMatchCount,
    responsePayloadMatchCount: state.dhMatches,
    filenameMatchCount: state.filenameMatches,
    mimeTypeMatchCount: state.mimeTypeMatches,
    fileSizeMatchCount: state.fileSizeMatches,
    uploadedFilesArrayCount: state.uploadedFilesArrayCount,
    fileIdPresent: state.fileIdPresent,
    sourceLayout: plan.tupleLayout,
    contextValueIsNumber: true,
    contextEqualsFileSize: dqc[1] === attachmentRef.fileSizeBytes,
  });
}

export function buildCapturedTextRequest(contract, session, capturedRequest, {
  prompt,
  preserveClientRequestId = false,
  preserveCapturedToken = false,
} = {}) {
  const operation = requireCapturedRequestOperation(contract, 'text');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || /\0/.test(prompt)) {
    throw new GeminiClientError('TEXT_PROMPT_INVALID', 'A non-empty Gemini text prompt within the captured limit is required.');
  }
  if (!capturedRequest || typeof capturedRequest.url !== 'string'
      || capturedRequest.method !== operation.request.method || typeof capturedRequest.body !== 'string') {
    throw new GeminiClientError('TEXT_TEMPLATE_INVALID', 'A paired current-browser text request template is required.');
  }
  let url;
  try { url = new URL(capturedRequest.url); }
  catch { throw new GeminiClientError('TEXT_TEMPLATE_INVALID', 'The captured Gemini text request URL is invalid.'); }
  if (url.origin !== SERVICE_ORIGIN || url.pathname !== operation.request.path) {
    throw new GeminiClientError('REQUEST_ORIGIN_BLOCKED', 'The captured text request escaped the observed Gemini operation.');
  }
  const query = [...url.searchParams.entries()];
  if (query.length !== operation.request.queryKeys.length
      || query.some(([name], index) => name !== operation.request.queryKeys[index])) {
    throw new GeminiClientError('REQUEST_CONTRACT_MISMATCH', 'The captured text query does not match the observed field order.');
  }
  const headers = Object.fromEntries(Object.entries(capturedRequest.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
  if (String(headers['content-type'] || '').split(';', 1)[0].toLowerCase()
      !== String(operation.request.contentType || '').split(';', 1)[0].toLowerCase()) {
    throw new GeminiClientError('REQUEST_CONTENT_TYPE_MISMATCH', 'The captured text content type does not match the observed operation.');
  }
  const form = parseCapturedForm(capturedRequest.body, operation.request.bodyFieldNames);
  let outer;
  let inner;
  try {
    outer = JSON.parse(form.get('f.req'));
    if (!Array.isArray(outer) || outer.length !== 2 || outer[0] !== null || typeof outer[1] !== 'string') throw new Error();
    inner = JSON.parse(outer[1]);
  } catch {
    throw new GeminiClientError('TEXT_TEMPLATE_INVALID', 'The captured Gemini text payload has an unsupported outer shape.');
  }
  if (!Array.isArray(inner) || inner.length !== 99 || !Array.isArray(inner[0])
      || inner[0].length < 1 || typeof inner[0][0] !== 'string' || !inner[0][0]) {
    throw new GeminiClientError('TEXT_TEMPLATE_INVALID', 'The captured Gemini text payload has an unsupported inner shape.');
  }
  const capturedPrompt = inner[0][0];
  if (preserveClientRequestId && preserveCapturedToken && prompt !== capturedPrompt) {
    throw new GeminiClientError('TEXT_CAPTURE_INTENT_MISMATCH', 'The authorized text request must match the exact browser-captured prompt.');
  }
  if (prompt === capturedPrompt && preserveClientRequestId && preserveCapturedToken) {
    return Object.freeze({
      method: operation.request.method,
      path: operation.request.path,
      query: Object.freeze(query.map(([name, value]) => Object.freeze([name, value]))),
      headers: Object.freeze({}),
      contentType: operation.request.contentType,
      body: capturedRequest.body,
    });
  }
  inner[0][0] = prompt;
  if (!preserveClientRequestId) {
    if (typeof inner[59] !== 'string' || !UUID.test(inner[59])) {
      throw new GeminiClientError('TEXT_TEMPLATE_INVALID', 'The captured Gemini text client ID field changed shape.');
    }
    inner[59] = randomUUID();
  }
  outer[1] = JSON.stringify(inner);
  form.set('f.req', JSON.stringify(outer));
  const batchContext = session?.batchContext;
  const antiForgeryToken = preserveCapturedToken ? form.get('at') : batchContext?.at;
  if (!antiForgeryToken) throw new GeminiClientError('SESSION_CONTEXT_REQUIRED', 'A current Gemini anti-forgery token is required for text generation.');
  form.set('at', antiForgeryToken);
  return Object.freeze({
    method: operation.request.method,
    path: operation.request.path,
    query: Object.freeze(query.map(([name, value]) => Object.freeze([name, value]))),
    headers: Object.freeze({}),
    contentType: operation.request.contentType,
    body: form.toString(),
  });
}
