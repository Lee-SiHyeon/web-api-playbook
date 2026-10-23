import { createHash } from 'node:crypto';
import { operationReadiness, validateContractRegistry } from './contracts.mjs';

const ID = /^[a-z][a-z0-9._-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const KINDS = new Set(['read', 'submit', 'poll', 'download', 'native']);
const EVIDENCE_MODES = new Set([
  'captured_session_replay', 'public_direct_replay', 'native_auth_bootstrap',
  'direct_wss_session_replay', 'direct_wss_regeneration_replay', 'first_party_bundle_direct_replay',
  'first_party_sdk_direct_replay', 'source_native_model_selection', 'direct_media_wss_replay', 'direct_media_http_replay',
  'direct_media_asset_download',
]);
const SAFE_REPO_FILE = /^(?:(?:src|scripts)\/[A-Za-z0-9._/-]+\.(?:mjs|js|py|txt)|contracts\/[A-Za-z0-9._/-]+\.json)$/;
const WSS_RECEIPT_KEYS = new Set([
  'schemaVersion', 'serviceId', 'evidenceClass', 'featureId', 'requirementId', 'operationId', 'observedAt', 'recordedAt',
  'execution', 'liveReplay', 'liveReplayRecorded', 'mocked', 'ownerVerified', 'sameAuthenticatedOwner', 'evidenceScope',
  'ownerIdentityReceiptSha256', 'ownerProofPath', 'ownerProofSha256', 'ownerScopeSha256',
  'handlerId', 'dispatchBinding', 'protocolSha256', 'requestDigest', 'promptSha256', 'evidencePhases',
  'assistantRegex', 'assistantRegexMatched', 'sourcePageRole', 'newChatContext', 'browserCapture', 'directTransport',
  'historyReadback', 'journal', 'codeSha256', 'persistenceAssertions',
]);
const WSS_REGEN_RECEIPT_KEYS = new Set([
  'schemaVersion', 'serviceId', 'evidenceClass', 'featureId', 'requirementId', 'operationId', 'observedAt', 'recordedAt',
  'execution', 'liveReplay', 'liveReplayRecorded', 'mocked', 'ownerVerified', 'sameAuthenticatedOwner', 'evidenceScope',
  'ownerIdentityReceiptSha256', 'ownerProofPath', 'ownerProofSha256', 'ownerScopeSha256',
  'handlerId', 'dispatchBinding', 'protocolSha256', 'requestDigest', 'intentDigest',
  'targetParentMessageSha256', 'assistantRegex', 'assistantRegexMatched', 'sourcePageRole', 'evidencePhases',
  'nativeCapture', 'browserGuards', 'directTransport', 'historyReadback', 'priorNegotiation', 'journal', 'codeSha256', 'persistenceAssertions',
]);
const PRIVATE_RECEIPT_KEYS = new Set([
  'schemaVersion', 'serviceId', 'featureId', 'requirementId', 'operationId', 'observedAt', 'recordedAt',
  'execution', 'liveReplay', 'liveReplayRecorded', 'mocked', 'ownerVerified', 'sameAuthenticatedOwner',
  'evidenceScope', 'ownerIdentityReceiptSha256', 'ownerProofPath', 'ownerProofSha256', 'ownerScopeSha256',
  'httpStatus', 'responseMime', 'responseBytes',
  'capturedOperationSha256', 'requestDigest', 'intentDigest', 'responseDigest', 'handlerId', 'dispatchBinding',
  'codeSha256', 'artifactVerified', 'readinessAssertions', 'persistenceAssertions', 'semanticReadback', 'readVariants',
  'responseDigestKind', 'restoreReplay', 'sourceProofPath', 'sourceProofSha256', 'codeHashCapturedAtExecution',
]);
const SDK_SEMANTIC_READBACK_KEYS = new Set([
  'readbackVerified', 'readbackStatus', 'preferenceName', 'beforeValue', 'afterValue',
  'otherPreferencesUnchanged', 'otherSettingsUnchanged', 'sameConversationId',
  'sameResponseId', 'shareLinkIdMatched', 'isPublic', 'allowIndexing', 'shareLinkAbsent',
  'restoreVerified', 'restoreStatus', 'restoreBeforeValue', 'restoreAfterValue',
  'restoreOtherPreferencesUnchanged', 'existingShareAbsent',
  'detailMatchesSearch', 'viewerIsOwner', 'mutableOwnerAccessVerified', 'responseNodeCount', 'inflightResponseCount',
  'loadedResponseCount', 'loadedUserMessageCount', 'loadedAssistantMessageCount', 'responseIdsBoundInMemory',
  'conversationAbsent', 'otherConversationsUnchanged', 'uploadReferenceVerified', 'metadataReadbackVerified',
  'assetReadbackVerified', 'downloadReadbackVerified', 'downloadBytesMatched', 'retainedForReuse',
  'cleanupRequested', 'conversationAssociationVerified', 'uploadResponseParsed',
]);
const CONVERSATION_READ_VARIANT_KEYS = new Set([
  'name', 'requestDigest', 'responseDigest', 'httpStatus', 'responseBytes', 'requestFieldNames',
  'conversationCount', 'nextPageTokenPresent', 'searchQuerySha256', 'textSearchMatchCount', 'targetConversationMatched',
]);
const FIRST_PARTY_RECEIPT_KEYS = new Set([
  'schemaVersion', 'serviceId', 'evidenceClass', 'featureId', 'requirementId', 'operationId', 'observedAt', 'recordedAt',
  'execution', 'liveReplay', 'liveReplayRecorded', 'mocked', 'ownerVerified', 'sameAuthenticatedOwner', 'evidenceScope',
  'ownerIdentityReceiptSha256', 'ownerProofPath', 'ownerProofSha256', 'ownerScopeSha256',
  'sourceProofPath', 'sourceProofSha256', 'sourceContractSha256', 'capturedOperationSha256',
  'method', 'pathTemplate', 'requestFieldNames', 'responseFieldNames', 'httpStatus', 'responseMime', 'responseBytes',
  'requestDigest', 'intentDigest', 'responseDigest', 'attemptCount', 'handlerId', 'dispatchBinding', 'transport',
  'semanticReadback', 'codeSha256', 'persistenceAssertions',
]);
const MEDIA_RECEIPT_KEYS = new Set([
  'schemaVersion', 'serviceId', 'evidenceClass', 'featureId', 'requirementId', 'operationId', 'observedAt', 'recordedAt',
  'execution', 'liveReplay', 'liveReplayRecorded', 'mocked', 'ownerVerified', 'sameAuthenticatedOwner', 'evidenceScope',
  'ownerIdentityReceiptSha256', 'ownerProofPath', 'ownerProofSha256', 'ownerScopeSha256',
  'handlerId', 'dispatchBinding', 'mediaContractSha256', 'requestDigest', 'intentDigest', 'promptSha256', 'generationMode',
  'sourceCodeSnapshotAt', 'operationContractSnapshotAt', 'operationContractSha256', 'registryPolicySha256',
  'browserCapture', 'directTransport', 'operationReadbacks', 'semanticReadback', 'artifact',
  'codeSha256', 'codeHashCapturedAtExecution', 'persistenceAssertions',
]);
const MEDIA_BROWSER_CAPTURE_KEYS = new Set([
  'captureMode', 'pageRoleMatched', 'intentMatched', 'requestCaptured', 'businessActionBlocked',
  'networkFailureCorrelated', 'browserBusinessWritesDelivered', 'browserResponseCount', 'rawRequestPersisted', 'rawResponsePersisted',
  'requestBodyDigest',
]);
const MEDIA_DIRECT_TRANSPORT_KEYS = new Set([
  'transport', 'origin', 'path', 'method', 'handshakeStatus', 'controlFramesSent', 'businessFramesSent',
  'requestStarted', 'responseReceived', 'httpStatus', 'responseMime', 'responseBytes', 'responseDigest',
  'responseDigestKind', 'requestBodyDigest', 'directDispatchCount', 'automaticRetries', 'tlsVerified',
  'redirectsFollowed', 'trustEnv', 'attemptCount',
]);
const MEDIA_READBACK_KEYS = new Set([
  'taskBoundToIntent', 'exactPromptMatched', 'sourceImageTaskVerified', 'uniqueTaskCount', 'assetCount',
  'privateGeneratedAssetCount', 'expectedAssetCount', 'sameConversationResponseSet',
  'allAssetDownloadsVerified', 'allAssetMagicVerified', 'allFileReadbacksVerified',
  'assetOwnerVerified', 'assetPromptMatched', 'sourceConversationMatched',
]);
const MEDIA_ARTIFACT_KEYS = new Set([
  'httpStatus', 'mimeType', 'bytes', 'sha256', 'magicVerified', 'independentFileReadback', 'taskAssetMatched',
]);
const MEDIA_OPERATION_CONTRACT_IDS = Object.freeze([
  'auth.owner.read', 'media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses',
]);
const MODEL_SELECTION_PHASE_RECEIPT_KEYS = new Set([
  'schemaVersion', 'serviceId', 'evidenceClass', 'evidencePath', 'featureId', 'requirementId', 'operationId',
  'observedAt', 'recordedAt', 'execution', 'liveReplay', 'liveReplayRecorded', 'mocked', 'ownerVerified',
  'sameAuthenticatedOwner', 'evidenceScope', 'ownerIdentityReceiptSha256', 'ownerProofPath', 'ownerProofSha256',
  'ownerScopeSha256', 'handlerId', 'dispatchBinding', 'sourceFacts', 'selection', 'normalSdkCapture',
  'catalogRead', 'directTransport', 'terminalMetadata', 'historyReadback', 'sessionHandoff', 'journal', 'sourceSnapshot', 'codeSha256',
  'persistenceAssertions',
]);
const MODEL_SELECTION_PHASE_SOURCE_KEYS = new Set([
  'catalogOperationId', 'catalogMethod', 'catalogPath', 'catalogRequestFieldNames', 'modeStore',
  'selectedModeField', 'setter', 'setterSourceTag', 'storageKey', 'selectionEffect',
  'nativeSessionModelPath', 'serverAckModelPath', 'sourceAssetSha256',
]);
const MODEL_SELECTION_PHASE_SELECTION_KEYS = new Set([
  'selectedModeId', 'sourceSessionModel', 'serverSessionAcknowledgementModeEchoed',
  'selectionSource', 'selectionEffect', 'serverPreferenceWriteForwarded', 'providerBackendModelVersion',
  'providerBackendModelVersionObserved',
]);
const MODEL_SELECTION_PHASE_CATALOG_KEYS = new Set([
  'operationId', 'method', 'path', 'status', 'responseBytes', 'choiceCount', 'defaultModeId',
  'selectedModeId', 'selectedModeAvailable', 'ownerBound', 'rawCatalogPersisted',
]);
const MODEL_SELECTION_PHASE_CAPTURE_KEYS = new Set([
  'sourcePageRole', 'sourceSetterCallsiteVerified', 'selectionFastVisible', 'selectionFastStored',
  'browserSessionAckModel', 'businessFrameCaptured', 'exactPromptMatched', 'browserBusinessFramesForwarded',
  'browserBusinessWritesDelivered', 'browserHttpWritesBlocked', 'uiRestoredAuto',
]);
const MODEL_SELECTION_PHASE_TRANSPORT_KEYS = new Set([
  'origin', 'path', 'handshakeStatus', 'normalControlFrameSentCount', 'serverSessionAcknowledgementObserved',
  'businessFrameSentCount', 'businessFrameBoundToServerSession', 'terminalEventObserved', 'terminalEventType',
  'terminalStatusMetadataCaptured', 'eventTypes',
]);
const MODEL_SELECTION_PHASE_TERMINAL_KEYS = new Set([
  'eventType', 'responseStatus', 'responseStatusReason', 'errorClass', 'errorCode', 'responseFieldNames',
  'errorFieldNames', 'statusOrErrorValueObserved',
]);
const MODEL_SELECTION_PHASE_HISTORY_KEYS = new Set([
  'ownerBound', 'listStatus', 'listResponseBytes', 'windowStart', 'windowEnd', 'timestampField', 'candidateCount',
  'candidateReadCount', 'exactPromptCandidateCount', 'detailStatus', 'detailResponseBytes',
  'responseNodesStatus', 'responseNodesResponseBytes', 'loadResponsesStatus', 'loadResponsesResponseBytes',
  'userTurnCount', 'assistantTurnCount', 'exactPromptMatched', 'assistantTextLengthCodePoints',
  'assistantTextSha256', 'assistantExactExpectedTextMatched', 'conversationIdSha256',
  'assistantResponseIdSha256', 'responseIdHintMatched', 'candidateReadStatusesAll200',
]);
const MODEL_SELECTION_PHASE_HANDOFF_KEYS = new Set([
  'mechanism', 'ownerReadStatus', 'sameOwnerVerified', 'credentialChanged', 'providerCookieRotationVerified',
  'expiredProviderSessionRecoveryVerified', 'mutationRetried',
]);
const MODEL_SELECTION_PHASE_JOURNAL_KEYS = new Set([
  'initialState', 'finalState', 'attemptCount', 'httpStatus', 'reasonCode', 'reconciledBy',
  'requestDigest', 'intentDigest', 'localOperationIdSha256',
]);
const MODEL_SELECTION_PHASE_SNAPSHOT_KEYS = new Set([
  'treeSha256', 'stableThroughTerminal', 'fileCount', 'codeSha256',
]);
const PHASE_CLAIM_KEYS = new Set(['id', 'status', 'receiptPath', 'ownerScopeSha256']);
const MEDIA_OPERATION_READBACK_KEYS = new Set(['operationId', 'httpStatus', 'responseBytes', 'responseDigest', 'responseDigestKind']);
const PRIVATE_READINESS_KEYS = new Set([
  'ownerScopeBound', 'handlerDispatchVerified', 'sessionHandoffVerified', 'renewalOutcomeVerified',
  'artifactVerified', 'tokenRefreshVerified', 'cookieRotationObserved', 'challengeBypassUsed',
]);
const PRIVATE_PERSISTENCE_KEYS = new Set([
  'credentialValuesPersisted', 'cookiesPersisted', 'tokensPersisted', 'requestBodiesPersisted',
  'responseBodiesPersisted', 'signedUrlValuesPersisted', 'passwordValuesPersisted',
  'conversationIdsPersisted', 'conversationTitlesPersisted', 'responseIdsPersisted', 'messageBodiesPersisted',
]);
const NATIVE_AUTH_RECEIPT_KEYS = new Set([
  'schemaVersion', 'serviceId', 'featureId', 'requirementId', 'operationId', 'observedAt', 'recordedAt',
  'execution', 'evidenceClass', 'providerLoginObserved', 'nativeBrowserProfile', 'sessionHandoffVerified',
  'sameAuthenticatedOwner', 'ownerVerified', 'evidenceScope', 'ownerIdentityReceiptSha256',
  'ownerProofPath', 'ownerProofSha256', 'ownerScopeSha256',
  'challengeBypassUsed', 'passwordSubmittedToProviderApi', 'receiptContainsCredentialValues',
  'readinessAssertions', 'persistenceAssertions', 'codeSha256',
]);
const NATIVE_AUTH_CODE_FILES = Object.freeze([
  'src/bootstrap-receive.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/protected-json-store.mjs', 'src/session.mjs',
]);

const HANDLER_DISPATCH = Object.freeze({
  'client.read': { kinds: new Set(['read', 'poll']), mode: 'validated_registry_generic' },
  'client.submit': { kinds: new Set(['submit']), mode: 'validated_registry_generic' },
  'client.download': { kinds: new Set(['download']), mode: 'validated_registry_generic' },
  'client.verify-owner': { kinds: new Set(['read']), mode: 'identity_role_dispatch' },
  'attachments.upload-direct': { kinds: new Set(['submit']), mode: 'owner_bound_attachment_upload' },
  'media.image-wss': { kinds: new Set(['submit']), mode: 'direct_wss_imagine_image_batch4' },
  'media.video-submit': { kinds: new Set(['submit']), mode: 'owner_bound_media_http_one_shot' },
  'media.asset-download': { kinds: new Set(['download']), mode: 'owner_bound_generated_asset_download' },
  'chat.text-wss': { kinds: new Set(['submit']), mode: 'direct_wss_single_frame' },
  'models.selected-mode-text': { kinds: new Set(['submit']), mode: 'source_native_model_selection_direct_wss' },
  'chat.regenerate-wss': { kinds: new Set(['submit']), mode: 'direct_wss_existing_task_regeneration' },
  'workspaces.list': { kinds: new Set(['read']), mode: 'owner_bound_workspace_client' },
  'workspaces.shared-list': { kinds: new Set(['read']), mode: 'owner_bound_workspace_client' },
  'workspaces.read': { kinds: new Set(['read']), mode: 'owner_bound_workspace_client' },
  'workspaces.create': { kinds: new Set(['submit']), mode: 'owner_bound_workspace_client' },
  'workspaces.update': { kinds: new Set(['submit']), mode: 'owner_bound_workspace_client' },
  'workspaces.delete': { kinds: new Set(['submit']), mode: 'owner_bound_workspace_client' },
});
const WORKSPACE_OPERATION_HANDLERS = Object.freeze({
  'workspaces.list': 'workspaces.list',
  'workspaces.shared.list': 'workspaces.shared-list',
  'workspaces.read': 'workspaces.read',
  'workspaces.create': 'workspaces.create',
  'workspaces.update': 'workspaces.update',
  'workspaces.delete': 'workspaces.delete',
});
const WORKSPACE_RECEIPT_REQUIREMENTS = Object.freeze({
  'workspaces.list': { requirementId: 'workspace.list', handlerId: 'workspaces.list', kind: 'read', method: 'GET' },
  'workspaces.shared.list': { requirementId: 'workspace.shared-list', handlerId: 'workspaces.shared-list', kind: 'read', method: 'GET' },
  'workspaces.read': { requirementId: 'workspace.read', handlerId: 'workspaces.read', kind: 'read', method: 'GET' },
  'workspaces.create': { requirementId: 'workspace.create', handlerId: 'workspaces.create', kind: 'submit', method: 'POST' },
  'workspaces.update': { requirementId: 'workspace.update', handlerId: 'workspaces.update', kind: 'submit', method: 'PUT' },
  'workspaces.delete': { requirementId: 'workspace.delete', handlerId: 'workspaces.delete', kind: 'submit', method: 'DELETE' },
});
const REVERIFICATION_BLOCKERS = new Set([
  'HANDLER_CODE_DRIFT', 'HANDLER_SOURCE_MISSING', 'NATIVE_SESSION_HANDLER_CODE_DRIFT',
  'WSS_PROTOCOL_CONTRACT_DRIFT', 'WSS_CAPTURE_PROTOCOL_MISMATCH', 'CAPTURED_CONTRACT_DRIFT',
  'FIRST_PARTY_SOURCE_ASSET_MISMATCH', 'SOURCE_EVIDENCE_MISSING_OR_DRIFTED', 'SOURCE_EVIDENCE_RECEIPT_MISMATCH',
  'HANDLER_SOURCE_BINDING_UNVERIFIED',
]);

export class FeatureChecklistError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FeatureChecklistError';
    this.code = code;
  }
}

function invalid() {
  throw new FeatureChecklistError('FEATURE_CHECK_SCHEMA_INVALID');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

function safeRepoPath(value) {
  return typeof value === 'string' && SAFE_REPO_FILE.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

function safeOwnerProofPath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) return false;
  const ownerProof = /^verification\/owner-proofs\/[a-f0-9]{64}\.json$/.test(value);
  const perRun = /^verification\/conversation-read-runs\/[A-Za-z0-9._:-]{1,160}\/auth-owner\.read\.json$/.test(value);
  return (ownerProof || perRun) && !value.split('/').some(part => !part || part === '.' || part === '..');
}

