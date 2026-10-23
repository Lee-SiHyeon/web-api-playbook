import { createHash } from 'node:crypto';
import { validateObservedContract } from './contract.mjs';
import { GeminiClientError } from './errors.mjs';
import { GeminiWebClient } from './client.mjs';
import { parseBatchResponse, requireRpcResponse } from './batch-response.mjs';
import {
  publicShareConversationRowCount,
  publicShareConversationRowHasId,
  readConversation,
  readPublicShareLinks,
} from './conversation-lifecycle.mjs';
import { findUnresolvedMutation, markMutationReconciled } from './journal.mjs';

const BATCH_PATH = '/_/BardChatUi/data/batchexecute';
const EXPECTED_RPC = Object.freeze({
  edit: 'MUAZcd',
  delete: 'GzXR5e',
  share_create: 'fuVx7',
  share_revoke: 'SgORbf',
});
const QUERY_KEYS = Object.freeze(['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt']);

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validJsonValue(value, depth = 0) {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 200 && value.every((item) => validJsonValue(item, depth + 1));
  if (isRecord(value)) return Object.keys(value).length <= 200
    && Object.entries(value).every(([key, item]) => key.length <= 150 && validJsonValue(item, depth + 1));
  return false;
}

function countExact(value, expected, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 50_000 || depth > 20) return 0;
  if (typeof value === 'string') return value === expected ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countExact(item, expected, depth + 1, budget), 0);
  if (isRecord(value)) return Object.values(value).reduce((sum, item) => sum + countExact(item, expected, depth + 1, budget), 0);
  return 0;
}

function countTemplatePlaceholder(value, name, depth = 0) {
  if (depth > 24) return 0;
  if (typeof value === 'string') return value === `{{${name}}}` ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTemplatePlaceholder(item, name, depth + 1), 0);
  if (isRecord(value)) return Object.values(value).reduce((sum, item) => sum + countTemplatePlaceholder(item, name, depth + 1), 0);
  return 0;
}

function bindMutationTemplate(value, bindings, depth = 0) {
  if (depth > 24) fail('LIFECYCLE_MUTATION_TEMPLATE_INVALID', 'The captured mutation argument template is too deeply nested.');
  if (typeof value === 'string') {
    const match = /^\{\{([A-Za-z][A-Za-z0-9]*)\}\}$/.exec(value);
    if (!match) return value;
    if (!Object.hasOwn(bindings, match[1])) fail('LIFECYCLE_MUTATION_TEMPLATE_INVALID', 'The captured mutation argument is missing a target binding.');
    return bindings[match[1]];
  }
  if (Array.isArray(value)) return value.map((item) => bindMutationTemplate(item, bindings, depth + 1));
  if (isRecord(value)) {
    if (Object.keys(value).length === 1 && typeof value.$literal === 'string') return value.$literal;
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, bindMutationTemplate(item, bindings, depth + 1)]));
  }
  return value;
}

function captureInstalledMutationContract(client, operationName) {
  const expectedRpc = EXPECTED_RPC[operationName];
  const operation = client?.contract?.operations?.[operationName];
  const base = client?.contract?.operations?.history_list;
  if (!expectedRpc || !operation || !base
      || operation.effect !== 'mutation' || operation.retryPolicy !== 'never'
      || operation.observation?.request !== true || operation.observation?.requestResponse !== false
      || operation.request?.rpcId !== expectedRpc
      || !Array.isArray(operation.request?.rpcArgsTemplate)
      || !Array.isArray(operation.request?.rpcCallTail)) {
    fail('LIFECYCLE_MUTATION_CONTRACT_REQUIRED', 'A captured request-only, no-retry mutation contract is required.');
  }
  const requestHeaders = client.transport.session?.requestHeaders?.[operationName]
    ?? client.transport.session?.requestHeaders?.history_list;
  if (!isRecord(requestHeaders)) fail('LIFECYCLE_MUTATION_HEADERS_REQUIRED', 'Current captured Gemini request headers are required for the mutation.');
  return {
    rpcId: expectedRpc,
    rpcCallTail: operation.request.rpcCallTail,
    requestHeaderValues: requestHeaders,
    request: Object.fromEntries(Object.entries(operation.request).filter(([key]) => key !== 'rpcCallTail')),
  };
}

/**
 * Make an isolated request-only mutation contract from one normal UI request
 * capture. This records only request shape; the UI response may have been
 * aborted by a write guard, so the first direct response remains unpaired.
 */
