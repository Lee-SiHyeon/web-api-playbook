import { createHash } from 'node:crypto';
import { validateContractRegistry } from './contracts.mjs';
import { fail } from './errors.mjs';
import { GROK_CONVERSATION_OPERATION_IDS as IDS } from './grok-conversations.mjs';

const SERVICE_ORIGIN = 'https://grok.com';
const CREATE_PATH = '/rest/app-chat/conversations';
const CREATE_SOURCE_URL = 'https://cdn.grok.com/_next/static/chunks/27akar72ihacg.js';
const CREATE_SOURCE_SHA256 = '8dcfb562e2b3f83f866c23c82f73503c52a409620c8830697d6cade848644759';
const CREATE_SOURCE_FUNCTION = 'chatCreateConversationRaw';
const CREATE_ADAPTER_URL = 'https://cdn.grok.com/_next/static/chunks/205b03gn_m2ip.js';
const CREATE_ADAPTER_SHA256 = '45e567d74dfd50b5a111359914000af956061ada3dc9e76531eec31c1c4dfeec';
const CREATE_PERMIT = 'first-live:conversation.create';
const PAGE_LIMIT = 20;
const TITLE_MAX = 256;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireSafeText(value, code, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw fail(code);
  }
  return value;
}

function requireIntent(value, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw fail(code);
  }
  return value;
}

function exactEmptyChatCreateBody(body) {
  return plainObject(body)
    && Object.keys(body).length === 2
    && Object.keys(body).join(',') === 'systemPromptName,temporary'
    && Object.hasOwn(body, 'systemPromptName') && body.systemPromptName === ''
    && Object.hasOwn(body, 'temporary') && body.temporary === false;
}

function scrub(value, seen = new Set()) {
  if (typeof value === 'string' || value === null || value === undefined) return;
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      try {
        if (typeof value[index] === 'string') value[index] = '';
        else scrub(value[index], seen);
      } catch { /* Best-effort clearing of returned API values. */ }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = '';
      else scrub(value[key], seen);
    } catch { /* Frozen summaries are safe to leave to garbage collection. */ }
  }
}

/** Build the first-live conversation.create operation from one guarded UI capture. */
export function buildCapturedGrokConversationCreateOperation(capture, {
  capturedAt = new Date().toISOString(),
  directReplayReceipt = 'verification/grok-conversation-crud-live-2026-10-06.json',
} = {}) {
  if (!plainObject(capture)
      || capture.method !== 'POST' || capture.origin !== SERVICE_ORIGIN || capture.path !== CREATE_PATH
      || capture.contentType !== 'application/json'
      || capture.sourceUrl !== CREATE_SOURCE_URL || capture.sourceSha256 !== CREATE_SOURCE_SHA256
      || capture.sourceFunctionName !== CREATE_SOURCE_FUNCTION
      || capture.normalUiAdapterMatched !== true
      || capture.browserRequestAbortConfirmed !== true || capture.browserRequestReachedProvider !== false
      || !Array.isArray(capture.requestHeaderNames)
      || !capture.requestHeaderNames.some(name => String(name).toLowerCase() === 'content-type')
      || !Array.isArray(capture.cookieNames) || !capture.cookieNames.includes('sso')
      || !exactEmptyChatCreateBody(capture.body)
      || !/^[a-f0-9]{64}$/.test(capture.requestBodySha256 ?? '')
      || capture.requestBodySha256 !== sha256(JSON.stringify(capture.body))
      || typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))
      || typeof directReplayReceipt !== 'string' || !directReplayReceipt.startsWith('verification/')) {
    throw fail('CONVERSATION_CREATE_CAPTURE_INVALID');
  }
  const operation = {
    id: IDS.create,
    kind: 'submit',
    method: 'POST',
    urlTemplate: `${SERVICE_ORIGIN}${CREATE_PATH}`,
    authMode: 'session',
    request: {
      inputSchema: {
        properties: {
          body: {
            type: 'object',
            properties: {
              systemPromptName: { type: 'string', maxLength: 256 },
              temporary: { type: 'boolean' },
            },
            required: ['systemPromptName', 'temporary'],
          },
        },
        required: ['body'],
      },
      bodyTemplate: { systemPromptName: '', temporary: false },
      bodyEncoding: 'json',
      contentType: 'application/json',
      credentialBindings: { cookies: ['sso'], headers: [] },
    },
    response: {
      mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 262_144,
    },
    responseJobIdPointer: '/conversationId',
    evidence: {
      source: 'first_party_sdk_contract',
      capturedAt,
      requestMethod: 'POST',
      requestPath: CREATE_PATH,
      httpStatus: null,
      responseContentType: 'unknown',
      securityBoundary: 'not_applicable',
      securitySignals: [],
      sourceUrl: CREATE_SOURCE_URL,
      sourceSha256: CREATE_SOURCE_SHA256,
      sourceFunctionName: CREATE_SOURCE_FUNCTION,
      sourceDeclaredHeaders: ['Content-Type'],
      browserWriteCapture: false,
      clientCallsiteFabricated: false,
      browserHeadersCaptured: false,
      directReplayReceipt,
      firstLiveReplayPermit: true,
    },
    effect: 'chat_write',
  };
  return Object.freeze(operation);
}

