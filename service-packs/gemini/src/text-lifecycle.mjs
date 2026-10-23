import { createHash } from 'node:crypto';
import { stdin } from 'node:process';
import { GeminiClientError } from './errors.mjs';
import { SERVICE_ORIGIN } from './constants.mjs';
import { validateSessionBundle } from './session.mjs';
import { buildCapturedTextRequest } from './text-adapter.mjs';
import { parseCapturedTextResponse, parseRequestOnlyTextResponse } from './text-response.mjs';
import { findUnresolvedMutation, loadJournal, markMutationReconciled, mutationIntentDigest } from './journal.mjs';
import { inspectAttachmentTaskAssistantReply } from './attachment-chain.mjs';
import { readGeminiHistoryTurnResponse } from './history-turn-response.mjs';

const ACTIONS = new Set(['continue', 'edit', 'regenerate']);
const CONVERSATION_ID = /^c_[0-9a-f]{16}$/;
const INTENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_VALUE_NODES = 100_000;
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

// The current first-party pTk request builder maps the active route `cmid`
// through `jc.E5.MEf.M6e`. A guarded live StreamGenerate capture for this
// source version carried the owner-resolved conversation ID at this raw JSON
// array path (bundle SHA256 15c83bb4122db88e22945b14a502234b966f630aed6321cd0f4bcefdf1bec8a4).
// This is a captured JSON path, not a protobuf field number.
const CAPTURED_ROUTE_CONVERSATION_ID_PATH = Object.freeze([71, 0]);

function clearStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      try {
        if (typeof value[index] === 'string') value[index] = '';
        else clearStrings(value[index], seen);
      } catch { /* Best-effort clearing of parsed envelope strings. */ }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = '';
      else clearStrings(value[key], seen);
    } catch { /* Best-effort clearing of parsed envelope strings. */ }
  }
}

function validateNativeActionCapture(value, action) {
  const allowed = new Set([
    'action', 'registeredTargetMatched', 'routeConversationMatched', 'nativeActionConfirmed',
    'streamGenerateObserved', 'streamGenerateAbortConfirmed', 'browserBusinessRequestCount',
    'browserBusinessRequestAbortCount', 'browserBusinessRequestsDelivered', 'unclassifiedBusinessPostCount',
    'unclassifiedBusinessPostAbortCount', 'unclassifiedBusinessPostsDelivered',
  ]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))
      || value.action !== action || value.registeredTargetMatched !== true
      || value.routeConversationMatched !== true || value.nativeActionConfirmed !== true
      || value.streamGenerateObserved !== true || value.streamGenerateAbortConfirmed !== true
      || !Number.isInteger(value.browserBusinessRequestCount) || value.browserBusinessRequestCount < 1
      || value.browserBusinessRequestAbortCount !== value.browserBusinessRequestCount
      || value.browserBusinessRequestsDelivered !== 0
      || !Number.isSafeInteger(value.unclassifiedBusinessPostCount) || value.unclassifiedBusinessPostCount < 0
      || value.unclassifiedBusinessPostCount > 1024
      || value.unclassifiedBusinessPostAbortCount !== value.unclassifiedBusinessPostCount
      || value.unclassifiedBusinessPostsDelivered !== 0) {
    fail('TEXT_ACTION_CAPTURE_PROOF_INVALID', 'A guarded, registered-target native action capture is required.');
  }
  return Object.freeze({ ...value });
}