export function installLifecycleMutationCapture(baseContract, {
  operationName,
  capture,
} = {}) {
  const rpcId = EXPECTED_RPC[operationName];
  if (!rpcId || !isRecord(capture) || capture.rpcId !== rpcId) {
    fail('LIFECYCLE_MUTATION_CAPTURE_INVALID', 'A normal UI request capture for the requested lifecycle action is required.');
  }
  const base = baseContract?.operations?.history_list;
  const request = capture.request;
  const observedBodyFields = request?.bodyFieldNames ?? request?.formFieldNames;
  if (!base || !isRecord(request)
      || request.method !== 'POST' || request.origin !== base.request.origin
      || request.path !== BATCH_PATH || request.path !== base.request.path
      || !Array.isArray(request.queryKeys) || request.queryKeys.length !== QUERY_KEYS.length
      || request.queryKeys.some((key, index) => key !== QUERY_KEYS[index])
      || !Array.isArray(request.headerNames) || request.headerNames.some((name) => !base.request.headerNames.some((allowed) => allowed.toLowerCase() === String(name).toLowerCase()))
      || typeof request.contentType !== 'string'
      || request.contentType.toLowerCase() !== base.request.contentType.toLowerCase()
      || !Array.isArray(observedBodyFields) || observedBodyFields.length !== 2
      || observedBodyFields.some((key, index) => key !== base.request.bodyFieldNames[index])
      || !Array.isArray(capture.rpcCallTail) || capture.rpcCallTail.length > 4
      || !capture.rpcCallTail.every((value) => validJsonValue(value))) {
    fail('LIFECYCLE_MUTATION_CAPTURE_INVALID', 'The normal UI mutation request did not match the captured Gemini batch envelope.');
  }
  const mutationOperation = {
    observation: { request: true, requestResponse: false },
    effect: 'mutation',
    retryPolicy: 'never',
    request: {
      ...Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'formFieldNames')),
      bodyFieldNames: Object.freeze([...observedBodyFields]),
      rpcId,
      rpcCallTail: Object.freeze([...capture.rpcCallTail]),
    },
  };
  return validateObservedContract({
    ...baseContract,
    operations: {
      ...baseContract.operations,
      [operationName]: mutationOperation,
    },
  });
}

/** Build a fresh batch request while preserving the SDK-captured call tail. */
export function buildCapturedLifecycleMutationRequest(contract, client, {
  operationName,
  rpcId,
  args,
} = {}) {
  const operation = contract?.operations?.[operationName];
  const context = client?.transport?.session?.batchContext;
  if (!operation || operation.observation?.request !== true || operation.observation?.requestResponse !== false
      || operation.effect !== 'mutation' || operation.retryPolicy !== 'never'
      || operation.request?.rpcId !== EXPECTED_RPC[operationName] || rpcId !== operation.request.rpcId
      || !Array.isArray(args) || !validJsonValue(args) || !context) {
    fail('LIFECYCLE_MUTATION_REQUEST_INVALID', 'A captured no-retry mutation request and fresh Gemini session are required.');
  }
  const baseSequence = Number(client.nextHistoryRequestId);
  if (!Number.isSafeInteger(baseSequence) || baseSequence < 0 || baseSequence > 999_999_999_999) {
    fail('SESSION_CONTEXT_REQUIRED', 'A numeric Gemini request sequence is required for this mutation.');
  }
  const requestId = String(client.nextHistoryRequestId++);
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
    if (!Object.hasOwn(values, name)) fail('LIFECYCLE_MUTATION_CAPTURE_INVALID', 'The captured mutation query contains an unsupported field.');
    return [name, values[name]];
  });
  const call = [rpcId, JSON.stringify(args), ...operation.request.rpcCallTail];
  const fReq = JSON.stringify([[call]]);
  const fields = { 'f.req': fReq, at: context.at };
  const body = new URLSearchParams(operation.request.bodyFieldNames.map((name) => [name, fields[name]])).toString();
  return Object.freeze({
    method: operation.request.method,
    path: operation.request.path,
    query: Object.freeze(query.map((entry) => Object.freeze(entry))),
    headers: Object.freeze(client.transport.session.requestHeaders?.[operationName]
      ?? client.transport.session.requestHeaders?.history_list ?? {}),
    contentType: operation.request.contentType,
    body,
  });
}

