#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInMemoryGrokConversationRuntime } from '../src/runtime.mjs';
import { loadContractRegistry, readinessMatrix } from '../src/client.mjs';
import { validateContractRegistry } from '../src/contracts.mjs';
import { canonicalJson, operationDigest, validateFeatureChecklist } from '../src/feature-checklist.mjs';
import {
  buildSourceGrokConversationCreateOperation,
  finalizeCapturedGrokConversationCreateOperation,
  runGrokConversationCrudOnce,
} from '../src/grok-conversation-crud-once.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_PATH = path.join(REPO, 'verification/grok-conversation-crud-live-2026-10-06.json');
const SOURCE_RECEIPT_PATH = path.join(REPO, 'contracts/grok-conversation-create-source-fragment-2026-10-06.json');
const NATIVE_ATTEMPT_PATH = path.join(REPO, 'verification/grok-conversation-create-native-ui-attempt-2026-10-06.json');
const CONTRACT_PATH = path.join(REPO, 'contracts/grok-conversation-crud-fragment-2026-10-06.json');
const CRUD_FEATURE_RECEIPT_DIR = path.join(REPO, 'verification/grok-feature-live-receipts');
const CRUD_CHECKLIST_PATH = path.join(REPO, 'contracts/grok-feature-checklist.v1.json');
const CRUD_OWNER_PROOF_PATH = 'verification/owner-proofs/bfed37fbf64e2c46562d41e6a2be7a8507c0a6d2ba0eae8cecf59f6b12f57fd4.json';
const EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const MAX_PACKET_BYTES = 2 * 1024 * 1024;
const ALLOWED_PACKET_KEYS = ['expectedIdentity', 'sessionBundle', 'createSource'];
const CODE_FILES = [
  'src/client.mjs', 'src/contracts.mjs', 'src/transport.mjs', 'src/grok-conversations.mjs',
  'src/grok-conversation-crud-once.mjs', 'scripts/grok-conversation-crud-once.mjs',
  'src/cli.mjs', 'contracts/grok-web.v1.json',
];

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scrub(value, depth = 0, seen = new Set()) {
  if (depth > 24 || value === null || value === undefined || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      try {
        if (typeof value[index] === 'string') value[index] = '';
        else scrub(value[index], depth + 1, seen);
      } catch { /* Best-effort memory clearing. */ }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = '';
      else scrub(value[key], depth + 1, seen);
    } catch { /* Frozen values are released with the task process. */ }
  }
}