/** Build the source-only first-live empty-chat contract when the native UI has no standalone create request. */
export function buildSourceGrokConversationCreateOperation(source, {
  capturedAt = new Date().toISOString(),
  directReplayReceipt = 'verification/grok-conversation-crud-live-2026-10-06.json',
} = {}) {
  if (!plainObject(source) || source.sourceMode !== 'first_party_sdk_contract'
      || source.normalUiRequestObserved !== false || source.normalUiAdapterMatched !== true
      || source.sourceUrl !== CREATE_SOURCE_URL || source.sourceSha256 !== CREATE_SOURCE_SHA256
      || source.sourceFunctionName !== CREATE_SOURCE_FUNCTION
      || source.adapterSourceUrl !== CREATE_ADAPTER_URL || source.adapterSourceSha256 !== CREATE_ADAPTER_SHA256
      || !exactEmptyChatCreateBody(source.body)
      || source.sourceBodySha256 !== sha256(JSON.stringify(source.body))
      || typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))
      || typeof directReplayReceipt !== 'string' || !directReplayReceipt.startsWith('verification/')) {
    throw fail('CONVERSATION_CREATE_SOURCE_CONTRACT_INVALID');
  }
  return Object.freeze({
    id: IDS.create,
    kind: 'submit',
    method: 'POST',
    urlTemplate: `${SERVICE_ORIGIN}${CREATE_PATH}`,
    authMode: 'session',
    request: {
      inputSchema: {
        properties: {
          body: {
            type: 'object',
            properties: {
              systemPromptName: { type: 'string', maxLength: 256 },
              temporary: { type: 'boolean' },
            },
            required: ['systemPromptName', 'temporary'],
          },
        },
        required: ['body'],
      },
      bodyTemplate: { systemPromptName: '', temporary: false },
      bodyEncoding: 'json',
      contentType: 'application/json',
      credentialBindings: { cookies: ['sso'], headers: [] },
    },
    response: {
      mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 262_144,
    },
    responseJobIdPointer: '/conversationId',
    evidence: {
      source: 'first_party_sdk_contract',
      capturedAt,
      requestMethod: 'POST',
      requestPath: CREATE_PATH,
      httpStatus: null,
      responseContentType: 'unknown',
      securityBoundary: 'not_applicable',
      securitySignals: [],
      sourceUrl: CREATE_SOURCE_URL,
      sourceSha256: CREATE_SOURCE_SHA256,
      sourceFunctionName: CREATE_SOURCE_FUNCTION,
      sourceDeclaredHeaders: ['Content-Type'],
      browserWriteCapture: false,
      clientCallsiteFabricated: false,
      browserHeadersCaptured: false,
      directReplayReceipt,
      firstLiveReplayPermit: true,
    },
    effect: 'chat_write',
  });
}

/** Install one source-captured operation in a task-local registry overlay. */
export function installCapturedGrokConversationCreate(registry, capture, options = {}) {
  if (!plainObject(registry) || !Array.isArray(registry.operations)
      || registry.operations.some(operation => operation?.id === IDS.create)) {
    throw fail('CONVERSATION_CREATE_REGISTRY_INVALID');
  }
  const operation = buildCapturedGrokConversationCreateOperation(capture, options);
  const overlay = structuredClone(registry);
  overlay.operations.push(operation);
  validateContractRegistry(overlay);
  return overlay;
}