/**
 * Dispatch one caller-confirmed rename/delete request, after owner verification
 * and a same-ID direct history read. The API accepts any explicit authorized
 * target; it does not hardcode this task's conversation.
 */
export async function mutateConversationOnce(client, {
  operationName,
  requestCapture,
  rpcId,
  args,
  targetConversationId,
  requiredPayloadValues,
  expectedOwner,
  confirmed,
  callerIntent,
  journalRoot,
} = {}) {
  if (!requestCapture && ['edit', 'delete'].includes(operationName)) {
    requestCapture = captureInstalledMutationContract(client, operationName);
  }
  if (requestCapture && rpcId === undefined) rpcId = requestCapture.rpcId;
  if (requestCapture && args === undefined) {
    const template = requestCapture.request?.rpcArgsTemplate;
    const bindings = { conversationId: targetConversationId };
    if (requiredPayloadValues?.length === 1) bindings.newTitle = requiredPayloadValues[0];
    if (!Array.isArray(template) || countTemplatePlaceholder(template, 'conversationId') !== 1
        || (requiredPayloadValues?.length === 1 && countTemplatePlaceholder(template, 'newTitle') !== 1)) {
      fail('LIFECYCLE_MUTATION_TEMPLATE_INVALID', 'The captured mutation contract cannot bind this conversation payload.');
    }
    args = bindMutationTemplate(template, bindings);
  }
  if (!['edit', 'delete'].includes(operationName) || confirmed !== true
      || typeof targetConversationId !== 'string' || !/^c_[0-9a-f]{16}$/.test(targetConversationId)
      || !Array.isArray(requiredPayloadValues) || requiredPayloadValues.some((value) => typeof value !== 'string')
      || typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)
      || typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    fail('LIFECYCLE_MUTATION_CONFIRMATION_REQUIRED', 'A confirmed owner-bound lifecycle target and stable caller intent are required.');
  }
  const expectedFields = [targetConversationId, ...requiredPayloadValues];
  for (const expected of expectedFields) {
    if (countExact(args, expected) !== 1) {
      fail('LIFECYCLE_MUTATION_TARGET_BINDING_FAILED', 'The captured mutation payload did not contain each authorized target value exactly once.');
    }
  }
  const contract = installLifecycleMutationCapture(client.contract, { operationName, capture: requestCapture });
  const session = {
    ...client.transport.session,
    requestHeaders: Object.freeze({
      ...(client.transport.session?.requestHeaders ?? {}),
      [operationName]: Object.freeze({ ...(requestCapture.requestHeaderValues ?? {}) }),
    }),
  };
  const writer = new GeminiWebClient({ contract, session, fetchImpl: client.transport.fetch });
  try {
    const ownerGate = await writer.refreshSession(expectedOwner);
    if (ownerGate.ownerMatched !== true || ownerGate.anonymousOwnerAbsent !== true) {
      fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
    }
    const preflight = await readConversation(writer, { expectedOwner, conversationId: targetConversationId });
    const preflightIdMatched = preflight.summary.apiConversationIdMatched === true;
    const preflightRouteBound = preflight.binding.bound === true;
    if (preflight.ownerMatched !== true || preflight.anonymousOwnerAbsent !== true
        || preflightIdMatched !== true || preflightRouteBound !== true) {
      fail('LIFECYCLE_MUTATION_PREFLIGHT_FAILED', 'The authorized conversation could not be bound by direct history read.');
    }
    if (isRecord(preflight.payload)) {
      for (const key of Object.keys(preflight.payload)) delete preflight.payload[key];
    } else if (Array.isArray(preflight.payload)) preflight.payload.length = 0;
    const requestSpec = buildCapturedLifecycleMutationRequest(contract, writer, { operationName, rpcId, args });
    const dispatched = await writer.captureMutationResponseOnce(operationName, requestSpec, {
      journalRoot,
      actor: expectedOwner,
      callerIntent,
    });
    const response = dispatched.response;
    let responseRpcDecoded = false;
    try {
      const base = requireCapturedOperation(contract, 'history_list');
      const frames = parseBatchResponse(response.body, {
        lengthUnit: base.response.frameLengthUnit,
        frameLengthOverheadUnits: base.response.frameLengthOverheadUnits,
      });
      requireRpcResponse(frames, rpcId);
      responseRpcDecoded = true;
    } catch {
      responseRpcDecoded = false;
    }
    const responseMetadata = Object.freeze({
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      responseBytes: response.responseBytes,
      responseSha256: createHash('sha256').update(response.body).digest('hex'),
      credentialPropagated: response.credentialPropagated,
      responseContractCaptured: false,
      responseRpcDecoded,
    });
    response.body.fill(0);
    return Object.freeze({
      operationName,
      rpcId,
      jobId: dispatched.jobId,
      journalPath: dispatched.journalPath,
      intentKeyHash: dispatched.intentKeyHash,
      wireBodyDigest: dispatched.wireBodyDigest,
      ownerMatched: ownerGate.ownerMatched,
      anonymousOwnerAbsent: ownerGate.anonymousOwnerAbsent,
      preflightConversationIdMatched: preflightIdMatched,
      preflightRouteBindingVerified: preflightRouteBound,
      response: responseMetadata,
    });
  } finally {
    writer.transport.session = null;
  }
}

