import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GrokWebClient, loadContractRegistry } from '../src/client.mjs';
import { fetchPublicModels } from '../src/public-models.mjs';
import { submitCapturedGrokTextOnce } from '../src/grok-text-websocket.mjs';
import { createGrokWorkspaceClient } from '../src/grok-workspaces.mjs';
import { createGrokAttachmentUploadClient } from '../src/grok-attachment-upload.mjs';
import { createGrokMediaApi } from '../src/grok-media-api.mjs';
import { submitGrokImagineImage, submitProvisionalCapturedGrokVideoOnce } from '../src/grok-media-operations.mjs';
import {
  canonicalJson,
  evaluateFeatureChecklist,
  FeatureChecklistError,
  grokMediaOperationContractSnapshot,
  operationDigest,
  sha256Text,
} from '../src/feature-checklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), 'utf8'));
}

async function digestFile(relativePath) {
  return createHash('sha256').update(await readFile(path.join(ROOT, relativePath))).digest('hex');
}

async function hashesFor(files) {
  return Object.fromEntries(await Promise.all([...new Set(files)].map(async file => [file, await digestFile(file)])));
}

function actualHandlers(checklist) {
  const namespaces = {
    'src/client.mjs': { GrokWebClient },
    'src/public-models.mjs': { fetchPublicModels },
    'src/grok-text-websocket.mjs': { submitCapturedGrokTextOnce },
    'src/grok-workspaces.mjs': { createGrokWorkspaceClient },
    'src/grok-attachment-upload.mjs': { createGrokAttachmentUploadClient },
    'src/grok-media-api.mjs': { createGrokMediaApi },
    'src/grok-media-operations.mjs': { submitGrokImagineImage, submitProvisionalCapturedGrokVideoOnce },
  };
  const workspaceClient = createGrokWorkspaceClient({
    client: { read: async () => ({}), submit: async () => ({}), status: async () => ({}) },
    journal: { get: async () => null, transition: async () => null },
  });
  const attachmentClient = createGrokAttachmentUploadClient({
    client: { read: async () => ({}), submit: async () => ({}), getInMemoryPrivateResponse: async () => ({}) },
    journal: { get: async () => null, transition: async () => null },
    assetReader: async () => ({}),
  });
  const mediaApi = createGrokMediaApi({ client: { read: async () => ({}) }, assetReader: async () => ({}) });
  return Object.fromEntries(Object.entries(checklist.handlerBindings).map(([id, binding]) => {
    const namespace = namespaces[binding.source];
    const owner = namespace?.[binding.owner];
    const found = binding.kind === 'clientMethod'
      ? typeof owner?.prototype?.[binding.member] === 'function'
      : typeof namespace?.[binding.member] === 'function'
        && (binding.workspaceMethod !== undefined
          ? typeof workspaceClient[binding.workspaceMethod] === 'function'
          : binding.factoryMethod !== undefined
            ? typeof (id === 'attachments.upload-direct' ? attachmentClient : mediaApi)[binding.factoryMethod] === 'function' : true);
    return [id, found];
  }));
}

function capturedReadOperation(id = 'history.list') {
  return {
    id,
    kind: 'read',
    method: 'GET',
    urlTemplate: 'https://grok.com/rest/private/history',
    authMode: 'session',
    request: {
      inputSchema: { properties: {}, required: [] },
      credentialBindings: { cookies: ['grok_session'], headers: [] },
    },
    response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
    evidence: {
      source: 'browser_network_capture',
      capturedAt: '2026-10-05T00:00:00.000Z',
      requestMethod: 'GET',
      requestPath: '/rest/private/history',
      httpStatus: 200,
      responseContentType: 'application/json',
      securityBoundary: 'normal_observed_xhr',
      securitySignals: [],
    },
  };
}

function capturedIdentityOperation() {
  return {
    ...capturedReadOperation('auth.owner.read'),
    urlTemplate: 'https://grok.com/api/auth/session',
    role: 'identity',
    identityJsonPointer: '/email',
    evidence: {
      ...capturedReadOperation('auth.owner.read').evidence,
      requestPath: '/api/auth/session',
    },
  };
}

function isolatedChecklist(operationId = 'history.list') {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    checkedAt: '2026-10-05',
    receiptDirectory: 'verification/grok-feature-live-receipts',
    publicReplayReceipt: 'discovery/client-chrome-public-replay-2026-10-05.json',
    sourceAssets: {},
    handlerBindings: {
      'client.read': {
        kind: 'clientMethod',
        source: 'src/client.mjs',
        owner: 'GrokWebClient',
        member: 'read',
        codeFiles: ['src/client.mjs', 'src/transport.mjs'],
      },
      'client.verify-owner': {
        kind: 'clientMethod',
        source: 'src/client.mjs',
        owner: 'GrokWebClient',
        member: 'verifyOwner',
        codeFiles: ['src/client.mjs', 'src/transport.mjs', 'src/session.mjs'],
      },
    },
    features: [
      {
        id: 'auth.owner-identity',
        required: true,
        applicability: 'required',
        requirements: [{
          id: 'auth.owner.read',
          operationId: 'auth.owner.read',
          expectedKind: 'read',
          evidenceMode: 'captured_session_replay',
          handlerId: 'client.verify-owner',
          expectedAuthMode: 'session',
          requiresOwnerVerified: true,
          candidate: { status: 'unknown', origin: 'https://grok.com', method: null, path: null, fieldNames: [] },
        }],
      },
      {
        id: 'private.history',
        required: true,
        applicability: 'required',
        requirements: [{
          id: 'history.list',
          operationId,
          expectedKind: 'read',
          evidenceMode: 'captured_session_replay',
          handlerId: 'client.read',
          expectedAuthMode: 'session',
          requiresOwnerVerified: true,
          candidate: {
            status: 'source_candidate_only',
            origin: 'https://grok.com',
            method: 'GET',
            path: '/rest/private/history',
            fieldNames: [],
          },
        }],
      },
    ],
  };
}

function syntheticRegistry(operation, identityOperation = capturedIdentityOperation()) {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    serviceOrigin: 'https://grok.com',
    allowedOrigins: ['https://grok.com'],
    identityOperationId: identityOperation.id,
    operations: [identityOperation, operation],
  };
}

function identityReceipt(codeSha256, operation = capturedIdentityOperation()) {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    featureId: 'auth.owner-identity',
    requirementId: 'auth.owner.read',
    operationId: operation.id,
    observedAt: '2026-10-05T00:00:00.000Z',
    recordedAt: '2026-10-05T00:00:01.000Z',
    execution: 'direct_http_client',
    liveReplay: true,
    liveReplayRecorded: true,
    mocked: false,
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    ownerScopeSha256: '9'.repeat(64),
    httpStatus: 200,
    responseMime: 'application/json',
    responseBytes: 24,
    capturedOperationSha256: operationDigest(operation),
    requestDigest: 'c'.repeat(64),
    responseDigest: 'd'.repeat(64),
    handlerId: 'client.verify-owner',
    dispatchBinding: { handlerId: 'client.verify-owner', operationId: operation.id, operationKind: 'read', mode: 'identity_role_dispatch' },
    readinessAssertions: { handlerDispatchVerified: true },
    persistenceAssertions: { credentialValuesPersisted: false, cookiesPersisted: false, tokensPersisted: false },
    codeSha256,
  };
}