/** Read a one-shot action envelope; raw session, request, ID and prompt stay in memory only. */
export async function readTextActionEnvelopeFromStdin(contract, { input = stdin, maxBytes = MAX_ENVELOPE_BYTES } = {}) {
  if (!input || input.isTTY === true || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ENVELOPE_BYTES) {
    fail('TEXT_ACTION_ENVELOPE_STDIN_REQUIRED', 'A bounded StreamGenerate action envelope must be piped on stdin.');
  }
  const chunks = [];
  let length = 0;
  let bytes;
  let packet;
  try {
    for await (const chunk of input) {
      const part = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8');
      length += part.length;
      if (length > maxBytes) {
        part.fill(0);
        fail('TEXT_ACTION_ENVELOPE_TOO_LARGE', 'The StreamGenerate action envelope exceeded its size bound.');
      }
      chunks.push(part);
    }
    if (!length) fail('TEXT_ACTION_ENVELOPE_REQUIRED', 'A StreamGenerate action envelope was not received.');
    bytes = Buffer.concat(chunks, length);
    try { packet = JSON.parse(bytes.toString('utf8')); }
    catch { fail('TEXT_ACTION_ENVELOPE_INVALID', 'The StreamGenerate action envelope is not valid JSON.'); }

    const allowed = new Set(['session', 'expectedOwner', 'capturedRequest', 'action', 'targetConversationId',
      'visibleRouteId', 'beforePrompt', 'afterPrompt', 'expectedAssistantMarker', 'nativeActionCapture']);
    if (!isRecord(packet) || Object.keys(packet).some((key) => !allowed.has(key))
        || !isRecord(packet.capturedRequest)
        || Object.keys(packet.capturedRequest).some((key) => !['url', 'method', 'body', 'headers'].includes(key))
        || typeof packet.capturedRequest.url !== 'string' || packet.capturedRequest.url.length > 8192
        || packet.capturedRequest.method !== 'POST' || typeof packet.capturedRequest.body !== 'string'
        || Buffer.byteLength(packet.capturedRequest.body, 'utf8') > 2 * 1024 * 1024
        || !isRecord(packet.capturedRequest.headers) || Object.keys(packet.capturedRequest.headers).length > 64
        || typeof packet.expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(packet.expectedOwner.trim())
        || !ACTIONS.has(packet.action) || typeof packet.targetConversationId !== 'string'
        || !CONVERSATION_ID.test(packet.targetConversationId)
        || typeof packet.visibleRouteId !== 'string' || packet.visibleRouteId !== packet.targetConversationId.slice(2)) {
      fail('TEXT_ACTION_ENVELOPE_INVALID', 'The StreamGenerate action envelope has an unsupported shape.');
    }
    validatePrompt(packet.beforePrompt, 'TEXT_ACTION_ENVELOPE_INVALID');
    validatePrompt(packet.afterPrompt, 'TEXT_ACTION_ENVELOPE_INVALID');
    if (typeof packet.expectedAssistantMarker !== 'string' || !packet.expectedAssistantMarker.trim()
        || packet.expectedAssistantMarker.length > 256 || /\0/.test(packet.expectedAssistantMarker)) {
      fail('TEXT_ACTION_ENVELOPE_INVALID', 'A bounded expected assistant marker is required.');
    }
    const operation = contract?.operations?.text;
    if (operation?.observation?.request !== true || operation.request?.path !== '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate') {
      fail('TEXT_ACTION_CONTRACT_REQUIRED', 'A current request-only StreamGenerate contract is required.');
    }
    let capturedUrl;
    try { capturedUrl = new URL(packet.capturedRequest.url); }
    catch { fail('TEXT_ACTION_ENVELOPE_INVALID', 'The captured StreamGenerate URL is invalid.'); }
    if (capturedUrl.origin !== SERVICE_ORIGIN || capturedUrl.pathname !== operation.request.path
        || [...capturedUrl.searchParams.keys()].some((name, index) => name !== operation.request.queryKeys[index])
        || capturedUrl.searchParams.size !== operation.request.queryKeys.length) {
      fail('TEXT_ACTION_ENVELOPE_INVALID', 'The captured StreamGenerate URL escaped its observed path or query shape.');
    }
    const allowedHeaders = new Set((operation.request.headerNames ?? []).map((name) => name.toLowerCase()));
    for (const [name, value] of Object.entries(packet.capturedRequest.headers)) {
      if (!allowedHeaders.has(name.toLowerCase()) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
        fail('TEXT_ACTION_ENVELOPE_INVALID', 'A captured StreamGenerate header is outside the observed allowlist.');
      }
    }
    let session = validateSessionBundle(packet.session, contract);
    const capturedRequest = {
      url: packet.capturedRequest.url,
      method: packet.capturedRequest.method,
      body: packet.capturedRequest.body,
      headers: { ...packet.capturedRequest.headers },
    };
    const textRequestHeaders = {};
    const forbiddenHeaders = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length']);
    for (const [name, value] of Object.entries(capturedRequest.headers)) {
      const normalized = name.toLowerCase();
      if (Object.hasOwn(textRequestHeaders, normalized) || forbiddenHeaders.has(normalized)) {
        fail('TEXT_ACTION_ENVELOPE_INVALID', 'A captured request header was duplicated or contains credentials.');
      }
      textRequestHeaders[normalized] = value;
    }
    session = validateSessionBundle({
      ...session,
      requestHeaders: { ...(session.requestHeaders ?? {}), text: textRequestHeaders },
    }, contract);
    const result = {
      session,
      expectedOwner: packet.expectedOwner,
      capturedRequest,
      action: packet.action,
      targetConversationId: packet.targetConversationId,
      visibleRouteId: packet.visibleRouteId,
      beforePrompt: packet.beforePrompt,
      afterPrompt: packet.afterPrompt,
      expectedAssistantMarker: packet.expectedAssistantMarker,
      nativeActionCapture: validateNativeActionCapture(packet.nativeActionCapture, packet.action),
    };
    clearStrings(packet);
    return result;
  } finally {
    clearStrings(packet);
    bytes?.fill(0);
    for (const part of chunks) part.fill(0);
  }
}