/** Create one owner-bound public share from an exact normal-UI request capture.
 * The decoded response stays on a non-enumerable in-memory property so the
 * caller can inspect its link without serializing that value into a receipt. */
export async function createConversationShareOnce(client, {
  requestCapture,
  rpcId,
  args,
  targetConversationId,
  expectedOwner,
  confirmed,
  callerIntent,
  journalRoot,
} = {}) {
  if (confirmed !== true || typeof targetConversationId !== 'string'
      || !/^c_[0-9a-f]{16}$/.test(targetConversationId)
      || typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)
      || typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    fail('SHARE_MUTATION_CONFIRMATION_REQUIRED', 'A confirmed owner-bound share target and stable caller intent are required.');
  }
  if (!Array.isArray(args) || countExact(args, targetConversationId) !== 1) {
    fail('SHARE_MUTATION_TARGET_BINDING_FAILED', 'The normal UI share request must bind the authorized conversation exactly once.');
  }
  const operationName = 'share_create';
  const contract = installLifecycleMutationCapture(client.contract, { operationName, capture: requestCapture });
  const session = {
    ...client.transport.session,
    requestHeaders: Object.freeze({
      ...(client.transport.session?.requestHeaders ?? {}),
      [operationName]: Object.freeze({ ...(requestCapture.requestHeaderValues ?? {}) }),
    }),
  };
  const writer = new GeminiWebClient({ contract, session, fetchImpl: client.transport.fetch });
  try {
    const ownerGate = await writer.refreshSession(expectedOwner);
    if (ownerGate.ownerMatched !== true || ownerGate.anonymousOwnerAbsent !== true) {
      fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
    }
    const preflight = await readConversation(writer, {
      expectedOwner,
      conversationId: targetConversationId,
    });
    const preflightIdMatched = preflight.summary.apiConversationIdMatched === true;
    const preflightRouteBound = preflight.binding.bound === true;
    if (preflight.ownerMatched !== true || preflight.anonymousOwnerAbsent !== true
        || preflightIdMatched !== true || preflightRouteBound !== true) {
      fail('SHARE_MUTATION_PREFLIGHT_FAILED', 'The authorized conversation could not be bound by direct history read.');
    }
    if (isRecord(preflight.payload)) {
      for (const key of Object.keys(preflight.payload)) delete preflight.payload[key];
    } else if (Array.isArray(preflight.payload)) preflight.payload.length = 0;

    const requestSpec = buildCapturedLifecycleMutationRequest(contract, writer, {
      operationName, rpcId, args,
    });
    const dispatched = await writer.captureMutationResponseOnce(operationName, requestSpec, {
      journalRoot,
      actor: expectedOwner,
      callerIntent,
    });
    const response = dispatched.response;
    const responseMetadata = {
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      responseBytes: response.responseBytes,
      responseSha256: createHash('sha256').update(response.body).digest('hex'),
      credentialPropagated: response.credentialPropagated,
      responseContractCaptured: false,
      responseRpcDecoded: false,
    };
    let responseData;
    try {
      const base = requireCapturedOperation(contract, 'history_list');
      const frames = parseBatchResponse(response.body, {
        lengthUnit: base.response.frameLengthUnit,
        frameLengthOverheadUnits: base.response.frameLengthOverheadUnits,
      });
      responseData = requireRpcResponse(frames, rpcId).data;
      responseMetadata.responseRpcDecoded = true;
    } catch {
      responseData = undefined;
    } finally {
      response.body.fill(0);
    }
    const summary = {
      operationName,
      rpcId,
      jobId: dispatched.jobId,
      journalPath: dispatched.journalPath,
      intentKeyHash: dispatched.intentKeyHash,
      wireBodyDigest: dispatched.wireBodyDigest,
      ownerMatched: ownerGate.ownerMatched,
      anonymousOwnerAbsent: ownerGate.anonymousOwnerAbsent,
      preflightConversationIdMatched: preflightIdMatched,
      preflightRouteBindingVerified: preflightRouteBound,
      response: Object.freeze(responseMetadata),
    };
    Object.defineProperty(summary, 'internal', {
      value: Object.freeze({ responseData }),
      enumerable: false,
    });
    return Object.freeze(summary);
  } finally {
    writer.transport.session = null;
  }
}