/** Finalize the create contract only from its actual response and same-owner readback. */
export function finalizeCapturedGrokConversationCreateOperation(operation, {
  directReplay,
  semanticReadbackVerified,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!plainObject(operation) || operation.id !== IDS.create || !plainObject(directReplay)
      || directReplay.source !== 'direct_http' || directReplay.status !== 200
      || directReplay.parsedData !== true || directReplay.ownerVerified !== true
      || directReplay.tlsVerified !== true || directReplay.trustEnv !== false
      || directReplay.redirectsFollowed !== false || directReplay.explicitRetries !== 0
      || directReplay.attemptCountPerMutation !== 1
      || typeof directReplay.responseDigestPersisted !== 'boolean'
      || (directReplay.responseDigestPersisted === true
        && !/^[a-f0-9]{64}$/.test(directReplay.responseSha256 ?? ''))
      || (directReplay.responseDigestPersisted === false && directReplay.responseSha256 !== undefined)
      || !Number.isSafeInteger(directReplay.responseBytes) || directReplay.responseBytes < 0
      || !/^[a-f0-9]{64}$/.test(directReplay.requestDigest ?? '')
      || !/^[a-f0-9]{64}$/.test(directReplay.intentDigest ?? '')
      || !Array.isArray(directReplay.requestHeaderNames)
      || !Array.isArray(directReplay.cookieNames)
      || semanticReadbackVerified !== true
      || !Number.isFinite(Date.parse(observedAt))) throw fail('CONVERSATION_CREATE_DIRECT_PROOF_INVALID');
  const finalized = structuredClone(operation);
  finalized.evidence = {
    ...finalized.evidence,
    capturedAt: observedAt,
    httpStatus: 200,
    responseContentType: 'application/json',
    semanticReadbackVerified: true,
    observedResponseSubstantive: directReplay.responseJobIdObserved === true,
    directReplay: { ...directReplay, observedAt },
  };
  if (finalized.evidence.observedResponseSubstantive !== true) {
    throw fail('CONVERSATION_CREATE_SERVICE_ID_UNOBSERVED');
  }
  return Object.freeze(finalized);
}

function conversationRecord(data) {
  return plainObject(data?.conversation) ? data.conversation : data;
}

function allStrings(value, depth = 0, out = [], budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 50_000 || depth > 16 || value === null || value === undefined) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, depth + 1, out, budget);
  else if (plainObject(value)) for (const item of Object.values(value)) allStrings(item, depth + 1, out, budget);
  return out;
}

function readFieldsMatch(value, { conversationId, titleHash, requireTitle = false } = {}) {
  const record = conversationRecord(value);
  const strings = allStrings(value);
  return {
    record,
    sameConversationId: record?.conversationId === conversationId,
    viewerIsOwner: record?.viewerIsOwner === true,
    titleMatched: typeof record?.title === 'string' && sha256(record.title) === titleHash,
    taskTitleTextFound: strings.some(text => typeof text === 'string' && sha256(text) === titleHash),
    mediaTypeCount: Array.isArray(record?.mediaTypes) ? record.mediaTypes.length : null,
    workspaceCount: Array.isArray(record?.workspaces) ? record.workspaces.length : null,
    taskResultPresent: record?.taskResult !== undefined && record?.taskResult !== null
      && !(plainObject(record.taskResult) && Object.keys(record.taskResult).length === 0),
    requireTitle,
  };
}

async function fullConversationSnapshot(conversations) {
  const ids = new Set();
  const seenTokens = new Set();
  let pageToken;
  let pages = 0;
  let status = null;
  for (; pages < PAGE_LIMIT; pages += 1) {
    const result = await conversations.list({ pageSize: 1_000, ...(pageToken ? { pageToken } : {}) });
    status = Number.isInteger(result?.status) ? result.status : null;
    if (status !== 200 || !Array.isArray(result?.data?.conversations)) throw fail('CONVERSATION_CRUD_LIST_READ_FAILED');
    for (const row of result.data.conversations) {
      if (!plainObject(row) || typeof row.conversationId !== 'string' || !row.conversationId) {
        throw fail('CONVERSATION_CRUD_LIST_SHAPE_INVALID');
      }
      ids.add(row.conversationId);
    }
    const next = result.data.nextPageToken;
    scrub(result.data);
    if (typeof next !== 'string' || !next) return { ids, pages: pages + 1, status, complete: true };
    if (seenTokens.has(next)) throw fail('CONVERSATION_CRUD_CURSOR_CYCLE');
    seenTokens.add(next);
    pageToken = next;
  }
  return { ids, pages, status, complete: false };
}