/** Clear a one-shot action envelope after its child finishes, including preflight failures. */
export function clearTextActionEnvelope(envelope) {
  if (!isRecord(envelope)) return;
  const capture = envelope.capturedRequest;
  if (isRecord(capture)) {
    try { capture.body = ''; } catch { /* Best-effort clearing only. */ }
    try { capture.url = ''; } catch { /* Best-effort clearing only. */ }
    for (const name of Object.keys(capture.headers ?? {})) {
      try { capture.headers[name] = ''; } catch { /* Best-effort clearing only. */ }
    }
    try { envelope.capturedRequest = null; } catch { /* A frozen outer envelope cannot be cleared. */ }
  }
  for (const key of ['session', 'expectedOwner', 'targetConversationId', 'visibleRouteId',
    'beforePrompt', 'afterPrompt', 'expectedAssistantMarker', 'nativeActionCapture']) {
    try { envelope[key] = null; } catch { /* A frozen outer envelope cannot be cleared. */ }
  }
}

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function textSha256(value) {
  return sha256(Buffer.from(value, 'utf8'));
}

function valueAtPath(value, path) {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current) || !Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
    current = current[index];
  }
  return current;
}

function validatePrompt(value, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000 || /\0/.test(value)) fail(code, 'A bounded task prompt is required.');
  return value;
}

function visit(value, callback, path = [], budget = { nodes: 0 }, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > MAX_VALUE_NODES || depth > 32) return;
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => visit(child, callback, [...path, index], budget, depth + 1));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) visit(child, callback, [...path, key], budget, depth + 1);
  }
}

function exactStrings(value, expected) {
  const matches = [];
  visit(value, (current, path) => {
    if (current === expected) matches.push(path);
  });
  return matches;
}

function stringsIn(value) {
  const strings = [];
  visit(value, (current) => {
    if (typeof current === 'string') strings.push(current);
  });
  return strings;
}

function clearReadback(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      try {
        if (typeof value[index] === 'string') value[index] = '';
        else clearReadback(value[index], seen);
      } catch { /* Best-effort clearing of private task text. */ }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = '';
      else clearReadback(value[key], seen);
    } catch { /* Frozen metadata summaries are not writable. */ }
  }
}