/** Revoke one task-bound public link after its exact owner-list row is preflighted. */
export async function revokePublicShareLinkOnce(client, {
  requestCapture,
  rpcId,
  args,
  targetShareId,
  targetConversationTitle,
  expectedRemainingTaskLinkCount,
  expectedOwner,
  confirmed,
  callerIntent,
  journalRoot,
} = {}) {
  if (!requestCapture) requestCapture = captureInstalledMutationContract(client, 'share_revoke');
  if (rpcId === undefined) rpcId = requestCapture.rpcId;
  if (args === undefined) {
    const template = requestCapture.request?.rpcArgsTemplate;
    if (!Array.isArray(template) || countTemplatePlaceholder(template, 'shareId') !== 1) {
      fail('SHARE_REVOKE_TEMPLATE_INVALID', 'The captured share-revoke contract cannot bind the selected link.');
    }
    args = bindMutationTemplate(template, { shareId: targetShareId });
  }
  if (confirmed !== true || typeof targetShareId !== 'string'
      || !/^[A-Za-z0-9._~-]{8,256}$/.test(targetShareId)
      || typeof targetConversationTitle !== 'string' || !targetConversationTitle.trim()
      || targetConversationTitle.length > 160 || /[\0\r\n]/.test(targetConversationTitle)
      || !Number.isInteger(expectedRemainingTaskLinkCount)
      || expectedRemainingTaskLinkCount < 1 || expectedRemainingTaskLinkCount > 2
      || typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)
      || typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    fail('SHARE_REVOKE_CONFIRMATION_REQUIRED', 'A confirmed owner-bound task share and stable caller intent are required.');
  }
  if (!Array.isArray(args) || countExact(args, targetShareId) !== 1) {
    fail('SHARE_REVOKE_TARGET_BINDING_FAILED', 'The captured owner revoke payload must contain the authorized share ID exactly once.');
  }
  const operationName = 'share_revoke';
  const contract = installLifecycleMutationCapture(client.contract, { operationName, capture: requestCapture });
  const session = {
    ...client.transport.session,
    requestHeaders: Object.freeze({
      ...(client.transport.session?.requestHeaders ?? {}),
      [operationName]: Object.freeze({ ...(requestCapture.requestHeaderValues ?? {}) }),
    }),
  };
  const writer = new GeminiWebClient({ contract, session, fetchImpl: client.transport.fetch });
  let ownerRows;
  let dispatched;
  try {
    const ownerGate = await writer.refreshSession(expectedOwner);
    if (ownerGate.ownerMatched !== true || ownerGate.anonymousOwnerAbsent !== true) {
      fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
    }
    ownerRows = await readPublicShareLinks(writer, { expectedOwner });
    const preflightTaskRowCount = publicShareConversationRowCount(ownerRows.internal.data, targetConversationTitle);
    const preflightIdRowCount = publicShareConversationRowHasId(ownerRows.internal.data, targetConversationTitle, targetShareId);
    if (ownerRows.ownerMatched !== true || ownerRows.anonymousOwnerAbsent !== true
        || preflightTaskRowCount !== expectedRemainingTaskLinkCount || preflightIdRowCount !== 1) {
      fail('SHARE_REVOKE_PREFLIGHT_FAILED', 'The owner list did not bind the selected public link to the task row.');
    }
    if (ownerRows.internal?.data && typeof ownerRows.internal.data === 'object') {
      const wipe = (value) => {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 1) {
            if (typeof value[i] === 'string') value[i] = '';
            else wipe(value[i]);
          }
          value.length = 0;
        } else if (value && typeof value === 'object') {
          for (const key of Object.keys(value)) {
            if (typeof value[key] === 'string') value[key] = '';
            else wipe(value[key]);
            delete value[key];
          }
        }
      };
      wipe(ownerRows.internal.data);
    }
    const requestSpec = buildCapturedLifecycleMutationRequest(contract, writer, {
      operationName, rpcId, args,
    });
    dispatched = await writer.captureMutationResponseOnce(operationName, requestSpec, {
      journalRoot,
      actor: expectedOwner,
      callerIntent,
    });
    const response = dispatched.response;
    const responseSha256 = createHash('sha256').update(response.body).digest('hex');
    let responseRpcDecoded = false;
    try {
      const base = requireCapturedOperation(contract, 'history_list');
      const frames = parseBatchResponse(response.body, {
        lengthUnit: base.response.frameLengthUnit,
        frameLengthOverheadUnits: base.response.frameLengthOverheadUnits,
      });
      requireRpcResponse(frames, rpcId);
      responseRpcDecoded = true;
    } catch {
      responseRpcDecoded = false;
    } finally {
      response.body.fill(0);
    }
    const readback = await readPublicShareLinks(writer, { expectedOwner });
    const readbackTaskRowCount = publicShareConversationRowCount(readback.internal.data, targetConversationTitle);
    const readbackIdRowCount = publicShareConversationRowHasId(readback.internal.data, targetConversationTitle, targetShareId);
    const readbackVerified = readback.ownerMatched === true && readback.anonymousOwnerAbsent === true
      && readback.httpStatus === 200 && readbackTaskRowCount === expectedRemainingTaskLinkCount - 1
      && readbackIdRowCount === 0 && readback.shareCount === ownerRows.shareCount - 1;
    if (readback.internal?.data && typeof readback.internal.data === 'object') {
      const wipe = (value) => {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 1) {
            if (typeof value[i] === 'string') value[i] = '';
            else wipe(value[i]);
          }
          value.length = 0;
        } else if (value && typeof value === 'object') {
          for (const key of Object.keys(value)) {
            if (typeof value[key] === 'string') value[key] = '';
            else wipe(value[key]);
            delete value[key];
          }
        }
      };
      wipe(readback.internal.data);
    }
    let journalReconciled = false;
    if (readbackVerified) {
      const pending = await findUnresolvedMutation('share_revoke', dispatched.intentKeyHash, { root: journalRoot });
      if (pending) {
        await markMutationReconciled(pending.jobPath, { found: true, resultCategory: 'share_link_absent_after_owner_readback' });
        journalReconciled = true;
      }
    }
    return Object.freeze({
      operationName,
      rpcId,
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      credentialPropagated: response.credentialPropagated,
      dispatchCount: 1,
      retryCount: 0,
      mutationHttpStatus: response.httpStatus,
      mutationContentType: response.contentType,
      mutationResponseBytes: response.responseBytes,
      mutationResponseSha256: responseSha256,
      responseRpcDecoded,
      preflightTaskRowCount,
      preflightShareIdRowMatched: preflightIdRowCount === 1,
      readbackHttpStatus: readback.httpStatus,
      readbackTaskRowCount,
      readbackShareIdAbsent: readbackIdRowCount === 0,
      readbackTotalShareCount: readback.shareCount,
      ownerListReadback: Object.freeze({
        httpStatus: readback.httpStatus,
        contentType: readback.contentType,
        responseBytes: readback.responseBytes,
        responseSha256: readback.responseSha256,
        request: Object.freeze({
          method: readback.request.method,
          origin: readback.request.origin,
          path: readback.request.path,
          queryKeys: readback.request.queryKeys,
          headerNames: readback.request.headerNames,
          bodyFieldNames: readback.request.formFieldNames,
          contentType: readback.request.contentType,
          valuesPersisted: false,
        }),
      }),
      readbackVerified,
      journalId: dispatched.jobId,
      intentKeyHash: dispatched.intentKeyHash,
      wireBodyDigest: dispatched.wireBodyDigest,
      journalReconciled,
    });
  } finally {
    writer.transport.session = null;
  }
}

export async function reconcileLifecycleMutation(journalPath, { found, resultCategory } = {}) {
  return markMutationReconciled(journalPath, { found, resultCategory });
}