function privateReceipt(checklist, operation, codeSha256, overrides = {}) {
  const feature = checklist.features.find(item => item.id === 'private.history');
  const requirement = feature.requirements[0];
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    featureId: feature.id,
    requirementId: requirement.id,
    operationId: operation.id,
    observedAt: '2026-10-05T00:00:00.000Z',
    recordedAt: '2026-10-05T00:00:01.000Z',
    execution: 'direct_http_client',
    liveReplay: true,
    liveReplayRecorded: true,
    mocked: false,
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    ownerIdentityReceiptSha256: 'f'.repeat(64),
    httpStatus: 200,
    responseMime: 'application/json',
    responseBytes: 48,
    capturedOperationSha256: operationDigest(operation),
    requestDigest: 'a'.repeat(64),
    responseDigest: 'b'.repeat(64),
    handlerId: requirement.handlerId,
    dispatchBinding: {
      handlerId: requirement.handlerId,
      operationId: operation.id,
      operationKind: operation.kind,
      mode: 'validated_registry_generic',
    },
    readinessAssertions: { handlerDispatchVerified: true, ownerScopeBound: true },
    persistenceAssertions: { credentialValuesPersisted: false, cookiesPersisted: false, tokensPersisted: false },
    codeSha256,
    ...overrides,
  };
}

async function syntheticCheck({ receiptOverrides = {}, operation: suppliedOperation } = {}) {
  const checklist = isolatedChecklist(suppliedOperation?.id);
  const operation = suppliedOperation ?? capturedReadOperation();
  const identityOperationContract = capturedIdentityOperation();
  const registry = syntheticRegistry(operation, identityOperationContract);
  const binding = checklist.handlerBindings['client.read'];
  const identityCodeHashes = await hashesFor(checklist.handlerBindings['client.verify-owner'].codeFiles);
  const identity = identityReceipt(identityCodeHashes);
  const ownerProofPath = `verification/owner-proofs/${sha256Text(canonicalJson(identity))}.json`;
  const codeHashes = await hashesFor([...binding.codeFiles, ...checklist.handlerBindings['client.verify-owner'].codeFiles]);
  const receipt = privateReceipt(checklist, operation, codeHashes, {
    ownerIdentityReceiptSha256: sha256Text(canonicalJson(identity)),
    ownerProofPath,
    ownerProofSha256: sha256Text(canonicalJson(identity)),
    ownerScopeSha256: identity.ownerScopeSha256,
    ...receiptOverrides,
  });
  const report = evaluateFeatureChecklist({
    checklist,
    registry,
    receipts: [identity, receipt],
    codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true },
    ownerProofDocuments: { [ownerProofPath]: identity },
  });
  return { report, checklist, operation, receipt, identity, ownerProofPath,
    ownerProofDocuments: { [ownerProofPath]: identity }, codeHashes };
}

test('the repository checker labels recorded public evidence as offline and never as current network verification', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const publicReplayReceipt = await json(checklist.publicReplayReceipt);
  const files = [
    ...Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles),
    ...Object.keys(publicReplayReceipt.implementationSha256),
  ];
  const codeHashes = await hashesFor(files);
  const report = evaluateFeatureChecklist({
    checklist,
    registry,
    receipts: [],
    publicReplayReceipt,
    codeHashes,
    handlers: actualHandlers(checklist),
  });
  const publicFeature = report.features.find(item => item.id === 'models.public-catalog');
  assert.equal(publicFeature.requirements[0].evidence.evidenceScope, 'anonymous_public_metadata');
  assert.equal(publicFeature.requirements[0].evidence.liveReplayRecorded, true);
  assert.equal(report.currentNetworkVerified, false);
  assert.equal(report.evidenceFreshness, 'recorded_receipts_only_current_network_not_checked');
  const completeRequired = report.features.filter(item => item.required && item.status === 'stored_receipt_consistent').length;
  assert.equal(report.summary.completeRequiredFeatures, completeRequired);
  assert.equal(report.status === 'stored_receipt_consistent', report.summary.missingRequiredFeatures === 0);
});

test('a captured native SDK frame and WSS replay remain needs-reverification after dispatch code drift', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const ownerReceipt = await json('verification/grok-feature-live-receipts/auth-owner.read.json');
  const wssReceipt = await json('verification/grok-feature-live-receipts/chat.create-and-respond.wss.json');
  const publicReplayReceipt = await json(checklist.publicReplayReceipt);
  const files = [
    ...Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles),
    ...Object.keys(ownerReceipt.codeSha256),
    ...Object.keys(wssReceipt.codeSha256),
    ...Object.keys(publicReplayReceipt.implementationSha256),
  ];
  const codeHashes = await hashesFor(files);
  const report = evaluateFeatureChecklist({
    checklist, registry, receipts: [ownerReceipt, wssReceipt], publicReplayReceipt, codeHashes,
    handlers: actualHandlers(checklist),
  });
  const text = report.features.find(item => item.id === 'chat.text-generation');
  const create = text.requirements.find(item => item.id === 'chat.create-and-respond');
  const respond = text.requirements.find(item => item.id === 'chat.respond');
  assert.equal(create.ready, false);
  assert.equal(create.evidenceStatus, 'needs_reverification');
  assert.ok(create.blockers.includes('HANDLER_CODE_DRIFT'));
  assert.equal(create.evidence.transport, 'direct_wss');
  assert.equal(create.evidence.websocketHandshakeStatus, 101);
  assert.equal(create.evidence.oneBusinessFrameSent, true);
  assert.equal(create.evidence.boundToFreshServerSession, true);
  assert.equal(create.evidence.independentHistoryReadback, true);
  assert.equal(create.evidence.browserBusinessFrameDelivered, false);
  assert.deepEqual(create.evidence.evidencePhases, [
    'sdk_browser_input', 'browser_business_frame_blocked',
    'direct_wss_control_ack_and_business_send', 'independent_http_history_readback',
  ]);
  assert.equal(respond.ready, false);
  assert.equal(text.status, 'incomplete');
  assert.equal(report.currentNetworkVerified, false);
});

test('WSS receipt protocol or handler drift does not pass as stored consistency', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const ownerReceipt = await json('verification/grok-feature-live-receipts/auth-owner.read.json');
  const wssReceipt = await json('verification/grok-feature-live-receipts/chat.create-and-respond.wss.json');
  const codeHashes = await hashesFor([
    ...Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles),
    ...Object.keys(ownerReceipt.codeSha256),
    ...Object.keys(wssReceipt.codeSha256),
  ]);
  const changedChecklist = structuredClone(checklist);
  changedChecklist.protocolContracts['chat.text.wss'].business.inputChunkTextPath = 'event.item.text';
  const protocolReport = evaluateFeatureChecklist({
    checklist: changedChecklist, registry, receipts: [ownerReceipt, wssReceipt], codeHashes,
    handlers: actualHandlers(changedChecklist),
  });
  const protocolRequirement = protocolReport.features.find(item => item.id === 'chat.text-generation')
    .requirements.find(item => item.id === 'chat.create-and-respond');
  assert.ok(protocolRequirement.blockers.includes('WSS_PROTOCOL_CONTRACT_DRIFT'));
  assert.ok(protocolRequirement.blockers.includes('WSS_CAPTURE_PROTOCOL_MISMATCH'));

  const codeDriftHashes = { ...codeHashes, 'src/grok-text-websocket.mjs': 'f'.repeat(64) };
  const codeReport = evaluateFeatureChecklist({
    checklist, registry, receipts: [ownerReceipt, wssReceipt], codeHashes: codeDriftHashes,
    handlers: actualHandlers(checklist),
  });
  const codeRequirement = codeReport.features.find(item => item.id === 'chat.text-generation')
    .requirements.find(item => item.id === 'chat.create-and-respond');
  assert.ok(codeRequirement.blockers.includes('HANDLER_CODE_DRIFT'));
});