function safeCaptureSummary(capture, requestSpec, targetIdMatches) {
  const url = new URL(capture.url);
  const names = (value) => [...new Set(Object.keys(value ?? {}).map((name) => name.toLowerCase()))].sort();
  return Object.freeze({
    method: capture.method,
    origin: url.origin,
    path: url.pathname,
    queryKeys: [...url.searchParams.keys()],
    headerNames: names(capture.headers),
    bodyFieldNames: [...new URLSearchParams(capture.body).keys()],
    bodyBytes: Buffer.byteLength(capture.body, 'utf8'),
    bodySha256: textSha256(capture.body),
    preservedWireBody: requestSpec.body === capture.body,
    targetIdOccurrenceCount: targetIdMatches.length,
    targetIdPath: targetIdMatches.length === 1 ? targetIdMatches[0].map((part) => typeof part === 'number' ? part : 'field') : null,
    rawUrlOrBodyPersisted: false,
  });
}

function responseSummary(result, decoded) {
  const response = result?.response;
  if (!response) return Object.freeze({ observed: false, decoded: false });
  return Object.freeze({
    observed: true,
    httpStatus: response.httpStatus,
    contentType: response.contentType,
    responseBytes: response.responseBytes,
    responseSha256: result.responseSha256 ?? (Buffer.isBuffer(response.body) ? sha256(response.body) : null),
    decoded: decoded?.matched === true,
    responseFrameCount: decoded?.nullSelectorFrameCount ?? 0,
    responseChunkCount: decoded?.mainCandidateChunkCount ?? 0,
    responseIdObserved: typeof decoded?.responseId === 'string' && decoded.responseId.length > 0,
  });
}

function decodeStreamGenerate(client, direct) {
  const body = direct?.response?.body;
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return null;
  const operation = client.contract?.operations?.text;
  if (operation?.observation?.requestResponse === true) {
    return parseCapturedTextResponse(client.contract, body);
  }
  return parseRequestOnlyTextResponse(client.contract, body, { contentType: direct.response.contentType });
}

function exactTaskReadback(detail, expectedPrompt, targetConversationId) {
  const values = stringsIn(detail?.payload);
  const promptPaths = exactStrings(detail?.payload, expectedPrompt);
  const idPaths = exactStrings(detail?.payload, targetConversationId);
  const summary = detail?.summary ?? {};
  return {
    values,
    proven: detail?.httpStatus === 200 && detail.binding?.bound === true
      && summary.rpcMatchCount === 1 && summary.apiConversationIdMatched === true
      && summary.taskIntentMatched === true && promptPaths.length > 0 && idPaths.length > 0,
    httpStatus: Number.isInteger(detail?.httpStatus) ? detail.httpStatus : null,
    responseBytes: Number.isSafeInteger(detail?.responseBytes) ? detail.responseBytes : null,
    responseSha256: typeof detail?.responseSha256 === 'string' && DIGEST.test(detail.responseSha256)
      ? detail.responseSha256 : null,
    rpcMatchCount: Number.isInteger(summary.rpcMatchCount) ? summary.rpcMatchCount : 0,
    taskPromptMatched: summary.taskIntentMatched === true && promptPaths.length > 0,
    apiConversationIdMatched: summary.apiConversationIdMatched === true && idPaths.length > 0,
    routeBindingMatched: detail?.binding?.bound === true,
  };
}

function inspectAssistantTurn(detail, prompt, expectedAssistantText, responseId) {
  if (!detail?.payload) return null;
  try {
    return inspectAttachmentTaskAssistantReply(detail.payload, {
      prompt,
      expectedFileText: expectedAssistantText,
      responseId,
    });
  } catch {
    return null;
  }
}