function safeVerificationPath(value) {
  return typeof value === 'string' && value.startsWith('verification/')
    && !value.includes('\\') && !value.includes('\0')
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

function validateOwnerProofReferenceFields(receipt, { identityReceipt = false } = {}) {
  if (identityReceipt) {
    if (receipt.ownerProofPath !== undefined || receipt.ownerProofSha256 !== undefined
      || (receipt.ownerScopeSha256 !== undefined && !SHA256.test(receipt.ownerScopeSha256))) invalid();
    return;
  }
  const keys = ['ownerProofPath', 'ownerProofSha256', 'ownerScopeSha256'];
  const present = keys.filter(key => receipt[key] !== undefined).length;
  if (present !== 0 && present !== keys.length) invalid();
  if (present === keys.length) {
    if (!safeOwnerProofPath(receipt.ownerProofPath) || !SHA256.test(receipt.ownerProofSha256)
      || !SHA256.test(receipt.ownerScopeSha256)
      || (receipt.ownerIdentityReceiptSha256 !== undefined
        && receipt.ownerIdentityReceiptSha256 !== receipt.ownerProofSha256)) invalid();
  }
  if (present === 0 && !SHA256.test(receipt.ownerIdentityReceiptSha256 ?? '')) invalid();
}

function onlyKeys(value, allowed) {
  return record(value) && Object.keys(value).every(key => allowed.has(key));
}

function validateBooleanAssertions(value, allowed, { requireFalse = false } = {}) {
  if (value === undefined) return;
  if (!onlyKeys(value, allowed) || Object.values(value).some(item => typeof item !== 'boolean')) invalid();
  if (requireFalse && Object.values(value).some(item => item !== false)) invalid();
}

function validatePhaseClaims(feature) {
  if (feature.phaseClaims === undefined) return;
  if (!['auth.session-renewal', 'models.private-selection'].includes(feature.id)
    || !Array.isArray(feature.phaseClaims) || !feature.phaseClaims.length || feature.phaseClaims.length > 8) invalid();
  const ids = new Set();
  for (const claim of feature.phaseClaims) {
    if (!onlyKeys(claim, PHASE_CLAIM_KEYS) || !ID.test(claim.id) || ids.has(claim.id)
      || !['verified_phase_claim', 'unverified', 'needs_reverification'].includes(claim.status)
      || !safeVerificationPath(claim.receiptPath) || !SHA256.test(claim.ownerScopeSha256)) invalid();
    ids.add(claim.id);
  }
}

function isoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function operationDigest(operation) {
  return sha256Text(canonicalJson(operation));
}

export function validateFeatureChecklist(checklist) {
  if (!record(checklist) || checklist.schemaVersion !== 1 || checklist.serviceId !== 'grok-web'
    || typeof checklist.checkedAt !== 'string' || !Number.isFinite(Date.parse(checklist.checkedAt))
    || checklist.receiptDirectory !== 'verification/grok-feature-live-receipts'
    || checklist.publicReplayReceipt !== 'discovery/client-chrome-public-replay-2026-10-05.json'
    || !record(checklist.handlerBindings) || !Array.isArray(checklist.features) || !checklist.features.length
    || !record(checklist.sourceAssets)) invalid();

  for (const [assetId, asset] of Object.entries(checklist.sourceAssets)) {
    if (!ID.test(assetId) || !record(asset) || !validOrigin(asset.origin)
      || typeof asset.path !== 'string' || !asset.path.startsWith('/') || /[?#]/.test(asset.path)
      || asset.path.split('/').some(part => part === '.' || part === '..')
      || !SHA256.test(asset.sha256) || typeof asset.classification !== 'string') invalid();
  }

  for (const [handlerId, binding] of Object.entries(checklist.handlerBindings)) {
    if (!ID.test(handlerId) || !record(binding) || !['clientMethod', 'namedExport'].includes(binding.kind)
      || !safeRepoPath(binding.source) || typeof binding.member !== 'string' || !binding.member
      || (binding.kind === 'clientMethod' && (typeof binding.owner !== 'string' || !binding.owner))
      || (binding.kind === 'namedExport' && binding.owner !== null)
      || !Array.isArray(binding.codeFiles) || !binding.codeFiles.length
      || binding.codeFiles.some(file => !safeRepoPath(file)) || !binding.codeFiles.includes(binding.source)) invalid();
    if (binding.workspaceMethod !== undefined
      && (binding.source !== 'src/grok-workspaces.mjs' || binding.kind !== 'namedExport'
        || binding.member !== 'createGrokWorkspaceClient'
        || !['list', 'listShared', 'read', 'create', 'update', 'delete'].includes(binding.workspaceMethod))) invalid();
    if (binding.factoryMethod !== undefined) {
      const attachmentFactory = handlerId === 'attachments.upload-direct' && binding.source === 'src/grok-attachment-upload.mjs'
        && binding.member === 'createGrokAttachmentUploadClient' && binding.factoryMethod === 'uploadDirect';
      const mediaFactory = handlerId === 'media.asset-download' && binding.source === 'src/grok-media-api.mjs'
        && binding.member === 'createGrokMediaApi' && binding.factoryMethod === 'downloadAssetToFile';
      if (binding.kind !== 'namedExport' || (!attachmentFactory && !mediaFactory)) invalid();
    }
  }

  if (checklist.protocolContracts !== undefined) {
    if (!record(checklist.protocolContracts)) invalid();
    for (const [protocolId, protocol] of Object.entries(checklist.protocolContracts)) {
      if (!ID.test(protocolId) || !record(protocol) || protocol.schemaVersion !== 1
        || protocol.operationId !== protocolId || protocol.transport !== 'wss'
        || protocol.origin !== 'https://grok.com' || protocol.path !== '/ws/mgw/'
        || JSON.stringify(protocol.queryKeyNames) !== JSON.stringify(['uid'])
        || typeof protocol.sourcePageRole !== 'string' || !Object.hasOwn(checklist.sourceAssets, protocol.sourceAsset)) invalid();
      if (protocol.protocolKind === 'existing_task_regeneration') {
        if (protocol.operationId !== 'chat.regenerate.wss' || protocol.sourcePageRole !== 'codex-grok-lifecycle-20261006'
          || !record(protocol.control) || protocol.control.eventType !== 'session.create'
          || JSON.stringify(protocol.control.allowedTopLevelFieldNames) !== JSON.stringify([['event'], ['event', 'session_id']])
          || JSON.stringify(protocol.control.eventFieldNames) !== JSON.stringify(['event_id', 'session', 'type'])
          || JSON.stringify(protocol.control.sessionFieldNames) !== JSON.stringify(['model', 'x_grok'])
          || protocol.control.sessionIdFieldPresent !== false
          || JSON.stringify(protocol.control.requiredExistingTaskFields) !== JSON.stringify(['active_response_id', 'conversation_id', 'initial_leaf_id', 'load_existing'])
          || protocol.control.loadExistingValue !== true
          || !record(protocol.business) || protocol.business.eventType !== 'response.create'
          || JSON.stringify(protocol.business.requiredEventFieldNames) !== JSON.stringify(['castle_request_token', 'event_id', 'parent_response_id', 'type'])
          || protocol.business.parentResponseIdField !== 'parent_response_id'
          || protocol.business.castleTokenField !== 'castle_request_token'
          || protocol.business.rebindOuterSessionIdOnly !== true
          || !record(protocol.history) || JSON.stringify(protocol.history.readbackOperationIds)
            !== JSON.stringify(['conversation.read', 'history.response-nodes', 'history.load-responses'])
          || protocol.history.requireSameTask !== true || protocol.history.requireNewAssistantWithSameParent !== true
          || protocol.history.requireUnchangedUserResponseCount !== true || protocol.history.requiredAddedAssistantCount !== 1
          || !SHA256.test(protocol.targetParentMessageSha256) || typeof protocol.assistantRegex !== 'string') invalid();
        try { new RegExp(protocol.assistantRegex); } catch { invalid(); }
      } else if (protocol.protocolKind === undefined) {
        if (!record(protocol.control) || protocol.control.eventType !== 'session.create'
          || JSON.stringify(protocol.control.topLevelFieldNames) !== JSON.stringify(['event'])
          || JSON.stringify(protocol.control.eventFieldNames) !== JSON.stringify(['event_id', 'session', 'type'])
          || JSON.stringify(protocol.control.sessionFieldNames) !== JSON.stringify(['model', 'x_grok'])
          || protocol.control.sessionIdPresent !== false || typeof protocol.control.modelType !== 'string'
          || !Array.isArray(protocol.control.xGrokFieldNames) || !Array.isArray(protocol.control.absentTargetFieldNames)
          || JSON.stringify(protocol.control.absentTargetFieldNames) !== JSON.stringify(['conversation_id', 'initial_load_id', 'load_existing'])
          || JSON.stringify(protocol.control.workspaceFieldNames) !== JSON.stringify([])
          || protocol.control.connectorIdValuesPersisted !== false
          || !record(protocol.business) || protocol.business.eventType !== 'response.create'
          || protocol.business.itemType !== 'message' || protocol.business.itemRole !== 'user'
          || typeof protocol.business.inputChunkTextPath !== 'string' || !SHA256.test(protocol.promptSha256)
          || typeof protocol.assistantRegex !== 'string' || !Array.isArray(protocol.readbackOperationIds)
          || protocol.readbackOperationIds.length !== 4 || protocol.readbackOperationIds.some(id => !ID.test(id))) invalid();
      } else invalid();
    }
  }

  const hasMediaRequirements = checklist.features.some(feature => feature?.requirements?.some(requirement =>
    typeof requirement?.evidenceMode === 'string' && requirement.evidenceMode.startsWith('direct_media_')));
  if (checklist.mediaContracts === undefined && hasMediaRequirements) invalid();
  if (checklist.mediaContracts !== undefined && !record(checklist.mediaContracts)) invalid();
  if (record(checklist.mediaContracts)) {
    const expectedMediaContractIds = [
      'artifact.image.download', 'artifact.video.download', 'image.generate.wss',
      'video.image-reference-to-video', 'video.text-to-video',
    ];
    if (JSON.stringify(Object.keys(checklist.mediaContracts).sort()) !== JSON.stringify(expectedMediaContractIds)) invalid();
    for (const [requirementId, contract] of Object.entries(checklist.mediaContracts)) {
    if (!ID.test(requirementId) || !record(contract) || contract.schemaVersion !== 1
      || contract.requirementId !== requirementId || !ID.test(contract.operationId)) invalid();
    if (requirementId === 'image.generate.wss') {
      if (contract.operationId !== 'media.image.create' || contract.mode !== 'image_wss_batch4'
        || contract.transport !== 'wss' || contract.origin !== 'wss://grok.com' || contract.path !== '/ws/imagine/listen'
        || contract.requestEventType !== 'conversation.item.create' || contract.requestItemType !== 'message'
        || contract.requestContentType !== 'input_text' || contract.imageQuality !== 2 || contract.imageBatch !== 4
        || !safeVerificationPath(contract.sourceEvidencePath) || !SHA256.test(contract.sourceEvidenceSha256 ?? '')
        || JSON.stringify(contract.readbackOperationIds) !== JSON.stringify(['media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses'])) invalid();
    } else if (requirementId === 'video.text-to-video' || requirementId === 'video.image-reference-to-video') {
      const imageReference = requirementId === 'video.image-reference-to-video';
      const expectedFields = imageReference
        ? ['aspectRatio', 'duration', 'inputAssets', 'mode', 'prompt', 'resolutionName', 'skipAudio']
        : ['aspectRatio', 'duration', 'prompt', 'resolutionName', 'skipAudio'];
      if (contract.operationId !== 'media.video.create' || contract.mode !== (imageReference ? 'imageToVideo' : 'textToVideo')
        || contract.transport !== 'http' || contract.origin !== 'https://grok.com' || contract.method !== 'POST'
        || contract.path !== '/rest/app-chat/conversations/new' || contract.contentType !== 'application/json'
        || JSON.stringify(contract.requestFieldNames) !== JSON.stringify(['enableImageStreaming', 'enableSideBySide', 'kind', 'mediaGenInput', 'message', 'modelName', 'responseMetadata', 'sendFinalMetadata'])
        || JSON.stringify(contract.mediaInputFieldNames) !== JSON.stringify(expectedFields)
        || contract.profile?.aspectRatio !== '2:3' || contract.profile?.duration !== 6
        || contract.profile?.resolutionName !== '480p' || contract.profile?.skipAudio !== true
        || (imageReference && contract.referenceMustBePrivateGeneratedImage !== true)
        || !safeVerificationPath(contract.sourceEvidencePath) || !SHA256.test(contract.sourceEvidenceSha256 ?? '')) invalid();
    } else if (contract.operationId !== 'media.asset.download' || !['generated_image_asset', 'generated_video_asset'].includes(contract.mode)
      || contract.transport !== 'http' || contract.origin !== 'https://assets.grok.com' || contract.method !== 'GET'
      || contract.path !== '/users/{owner}/generated/{assetKey}' || contract.urlBuilder !== 'getAssetUrl'
      || contract.requireMagicAndFileReadback !== true || !safeVerificationPath(contract.sourceEvidencePath)
      || !SHA256.test(contract.sourceEvidenceSha256 ?? '')
      || JSON.stringify(contract.readbackOperationIds) !== JSON.stringify(['media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses'])
      || (requirementId === 'artifact.image.download' && contract.requiredMimePrefix !== 'image/')
      || (requirementId === 'artifact.video.download' && contract.requiredMime !== 'video/mp4')) invalid();
    }
  }

  const featureIds = new Set();
  const requirementIds = new Set();
  for (const feature of checklist.features) {
    if (!record(feature) || !ID.test(feature.id) || featureIds.has(feature.id)
      || typeof feature.required !== 'boolean' || typeof feature.applicability !== 'string' || !feature.applicability.trim()
      || !Array.isArray(feature.requirements) || !feature.requirements.length) invalid();
    featureIds.add(feature.id);
    for (const requirement of feature.requirements) {
      if (!record(requirement) || !ID.test(requirement.id) || requirementIds.has(requirement.id)
        || !ID.test(requirement.operationId) || !KINDS.has(requirement.expectedKind)
        || !EVIDENCE_MODES.has(requirement.evidenceMode) || typeof requirement.handlerId !== 'string'
        || (!Object.hasOwn(checklist.handlerBindings, requirement.handlerId)
          && !(requirement.evidenceMode === 'native_auth_bootstrap' && requirement.handlerId === 'auth.bootstrap'))
        || !['session', 'none', 'any'].includes(requirement.expectedAuthMode)
        || typeof requirement.requiresOwnerVerified !== 'boolean') invalid();
      requirementIds.add(requirement.id);
      if (requirement.evidenceMode === 'native_auth_bootstrap'
        && (requirement.operationId !== 'auth.native-bootstrap' || requirement.handlerId !== 'auth.bootstrap'
          || requirement.expectedKind !== 'native' || requirement.expectedAuthMode !== 'none')) invalid();
      if (requirement.evidenceMode === 'public_direct_replay'
        && (requirement.operationId !== 'public.models' || requirement.handlerId !== 'public.models'
          || requirement.expectedAuthMode !== 'none')) invalid();
      if (requirement.evidenceMode === 'direct_wss_session_replay'
        && (feature.id !== 'chat.text-generation' || requirement.id !== 'chat.create-and-respond'
          || requirement.operationId !== 'chat.text.wss'
          || requirement.expectedKind !== 'submit' || requirement.handlerId !== 'chat.text-wss'
          || requirement.expectedAuthMode !== 'session' || !requirement.requiresOwnerVerified)) invalid();
      if (requirement.evidenceMode === 'source_native_model_selection'
        && (feature.id !== 'models.private-selection' || requirement.id !== 'models.selection-in-chat'
          || requirement.operationId !== 'chat.text.wss' || requirement.expectedKind !== 'submit'
          || requirement.handlerId !== 'models.selected-mode-text' || requirement.expectedAuthMode !== 'session'
          || !requirement.requiresOwnerVerified)) invalid();
      if (requirement.evidenceMode === 'direct_wss_regeneration_replay'
        && (feature.id !== 'chat.regenerate' || requirement.id !== 'chat.regenerate.response'
          || requirement.operationId !== 'chat.regenerate.wss' || requirement.expectedKind !== 'submit'
          || requirement.handlerId !== 'chat.regenerate-wss' || requirement.expectedAuthMode !== 'session'
          || !requirement.requiresOwnerVerified)) invalid();
      if (requirement.evidenceMode === 'first_party_bundle_direct_replay'
        && (!requirement.operationId.startsWith('workspaces.') || !requirement.handlerId.startsWith('workspaces.')
          || requirement.expectedAuthMode !== 'session' || !requirement.requiresOwnerVerified)) invalid();
      if (requirement.evidenceMode === 'first_party_sdk_direct_replay'
        && (requirement.expectedAuthMode !== 'session' || !requirement.requiresOwnerVerified
          || !['read', 'submit', 'poll'].includes(requirement.expectedKind))) invalid();
      if (requirement.evidenceMode === 'direct_media_wss_replay'
        && (feature.id !== 'image-generation' || requirement.id !== 'image.generate.wss'
          || requirement.operationId !== 'media.image.create' || requirement.handlerId !== 'media.image-wss'
          || requirement.expectedKind !== 'submit' || requirement.expectedAuthMode !== 'session'
          || !requirement.requiresOwnerVerified)) invalid();
      if (requirement.evidenceMode === 'direct_media_http_replay'
        && (feature.id !== 'video-generation' || !['video.text-to-video', 'video.image-reference-to-video'].includes(requirement.id)
          || requirement.operationId !== 'media.video.create' || requirement.handlerId !== 'media.video-submit'
          || requirement.expectedKind !== 'submit' || requirement.expectedAuthMode !== 'session'
          || !requirement.requiresOwnerVerified)) invalid();
      if (requirement.evidenceMode === 'direct_media_asset_download'
        && (feature.id !== 'artifact-download' || !['artifact.image.download', 'artifact.video.download'].includes(requirement.id)
          || requirement.operationId !== 'media.asset.download' || requirement.handlerId !== 'media.asset-download'
          || requirement.expectedKind !== 'download' || requirement.expectedAuthMode !== 'session'
          || !requirement.requiresOwnerVerified)) invalid();
      if (requirement.evidenceMode.startsWith('direct_media_')) {
        const mediaContract = checklist.mediaContracts?.[requirement.id];
        if (!mediaContract || mediaContract.operationId !== requirement.operationId) invalid();
        const path = mediaContract.path;
        if (requirement.candidate?.path !== path) invalid();
      }
      if (requirement.evidenceMode === 'captured_session_replay' && ['public.models', 'auth.bootstrap'].includes(requirement.handlerId)) invalid();
      const validHandlerIds = requirement.evidenceMode === 'native_auth_bootstrap'
        ? ['auth.bootstrap']
        : requirement.evidenceMode === 'direct_media_wss_replay'
          ? ['media.image-wss']
          : requirement.evidenceMode === 'direct_media_http_replay'
            ? ['media.video-submit']
            : requirement.evidenceMode === 'direct_media_asset_download'
              ? ['media.asset-download']
        : requirement.evidenceMode === 'direct_wss_session_replay'
        ? ['chat.text-wss']
        : requirement.evidenceMode === 'source_native_model_selection'
        ? ['models.selected-mode-text']
        : requirement.evidenceMode === 'direct_wss_regeneration_replay'
        ? ['chat.regenerate-wss']
        : requirement.evidenceMode === 'first_party_bundle_direct_replay'
        ? [WORKSPACE_OPERATION_HANDLERS[requirement.operationId] ?? '']
        : requirement.evidenceMode === 'first_party_sdk_direct_replay'
        ? (requirement.operationId === 'attachment.upload.direct' ? ['attachments.upload-direct']
          : requirement.expectedKind === 'read' || requirement.expectedKind === 'poll' ? ['client.read'] : ['client.submit'])
        : requirement.evidenceMode === 'public_direct_replay'
        ? ['public.models']
        : requirement.expectedKind === 'read'
          ? (feature.id === 'auth.owner-identity' ? ['client.verify-owner'] : ['client.read'])
          : requirement.expectedKind === 'poll'
            ? ['client.read']
            : requirement.expectedKind === 'download'
              ? ['client.download']
              : (feature.id === 'auth.login' ? ['auth.login']
                : feature.id === 'auth.session-renewal' ? ['auth.renew'] : ['client.submit']);
      if (!validHandlerIds.includes(requirement.handlerId)) invalid();
      const candidate = requirement.candidate;
      if (!record(candidate) || !['source_candidate_only', 'unknown', 'direct_public_replay', 'native_bootstrap', 'direct_wss_replay', 'direct_media_capture', 'first_party_direct_replay'].includes(candidate.status)
        || !(candidate.origin === null || validOrigin(candidate.origin))
        || !(candidate.method === null || METHODS.has(candidate.method))
        || !(candidate.path === null || (typeof candidate.path === 'string' && candidate.path.startsWith('/')
          && !/[?#]/.test(candidate.path) && !candidate.path.split('/').some(part => part === '.' || part === '..')))
        || !Array.isArray(candidate.fieldNames)
        || candidate.fieldNames.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name))) invalid();
      if (candidate.sourceAsset !== undefined && !Object.hasOwn(checklist.sourceAssets, candidate.sourceAsset)) invalid();
    }
    validatePhaseClaims(feature);
    if (feature.unverifiedAlternates !== undefined) {
      if (!Array.isArray(feature.unverifiedAlternates)) invalid();
      const alternateIds = new Set();
      for (const alternate of feature.unverifiedAlternates) {
        if (!record(alternate) || !ID.test(alternate.id) || alternateIds.has(alternate.id)
          || !ID.test(alternate.operationId) || !record(alternate.candidate)) invalid();
        alternateIds.add(alternate.id);
        const candidate = alternate.candidate;
        if (!['source_candidate_only', 'unknown'].includes(candidate.status)
          || !(candidate.origin === null || validOrigin(candidate.origin))
          || !(candidate.method === null || METHODS.has(candidate.method))
          || !(candidate.path === null || (typeof candidate.path === 'string' && candidate.path.startsWith('/')
            && !/[?#]/.test(candidate.path) && !candidate.path.split('/').some(part => part === '.' || part === '..')))
          || !Array.isArray(candidate.fieldNames)
          || candidate.fieldNames.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name))
          || (candidate.sourceAsset !== undefined && !Object.hasOwn(checklist.sourceAssets, candidate.sourceAsset))) invalid();
      }
    }
  }
  return checklist;
}

function validatePrivateReceipt(receipt) {
  if (!onlyKeys(receipt, PRIVATE_RECEIPT_KEYS) || receipt.schemaVersion !== 1 || receipt.serviceId !== 'grok-web'
    || !ID.test(receipt.featureId) || !ID.test(receipt.requirementId) || !ID.test(receipt.operationId)
    || !isoTimestamp(receipt.observedAt) || !isoTimestamp(receipt.recordedAt)
    || receipt.execution !== 'direct_http_client' || receipt.liveReplay !== true || receipt.liveReplayRecorded !== true
    || typeof receipt.mocked !== 'boolean' || typeof receipt.ownerVerified !== 'boolean'
    || receipt.sameAuthenticatedOwner !== true || receipt.evidenceScope !== 'same_authenticated_owner'
    || !Number.isInteger(receipt.httpStatus) || receipt.httpStatus < 200 || receipt.httpStatus > 599
    || !Number.isSafeInteger(receipt.responseBytes) || receipt.responseBytes < 1
    || !SHA256.test(receipt.capturedOperationSha256) || !SHA256.test(receipt.requestDigest)
    || (receipt.intentDigest !== undefined && !SHA256.test(receipt.intentDigest))
    || !SHA256.test(receipt.responseDigest) || typeof receipt.handlerId !== 'string'
    || !record(receipt.codeSha256) || !Object.keys(receipt.codeSha256).length
    || Object.entries(receipt.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))
    || typeof receipt.responseMime !== 'string' || !receipt.responseMime.trim()
    || (receipt.ownerIdentityReceiptSha256 !== undefined && !SHA256.test(receipt.ownerIdentityReceiptSha256))
    || (receipt.artifactVerified !== undefined && typeof receipt.artifactVerified !== 'boolean')
    || (receipt.dispatchBinding !== undefined && !onlyKeys(receipt.dispatchBinding,
      new Set(['handlerId', 'operationId', 'operationKind', 'mode'])))) invalid();
  validateOwnerProofReferenceFields(receipt, { identityReceipt: receipt.operationId === 'auth.owner.read' });
  validateBooleanAssertions(receipt.readinessAssertions, PRIVATE_READINESS_KEYS);
  validateBooleanAssertions(receipt.persistenceAssertions, PRIVATE_PERSISTENCE_KEYS, { requireFalse: true });
  if (receipt.responseDigestKind !== undefined && !['raw_http_body', 'parsed_json_data'].includes(receipt.responseDigestKind)) invalid();
  if (receipt.sourceProofPath !== undefined && !safeVerificationPath(receipt.sourceProofPath)) invalid();
  if (receipt.sourceProofSha256 !== undefined && !SHA256.test(receipt.sourceProofSha256)) invalid();
  if (receipt.codeHashCapturedAtExecution !== undefined && typeof receipt.codeHashCapturedAtExecution !== 'boolean') invalid();
  if (receipt.restoreReplay !== undefined) {
    const restore = receipt.restoreReplay;
    if (receipt.operationId !== 'settings.update'
      || !onlyKeys(restore, new Set(['httpStatus', 'readbackStatus', 'requestDigest', 'intentDigest', 'readbackVerified',
        'otherPreferencesUnchanged', 'otherSettingsUnchanged']))
      || restore.httpStatus !== 200 || restore.readbackStatus !== 200
      || !SHA256.test(restore.requestDigest) || !SHA256.test(restore.intentDigest)
      || restore.readbackVerified !== true || restore.otherPreferencesUnchanged !== true
      || restore.otherSettingsUnchanged !== true) invalid();
  }
  if (receipt.semanticReadback !== undefined) {
    const semanticBooleanKeys = new Set([
      'readbackVerified', 'beforeValue', 'afterValue', 'otherPreferencesUnchanged', 'otherSettingsUnchanged',
      'sameConversationId', 'sameResponseId', 'shareLinkIdMatched', 'isPublic', 'allowIndexing',
      'shareLinkAbsent', 'restoreVerified', 'restoreBeforeValue', 'restoreAfterValue',
      'restoreOtherPreferencesUnchanged', 'existingShareAbsent', 'detailMatchesSearch', 'viewerIsOwner',
      'mutableOwnerAccessVerified', 'responseIdsBoundInMemory', 'conversationAbsent', 'otherConversationsUnchanged',
      'uploadReferenceVerified', 'metadataReadbackVerified', 'assetReadbackVerified', 'downloadReadbackVerified',
      'downloadBytesMatched', 'retainedForReuse', 'cleanupRequested', 'conversationAssociationVerified',
      'uploadResponseParsed',
    ]);
    const semanticCountKeys = new Set([
      'responseNodeCount', 'inflightResponseCount', 'loadedResponseCount',
      'loadedUserMessageCount', 'loadedAssistantMessageCount',
    ]);
    if (!onlyKeys(receipt.semanticReadback, SDK_SEMANTIC_READBACK_KEYS)
      || Object.entries(receipt.semanticReadback).some(([key, value]) => (
        semanticBooleanKeys.has(key)
          ? typeof value !== 'boolean'
          : semanticCountKeys.has(key)
            ? (!Number.isSafeInteger(value) || value < 0)
          : key === 'readbackStatus' || key === 'restoreStatus'
            ? (!Number.isInteger(value) || value < 200 || value > 599)
            : key === 'preferenceName'
              ? (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value))
              : true
      ))) invalid();
  }
  if (receipt.readVariants !== undefined) {
    if (receipt.operationId !== 'conversation.list.read' || !Array.isArray(receipt.readVariants)
      || receipt.readVariants.length !== 3) invalid();
    const expectedNames = ['first_page', 'next_page', 'search'];
    for (let index = 0; index < receipt.readVariants.length; index += 1) {
      const variant = receipt.readVariants[index];
      if (!onlyKeys(variant, CONVERSATION_READ_VARIANT_KEYS) || variant.name !== expectedNames[index]
        || !SHA256.test(variant.requestDigest) || !SHA256.test(variant.responseDigest)
        || !Number.isInteger(variant.httpStatus) || variant.httpStatus < 200 || variant.httpStatus > 299
        || !Number.isSafeInteger(variant.responseBytes) || variant.responseBytes < 1
        || !Array.isArray(variant.requestFieldNames) || variant.requestFieldNames.some(name => typeof name !== 'string'
          || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name))
        || !Number.isSafeInteger(variant.conversationCount) || variant.conversationCount < 0
        || typeof variant.nextPageTokenPresent !== 'boolean') invalid();
      if (variant.name === 'search') {
        if (!SHA256.test(variant.searchQuerySha256) || !Number.isSafeInteger(variant.textSearchMatchCount)
          || variant.textSearchMatchCount < 0 || variant.targetConversationMatched !== true
          || !variant.requestFieldNames.includes('searchQuery')) invalid();
      } else if (variant.searchQuerySha256 !== undefined || variant.textSearchMatchCount !== undefined
        || variant.targetConversationMatched !== undefined) invalid();
      if (variant.name === 'next_page' && !variant.requestFieldNames.includes('pageToken')) invalid();
    }
  }
  return receipt;
}

function validateDirectWssReceipt(receipt) {
  if (!onlyKeys(receipt, WSS_RECEIPT_KEYS) || receipt.schemaVersion !== 1 || receipt.serviceId !== 'grok-web'
    || receipt.evidenceClass !== 'direct_wss_session_replay' || receipt.featureId !== 'chat.text-generation'
    || receipt.requirementId !== 'chat.create-and-respond' || receipt.operationId !== 'chat.text.wss'
    || !isoTimestamp(receipt.observedAt) || !isoTimestamp(receipt.recordedAt)
    || receipt.execution !== 'direct_wss_client' || receipt.liveReplay !== true || receipt.liveReplayRecorded !== true
    || receipt.mocked !== false || receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true
    || receipt.evidenceScope !== 'same_authenticated_owner' || !SHA256.test(receipt.ownerIdentityReceiptSha256)
    || receipt.handlerId !== 'chat.text-wss' || !SHA256.test(receipt.protocolSha256)
    || !SHA256.test(receipt.requestDigest) || !SHA256.test(receipt.promptSha256)
    || receipt.assistantRegex !== '^PROTOCOL42:\\s*42\\.?$' || receipt.assistantRegexMatched !== true
    || receipt.sourcePageRole !== 'codex-grok-core-20261006'
    || !record(receipt.dispatchBinding) || receipt.dispatchBinding.handlerId !== 'chat.text-wss'
    || receipt.dispatchBinding.operationId !== 'chat.text.wss' || receipt.dispatchBinding.operationKind !== 'submit'
    || receipt.dispatchBinding.mode !== 'direct_wss_single_frame') invalid();
  validateOwnerProofReferenceFields(receipt);
  const expectedPhases = [
    'sdk_browser_input',
    'browser_business_frame_blocked',
    'direct_wss_control_ack_and_business_send',
    'independent_http_history_readback',
  ];
  if (JSON.stringify(receipt.evidencePhases) !== JSON.stringify(expectedPhases)) invalid();
  const newChat = receipt.newChatContext;
  const capture = receipt.browserCapture;
  const direct = receipt.directTransport;
  const history = receipt.historyReadback;
  const journal = receipt.journal;
  if (!record(newChat) || newChat.routePath !== '/c' || newChat.pageWasEmptyNewChat !== true
    || newChat.baselineReadBeforeSubmit !== true || newChat.baselinePageSize !== 24
    || newChat.conversationTargetPresent !== false || newChat.initialLoadTargetPresent !== false
    || newChat.loadExistingTrue !== false || !Array.isArray(newChat.workspaceTargetFieldNames)
    || newChat.workspaceTargetFieldNames.length !== 0 || newChat.connectorIdValuesPersisted !== false
    || !Number.isInteger(newChat.connectorIdCount) || newChat.connectorIdCount < 0) invalid();
  if (!record(capture) || capture.controlEventType !== 'session.create'
    || JSON.stringify(capture.controlTopLevelFieldNames) !== JSON.stringify(['event'])
    || JSON.stringify(capture.controlEventFieldNames) !== JSON.stringify(['event_id', 'session', 'type'])
    || JSON.stringify(capture.controlSessionFieldNames) !== JSON.stringify(['model', 'x_grok'])
    || !Array.isArray(capture.controlXGrokFieldNames)
    || capture.controlModelType !== 'string' || !Array.isArray(capture.controlXGrokFieldNames)
    || capture.controlSessionIdPresent !== false || capture.businessEventType !== 'response.create'
    || JSON.stringify(capture.controlAbsentTargetFieldNames) !== JSON.stringify(['conversation_id', 'initial_load_id', 'load_existing'])
    || capture.businessItemType !== 'message' || capture.businessItemRole !== 'user'
    || capture.inputChunkTextPath !== 'event.item.x_grok.input_chunks[].text.text'
    || capture.promptSha256 !== receipt.promptSha256 || capture.promptExactAfterTrim !== true
    || capture.businessFrameCaptured !== true || capture.browserBusinessFrameDelivered !== false
    || capture.browserControlFramesForwarded !== 1 || capture.browserWriteAbortVerified !== true
    || capture.httpAppChatWriteCount !== 0 || capture.rawControlPersisted !== false
    || capture.rawBusinessFramePersisted !== false || capture.promptTextPersisted !== false) invalid();
  if (!record(direct) || direct.origin !== 'wss://grok.com' || direct.path !== '/ws/mgw/'
    || JSON.stringify(direct.queryKeyNames) !== JSON.stringify(['uid']) || direct.handshakeStatus !== 101
    || direct.normalControlFrameSentCount !== 1 || direct.serverSessionAcknowledgementObserved !== true
    || direct.businessFrameSentCount !== 1 || direct.businessFrameBoundToServerSession !== true
    || direct.businessFrameSentAfterAcknowledgement !== true
    || direct.terminalEventObserved !== true || !Array.isArray(direct.eventTypes)
    || direct.eventTypes.some(type => typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{0,95}$/.test(type))
    || !direct.eventTypes.includes('session.created')
    || !direct.eventTypes.some(type => ['response.done', 'response.completed', 'response.finished'].includes(type))) invalid();
  if (!record(history) || history.ownerBound !== true || history.conversationListStatus !== 200
    || history.conversationDetailStatus !== 200 || history.responseNodesStatus !== 200
    || history.loadResponsesStatus !== 200 || history.exactPromptMatched !== true
    || history.assistantRegexMatched !== true || history.recentCandidateCount !== 1
    || history.conversationIdsPersisted !== false || history.responseIdsPersisted !== false
    || history.assistantResponsePersisted !== false) invalid();
  if (!record(journal) || journal.state !== 'completed' || journal.attemptCount !== 1
    || !SHA256.test(journal.requestDigest) || journal.rawIdentifiersPersisted !== false) invalid();
  if (!record(receipt.codeSha256) || !Object.keys(receipt.codeSha256).length
    || Object.entries(receipt.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))) invalid();
  validateBooleanAssertions(receipt.persistenceAssertions, PRIVATE_PERSISTENCE_KEYS, { requireFalse: true });
  return receipt;
}