test('WSS regeneration evidence reports zero browser business delivery as false', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const ownerReceipt = await json('verification/grok-feature-live-receipts/auth-owner.read.json');
  const regenerationReceipt = await json('verification/grok-feature-live-receipts/chat.regenerate.response.wss.json');
  const codeHashes = await hashesFor([
    ...Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles),
    ...Object.keys(ownerReceipt.codeSha256),
    ...Object.keys(regenerationReceipt.codeSha256),
  ]);
  const report = evaluateFeatureChecklist({
    checklist, registry, receipts: [ownerReceipt, regenerationReceipt], codeHashes,
    handlers: actualHandlers(checklist),
  });
  const requirement = report.features.find(item => item.id === 'chat.regenerate')
    .requirements.find(item => item.id === 'chat.regenerate.response');
  assert.equal(requirement.ready, false);
  assert.equal(requirement.evidenceStatus, 'needs_reverification');
  assert.ok(requirement.blockers.includes('HANDLER_CODE_DRIFT'));
  assert.equal(requirement.evidence.browserBusinessFrameDelivered, false);
  assert.equal(requirement.evidence.verifiedNoBusinessRecoveryUsed, false);
});

test('conversation delete requires the exact guarded soft-delete route and unchanged non-target owners', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const ownerReceipt = await json('verification/grok-feature-live-receipts/auth-owner.read.json');
  const deleteReceipt = await json('verification/grok-feature-live-receipts/conversation.delete.json');
  const proofPath = 'verification/grok-conversation-crud-live-2026-10-06.json';
  const proofBytes = await readFile(path.join(ROOT, proofPath));
  const proof = JSON.parse(proofBytes.toString('utf8'));
  const codeHashes = await hashesFor([
    ...Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles),
    ...Object.keys(ownerReceipt.codeSha256),
    ...Object.keys(deleteReceipt.codeSha256),
  ]);
  // This positive validator scene uses a synthetic consistent code snapshot.
  // Never rewrite the checked-in live receipts after an unrelated CLI edit.
  const consistentFixture = receipt => ({ ...receipt, codeSha256: Object.fromEntries(
    Object.keys(receipt.codeSha256).map(file => [file, codeHashes[file]]),
  ) });
  const report = evaluateFeatureChecklist({
    checklist, registry, receipts: [consistentFixture(ownerReceipt), consistentFixture(deleteReceipt)], codeHashes,
    handlers: actualHandlers(checklist),
    sourceEvidenceHashes: { [proofPath]: createHash('sha256').update(proofBytes).digest('hex') },
    sourceEvidenceDocuments: { [proofPath]: proof },
  });
  const deletion = report.features.find(item => item.id === 'conversation.crud')
    .requirements.find(item => item.id === 'conversation.delete');
  assert.equal(deletion.ready, false);
  assert.ok(deletion.blockers.some(reason => ['HANDLER_CODE_DRIFT', 'OWNER_PROOF_REFERENCE_UNRESOLVED',
    'OWNER_IDENTITY_RECEIPT_MISSING'].includes(reason)));
  assert.equal(deletion.evidence.provenance, 'first_party_sdk_contract');
  assert.equal(deletion.evidence.sourceMethod, 'chatSoftDeleteConversationRaw');
  assert.equal(deletion.evidence.conversationAbsent, true);
  assert.equal(deletion.evidence.otherConversationsUnchanged, true);
  assert.equal(proof.browserGuardAndReset.browserBusinessFramesDelivered, 0);
  assert.equal(proof.operations.delete.attemptCount, 1);
  assert.equal(proof.readback.delete.completePaginatedListReadback, true);
  const driftedHashes = { ...codeHashes, 'src/cli.mjs': '0'.repeat(64) };
  const drifted = evaluateFeatureChecklist({
    checklist, registry, receipts: [consistentFixture(ownerReceipt), consistentFixture(deleteReceipt)], codeHashes: driftedHashes,
    handlers: actualHandlers(checklist),
    sourceEvidenceHashes: { [proofPath]: createHash('sha256').update(proofBytes).digest('hex') },
    sourceEvidenceDocuments: { [proofPath]: proof },
  });
  const changed = drifted.features.find(item => item.id === 'conversation.crud')
    .requirements.find(item => item.id === 'conversation.delete');
  assert.equal(changed.ready, false);
  assert.equal(changed.evidenceStatus, 'needs_reverification');
});

test('first-party workspace receipts match the source-backed replay and expose code drift for re-verification', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const ownerReceipt = await json('verification/grok-feature-live-receipts/auth-owner.read.json');
  const wssReceipt = await json('verification/grok-feature-live-receipts/chat.create-and-respond.wss.json');
  const receiptNames = [
    'workspace.list.json', 'workspace.shared-list.json', 'workspace.read.json',
    'workspace.create.json', 'workspace.update.json', 'workspace.delete.json',
  ];
  const workspaceReceipts = await Promise.all(receiptNames.map(name => json(`verification/grok-feature-live-receipts/${name}`)));
  const proofPath = 'verification/grok-workspaces-live-2026-10-06.json';
  const proofBytes = await readFile(path.join(ROOT, proofPath));
  const proof = JSON.parse(proofBytes.toString('utf8'));
  const publicReplayReceipt = await json(checklist.publicReplayReceipt);
  const codeHashes = await hashesFor([
    ...Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles),
    ...Object.keys(ownerReceipt.codeSha256),
    ...Object.keys(wssReceipt.codeSha256),
    ...workspaceReceipts.flatMap(receipt => Object.keys(receipt.codeSha256)),
    ...Object.keys(publicReplayReceipt.implementationSha256),
  ]);
  const report = evaluateFeatureChecklist({
    checklist, registry, receipts: [ownerReceipt, wssReceipt, ...workspaceReceipts], publicReplayReceipt, codeHashes,
    handlers: actualHandlers(checklist),
    sourceEvidenceHashes: { [proofPath]: createHash('sha256').update(proofBytes).digest('hex') },
    sourceEvidenceDocuments: { [proofPath]: proof },
  });
  const workspaces = report.features.find(item => item.id === 'workspaces');
  const create = workspaces.requirements.find(item => item.id === 'workspace.create');
  const deletion = workspaces.requirements.find(item => item.id === 'workspace.delete');
  assert.equal(workspaces.status, 'incomplete');
  assert.equal(create.evidenceStatus, 'needs_reverification');
  assert.ok(create.blockers.includes('HANDLER_CODE_DRIFT'));
  assert.equal(create.evidence.provenance, 'first_party_bundle_contract');
  assert.equal(create.evidence.browserWriteCapture, false);
  assert.equal(create.evidence.semanticReadbackVerified, true);
  assert.equal(deletion.evidence.semanticReadbackVerified, true);
  assert.equal(report.summary.checklistRequirements,
    checklist.features.reduce((count, feature) => count + feature.requirements.length, 0));
  assert.equal(report.currentNetworkVerified, false);
});