function sameSet(left, right, excluded = undefined) {
  const a = new Set([...left].filter(value => value !== excluded));
  const b = new Set([...right].filter(value => value !== excluded));
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function digestIdSet(values) {
  return sha256(JSON.stringify([...values].sort()));
}

function safeMutationFields(result, prior = {}) {
  const source = result?.sourceDiscoveryReceipt;
  return {
    ...prior,
    state: typeof result?.state === 'string' ? result.state : prior.state ?? 'needs_review',
    verified: result?.verified === true || prior.verified === true,
    httpStatus: Number.isInteger(result?.httpStatus) ? result.httpStatus
      : Number.isInteger(source?.responseStatus) ? source.responseStatus : prior.httpStatus ?? null,
    readbackStatus: Number.isInteger(result?.readbackStatus) ? result.readbackStatus : prior.readbackStatus ?? null,
    requestDigest: /^[a-f0-9]{64}$/.test(source?.requestDigest ?? '') ? source.requestDigest : prior.requestDigest ?? null,
    intentDigest: /^[a-f0-9]{64}$/.test(source?.intentDigest ?? '') ? source.intentDigest : prior.intentDigest ?? null,
    responseBytes: Number.isSafeInteger(source?.responseBytes) ? source.responseBytes : prior.responseBytes ?? null,
    sourceFunctionName: typeof source?.sourceFunctionName === 'string' ? source.sourceFunctionName : prior.sourceFunctionName ?? null,
    method: typeof source?.method === 'string' ? source.method : prior.method ?? null,
    pathTemplate: typeof source?.pathTemplate === 'string' ? source.pathTemplate : prior.pathTemplate ?? null,
    tlsVerified: source ? source.tlsVerified === true : prior.tlsVerified ?? false,
    trustEnv: source ? source.trustEnv === true : prior.trustEnv ?? null,
    redirectsFollowed: source ? source.redirectsFollowed === true : prior.redirectsFollowed ?? null,
    explicitRetries: Number.isInteger(source?.explicitRetries) ? source.explicitRetries : prior.explicitRetries ?? null,
    attemptCount: Number.isInteger(source?.attemptCount) ? source.attemptCount : prior.attemptCount ?? null,
    ownerVerified: source ? source.ownerVerified === true : prior.ownerVerified ?? false,
    serviceJobIdObserved: source ? source.responseJobIdObserved === true : prior.serviceJobIdObserved ?? false,
    journalState: typeof result?.state === 'string' ? result.state : prior.journalState ?? 'unavailable',
  };
}

/** Run one newly created, empty private conversation through create/read/title-update/delete. */
export async function runGrokConversationCrudOnce({
  runtime,
  createSource,
  title,
  createIntentId,
  updateIntentId,
  deleteIntentId,
  onCheckpoint = async () => {},
} = {}) {
  if (!plainObject(runtime) || !runtime.client || !runtime.conversations || !runtime.journal
      || !exactEmptyChatCreateBody(createSource?.body)) throw fail('CONVERSATION_CRUD_RUNTIME_REQUIRED');
  buildSourceGrokConversationCreateOperation(createSource);
  const exactTitle = requireSafeText(title, 'CONVERSATION_CRUD_TITLE_INVALID', TITLE_MAX);
  const intents = {
    create: requireIntent(createIntentId, 'CONVERSATION_CRUD_CREATE_INTENT_INVALID'),
    update: requireIntent(updateIntentId, 'CONVERSATION_CRUD_UPDATE_INTENT_INVALID'),
    delete: requireIntent(deleteIntentId, 'CONVERSATION_CRUD_DELETE_INTENT_INVALID'),
  };
  if (new Set(Object.values(intents)).size !== 3) throw fail('CONVERSATION_CRUD_INTENTS_NOT_UNIQUE');
  const titleSha256 = sha256(exactTitle);
  const receipt = {
    schemaVersion: 1,
    operationId: 'conversation.crud',
    status: 'running',
    ownerVerified: false,
    createSourceContract: {
      sourceMode: 'first_party_sdk_contract',
      normalUiRequestObserved: false,
      normalUiAdapterMatched: true,
      sourceFunctionName: CREATE_SOURCE_FUNCTION,
      sourceSha256: CREATE_SOURCE_SHA256,
      method: 'POST',
      pathTemplate: CREATE_PATH,
      bodyFieldNames: ['systemPromptName', 'temporary'],
      systemPromptNameEmpty: true,
      temporaryFalse: true,
      requestBodyPersisted: false,
      sourceBodySha256: createSource.sourceBodySha256,
      browserBusinessWriteDelivered: false,
    },
    task: {
      titleLength: exactTitle.length,
      titleSha256,
      conversationIdPersisted: false,
      originalOwnerDataChanged: false,
      textGenerationRequested: false,
      attachmentOrMediaPresent: false,
      sharingEnabled: false,
    },
    operations: {},
    readback: {},
    persistenceAssertions: {
      rawConversationIdsPersisted: false,
      rawTitlesPersisted: false,
      rawRequestBodiesPersisted: false,
      rawResponseBodiesPersisted: false,
      cookiesOrTokensPersisted: false,
      messageBodiesPersisted: false,
    },
  };
  let conversationId = '';
  let before;
  let afterCreate;
  let afterUpdate;
  let afterDelete;
  let responseNodes;
  let updatedRecord;
  const localOperationIds = [];
  const privateResults = [];
  try {
    const status = await runtime.client.status();
    if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
    receipt.ownerVerified = true;

    before = await fullConversationSnapshot(runtime.conversations);
    if (!before.complete) throw fail('CONVERSATION_CRUD_BASELINE_INCOMPLETE');
    const search = await runtime.conversations.search(exactTitle, { pageSize: 100 });
    privateResults.push(search?.data);
    const titleCollision = allStrings(search?.data).some(text => text === exactTitle);
    if (search?.status !== 200 || !Array.isArray(search?.data?.conversations) || titleCollision) {
      throw fail('CONVERSATION_CRUD_TITLE_NOT_UNIQUE');
    }
    receipt.readback.baselineStatus = before.status;
    receipt.readback.baselinePageCount = before.pages;
    receipt.readback.baselineConversationCount = before.ids.size;
    receipt.readback.baselineConversationIdSetSha256 = digestIdSet(before.ids);
    receipt.readback.exactTitleSearchStatus = search.status;
    receipt.readback.exactTitleCollision = false;
    await onCheckpoint(structuredClone(receipt));

    receipt.operations.create = { state: 'dispatch_pending', intentIdPersisted: false, retryCount: 0 };
    await onCheckpoint(structuredClone(receipt));
    const created = await runtime.conversations.create(createSource.body, {
      confirm: true,
      intentId: intents.create,
      sourceDiscoveryPermit: CREATE_PERMIT,
      onResponseCheckpoint: async checkpoint => {
        const response = checkpoint?.responseReceipt ?? {};
        receipt.operations.create = {
          state: 'response_observed',
          httpStatus: Number.isInteger(response.responseStatus) ? response.responseStatus : null,
          contentType: typeof response.responseContentType === 'string' ? response.responseContentType : null,
          responseBytes: Number.isSafeInteger(response.responseBytes) ? response.responseBytes : null,
          responseDigest: response.responseDigestKind === 'raw_http_body'
            && /^[a-f0-9]{64}$/.test(response.responseDigest ?? '') ? response.responseDigest : null,
          responseDigestPersisted: response.responseDigestKind === 'raw_http_body'
            && /^[a-f0-9]{64}$/.test(response.responseDigest ?? ''),
          responseDigestKind: ['raw_http_body', 'parsed_json_data'].includes(response.responseDigestKind) ? response.responseDigestKind : null,
          responseFieldNames: Array.isArray(response.responseTopLevelFieldNames) ? response.responseTopLevelFieldNames : [],
          responseContentType: typeof response.responseContentType === 'string' ? response.responseContentType : null,
          requestHeaderNames: Array.isArray(response.requestHeaderNames) ? response.requestHeaderNames : [],
          cookieNames: Array.isArray(response.cookieNames) ? response.cookieNames : [],
          httpVersion: typeof response.transportHttpVersion === 'string' ? response.transportHttpVersion : null,
          tlsVerified: response.tlsVerified === true,
          trustEnv: response.trustEnv === true,
          redirectsFollowed: response.redirectsFollowed === true,
          explicitRetries: Number.isInteger(response.explicitRetries) ? response.explicitRetries : null,
          attemptCount: Number.isInteger(response.attemptCount) ? response.attemptCount : null,
          ownerVerified: response.ownerVerified === true,
          requestDigest: /^[a-f0-9]{64}$/.test(checkpoint.requestDigest ?? '') ? checkpoint.requestDigest : null,
          intentDigest: /^[a-f0-9]{64}$/.test(checkpoint.intentDigest ?? '') ? checkpoint.intentDigest : null,
          serviceJobIdObserved: checkpoint.serviceJobIdObserved === true,
          retryCount: 0,
        };
        await onCheckpoint(structuredClone(receipt));
      },
    });
    privateResults.push(created);
    if (typeof created?.localOperationId === 'string') localOperationIds.push(created.localOperationId);
    receipt.operations.create = safeMutationFields(created, receipt.operations.create);
    if (created?.state !== 'completed' || created?.verified !== true || typeof created?.conversationId !== 'string') {
      receipt.status = 'needs_review';
      receipt.operations.create.state = created?.state ?? 'needs_review';
      await onCheckpoint(structuredClone(receipt));
      return Object.freeze(receipt);
    }
    conversationId = created.conversationId;
    receipt.task.conversationIdSha256 = sha256(conversationId);
    afterCreate = await fullConversationSnapshot(runtime.conversations);
    if (!afterCreate.complete || !afterCreate.ids.has(conversationId)
        || !sameSet(afterCreate.ids, before.ids, conversationId)
        || afterCreate.ids.size !== before.ids.size + 1) throw fail('CONVERSATION_CREATE_LIST_DELTA_INVALID');

    const read = await runtime.conversations.read(conversationId);
    privateResults.push(read?.data);
    const readMatch = readFieldsMatch(read?.data, { conversationId });
    if (read?.status !== 200 || readMatch.sameConversationId !== true || readMatch.viewerIsOwner !== true
        || readMatch.mediaTypeCount !== 0 || readMatch.workspaceCount !== 0 || readMatch.taskResultPresent) {
      throw fail('CONVERSATION_CREATE_READBACK_INVALID');
    }
    responseNodes = await runtime.conversations.responseNodes(conversationId);
    privateResults.push(responseNodes?.data);
    if (responseNodes?.status !== 200 || !Array.isArray(responseNodes?.data?.responseNodes)
        || responseNodes.data.responseNodes.length !== 0
        || !Array.isArray(responseNodes?.data?.inflightResponses)
        || responseNodes.data.inflightResponses.length !== 0) throw fail('CONVERSATION_CREATE_NOT_EMPTY');
    receipt.readback.create = {
      status: read.status,
      sameConversationId: true,
      conversationIdSha256: receipt.task.conversationIdSha256,
      viewerIsOwner: true,
      mediaTypeCount: 0,
      workspaceCount: 0,
      taskResultPresent: false,
      responseNodesStatus: responseNodes.status,
      responseNodeCount: 0,
      inflightResponseCount: 0,
      listStatus: afterCreate.status,
      listPageCount: afterCreate.pages,
      listConversationIdSetSha256: digestIdSet(afterCreate.ids),
      unrelatedConversationIdSetMatchesBaseline: sameSet(afterCreate.ids, before.ids, conversationId),
      exactlyOneNewConversation: true,
    };
    receipt.operations.create.conversationIdPersisted = false;
    await onCheckpoint(structuredClone(receipt));

    receipt.operations.update = { state: 'dispatch_pending', intentIdPersisted: false, retryCount: 0 };
    await onCheckpoint(structuredClone(receipt));
    const updated = await runtime.conversations.update(conversationId, { title: exactTitle }, {
      confirm: true,
      intentId: intents.update,
      onResponseCheckpoint: async checkpoint => {
        const response = checkpoint?.responseReceipt ?? {};
        receipt.operations.update = {
          state: 'response_observed',
          httpStatus: Number.isInteger(response.responseStatus) ? response.responseStatus : null,
          responseBytes: Number.isSafeInteger(response.responseBytes) ? response.responseBytes : null,
          responseDigest: response.responseDigestKind === 'raw_http_body'
            && /^[a-f0-9]{64}$/.test(response.responseDigest ?? '') ? response.responseDigest : null,
          responseDigestPersisted: response.responseDigestKind === 'raw_http_body'
            && /^[a-f0-9]{64}$/.test(response.responseDigest ?? ''),
          responseDigestKind: ['raw_http_body', 'parsed_json_data'].includes(response.responseDigestKind) ? response.responseDigestKind : null,
          responseFieldNames: Array.isArray(response.responseTopLevelFieldNames) ? response.responseTopLevelFieldNames : [],
          responseContentType: typeof response.responseContentType === 'string' ? response.responseContentType : null,
          requestDigest: /^[a-f0-9]{64}$/.test(checkpoint.requestDigest ?? '') ? checkpoint.requestDigest : null,
          intentDigest: /^[a-f0-9]{64}$/.test(checkpoint.intentDigest ?? '') ? checkpoint.intentDigest : null,
          requestHeaderNames: Array.isArray(response.requestHeaderNames) ? response.requestHeaderNames : [],
          cookieNames: Array.isArray(response.cookieNames) ? response.cookieNames : [],
          tlsVerified: response.tlsVerified === true,
          trustEnv: response.trustEnv === true,
          redirectsFollowed: response.redirectsFollowed === true,
          explicitRetries: Number.isInteger(response.explicitRetries) ? response.explicitRetries : null,
          attemptCount: Number.isInteger(response.attemptCount) ? response.attemptCount : null,
          ownerVerified: response.ownerVerified === true,
          retryCount: 0,
        };
        await onCheckpoint(structuredClone(receipt));
      },
    });
    if (typeof updated?.localOperationId === 'string') localOperationIds.push(updated.localOperationId);
    receipt.operations.update = safeMutationFields(updated, receipt.operations.update);
    if (updated?.state !== 'completed' || updated?.verified !== true) throw fail('CONVERSATION_TITLE_UPDATE_NOT_VERIFIED');
    const updateRead = await runtime.conversations.read(conversationId);
    privateResults.push(updateRead?.data);
    const updateMatch = readFieldsMatch(updateRead?.data, { conversationId, titleHash: titleSha256, requireTitle: true });
    if (updateRead?.status !== 200 || updateMatch.sameConversationId !== true || updateMatch.viewerIsOwner !== true
        || updateMatch.titleMatched !== true || updateMatch.taskTitleTextFound !== true) {
      throw fail('CONVERSATION_TITLE_UPDATE_READBACK_INVALID');
    }
    afterUpdate = await fullConversationSnapshot(runtime.conversations);
    if (!afterUpdate.complete || !sameSet(afterUpdate.ids, afterCreate.ids)) throw fail('CONVERSATION_TITLE_UPDATE_LIST_CHANGED');
    updatedRecord = updateMatch.record;
    receipt.readback.titleUpdate = {
      status: updateRead.status,
      sameConversationId: true,
      conversationIdSha256: receipt.task.conversationIdSha256,
      viewerIsOwner: true,
      exactTitleMatched: true,
      titleSha256,
      titleLength: exactTitle.length,
      listStatus: afterUpdate.status,
      listConversationIdSetSha256: digestIdSet(afterUpdate.ids),
      conversationIdSetUnchanged: true,
    };
    await onCheckpoint(structuredClone(receipt));

    receipt.operations.delete = { state: 'dispatch_pending', intentIdPersisted: false, retryCount: 0 };
    await onCheckpoint(structuredClone(receipt));
    const deleted = await runtime.conversations.delete(conversationId, {
      confirm: true,
      intentId: intents.delete,
      onResponseCheckpoint: async checkpoint => {
        const response = checkpoint?.responseReceipt ?? {};
        receipt.operations.delete = {
          state: 'response_observed',
          httpStatus: Number.isInteger(response.responseStatus) ? response.responseStatus : null,
          responseBytes: Number.isSafeInteger(response.responseBytes) ? response.responseBytes : null,
          responseDigest: response.responseDigestKind === 'raw_http_body'
            && /^[a-f0-9]{64}$/.test(response.responseDigest ?? '') ? response.responseDigest : null,
          responseDigestPersisted: response.responseDigestKind === 'raw_http_body'
            && /^[a-f0-9]{64}$/.test(response.responseDigest ?? ''),
          responseDigestKind: ['raw_http_body', 'parsed_json_data'].includes(response.responseDigestKind) ? response.responseDigestKind : null,
          responseFieldNames: Array.isArray(response.responseTopLevelFieldNames) ? response.responseTopLevelFieldNames : [],
          responseContentType: typeof response.responseContentType === 'string' ? response.responseContentType : null,
          requestDigest: /^[a-f0-9]{64}$/.test(checkpoint.requestDigest ?? '') ? checkpoint.requestDigest : null,
          intentDigest: /^[a-f0-9]{64}$/.test(checkpoint.intentDigest ?? '') ? checkpoint.intentDigest : null,
          requestHeaderNames: Array.isArray(response.requestHeaderNames) ? response.requestHeaderNames : [],
          cookieNames: Array.isArray(response.cookieNames) ? response.cookieNames : [],
          tlsVerified: response.tlsVerified === true,
          trustEnv: response.trustEnv === true,
          redirectsFollowed: response.redirectsFollowed === true,
          explicitRetries: Number.isInteger(response.explicitRetries) ? response.explicitRetries : null,
          attemptCount: Number.isInteger(response.attemptCount) ? response.attemptCount : null,
          ownerVerified: response.ownerVerified === true,
          retryCount: 0,
        };
        await onCheckpoint(structuredClone(receipt));
      },
    });
    privateResults.push(deleted);
    if (typeof deleted?.localOperationId === 'string') localOperationIds.push(deleted.localOperationId);
    receipt.operations.delete = safeMutationFields(deleted, receipt.operations.delete);
    if (deleted?.state !== 'completed' || deleted?.verified !== true || deleted?.conversationAbsent !== true) {
      throw fail('CONVERSATION_DELETE_NOT_VERIFIED');
    }
    afterDelete = await fullConversationSnapshot(runtime.conversations);
    if (!afterDelete.complete || !sameSet(afterDelete.ids, before.ids)) throw fail('CONVERSATION_DELETE_PRESERVATION_READBACK_FAILED');
    let detailStatus = null;
    let detailAbsent = false;
    try {
      const detail = await runtime.client.read(IDS.read, { conversationId });
      detailStatus = detail?.status ?? null;
      detailAbsent = detailStatus === 404;
      privateResults.push(detail?.data);
    } catch (error) {
      detailStatus = Number.isInteger(error?.details?.status) ? error.details.status : null;
      detailAbsent = detailStatus === 404;
    }
    receipt.readback.delete = {
      listStatus: afterDelete.status,
      listPageCount: afterDelete.pages,
      conversationIdSha256: receipt.task.conversationIdSha256,
      listConversationIdSetSha256: digestIdSet(afterDelete.ids),
      baselineConversationIdSetSha256: digestIdSet(before.ids),
      targetAbsent: true,
      unrelatedConversationSetPreserved: true,
      detailStatus,
      detailAbsent,
      detailAbsenceRequiredBySoftDeleteContract: false,
    };
    receipt.status = 'verified';
    receipt.operations.delete.verified = true;
    receipt.task.exactTaskConversationCount = 1;
    await onCheckpoint(structuredClone(receipt));
    return Object.freeze(receipt);
  } catch (error) {
    receipt.status = 'needs_review';
    receipt.errorCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
      ? error.code : 'CONVERSATION_CRUD_FAILED';
    if (receipt.operations.create?.state === 'dispatch_pending') receipt.operations.create.state = 'outcome_unknown';
    if (receipt.operations.update?.state === 'dispatch_pending') receipt.operations.update.state = 'outcome_unknown';
    if (receipt.operations.delete?.state === 'dispatch_pending') receipt.operations.delete.state = 'outcome_unknown';
    await onCheckpoint(structuredClone(receipt)).catch(() => {});
    return Object.freeze(receipt);
  } finally {
    if (typeof runtime.client.clearInMemoryServiceJobId === 'function') {
      for (const localOperationId of localOperationIds) await runtime.client.clearInMemoryServiceJobId(localOperationId).catch(() => {});
    }
    if (before?.ids) before.ids.clear();
    if (afterCreate?.ids) afterCreate.ids.clear();
    if (afterUpdate?.ids) afterUpdate.ids.clear();
    if (afterDelete?.ids) afterDelete.ids.clear();
    for (const value of privateResults) scrub(value);
    conversationId = '';
    if (updatedRecord && typeof updatedRecord === 'object') {
      for (const key of Object.keys(updatedRecord)) {
        if (typeof updatedRecord[key] === 'string') updatedRecord[key] = '';
      }
    }
  }
}

export const GROK_CONVERSATION_CREATE_SOURCE = Object.freeze({
  path: CREATE_PATH,
  sourceUrl: CREATE_SOURCE_URL,
  sourceSha256: CREATE_SOURCE_SHA256,
  sourceFunctionName: CREATE_SOURCE_FUNCTION,
  sourceDiscoveryPermit: CREATE_PERMIT,
});