function validateModelSelectionPhaseReceipt(receipt) {
  if (!onlyKeys(receipt, MODEL_SELECTION_PHASE_RECEIPT_KEYS) || receipt.schemaVersion !== 1
    || receipt.serviceId !== 'grok-web' || receipt.evidenceClass !== 'source_native_model_selection_phase'
    || receipt.evidencePath !== 'verification/grok-feature-live-receipts/models.selection-in-chat.json'
    || receipt.featureId !== 'models.private-selection' || receipt.requirementId !== 'models.selection-in-chat'
    || receipt.operationId !== 'chat.text.wss' || !isoTimestamp(receipt.observedAt) || !isoTimestamp(receipt.recordedAt)
    || receipt.execution !== 'direct_wss_client' || receipt.liveReplay !== true || receipt.liveReplayRecorded !== true
    || receipt.mocked !== false || receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true
    || receipt.evidenceScope !== 'same_authenticated_owner' || !SHA256.test(receipt.ownerIdentityReceiptSha256)
    || receipt.handlerId !== 'models.selected-mode-text' || !SHA256.test(receipt.ownerScopeSha256)
    || !onlyKeys(receipt.dispatchBinding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))
    || receipt.dispatchBinding.handlerId !== 'models.selected-mode-text'
    || receipt.dispatchBinding.operationId !== 'chat.text.wss' || receipt.dispatchBinding.operationKind !== 'submit'
    || receipt.dispatchBinding.mode !== 'source_native_model_selection_direct_wss') invalid();
  validateOwnerProofReferenceFields(receipt);
  const legacy = !Object.hasOwn(receipt, 'catalogRead');

  const source = receipt.sourceFacts;
  if (!onlyKeys(source, MODEL_SELECTION_PHASE_SOURCE_KEYS)
    || source.catalogOperationId !== 'models.modes' || source.catalogMethod !== 'POST'
    || source.catalogPath !== '/rest/modes' || JSON.stringify(source.catalogRequestFieldNames) !== JSON.stringify(['locale'])
    || source.modeStore !== 'useModesStore' || source.selectedModeField !== 'selectedModeId'
    || source.setter !== 'setSelectedModeId' || source.setterSourceTag !== 'user'
    || source.storageKey !== 'modes-selected-id' || source.selectionEffect !== 'local_sdk_state_and_local_storage'
    || source.nativeSessionModelPath !== 'event.session.model'
    || source.serverAckModelPath !== 'event.session.model'
    || !record(source.sourceAssetSha256)
    || JSON.stringify(Object.keys(source.sourceAssetSha256).sort()) !== JSON.stringify([
      'chat-mode-selection-chat-callsite', 'chat-mode-selection-store', 'gateway-session',
    ].sort())
    || Object.values(source.sourceAssetSha256).some(value => !SHA256.test(value))) invalid();

  const selection = receipt.selection;
  if (!onlyKeys(selection, MODEL_SELECTION_PHASE_SELECTION_KEYS)
    || selection.selectedModeId !== 'fast' || selection.sourceSessionModel !== 'fast'
    || selection.serverSessionAcknowledgementModeEchoed !== true
    || selection.selectionSource !== 'sdk_state'
    || selection.selectionEffect !== 'local_sdk_state_and_local_storage'
    || selection.serverPreferenceWriteForwarded !== false
    || (selection.providerBackendModelVersion !== null && !/^(?:fast|expert|auto|heavy|build|grok-[a-z0-9]+(?:[._:-][a-z0-9]+)*)$/.test(selection.providerBackendModelVersion))
    || typeof selection.providerBackendModelVersionObserved !== 'boolean'
    || selection.providerBackendModelVersionObserved !== (selection.providerBackendModelVersion !== null)) invalid();

  if (!legacy) {
    const catalog = receipt.catalogRead;
    if (!onlyKeys(catalog, MODEL_SELECTION_PHASE_CATALOG_KEYS)
      || catalog.operationId !== 'models.modes' || catalog.method !== 'POST' || catalog.path !== '/rest/modes'
      || catalog.status !== 200 || !Number.isSafeInteger(catalog.responseBytes) || catalog.responseBytes < 1
      || !Number.isSafeInteger(catalog.choiceCount) || catalog.choiceCount < 1 || catalog.choiceCount > 500
      || catalog.defaultModeId !== 'auto' || catalog.selectedModeId !== 'fast'
      || catalog.selectedModeAvailable !== true || catalog.ownerBound !== true || catalog.rawCatalogPersisted !== false) invalid();
  }

  const capture = receipt.normalSdkCapture;
  if (!onlyKeys(capture, MODEL_SELECTION_PHASE_CAPTURE_KEYS)
    || capture.sourcePageRole !== 'codex-grok-model-current-validation-20261006'
    || capture.sourceSetterCallsiteVerified !== true || capture.selectionFastVisible !== true
    || capture.selectionFastStored !== true || capture.browserSessionAckModel !== 'fast'
    || capture.businessFrameCaptured !== true || capture.exactPromptMatched !== true
    || capture.browserBusinessFramesForwarded !== 0 || capture.browserBusinessWritesDelivered !== 0
    || !Number.isSafeInteger(capture.browserHttpWritesBlocked) || capture.browserHttpWritesBlocked < 0
    || capture.uiRestoredAuto !== true) invalid();

  const direct = receipt.directTransport;
  if (!onlyKeys(direct, MODEL_SELECTION_PHASE_TRANSPORT_KEYS)
    || direct.origin !== 'wss://grok.com' || direct.path !== '/ws/mgw/' || direct.handshakeStatus !== 101
    || direct.normalControlFrameSentCount !== 1 || direct.serverSessionAcknowledgementObserved !== true
    || direct.businessFrameSentCount !== 1 || direct.businessFrameBoundToServerSession !== true
    || direct.terminalEventObserved !== true
    || (legacy ? direct.terminalEventType !== 'response.done' : !TERMINAL_EVENTS.has(direct.terminalEventType))
    || (legacy ? direct.terminalStatusMetadataCaptured !== false : typeof direct.terminalStatusMetadataCaptured !== 'boolean')
    || !Array.isArray(direct.eventTypes)
    || direct.eventTypes.some(type => typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{0,95}$/.test(type))
    || !direct.eventTypes.includes('session.created') || !direct.eventTypes.includes(direct.terminalEventType)) invalid();

  const terminal = receipt.terminalMetadata;
  if (!legacy) {
    if (direct.terminalStatusMetadataCaptured !== (terminal !== null)
      || (terminal !== null && (!onlyKeys(terminal, MODEL_SELECTION_PHASE_TERMINAL_KEYS)
        || terminal.eventType !== direct.terminalEventType
        || ['responseStatus', 'responseStatusReason', 'errorClass', 'errorCode']
          .some(key => terminal[key] !== null && (typeof terminal[key] !== 'string'
            || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(terminal[key])))
        || !Array.isArray(terminal.responseFieldNames) || terminal.responseFieldNames.length > 64
        || terminal.responseFieldNames.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))
        || !Array.isArray(terminal.errorFieldNames) || terminal.errorFieldNames.length > 32
        || terminal.errorFieldNames.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))
        || terminal.statusOrErrorValueObserved !== ['responseStatus', 'responseStatusReason', 'errorClass', 'errorCode']
          .some(key => terminal[key] !== null)))) invalid();
  }

  const history = receipt.historyReadback;
  if (!onlyKeys(history, MODEL_SELECTION_PHASE_HISTORY_KEYS)
    || history.ownerBound !== true || history.listStatus !== 200
    || (!legacy && history.listResponseBytes !== null && (!Number.isSafeInteger(history.listResponseBytes) || history.listResponseBytes < 0))
    || (legacy ? (history.windowStart !== '2026-10-06T11:04:00Z' || history.windowEnd !== '2026-10-06T11:08:00Z'
      || history.timestampField !== 'createTime')
      : (!['conversation.attached.event.conversation.id', 'conversation.list.read'].includes(history.timestampField)
        || (history.windowStart !== null && !isoTimestamp(history.windowStart))
        || (history.windowEnd !== null && !isoTimestamp(history.windowEnd))))
    || history.candidateCount !== 1 || history.candidateReadCount !== 1 || history.exactPromptCandidateCount !== 1
    || history.detailStatus !== 200 || history.responseNodesStatus !== 200 || history.loadResponsesStatus !== 200
    || (!legacy && ['detailResponseBytes', 'responseNodesResponseBytes', 'loadResponsesResponseBytes']
      .some(key => history[key] !== null && (!Number.isSafeInteger(history[key]) || history[key] < 0))
    )
    || history.userTurnCount !== 1 || history.assistantTurnCount !== 1 || history.exactPromptMatched !== true
    || !Number.isSafeInteger(history.assistantTextLengthCodePoints) || history.assistantTextLengthCodePoints < 1
    || !SHA256.test(history.assistantTextSha256)
    || history.assistantExactExpectedTextMatched !== true || !SHA256.test(history.conversationIdSha256)
    || (history.assistantResponseIdSha256 !== null && !SHA256.test(history.assistantResponseIdSha256))
    || (!legacy && history.responseIdHintMatched !== null && typeof history.responseIdHintMatched !== 'boolean')
    || history.candidateReadStatusesAll200 !== true) invalid();

  const handoff = receipt.sessionHandoff;
  if (!onlyKeys(handoff, MODEL_SELECTION_PHASE_HANDOFF_KEYS)
    || handoff.mechanism !== 'fresh_session_handoff_and_direct_owner_verification'
    || handoff.ownerReadStatus !== 200 || handoff.sameOwnerVerified !== true || handoff.credentialChanged !== false
    || handoff.providerCookieRotationVerified !== false || handoff.expiredProviderSessionRecoveryVerified !== false
    || handoff.mutationRetried !== false) invalid();

  const journal = receipt.journal;
  if (!onlyKeys(journal, MODEL_SELECTION_PHASE_JOURNAL_KEYS)
    || !['sending', 'outcome_unknown'].includes(journal.initialState)
    || journal.finalState !== 'completed' || journal.attemptCount !== 1
    || journal.httpStatus !== 101 || journal.reasonCode !== 'TEXT_WSS_READBACK_VERIFIED'
    || journal.reconciledBy !== 'history.load-responses' || !SHA256.test(journal.requestDigest)
    || !SHA256.test(journal.intentDigest) || !SHA256.test(journal.localOperationIdSha256)) invalid();

  const snapshot = receipt.sourceSnapshot;
  if (!onlyKeys(snapshot, MODEL_SELECTION_PHASE_SNAPSHOT_KEYS) || !SHA256.test(snapshot.treeSha256)
    || snapshot.stableThroughTerminal !== true || !record(snapshot.codeSha256)
    || !Object.keys(snapshot.codeSha256).length
    || (legacy ? snapshot.fileCount !== 51 : snapshot.fileCount !== Object.keys(snapshot.codeSha256).length)
    || Object.entries(snapshot.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))) invalid();
  if (!record(receipt.codeSha256) || !Object.keys(receipt.codeSha256).length
    || Object.entries(receipt.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))) invalid();
  if (canonicalJson(receipt.codeSha256) !== canonicalJson(snapshot.codeSha256)) invalid();
  validateBooleanAssertions(receipt.persistenceAssertions, PRIVATE_PERSISTENCE_KEYS, { requireFalse: true });
  return receipt;
}