test('a captured contract plus owner-bound direct replay produces stored-receipt consistency', async () => {
  const { report } = await syntheticCheck();
  assert.equal(report.status, 'stored_receipt_consistent');
  assert.equal(report.summary.completeRequiredOperations, 2);
  assert.equal(report.currentNetworkVerified, false);
  assert.equal(report.evidenceFreshness, 'recorded_receipts_only_current_network_not_checked');
  const history = report.features.find(item => item.id === 'private.history').requirements[0];
  assert.equal(history.evidence.evidenceScope, 'same_authenticated_owner');
});

test('a mocked receipt cannot complete a private feature', async () => {
  const { report } = await syntheticCheck({ receiptOverrides: { mocked: true } });
  const requirement = report.features.find(item => item.id === 'private.history').requirements[0];
  assert.equal(report.status, 'incomplete');
  assert.ok(requirement.blockers.includes('RECEIPT_IS_NOT_LIVE'));
});

test('source-derived public.models 200 evidence cannot satisfy an authenticated private requirement', async () => {
  const checklist = isolatedChecklist('public.models');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const operation = registry.operations.find(item => item.id === 'public.models');
  const codeHashes = await hashesFor(checklist.handlerBindings['client.read'].codeFiles);
  const receipt = privateReceipt(checklist, operation, codeHashes);
  const report = evaluateFeatureChecklist({
    checklist,
    registry,
    receipts: [receipt],
    publicReplayReceipt: await json('discovery/client-chrome-public-replay-2026-10-05.json'),
    codeHashes,
    handlers: { 'client.read': true },
  });
  const requirement = report.features.find(item => item.id === 'private.history').requirements[0];
  assert.equal(requirement.ready, false);
  assert.ok(requirement.blockers.includes('PUBLIC_MODEL_CANNOT_SATISFY_PRIVATE_FEATURE'));
  assert.ok(requirement.blockers.includes('BROWSER_CAPTURE_REQUIRED'));
  assert.ok(requirement.blockers.includes('CONTRACT_AUTH_MODE_MISMATCH'));
});

test('contract or handler code drift invalidates a previously positive receipt', async () => {
  const { checklist, operation, receipt, ownerProofDocuments, codeHashes } = await syntheticCheck();
  const changedOperation = structuredClone(operation);
  changedOperation.response.maxBytes += 1;
  const contractDrift = evaluateFeatureChecklist({
    checklist,
    registry: syntheticRegistry(changedOperation),
    receipts: [identityReceipt(await hashesFor(checklist.handlerBindings['client.verify-owner'].codeFiles)), receipt],
    codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true },
    ownerProofDocuments,
  });
  assert.ok(contractDrift.features.find(item => item.id === 'private.history').requirements[0].blockers.includes('CAPTURED_CONTRACT_DRIFT'));

  const changedHashes = { ...codeHashes, 'src/client.mjs': 'c'.repeat(64) };
  const codeDrift = evaluateFeatureChecklist({
    checklist,
    registry: syntheticRegistry(operation),
    receipts: [identityReceipt(await hashesFor(checklist.handlerBindings['client.verify-owner'].codeFiles)), receipt],
    codeHashes: changedHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true },
    ownerProofDocuments,
  });
  assert.ok(codeDrift.features.find(item => item.id === 'private.history').requirements[0].blockers.includes('HANDLER_CODE_DRIFT'));
});

test('malformed live receipts are a schema error, not a feature pass', async () => {
  const { checklist, operation, receipt, codeHashes } = await syntheticCheck();
  const malformed = { ...receipt, requestDigest: 'not-a-digest' };
  assert.throws(() => evaluateFeatureChecklist({
    checklist,
    registry: syntheticRegistry(operation),
    receipts: [malformed],
    codeHashes,
    handlers: { 'client.read': true },
  }), error => error instanceof FeatureChecklistError && error.code === 'FEATURE_CHECK_SCHEMA_INVALID');

  for (const opaque of [
    { ...receipt, httpStatus: 0 },
    { ...receipt, liveReplayRecorded: false },
  ]) {
    assert.throws(() => evaluateFeatureChecklist({
      checklist,
      registry: syntheticRegistry(operation),
      receipts: [opaque],
      codeHashes,
      handlers: { 'client.read': true, 'client.verify-owner': true },
    }), error => error instanceof FeatureChecklistError && error.code === 'FEATURE_CHECK_SCHEMA_INVALID');
  }
});

test('private operation receipts bind to the exact identity scope and handler dispatch', async () => {
  const { report, checklist, operation, receipt, identity, ownerProofDocuments, codeHashes } = await syntheticCheck();
  const wrongOwner = { ...receipt, ownerScopeSha256: 'e'.repeat(64) };
  const reportWrongOwner = evaluateFeatureChecklist({
    checklist, registry: syntheticRegistry(operation), receipts: [identity, wrongOwner], codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true }, ownerProofDocuments,
  });
  const history = reportWrongOwner.features.find(item => item.id === 'private.history').requirements[0];
  assert.ok(history.blockers.includes('OWNER_IDENTITY_SCOPE_MISMATCH'));

  const wrongDispatch = {
    ...receipt,
    dispatchBinding: { ...receipt.dispatchBinding, operationId: 'different.operation' },
  };
  const reportWrongDispatch = evaluateFeatureChecklist({
    checklist, registry: syntheticRegistry(operation), receipts: [identity, wrongDispatch], codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true }, ownerProofDocuments,
  });
  assert.ok(reportWrongDispatch.features.find(item => item.id === 'private.history').requirements[0].blockers
    .includes('HANDLER_DISPATCH_NOT_BOUND'));
  assert.ok(report.features.find(item => item.id === 'private.history').requirements[0].ready);
});

test('a new timestamped owner proof does not invalidate a run linked to the archived same-owner proof', async () => {
  const { checklist, operation, receipt, identity, codeHashes } = await syntheticCheck();
  const archivedProof = { ...identity, observedAt: '2026-10-04T23:59:00.000Z', recordedAt: '2026-10-04T23:59:01.000Z' };
  const proofSha = sha256Text(canonicalJson(archivedProof));
  const proofPath = `verification/owner-proofs/${proofSha}.json`;
  const linkedReceipt = { ...receipt, ownerIdentityReceiptSha256: proofSha, ownerProofPath: proofPath,
    ownerProofSha256: proofSha, ownerScopeSha256: archivedProof.ownerScopeSha256 };
  const currentProof = { ...identity, observedAt: '2026-10-06T00:00:00.000Z', recordedAt: '2026-10-06T00:00:01.000Z' };
  const report = evaluateFeatureChecklist({
    checklist, registry: syntheticRegistry(operation), receipts: [currentProof, linkedReceipt], codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true }, ownerProofDocuments: { [proofPath]: archivedProof },
  });
  assert.equal(report.features.find(item => item.id === 'private.history').requirements[0].ready, true);
});