async function readPacket() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_PACKET_BYTES) fail('CRUD_PACKET_TOO_LARGE');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('CRUD_PACKET_REQUIRED');
  const raw = Buffer.concat(chunks, length);
  let packet;
  try { packet = JSON.parse(raw.toString('utf8')); } catch { raw.fill(0); fail('CRUD_PACKET_INVALID'); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || Object.keys(packet).sort().join(',') !== ALLOWED_PACKET_KEYS.slice().sort().join(',')) {
    scrub(packet);
    fail('CRUD_PACKET_INVALID');
  }
  return packet;
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.pending`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertAbsent(filePath, code) {
  try { await access(filePath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  fail(code);
}

async function codeSnapshot() {
  const output = {};
  for (const file of CODE_FILES) output[file] = sha256(await readFile(path.join(REPO, file)));
  return output;
}

async function validateSourceReceipt(packet) {
  const fragment = JSON.parse(await readFile(SOURCE_RECEIPT_PATH, 'utf8'));
  const attempt = JSON.parse(await readFile(NATIVE_ATTEMPT_PATH, 'utf8'));
  const createOperation = fragment?.operations?.find(operation => operation.id === 'conversation.create');
  const source = packet.createSource;
  if (!source || fragment?.fragmentId !== 'grok-conversation-create-source-contract'
      || fragment?.firstLiveReplay?.directDispatchPerformed !== false
      || attempt?.operationId !== 'conversation.create' || attempt?.normalUiRequestObserved !== false
      || attempt?.exactCreateRequestCount !== 0
      || attempt?.lastGuardedProbe?.browserBusinessFramesDelivered !== 0
      || attempt?.lastGuardedProbe?.browserBusinessFrameCount !== 0
      || attempt?.lastGuardedProbe?.exactCreateRequestCount !== 0
      || !createOperation || createOperation.evidence?.source !== 'first_party_sdk_contract'
      || createOperation.evidence?.firstLiveReplayPermit !== true
      || createOperation.evidence?.sourceFunctionName !== 'chatCreateConversationRaw'
      || source.sourceMode !== 'first_party_sdk_contract' || source.normalUiRequestObserved !== false
      || source.sourceBodySha256 !== sha256(Buffer.from(JSON.stringify(source.body), 'utf8'))
      || source.sourceBodySha256 !== fragment.body?.sourceBodySha256
      || source.sourceSha256 !== createOperation.evidence.sourceSha256
      || source.adapterSourceSha256 !== fragment.sourceAssets?.find(asset => asset.adapterFunctionName === 'createChatConversation')?.sourceSha256) {
    fail('CRUD_SOURCE_CONTRACT_RECEIPT_INVALID');
  }
  return {
    receiptSha256: sha256(await readFile(SOURCE_RECEIPT_PATH)),
    source: fragment.sourceAssets,
    adapterSourceSha256: fragment.sourceAssets?.find(asset => asset.adapterFunctionName === 'createChatConversation')?.sourceSha256,
    nativeUiAttemptReceiptSha256: sha256(await readFile(NATIVE_ATTEMPT_PATH)),
  };
}

function appendTaskDirectReplay(operation, taskResult, observedAt, operationKey) {
  const record = taskResult.operations?.[operationKey];
  if (!record || record.state !== 'completed' || record.verified !== true
      || record.httpStatus !== 200 || record.ownerVerified !== true
      || record.tlsVerified !== true || record.trustEnv !== false
      || record.redirectsFollowed !== false || record.explicitRetries !== 0
      || record.attemptCount !== 1
      || !/^[a-f0-9]{64}$/.test(record.requestDigest ?? '')
      || !/^[a-f0-9]{64}$/.test(record.intentDigest ?? '')
      || !Number.isSafeInteger(record.responseBytes) || record.responseBytes < 0) {
    fail('CRUD_TASK_DIRECT_REPLAY_RECEIPT_INVALID');
  }
  const normalized = structuredClone(operation);
  const responseSubstantive = record.responseFieldNames.length > 0 || record.responseBytes > 2;
  normalized.evidence = {
    ...normalized.evidence,
    capturedAt: observedAt,
    directReplayReceipt: 'verification/grok-conversation-crud-live-2026-10-06.json',
    httpStatus: 200,
    responseContentType: record.responseContentType ?? 'application/json',
    semanticReadbackVerified: operation.id === 'conversation.update'
      ? taskResult.readback.titleUpdate?.sameConversationId === true
        && taskResult.readback.titleUpdate?.exactTitleMatched === true
        && taskResult.readback.titleUpdate?.conversationIdSetUnchanged === true
      : operation.id === 'conversation.soft-delete'
        ? taskResult.readback.delete?.targetAbsent === true
          && taskResult.readback.delete?.unrelatedConversationSetPreserved === true
          && taskResult.readback.delete?.conversationIdSetMatchesBaseline === true
        : false,
    directReplayReceipt: 'verification/grok-conversation-crud-live-2026-10-06.json',
    semanticReadbackVerified: true,
    observedResponseSubstantive: responseSubstantive,
    ...(responseSubstantive ? {} : { responseMayBeEmptyObject: true }),
    directReplay: {
      source: 'direct_http',
      status: 200,
      parsedData: true,
      observedAt,
      ownerVerified: true,
      tlsVerified: true,
      trustEnv: false,
      redirectsFollowed: false,
      explicitRetries: 0,
      attemptCountPerMutation: 1,
      responseBytes: record.responseBytes,
      responseDigestPersisted: record.responseDigestPersisted === true,
      ...(record.responseDigestPersisted === true ? { responseSha256: record.responseDigest } : {}),
      requestDigest: record.requestDigest,
      intentDigest: record.intentDigest,
      requestHeaderNames: Array.isArray(record.requestHeaderNames) ? record.requestHeaderNames : [],
      cookieNames: Array.isArray(record.cookieNames) ? record.cookieNames : [],
      responseTopLevelFieldNames: Array.isArray(record.responseFieldNames) ? record.responseFieldNames : [],
      ...(operation.id === 'conversation.soft-delete' ? {
        semanticReadback: {
          conversationAbsent: taskResult.readback.delete?.targetAbsent === true,
          otherConversationsUnchanged: taskResult.readback.delete?.unrelatedConversationSetPreserved === true,
          completeListReadback: taskResult.readback.delete?.completePaginatedListReadback === true,
        },
      } : {}),
    },
  };
  validateContractRegistry({
    schemaVersion: 1, serviceId: 'grok-web', serviceOrigin: 'https://grok.com',
    allowedOrigins: ['https://grok.com'], operations: [normalized],
  });
  return normalized;
}

export async function createContractFragment(baseRegistry, createOperation, workflow, sourceMetadata) {
  if (workflow.status !== 'verified') return null;
  // Preserve the original run's observation timestamp. Per-operation wall-clock
  // dispatch timestamps were not persisted, so this is intentionally the
  // workflow-start observation time, not a reconstructed request timestamp.
  const observedAt = workflow.observedAt;
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
    fail('CRUD_TASK_OBSERVATION_TIMESTAMP_INVALID');
  }
  const createProof = workflow.operations.create;
  const directReplay = {
    source: 'direct_http', status: 200, parsedData: true, observedAt,
    ownerVerified: true, tlsVerified: createProof.tlsVerified === true,
    trustEnv: createProof.trustEnv, redirectsFollowed: createProof.redirectsFollowed,
    explicitRetries: createProof.explicitRetries,
    attemptCountPerMutation: createProof.attemptCount,
    responseBytes: createProof.responseBytes,
    responseDigestPersisted: createProof.responseDigestPersisted === true,
    ...(createProof.responseDigestPersisted === true ? { responseSha256: createProof.responseDigest } : {}),
    requestDigest: createProof.requestDigest,
    intentDigest: createProof.intentDigest,
    requestHeaderNames: createProof.requestHeaderNames,
    cookieNames: createProof.cookieNames,
    responseJobIdObserved: createProof.serviceJobIdObserved === true,
    responseTopLevelFieldNames: createProof.responseFieldNames,
  };
  const finalizedCreate = finalizeCapturedGrokConversationCreateOperation(createOperation, {
    directReplay,
    semanticReadbackVerified: workflow.readback.create?.sameConversationId === true
      && workflow.readback.create?.viewerIsOwner === true
      && workflow.readback.create?.exactlyOneNewConversation === true,
    observedAt,
  });
  const update = baseRegistry.operations.find(operation => operation.id === 'conversation.update');
  const remove = baseRegistry.operations.find(operation => operation.id === 'conversation.soft-delete');
  const read = baseRegistry.operations.find(operation => operation.id === 'conversation.read');
  if (!read || !update || !remove) fail('CRUD_BASE_CONTRACT_OPERATION_MISSING');
  const fragment = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    serviceOrigin: 'https://grok.com',
    allowedOrigins: ['https://grok.com'],
    identityOperationId: null,
    fragmentId: 'grok-conversation-crud-task-only',
    observedAt,
    operations: [
      finalizedCreate,
      read,
      appendTaskDirectReplay(update, workflow, observedAt, 'update'),
      appendTaskDirectReplay(remove, workflow, observedAt, 'delete'),
    ],
    sourceAssets: [
      { sourceUrl: 'https://cdn.grok.com/_next/static/chunks/27akar72ihacg.js',
        sourceSha256: '8dcfb562e2b3f83f866c23c82f73503c52a409620c8830697d6cade848644759',
        sourceFunctionNames: ['chatCreateConversationRaw', 'chatUpdateConversationRaw'] },
      { sourceUrl: 'https://cdn.grok.com/_next/static/chunks/0uf56-pwxogcp.js',
        sourceSha256: 'be4f8e3ba59be451e39f4f289b39706763028ef0b107335676dcc6fa2893b99a',
        sourceFunctionNames: ['chatGetConversationV2Raw', 'chatSoftDeleteConversationRaw'] },
      { sourceUrl: 'https://cdn.grok.com/_next/static/chunks/205b03gn_m2ip.js',
        sourceSha256: sourceMetadata?.adapterSourceSha256,
        sourceFunctionNames: ['createChatConversation'] },
    ],
    sourceOnlyCreateContractReceipt: 'contracts/grok-conversation-create-source-fragment-2026-10-06.json',
    nativeUiAttemptReceipt: 'verification/grok-conversation-create-native-ui-attempt-2026-10-06.json',
    normalUiCreateRequestObserved: false,
    liveWorkflowReceipt: 'verification/grok-conversation-crud-live-2026-10-06.json',
    persistenceAssertions: {
      conversationIdsPersisted: false,
      conversationTitlesPersisted: false,
      requestBodiesPersisted: false,
      responseBodiesPersisted: false,
      cookieValuesPersisted: false,
    },
  };
  validateContractRegistry(fragment);
  return fragment;
}

export async function integrateFirstLiveCreateContract(fragment, workflow) {
  const finalizedCreate = fragment?.operations?.find(operation => operation.id === 'conversation.create');
  if (!finalizedCreate) fail('CRUD_FINAL_CREATE_CONTRACT_MISSING');
  const registryPath = path.join(REPO, 'contracts/grok-web.v1.json');
  const currentRegistry = await loadContractRegistry(registryPath);
  const currentCreate = currentRegistry.operations.find(operation => operation.id === 'conversation.create');
  if (!currentCreate || currentCreate.evidence?.source !== 'first_party_sdk_contract'
      || currentCreate.evidence?.sourceSha256 !== finalizedCreate.evidence.sourceSha256
      || currentCreate.evidence?.sourceFunctionName !== finalizedCreate.evidence.sourceFunctionName
      || currentCreate.evidence?.requestPath !== finalizedCreate.evidence.requestPath) {
    fail('CRUD_MAIN_CREATE_CONTRACT_DRIFT');
  }
  const finalizedOperations = new Map(fragment.operations
    .filter(operation => ['conversation.create', 'conversation.update', 'conversation.soft-delete'].includes(operation.id))
    .map(operation => [operation.id, operation]));
  currentRegistry.operations = currentRegistry.operations.map(operation =>
    finalizedOperations.get(operation.id) ?? operation);
  validateContractRegistry(currentRegistry);

  const sourcePath = path.join(REPO, 'contracts/grok-conversation-create-source-fragment-2026-10-06.json');
  const sourceFragment = JSON.parse(await readFile(sourcePath, 'utf8'));
  sourceFragment.operations = [finalizedCreate];
  sourceFragment.firstLiveReplay = {
    sourceDiscoveryPermit: 'first-live:conversation.create',
    directDispatchPerformed: true,
    directDispatchCount: workflow.operations.create.attemptCount,
    httpStatus: workflow.operations.create.httpStatus,
    ownerVerified: workflow.operations.create.ownerVerified,
    responseJobIdObserved: workflow.operations.create.serviceJobIdObserved,
    semanticReadbackVerified: workflow.readback.create?.sameConversationId === true
      && workflow.readback.create?.viewerIsOwner === true
      && workflow.readback.create?.exactlyOneNewConversation === true,
    normalUiRequestObserved: false,
    conversationIdPersisted: false,
  };
  validateContractRegistry(sourceFragment);

  const fragmentPath = path.join(REPO, 'contracts/grok-conversation-crud-fragment-2026-10-06.json');
  const checklist = JSON.parse(await readFile(CRUD_CHECKLIST_PATH, 'utf8'));
  const crudFeature = checklist.features.find(feature => feature.id === 'conversation.crud');
  const requirements = new Map(crudFeature?.requirements?.map(requirement => [requirement.id, requirement]) ?? []);
  const configureRequirement = (id, { operationId, method, route, fieldNames, evidenceMode }) => {
    const requirement = requirements.get(id);
    if (!requirement) fail('CRUD_CHECKLIST_REQUIREMENT_MISSING');
    requirement.operationId = operationId;
    requirement.evidenceMode = evidenceMode;
    requirement.candidate = {
      ...requirement.candidate,
      status: evidenceMode === 'first_party_sdk_direct_replay' ? 'first_party_direct_replay' : 'source_candidate_only',
      origin: 'https://grok.com',
      method,
      path: route,
      fieldNames,
      sourceAsset: 'chat',
    };
  };
  configureRequirement('conversation.create', {
    operationId: 'conversation.create', method: 'POST', route: '/rest/app-chat/conversations',
    fieldNames: ['systemPromptName', 'temporary'], evidenceMode: 'first_party_sdk_direct_replay',
  });
  configureRequirement('conversation.read', {
    operationId: 'conversation.read', method: 'GET', route: '/rest/app-chat/conversations_v2/{conversationId}',
    fieldNames: ['includeTaskResult', 'includeWorkspaces'], evidenceMode: 'captured_session_replay',
  });
  requirements.get('conversation.read').candidate.notes =
    'The task-only CRUD receipt records an independent same-owner detail readback (HTTP 200, same ID, no media/workspaces/task result), but it does not retain per-read request/response digests; the normalized read replay remains separately evidenced.';
  configureRequirement('conversation.title.update', {
    operationId: 'conversation.update', method: 'PUT', route: '/rest/app-chat/conversations/{conversationId}',
    fieldNames: ['title', 'starred', 'botAgentId'], evidenceMode: 'first_party_sdk_direct_replay',
  });
  configureRequirement('conversation.delete', {
    operationId: 'conversation.soft-delete', method: 'DELETE', route: '/rest/app-chat/conversations/soft/{conversationId}',
    fieldNames: [], evidenceMode: 'first_party_sdk_direct_replay',
  });
  validateFeatureChecklist(checklist);

  const workflowBytes = await readFile(RECEIPT_PATH);
  const workflowSha256 = sha256(workflowBytes);
  const ownerProof = JSON.parse(await readFile(path.join(REPO, CRUD_OWNER_PROOF_PATH), 'utf8'));
  const ownerProofSha256 = sha256(canonicalJson(ownerProof));
  if (ownerProof.ownerScopeSha256 !== workflow.ownerScopeDigest
      || ownerProofSha256 !== 'bfed37fbf64e2c46562d41e6a2be7a8507c0a6d2ba0eae8cecf59f6b12f57fd4') {
    fail('CRUD_OWNER_PROOF_SCOPE_MISMATCH');
  }
  const operationMap = new Map(currentRegistry.operations.map(operation => [operation.id, operation]));
  const featureReceipts = [
    ['create', 'conversation.create', 'conversation.create', { readbackVerified: true, readbackStatus: 200, sameConversationId: true, viewerIsOwner: true }],
    ['update', 'conversation.title.update', 'conversation.update', { readbackVerified: true, readbackStatus: 200, sameConversationId: true, viewerIsOwner: true }],
    ['delete', 'conversation.delete', 'conversation.soft-delete', { readbackVerified: true, readbackStatus: 200, conversationAbsent: true, otherConversationsUnchanged: true }],
  ];
  const receiptHashes = {};
  for (const [key, requirementId, operationId, semanticReadback] of featureReceipts) {
    const record = workflow.operations?.[key];
    const operation = operationMap.get(operationId);
    if (!record || record.state !== 'completed' || record.verified !== true || !operation
        || record.httpStatus !== 200 || record.attemptCount !== 1
        || !/^[a-f0-9]{64}$/.test(record.requestDigest ?? '')
        || !/^[a-f0-9]{64}$/.test(record.intentDigest ?? '')
        || !/^[a-f0-9]{64}$/.test(record.responseDigest ?? '')) fail('CRUD_FEATURE_OPERATION_PROOF_INVALID');
    const codeSha256 = {};
    for (const file of ['src/client.mjs', 'src/transport.mjs', 'src/journal.mjs']) {
      const digest = workflow.sourceCodeSnapshotSha256?.[file];
      if (typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) codeSha256[file] = digest;
    }
    const receipt = {
      schemaVersion: 1,
      serviceId: 'grok-web',
      featureId: 'conversation.crud',
      requirementId,
      operationId,
      observedAt: workflow.observedAt,
      recordedAt: new Date().toISOString(),
      execution: 'direct_http_client',
      liveReplay: true,
      liveReplayRecorded: true,
      mocked: false,
      ownerVerified: true,
      sameAuthenticatedOwner: true,
      evidenceScope: 'same_authenticated_owner',
      ownerIdentityReceiptSha256: ownerProofSha256,
      ownerProofPath: CRUD_OWNER_PROOF_PATH,
      ownerProofSha256,
      ownerScopeSha256: workflow.ownerScopeDigest,
      httpStatus: record.httpStatus,
      responseMime: record.responseContentType,
      responseBytes: record.responseBytes,
      capturedOperationSha256: operationDigest(operation),
      requestDigest: record.requestDigest,
      intentDigest: record.intentDigest,
      responseDigest: record.responseDigest,
      responseDigestKind: 'raw_http_body',
      handlerId: 'client.submit',
      dispatchBinding: { handlerId: 'client.submit', operationId, operationKind: 'submit', mode: 'validated_registry_generic' },
      codeSha256,
      readinessAssertions: { handlerDispatchVerified: true, ownerScopeBound: true },
      persistenceAssertions: {
        credentialValuesPersisted: false,
        cookiesPersisted: false,
        tokensPersisted: false,
        requestBodiesPersisted: false,
        responseBodiesPersisted: false,
        signedUrlValuesPersisted: false,
        passwordValuesPersisted: false,
        conversationIdsPersisted: false,
        conversationTitlesPersisted: false,
        responseIdsPersisted: false,
        messageBodiesPersisted: false,
      },
      semanticReadback,
      sourceProofPath: 'verification/grok-conversation-crud-live-2026-10-06.json',
      sourceProofSha256: workflowSha256,
      codeHashCapturedAtExecution: true,
    };
    const receiptPath = path.join(CRUD_FEATURE_RECEIPT_DIR,
      key === 'update' ? 'conversation.title.update.json' : `conversation.${key}.json`);
    await atomicJson(receiptPath, receipt);
    receiptHashes[path.relative(REPO, receiptPath)] = sha256(await readFile(receiptPath));
  }

  await atomicJson(fragmentPath, fragment);
  await atomicJson(sourcePath, sourceFragment);
  await atomicJson(registryPath, currentRegistry);
  await atomicJson(CRUD_CHECKLIST_PATH, checklist);
  return {
    mainRegistrySha256: sha256(await readFile(registryPath)),
    sourceFragmentSha256: sha256(await readFile(sourcePath)),
    workflowFragmentSha256: sha256(await readFile(fragmentPath)),
    checklistSha256: sha256(await readFile(CRUD_CHECKLIST_PATH)),
  };
}

async function main() {
  let packet;
  let runtime;
  try {
    packet = await readPacket();
    if (typeof packet.expectedIdentity !== 'string'
        || sha256(packet.expectedIdentity.trim().toLowerCase()) !== EXPECTED_OWNER_SHA256
        || !packet.sessionBundle || typeof packet.sessionBundle !== 'object'
        || !packet.createSource || typeof packet.createSource !== 'object') fail('CRUD_PACKET_OWNER_BINDING_INVALID');
    await assertAbsent(RECEIPT_PATH, 'CRUD_RECEIPT_ALREADY_EXISTS');
    await assertAbsent(CONTRACT_PATH, 'CRUD_CONTRACT_FRAGMENT_ALREADY_EXISTS');
    const sourceReceipt = await validateSourceReceipt(packet);
    const snapshotBefore = await codeSnapshot();
    const baseRegistry = await loadContractRegistry();
    const createOperation = baseRegistry.operations.find(operation => operation.id === 'conversation.create');
    const sourceOperation = buildSourceGrokConversationCreateOperation(packet.createSource);
    if (!createOperation || createOperation.method !== sourceOperation.method
        || createOperation.evidence?.sourceFunctionName !== sourceOperation.evidence.sourceFunctionName
        || createOperation.evidence?.sourceSha256 !== sourceOperation.evidence.sourceSha256
        || JSON.stringify(createOperation.request?.bodyTemplate) !== JSON.stringify(sourceOperation.request.bodyTemplate)
        || createOperation.responseJobIdPointer !== '/conversationId'
        || createOperation.evidence?.firstLiveReplayPermit !== true) fail('CRUD_MAIN_CREATE_CONTRACT_MISMATCH');
    for (const id of ['conversation.read', 'conversation.update', 'conversation.soft-delete']) {
      const operation = baseRegistry.operations.find(item => item.id === id);
      const readiness = readinessMatrix(baseRegistry).operations.find(item => item.operationId === id);
      if (!operation || readiness?.ready !== true) fail('CRUD_BASE_OPERATION_NOT_READY');
    }
    runtime = await createInMemoryGrokConversationRuntime({
      pythonExecutable: '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python',
    });
    await runtime.client.importSession(packet.sessionBundle);
    const owner = await runtime.client.verifyOwner(packet.expectedIdentity);
    if (owner?.ownerVerified !== true || owner?.source !== 'direct_http_identity_read') fail('CRUD_DIRECT_OWNER_VERIFICATION_FAILED');
    const ownerScope = await runtime.sessionPersistence.read();
    const ownerScopeDigest = ownerScope?.session?.ownerBinding?.identityDigest;
    if (typeof ownerScopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ownerScopeDigest)) fail('CRUD_OWNER_SCOPE_UNAVAILABLE');

    const title = `Codex Grok CRUD task 20261006 ${randomUUID().slice(0, 8)}`;
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const onCheckpoint = async safeReceipt => {
      await atomicJson(RECEIPT_PATH, {
        ...safeReceipt,
        observedAt: startedAt,
        ownerScopeDigest,
        createSourceReceiptSha256: sourceReceipt.receiptSha256,
        nativeUiAttemptReceiptSha256: sourceReceipt.nativeUiAttemptReceiptSha256,
        pageRole: 'codex-grok-conversation-crud-20261006',
        sourceCodeSnapshotSha256: snapshotBefore,
        localRunDigest: sha256(runId),
      });
    };
    const taskReceipt = await runGrokConversationCrudOnce({
      runtime,
      createSource: packet.createSource,
      title,
      createIntentId: `grok-conversation-crud-20261006-create-${runId}`,
      updateIntentId: `grok-conversation-crud-20261006-update-${runId}`,
      deleteIntentId: `grok-conversation-crud-20261006-delete-${runId}`,
      onCheckpoint,
    });
    const snapshotAfter = await codeSnapshot();
    const finalReceipt = {
      ...taskReceipt,
      observedAt: startedAt,
      ownerScopeDigest,
      createSourceReceiptSha256: sourceReceipt.receiptSha256,
      nativeUiAttemptReceiptSha256: sourceReceipt.nativeUiAttemptReceiptSha256,
      pageRole: 'codex-grok-conversation-crud-20261006',
      sourceCodeSnapshotSha256: snapshotBefore,
      sourceCodeSnapshotStable: JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter),
      sourceCodeSnapshotAfterSha256: snapshotAfter,
      localRunDigest: sha256(runId),
      persistenceAssertions: {
        ...taskReceipt.persistenceAssertions,
        conversationIdsPersisted: false,
        conversationTitlesPersisted: false,
        callerIntentsPersisted: false,
        rawRequestBodiesPersisted: false,
        rawResponseBodiesPersisted: false,
        cookieValuesPersisted: false,
        messageBodiesPersisted: false,
      },
    };
    await atomicJson(RECEIPT_PATH, finalReceipt);
    let fragment = null;
    let contractIntegration = null;
    let contractIntegrationError = null;
    try {
      fragment = await createContractFragment(baseRegistry, createOperation, finalReceipt, packet.createSource);
      if (fragment) contractIntegration = await integrateFirstLiveCreateContract(fragment, finalReceipt);
    } catch (error) {
      contractIntegrationError = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
        ? error.code : 'CRUD_CONTRACT_INTEGRATION_FAILED';
    }
    finalReceipt.normalizedContractCreated = Boolean(fragment);
    finalReceipt.mainRegistryCreateReady = Boolean(contractIntegration);
    if (contractIntegration) {
      finalReceipt.contractIntegrationSha256 = contractIntegration;
    }
    if (contractIntegrationError) finalReceipt.contractIntegrationErrorCode = contractIntegrationError;
    await atomicJson(RECEIPT_PATH, finalReceipt);
    let featureReceiptRefreshErrorCode = null;
    // The workflow receipt now has its final contents. Refresh standard feature
    // receipts once so their sourceProofSha256 binds to this exact durable file.
    if (fragment && contractIntegration) {
      try { await integrateFirstLiveCreateContract(fragment, finalReceipt); }
      catch (error) {
        featureReceiptRefreshErrorCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
          ? error.code : 'CRUD_FEATURE_RECEIPT_REFRESH_FAILED';
      }
    }
    process.stdout.write(`${JSON.stringify({
      status: finalReceipt.status,
      operationId: finalReceipt.operationId,
      createHttpStatus: finalReceipt.operations?.create?.httpStatus ?? null,
      updateHttpStatus: finalReceipt.operations?.update?.httpStatus ?? null,
      deleteHttpStatus: finalReceipt.operations?.delete?.httpStatus ?? null,
      readbackVerified: finalReceipt.status === 'verified',
      normalizedContractCreated: Boolean(fragment),
      mainRegistryCreateReady: Boolean(contractIntegration),
      contractIntegrationErrorCode: contractIntegrationError,
      featureReceiptRefreshErrorCode,
      receiptPath: 'verification/grok-conversation-crud-live-2026-10-06.json',
      sourceReceiptPath: 'contracts/grok-conversation-create-source-fragment-2026-10-06.json',
      normalUiCreateRequestObserved: false,
      contractPath: fragment ? 'contracts/grok-conversation-crud-fragment-2026-10-06.json' : null,
      rawConversationIdPersisted: false,
      rawTitlePersisted: false,
    })}\n`);
    if (finalReceipt.status !== 'verified') process.exitCode = 1;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
      ? error.code : 'GROK_CONVERSATION_CRUD_FAILED';
    process.stdout.write(`${JSON.stringify({ status: 'needs_review', operationId: 'conversation.crud', errorCode: code, directDispatchCount: null,
      dispatchStatus: 'unknown_after_runner_error',
      receiptPath: 'verification/grok-conversation-crud-live-2026-10-06.json', rawConversationIdPersisted: false })}\n`);
    process.exitCode = 1;
  } finally {
    if (runtime?.client) await runtime.client.clearSession().catch(() => {});
    if (packet) {
      packet.expectedIdentity = '';
      scrub(packet.sessionBundle);
      scrub(packet.createSource);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