function validateDirectWssRegenerationReceipt(receipt) {
  const phases = [
    'native_regenerate_action',
    'browser_business_frame_blocked',
    'direct_wss_control_ack_and_regeneration_send',
    'independent_owner_history_readback',
  ];
  const expectedPriorKeys = new Set([
    'operationId', 'state', 'httpStatus', 'reasonCode', 'requestDigest', 'intentDigest',
    'controlFrameSent', 'serverSessionAcknowledgementObserved', 'businessFrameBoundToServerSession',
    'directBusinessFrameSent', 'browserBusinessFramesDelivered', 'historyUnchanged', 'ownerVerified',
    'sameConversationTarget', 'sameParentTarget', 'targetAssistantUnchanged', 'userResponseCountUnchanged',
  ]);
  if (!onlyKeys(receipt, WSS_REGEN_RECEIPT_KEYS) || receipt.schemaVersion !== 1 || receipt.serviceId !== 'grok-web'
    || receipt.evidenceClass !== 'direct_wss_regeneration_replay' || receipt.featureId !== 'chat.regenerate'
    || receipt.requirementId !== 'chat.regenerate.response' || receipt.operationId !== 'chat.regenerate.wss'
    || !isoTimestamp(receipt.observedAt) || !isoTimestamp(receipt.recordedAt)
    || receipt.execution !== 'direct_wss_client' || receipt.liveReplay !== true || receipt.liveReplayRecorded !== true
    || receipt.mocked !== false || receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true
    || receipt.evidenceScope !== 'same_authenticated_owner' || !SHA256.test(receipt.ownerIdentityReceiptSha256)
    || receipt.handlerId !== 'chat.regenerate-wss' || !SHA256.test(receipt.protocolSha256)
    || !SHA256.test(receipt.requestDigest) || !SHA256.test(receipt.intentDigest)
    || !SHA256.test(receipt.targetParentMessageSha256)
    || receipt.assistantRegex !== '^PROTOCOL42:\\s*42\\.?$' || receipt.assistantRegexMatched !== true
    || receipt.sourcePageRole !== 'codex-grok-lifecycle-20261006'
    || !onlyKeys(receipt.dispatchBinding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))
    || receipt.dispatchBinding.handlerId !== 'chat.regenerate-wss'
    || receipt.dispatchBinding.operationId !== 'chat.regenerate.wss'
    || receipt.dispatchBinding.operationKind !== 'submit'
    || receipt.dispatchBinding.mode !== 'direct_wss_existing_task_regeneration'
    || JSON.stringify(receipt.evidencePhases) !== JSON.stringify(phases)) invalid();
  validateOwnerProofReferenceFields(receipt);
  const capture = receipt.nativeCapture;
  if (!record(capture) || capture.sourcePageRoleVerified !== true || capture.targetConversationMatched !== true
    || capture.targetResponseCardMatched !== true || capture.regenerateControlCount !== 1 || capture.regenerateClickCount !== 1
    || capture.emptyComposerFocusPriming !== true || capture.businessEventType !== 'response.create'
    || JSON.stringify(capture.businessEventFieldNames) !== JSON.stringify(['castle_request_token', 'event_id', 'parent_response_id', 'type'])
    || capture.castleRequestTokenIsString !== true || capture.castleRequestTokenNonempty !== true
    || !Number.isSafeInteger(capture.castleRequestTokenLengthBytes) || capture.castleRequestTokenLengthBytes < 1
    || capture.castleRequestTokenLengthBytes > 8192 || capture.castleRequestTokenHasControlChars !== false
    || capture.nativeEventPreparerValidationPassed !== true || capture.businessFrameCaptured !== true
    || capture.browserBusinessFrameDelivered !== false || capture.browserControlFramesForwarded !== 1
    || capture.rawEventPersisted !== false) invalid();
  const guards = receipt.browserGuards;
  if (!record(guards) || guards.httpMutationAbortGuardInstalledBeforeReload !== true
    || guards.websocketBusinessGuardInstalledBeforeReload !== true || guards.taskAttachGatePassed !== true
    || guards.browserControlFramesForwarded !== 1 || guards.browserBusinessFramesCaptured !== 1
    || guards.browserBusinessFramesDelivered !== 0 || !Number.isSafeInteger(guards.httpMutationAbortCount)
    || guards.httpMutationAbortCount < 0 || guards.rawBusinessFramePersisted !== false) invalid();
  const direct = receipt.directTransport;
  if (!record(direct) || direct.origin !== 'wss://grok.com' || direct.path !== '/ws/mgw/'
    || JSON.stringify(direct.queryKeyNames) !== JSON.stringify(['uid']) || direct.handshakeStatus !== 101
    || direct.controlFrameSentCount !== 1 || direct.serverSessionAcknowledgementObserved !== true
    || typeof direct.capturedSessionIdMatchedAcknowledgement !== 'boolean'
    || direct.businessFrameSentCount !== 1 || direct.businessFrameBoundToServerSession !== true
    || direct.businessFrameSentAfterAcknowledgement !== true || direct.terminalEventObserved !== true
    || !Array.isArray(direct.eventTypes) || direct.eventTypes.some(type => typeof type !== 'string'
      || !/^[a-z][a-z0-9_.-]{0,95}$/.test(type)) || !direct.eventTypes.includes('session.created')
    || !direct.eventTypes.some(type => ['response.done', 'response.completed', 'response.finished'].includes(type))) invalid();
  const history = receipt.historyReadback;
  if (!record(history) || history.ownerBound !== true || history.ownerReadStatus !== 200
    || history.conversationReadStatus !== 200 || history.responseNodesStatus !== 200 || history.loadResponsesStatus !== 200
    || JSON.stringify(history.readbackOperationIds) !== JSON.stringify(['conversation.read', 'history.response-nodes', 'history.load-responses'])
    || history.sameConversationTarget !== true || history.viewerIsOwner !== true
    || history.exactParentMessageHashMatched !== true || history.targetResponseParentMatched !== true
    || history.targetAssistantPatternMatched !== true || history.targetAssistantUnchanged !== true
    || history.addedAssistantResponseCount !== 1 || history.newAssistantParentMatched !== true
    || history.newAssistantNonempty !== true || history.newAssistantPatternMatched !== true
    || !Number.isSafeInteger(history.responseCountBefore) || history.responseCountBefore < 1
    || history.responseCountAfter !== history.responseCountBefore + 1
    || !Number.isSafeInteger(history.userResponseCountBefore) || history.userResponseCountBefore < 1
    || history.userResponseCountAfter !== history.userResponseCountBefore
    || history.userResponseCountUnchanged !== true
    || history.conversationIdsPersisted !== false || history.responseIdsPersisted !== false
    || history.assistantResponsePersisted !== false) invalid();
  const prior = receipt.priorNegotiation;
  if (prior !== undefined && (!onlyKeys(prior, expectedPriorKeys) || prior.operationId !== 'chat.regenerate.wss'
    || prior.state !== 'rejected' || prior.httpStatus !== 101 || prior.reasonCode !== 'CONVERSATION_WSS_FRAME_NOT_SENT'
    || !SHA256.test(prior.requestDigest) || prior.intentDigest !== receipt.intentDigest
    || prior.controlFrameSent !== true || prior.serverSessionAcknowledgementObserved !== true
    || prior.businessFrameBoundToServerSession !== false || prior.directBusinessFrameSent !== false
    || prior.browserBusinessFramesDelivered !== 0 || prior.historyUnchanged !== true || prior.ownerVerified !== true
    || prior.sameConversationTarget !== true || prior.sameParentTarget !== true
    || prior.targetAssistantUnchanged !== true || prior.userResponseCountUnchanged !== true)) invalid();
  const journal = receipt.journal;
  if (!onlyKeys(journal, new Set(['state', 'attemptCount', 'requestDigest', 'intentDigest', 'recoveryOfRequestDigest',
    'verifiedNoBusinessRecoveryUsed', 'businessDispatchCount', 'rawIdentifiersPersisted']))
    || journal.state !== 'completed' || journal.attemptCount !== 1
    || journal.requestDigest !== receipt.requestDigest || journal.intentDigest !== receipt.intentDigest
    || typeof journal.verifiedNoBusinessRecoveryUsed !== 'boolean'
    || (prior !== undefined && (journal.recoveryOfRequestDigest !== prior.requestDigest
      || journal.verifiedNoBusinessRecoveryUsed !== true))
    || (prior === undefined && (journal.recoveryOfRequestDigest !== null
      || journal.verifiedNoBusinessRecoveryUsed !== false))
    || journal.businessDispatchCount !== 1 || journal.rawIdentifiersPersisted !== false) invalid();
  if (!record(receipt.codeSha256) || !Object.keys(receipt.codeSha256).length
    || Object.entries(receipt.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))) invalid();
  validateBooleanAssertions(receipt.persistenceAssertions, PRIVATE_PERSISTENCE_KEYS, { requireFalse: true });
  return receipt;
}

function validateFirstPartyWorkspaceReceipt(receipt) {
  const expected = WORKSPACE_RECEIPT_REQUIREMENTS[receipt?.operationId];
  if (!expected || !onlyKeys(receipt, FIRST_PARTY_RECEIPT_KEYS) || receipt.schemaVersion !== 1
    || receipt.serviceId !== 'grok-web' || receipt.evidenceClass !== 'first_party_bundle_direct_replay'
    || receipt.featureId !== 'workspaces' || receipt.requirementId !== expected.requirementId
    || !isoTimestamp(receipt.observedAt) || !isoTimestamp(receipt.recordedAt)
    || receipt.execution !== 'direct_http_client' || receipt.liveReplay !== true || receipt.liveReplayRecorded !== true
    || receipt.mocked !== false || receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true
    || receipt.evidenceScope !== 'same_authenticated_owner' || !SHA256.test(receipt.ownerIdentityReceiptSha256)
    || receipt.sourceProofPath !== 'verification/grok-workspaces-live-2026-10-06.json'
    || !SHA256.test(receipt.sourceProofSha256) || !SHA256.test(receipt.sourceContractSha256)
    || !SHA256.test(receipt.capturedOperationSha256) || receipt.method !== expected.method
    || typeof receipt.pathTemplate !== 'string' || !receipt.pathTemplate.startsWith('/') || /[?#]/.test(receipt.pathTemplate)
    || receipt.pathTemplate.includes('__') || !Array.isArray(receipt.requestFieldNames)
    || !Array.isArray(receipt.responseFieldNames)
    || [...receipt.requestFieldNames, ...receipt.responseFieldNames].some(name => typeof name !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name))
    || !Number.isInteger(receipt.httpStatus) || receipt.httpStatus < 200 || receipt.httpStatus > 299
    || typeof receipt.responseMime !== 'string' || (!receipt.responseMime.trim() && receipt.httpStatus !== 204)
    || !Number.isSafeInteger(receipt.responseBytes) || receipt.responseBytes < (receipt.httpStatus === 204 ? 0 : 1)
    || (receipt.requestDigest !== undefined && !SHA256.test(receipt.requestDigest))
    || (receipt.intentDigest !== undefined && !SHA256.test(receipt.intentDigest))
    || (receipt.responseDigest !== undefined && !SHA256.test(receipt.responseDigest))
    || (expected.kind === 'submit' && (!SHA256.test(receipt.requestDigest) || !SHA256.test(receipt.intentDigest)
      || !SHA256.test(receipt.responseDigest) || receipt.attemptCount !== 1))
    || (receipt.attemptCount !== undefined && receipt.attemptCount !== 1)
    || receipt.handlerId !== expected.handlerId
    || !onlyKeys(receipt.dispatchBinding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))
    || receipt.dispatchBinding.handlerId !== expected.handlerId
    || receipt.dispatchBinding.operationId !== receipt.operationId
    || receipt.dispatchBinding.operationKind !== expected.kind
    || receipt.dispatchBinding.mode !== 'owner_bound_workspace_client'
    || !onlyKeys(receipt.transport, new Set(['tlsVerified', 'trustEnv', 'redirectsFollowed', 'explicitRetries',
      'cookieNames', 'cookieValuesPersisted', 'browserWriteCapture']))
    || receipt.transport.tlsVerified !== true || receipt.transport.trustEnv !== false
    || receipt.transport.redirectsFollowed !== false || receipt.transport.explicitRetries !== 0
    || receipt.transport.cookieValuesPersisted !== false || receipt.transport.browserWriteCapture !== false
    || !Array.isArray(receipt.transport.cookieNames)
    || receipt.transport.cookieNames.some(name => typeof name !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(name))
    || !record(receipt.semanticReadback) || !record(receipt.codeSha256)
    || !Object.keys(receipt.codeSha256).length
    || Object.entries(receipt.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))) invalid();
  validateOwnerProofReferenceFields(receipt);
  const semanticKeys = {
    'workspaces.list': new Set(['complete', 'workspaceCount']),
    'workspaces.shared.list': new Set(['complete', 'workspaceCount']),
    'workspaces.read': new Set(['readbackVerified', 'privateVerified', 'kindMatched', 'nameMatched']),
    'workspaces.create': new Set(['readbackVerified', 'readbackStatus', 'idMatched', 'nameMatched', 'kindMatched', 'privateVerified']),
    'workspaces.update': new Set(['readbackVerified', 'readbackStatus', 'idMatched', 'renamedNameMatched', 'kindMatched', 'privateVerified']),
    'workspaces.delete': new Set(['completeListReadback', 'listStatus', 'targetAbsent', 'baselineIdSetRestored', 'finalWorkspaceCount', 'responseSubstantive']),
  }[receipt.operationId];
  if (!onlyKeys(receipt.semanticReadback, semanticKeys)) invalid();
  if (receipt.operationId === 'workspaces.list' || receipt.operationId === 'workspaces.shared.list') {
    if (receipt.semanticReadback.complete !== true || !Number.isSafeInteger(receipt.semanticReadback.workspaceCount)
      || receipt.semanticReadback.workspaceCount < 0) invalid();
  } else if (receipt.operationId === 'workspaces.read') {
    if (receipt.semanticReadback.readbackVerified !== true || receipt.semanticReadback.privateVerified !== true
      || receipt.semanticReadback.kindMatched !== true
      || receipt.semanticReadback.nameMatched !== true) invalid();
  } else if (receipt.operationId === 'workspaces.create') {
    if (receipt.semanticReadback.readbackVerified !== true || receipt.semanticReadback.readbackStatus !== 200
      || receipt.semanticReadback.idMatched !== true || receipt.semanticReadback.nameMatched !== true
      || receipt.semanticReadback.kindMatched !== true || receipt.semanticReadback.privateVerified !== true) invalid();
  } else if (receipt.operationId === 'workspaces.update') {
    if (receipt.semanticReadback.readbackVerified !== true || receipt.semanticReadback.readbackStatus !== 200
      || receipt.semanticReadback.idMatched !== true || receipt.semanticReadback.renamedNameMatched !== true
      || receipt.semanticReadback.kindMatched !== true || receipt.semanticReadback.privateVerified !== true) invalid();
  } else if (receipt.semanticReadback.completeListReadback !== true || receipt.semanticReadback.listStatus !== 200
    || receipt.semanticReadback.targetAbsent !== true || receipt.semanticReadback.baselineIdSetRestored !== true
    || !Number.isSafeInteger(receipt.semanticReadback.finalWorkspaceCount)
    || receipt.semanticReadback.finalWorkspaceCount < 0 || receipt.semanticReadback.responseSubstantive !== false) invalid();
  if (!record(receipt.persistenceAssertions)) invalid();
  validateBooleanAssertions(receipt.persistenceAssertions,
    new Set([...PRIVATE_PERSISTENCE_KEYS, 'workspaceIdsPersisted', 'identityValuePersisted']), { requireFalse: true });
  return receipt;
}

function validateNativeAuthReceipt(receipt) {
  if (!onlyKeys(receipt, NATIVE_AUTH_RECEIPT_KEYS) || receipt.schemaVersion !== 1 || receipt.serviceId !== 'grok-web'
    || receipt.featureId !== 'auth.login' || receipt.requirementId !== 'auth.native-bootstrap'
    || receipt.operationId !== 'auth.native-bootstrap' || !isoTimestamp(receipt.observedAt) || !isoTimestamp(receipt.recordedAt)
    || receipt.execution !== 'native_browser_session_handoff' || receipt.evidenceClass !== 'native_auth_bootstrap'
    || receipt.providerLoginObserved !== true || receipt.nativeBrowserProfile !== true
    || receipt.sessionHandoffVerified !== true || receipt.sameAuthenticatedOwner !== true || receipt.ownerVerified !== true
    || receipt.evidenceScope !== 'same_authenticated_owner' || !SHA256.test(receipt.ownerIdentityReceiptSha256)
    || receipt.challengeBypassUsed !== false || receipt.passwordSubmittedToProviderApi !== false
    || receipt.receiptContainsCredentialValues !== false
    || !record(receipt.codeSha256)
    || Object.entries(receipt.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))) invalid();
  validateOwnerProofReferenceFields(receipt);
  validateBooleanAssertions(receipt.readinessAssertions, PRIVATE_READINESS_KEYS);
  validateBooleanAssertions(receipt.persistenceAssertions, PRIVATE_PERSISTENCE_KEYS, { requireFalse: true });
  return receipt;
}

function validateDirectMediaReceipt(receipt) {
  if (!onlyKeys(receipt, MEDIA_RECEIPT_KEYS) || ![1, 2].includes(receipt.schemaVersion) || receipt.serviceId !== 'grok-web'
    || receipt.evidenceClass !== 'direct_media_operation_replay'
    || !['image.generate.wss', 'video.text-to-video', 'video.image-reference-to-video', 'artifact.image.download', 'artifact.video.download'].includes(receipt.requirementId)
    || !isoTimestamp(receipt.observedAt) || !isoTimestamp(receipt.recordedAt)
    || !['direct_wss_client', 'direct_http_client'].includes(receipt.execution)
    || receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false
    || receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true
    || receipt.evidenceScope !== 'same_authenticated_owner'
    || !SHA256.test(receipt.mediaContractSha256) || !SHA256.test(receipt.requestDigest)
    || !SHA256.test(receipt.intentDigest) || !SHA256.test(receipt.promptSha256)
    || receipt.codeHashCapturedAtExecution !== true || !isoTimestamp(receipt.sourceCodeSnapshotAt)
    || Date.parse(receipt.sourceCodeSnapshotAt) > Date.parse(receipt.observedAt) || !record(receipt.codeSha256)
    || !Object.keys(receipt.codeSha256).length
    || Object.entries(receipt.codeSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))
    || !onlyKeys(receipt.dispatchBinding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))) invalid();
  const hasOperationContractSnapshot = receipt.operationContractSha256 !== undefined
    || receipt.operationContractSnapshotAt !== undefined || receipt.registryPolicySha256 !== undefined;
  if ((receipt.schemaVersion === 2 && !hasOperationContractSnapshot)
    || hasOperationContractSnapshot) {
    if (!record(receipt.operationContractSha256)
      || Object.keys(receipt.operationContractSha256).length !== MEDIA_OPERATION_CONTRACT_IDS.length
      || MEDIA_OPERATION_CONTRACT_IDS.some(operationId => !SHA256.test(receipt.operationContractSha256[operationId] ?? ''))
      || Object.keys(receipt.operationContractSha256).some(operationId => !MEDIA_OPERATION_CONTRACT_IDS.includes(operationId))
      || !isoTimestamp(receipt.operationContractSnapshotAt)
      || receipt.operationContractSnapshotAt !== receipt.sourceCodeSnapshotAt
      || Date.parse(receipt.operationContractSnapshotAt) > Date.parse(receipt.observedAt)
      || !SHA256.test(receipt.registryPolicySha256 ?? '')) invalid();
  }
  validateOwnerProofReferenceFields(receipt);
  if (!record(receipt.persistenceAssertions)) invalid();
  validateBooleanAssertions(receipt.persistenceAssertions,
    new Set([...PRIVATE_PERSISTENCE_KEYS, 'rawFramesPersisted', 'assetBytesPersisted', 'assetIdsPersisted',
      'promptPersisted', 'rawIdsOrKeysOrUrlsPersisted', 'cookiesOrTokensPersisted']), { requireFalse: true });

  const expectedByRequirement = {
    'image.generate.wss': { featureId: 'image-generation', operationId: 'media.image.create', handlerId: 'media.image-wss', mode: 'direct_wss_imagine_image_batch4', execution: 'direct_wss_client' },
    'video.text-to-video': { featureId: 'video-generation', operationId: 'media.video.create', handlerId: 'media.video-submit', mode: 'owner_bound_media_http_one_shot', execution: 'direct_http_client' },
    'video.image-reference-to-video': { featureId: 'video-generation', operationId: 'media.video.create', handlerId: 'media.video-submit', mode: 'owner_bound_media_http_one_shot', execution: 'direct_http_client' },
    'artifact.image.download': { featureId: 'artifact-download', operationId: 'media.asset.download', handlerId: 'media.asset-download', mode: 'owner_bound_generated_asset_download', execution: 'direct_http_client' },
    'artifact.video.download': { featureId: 'artifact-download', operationId: 'media.asset.download', handlerId: 'media.asset-download', mode: 'owner_bound_generated_asset_download', execution: 'direct_http_client' },
  }[receipt.requirementId];
  if (receipt.featureId !== expectedByRequirement.featureId || receipt.operationId !== expectedByRequirement.operationId
    || receipt.handlerId !== expectedByRequirement.handlerId || receipt.execution !== expectedByRequirement.execution
    || receipt.dispatchBinding.handlerId !== expectedByRequirement.handlerId
    || receipt.dispatchBinding.operationId !== expectedByRequirement.operationId
    || receipt.dispatchBinding.operationKind !== (receipt.requirementId.startsWith('artifact.') ? 'download' : 'submit')
    || receipt.dispatchBinding.mode !== expectedByRequirement.mode) invalid();
  if ((receipt.requirementId === 'video.text-to-video' && receipt.generationMode !== 'text')
    || (receipt.requirementId === 'video.image-reference-to-video' && receipt.generationMode !== 'image_reference')
    || (receipt.requirementId.startsWith('image.') && receipt.generationMode !== undefined)
    || (receipt.requirementId.startsWith('artifact.') && receipt.generationMode !== undefined)) invalid();

  if (!onlyKeys(receipt.browserCapture, MEDIA_BROWSER_CAPTURE_KEYS)
    || !['websocket_frame_blocked', 'http_request_aborted', 'native_read_capture'].includes(receipt.browserCapture.captureMode)
    || receipt.browserCapture.pageRoleMatched !== true || receipt.browserCapture.intentMatched !== true
    || receipt.browserCapture.requestCaptured !== true
    || typeof receipt.browserCapture.networkFailureCorrelated !== 'boolean'
    || receipt.browserCapture.browserBusinessWritesDelivered !== 0
    || !Number.isSafeInteger(receipt.browserCapture.browserResponseCount) || receipt.browserCapture.browserResponseCount < 0
    || receipt.browserCapture.rawRequestPersisted !== false || receipt.browserCapture.rawResponsePersisted !== false) invalid();
  if (receipt.requirementId === 'image.generate.wss') {
    if (receipt.browserCapture.captureMode !== 'websocket_frame_blocked' || receipt.browserCapture.businessActionBlocked !== true
      || receipt.browserCapture.browserResponseCount !== 0 || !SHA256.test(receipt.browserCapture.requestBodyDigest ?? '')
      || receipt.directTransport.requestBodyDigest !== receipt.browserCapture.requestBodyDigest) invalid();
  } else if (receipt.requirementId.startsWith('video.')) {
    if (receipt.browserCapture.captureMode !== 'http_request_aborted' || receipt.browserCapture.businessActionBlocked !== true
      || receipt.browserCapture.networkFailureCorrelated !== true || receipt.browserCapture.browserResponseCount !== 0
      || !SHA256.test(receipt.browserCapture.requestBodyDigest ?? '')
      || receipt.directTransport.requestBodyDigest !== receipt.browserCapture.requestBodyDigest) invalid();
  } else if (receipt.browserCapture.captureMode !== 'native_read_capture'
    || receipt.browserCapture.businessActionBlocked !== false || receipt.browserCapture.browserResponseCount < 1) invalid();

  if (!onlyKeys(receipt.directTransport, MEDIA_DIRECT_TRANSPORT_KEYS)
    || !['wss', 'http', 'asset_http'].includes(receipt.directTransport.transport)
    || typeof receipt.directTransport.origin !== 'string' || typeof receipt.directTransport.path !== 'string'
    || !Number.isInteger(receipt.directTransport.directDispatchCount) || receipt.directTransport.directDispatchCount !== 1
    || receipt.directTransport.automaticRetries !== 0 || receipt.directTransport.attemptCount !== 1
    || typeof receipt.directTransport.requestStarted !== 'boolean'
    || typeof receipt.directTransport.responseReceived !== 'boolean') invalid();
  if (receipt.directTransport.requestBodyDigest !== undefined && !SHA256.test(receipt.directTransport.requestBodyDigest)) invalid();
  if (receipt.directTransport.responseDigest !== undefined && receipt.directTransport.responseDigest !== null
    && !SHA256.test(receipt.directTransport.responseDigest)) invalid();
  if (receipt.directTransport.responseDigestKind !== undefined && receipt.directTransport.responseDigestKind !== null
    && !['raw_http_body', 'parsed_json_data'].includes(receipt.directTransport.responseDigestKind)) invalid();
  if (receipt.directTransport.httpStatus !== undefined && receipt.directTransport.httpStatus !== null
    && (!Number.isInteger(receipt.directTransport.httpStatus) || receipt.directTransport.httpStatus < 200
      || receipt.directTransport.httpStatus > 299)) invalid();
  if (receipt.directTransport.responseBytes !== undefined && receipt.directTransport.responseBytes !== null
    && (!Number.isSafeInteger(receipt.directTransport.responseBytes) || receipt.directTransport.responseBytes < 1)) invalid();
  if (receipt.directTransport.responseMime !== undefined && receipt.directTransport.responseMime !== null
    && (typeof receipt.directTransport.responseMime !== 'string' || !receipt.directTransport.responseMime.includes('/'))) invalid();

  if (!Array.isArray(receipt.operationReadbacks) || receipt.operationReadbacks.length !== 4
    || JSON.stringify(receipt.operationReadbacks.map(item => item?.operationId))
      !== JSON.stringify(['media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses'])) invalid();
  for (const item of receipt.operationReadbacks) {
    if (!onlyKeys(item, MEDIA_OPERATION_READBACK_KEYS) || !Number.isInteger(item.httpStatus) || item.httpStatus !== 200
      || !Number.isSafeInteger(item.responseBytes) || item.responseBytes < 1 || !SHA256.test(item.responseDigest ?? '')
      || item.responseDigestKind !== 'raw_http_body') invalid();
  }

  if (!onlyKeys(receipt.semanticReadback, MEDIA_READBACK_KEYS)
    || Object.entries(receipt.semanticReadback).some(([key, value]) => {
      const booleanKey = ['taskBoundToIntent', 'exactPromptMatched', 'sourceImageTaskVerified', 'sameConversationResponseSet',
        'allAssetDownloadsVerified', 'allAssetMagicVerified', 'allFileReadbacksVerified', 'assetOwnerVerified',
        'assetPromptMatched', 'sourceConversationMatched'].includes(key);
      const countKey = ['uniqueTaskCount', 'assetCount', 'privateGeneratedAssetCount', 'expectedAssetCount'].includes(key);
      return booleanKey ? typeof value !== 'boolean' : countKey ? (!Number.isSafeInteger(value) || value < 0) : true;
    })) invalid();
  const needsArtifact = receipt.requirementId === 'image.generate.wss'
    || receipt.requirementId.startsWith('video.') || receipt.requirementId.startsWith('artifact.');
  if (needsArtifact) {
    if (!Array.isArray(receipt.artifact) || receipt.artifact.length < 1 || receipt.artifact.length > 4) invalid();
    for (const artifact of receipt.artifact) {
      if (!onlyKeys(artifact, MEDIA_ARTIFACT_KEYS) || typeof artifact.mimeType !== 'string'
        || artifact.httpStatus !== 200
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || !SHA256.test(artifact.sha256 ?? '')
        || artifact.magicVerified !== true || artifact.independentFileReadback !== true || artifact.taskAssetMatched !== true) invalid();
    }
  } else if (receipt.artifact !== undefined) invalid();
  return receipt;
}