test('legacy owner digest fails closed when its exact archived proof is missing or belongs to another scope', async () => {
  const { checklist, operation, receipt, identity, ownerProofDocuments, codeHashes } = await syntheticCheck();
  const oldProof = { ...identity, observedAt: '2026-10-04T23:59:00.000Z', recordedAt: '2026-10-04T23:59:01.000Z' };
  const oldDigest = sha256Text(canonicalJson(oldProof));
  const legacyReceipt = { ...receipt, ownerIdentityReceiptSha256: oldDigest };
  delete legacyReceipt.ownerProofPath;
  delete legacyReceipt.ownerProofSha256;
  delete legacyReceipt.ownerScopeSha256;
  const evaluate = ownerProofDocumentsArg => evaluateFeatureChecklist({
    checklist, registry: syntheticRegistry(operation), receipts: [identity, legacyReceipt], codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true }, ownerProofDocuments: ownerProofDocumentsArg,
  }).features.find(item => item.id === 'private.history').requirements[0];
  assert.ok(evaluate({}).blockers.includes('OWNER_PROOF_REFERENCE_UNRESOLVED'));
  assert.equal(evaluate({ 'verification/conversation-read-runs/run-a/auth-owner.read.json': oldProof })
    .blockers.includes('OWNER_PROOF_REFERENCE_UNRESOLVED'), false);
  const wrongOwnerProof = { ...oldProof, ownerScopeSha256: 'e'.repeat(64) };
  const wrongDigest = sha256Text(canonicalJson(wrongOwnerProof));
  const wrongLegacyReceipt = { ...legacyReceipt, ownerIdentityReceiptSha256: wrongDigest };
  const wrongOwnerReport = evaluateFeatureChecklist({
    checklist, registry: syntheticRegistry(operation), receipts: [identity, wrongLegacyReceipt], codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true },
    ownerProofDocuments: { 'verification/conversation-read-runs/run-b/auth-owner.read.json': wrongOwnerProof },
  });
  assert.ok(wrongOwnerReport.features.find(item => item.id === 'private.history').requirements[0].blockers
    .includes('OWNER_IDENTITY_SCOPE_MISMATCH'));
});

test('typed safe readiness assertions are allowed while credential values and unknown secret fields fail closed', async () => {
  const { checklist, operation, receipt, identity, ownerProofDocuments, codeHashes } = await syntheticCheck();
  const safe = {
    ...receipt,
    readinessAssertions: { handlerDispatchVerified: true, ownerScopeBound: true, tokenRefreshVerified: false },
    persistenceAssertions: { credentialValuesPersisted: false, cookiesPersisted: false, tokensPersisted: false },
  };
  const safeReport = evaluateFeatureChecklist({
    checklist, registry: syntheticRegistry(operation), receipts: [identity, safe], codeHashes,
    handlers: { 'client.read': true, 'client.verify-owner': true }, ownerProofDocuments,
  });
  assert.equal(safeReport.status, 'stored_receipt_consistent');

  for (const invalid of [
    { ...receipt, cookieValue: 'must-not-be-stored' },
    { ...receipt, persistenceAssertions: { cookiesPersisted: 'false' } },
    { ...receipt, readinessAssertions: { tokenRefreshVerified: 'true' } },
  ]) {
    assert.throws(() => evaluateFeatureChecklist({
      checklist, registry: syntheticRegistry(operation), receipts: [identity, invalid], codeHashes,
      handlers: { 'client.read': true, 'client.verify-owner': true },
    }), error => error instanceof FeatureChecklistError && error.code === 'FEATURE_CHECK_SCHEMA_INVALID');
  }
});

test('candidate HTTP login receipts cannot stand in for native browser sign-in and owner-bound handoff', async () => {
  const { checklist, operation, receipt, identity, codeHashes } = await syntheticCheck();
  const candidate = {
    id: 'auth.login',
    required: true,
    applicability: 'required',
    requirements: [{
      id: 'auth.password-submit', operationId: 'auth.password-submit', expectedKind: 'submit',
      evidenceMode: 'captured_session_replay', handlerId: 'auth.login', expectedAuthMode: 'any',
      requiresOwnerVerified: false,
      candidate: { status: 'source_candidate_only', origin: 'https://accounts.x.ai', method: 'POST', path: '/api/auth/sign-in', fieldNames: ['email'] },
    }],
  };
  const authChecklist = { ...checklist, handlerBindings: {
    ...checklist.handlerBindings,
    'auth.login': { kind: 'clientMethod', source: 'src/client.mjs', owner: 'GrokWebClient', member: 'login', codeFiles: ['src/client.mjs'] },
  }, features: [...checklist.features, candidate] };
  const httpCandidateReceipt = { ...receipt, featureId: 'auth.login', requirementId: 'auth.password-submit', operationId: 'auth.password-submit' };
  const report = evaluateFeatureChecklist({
    checklist: authChecklist,
    registry: syntheticRegistry(operation),
    receipts: [identity, receipt, httpCandidateReceipt],
    codeHashes: { ...codeHashes, 'src/cli.mjs': '1'.repeat(64), 'src/bootstrap-receive.mjs': '2'.repeat(64), 'src/protected-json-store.mjs': '3'.repeat(64) },
    handlers: { 'client.read': true, 'client.verify-owner': true, 'auth.bootstrap': true },
  });
  const login = report.features.find(item => item.id === 'auth.login');
  assert.equal(login.status, 'incomplete');
  assert.ok(login.requirements[0].blockers.includes('NATIVE_AUTH_BOOTSTRAP_RECEIPT_MISSING'));
  assert.equal(login.unverifiedHttpLoginCandidates[0], 'auth.password-submit');
});

test('native browser sign-in and handoff pass only when linked to the direct HTTP owner scope', async () => {
  const { checklist, operation, receipt, identity, ownerProofPath, ownerProofDocuments, codeHashes } = await syntheticCheck();
  const authFeature = {
    id: 'auth.login',
    required: true,
    applicability: 'required',
    requirements: [{
      id: 'auth.password-submit', operationId: 'auth.password-submit', expectedKind: 'submit',
      evidenceMode: 'captured_session_replay', handlerId: 'auth.login', expectedAuthMode: 'any',
      requiresOwnerVerified: false,
      candidate: { status: 'source_candidate_only', origin: 'https://accounts.x.ai', method: 'POST', path: '/api/auth/sign-in', fieldNames: ['email'] },
    }],
  };
  const authChecklist = { ...checklist, handlerBindings: {
    ...checklist.handlerBindings,
    'auth.login': { kind: 'clientMethod', source: 'src/client.mjs', owner: 'GrokWebClient', member: 'login', codeFiles: ['src/client.mjs'] },
  }, features: [...checklist.features, authFeature] };
  const handoffFiles = [
    'src/bootstrap-receive.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/protected-json-store.mjs', 'src/session.mjs',
  ];
  const handoffCode = await hashesFor(handoffFiles);
  const nativeReceipt = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    featureId: 'auth.login',
    requirementId: 'auth.native-bootstrap',
    operationId: 'auth.native-bootstrap',
    observedAt: '2026-10-05T00:00:00.000Z',
    recordedAt: '2026-10-05T00:01:00.000Z',
    execution: 'native_browser_session_handoff',
    evidenceClass: 'native_auth_bootstrap',
    providerLoginObserved: true,
    nativeBrowserProfile: true,
    sessionHandoffVerified: true,
    sameAuthenticatedOwner: true,
    ownerVerified: true,
    evidenceScope: 'same_authenticated_owner',
    ownerIdentityReceiptSha256: sha256Text(canonicalJson(identity)),
    ownerProofPath,
    ownerProofSha256: sha256Text(canonicalJson(identity)),
    ownerScopeSha256: identity.ownerScopeSha256,
    challengeBypassUsed: false,
    passwordSubmittedToProviderApi: false,
    receiptContainsCredentialValues: false,
    persistenceAssertions: { credentialValuesPersisted: false, cookiesPersisted: false, tokensPersisted: false },
    codeSha256: handoffCode,
  };
  const report = evaluateFeatureChecklist({
    checklist: authChecklist,
    registry: syntheticRegistry(operation),
    receipts: [identity, receipt, nativeReceipt],
    codeHashes: { ...codeHashes, ...handoffCode },
    handlers: { 'client.read': true, 'client.verify-owner': true, 'auth.bootstrap': true },
    ownerProofDocuments,
  });
  const login = report.features.find(item => item.id === 'auth.login');
  assert.equal(login.status, 'stored_receipt_consistent');
  assert.equal(login.requirements[0].evidence.directHttpPasswordLogin, false);
  assert.equal(report.currentNetworkVerified, false);
});