function inspectDistinctTurnDraftIds(detail, prompt) {
  if (!detail?.payload) return Object.freeze({ matched: false, turnIdPresent: false, draftIdPresent: false, distinct: false });
  try {
    const mapped = readGeminiHistoryTurnResponse(detail.payload, { prompt });
    const turnId = mapped.internal?.turnId;
    const draftId = mapped.internal?.draftId;
    const valid = (value) => typeof value === 'string' && value.length > 0
      && Buffer.byteLength(value, 'utf8') <= 512;
    const turnIdPresent = mapped.matched === true && valid(turnId);
    const draftIdPresent = mapped.matched === true && valid(draftId);
    return Object.freeze({ matched: mapped.matched === true, turnIdPresent, draftIdPresent,
      distinct: turnIdPresent && draftIdPresent && turnId !== draftId });
  } catch {
    return Object.freeze({ matched: false, turnIdPresent: false, draftIdPresent: false, distinct: false });
  }
}

/** Replay one native StreamGenerate action once, with exact-task hNvQHb reads around it. */
export async function submitGeminiTextActionOnce({
  client,
  action,
  capturedRequest,
  expectedOwner,
  expectedOwnerSha256,
  targetConversationId,
  visibleRouteId,
  beforePrompt,
  afterPrompt,
  expectedAssistantMarker,
  callerIntent,
  journalRoot,
  nativeActionCapture,
} = {}) {
  if (!client || typeof client.refreshSession !== 'function' || typeof client.readHistoryDetail !== 'function'
      || typeof client.generateTextOnce !== 'function' || !ACTIONS.has(action)) {
    fail('TEXT_ACTION_CLIENT_INVALID', 'A captured StreamGenerate action and owner-scoped text client are required.');
  }
  if (typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner.trim())
      || !DIGEST.test(expectedOwnerSha256 ?? '')
      || sha256(Buffer.from(expectedOwner.trim().toLowerCase(), 'utf8')) !== expectedOwnerSha256) {
    fail('TEXT_ACTION_OWNER_BINDING_INVALID', 'The expected account digest does not match the in-memory owner identity.');
  }
  if (typeof targetConversationId !== 'string' || !CONVERSATION_ID.test(targetConversationId)
      || visibleRouteId !== targetConversationId.slice(2)) {
    fail('TEXT_ACTION_TARGET_INVALID', 'The exact API and visible route conversation IDs must be bound.');
  }
  if (typeof callerIntent !== 'string' || !INTENT.test(callerIntent)) {
    fail('TEXT_ACTION_INTENT_INVALID', 'A fresh stable caller intent is required for this action.');
  }
  validatePrompt(beforePrompt, 'TEXT_ACTION_BEFORE_PROMPT_INVALID');
  validatePrompt(afterPrompt, 'TEXT_ACTION_AFTER_PROMPT_INVALID');
  if (typeof expectedAssistantMarker !== 'string' || !expectedAssistantMarker.trim()
      || expectedAssistantMarker.length > 256 || /\0/.test(expectedAssistantMarker)) {
    fail('TEXT_ACTION_ASSISTANT_MARKER_REQUIRED', 'A bounded expected assistant marker is required for semantic readback.');
  }
  if (action === 'regenerate' && beforePrompt !== afterPrompt) {
    fail('TEXT_ACTION_PROMPT_TRANSITION_INVALID', 'Regeneration must retain the exact user prompt.');
  }
  if (action !== 'regenerate' && beforePrompt === afterPrompt) {
    fail('TEXT_ACTION_PROMPT_TRANSITION_INVALID', 'Edit or continuation must use a distinct after-prompt.');
  }
  const captureProof = validateNativeActionCapture(nativeActionCapture, action);

  let requestSpec;
  try {
    requestSpec = buildCapturedTextRequest(client.contract, client.transport?.session, capturedRequest, {
      prompt: afterPrompt,
      preserveClientRequestId: true,
      preserveCapturedToken: true,
    });
  } catch (error) {
    throw error;
  }
  const outer = JSON.parse(new URLSearchParams(capturedRequest.body).get('f.req'));
  const inner = JSON.parse(outer[1]);
  // Bind only the SDK's source-mapped route context field. Searching the full
  // payload could accept a conversation ID echoed in user text or attachments.
  const targetIdMatches = valueAtPath(inner, CAPTURED_ROUTE_CONVERSATION_ID_PATH) === targetConversationId
    ? [CAPTURED_ROUTE_CONVERSATION_ID_PATH] : [];
  if (targetIdMatches.length !== 1) {
    fail('TEXT_ACTION_CAPTURE_TARGET_MISMATCH', 'The native request did not bind exactly once to the requested task conversation.');
  }
  const captureSummary = safeCaptureSummary(capturedRequest, requestSpec, targetIdMatches);

  const identity = await client.refreshSession(expectedOwner);
  const ownerMatched = identity?.ownerMatched === true && identity?.anonymousOwnerAbsent === true
    && client.verifiedOwner === expectedOwner.trim().toLowerCase();
  if (!ownerMatched) {
    return Object.freeze({
      operation: `text_${action}`,
      state: 'owner_gate_failed',
      requestSent: false,
      ownerMatched: identity?.ownerMatched === true,
      anonymousOwnerAbsent: identity?.anonymousOwnerAbsent === true,
      capture: captureSummary,
      browserCapture: Object.freeze({ ...captureProof }),
    });
  }

  let beforeDetail;
  try {
    beforeDetail = await client.readHistoryDetail({
      apiConversationId: targetConversationId,
      visibleRouteId,
      expectedIntent: beforePrompt,
    });
  } catch {
    fail('TEXT_ACTION_BEFORE_READBACK_FAILED', 'The target task could not be independently read before dispatch.');
  }
  const before = exactTaskReadback(beforeDetail, beforePrompt, targetConversationId);
  if (!before.proven) {
    clearReadback(beforeDetail.payload);
    fail('TEXT_ACTION_BEFORE_READBACK_UNBOUND', 'The exact task prompt and conversation were not confirmed before dispatch.');
  }
  const beforeAssistant = inspectAssistantTurn(beforeDetail, beforePrompt, expectedAssistantMarker);
  const beforeTurnIds = inspectDistinctTurnDraftIds(beforeDetail, beforePrompt);
  if (beforeAssistant?.promptPathCount !== 1 || beforeAssistant.taskTurnMatchCount !== 1
      || beforeAssistant.assistantNodePresent !== true || beforeTurnIds.distinct !== true) {
    clearReadback(beforeDetail.payload);
    fail('TEXT_ACTION_BEFORE_ASSISTANT_TURN_UNBOUND', 'The exact task prompt did not bind to one source-shaped assistant turn with distinct turn and draft identifiers.');
  }

  let direct = null;
  let directErrorCode = null;
  let decoded = null;
  let afterDetail = null;
  let after = null;
  let journalReconciled = false;
  let journalState = 'not_observed';
  let journalDispatchCount = 0;
  const intentKeyHash = mutationIntentDigest({ capability: 'text', actor: expectedOwner, callerIntent });
  try {
    try {
      direct = await client.generateTextOnce(capturedRequest, afterPrompt, {
        actor: expectedOwner,
        callerIntent,
        journalRoot,
        preserveClientRequestId: true,
        preserveCapturedToken: true,
      });
      journalState = 'response_received';
      journalDispatchCount = 1;
      try { decoded = decodeStreamGenerate(client, direct); } catch { decoded = null; }
    } catch (error) {
      directErrorCode = error instanceof GeminiClientError && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
        ? error.code : 'TEXT_ACTION_DIRECT_REQUEST_FAILED';
    }

    try {
      afterDetail = await client.readHistoryDetail({
        apiConversationId: targetConversationId,
        visibleRouteId,
        expectedIntent: afterPrompt,
      });
      after = exactTaskReadback(afterDetail, afterPrompt, targetConversationId);
    } catch {
      after = null;
    }

    const beforeStrings = beforeDetail?.payload ? stringsIn(beforeDetail.payload) : [];
    const afterAssistant = inspectAssistantTurn(afterDetail, afterPrompt, expectedAssistantMarker,
      typeof decoded?.responseId === 'string' ? decoded.responseId : undefined);
    const afterTurnIds = inspectDistinctTurnDraftIds(afterDetail, afterPrompt);
    const assistantMarkerInDirectReply = decoded?.matched === true && typeof decoded?.text === 'string'
      && decoded.text.trim() === expectedAssistantMarker;
    const assistantMarkerInReadback = afterAssistant?.exactAnswerMatched === true;
    const assistantMarkerWasAbsentBefore = beforeAssistant.exactAnswerMatched !== true;
    const responseId = typeof decoded?.responseId === 'string' ? decoded.responseId : null;
    const responseIdWasNew = Boolean(responseId && !beforeStrings.includes(responseId));
    const responseIdInReadback = Boolean(responseId && afterAssistant?.responseIdExactlyMatchedTurnId === true);
    const responseIdBindingVerified = responseIdWasNew && responseIdInReadback;
    const assistantMarkerNoveltyRequired = action !== 'regenerate';
    const promptTransitionVerified = action === 'regenerate'
      ? before.taskPromptMatched && after?.taskPromptMatched === true && beforePrompt === afterPrompt
      : before.taskPromptMatched && after?.taskPromptMatched === true && beforePrompt !== afterPrompt;
    const afterPriorAssistant = action === 'continue'
      ? inspectAssistantTurn(afterDetail, beforePrompt, expectedAssistantMarker)
      : null;
    const continuationPreservedPriorPrompt = action !== 'continue'
      || (afterPriorAssistant?.promptPathCount === 1 && afterPriorAssistant.taskTurnMatchCount === 1
        && afterPriorAssistant.assistantNodePresent === true);
    let journalSnapshot = direct?.journalPath
      ? await loadJournal(direct.journalPath).catch(() => null)
      : await findUnresolvedMutation('text', intentKeyHash, { root: journalRoot }).catch(() => undefined);
    if (journalSnapshot) {
      journalState = journalSnapshot.state;
      journalDispatchCount = journalSnapshot.dispatchCount;
    }
    const actionSemanticVerified = before.proven && after?.proven === true && promptTransitionVerified
      && afterTurnIds.distinct === true
      && continuationPreservedPriorPrompt
      && (!assistantMarkerNoveltyRequired || assistantMarkerWasAbsentBefore) && assistantMarkerInReadback
      && journalDispatchCount === 1
      && responseIdBindingVerified;

    if (actionSemanticVerified) {
      const pending = journalSnapshot && !['reconciled', 'confirmed_rejected', 'preflight_failed'].includes(journalSnapshot.state)
        ? journalSnapshot : null;
      if (pending?.jobPath) {
        try {
          await markMutationReconciled(pending.jobPath, { found: true, resultCategory: `text_${action}_hNv_readback` });
          journalReconciled = true;
          journalState = 'reconciled';
        } catch { journalState = 'reconciliation_failed'; }
      }
    }

    const response = responseSummary(direct, decoded);
    const state = actionSemanticVerified && journalReconciled ? 'verified'
      : journalDispatchCount === 1 ? (direct ? 'readback_pending' : 'outcome_unknown')
        : 'preflight_failed';
    return Object.freeze({
      operation: `text_${action}`,
      state,
      requestSent: journalDispatchCount === 1,
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      credentialPropagated: direct?.response?.credentialPropagated === true,
      directDispatchCount: journalDispatchCount,
      retryCount: 0,
      ...(directErrorCode ? { directErrorCode } : {}),
      callerIntentSha256: textSha256(callerIntent),
      actionPromptSha256: textSha256(afterPrompt),
      beforePromptSha256: textSha256(beforePrompt),
      expectedAssistantMarkerSha256: textSha256(expectedAssistantMarker),
      capture: captureSummary,
      browserCapture: Object.freeze({ ...captureProof }),
      response,
      readback: Object.freeze({
        beforeHttpStatus: before.httpStatus,
        beforeResponseBytes: before.responseBytes,
        beforeResponseSha256: before.responseSha256,
        beforeTaskPromptMatched: before.taskPromptMatched,
        beforeTurnIdPresent: beforeTurnIds.turnIdPresent,
        beforeDraftIdPresent: beforeTurnIds.draftIdPresent,
        beforeTurnAndDraftIdsDistinct: beforeTurnIds.distinct,
        afterHttpStatus: after?.httpStatus ?? null,
        afterResponseBytes: after?.responseBytes ?? null,
        afterResponseSha256: after?.responseSha256 ?? null,
        sameConversationMatched: after?.apiConversationIdMatched === true,
        afterTaskPromptMatched: after?.taskPromptMatched === true,
        afterTurnIdPresent: afterTurnIds.turnIdPresent,
        afterDraftIdPresent: afterTurnIds.draftIdPresent,
        afterTurnAndDraftIdsDistinct: afterTurnIds.distinct,
        legacyDirectCandidateMarkerMatch: assistantMarkerInDirectReply,
        assistantMarkerInReadback,
        assistantMarkerWasAbsentBefore,
        responseIdObserved: responseId !== null,
        responseIdWasNew,
        responseIdInReadback,
        hNvAnswerExactMatched: afterAssistant?.exactAnswerMatched === true,
        hNvAnswerSource: afterAssistant?.structuredContentPresent === true
          ? 'hNvQHb_turn.response.Ya.structuredContent'
          : afterAssistant?.plainTextCandidatePresent === true ? 'hNvQHb_turn.response.Ya.vda' : 'unavailable',
        hNvAnswerCandidateCount: Number.isInteger(afterAssistant?.assistantStringCount)
          ? afterAssistant.assistantStringCount : 0,
        streamResponseIdExactlyMatchedTurnId: afterAssistant?.responseIdExactlyMatchedTurnId === true,
        streamResponseIdExactlyMatchedDraftId: afterAssistant?.responseIdExactlyMatchedDraftId === true,
        streamResponseIdExactMatchKind: ['exactly_matches_turn_id_value', 'exactly_matches_draft_id_value',
          'exactly_matches_both_values', 'no_exact_value_match', 'comparison_unavailable']
          .includes(afterAssistant?.responseIdExactMatchKind) ? afterAssistant.responseIdExactMatchKind : 'comparison_unavailable',
        responseIdBindingVerified,
        priorPromptPreservedForContinuation: continuationPreservedPriorPrompt,
        semanticVerified: actionSemanticVerified,
      }),
      mutationJournal: Object.freeze({ state: journalState, dispatchCount: journalDispatchCount, reconciled: journalReconciled }),
      rawPromptConversationOrResponseValuesPersisted: false,
    });
  } finally {
    if (Buffer.isBuffer(direct?.response?.body)) direct.response.body.fill(0);
    clearReadback(beforeDetail?.payload);
    clearReadback(afterDetail?.payload);
    if (capturedRequest && typeof capturedRequest === 'object') {
      try { capturedRequest.body = ''; } catch { /* A caller may supply an immutable capture. */ }
      for (const name of Object.keys(capturedRequest.headers ?? {})) {
        try { capturedRequest.headers[name] = ''; } catch { /* Best-effort clearing only. */ }
      }
      try { capturedRequest.url = ''; } catch { /* A caller may supply an immutable capture. */ }
    }
  }
}

export const GEMINI_TEXT_LIFECYCLE_ACTIONS = Object.freeze([...ACTIONS]);