export function grokMediaOperationContractSnapshot(registry) {
  const operationContractSha256 = {};
  for (const operationId of MEDIA_OPERATION_CONTRACT_IDS) {
    const matches = registry.operations.filter(item => item.id === operationId);
    if (matches.length !== 1) return null;
    operationContractSha256[operationId] = operationDigest(matches[0]);
  }
  return {
    operationContractSha256,
    registryPolicySha256: sha256Text(canonicalJson({
      schemaVersion: registry.schemaVersion,
      serviceId: registry.serviceId,
      serviceOrigin: registry.serviceOrigin,
      allowedOrigins: [...registry.allowedOrigins].sort(),
      identityOperationId: registry.identityOperationId,
    })),
  };
}

function evaluateDirectMediaRequirement(feature, requirement, binding, context, reasons) {
  const mediaContract = context.mediaContracts?.[requirement.id];
  if (!mediaContract || mediaContract.operationId !== requirement.operationId) addReason(reasons, 'MEDIA_CONTRACT_MISSING');
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  const matching = context.mediaReceipts.filter(item => item.featureId === feature.id
    && item.requirementId === requirement.id && item.operationId === requirement.operationId
    && item.handlerId === requirement.handlerId);
  if (matching.length === 0) {
    addReason(reasons, 'POSITIVE_MEDIA_REPLAY_RECEIPT_MISSING');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_MEDIA_REPLAY_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  requireSameOwnerProof(receipt, context, reasons);
  if (receipt.mediaContractSha256 !== sha256Text(canonicalJson(mediaContract))) addReason(reasons, 'MEDIA_CONTRACT_DRIFT');
  if (receipt.operationContractSha256 !== undefined) {
    const currentContracts = grokMediaOperationContractSnapshot(context.registry);
    if (!currentContracts) addReason(reasons, 'MEDIA_OPERATION_CONTRACT_NOT_INSTALLED');
    else {
      if (receipt.operationContractSnapshotAt !== receipt.sourceCodeSnapshotAt) {
        addReason(reasons, 'MEDIA_OPERATION_CONTRACT_SNAPSHOT_TIME_INVALID');
      }
      if (receipt.registryPolicySha256 !== currentContracts.registryPolicySha256) {
        addReason(reasons, 'MEDIA_REGISTRY_POLICY_DRIFT');
      }
      for (const operationId of MEDIA_OPERATION_CONTRACT_IDS) {
        if (receipt.operationContractSha256[operationId] !== currentContracts.operationContractSha256[operationId]) {
          addReason(reasons, 'MEDIA_OPERATION_CONTRACT_DRIFT');
          break;
        }
      }
    }
  }
  if (!context.sourceEvidenceDocuments?.[mediaContract.sourceEvidencePath]
    || context.sourceEvidenceHashes?.[mediaContract.sourceEvidencePath] !== mediaContract.sourceEvidenceSha256) {
    addReason(reasons, 'MEDIA_SOURCE_EVIDENCE_MISSING_OR_DRIFTED');
  }
  const dispatch = HANDLER_DISPATCH[requirement.handlerId];
  if (!dispatch || !dispatch.kinds.has(requirement.expectedKind)
    || receipt.dispatchBinding.handlerId !== requirement.handlerId
    || receipt.dispatchBinding.operationId !== requirement.operationId
    || receipt.dispatchBinding.operationKind !== requirement.expectedKind
    || receipt.dispatchBinding.mode !== dispatch.mode) addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  if (receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  for (const file of binding.codeFiles) {
    if (!context.codeHashes[file]) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const operationId of mediaContract?.readbackOperationIds ?? []) {
    const operation = context.registry.operations.find(item => item.id === operationId);
    if (!operation) addReason(reasons, 'MEDIA_READBACK_CONTRACT_NOT_INSTALLED');
    else if (operation.kind !== 'read' || !operationReadiness(operation).ready) {
      addReason(reasons, 'MEDIA_READBACK_CONTRACT_NOT_READY');
    }
  }

  const direct = receipt.directTransport;
  const readback = receipt.semanticReadback;
  const artifacts = receipt.artifact;
  if (receipt.requirementId === 'image.generate.wss') {
    if (direct.transport !== 'wss' || direct.origin !== mediaContract.origin || direct.path !== mediaContract.path
      || direct.handshakeStatus !== 101 || direct.businessFramesSent !== 1
      || direct.directDispatchCount !== 1 || direct.automaticRetries !== 0 || !direct.requestStarted
      || receipt.browserCapture.captureMode !== 'websocket_frame_blocked'
      || receipt.browserCapture.networkFailureCorrelated !== false
      || readback.taskBoundToIntent !== true || readback.exactPromptMatched !== true
      || readback.uniqueTaskCount !== 1 || readback.assetCount !== 4 || readback.privateGeneratedAssetCount !== 4
      || readback.expectedAssetCount !== 4 || readback.sameConversationResponseSet !== true
      || readback.allAssetDownloadsVerified !== true || readback.allAssetMagicVerified !== true
      || readback.allFileReadbacksVerified !== true || artifacts.length !== 4
      || artifacts.some(item => !item.mimeType.startsWith('image/') || item.httpStatus !== 200)) addReason(reasons, 'IMAGE_TASK_READBACK_INCOMPLETE');
  } else if (receipt.requirementId.startsWith('video.')) {
    const expectedMode = receipt.requirementId === 'video.text-to-video' ? 'textToVideo' : 'imageToVideo';
    if (receipt.generationMode !== (expectedMode === 'textToVideo' ? 'text' : 'image_reference')
      || direct.transport !== 'http' || direct.origin !== mediaContract.origin || direct.path !== mediaContract.path
      || direct.method !== mediaContract.method || !direct.requestStarted || direct.responseReceived !== true
      || direct.httpStatus !== 200 || direct.responseMime?.split(';', 1)[0].toLowerCase() !== 'application/json'
      || !Number.isSafeInteger(direct.responseBytes) || direct.responseBytes < 1
      || !SHA256.test(direct.responseDigest ?? '') || direct.responseDigestKind !== 'raw_http_body'
      || !SHA256.test(direct.requestBodyDigest ?? '') || direct.requestBodyDigest !== receipt.browserCapture.requestBodyDigest
      || direct.directDispatchCount !== 1 || direct.automaticRetries !== 0 || direct.tlsVerified !== true
      || direct.redirectsFollowed !== false || direct.trustEnv !== false
      || receipt.browserCapture.captureMode !== 'http_request_aborted'
      || receipt.browserCapture.networkFailureCorrelated !== true
      || readback.taskBoundToIntent !== true || readback.exactPromptMatched !== true
      || readback.uniqueTaskCount !== 1 || readback.assetCount !== 1 || readback.privateGeneratedAssetCount !== 1
      || readback.expectedAssetCount !== 1 || readback.sameConversationResponseSet !== true
      || readback.allAssetDownloadsVerified !== true || readback.allAssetMagicVerified !== true
      || readback.allFileReadbacksVerified !== true || artifacts.length !== 1
      || artifacts[0].mimeType !== 'video/mp4' || artifacts[0].httpStatus !== 200
      || (expectedMode === 'imageToVideo' && readback.sourceImageTaskVerified !== true)) {
      addReason(reasons, 'VIDEO_TASK_READBACK_INCOMPLETE');
    }
  } else {
    const expectedMime = mediaContract.requiredMime ?? null;
    const mimePrefix = mediaContract.requiredMimePrefix ?? null;
    if (direct.transport !== 'asset_http' || direct.origin !== mediaContract.origin
      || direct.path !== mediaContract.path || direct.method !== 'GET'
      || !direct.requestStarted || direct.responseReceived !== true || direct.httpStatus !== 200
      || direct.directDispatchCount !== 1 || direct.automaticRetries !== 0 || direct.tlsVerified !== true
      || direct.redirectsFollowed !== false || direct.trustEnv !== false
      || !Number.isSafeInteger(direct.responseBytes) || direct.responseBytes < 1
      || !SHA256.test(direct.responseDigest ?? '') || artifacts.length !== 1
      || artifacts[0].httpStatus !== direct.httpStatus
      || (expectedMime && artifacts[0].mimeType !== expectedMime)
      || (mimePrefix && !artifacts[0].mimeType.startsWith(mimePrefix))
      || artifacts[0].bytes !== direct.responseBytes || artifacts[0].sha256 !== direct.responseDigest
      || readback.taskBoundToIntent !== true || readback.exactPromptMatched !== true
      || readback.assetOwnerVerified !== true || readback.assetPromptMatched !== true
      || readback.sourceConversationMatched !== true) addReason(reasons, 'GENERATED_ASSET_DOWNLOAD_UNVERIFIED');
  }
  return {
    ...receiptEvidence(receipt),
    provenance: 'direct_media_operation_replay',
    transport: direct.transport,
    httpStatus: direct.httpStatus ?? null,
    websocketHandshakeStatus: direct.handshakeStatus ?? null,
    taskBound: readback.taskBoundToIntent,
    readbackVerified: readback.allFileReadbacksVerified === true,
    artifactCount: artifacts.length,
  };
}

function validatePublicReplayReceipt(receipt) {
  if (!record(receipt) || receipt.schemaVersion !== 1 || receipt.service !== 'grok'
    || !record(receipt.publicRead) || !record(receipt.publicRead.evidence)
    || receipt.publicRead.evidence.operationId !== 'public.models'
    || receipt.publicRead.evidence.sourceDerived !== true || receipt.publicRead.evidence.browserCaptured !== false
    || receipt.publicRead.evidence.credentialsUsed !== false || receipt.publicRead.evidence.directReadVerified !== true
    || receipt.publicRead.evidence.liveReplay !== true || receipt.publicRead.evidence.liveResponseStatus !== 200
    || !Number.isSafeInteger(receipt.publicRead.evidence.liveResponseBytes) || receipt.publicRead.evidence.liveResponseBytes < 1
    || !SHA256.test(receipt.publicRead.evidence.liveResponseSha256)
    || !SHA256.test(receipt.publicRead.evidence.sourceSha256)
    || !record(receipt.implementationSha256)
    || Object.entries(receipt.implementationSha256).some(([file, hash]) => !safeRepoPath(file) || !SHA256.test(hash))) invalid();
  if (!isoTimestamp(receipt.checkedAt) || receipt.secretsPersistedInEvidence !== false) invalid();
  return receipt;
}

export function validatePublicReplayEvidence(receipt) {
  if (receipt !== null && receipt !== undefined) validatePublicReplayReceipt(receipt);
  return receipt ?? null;
}

export function validateFeatureReceipts(receipts) {
  if (!Array.isArray(receipts)) invalid();
  for (const receipt of receipts) {
    if (receipt?.evidenceClass === 'native_auth_bootstrap' || receipt?.requirementId === 'auth.native-bootstrap') {
      validateNativeAuthReceipt(receipt);
    } else if (receipt?.evidenceClass === 'direct_wss_session_replay') {
      validateDirectWssReceipt(receipt);
    } else if (receipt?.evidenceClass === 'direct_wss_regeneration_replay') {
      validateDirectWssRegenerationReceipt(receipt);
    } else if (receipt?.evidenceClass === 'source_native_model_selection_phase') {
      validateModelSelectionPhaseReceipt(receipt);
    } else if (receipt?.evidenceClass === 'first_party_bundle_direct_replay') {
      validateFirstPartyWorkspaceReceipt(receipt);
    } else if (receipt?.evidenceClass === 'direct_media_operation_replay') {
      validateDirectMediaReceipt(receipt);
    } else {
      validatePrivateReceipt(receipt);
    }
  }
  return receipts;
}

function applicabilityClass(value) {
  if (typeof value !== 'string') return 'unknown';
  if (/^conditional\b/i.test(value) || /^required\s+(?:when|if)\b/i.test(value)) return 'conditional';
  if (/^unknown\b/i.test(value)) return 'unknown';
  if (/^required\b/i.test(value)) return 'required';
  return 'unknown';
}

function isIdentityRequirement(requirement, operation, registry) {
  return requirement.handlerId === 'client.verify-owner'
    && operation?.role === 'identity'
    && registry.identityOperationId === operation.id;
}

function identityReceiptFor(checklist, registry, receipts, codeHashes, handlers) {
  const feature = checklist.features.find(item => item.id === 'auth.owner-identity');
  const requirement = feature?.requirements.find(item => item.operationId === registry.identityOperationId
    && item.handlerId === 'client.verify-owner');
  if (!requirement || !registry.identityOperationId) return { receipt: null, digest: null, ambiguous: false };
  const matches = receipts.filter(item => item.featureId === feature.id && item.requirementId === requirement.id
    && item.operationId === registry.identityOperationId && item.handlerId === 'client.verify-owner');
  if (matches.length !== 1) return { receipt: null, digest: null, ambiguous: matches.length > 1 };
  const receipt = matches[0];
  const operation = registry.operations.find(item => item.id === registry.identityOperationId);
  const binding = checklist.handlerBindings[requirement.handlerId];
  const responseMime = receipt.responseMime?.split(';', 1)[0].trim().toLowerCase();
  const operationMime = operation?.response?.contentTypes?.map(type => type.split(';', 1)[0].trim().toLowerCase()) ?? [];
  const valid = operation?.role === 'identity' && operation.kind === 'read'
    && operationReadiness(operation).ready
    && handlers?.['client.verify-owner'] === true
    && receipt.liveReplay === true && receipt.liveReplayRecorded === true && receipt.mocked === false
    && receipt.ownerVerified === true && receipt.sameAuthenticatedOwner === true
    && SHA256.test(receipt.ownerScopeSha256)
    && receipt.capturedOperationSha256 === operationDigest(operation)
    && operation.response.statuses.includes(receipt.httpStatus)
    && operationMime.includes(responseMime)
    && receipt.responseBytes <= operation.response.maxBytes
    && dispatchBindingMatches(receipt, requirement, operation, registry)
    && receipt.readinessAssertions?.handlerDispatchVerified === true
    && binding.codeFiles.every(file => codeHashes?.[file] && receipt.codeSha256?.[file] === codeHashes[file]);
  if (!valid) return { receipt: null, digest: null, ambiguous: false };
  return { receipt, digest: sha256Text(canonicalJson(receipt)), scopeSha256: receipt.ownerScopeSha256, ambiguous: false };
}

function validOwnerProofDocument(proof) {
  return record(proof) && proof.schemaVersion === 1 && proof.serviceId === 'grok-web'
    && proof.featureId === 'auth.owner-identity' && proof.requirementId === 'auth.owner.read'
    && proof.operationId === 'auth.owner.read' && proof.ownerVerified === true
    && proof.sameAuthenticatedOwner === true && proof.evidenceScope === 'same_authenticated_owner'
    && SHA256.test(proof.ownerScopeSha256);
}

function resolveOwnerProof(receipt, currentIdentity, documents = {}) {
  if (!currentIdentity?.scopeSha256 || !SHA256.test(currentIdentity.scopeSha256)) return { status: 'current_missing' };
  let proof;
  if (receipt.ownerProofPath !== undefined) {
    proof = documents[receipt.ownerProofPath];
    if (!proof || !validOwnerProofDocument(proof)
      || sha256Text(canonicalJson(proof)) !== receipt.ownerProofSha256) return { status: 'unresolved' };
    if (receipt.ownerProofPath.startsWith('verification/owner-proofs/')
      && receipt.ownerProofPath !== `verification/owner-proofs/${receipt.ownerProofSha256}.json`) return { status: 'unresolved' };
    if (receipt.ownerScopeSha256 !== proof.ownerScopeSha256) return { status: 'mismatch' };
  } else {
    const legacyDigest = receipt.ownerIdentityReceiptSha256;
    if (!SHA256.test(legacyDigest ?? '')) return { status: 'unresolved' };
    const matches = Object.values(documents).filter(item => validOwnerProofDocument(item)
      && sha256Text(canonicalJson(item)) === legacyDigest);
    if (!matches.length) return { status: 'unresolved' };
    proof = matches[0];
  }
  return proof.ownerScopeSha256 === currentIdentity.scopeSha256
    ? { status: 'verified', proof }
    : { status: 'mismatch', proof };
}

function requireSameOwnerProof(receipt, context, reasons) {
  const resolved = resolveOwnerProof(receipt, context.identityReceipt, context.ownerProofDocuments);
  if (resolved.status === 'current_missing') addReason(reasons, 'OWNER_IDENTITY_RECEIPT_MISSING');
  else if (resolved.status === 'unresolved') addReason(reasons, 'OWNER_PROOF_REFERENCE_UNRESOLVED');
  else if (resolved.status === 'mismatch') addReason(reasons, 'OWNER_IDENTITY_SCOPE_MISMATCH');
  return resolved.status === 'verified';
}

function dispatchBindingMatches(receipt, requirement, operation, registry) {
  const expected = HANDLER_DISPATCH[requirement.handlerId];
  if (!expected || !expected.kinds.has(operation.kind)) return false;
  if (requirement.handlerId === 'client.verify-owner'
    && !isIdentityRequirement(requirement, operation, registry)) return false;
  const binding = receipt.dispatchBinding;
  return onlyKeys(binding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))
    && binding.handlerId === requirement.handlerId
    && binding.operationId === operation.id
    && binding.operationKind === operation.kind
    && binding.mode === expected.mode;
}

function receiptEvidence(receipt, evidenceScope = receipt?.evidenceScope ?? null) {
  if (!receipt) return null;
  return {
    recordedAt: receipt.recordedAt ?? receipt.observedAt ?? null,
    observedAt: receipt.observedAt ?? null,
    evidenceScope,
    ownerIdentityReceiptSha256: receipt.ownerIdentityReceiptSha256 ?? null,
    ownerProofPath: receipt.ownerProofPath ?? null,
    ownerProofSha256: receipt.ownerProofSha256 ?? null,
    ownerScopeSha256: receipt.ownerScopeSha256 ?? null,
    liveReplayRecorded: receipt.liveReplayRecorded === true,
  };
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function hashMatchesFiles(expected, actualHashes, reasons) {
  for (const [file, expectedHash] of Object.entries(expected)) {
    if (actualHashes[file] === undefined) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (actualHashes[file] !== expectedHash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
}

function evaluatePublicRequirement(requirement, operation, binding, context, reasons) {
  if (!operation) {
    addReason(reasons, 'CONTRACT_NOT_INSTALLED');
    return null;
  }
  if (operation.id !== 'public.models' || operation.authMode !== 'none'
    || operation.kind !== requirement.expectedKind || operation.evidence?.source !== 'public_bundle_callsite'
    || operation.authMode !== requirement.expectedAuthMode || !operationReadiness(operation).ready) {
    addReason(reasons, 'PUBLIC_MODEL_CONTRACT_NOT_READY');
  }
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  if (!context.publicReplayReceipt) {
    addReason(reasons, 'PUBLIC_REPLAY_RECEIPT_MISSING');
    return null;
  }
  const evidence = context.publicReplayReceipt.publicRead.evidence;
  const sourceAsset = context.sourceAssets?.[requirement.candidate.sourceAsset];
  let sourceUrl = null;
  try { sourceUrl = new URL(operation.evidence?.sourceFile); } catch { /* A malformed source URL remains unresolved. */ }
  if (evidence.sourceSha256 !== operation?.evidence?.sourceSha256
    || evidence.liveResponseSha256 !== operation?.evidence?.directReplay?.responseSha256
    || evidence.liveResponseBytes > operation?.response?.maxBytes
    || !sourceAsset || !sourceUrl || sourceUrl.origin !== sourceAsset.origin
    || sourceUrl.pathname !== sourceAsset.path || operation.evidence?.sourceSha256 !== sourceAsset.sha256) {
    addReason(reasons, 'PUBLIC_REPLAY_CONTRACT_MISMATCH');
  }
  hashMatchesFiles(context.publicReplayReceipt.implementationSha256, context.codeHashes, reasons);
  for (const file of binding.codeFiles) {
    if (context.codeHashes[file] === undefined) addReason(reasons, 'HANDLER_SOURCE_MISSING');
  }
  return {
    recordedAt: context.publicReplayReceipt.checkedAt,
    observedAt: evidence.checkedAt ?? context.publicReplayReceipt.checkedAt,
    evidenceScope: 'anonymous_public_metadata',
    liveReplayRecorded: evidence.liveReplay === true,
  };
}

function evaluateCapturedRequirement(feature, requirement, operation, receipts, binding, context, reasons) {
  if (requirement.operationId === 'public.models') addReason(reasons, 'PUBLIC_MODEL_CANNOT_SATISFY_PRIVATE_FEATURE');
  if (!operation) addReason(reasons, 'CONTRACT_NOT_INSTALLED');
  if (operation) {
    if (operation.kind !== requirement.expectedKind) addReason(reasons, 'CONTRACT_KIND_MISMATCH');
    if (requirement.expectedAuthMode !== 'any' && operation.authMode !== requirement.expectedAuthMode) {
      addReason(reasons, 'CONTRACT_AUTH_MODE_MISMATCH');
    }
    if (operation.evidence?.source !== 'browser_network_capture') addReason(reasons, 'BROWSER_CAPTURE_REQUIRED');
    if (operation.evidence?.securityBoundary !== 'normal_observed_xhr'
      || !Array.isArray(operation.evidence.securitySignals) || operation.evidence.securitySignals.length) {
      addReason(reasons, 'SECURITY_BOUNDARY_NOT_CLEARED');
    }
    if (!operationReadiness(operation).ready) addReason(reasons, 'CONTRACT_NOT_READY');
    if (requirement.handlerId === 'client.verify-owner'
      && (operation.role !== 'identity' || context.registry.identityOperationId !== operation.id)) {
      addReason(reasons, 'IDENTITY_HANDLER_NOT_BOUND');
    }
    if (requirement.expectedAuthMode === 'session') {
      const bindings = operation.request?.credentialBindings ?? { cookies: [], headers: [] };
      if (!bindings.cookies?.length && !bindings.headers?.length) addReason(reasons, 'SESSION_BINDINGS_MISSING');
    }
  }
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');

  const matching = receipts.filter(item => item.requirementId === requirement.id);
  if (matching.length === 0) {
    addReason(reasons, 'POSITIVE_LIVE_RECEIPT_MISSING');
    if (applicabilityClass(feature.applicability) !== 'required') addReason(reasons, 'CONDITIONAL_APPLICABILITY_UNRESOLVED');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_LIVE_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (receipt.featureId !== feature.id || receipt.operationId !== requirement.operationId) addReason(reasons, 'RECEIPT_SCOPE_MISMATCH');
  if (receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false) addReason(reasons, 'RECEIPT_IS_NOT_LIVE');
  if (requirement.requiresOwnerVerified && receipt.ownerVerified !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  const identityRequirement = isIdentityRequirement(requirement, operation, context.registry);
  if (requirement.requiresOwnerVerified && !identityRequirement) {
    requireSameOwnerProof(receipt, context, reasons);
  }
  if (requirement.requiresOwnerVerified && identityRequirement && receipt.ownerIdentityReceiptSha256 !== undefined) {
    addReason(reasons, 'OWNER_IDENTITY_RECEIPT_SELF_REFERENCE');
  }
  if (receipt.handlerId !== requirement.handlerId || receipt.handlerId !== binding.handlerId) addReason(reasons, 'RECEIPT_HANDLER_MISMATCH');
  if (operation && !dispatchBindingMatches(receipt, requirement, operation, context.registry)) {
    addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  }
  if (operation) {
    if (receipt.capturedOperationSha256 !== operationDigest(operation)) addReason(reasons, 'CAPTURED_CONTRACT_DRIFT');
    if (!operation.response.statuses.includes(receipt.httpStatus)) addReason(reasons, 'LIVE_STATUS_NOT_ACCEPTED');
    if (receipt.responseMime && !operation.response.contentTypes.some(type => type.split(';', 1)[0].toLowerCase() === receipt.responseMime.split(';', 1)[0].toLowerCase())) {
      addReason(reasons, 'LIVE_MIME_NOT_ACCEPTED');
    }
    const maxBytes = operation.kind === 'download' ? operation.artifact?.maxBytes : operation.response.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || receipt.responseBytes > maxBytes) addReason(reasons, 'LIVE_RESPONSE_SIZE_INVALID');
  }
  if (requirement.expectedKind === 'download' && receipt.artifactVerified !== true) addReason(reasons, 'ARTIFACT_NOT_VERIFIED');
  if (requirement.operationId === 'conversation.list.read') {
    const variants = Array.isArray(receipt.readVariants) ? receipt.readVariants : [];
    const variantNames = variants.map(item => item.name);
    if (JSON.stringify(variantNames) !== JSON.stringify(['first_page', 'next_page', 'search'])) {
      addReason(reasons, 'CONVERSATION_LIST_PAGE_SEARCH_EVIDENCE_MISSING');
    } else if (operation) {
      const allowedFields = new Set(Object.keys(operation.request?.inputSchema?.properties ?? {}));
      if (variants.some(item => item.httpStatus !== 200 || item.responseBytes > operation.response.maxBytes
        || item.requestFieldNames.some(name => !allowedFields.has(name)))) {
        addReason(reasons, 'CONVERSATION_LIST_VARIANT_CONTRACT_MISMATCH');
      }
      const firstPage = variants[0];
      const nextPage = variants[1];
      const search = variants[2];
      if (JSON.stringify(firstPage.requestFieldNames) !== JSON.stringify(['pageSize']) || !firstPage.nextPageTokenPresent
        || JSON.stringify(nextPage.requestFieldNames) !== JSON.stringify(['pageSize', 'pageToken'])
        || JSON.stringify(search.requestFieldNames) !== JSON.stringify(['pageSize', 'searchQuery'])
        || search.textSearchMatchCount < 1
        || search.targetConversationMatched !== true) addReason(reasons, 'CONVERSATION_LIST_VARIANT_READBACK_UNVERIFIED');
      if (receipt.requestDigest !== firstPage.requestDigest || receipt.responseDigest !== firstPage.responseDigest
        || receipt.responseBytes !== firstPage.responseBytes || receipt.httpStatus !== firstPage.httpStatus) {
        addReason(reasons, 'CONVERSATION_LIST_PRIMARY_VARIANT_MISMATCH');
      }
    }
  }
  if (requirement.operationId === 'conversation.read'
    && (receipt.semanticReadback?.readbackVerified !== true
      || receipt.semanticReadback?.detailMatchesSearch !== true
      || receipt.semanticReadback?.viewerIsOwner !== true
      || receipt.semanticReadback?.mutableOwnerAccessVerified !== true)) {
    addReason(reasons, 'CONVERSATION_DETAIL_READBACK_UNVERIFIED');
  }
  if (requirement.operationId === 'history.response-nodes'
    && (!Number.isSafeInteger(receipt.semanticReadback?.responseNodeCount)
      || !Number.isSafeInteger(receipt.semanticReadback?.inflightResponseCount))) {
    addReason(reasons, 'HISTORY_RESPONSE_NODES_SHAPE_UNVERIFIED');
  }
  if (requirement.operationId === 'history.load-responses'
    && (!Number.isSafeInteger(receipt.semanticReadback?.loadedResponseCount)
      || !Number.isSafeInteger(receipt.semanticReadback?.loadedUserMessageCount)
      || !Number.isSafeInteger(receipt.semanticReadback?.loadedAssistantMessageCount)
      || receipt.semanticReadback?.responseIdsBoundInMemory !== true)) {
    addReason(reasons, 'HISTORY_LOAD_RESPONSES_SHAPE_UNVERIFIED');
  }
  const expectedFiles = Object.fromEntries(binding.codeFiles.map(file => [file, context.codeHashes[file]]));
  if (Object.values(expectedFiles).some(hash => !hash)) addReason(reasons, 'HANDLER_SOURCE_MISSING');
  for (const [file, hash] of Object.entries(expectedFiles)) {
    if (receipt.codeSha256[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  if (receipt.readinessAssertions?.handlerDispatchVerified !== true) addReason(reasons, 'HANDLER_DISPATCH_NOT_RECORDED');
  if (requirement.requiresOwnerVerified && !identityRequirement
    && receipt.readinessAssertions?.ownerScopeBound !== true) addReason(reasons, 'OWNER_IDENTITY_SCOPE_NOT_RECORDED');
  const evidence = receiptEvidence(receipt);
  if (requirement.operationId === 'conversation.list.read' && Array.isArray(receipt.readVariants)) {
    evidence.readVariants = receipt.readVariants.map(item => ({
      name: item.name, httpStatus: item.httpStatus, responseBytes: item.responseBytes,
      conversationCount: item.conversationCount, nextPageTokenPresent: item.nextPageTokenPresent,
      ...(item.name === 'search' ? {
        searchQuerySha256: item.searchQuerySha256,
        textSearchMatchCount: item.textSearchMatchCount,
        targetConversationMatched: item.targetConversationMatched,
      } : {}),
    }));
  }
  if (receipt.semanticReadback) evidence.semanticReadback = receipt.semanticReadback;
  return evidence;
}

export function currentSettingsRoundtripMatchesReceipt(receipt, proof) {
  if (!record(proof) || proof.schema !== 'grok-settings-current-source-roundtrip-v2'
      || proof.outcome !== 'verified' || proof.sourceStable !== true
      || proof.ownerVerified !== true || proof.ownerScopeSha256 !== receipt.ownerScopeSha256
      || proof.preference !== 'autoWrapLongLinesCode' || typeof proof.baseline !== 'boolean'
      || proof.remotePrivacyFieldsSubmitted !== false || proof.rawSettingsCredentialsValuesPersisted !== false
      || proof.writeAttempts?.apply !== 1 || proof.writeAttempts?.restore !== 1
      || proof.changedValueMatched !== true || proof.baselineRestored !== true
      || proof.wholeSettingsRestored !== true || !record(proof.sourceBeforeImports)) return false;
  const readValid = value => record(value) && value.httpStatus === 200
    && value.mime?.split(';', 1)[0].trim().toLowerCase() === 'application/json'
    && Number.isSafeInteger(value.responseBytes) && value.responseBytes > 0
    && SHA256.test(value.rawBodySha256 ?? '') && value.rawDigestKind === 'raw_http_body'
    && SHA256.test(value.requestDigest ?? '');
  if (![proof.ownerRead, proof.before, proof.afterApply, proof.afterRestore].every(readValid)) return false;
  const writeValid = value => value?.state === 'completed' && value.verified === true
    && value.httpStatus === 200 && value.readbackStatus === 200
    && value.otherPreferencesUnchanged === true && value.otherSettingsUnchanged === true
    && value.responseReceipt?.operationId === 'settings.update'
    && value.responseReceipt.responseStatus === 200
    && value.responseReceipt.responseContentType === 'application/json'
    && value.responseReceipt.responseDigestKind === 'raw_http_body'
    && SHA256.test(value.responseReceipt.responseDigest ?? '')
    && SHA256.test(value.responseReceipt.requestDigest ?? '')
    && SHA256.test(value.responseReceipt.intentDigest ?? '')
    && value.responseReceipt.attemptCount === 1 && value.responseReceipt.explicitRetries === 0
    && value.responseReceipt.ownerVerified === true && value.responseReceipt.tlsVerified === true
    && value.responseReceipt.trustEnv === false && value.responseReceipt.redirectsFollowed === false;
  if (![proof.apply, proof.restore].every(writeValid)) return false;
  const apply = proof.apply.responseReceipt;
  const restore = proof.restore.responseReceipt;
  const semantic = receipt.semanticReadback;
  return receipt.operationId === 'settings.update'
    && receipt.httpStatus === apply.responseStatus && receipt.responseBytes === apply.responseBytes
    && receipt.responseDigest === apply.responseDigest && receipt.responseDigestKind === 'raw_http_body'
    && receipt.requestDigest === apply.requestDigest && receipt.intentDigest === apply.intentDigest
    && proof.afterApply.rawBodySha256 === apply.responseDigest
    && proof.afterRestore.rawBodySha256 === restore.responseDigest
    && proof.before.rawBodySha256 === proof.afterRestore.rawBodySha256
    && receipt.restoreReplay?.requestDigest === restore.requestDigest
    && receipt.restoreReplay?.intentDigest === restore.intentDigest
    && semantic?.beforeValue === proof.baseline && semantic?.afterValue === !proof.baseline
    && semantic?.restoreBeforeValue === !proof.baseline && semantic?.restoreAfterValue === proof.baseline
    && Object.entries(receipt.codeSha256 ?? {}).every(([file, digest]) =>
      proof.sourceBeforeImports[file] === digest)
    && SHA256.test(proof.sourceBeforeImports['scripts/verify-settings-roundtrip-once.mjs'] ?? '');
}

function firstPartySdkProofMatchesReceipt(receipt, proof) {
  if (receipt.operationId === 'settings.update'
      && proof?.schema === 'grok-settings-current-source-roundtrip-v2') {
    return currentSettingsRoundtripMatchesReceipt(receipt, proof);
  }
  if (receipt.operationId === 'conversation.soft-delete') {
    if (record(proof) && proof.operationId === 'conversation.crud') {
      const direct = proof.operations?.delete;
      const semantic = proof.readback?.delete;
      return Boolean(proof.status === 'verified' && proof.ownerVerified === true
        && proof.ownerScopeDigest === receipt.ownerScopeSha256
        && proof.createSourceContract?.browserBusinessWriteDelivered === false
        && proof.browserGuardAndReset?.httpGuardInstalledBeforeDirectWriter === true
        && proof.browserGuardAndReset?.webSocketGuardInstalledBeforeDirectWriter === true
        && proof.browserGuardAndReset?.browserBusinessFramesDelivered === 0
        && direct?.state === 'completed' && direct?.verified === true
        && direct?.httpStatus === receipt.httpStatus && direct?.responseBytes === receipt.responseBytes
        && direct?.requestDigest === receipt.requestDigest && direct?.intentDigest === receipt.intentDigest
        && direct?.responseDigestPersisted === true && direct?.responseDigest === receipt.responseDigest
        && direct?.responseDigestKind === 'raw_http_body'
        && proof.sourceCodeSnapshotSha256?.['contracts/grok-web.v1.json']
          === 'a2f8be65b4b12757e8380a90afad93d223d8ab2993239a2a4f0814124c17c4b0'
        && direct?.attemptCount === 1 && direct?.explicitRetries === 0
        && direct?.tlsVerified === true && direct?.trustEnv === false && direct?.redirectsFollowed === false
        && semantic?.listStatus === 200 && semantic?.completePaginatedListReadback === true
        && semantic?.targetAbsent === true && semantic?.unrelatedConversationSetPreserved === true
        && semantic?.conversationIdSetMatchesBaseline === true
        && semantic?.baselineConversationIdSetSha256 === semantic?.currentConversationIdSetSha256
        && receipt.semanticReadback?.conversationAbsent === true
        && receipt.semanticReadback?.otherConversationsUnchanged === true);
    }
    if (!record(proof) || proof.schemaVersion !== 1 || proof.operationId !== 'conversation.soft-delete'
      || proof.ownerVerified !== true || proof.sourceCapture?.exactTargetMatched !== true
      || proof.sourceCapture?.browserRequestAbortConfirmed !== true
      || proof.sourceCapture?.browserRequestReachedProvider !== false
      || proof.sourceCapture?.pathTemplate !== '/rest/app-chat/conversations/soft/{conversationId}'
      || proof.source?.sourceFunctionName !== 'chatSoftDeleteConversationRaw'
      || proof.source?.sourceSha256 !== 'be4f8e3ba59be451e39f4f289b39706763028ef0b107335676dcc6fa2893b99a'
      || proof.source?.method !== 'DELETE'
      || !record(proof.directReplay) || !record(proof.semanticReadback)) return false;
    const direct = proof.directReplay;
    const semantic = proof.semanticReadback;
    return Boolean(receipt.httpStatus === direct.httpStatus && receipt.responseBytes === direct.responseBytes
      && receipt.requestDigest === direct.requestDigest && receipt.intentDigest === direct.intentDigest
      && receipt.responseDigest === direct.parsedResponseDigest && receipt.responseDigestKind === 'parsed_json_data'
      && direct.responseDigestPersisted === false && direct.attemptCount === 1 && direct.ownerVerified === true
      && direct.tlsVerified === true && direct.trustEnv === false
      && direct.redirectsFollowed === false && direct.explicitRetries === 0
      && semantic.conversationAbsent === true && semantic.otherConversationsUnchanged === true
      && semantic.completeListReadback === true
      && semantic.readbackStatus === 200 && receipt.semanticReadback?.conversationAbsent === true
      && receipt.semanticReadback?.otherConversationsUnchanged === true);
  }
  if (receipt.operationId !== 'settings.update') return record(proof);
  if (!record(proof) || proof.schemaVersion !== 1 || proof.operationId !== 'settings.update'
    || proof.ownerVerified !== true || proof.rawCookiePersisted !== false
    || proof.rawIdentityPersisted !== false || proof.rawSettingsPersisted !== false
    || !record(proof.target) || !record(proof.directChange) || !record(proof.directChange.readback)
    || !record(proof.restore) || !record(proof.restore.readback)) return false;
  const direct = proof.directChange;
  const restore = proof.restore;
  const semantic = receipt.semanticReadback;
  return Boolean(receipt.httpStatus === direct.httpStatus && receipt.responseBytes === direct.responseBytes
    && receipt.requestDigest === direct.requestDigest && receipt.intentDigest === direct.intentDigest
    && receipt.responseDigest === direct.parsedResponseDigest && receipt.responseDigestKind === 'parsed_json_data'
    && direct.responseDigestPersisted === false && direct.verified === true
    && receipt.restoreReplay?.httpStatus === restore.httpStatus
    && receipt.restoreReplay?.readbackStatus === restore.readbackStatus
    && receipt.restoreReplay?.requestDigest === restore.requestDigest
    && receipt.restoreReplay?.intentDigest === restore.intentDigest
    && receipt.restoreReplay?.readbackVerified === restore.verified
    && receipt.restoreReplay?.otherPreferencesUnchanged === restore.readback.otherPreferencesUnchanged
    && receipt.restoreReplay?.otherSettingsUnchanged === restore.readback.otherSettingsUnchanged
    && semantic?.preferenceName === proof.target.preferenceName
    && semantic?.beforeValue === proof.target.initialValue
    && semantic?.afterValue === proof.target.temporaryValue
    && semantic?.restoreBeforeValue === proof.target.temporaryValue
    && semantic?.restoreAfterValue === proof.target.restoredValue
    && semantic?.otherPreferencesUnchanged === direct.readback.otherPreferencesUnchanged
    && semantic?.otherSettingsUnchanged === direct.readback.otherSettingsUnchanged
    && semantic?.restoreOtherPreferencesUnchanged === restore.readback.otherPreferencesUnchanged
    && semantic?.restoreVerified === restore.verified
    && proof.finalValueVerifiedFalse === true);
}

function evaluateFirstPartySdkRequirement(feature, requirement, operation, receipts, binding, context, reasons) {
  if (requirement.operationId === 'attachment.upload.direct'
    && requirement.handlerId === 'attachments.upload-direct') {
    return evaluateDirectAttachmentUploadRequirement(feature, requirement, operation, receipts, binding, context, reasons);
  }
  if (!operation) addReason(reasons, 'CONTRACT_NOT_INSTALLED');
  if (operation) {
    if (operation.kind !== requirement.expectedKind) addReason(reasons, 'CONTRACT_KIND_MISMATCH');
    if (operation.authMode !== requirement.expectedAuthMode) addReason(reasons, 'CONTRACT_AUTH_MODE_MISMATCH');
    if (operation.evidence?.source !== 'first_party_sdk_contract') addReason(reasons, 'FIRST_PARTY_SDK_SOURCE_MISSING');
    if (!operationReadiness(operation).ready) addReason(reasons, 'CONTRACT_NOT_READY');
  }
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  const matching = receipts.filter(item => item.featureId === feature.id && item.requirementId === requirement.id
    && item.operationId === requirement.operationId && item.handlerId === requirement.handlerId);
  if (matching.length === 0) {
    addReason(reasons, 'POSITIVE_FIRST_PARTY_SDK_RECEIPT_MISSING');
    if (applicabilityClass(feature.applicability) !== 'required') addReason(reasons, 'CONDITIONAL_APPLICABILITY_UNRESOLVED');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_FIRST_PARTY_SDK_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false) addReason(reasons, 'RECEIPT_IS_NOT_LIVE');
  if (receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  requireSameOwnerProof(receipt, context, reasons);
  const sourceProofPath = operation?.evidence?.directReplayReceipt;
  const sourceProof = context.sourceEvidenceDocuments?.[sourceProofPath];
  if (receipt.sourceProofPath !== sourceProofPath || !sourceProof
    || context.sourceEvidenceHashes?.[sourceProofPath] !== receipt.sourceProofSha256) {
    addReason(reasons, 'SOURCE_EVIDENCE_MISSING_OR_DRIFTED');
  }
  if (receipt.codeHashCapturedAtExecution !== true) addReason(reasons, 'HANDLER_SOURCE_BINDING_UNVERIFIED');
  if (!firstPartySdkProofMatchesReceipt(receipt, sourceProof)) addReason(reasons, 'SOURCE_EVIDENCE_RECEIPT_MISMATCH');
  if (operation) {
    const replay = operation.evidence?.directReplay;
    const expectedResponseDigest = replay?.responseDigestPersisted === false
      ? replay?.parsedResponseDigest : replay?.responseSha256;
    const expectedResponseDigestKind = replay?.responseDigestPersisted === false
      ? 'parsed_json_data' : 'raw_http_body';
    if (!replay || receipt.capturedOperationSha256 !== operationDigest(operation)
      || receipt.httpStatus !== replay.status || receipt.responseDigest !== expectedResponseDigest
      || receipt.responseDigestKind !== expectedResponseDigestKind
      || receipt.responseBytes !== replay.responseBytes
      || (operation.kind === 'submit' && (receipt.requestDigest !== replay.requestDigest
        || receipt.intentDigest !== replay.intentDigest))
      || (operation.kind !== 'submit' && receipt.requestDigest !== replay.requestDigest)) {
      addReason(reasons, 'FIRST_PARTY_SDK_REPLAY_MISMATCH');
    }
    if (!operation.response.statuses.includes(receipt.httpStatus)) addReason(reasons, 'LIVE_STATUS_NOT_ACCEPTED');
    if (receipt.responseMime && !operation.response.contentTypes.some(type => type.split(';', 1)[0].toLowerCase()
      === receipt.responseMime.split(';', 1)[0].toLowerCase())) addReason(reasons, 'LIVE_MIME_NOT_ACCEPTED');
    const maxBytes = operation.kind === 'download' ? operation.artifact?.maxBytes : operation.response.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || receipt.responseBytes > maxBytes) addReason(reasons, 'LIVE_RESPONSE_SIZE_INVALID');
  }
  if (receipt.handlerId !== requirement.handlerId
    || !operation || !dispatchBindingMatches(receipt, requirement, operation, context.registry)) {
    addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  }
  const semantic = receipt.semanticReadback;
  if (requirement.expectedKind === 'submit' && (!semantic || semantic.readbackVerified !== true
    || semantic.readbackStatus !== 200)) addReason(reasons, 'SEMANTIC_READBACK_NOT_VERIFIED');
  if (receipt.operationId === 'settings.update' && (semantic?.preferenceName !== 'autoWrapLongLinesCode'
    || typeof semantic.beforeValue !== 'boolean' || typeof semantic.afterValue !== 'boolean'
    || semantic.beforeValue === semantic.afterValue || semantic.otherPreferencesUnchanged !== true
    || semantic.otherSettingsUnchanged !== true || semantic.restoreVerified !== true
    || semantic.restoreStatus !== 200 || semantic.restoreBeforeValue !== semantic.afterValue
    || semantic.restoreAfterValue !== semantic.beforeValue || semantic.restoreOtherPreferencesUnchanged !== true
    || receipt.restoreReplay?.httpStatus !== 200 || receipt.restoreReplay?.readbackStatus !== semantic.restoreStatus
    || receipt.restoreReplay?.readbackVerified !== true || receipt.restoreReplay?.otherPreferencesUnchanged !== true
    || receipt.restoreReplay?.otherSettingsUnchanged !== true)) {
    addReason(reasons, 'SAFE_PREFERENCE_CHANGE_RESTORE_NOT_VERIFIED');
  }
  if (receipt.operationId === 'conversation.share.set' && (semantic?.sameConversationId !== true
    || semantic?.sameResponseId !== true || semantic?.shareLinkIdMatched !== true
    || semantic?.isPublic !== true || typeof semantic?.allowIndexing !== 'boolean')) {
    addReason(reasons, 'PUBLIC_SHARE_READBACK_NOT_VERIFIED');
  }
  if (receipt.operationId === 'conversation.share.revoke' && semantic?.shareLinkAbsent !== true) {
    addReason(reasons, 'SHARE_REVOKE_ABSENCE_NOT_VERIFIED');
  }
  if (receipt.operationId === 'conversation.soft-delete' && (semantic?.conversationAbsent !== true
    || semantic?.otherConversationsUnchanged !== true
    || semantic?.readbackVerified !== true || semantic?.readbackStatus !== 200)) {
    addReason(reasons, 'CONVERSATION_DELETE_ABSENCE_NOT_VERIFIED');
  }
  for (const file of binding.codeFiles) {
    if (!context.codeHashes[file]) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  return {
    ...receiptEvidence(receipt),
    provenance: 'first_party_sdk_contract',
    handlerId: receipt.handlerId,
    sourceMethod: operation?.evidence?.sourceFunctionName ?? null,
    method: operation?.method ?? null,
    pathTemplate: operation ? operationPathTemplate(operation.urlTemplate) : null,
    httpStatus: receipt.httpStatus,
    semanticReadbackVerified: semantic?.readbackVerified === true,
    restoreVerified: semantic?.restoreVerified === true,
    ...(receipt.operationId === 'conversation.soft-delete' ? {
      conversationAbsent: semantic?.conversationAbsent === true,
      otherConversationsUnchanged: semantic?.otherConversationsUnchanged === true,
    } : {}),
  };
}

function evaluateDirectAttachmentUploadRequirement(feature, requirement, operation, receipts, binding, context, reasons) {
  if (!operation) addReason(reasons, 'CONTRACT_NOT_INSTALLED');
  if (operation) {
    const sourceAsset = context.sourceAssets?.['attachment-upload-direct'];
    let sourceUrl = null;
    try { sourceUrl = new URL(operation.evidence?.sourceUrl); } catch { /* Invalid source URL stays unresolved. */ }
    if (operation.kind !== 'submit' || operation.method !== 'POST' || operation.authMode !== 'session'
      || operation.urlTemplate !== 'https://grok.com/http/upload-file-v2/direct'
      || operation.evidence?.source !== 'first_party_sdk_contract'
      || operation.evidence?.sourceFunctionName !== 'uploadFileV2'
      || operation.evidence?.requestPath !== '/http/upload-file-v2/direct'
      || !sourceAsset || !sourceUrl || sourceUrl.origin !== sourceAsset.origin || sourceUrl.pathname !== sourceAsset.path
      || operation.evidence?.sourceSha256 !== sourceAsset.sha256) addReason(reasons, 'DIRECT_UPLOAD_CAPTURED_CONTRACT_MISMATCH');
    if (!operationReadiness(operation).ready) addReason(reasons, 'CONTRACT_NOT_READY');
  }
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  const matching = receipts.filter(item => item.featureId === feature.id && item.requirementId === requirement.id
    && item.operationId === requirement.operationId && item.handlerId === requirement.handlerId);
  if (!matching.length) {
    addReason(reasons, 'POSITIVE_DIRECT_UPLOAD_RECEIPT_MISSING');
    return null;
  }
  if (matching.length !== 1) {
    addReason(reasons, 'DUPLICATE_DIRECT_UPLOAD_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false) addReason(reasons, 'RECEIPT_IS_NOT_LIVE');
  if (receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  requireSameOwnerProof(receipt, context, reasons);
  if (!operation || receipt.capturedOperationSha256 !== operationDigest(operation)) addReason(reasons, 'CAPTURED_CONTRACT_DRIFT');
  if (!SHA256.test(receipt.intentDigest ?? '')) addReason(reasons, 'DIRECT_UPLOAD_INTENT_BINDING_MISSING');
  if (!operation?.response?.statuses.includes(receipt.httpStatus)) addReason(reasons, 'LIVE_STATUS_NOT_ACCEPTED');
  if (!operation?.response?.contentTypes.some(type => type.split(';', 1)[0].toLowerCase()
    === receipt.responseMime.split(';', 1)[0].toLowerCase())) addReason(reasons, 'LIVE_MIME_NOT_ACCEPTED');
  if (!operation || receipt.responseBytes > operation.response.maxBytes) addReason(reasons, 'LIVE_RESPONSE_SIZE_INVALID');
  if (receipt.codeHashCapturedAtExecution !== true) addReason(reasons, 'HANDLER_SOURCE_BINDING_UNVERIFIED');
  if (!dispatchBindingMatches(receipt, requirement, operation, context.registry)) addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  if (!receipt.readinessAssertions?.ownerScopeBound) addReason(reasons, 'OWNER_SCOPE_ASSERTION_MISSING');
  for (const file of binding.codeFiles) {
    if (!context.codeHashes[file]) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }

  const proofPath = receipt.sourceProofPath;
  const proof = typeof proofPath === 'string' ? context.sourceEvidenceDocuments?.[proofPath] : null;
  const apiAuditPath = proof?.apiResult?.apiAuditPath;
  const apiProof = apiAuditPath ? context.sourceEvidenceDocuments?.[apiAuditPath] : proof;
  const upload = proof?.apiResult ?? proof;
  if (!proof || context.sourceEvidenceHashes?.[proofPath] !== receipt.sourceProofSha256) {
    addReason(reasons, 'SOURCE_EVIDENCE_MISSING_OR_DRIFTED');
  } else {
    if (upload.operation !== 'attachment.upload.direct' || upload.state !== 'completed'
      || upload.ownerVerified !== true || upload.browserBusinessWritesDelivered !== 0
      || upload.uniqueMarkerAbsentBeforeWrite !== true || upload.uploadRequestCount !== 1
      || upload.uploadHttpStatus !== receipt.httpStatus) addReason(reasons, 'DIRECT_UPLOAD_RUN_PROOF_MISMATCH');
    if (!apiProof || !Number.isSafeInteger(apiProof.uploadResponseBytes)) {
      // Kept explicit below so older receipts with an omitted response length cannot pass.
      addReason(reasons, 'DIRECT_UPLOAD_RESPONSE_BODY_EVIDENCE_MISSING');
    } else if (!Number.isSafeInteger(apiProof.uploadResponseBytes) || apiProof.uploadResponseBytes < 1
      || apiProof.uploadResponseBytes !== receipt.responseBytes
      || !SHA256.test(apiProof.uploadRequestDigest ?? '') || apiProof.uploadRequestDigest !== receipt.requestDigest
      || !SHA256.test(apiProof.uploadResponseDigest ?? '') || apiProof.uploadResponseDigest !== receipt.responseDigest) {
      addReason(reasons, 'DIRECT_UPLOAD_RESPONSE_BODY_EVIDENCE_MISSING');
    }
    if (!apiProof || apiProof.exactTaskAssetMatchesAfterWrite !== 1 || apiProof.metadataReadbackVerified !== true
      || apiProof.assetReadbackVerified !== true || apiProof.downloadVerified !== true
      || apiProof.download?.bytesMatch !== true || !Number.isSafeInteger(apiProof.fileBytes) || apiProof.fileBytes < 1
      || !SHA256.test(apiProof.fileSha256 ?? '') || apiProof.download?.bodyBytes !== apiProof.fileBytes
      || apiProof.download?.sha256 !== apiProof.fileSha256) addReason(reasons, 'DIRECT_UPLOAD_ASSET_READBACK_INCOMPLETE');
    if (proof.attachmentReferenceShapeVerified !== true || proof.attachmentReferencePersisted !== false
      || proof.sourceStable !== true || typeof apiProof?.cleanupRequested !== 'boolean'
      || (apiProof?.cleanupRequested === false && (apiProof.retainedForReuse !== true || apiProof.cleanupVerified !== false))
      || (apiProof?.cleanupRequested === true && apiProof.cleanupVerified !== true)) addReason(reasons, 'DIRECT_UPLOAD_RETENTION_OR_REFERENCE_UNVERIFIED');
    if (binding.codeFiles.some(file => proof.sourceBefore?.[file] !== receipt.codeSha256[file]
      || proof.sourceAfter?.[file] !== receipt.codeSha256[file])) addReason(reasons, 'DIRECT_UPLOAD_HANDLER_HASH_NOT_CAPTURED');
  }
  const semantic = receipt.semanticReadback;
  if (!semantic || semantic.uploadResponseParsed !== true || semantic.uploadReferenceVerified !== true
    || semantic.metadataReadbackVerified !== true || semantic.assetReadbackVerified !== true
    || semantic.downloadReadbackVerified !== true || semantic.downloadBytesMatched !== true
    || typeof semantic.cleanupRequested !== 'boolean'
    || semantic.cleanupRequested !== apiProof?.cleanupRequested
    || semantic.retainedForReuse !== apiProof?.retainedForReuse
    || (semantic.cleanupRequested === false && semantic.retainedForReuse !== true)) {
    addReason(reasons, 'DIRECT_UPLOAD_SEMANTIC_READBACK_INCOMPLETE');
  }
  return {
    ...receiptEvidence(receipt),
    provenance: 'first_party_sdk_direct_upload',
    sourceFunction: operation?.evidence?.sourceFunctionName ?? null,
    method: operation?.method ?? null,
    path: operation ? new URL(operation.urlTemplate).pathname : null,
    httpStatus: receipt.httpStatus,
    responseBytes: receipt.responseBytes,
    uploadResponseBodyVerified: Boolean(apiProof && Number.isSafeInteger(apiProof.uploadResponseBytes)
      && SHA256.test(apiProof.uploadResponseDigest ?? '')),
    metadataAndAssetReadbackVerified: semantic?.metadataReadbackVerified === true
      && semantic?.assetReadbackVerified === true,
    retainedForReuse: semantic?.retainedForReuse === true,
  };
}

function evaluateDirectWssRequirement(feature, requirement, binding, context, reasons) {
  const protocol = context.protocolContracts?.[requirement.operationId];
  if (!protocol) addReason(reasons, 'WSS_PROTOCOL_CONTRACT_MISSING');
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  const matching = context.wssReceipts.filter(item => item.featureId === feature.id
    && item.requirementId === requirement.id && item.operationId === requirement.operationId
    && item.handlerId === requirement.handlerId);
  if (matching.length === 0) {
    addReason(reasons, 'POSITIVE_WSS_REPLAY_RECEIPT_MISSING');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_WSS_REPLAY_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false) addReason(reasons, 'WSS_RECEIPT_IS_NOT_LIVE');
  if (receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  requireSameOwnerProof(receipt, context, reasons);
  if (protocol && receipt.protocolSha256 !== sha256Text(canonicalJson(protocol))) addReason(reasons, 'WSS_PROTOCOL_CONTRACT_DRIFT');
  if (protocol && receipt.promptSha256 !== protocol.promptSha256) addReason(reasons, 'WSS_PROMPT_CONTRACT_MISMATCH');
  if (protocol && receipt.assistantRegex !== protocol.assistantRegex) addReason(reasons, 'WSS_RESPONSE_CONTRACT_MISMATCH');
  if (protocol && (receipt.sourcePageRole !== protocol.sourcePageRole
    || JSON.stringify(receipt.browserCapture.controlTopLevelFieldNames) !== JSON.stringify(protocol.control.topLevelFieldNames)
    || JSON.stringify(receipt.browserCapture.controlEventFieldNames) !== JSON.stringify(protocol.control.eventFieldNames)
    || JSON.stringify(receipt.browserCapture.controlSessionFieldNames) !== JSON.stringify(protocol.control.sessionFieldNames)
    || JSON.stringify(receipt.browserCapture.controlXGrokFieldNames) !== JSON.stringify(protocol.control.xGrokFieldNames)
    || JSON.stringify(receipt.browserCapture.controlAbsentTargetFieldNames) !== JSON.stringify(protocol.control.absentTargetFieldNames)
    || receipt.browserCapture.controlModelType !== protocol.control.modelType
    || receipt.browserCapture.inputChunkTextPath !== protocol.business.inputChunkTextPath)) {
    addReason(reasons, 'WSS_CAPTURE_PROTOCOL_MISMATCH');
  }
  const bindingInfo = HANDLER_DISPATCH[requirement.handlerId];
  const dispatchBinding = receipt.dispatchBinding;
  if (!bindingInfo || !bindingInfo.kinds.has(requirement.expectedKind)
    || !onlyKeys(dispatchBinding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))
    || dispatchBinding.handlerId !== requirement.handlerId || dispatchBinding.operationId !== requirement.operationId
    || dispatchBinding.operationKind !== requirement.expectedKind || dispatchBinding.mode !== bindingInfo.mode) {
    addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  }
  for (const file of binding.codeFiles) {
    if (!context.codeHashes[file]) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  return {
    ...receiptEvidence(receipt),
    transport: 'direct_wss',
    websocketHandshakeStatus: receipt.directTransport.handshakeStatus,
    oneBusinessFrameSent: receipt.directTransport.businessFrameSentCount === 1,
    boundToFreshServerSession: receipt.directTransport.businessFrameBoundToServerSession === true,
    independentHistoryReadback: receipt.historyReadback.exactPromptMatched && receipt.historyReadback.assistantRegexMatched,
    sourcePageRole: receipt.sourcePageRole,
    evidencePhases: receipt.evidencePhases,
    nativeBusinessFrameCaptured: receipt.browserCapture.businessFrameCaptured,
    browserBusinessFrameDelivered: receipt.browserCapture.browserBusinessFrameDelivered,
  };
}

function evaluateSourceNativeModelSelectionRequirement(feature, requirement, binding, context, reasons) {
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  const matching = context.modelSelectionReceipts.filter(item => item.featureId === feature.id
    && item.requirementId === requirement.id && item.operationId === requirement.operationId
    && item.handlerId === requirement.handlerId);
  if (matching.length === 0) {
    addReason(reasons, 'POSITIVE_MODEL_SELECTION_PHASE_RECEIPT_MISSING');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_MODEL_SELECTION_PHASE_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false) {
    addReason(reasons, 'MODEL_SELECTION_RECEIPT_IS_NOT_LIVE');
  }
  if (receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  requireSameOwnerProof(receipt, context, reasons);

  const sourceAssets = receipt.sourceFacts.sourceAssetSha256;
  for (const [assetId, hash] of Object.entries(sourceAssets)) {
    if (context.sourceAssets?.[assetId]?.sha256 !== hash) addReason(reasons, 'FIRST_PARTY_SOURCE_ASSET_MISMATCH');
  }
  const bindingInfo = HANDLER_DISPATCH[requirement.handlerId];
  if (!bindingInfo || !bindingInfo.kinds.has(requirement.expectedKind)
    || !onlyKeys(receipt.dispatchBinding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))
    || receipt.dispatchBinding.handlerId !== requirement.handlerId
    || receipt.dispatchBinding.operationId !== requirement.operationId
    || receipt.dispatchBinding.operationKind !== requirement.expectedKind
    || receipt.dispatchBinding.mode !== bindingInfo.mode) addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  for (const file of binding.codeFiles) {
    if (!context.codeHashes[file]) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  const selection = receipt.selection;
  const capture = receipt.normalSdkCapture;
  const direct = receipt.directTransport;
  const history = receipt.historyReadback;
  const handoff = receipt.sessionHandoff;
  if (selection.selectedModeId !== selection.sourceSessionModel
    || selection.serverSessionAcknowledgementModeEchoed !== true
    || selection.serverPreferenceWriteForwarded !== false
    || capture.selectionFastVisible !== true || capture.selectionFastStored !== true
    || capture.browserSessionAckModel !== selection.selectedModeId) addReason(reasons, 'MODEL_SELECTION_SOURCE_BINDING_UNVERIFIED');
  if (direct.handshakeStatus !== 101 || direct.serverSessionAcknowledgementObserved !== true
    || direct.businessFrameSentCount !== 1 || direct.businessFrameBoundToServerSession !== true
    || direct.terminalEventObserved !== true) addReason(reasons, 'MODEL_SELECTION_DIRECT_WSS_REPLAY_INCOMPLETE');
  if (history.ownerBound !== true || history.exactPromptMatched !== true
    || history.assistantExactExpectedTextMatched !== true || history.candidateCount !== 1) {
    addReason(reasons, 'MODEL_SELECTION_SEMANTIC_HISTORY_READBACK_UNVERIFIED');
  }
  if (handoff.sameOwnerVerified !== true || handoff.providerCookieRotationVerified !== false
    || handoff.expiredProviderSessionRecoveryVerified !== false) addReason(reasons, 'SESSION_HANDOFF_PHASE_CLAIM_INVALID');
  return {
    ...receiptEvidence(receipt),
    provenance: 'source_native_model_selection_and_direct_wss',
    selectedModeId: selection.selectedModeId,
    nativeSessionModel: selection.sourceSessionModel,
    serverAcknowledgementMatchedSelectedMode: selection.serverSessionAcknowledgementModeEchoed,
    localSelectionVisibleAndStored: capture.selectionFastVisible && capture.selectionFastStored,
    preferenceWriteForwarded: selection.serverPreferenceWriteForwarded,
    catalogReadStatus: receipt.catalogRead?.status ?? null,
    catalogChoiceCount: receipt.catalogRead?.choiceCount ?? null,
    directFrameSent: direct.businessFrameSentCount === 1,
    terminalEventType: direct.terminalEventType,
    terminalMetadataCaptured: direct.terminalStatusMetadataCaptured,
    terminalResponseStatus: receipt.terminalMetadata?.responseStatus ?? null,
    terminalResponseStatusReason: receipt.terminalMetadata?.responseStatusReason ?? null,
    terminalErrorClass: receipt.terminalMetadata?.errorClass ?? null,
    terminalErrorCode: receipt.terminalMetadata?.errorCode ?? null,
    terminalStatusOrErrorValueObserved: receipt.terminalMetadata?.statusOrErrorValueObserved === true,
    semanticHistoryReadbackVerified: history.exactPromptMatched && history.assistantExactExpectedTextMatched,
    assistantTextLengthCodePoints: history.assistantTextLengthCodePoints,
    assistantTextSha256: history.assistantTextSha256,
    assistantResponseIdSha256: history.assistantResponseIdSha256,
    readbackHttpStatuses: Object.freeze({ list: history.listStatus, detail: history.detailStatus,
      responseNodes: history.responseNodesStatus, loadResponses: history.loadResponsesStatus }),
    providerBackendModelVersion: selection.providerBackendModelVersion,
    providerBackendVersionObserved: selection.providerBackendModelVersionObserved,
    sameOwnerSessionHandoffVerified: handoff.sameOwnerVerified,
    providerCookieRotationVerified: handoff.providerCookieRotationVerified,
    expiredProviderSessionRecoveryVerified: handoff.expiredProviderSessionRecoveryVerified,
    initialJournalState: receipt.journal.initialState,
    finalJournalState: receipt.journal.finalState,
  };
}

function evaluateDirectWssRegenerationRequirement(feature, requirement, binding, context, reasons) {
  const protocol = context.protocolContracts?.[requirement.operationId];
  if (!protocol || protocol.protocolKind !== 'existing_task_regeneration') addReason(reasons, 'WSS_REGENERATION_PROTOCOL_CONTRACT_MISSING');
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  const matching = context.wssRegenerationReceipts.filter(item => item.featureId === feature.id
    && item.requirementId === requirement.id && item.operationId === requirement.operationId
    && item.handlerId === requirement.handlerId);
  if (matching.length === 0) {
    addReason(reasons, 'POSITIVE_WSS_REGENERATION_RECEIPT_MISSING');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_WSS_REGENERATION_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false) addReason(reasons, 'WSS_RECEIPT_IS_NOT_LIVE');
  if (receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  if (!context.identityReceipt?.digest) {
    addReason(reasons, context.identityReceipt?.ambiguous ? 'OWNER_IDENTITY_RECEIPT_AMBIGUOUS' : 'OWNER_IDENTITY_RECEIPT_MISSING');
  } else requireSameOwnerProof(receipt, context, reasons);
  if (protocol && receipt.protocolSha256 !== sha256Text(canonicalJson(protocol))) addReason(reasons, 'WSS_PROTOCOL_CONTRACT_DRIFT');
  if (protocol && (receipt.sourcePageRole !== protocol.sourcePageRole
    || receipt.targetParentMessageSha256 !== protocol.targetParentMessageSha256
    || receipt.assistantRegex !== protocol.assistantRegex
    || JSON.stringify(receipt.nativeCapture.businessEventFieldNames) !== JSON.stringify(protocol.business.requiredEventFieldNames)
    || JSON.stringify(receipt.historyReadback.readbackOperationIds) !== JSON.stringify(protocol.history.readbackOperationIds))) {
    addReason(reasons, 'WSS_REGENERATION_CAPTURE_PROTOCOL_MISMATCH');
  }
  const dispatchBinding = receipt.dispatchBinding;
  const bindingInfo = HANDLER_DISPATCH[requirement.handlerId];
  if (!bindingInfo || !bindingInfo.kinds.has(requirement.expectedKind)
    || !onlyKeys(dispatchBinding, new Set(['handlerId', 'operationId', 'operationKind', 'mode']))
    || dispatchBinding.handlerId !== requirement.handlerId || dispatchBinding.operationId !== requirement.operationId
    || dispatchBinding.operationKind !== requirement.expectedKind || dispatchBinding.mode !== bindingInfo.mode) {
    addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  }
  for (const file of binding.codeFiles) {
    if (!context.codeHashes[file]) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  return {
    ...receiptEvidence(receipt),
    transport: 'direct_wss_existing_task_regeneration',
    websocketHandshakeStatus: receipt.directTransport.handshakeStatus,
    oneBusinessFrameSent: receipt.directTransport.businessFrameSentCount === 1,
    boundToFreshServerSession: receipt.directTransport.businessFrameBoundToServerSession === true,
    browserBusinessFrameDelivered: receipt.browserGuards.browserBusinessFramesDelivered > 0,
    sameTaskReadback: receipt.historyReadback.sameConversationTarget === true,
    newAssistantLineageVerified: receipt.historyReadback.newAssistantParentMatched === true,
    userResponseCountUnchanged: receipt.historyReadback.userResponseCountUnchanged === true,
    positiveAssistantPatternMatched: receipt.historyReadback.newAssistantPatternMatched === true,
    verifiedNoBusinessRecoveryUsed: receipt.journal.verifiedNoBusinessRecoveryUsed === true,
  };
}

function evaluateFirstPartyRequirement(feature, requirement, operation, receipts, binding, context, reasons) {
  if (!operation) addReason(reasons, 'CONTRACT_NOT_INSTALLED');
  if (operation) {
    if (operation.kind !== requirement.expectedKind) addReason(reasons, 'CONTRACT_KIND_MISMATCH');
    if (operation.authMode !== requirement.expectedAuthMode) addReason(reasons, 'CONTRACT_AUTH_MODE_MISMATCH');
    if (operation.evidence?.source !== 'first_party_bundle_contract') addReason(reasons, 'FIRST_PARTY_SOURCE_CONTRACT_MISSING');
    if (!operationReadiness(operation).ready) addReason(reasons, 'CONTRACT_NOT_READY');
  }
  if (!context.handlers[requirement.handlerId]) addReason(reasons, 'HANDLER_NOT_INSTALLED');
  const matching = receipts.filter(item => item.featureId === feature.id && item.requirementId === requirement.id
    && item.operationId === requirement.operationId && item.handlerId === requirement.handlerId);
  if (matching.length === 0) {
    addReason(reasons, 'POSITIVE_LIVE_RECEIPT_MISSING');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_LIVE_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (receipt.liveReplay !== true || receipt.liveReplayRecorded !== true || receipt.mocked !== false) addReason(reasons, 'RECEIPT_IS_NOT_LIVE');
  if (receipt.ownerVerified !== true || receipt.sameAuthenticatedOwner !== true) addReason(reasons, 'ACCOUNT_OWNER_NOT_VERIFIED');
  requireSameOwnerProof(receipt, context, reasons);
  const sourceProofPath = operation?.evidence?.directReplayReceipt;
  const sourceProof = context.sourceEvidenceDocuments?.[sourceProofPath];
  if (receipt.sourceProofPath !== sourceProofPath || !sourceProof
    || context.sourceEvidenceHashes?.[sourceProofPath] !== receipt.sourceProofSha256) {
    addReason(reasons, 'SOURCE_EVIDENCE_MISSING_OR_DRIFTED');
  }
  if (operation && receipt.method !== operation.method) addReason(reasons, 'FIRST_PARTY_METHOD_MISMATCH');
  if (operation && receipt.pathTemplate !== operationPathTemplate(operation.urlTemplate)) addReason(reasons, 'FIRST_PARTY_PATH_MISMATCH');
  if (operation && (receipt.sourceContractSha256 !== operation.evidence?.sourceSha256
    || receipt.capturedOperationSha256 !== operationDigest(operation))) addReason(reasons, 'CAPTURED_CONTRACT_DRIFT');
  if (operation) {
    const sourceAsset = context.sourceAssets?.[requirement.candidate.sourceAsset];
    let sourceUrl = null;
    try { sourceUrl = new URL(operation.evidence?.sourceUrl); } catch { /* Invalid source URL stays unresolved. */ }
    if (!sourceAsset || !sourceUrl || sourceUrl.origin !== sourceAsset.origin || sourceUrl.pathname !== sourceAsset.path
      || operation.evidence?.sourceSha256 !== sourceAsset.sha256) addReason(reasons, 'FIRST_PARTY_SOURCE_ASSET_MISMATCH');
  }
  if (!workspaceProofMatchesReceipt(receipt, sourceProof)) addReason(reasons, 'SOURCE_EVIDENCE_RECEIPT_MISMATCH');
  if (operation) {
    if (receipt.capturedOperationSha256 !== operationDigest(operation)) addReason(reasons, 'CAPTURED_CONTRACT_DRIFT');
    if (!operation.response.statuses.includes(receipt.httpStatus)) addReason(reasons, 'LIVE_STATUS_NOT_ACCEPTED');
    if (receipt.responseMime && !operation.response.contentTypes.some(type => type.split(';', 1)[0].toLowerCase() === receipt.responseMime.split(';', 1)[0].toLowerCase())) {
      addReason(reasons, 'LIVE_MIME_NOT_ACCEPTED');
    }
    if (receipt.responseBytes > operation.response.maxBytes) addReason(reasons, 'LIVE_RESPONSE_SIZE_INVALID');
  }
  if (operation && !dispatchBindingMatches(receipt, requirement, operation, context.registry)) {
    addReason(reasons, 'HANDLER_DISPATCH_NOT_BOUND');
  }
  for (const file of binding.codeFiles) {
    if (!context.codeHashes[file]) addReason(reasons, 'HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'HANDLER_CODE_DRIFT');
  }
  return {
    ...receiptEvidence(receipt),
    provenance: 'first_party_bundle_contract',
    sourceEvidencePath: receipt.sourceProofPath,
    sourceContractSha256: receipt.sourceContractSha256,
    handlerId: receipt.handlerId,
    method: receipt.method,
    pathTemplate: receipt.pathTemplate,
    httpStatus: receipt.httpStatus,
    semanticReadbackVerified: true,
    browserWriteCapture: receipt.transport.browserWriteCapture,
  };
}

function operationPathTemplate(urlTemplate) {
  try {
    return new URL(urlTemplate).pathname.replace(/\{\{input\.([A-Za-z][A-Za-z0-9]*)\}\}/g, '{$1}');
  } catch { return null; }
}

function workspaceProofMatchesReceipt(receipt, proof) {
  if (!record(proof) || proof.schemaVersion !== 1
    || proof.result?.status !== 'verified' || proof.result?.ownerVerified !== true
    || proof.sourceContract?.provenance !== 'first_party_bundle_contract'
    || proof.sourceContract?.sourceSha256 !== receipt.sourceContractSha256
    || proof.transport?.tlsVerified !== true || proof.transport?.trustEnv !== false
    || proof.transport?.redirectsFollowed !== false || proof.transport?.explicitRetries !== 0
    || proof.transport?.cookieValuesPersisted !== false || proof.transport?.rawBodiesPersisted !== false) return false;
  if (receipt.transport.tlsVerified !== proof.transport.tlsVerified
    || receipt.transport.trustEnv !== proof.transport.trustEnv
    || receipt.transport.redirectsFollowed !== proof.transport.redirectsFollowed
    || receipt.transport.explicitRetries !== proof.transport.explicitRetries
    || receipt.transport.cookieValuesPersisted !== proof.transport.cookieValuesPersisted
    || receipt.transport.browserWriteCapture !== proof.sourceContract?.browserWriteCapture
    || JSON.stringify(receipt.transport.cookieNames) !== JSON.stringify(proof.transport.cookieNames)) return false;
  const proofCodeHashes = {
    'src/grok-workspaces.mjs': proof.codeHashes?.workspaceClientAfterPolicyReviewSha256,
    'src/client.mjs': proof.codeHashes?.workspaceCoreClientSha256,
    'src/runtime.mjs': proof.codeHashes?.workspaceRuntimeSha256,
    'src/cli.mjs': proof.codeHashes?.workspaceCliSha256,
  };
  if (Object.entries(receipt.codeSha256).some(([file, hash]) => proofCodeHashes[file] !== hash)) return false;
  const preflight = proof.preflight;
  const mutation = Array.isArray(proof.mutations)
    ? proof.mutations.find(item => item.operationId === receipt.operationId) : null;
  if (receipt.operationId === 'workspaces.list') {
    return Boolean(preflight && receipt.httpStatus === preflight.privateListStatus
      && receipt.responseBytes === preflight.privateListResponseBytes
      && receipt.semanticReadback.complete === preflight.privateListComplete
      && receipt.semanticReadback.workspaceCount === preflight.privateWorkspaceCount);
  }
  if (receipt.operationId === 'workspaces.shared.list') {
    return Boolean(preflight && receipt.httpStatus === preflight.sharedListStatus
      && receipt.responseBytes === preflight.sharedListResponseBytes
      && receipt.semanticReadback.complete === preflight.sharedListComplete
      && receipt.semanticReadback.workspaceCount === preflight.sharedWorkspaceCount);
  }
  if (receipt.operationId === 'workspaces.read') {
    const create = proof.mutations?.find(item => item.operationId === 'workspaces.create');
    return Boolean(create && receipt.httpStatus === create.readbackStatus
      && receipt.responseBytes === create.readbackResponseBytes && receipt.responseDigest === create.readbackSha256
      && receipt.semanticReadback.readbackVerified === create.readbackVerified
      && receipt.semanticReadback.privateVerified === create.readbackPrivate
      && receipt.semanticReadback.kindMatched === create.readbackKindMatched
      && receipt.semanticReadback.nameMatched === create.readbackNameMatched);
  }
  if (!mutation || receipt.httpStatus !== mutation.responseStatus || receipt.responseBytes !== mutation.responseBytes
    || receipt.requestDigest !== mutation.requestDigest || receipt.intentDigest !== mutation.intentDigest
    || receipt.responseDigest !== mutation.responseSha256 || receipt.attemptCount !== mutation.attemptCount) return false;
  if (receipt.operationId === 'workspaces.create') {
    return Boolean(receipt.semanticReadback.readbackStatus === mutation.readbackStatus
      && receipt.semanticReadback.readbackVerified === mutation.readbackVerified
      && receipt.semanticReadback.idMatched === mutation.readbackIdMatched
      && receipt.semanticReadback.nameMatched === mutation.readbackNameMatched
      && receipt.semanticReadback.kindMatched === mutation.readbackKindMatched
      && receipt.semanticReadback.privateVerified === mutation.readbackPrivate);
  }
  if (receipt.operationId === 'workspaces.update') {
    return Boolean(receipt.semanticReadback.readbackStatus === mutation.readbackStatus
      && receipt.semanticReadback.readbackVerified === mutation.readbackVerified
      && receipt.semanticReadback.idMatched === mutation.readbackIdMatched
      && receipt.semanticReadback.renamedNameMatched === mutation.readbackRenamedNameMatched
      && receipt.semanticReadback.kindMatched === mutation.readbackKindMatched
      && receipt.semanticReadback.privateVerified === mutation.readbackPrivate);
  }
  return Boolean(receipt.semanticReadback.completeListReadback === proof.cleanup.independentPrivateListAbsenceVerified
    && receipt.semanticReadback.listStatus === proof.cleanup.finalListStatus
    && receipt.semanticReadback.targetAbsent === mutation.createdIdAbsentFromPrivateList
    && receipt.semanticReadback.baselineIdSetRestored === proof.cleanup.baselinePrivateIdSetRestored
    && receipt.semanticReadback.finalWorkspaceCount === mutation.finalPrivateWorkspaceCount
    && receipt.semanticReadback.responseSubstantive === mutation.responseJsonSubstantive);
}

function evaluateNativeAuthBootstrap(feature, receipts, context, reasons) {
  const matching = context.nativeAuthReceipts.filter(item => item.featureId === feature.id
    && item.requirementId === 'auth.native-bootstrap');
  if (matching.length === 0) {
    addReason(reasons, 'NATIVE_AUTH_BOOTSTRAP_RECEIPT_MISSING');
    return null;
  }
  if (matching.length > 1) {
    addReason(reasons, 'DUPLICATE_NATIVE_AUTH_BOOTSTRAP_RECEIPTS');
    return null;
  }
  const receipt = matching[0];
  if (context.handlers['auth.bootstrap'] !== true) addReason(reasons, 'NATIVE_SESSION_HANDOFF_NOT_INSTALLED');
  requireSameOwnerProof(receipt, context, reasons);
  for (const file of NATIVE_AUTH_CODE_FILES) {
    if (context.codeHashes[file] === undefined) addReason(reasons, 'NATIVE_SESSION_HANDLER_SOURCE_MISSING');
    else if (receipt.codeSha256[file] !== context.codeHashes[file]) addReason(reasons, 'NATIVE_SESSION_HANDLER_CODE_DRIFT');
  }
  for (const [file, hash] of Object.entries(receipt.codeSha256)) {
    if (context.codeHashes[file] !== hash) addReason(reasons, 'NATIVE_SESSION_HANDLER_CODE_DRIFT');
  }
  return {
    ...receiptEvidence(receipt),
    nativeProviderLoginRecorded: true,
    sessionHandoffRecorded: receipt.sessionHandoffVerified === true,
    directHttpPasswordLogin: false,
  };
}

export function evaluateFeatureChecklist({ checklist, registry, receipts = [], publicReplayReceipt = null, codeHashes = {}, handlers = {},
  sourceEvidenceHashes = {}, sourceEvidenceDocuments = {}, ownerProofDocuments = {} }) {
  validateFeatureChecklist(checklist);
  try { validateContractRegistry(registry); } catch { invalid(); }
  validateFeatureReceipts(receipts);
  const nativeAuthReceipts = [];
  const privateReceipts = [];
  const wssReceipts = [];
  const wssRegenerationReceipts = [];
  const modelSelectionReceipts = [];
  const firstPartyReceipts = [];
  const mediaReceipts = [];
  for (const receipt of receipts) {
    if (receipt?.evidenceClass === 'native_auth_bootstrap' || receipt?.requirementId === 'auth.native-bootstrap') {
      nativeAuthReceipts.push(validateNativeAuthReceipt(receipt));
    } else if (receipt?.evidenceClass === 'direct_wss_session_replay') {
      wssReceipts.push(validateDirectWssReceipt(receipt));
    } else if (receipt?.evidenceClass === 'direct_wss_regeneration_replay') {
      wssRegenerationReceipts.push(validateDirectWssRegenerationReceipt(receipt));
    } else if (receipt?.evidenceClass === 'source_native_model_selection_phase') {
      modelSelectionReceipts.push(validateModelSelectionPhaseReceipt(receipt));
    } else if (receipt?.evidenceClass === 'first_party_bundle_direct_replay') {
      firstPartyReceipts.push(validateFirstPartyWorkspaceReceipt(receipt));
    } else if (receipt?.evidenceClass === 'direct_media_operation_replay') {
      mediaReceipts.push(validateDirectMediaReceipt(receipt));
    } else {
      privateReceipts.push(validatePrivateReceipt(receipt));
    }
  }
  validatePublicReplayEvidence(publicReplayReceipt);
  if (!record(codeHashes) || Object.values(codeHashes).some(value => value !== null && !SHA256.test(value))
    || !record(sourceEvidenceHashes) || Object.values(sourceEvidenceHashes).some(value => value !== null && !SHA256.test(value))
    || !record(sourceEvidenceDocuments) || !record(ownerProofDocuments)
    || Object.entries(ownerProofDocuments).some(([file, proof]) => !safeOwnerProofPath(file) || !record(proof))) invalid();
  if (!record(handlers) || Object.values(handlers).some(value => typeof value !== 'boolean')) invalid();

  const identityReceipt = identityReceiptFor(checklist, registry, privateReceipts, codeHashes, handlers);
  const evaluationContext = {
    handlers, publicReplayReceipt, codeHashes, registry, identityReceipt, nativeAuthReceipts,
    sourceAssets: checklist.sourceAssets, protocolContracts: checklist.protocolContracts ?? {}, wssReceipts,
    wssRegenerationReceipts, modelSelectionReceipts, firstPartyReceipts, mediaReceipts,
    mediaContracts: checklist.mediaContracts ?? {}, sourceEvidenceHashes, sourceEvidenceDocuments, ownerProofDocuments,
  };

  const features = checklist.features.map(feature => {
    if (feature.id === 'auth.login') {
      const reasons = [];
      const evidence = evaluateNativeAuthBootstrap(feature, nativeAuthReceipts, evaluationContext, reasons);
      const ready = reasons.length === 0;
      return {
        id: feature.id,
        required: feature.required,
        applicability: feature.applicability,
        applicabilityClass: applicabilityClass(feature.applicability),
        status: ready ? 'stored_receipt_consistent' : 'incomplete',
        requirements: [{
          id: 'auth.native-bootstrap',
          operationId: 'auth.native-bootstrap',
          candidateStatus: 'native_bootstrap',
          ready,
          blockers: reasons,
          evidence,
        }],
        unverifiedHttpLoginCandidates: feature.requirements.map(item => item.id),
      };
    }
    const requirements = feature.requirements.map(requirement => {
      const reasons = [];
      const operation = registry.operations.find(item => item.id === requirement.operationId);
      const binding = checklist.handlerBindings[requirement.handlerId];
      let evidence = null;
      if (requirement.evidenceMode === 'public_direct_replay') {
        evidence = evaluatePublicRequirement(requirement, operation, binding, evaluationContext, reasons);
      } else if (requirement.evidenceMode.startsWith('direct_media_')) {
        evidence = evaluateDirectMediaRequirement(feature, requirement, binding, evaluationContext, reasons);
      } else if (requirement.evidenceMode === 'native_auth_bootstrap') {
        evidence = evaluateNativeAuthBootstrap(feature, nativeAuthReceipts, evaluationContext, reasons);
      } else if (requirement.evidenceMode === 'direct_wss_session_replay') {
        evidence = evaluateDirectWssRequirement(feature, requirement, binding, evaluationContext, reasons);
      } else if (requirement.evidenceMode === 'direct_wss_regeneration_replay') {
        evidence = evaluateDirectWssRegenerationRequirement(feature, requirement, binding, evaluationContext, reasons);
      } else if (requirement.evidenceMode === 'source_native_model_selection') {
        evidence = evaluateSourceNativeModelSelectionRequirement(feature, requirement, binding, evaluationContext, reasons);
      } else if (requirement.evidenceMode === 'first_party_sdk_direct_replay') {
        evidence = evaluateFirstPartySdkRequirement(feature, requirement, operation, privateReceipts, binding, evaluationContext, reasons);
      } else if (requirement.evidenceMode === 'first_party_bundle_direct_replay') {
        evidence = evaluateFirstPartyRequirement(feature, requirement, operation, firstPartyReceipts, binding, evaluationContext, reasons);
      } else {
        evidence = evaluateCapturedRequirement(feature, requirement, operation, privateReceipts,
          { ...binding, handlerId: requirement.handlerId }, evaluationContext, reasons);
      }
      return {
        id: requirement.id,
        operationId: requirement.operationId,
        candidateStatus: requirement.candidate.status,
        ready: reasons.length === 0,
        evidenceStatus: reasons.length === 0 ? 'stored_receipt_consistent'
          : reasons.some(reason => REVERIFICATION_BLOCKERS.has(reason)) ? 'needs_reverification' : 'incomplete',
        reverificationRequired: reasons.some(reason => REVERIFICATION_BLOCKERS.has(reason)),
        blockers: reasons,
        evidence,
      };
    });
    const complete = requirements.every(item => item.ready);
    return {
      id: feature.id,
      required: feature.required,
      applicability: feature.applicability,
      applicabilityClass: applicabilityClass(feature.applicability),
      applicabilityResolution: applicabilityClass(feature.applicability) === 'required'
        ? 'required' : complete ? 'applicable_by_recorded_operation' : 'unresolved',
      status: complete ? 'stored_receipt_consistent' : 'incomplete',
      requirements,
      ...(feature.phaseClaims ? { phaseClaims: feature.phaseClaims.map(claim => {
        const receiptAvailable = modelSelectionReceipts.some(item => item.evidencePath === claim.receiptPath
          && item.ownerScopeSha256 === claim.ownerScopeSha256);
        return { id: claim.id, status: claim.status === 'verified_phase_claim' && !receiptAvailable
          ? 'phase_claim_receipt_unresolved' : claim.status, receiptAvailable };
      }) } : {}),
      ...(feature.unverifiedAlternates ? { unverifiedAlternates: feature.unverifiedAlternates.map(item => ({
        id: item.id,
        operationId: item.operationId,
        status: 'unverified_alternate',
        candidateStatus: item.candidate.status,
      })) } : {}),
      ...(feature.unverifiedAlternates ? {
        unverifiedAlternates: feature.unverifiedAlternates.map(item => ({
          id: item.id,
          operationId: item.operationId,
          status: 'unverified_alternate',
          candidateStatus: item.candidate.status,
        })),
      } : {}),
    };
  });
  const requiredFeatures = features.filter(feature => feature.required);
  const requiredRequirements = requiredFeatures.flatMap(feature => feature.requirements);
  const readyCount = requiredRequirements.filter(requirement => requirement.ready).length;
  const missingFeatureCount = requiredFeatures.filter(feature => feature.status !== 'stored_receipt_consistent').length;
  const allRecordedAt = [
    ...privateReceipts.map(item => item.recordedAt),
    ...nativeAuthReceipts.map(item => item.recordedAt),
    ...wssReceipts.map(item => item.recordedAt),
    ...wssRegenerationReceipts.map(item => item.recordedAt),
    ...firstPartyReceipts.map(item => item.recordedAt),
    ...mediaReceipts.map(item => item.recordedAt),
    ...(publicReplayReceipt ? [publicReplayReceipt.checkedAt] : []),
  ].filter(isoTimestamp).sort();
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    status: missingFeatureCount === 0 ? 'stored_receipt_consistent' : 'incomplete',
    evidenceFreshness: 'recorded_receipts_only_current_network_not_checked',
    currentNetworkVerified: false,
    lastRecordedEvidenceAt: allRecordedAt.at(-1) ?? null,
    summary: {
      requiredFeatures: requiredFeatures.length,
      completeRequiredFeatures: requiredFeatures.length - missingFeatureCount,
      requiredOperations: requiredRequirements.length,
      checklistRequirements: checklist.features.filter(feature => feature.required)
        .reduce((sum, feature) => sum + feature.requirements.length, 0),
      completeRequiredOperations: readyCount,
      needsReverificationOperations: requiredFeatures.flatMap(feature => feature.requirements)
        .filter(requirement => requirement.reverificationRequired).length,
      missingRequiredFeatures: missingFeatureCount,
      optionalIncompleteFeatures: features.filter(feature => !feature.required && feature.status !== 'stored_receipt_consistent').map(feature => feature.id),
    },
    features,
  };
}