test('direct asset upload stays incomplete when the 20-byte run lacks upload response-body measurements', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const operation = registry.operations.find(item => item.id === 'attachment.upload.direct');
  const identityOperation = registry.operations.find(item => item.id === registry.identityOperationId);
  const handler = checklist.handlerBindings['attachments.upload-direct'];
  const identityBinding = checklist.handlerBindings['client.verify-owner'];
  const codeHashes = await hashesFor([...handler.codeFiles, ...identityBinding.codeFiles]);
  const identity = identityReceipt(Object.fromEntries(identityBinding.codeFiles.map(file => [file, codeHashes[file]])), identityOperation);
  const ownerProofSha256 = sha256Text(canonicalJson(identity));
  const ownerProofPath = `verification/owner-proofs/${ownerProofSha256}.json`;
  const sourceProofPath = 'verification/grok-attachment-default-retention-live-2026-10-07.json';
  const sourceProof = await json(sourceProofPath);
  const sourceProofSha256 = await digestFile(sourceProofPath);
  const apiAuditPath = sourceProof.apiResult.apiAuditPath;
  const apiAuditRelativePath = path.relative(ROOT, apiAuditPath);
  const apiProof = await json(apiAuditRelativePath);
  const apiProofSha256 = await digestFile(apiAuditRelativePath);
  const receipt = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    featureId: 'conversation.uploads',
    requirementId: 'upload.direct.asset',
    operationId: 'attachment.upload.direct',
    observedAt: '2026-10-06T00:00:00.000Z',
    recordedAt: '2026-10-06T00:00:01.000Z',
    execution: 'direct_http_client',
    liveReplay: true,
    liveReplayRecorded: true,
    mocked: false,
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    ownerIdentityReceiptSha256: ownerProofSha256,
    ownerProofPath,
    ownerProofSha256,
    ownerScopeSha256: identity.ownerScopeSha256,
    httpStatus: 200,
    responseMime: 'application/json',
    responseBytes: 123,
    capturedOperationSha256: operationDigest(operation),
    requestDigest: 'a'.repeat(64),
    intentDigest: 'b'.repeat(64),
    responseDigest: 'c'.repeat(64),
    handlerId: 'attachments.upload-direct',
    dispatchBinding: {
      handlerId: 'attachments.upload-direct', operationId: 'attachment.upload.direct',
      operationKind: 'submit', mode: 'owner_bound_attachment_upload',
    },
    codeSha256: Object.fromEntries(handler.codeFiles.map(file => [file, codeHashes[file]])),
    codeHashCapturedAtExecution: true,
    readinessAssertions: { ownerScopeBound: true },
    persistenceAssertions: { credentialValuesPersisted: false },
    sourceProofPath,
    sourceProofSha256,
    semanticReadback: {
      uploadResponseParsed: true,
      uploadReferenceVerified: true,
      metadataReadbackVerified: true,
      assetReadbackVerified: true,
      downloadReadbackVerified: true,
      downloadBytesMatched: true,
      cleanupRequested: false,
      retainedForReuse: true,
    },
  };
  const report = evaluateFeatureChecklist({
    checklist,
    registry,
    receipts: [identity, receipt],
    codeHashes,
    handlers: { 'client.verify-owner': true, 'attachments.upload-direct': true },
    ownerProofDocuments: { [ownerProofPath]: identity },
    sourceEvidenceHashes: { [sourceProofPath]: sourceProofSha256, [apiAuditPath]: apiProofSha256 },
    sourceEvidenceDocuments: { [sourceProofPath]: sourceProof, [apiAuditPath]: apiProof },
  });
  const uploadFeature = report.features.find(item => item.id === 'conversation.uploads');
  const direct = uploadFeature.requirements.find(item => item.id === 'upload.direct.asset');
  assert.ok(direct.blockers.includes('DIRECT_UPLOAD_RESPONSE_BODY_EVIDENCE_MISSING'));
  assert.equal(direct.blockers.includes('HANDLER_NOT_INSTALLED'), false);
  assert.equal(direct.blockers.includes('HANDLER_DISPATCH_NOT_BOUND'), false);
  assert.equal(direct.blockers.includes('HANDLER_CODE_DRIFT'), false);
  assert.equal(direct.ready, false);
  assert.deepEqual(uploadFeature.requirements.filter(item => ['upload.init', 'upload.patch', 'upload.complete', 'upload.status', 'upload.abort']
    .includes(item.id)).map(item => item.id), ['upload.init', 'upload.patch', 'upload.complete', 'upload.status', 'upload.abort']);
  assert.ok(uploadFeature.requirements.some(item => item.id === 'upload.attach-to-conversation'
    && item.blockers.includes('CONTRACT_NOT_INSTALLED')));
  assert.equal(sourceProof.fileBytes, 20);
  assert.equal(sourceProof.apiResult.uploadHttpStatus, 200);
  assert.equal(Object.hasOwn(apiProof, 'uploadResponseBytes'), false);
});

test('normalized checklist uses installed upload and observed media routes while keeping alternate paths unverified', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const upload = checklist.features.find(item => item.id === 'conversation.uploads');
  const byRequirement = Object.fromEntries(upload.requirements.map(item => [item.id, item]));
  for (const [requirementId, operationId] of Object.entries({
    'upload.init': 'attachment.upload.init',
    'upload.complete': 'attachment.upload.complete',
    'upload.status': 'attachment.upload.status',
    'upload.abort': 'attachment.upload.abort',
  })) {
    assert.equal(byRequirement[requirementId].operationId, operationId);
    assert.ok(registry.operations.some(operation => operation.id === operationId));
    assert.equal(byRequirement[requirementId].evidenceMode, 'first_party_sdk_direct_replay');
  }
  assert.equal(byRequirement['upload.patch'].operationId, 'attachment.upload.patch');
  assert.equal(registry.operations.some(operation => operation.id === 'attachment.upload.patch'), false);

  const image = checklist.features.find(item => item.id === 'image-generation');
  assert.equal(image.requirements.find(item => item.id === 'image.generate.wss').candidate.path, '/ws/imagine/listen');
  assert.equal(image.requirements.find(item => item.id === 'image.history.list').operationId, 'media.assets.list');
  assert.ok(image.unverifiedAlternates.some(item => item.candidate.path === '/rest/media/pipeline/run'));
  assert.ok(image.unverifiedAlternates.every(item => item.candidate.status === 'source_candidate_only'));

  const video = checklist.features.find(item => item.id === 'video-generation');
  assert.equal(video.requirements.find(item => item.id === 'video.text-to-video').candidate.path, '/rest/app-chat/conversations/new');
  assert.equal(video.requirements.find(item => item.id === 'video.image-reference-to-video').candidate.path,
    '/rest/app-chat/conversations/new');
  assert.notEqual(video.requirements.find(item => item.id === 'video.text-to-video').id,
    video.requirements.find(item => item.id === 'video.image-reference-to-video').id);
  assert.ok(video.unverifiedAlternates.some(item => item.candidate.path === '/rest/media/video-sequence/create'));

  const artifact = checklist.features.find(item => item.id === 'artifact-download');
  assert.equal(artifact.requirements.find(item => item.id === 'artifact.image.download').candidate.origin, 'https://assets.grok.com');
  assert.equal(artifact.requirements.find(item => item.id === 'artifact.video.download').candidate.origin, 'https://assets.grok.com');
  assert.ok(artifact.requirements.some(item => item.id === 'artifact.conversation-file.download'));
  assert.ok(artifact.requirements.some(item => item.id === 'artifact.conversation-files.zip'));
  const mediaDownloadBinding = checklist.handlerBindings['media.asset-download'];
  assert.equal(mediaDownloadBinding.source, 'src/grok-media-api.mjs');
  assert.ok(mediaDownloadBinding.codeFiles.includes('src/client.mjs'));
  assert.ok(!mediaDownloadBinding.codeFiles.includes('contracts/grok-web.v1.json'));
  assert.ok(mediaDownloadBinding.codeFiles.includes('src/transport.mjs'));
  assert.ok(mediaDownloadBinding.codeFiles.includes('scripts/grok_media_asset_download.py'));
  assert.equal(mediaDownloadBinding.codeFiles.includes('src/cli.mjs'), false);

  const result = spawnSync(NODE, ['scripts/check-features.mjs', '--json'], { cwd: ROOT, encoding: 'utf8', env: {} });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  const imageFeature = report.features.find(item => item.id === 'image-generation');
  assert.equal(imageFeature.status, 'incomplete');
  assert.ok(imageFeature.requirements.every(item => item.blockers.includes('POSITIVE_MEDIA_REPLAY_RECEIPT_MISSING')
    || item.blockers.includes('POSITIVE_LIVE_RECEIPT_MISSING')));

  const videoFeature = report.features.find(item => item.id === 'video-generation');
  assert.equal(videoFeature.status, 'incomplete');
  assert.ok(videoFeature.requirements.every(item => item.blockers.includes('POSITIVE_MEDIA_REPLAY_RECEIPT_MISSING')));

  const artifactFeature = report.features.find(item => item.id === 'artifact-download');
  assert.equal(artifactFeature.status, 'incomplete');
  const videoDownload = artifactFeature.requirements.find(item => item.id === 'artifact.video.download');
  assert.equal(videoDownload.ready, false);
  assert.equal(videoDownload.reverificationRequired, true);
  assert.ok(videoDownload.blockers.includes('HANDLER_CODE_DRIFT'));
  const imageDownload = artifactFeature.requirements.find(item => item.id === 'artifact.image.download');
  const imageReceipt = await json('verification/grok-feature-live-receipts/media-artifact.image.download.json');
  const imageSourceCurrent = (await Promise.all(Object.entries(imageReceipt.codeSha256)
    .map(async ([file, digest]) => (await digestFile(file)) === digest))).every(Boolean);
  assert.equal(imageDownload.ready, imageSourceCurrent);
  assert.equal(imageDownload.reverificationRequired, !imageSourceCurrent);
  if (imageSourceCurrent) assert.deepEqual(imageDownload.blockers, []);
  else assert.ok(imageDownload.blockers.includes('HANDLER_CODE_DRIFT'));
  for (const requirementId of ['artifact.conversation-file.download', 'artifact.conversation-files.zip']) {
    const requirement = artifactFeature.requirements.find(item => item.id === requirementId);
    assert.equal(requirement.ready, false);
    assert.ok(requirement.blockers.includes('POSITIVE_MEDIA_REPLAY_RECEIPT_MISSING')
      || requirement.blockers.includes('POSITIVE_LIVE_RECEIPT_MISSING'));
  }
});

test('direct Imagine receipt schema binds actual WSS handler, owner proof, task assets, and execution-time code hashes', async () => {
  const checklist = await json('contracts/grok-feature-checklist.v1.json');
  const registry = await loadContractRegistry(path.join(ROOT, 'contracts/grok-web.v1.json'));
  const identityOperation = registry.operations.find(item => item.id === registry.identityOperationId);
  const identityBinding = checklist.handlerBindings['client.verify-owner'];
  const imageBinding = checklist.handlerBindings['media.image-wss'];
  const files = [...new Set([...Object.values(checklist.handlerBindings).flatMap(binding => binding.codeFiles),
    ...identityBinding.codeFiles, ...imageBinding.codeFiles])];
  const codeHashes = await hashesFor(files);
  const identity = identityReceipt(Object.fromEntries(identityBinding.codeFiles.map(file => [file, codeHashes[file]])), identityOperation);
  const ownerProofSha256 = sha256Text(canonicalJson(identity));
  const ownerProofPath = `verification/owner-proofs/${ownerProofSha256}.json`;
  const contract = checklist.mediaContracts['image.generate.wss'];
  const { operationContractSha256, registryPolicySha256 } = grokMediaOperationContractSnapshot(registry);
  const sourceProof = await json(contract.sourceEvidencePath);
  const sourceProofSha256 = await digestFile(contract.sourceEvidencePath);
  const receipt = {
    schemaVersion: 2,
    serviceId: 'grok-web',
    evidenceClass: 'direct_media_operation_replay',
    featureId: 'image-generation',
    requirementId: 'image.generate.wss',
    operationId: 'media.image.create',
    observedAt: '2026-10-06T00:00:00.000Z',
    recordedAt: '2026-10-06T00:00:01.000Z',
    execution: 'direct_wss_client',
    liveReplay: true,
    liveReplayRecorded: true,
    mocked: false,
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    ownerIdentityReceiptSha256: ownerProofSha256,
    ownerProofPath,
    ownerProofSha256,
    ownerScopeSha256: identity.ownerScopeSha256,
    handlerId: 'media.image-wss',
    dispatchBinding: {
      handlerId: 'media.image-wss', operationId: 'media.image.create',
      operationKind: 'submit', mode: 'direct_wss_imagine_image_batch4',
    },
    mediaContractSha256: sha256Text(canonicalJson(contract)),
    operationContractSnapshotAt: '2026-10-06T00:00:00.000Z',
    operationContractSha256,
    registryPolicySha256,
    requestDigest: 'a'.repeat(64),
    intentDigest: 'b'.repeat(64),
    promptSha256: 'c'.repeat(64),
    sourceCodeSnapshotAt: '2026-10-06T00:00:00.000Z',
    codeHashCapturedAtExecution: true,
    codeSha256: Object.fromEntries(imageBinding.codeFiles.map(file => [file, codeHashes[file]])),
    browserCapture: {
      captureMode: 'websocket_frame_blocked', pageRoleMatched: true, intentMatched: true,
      requestCaptured: true, businessActionBlocked: true, networkFailureCorrelated: false,
      browserBusinessWritesDelivered: 0, browserResponseCount: 0, rawRequestPersisted: false, rawResponsePersisted: false,
      requestBodyDigest: 'a'.repeat(64),
    },
    directTransport: {
      transport: 'wss', origin: contract.origin, path: contract.path, method: null,
      handshakeStatus: 101, controlFramesSent: 1, businessFramesSent: 1,
      requestStarted: true, responseReceived: false, httpStatus: null, responseMime: null,
      responseBytes: null, responseDigest: null, responseDigestKind: null,
      requestBodyDigest: 'a'.repeat(64), directDispatchCount: 1, automaticRetries: 0, attemptCount: 1,
    },
    operationReadbacks: contract.readbackOperationIds.map(operationId => ({
      operationId, httpStatus: 200, responseBytes: 128, responseDigest: 'd'.repeat(64), responseDigestKind: 'raw_http_body',
    })),
    semanticReadback: {
      taskBoundToIntent: true, exactPromptMatched: true, sourceImageTaskVerified: false,
      uniqueTaskCount: 1, assetCount: 4, privateGeneratedAssetCount: 4, expectedAssetCount: 4,
      sameConversationResponseSet: true, allAssetDownloadsVerified: true,
      allAssetMagicVerified: true, allFileReadbacksVerified: true,
    },
    artifact: Array.from({ length: 4 }, (_, index) => ({
      httpStatus: 200, mimeType: 'image/jpeg', bytes: 512 + index, sha256: `${String(index + 1).repeat(64).slice(0,64)}`,
      magicVerified: true, independentFileReadback: true, taskAssetMatched: true,
    })),
    persistenceAssertions: {
      credentialValuesPersisted: false, cookiesPersisted: false, tokensPersisted: false,
      rawFramesPersisted: false, assetBytesPersisted: false, assetIdsPersisted: false,
      promptPersisted: false, rawIdsOrKeysOrUrlsPersisted: false, cookiesOrTokensPersisted: false,
    },
  };
  const report = evaluateFeatureChecklist({
    checklist, registry, receipts: [identity, receipt], codeHashes, handlers: actualHandlers(checklist),
    ownerProofDocuments: { [ownerProofPath]: identity },
    sourceEvidenceHashes: { [contract.sourceEvidencePath]: sourceProofSha256 },
    sourceEvidenceDocuments: { [contract.sourceEvidencePath]: sourceProof },
  });
  const imageRequirement = report.features.find(item => item.id === 'image-generation')
    .requirements.find(item => item.id === 'image.generate.wss');
  assert.equal(imageRequirement.ready, true);
  assert.equal(report.currentNetworkVerified, false);
  const { operationContractSnapshotAt, operationContractSha256: scopedOperationHashes,
    registryPolicySha256: scopedRegistryPolicy, ...unscopedV2Receipt } = receipt;
  assert.ok(operationContractSnapshotAt);
  assert.ok(scopedOperationHashes);
  assert.ok(scopedRegistryPolicy);
  assert.throws(() => validateFeatureReceipts([unscopedV2Receipt]));

  const unrelatedRegistry = structuredClone(registry);
  unrelatedRegistry.operations.find(item => item.id === 'public.models').evidence.capturedAt = '2026-10-04';
  const unrelatedChange = evaluateFeatureChecklist({
    checklist, registry: unrelatedRegistry, receipts: [identity, receipt], codeHashes, handlers: actualHandlers(checklist),
    ownerProofDocuments: { [ownerProofPath]: identity },
    sourceEvidenceHashes: { [contract.sourceEvidencePath]: sourceProofSha256 },
    sourceEvidenceDocuments: { [contract.sourceEvidencePath]: sourceProof },
  });
  assert.equal(unrelatedChange.features.find(item => item.id === 'image-generation')
    .requirements.find(item => item.id === 'image.generate.wss').ready, true);

  const readbackDriftRegistry = structuredClone(registry);
  readbackDriftRegistry.operations.find(item => item.id === 'media.assets.list').evidence.capturedAt = '2026-10-05';
  const readbackDrift = evaluateFeatureChecklist({
    checklist, registry: readbackDriftRegistry, receipts: [identity, receipt], codeHashes, handlers: actualHandlers(checklist),
    ownerProofDocuments: { [ownerProofPath]: identity },
    sourceEvidenceHashes: { [contract.sourceEvidencePath]: sourceProofSha256 },
    sourceEvidenceDocuments: { [contract.sourceEvidencePath]: sourceProof },
  });
  const staleContract = readbackDrift.features.find(item => item.id === 'image-generation')
    .requirements.find(item => item.id === 'image.generate.wss');
  assert.equal(staleContract.ready, false);
  assert.ok(staleContract.blockers.includes('MEDIA_OPERATION_CONTRACT_DRIFT'));

  const policyDriftRegistry = structuredClone(registry);
  policyDriftRegistry.allowedOrigins.push('https://assets.grok.com');
  const policyDrift = evaluateFeatureChecklist({
    checklist, registry: policyDriftRegistry, receipts: [identity, receipt], codeHashes, handlers: actualHandlers(checklist),
    ownerProofDocuments: { [ownerProofPath]: identity },
    sourceEvidenceHashes: { [contract.sourceEvidencePath]: sourceProofSha256 },
    sourceEvidenceDocuments: { [contract.sourceEvidencePath]: sourceProof },
  });
  const stalePolicy = policyDrift.features.find(item => item.id === 'image-generation')
    .requirements.find(item => item.id === 'image.generate.wss');
  assert.equal(stalePolicy.ready, false);
  assert.ok(stalePolicy.blockers.includes('MEDIA_REGISTRY_POLICY_DRIFT'));

  const drifted = evaluateFeatureChecklist({
    checklist, registry, receipts: [identity, receipt],
    codeHashes: { ...codeHashes, 'src/grok-media-operations.mjs': '0'.repeat(64) },
    handlers: actualHandlers(checklist), ownerProofDocuments: { [ownerProofPath]: identity },
    sourceEvidenceHashes: { [contract.sourceEvidencePath]: sourceProofSha256 },
    sourceEvidenceDocuments: { [contract.sourceEvidencePath]: sourceProof },
  });
  const staleImage = drifted.features.find(item => item.id === 'image-generation')
    .requirements.find(item => item.id === 'image.generate.wss');
  assert.equal(staleImage.ready, false);
  assert.ok(staleImage.blockers.includes('HANDLER_CODE_DRIFT'));
});

test('strict CLI is offline and exits 2 while required private features are incomplete', () => {
  const result = spawnSync(NODE, ['scripts/check-features.mjs', '--strict', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, report.status === 'stored_receipt_consistent' ? 0 : 2);
  assert.equal(report.summary.completeRequiredFeatures,
    report.features.filter(item => item.required && item.status === 'stored_receipt_consistent').length);
  assert.match(report.ioPolicy, /no provider, login, browser, credential store, or network access/);
});
