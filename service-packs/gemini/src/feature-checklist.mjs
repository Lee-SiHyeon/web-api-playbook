import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateObservedContract } from './contract.mjs';
import { GeminiClientError } from './errors.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from './constants.mjs';
import { GeminiWebClient } from './client.mjs';
import { snapshotFeatureSourceScope, validateFeatureSourceScope } from './source-scope.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FEATURE_CHECKLIST_PATH = 'discovery/feature-checklist.json';
export const OBSERVED_CONTRACT_PATH = 'discovery/observed-contract.json';
const RECEIPT_PREFIX = 'verification/features/';
const PAIR_PREFIX = 'verification/feature-evidence/';
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9_]{0,63}$/;
const PAIR_KEYS = new Set([
  'schema', 'service', 'featureId', 'operationId', 'caseId', 'contractSha256', 'clientCodeSha256',
  'observedAt', 'executionHost', 'transport', 'evidenceClass', 'mocked', 'publicOnly',
  'requestResponsePaired', 'authenticatedOwnerVerified', 'expectedOutcomeVerified', 'identityMatchVerified',
  'credentialPropagated',
  'readbackOfOperation', 'readbackOfCaseId', 'request', 'response', 'secretsPersisted',
  'directReplay',
]);
const PAIR_REQUEST_KEYS = new Set([
  'method', 'origin', 'path', 'queryKeys', 'headerNames', 'bodyFieldNames', 'valuesPersisted', 'contentType',
  'correlationId', 'rpcId', 'preferenceFieldIds', 'preferenceArrayIndex', 'preferenceVectorLength',
  'rpcArgsShape', 'rpcCallTailShape', 'conversationIdOccurrenceCount',
  'newTitleOccurrenceCount', 'shareIdOccurrenceCount', 'conversationTitleOccurrenceCount',
]);
const PAIR_RESPONSE_KEYS = new Set(['status', 'contentType', 'bytes', 'bodySha256', 'framing']);
const LOCAL_CONTROL_KEYS = new Set([
  'schema', 'service', 'featureId', 'operationId', 'caseId', 'contractSha256', 'clientCodeSha256',
  'observedAt', 'executionHost', 'transport', 'evidenceClass', 'mocked', 'publicOnly',
  'authenticatedOwnerVerified', 'expectedOutcomeVerified', 'secretsPersisted',
  'selectionCorrelationId', 'readbackOfOperation', 'readbackOfCaseId', 'selectedChoiceId',
  'selectedModeId', 'modeCategory', 'thinkingLevel', 'preparedRequestMetadata',
  'serverPreferenceWritePerformed', 'businessRequestDispatched', 'catalogModelIdMatched',
]);
const PREPARED_MODEL_METADATA_KEYS = new Set(['modeId', 'modeCategory', 'thinkingLevel', 'isTemporaryChat']);
const DIRECT_REPLAY_KEYS = new Set([
  'browserRequestAborted', 'networkIdMatched', 'loadingFailedCount', 'browserResponseCount',
  'intentMatched', 'newTaskContextVerified', 'directDispatchCount', 'retryCount', 'requestBodyMatchesCapture',
  'responseDecoded', 'responseContractCaptured', 'nullSelectorFrameCount', 'mainCandidateChunkCount',
  'readbackPromptMatched', 'readbackAssistantMarkerMatched', 'readbackApiIdEchoed', 'readbackRouteBound',
  'capability', 'taskReadbackVerified', 'apiIdEchoed', 'routeBound', 'journalReconciled',
  'artifactVerified', 'artifactMime', 'artifactBytes', 'artifactSha256', 'artifactMagicMatched',
  'evidenceType', 'sourceRpcMatched', 'rpcArgsBoundExactlyOnce', 'ownerMatched', 'exactTaskReadbackVerified',
  'sameConversationIdReadback', 'newTitleReadback', 'promptContentPreserved',
  'targetAbsentFromOwnerHistory', 'targetAbsentFromSearch', 'taskContentBoundByPublicRead',
  'ownerListTargetRowReadback', 'targetShareRowPreflightMatched', 'targetShareRowAbsentAfterReadback',
  'ownerListBaselineRestored', 'unrelatedLinksPreserved', 'responseRpcDecoded',
]);
const RECEIPT_KEYS = new Set([
  'schema', 'service', 'featureId', 'outcome', 'checkedAt', 'evidenceClass', 'transport', 'executionHost',
  'mocked', 'publicOnly', 'authenticatedOwnerVerified', 'secretsPersisted', 'contractSha256',
  'implementationFiles', 'implementationSetSha256', 'ownerIdentityEvidence', 'operationEvidence',
  'sourceScope',
  'readbackBindings', 'readbackCases', 'sessionHandoffVerified', 'renewalOutcomeVerified',
  'applicabilityResolution', 'readinessAssertions', 'persistenceAssertions', 'authBootstrapEvidence',
]);
const IDENTITY_REF_KEYS = new Set(['path', 'sha256', 'implementationFiles', 'implementationSetSha256', 'sourceScope', 'contractSha256']);
const OPERATION_REF_KEYS = new Set(['operationId', 'caseId', 'path', 'sha256']);
const READBACK_BINDING_KEYS = new Set([
  'writeOperation', 'writeCaseId', 'readOperation', 'readCaseId', 'correlationId', 'sameOwner',
  'requestCorrelationVerified', 'stateCorrelationVerified', 'expectedStateVerified', 'bindingKind',
]);
const SAFE_READINESS_KEYS = new Set([
  'ownerIdentityBound', 'sessionHandoffVerified', 'renewalOutcomeVerified', 'readbacksBound',
  'handlerDispatchVerified', 'tokenRefreshVerified', 'cookieRotationObserved', 'challengeBypassUsed',
]);
const SAFE_PERSISTENCE_KEYS = new Set([
  'credentialsPersisted', 'cookiesPersisted', 'tokensPersisted', 'requestValuesPersisted',
  'responseValuesPersisted', 'requestBodiesPersisted', 'responseBodiesPersisted',
]);
const AUTH_BOOTSTRAP_KEYS = new Set([
  'schema', 'executionHost', 'context', 'providerAuthenticatedSessionObserved', 'nativeBrowserProfile',
  'sessionHandoffVerified', 'passwordSubmittedToProviderApi', 'challengeBypassUsed',
  'evidenceScope', 'ownerIdentityEvidenceSha256', 'observedAt', 'recordedAt',
  'secretsPersisted', 'implementationFiles', 'implementationSetSha256',
]);
const AUTH_BOOTSTRAP_IMPLEMENTATION_FILES = Object.freeze([
  'scripts/gemini-settings-update-once.py', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
  'src/http-session-bootstrap.mjs', 'src/http-transport.mjs', 'src/https-transport.mjs', 'src/session.mjs',
]);
const VERIFIED_SCRIPT_IMPLEMENTATION_PATHS = new Set([
  'scripts/run-linux-api.py',
  'scripts/run-linux-text-smoke.py',
  'scripts/gemini-settings-update-once.py',
  'scripts/verify-history.mjs',
]);
const REQUEST_ONLY_BATCH_MUTATION_RPC = Object.freeze({
  edit: 'MUAZcd',
  delete: 'GzXR5e',
  share_create: 'fuVx7',
  share_revoke: 'SgORbf',
});
const BATCH_QUERY_KEYS = Object.freeze(['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt']);

const VERIFIED_OPERATION_ADAPTERS = Object.freeze({
  identity: {
    clientMethod: 'verifyOwner',
    matchesOperation: (operation) => operation.request.method === 'GET' && operation.request.path === '/app'
      && operation.request.queryKeys.length === 0 && operation.response.contentType === 'text/html'
      && operation.response.framing === 'text',
    implementationFiles: [
      'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs', 'src/http-session-bootstrap.mjs',
      'src/http-transport.mjs', 'src/https-transport.mjs', 'src/session.mjs',
    ],
  },
  history_list: {
    clientMethod: 'listHistory',
    matchesOperation: (operation) => operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.contentType === 'application/x-www-form-urlencoded;charset=UTF-8'
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute' && operation.response.rpcId === 'MaZiqc',
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/http-session-bootstrap.mjs', 'src/http-transport.mjs', 'src/https-transport.mjs', 'src/rpc-adapters.mjs', 'src/session.mjs',
    ],
  },
  history_read: {
    clientMethod: 'readHistoryDetail',
    matchesOperation: (operation) => operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.rpcId === 'hNvQHb'
      && Array.isArray(operation.request.rpcArgsTemplate)
      && operation.request.rpcArgsTemplate.length === 8
      && operation.request.rpcArgsTemplate[0] === '{{apiConversationId}}'
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute'
      && operation.response.rpcId === 'hNvQHb',
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/history-detail.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/media-response.mjs', 'src/media.mjs', 'src/session.mjs',
    ],
  },
  history_search: {
    clientMethod: 'searchHistory',
    matchesOperation: (operation) => operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.rpcId === 'unqWSc'
      && JSON.stringify(operation.request.rpcArgsTemplate) === JSON.stringify(['{{searchQuery}}'])
      && operation.request.contentType === 'application/x-www-form-urlencoded;charset=UTF-8'
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute' && operation.response.rpcId === 'unqWSc',
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs', 'src/https-transport.mjs',
      'src/rpc-adapters.mjs', 'src/session.mjs',
    ],
  },
  model_list: {
    clientMethod: 'listModels',
    matchesOperation: (operation) => operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.rpcId === 'otAQ7b'
      && Array.isArray(operation.request.rpcArgsTemplate) && operation.request.rpcArgsTemplate.length === 0
      && operation.request.contentType === 'application/x-www-form-urlencoded;charset=UTF-8'
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute' && operation.response.rpcId === 'otAQ7b',
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs', 'src/https-transport.mjs',
      'src/rpc-adapters.mjs', 'src/session.mjs',
    ],
  },
  model_select: {
    clientMethod: 'selectModelChoice',
    localControl: true,
    effect: 'mutation',
    implementationFiles: ['src/client.mjs', 'src/cli.mjs', 'src/model-selection.mjs'],
  },
  selection_state: {
    clientMethod: 'getSelectedModelChoice',
    localControl: true,
    effect: 'read',
    implementationFiles: ['src/client.mjs', 'src/cli.mjs', 'src/model-selection.mjs'],
  },
  settings_read: {
    clientMethod: 'readPreference',
    matchesOperation: (operation) => operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.rpcId === 'ESY5D'
      && JSON.stringify(operation.request.rpcArgsTemplate) === JSON.stringify([null, '{{preferenceFieldIds}}'])
      && Array.isArray(operation.request.allowlistedPreferenceKeys)
      && operation.request.allowlistedPreferenceKeys.length === 7
      && Array.isArray(operation.request.preferenceFieldIds)
      && operation.request.preferenceFieldIds.length >= 7
      && operation.request.preferenceFieldIds.length <= 512
      && operation.request.preferenceFieldIds.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000)
      && new Set(operation.request.preferenceFieldIds).size === operation.request.preferenceFieldIds.length
      && [62, 61, 39, 25, 77, 93, 41].every((value) => operation.request.preferenceFieldIds.includes(value))
      && operation.request.contentType === 'application/x-www-form-urlencoded;charset=UTF-8'
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute' && operation.response.rpcId === 'ESY5D',
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs', 'src/https-transport.mjs',
      'src/rpc-adapters.mjs', 'src/session.mjs', 'src/settings-update.mjs',
    ],
  },
  settings_update: {
    clientMethod: 'updateSettingsPreference',
    matchesOperation: (operation) => operation.effect === 'mutation'
      && operation.retryPolicy === 'never'
      && operation.observation?.requestResponse === true
      && operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.rpcId === 'L5adhe'
      && JSON.stringify(operation.request.rpcArgsTemplate) === JSON.stringify([
        '{{preferenceValueVector}}', null, ['{{preferenceFieldId}}'],
      ])
      && operation.request.preferenceUpdateBranch === 'field3'
      && operation.request.preferenceArrayIndexOffset === -1
      && operation.request.preferenceVectorLengthEqualsFieldId === true
      && operation.request.sourceBundleSha256 === '3137eb01bfe212ddc5b7df423acd9c9633537f528a0cd13a07c25e075495e7aa'
      && JSON.stringify(operation.request.writablePreferenceKeys) === JSON.stringify(['side_nav_open_by_default'])
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute' && operation.response.rpcId === 'L5adhe'
      && operation.response.frameLengthUnit === 'utf16_code_units'
      && operation.response.frameLengthOverheadUnits === 2,
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/journal.mjs', 'src/mutation.mjs', 'src/session.mjs',
      'src/settings-update.mjs',
    ],
  },
  share_read: {
    clientMethod: 'readPublicShareLinks',
    matchesOperation: (operation) => operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.rpcId === 'OXxBcc'
      && Array.isArray(operation.request.rpcArgsTemplate)
      && operation.request.rpcArgsTemplate.length === 0
      && operation.request.contentType === 'application/x-www-form-urlencoded;charset=UTF-8'
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute'
      && operation.response.rpcId === 'OXxBcc',
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/session.mjs',
    ],
  },
  share_public_read: {
    clientMethod: 'readAnonymousSharedConversation',
    matchesOperation: (operation) => operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/batchexecute'
      && operation.request.rpcId === 'ujx1Bf'
      && JSON.stringify(operation.request.rpcArgsTemplate) === JSON.stringify([null, '{{shareId}}', [4]])
      && operation.request.contentType === 'application/x-www-form-urlencoded;charset=utf-8'
      && operation.response.contentType === 'application/json'
      && operation.response.framing === 'batchexecute'
      && operation.response.rpcId === 'ujx1Bf'
      && operation.response.selectorMode === 'rpc_id',
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/rpc-adapters.mjs', 'src/session.mjs',
    ],
  },
  edit: {
    clientMethod: 'renameConversation',
    matchesOperation: (operation) => isRequestOnlyBatchMutation('edit', operation),
    implementationFiles: [
      'scripts/gemini-lifecycle-mutation-once.mjs', 'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs',
      'src/constants.mjs', 'src/contract.mjs', 'src/conversation-lifecycle.mjs', 'src/history-detail.mjs',
      'src/http-session-bootstrap.mjs', 'src/http-transport.mjs', 'src/https-transport.mjs',
      'src/journal.mjs', 'src/lifecycle-mutation.mjs', 'src/session.mjs',
    ],
  },
  delete: {
    clientMethod: 'deleteConversation',
    matchesOperation: (operation) => isRequestOnlyBatchMutation('delete', operation),
    implementationFiles: [
      'scripts/gemini-lifecycle-mutation-once.mjs', 'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs',
      'src/constants.mjs', 'src/contract.mjs', 'src/conversation-lifecycle.mjs', 'src/history-detail.mjs',
      'src/http-session-bootstrap.mjs', 'src/http-transport.mjs', 'src/https-transport.mjs',
      'src/journal.mjs', 'src/lifecycle-mutation.mjs', 'src/session.mjs',
    ],
  },
  share_create: {
    clientMethod: 'createConversationShare',
    matchesOperation: (operation) => isRequestOnlyBatchMutation('share_create', operation),
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/history-detail.mjs', 'src/http-session-bootstrap.mjs',
      'src/http-transport.mjs', 'src/https-transport.mjs', 'src/journal.mjs', 'src/lifecycle-mutation.mjs', 'src/session.mjs',
    ],
  },
  share_revoke: {
    clientMethod: 'revokePublicShareLink',
    matchesOperation: (operation) => isRequestOnlyBatchMutation('share_revoke', operation),
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/conversation-lifecycle.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/journal.mjs', 'src/lifecycle-mutation.mjs', 'src/session.mjs',
    ],
  },
  image: {
    clientMethod: 'generateImageOnce',
    // Image and text use the same captured StreamGenerate wire contract. The
    // distinct image meaning is established by its task-owned capture receipt.
    contractOperationName: 'text',
    matchesOperation: (operation) => isRequestOnlyTextOperation('text', operation),
    artifactClientMethod: 'downloadTaskMediaAssetOnce',
    artifactCapability: 'image',
    implementationFiles: [
      'src/batch-response.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/history-detail.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/journal.mjs', 'src/media-capture.mjs', 'src/media-direct-once.mjs',
      'src/media-download.mjs', 'src/media-response.mjs', 'src/media.mjs', 'src/mutation.mjs', 'src/session.mjs',
    ],
  },
  video: {
    clientMethod: 'generateVideoOnce',
    // Video has a capability-specific captured payload on the same endpoint.
    // A separate positive same-task readback is still required by its receipt.
    contractOperationName: 'text',
    matchesOperation: (operation) => isRequestOnlyTextOperation('text', operation),
    artifactClientMethod: 'downloadTaskMediaAssetOnce',
    artifactCapability: 'video',
    implementationFiles: [
      'src/batch-response.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/history-detail.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/journal.mjs', 'src/media-capture.mjs', 'src/media-direct-once.mjs',
      'src/media-download.mjs', 'src/media-response.mjs', 'src/media.mjs', 'src/mutation.mjs', 'src/session.mjs',
    ],
  },
  text: {
    clientMethod: 'generateTextOnce',
    matchesOperation: (operation) => operation.observation?.request === true
      && operation.observation?.requestResponse === false && operation.response === undefined
      && operation.effect === 'mutation' && operation.retryPolicy === 'never'
      && operation.request.method === 'POST'
      && operation.request.path === '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
      && operation.request.contentType === 'application/x-www-form-urlencoded;charset=UTF-8'
      && JSON.stringify(operation.request.queryKeys) === JSON.stringify(['bl', 'f.sid', 'hl', '_reqid', 'rt'])
      && JSON.stringify(operation.request.bodyFieldNames) === JSON.stringify(['f.req', 'at']),
    implementationFiles: [
      'src/batch-response.mjs', 'src/cli.mjs', 'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs',
      'src/history-detail.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
      'src/https-transport.mjs', 'src/journal.mjs', 'src/media-response.mjs', 'src/media.mjs',
      'src/mutation.mjs', 'src/rpc-adapters.mjs', 'src/session.mjs', 'src/text-adapter.mjs',
      'src/text-response.mjs',
    ],
  },
});

function invalid(message) {
  throw new GeminiClientError('FEATURE_AUDIT_SCHEMA_INVALID', message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function validateBooleanAssertions(value, allowed, requireFalse = false) {
  if (value === undefined) return;
  if (!onlyKeys(value, allowed) || Object.values(value).some((item) => typeof item !== 'boolean')
      || (requireFalse && Object.values(value).some((item) => item !== false))) {
    invalid('A readiness or persistence assertion is invalid.');
  }
}

function validateAuthBootstrapEvidence(value) {
  return onlyKeys(value, AUTH_BOOTSTRAP_KEYS)
    && value.schema === 'gemini-native-auth-bootstrap-evidence-v2'
    && value.executionHost === 'linux_worker'
    && value.context === 'native_browser_session_handoff'
    && value.providerAuthenticatedSessionObserved === true
    && value.nativeBrowserProfile === true
    && value.sessionHandoffVerified === true
    && value.passwordSubmittedToProviderApi === false
    && value.challengeBypassUsed === false
    && value.evidenceScope === 'same_authenticated_owner'
    && typeof value.ownerIdentityEvidenceSha256 === 'string' && SHA256.test(value.ownerIdentityEvidenceSha256)
    && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
    && typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt))
    && value.secretsPersisted === false
    && Array.isArray(value.implementationFiles)
    && value.implementationSetSha256 && SHA256.test(value.implementationSetSha256);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function implementationSetHash(files) {
  const canonical = [...files].map(({ path: filePath, sha256: digest }) => ({ path: filePath, sha256: digest }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return sha256(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

async function readJson(filePath, { optional = false } = {}) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') return null;
    throw new GeminiClientError('FEATURE_AUDIT_READ_FAILED', 'A feature audit input could not be read.');
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes };
  } catch {
    invalid('A feature audit JSON file is malformed.');
  }
}

async function readRepoJson(root, relativePath, { optional = false } = {}) {
  if (!safeRelativePath(relativePath, '')) invalid('An evidence path is not a safe repository-relative path.');
  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, relativePath);
  let fileReal;
  try { fileReal = await realpath(candidate); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new GeminiClientError('FEATURE_AUDIT_READ_FAILED', 'A feature audit input could not be inspected.');
  }
  if (!fileReal.startsWith(rootReal + path.sep)) invalid('An evidence path resolves outside the Gemini client repository.');
  return readJson(fileReal, { optional });
}

function safeRelativePath(value, prefix, suffix = '.json') {
  if (typeof value !== 'string' || !value.startsWith(prefix) || !value.endsWith(suffix)
      || value.includes('\\') || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    return false;
  }
  return true;
}

function validateChecklist(checklist) {
  if (!isRecord(checklist) || checklist.schema !== 'gemini-feature-checklist-v1'
      || checklist.service !== SERVICE_ID || checklist.origin !== SERVICE_ORIGIN
      || checklist.policy?.publicStatusCanCompletePrivateFeature !== false
      || checklist.policy?.unknownApplicabilityBlocksStrict !== true
      || checklist.policy?.ownerIdentityFeatureId !== 'identity'
      || !ID.test(checklist.policy?.ownerIdentityOperationId)
      || !ID.test(checklist.policy?.ownerIdentityOperationCaseId)
      || !Array.isArray(checklist.features) || checklist.features.length === 0) {
    invalid('The Gemini feature checklist header or policy is invalid.');
  }
  const seen = new Set();
  for (const feature of checklist.features) {
    if (!isRecord(feature) || !ID.test(feature.id) || seen.has(feature.id)
        || typeof feature.title !== 'string' || !feature.title.trim()
        || !['required', 'conditional', 'unknown'].includes(feature.applicability)
        || !isRecord(feature.basis) || typeof feature.basis.kind !== 'string'
        || typeof feature.basis.reference !== 'string' || typeof feature.basis.note !== 'string'
        || (feature.ownerIdentityEvidenceCaseId !== undefined && !ID.test(feature.ownerIdentityEvidenceCaseId))
        || !Array.isArray(feature.contractOperations) || feature.contractOperations.length === 0
        || feature.contractOperations.some((name) => !ID.test(name))
        || new Set(feature.contractOperations).size !== feature.contractOperations.length
        || !Array.isArray(feature.requiredOperationCases) || feature.requiredOperationCases.length === 0
        || !isRecord(feature.requiredEffects)
        || feature.contractOperations.some((name) => !['read', 'mutation'].includes(feature.requiredEffects[name]))
        || Object.keys(feature.requiredEffects).some((name) => !feature.contractOperations.includes(name))
        || !Array.isArray(feature.readbackOperations)
        || feature.readbackOperations.some((name) => !feature.contractOperations.includes(name))
        || new Set(feature.readbackOperations).size !== feature.readbackOperations.length
        || feature.requiresOwnerIdentity !== true
        || !safeRelativePath(feature.receiptPath, RECEIPT_PREFIX)
        || feature.receiptPath !== `${RECEIPT_PREFIX}${feature.id}.json`) {
      invalid('A Gemini feature checklist entry is invalid.');
    }
    const caseKeys = new Set();
    for (const operationCase of feature.requiredOperationCases) {
      if (!isRecord(operationCase) || !ID.test(operationCase.operation) || !ID.test(operationCase.caseId)
          || !feature.contractOperations.includes(operationCase.operation)) {
        invalid('A required Gemini operation case is invalid.');
      }
      const key = `${operationCase.operation}\0${operationCase.caseId}`;
      if (caseKeys.has(key)) invalid('A required Gemini operation case is duplicated.');
      caseKeys.add(key);
    }
    if (feature.contractOperations.some((name) => !feature.requiredOperationCases.some((item) => item.operation === name))) {
      invalid('Every captured operation must have an explicitly required evidence case.');
    }
    if (feature.requiresReadback === true) {
      const mutationCases = feature.requiredOperationCases.filter((item) => feature.requiredEffects[item.operation] === 'mutation');
      if (!mutationCases.length || !feature.readbackOperations.length || !Array.isArray(feature.requiredReadbackBindings)) {
        invalid('A mutating feature must declare its readback operation.');
      }
      if (feature.requiredReadbackBindings.length < mutationCases.length) {
        invalid('Every mutating case must have at least one readback binding.');
      }
      const readbackKeys = new Set();
      for (const binding of feature.requiredReadbackBindings) {
        if (!isRecord(binding)
            || Object.keys(binding).some((key) => !['writeOperation', 'writeCaseId', 'readOperation', 'readCaseId'].includes(key))
            || !ID.test(binding.writeOperation) || !ID.test(binding.writeCaseId)
            || !ID.test(binding.readOperation) || !ID.test(binding.readCaseId)) {
          invalid('A required readback binding is invalid.');
        }
        const key = `${binding.writeOperation}\0${binding.writeCaseId}\0${binding.readOperation}\0${binding.readCaseId}`;
        if (readbackKeys.has(key)) invalid('A required readback binding is duplicated.');
        readbackKeys.add(key);
      }
      for (const writeCase of mutationCases) {
        if (!feature.requiredReadbackBindings.some((binding) => binding?.writeOperation === writeCase.operation
            && binding?.writeCaseId === writeCase.caseId && feature.readbackOperations.includes(binding?.readOperation)
            && ID.test(binding?.readCaseId))) {
          invalid('Every mutating operation case must declare its bound readback case.');
        }
      }
      for (const binding of feature.requiredReadbackBindings) {
        if (!caseKeys.has(`${binding?.readOperation}\0${binding?.readCaseId}`)
            || !mutationCases.some((item) => item.operation === binding?.writeOperation && item.caseId === binding?.writeCaseId)) {
          invalid('A bound readback must name declared write and read cases.');
        }
        if (!feature.readbackOperations.includes(binding.readOperation)
            || feature.requiredEffects[binding.readOperation] !== 'read') {
          invalid('A bound readback must use a captured read operation.');
        }
      }
      for (const readOperation of feature.readbackOperations) {
        for (const readCase of feature.requiredOperationCases.filter((item) => item.operation === readOperation)) {
          if (!feature.requiredReadbackBindings.some((binding) => binding.readOperation === readCase.operation
              && binding.readCaseId === readCase.caseId)) {
            invalid('Every declared readback case must be bound to a mutating case.');
          }
        }
      }
    }
    if (feature.requiresBoundReadbackCases !== undefined
        && (!Array.isArray(feature.requiresBoundReadbackCases)
          || feature.requiresBoundReadbackCases.some((id) => !ID.test(id)))) {
      invalid('A feature readback coverage list is invalid.');
    }
    seen.add(feature.id);
  }
  for (const feature of checklist.features) {
    for (const id of feature.requiresBoundReadbackCases ?? []) {
      if (!seen.has(id)) invalid('A readback coverage feature is not in the checklist.');
    }
  }
  return checklist;
}

function validateApplicabilityEvidence(value, featureId, state) {
  if (!onlyKeys(value, new Set(['schema', 'service', 'featureId', 'executionHost', 'context', 'ownerVerified', 'state', 'observedAt', 'observationSummary', 'secretsPersisted']))
      || value.schema !== 'gemini-feature-applicability-evidence-v1'
      || value.service !== SERVICE_ID || value.featureId !== featureId
      || typeof value.executionHost !== 'string' || typeof value.context !== 'string'
      || typeof value.ownerVerified !== 'boolean' || typeof value.state !== 'string'
      || typeof value.observedAt !== 'string' || typeof value.observationSummary !== 'string'
      || typeof value.secretsPersisted !== 'boolean') {
    invalid(`Applicability evidence for ${featureId} has an invalid schema.`);
  }
  return value.executionHost === 'linux_worker' && value.context === 'authenticated_ui'
    && value.ownerVerified === true && value.state === state
    && Number.isFinite(Date.parse(value.observedAt))
    && value.observationSummary.trim().length > 0
    && value.secretsPersisted === false;
}

function isCapturedRequestResponseOperation(operation) {
  return isRecord(operation) && operation.observation?.requestResponse === true
    && isRecord(operation.request) && isRecord(operation.response)
    && typeof operation.request.method === 'string' && typeof operation.request.path === 'string'
    && typeof operation.response.contentType === 'string' && typeof operation.response.framing === 'string';
}

function isRequestOnlyTextOperation(operationName, operation) {
  return operationName === 'text' && isRecord(operation)
    && operation.observation?.request === true && operation.observation?.requestResponse === false
    && operation.response === undefined && operation.effect === 'mutation' && operation.retryPolicy === 'never'
    && operation.request?.method === 'POST'
    && operation.request?.path === '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
}

function isRequestOnlyMediaOperation(operationName, operation) {
  return ['image', 'video'].includes(operationName) && isRequestOnlyTextOperation('text', operation);
}

function countTemplatePlaceholder(value, name) {
  if (typeof value === 'string') return value === `{{${name}}}` ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTemplatePlaceholder(item, name), 0);
  if (isRecord(value)) return Object.values(value).reduce((sum, item) => sum + countTemplatePlaceholder(item, name), 0);
  return 0;
}

function isRequestOnlyBatchMutation(operationName, operation) {
  const expectedRpc = REQUEST_ONLY_BATCH_MUTATION_RPC[operationName];
  const request = operation?.request;
  if (!expectedRpc || !isRecord(operation) || operation.observation?.request !== true
      || operation.observation?.requestResponse !== false || operation.effect !== 'mutation'
      || operation.retryPolicy !== 'never' || operation.response !== undefined
      || request?.method !== 'POST' || request?.origin !== SERVICE_ORIGIN
      || request?.path !== '/_/BardChatUi/data/batchexecute'
      || request?.rpcId !== expectedRpc
      || JSON.stringify(request?.queryKeys) !== JSON.stringify(BATCH_QUERY_KEYS)
      || JSON.stringify(request?.bodyFieldNames) !== JSON.stringify(['f.req', 'at'])
      || String(request?.contentType ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded'
      || !Array.isArray(request?.headerNames)
      || !request.headerNames.some((name) => String(name).toLowerCase() === 'content-type')) return false;
  if (operationName === 'delete') {
    return JSON.stringify(request.rpcArgsTemplate) === JSON.stringify(['{{conversationId}}'])
      && JSON.stringify(request.rpcCallTail) === JSON.stringify([null, 'generic']);
  }
  if (operationName === 'share_revoke') {
    return JSON.stringify(request.rpcArgsTemplate) === JSON.stringify([null, '{{shareId}}'])
      && JSON.stringify(request.rpcCallTail) === JSON.stringify([null, 'generic']);
  }
  if (operationName === 'edit') {
    return Array.isArray(request.rpcArgsTemplate)
      && countTemplatePlaceholder(request.rpcArgsTemplate, 'conversationId') === 1
      && countTemplatePlaceholder(request.rpcArgsTemplate, 'newTitle') === 1
      && JSON.stringify(request.rpcCallTail) === JSON.stringify([null, 'generic']);
  }
  return operationName === 'share_create' && JSON.stringify(request.rpcCallTail) === JSON.stringify([null, 'generic']);
}

function isSupportedOperationContract(operationName, operation) {
  return isCapturedRequestResponseOperation(operation) || isRequestOnlyTextOperation(operationName, operation)
    || isRequestOnlyMediaOperation(operationName, operation) || isRequestOnlyBatchMutation(operationName, operation);
}

function contractOperationFor(operationName, contract) {
  if (VERIFIED_OPERATION_ADAPTERS[operationName]?.localControl === true) return null;
  const sourceName = VERIFIED_OPERATION_ADAPTERS[operationName]?.contractOperationName ?? operationName;
  return contract?.operations?.[operationName] ?? contract?.operations?.[sourceName] ?? null;
}

function hasLocalControlAdapter(operationName) {
  return VERIFIED_OPERATION_ADAPTERS[operationName]?.localControl === true;
}

function operationEffectFor(operationName, contract) {
  const binding = VERIFIED_OPERATION_ADAPTERS[operationName];
  if (binding?.localControl === true) return binding.effect;
  return contractOperationFor(operationName, contract)?.effect;
}

function validatePairEvidence(pair, feature, operationName, caseId, contractOperation, contractHash, codeHash) {
  const anonymousPublicShare = operationName === 'share_public_read';
  if (!isCapturedRequestResponseOperation(contractOperation)) return false;
  if (!onlyKeys(pair, PAIR_KEYS) || !onlyKeys(pair.request, PAIR_REQUEST_KEYS) || !onlyKeys(pair.response, PAIR_RESPONSE_KEYS)
      || pair.schema !== 'gemini-feature-pair-evidence-v1'
      || pair.service !== SERVICE_ID || pair.featureId !== feature.id || pair.operationId !== operationName || pair.caseId !== caseId
      || !isRecord(pair.request) || !isRecord(pair.response)
      || !Array.isArray(pair.request.queryKeys) || !Array.isArray(pair.request.headerNames)
      || pair.request.headerNames.some((name) => typeof name !== 'string')
      || typeof pair.request.method !== 'string' || typeof pair.request.origin !== 'string'
      || typeof pair.request.path !== 'string' || typeof pair.request.valuesPersisted !== 'boolean'
      || !Number.isInteger(pair.response.status) || typeof pair.response.contentType !== 'string'
      || !Number.isSafeInteger(pair.response.bytes) || typeof pair.response.bodySha256 !== 'string'
      || typeof pair.response.framing !== 'string' || typeof pair.mocked !== 'boolean'
      || typeof pair.publicOnly !== 'boolean' || typeof pair.requestResponsePaired !== 'boolean'
      || typeof pair.authenticatedOwnerVerified !== 'boolean' || typeof pair.expectedOutcomeVerified !== 'boolean'
      || (pair.identityMatchVerified !== undefined && typeof pair.identityMatchVerified !== 'boolean')
      || (pair.credentialPropagated !== undefined && typeof pair.credentialPropagated !== 'boolean')
      || typeof pair.secretsPersisted !== 'boolean') {
    invalid(`Request/response evidence for ${feature.id}/${operationName}/${caseId} has an invalid schema.`);
  }
  if (pair.contractSha256 !== contractHash || pair.clientCodeSha256 !== codeHash
      || pair.executionHost !== 'linux_worker' || pair.transport !== 'direct_http'
      || pair.evidenceClass !== 'direct_http_live' || pair.mocked !== false || pair.publicOnly !== anonymousPublicShare
      || pair.requestResponsePaired !== true || pair.authenticatedOwnerVerified !== !anonymousPublicShare
      || pair.expectedOutcomeVerified !== true || pair.secretsPersisted !== false
      || (operationName === 'identity' && pair.credentialPropagated !== true)
      || (anonymousPublicShare && pair.credentialPropagated !== false)
      || typeof pair.observedAt !== 'string' || !Number.isFinite(Date.parse(pair.observedAt))) return false;
  const request = pair.request;
  const response = pair.response;
  const observedMime = response.contentType.split(';', 1)[0].trim().toLowerCase();
  const contractMime = contractOperation.response.contentType.split(';', 1)[0].trim().toLowerCase();
  const contractHeaderNames = new Set(contractOperation.request.headerNames.map((name) => name.toLowerCase()));
  const requestHeaderNamesMatch = request.headerNames.every((name) => contractHeaderNames.has(name.toLowerCase()));
  if (request.method !== contractOperation.request.method
      || request.origin !== contractOperation.request.origin || request.path !== contractOperation.request.path
      || JSON.stringify(request.queryKeys) !== JSON.stringify(contractOperation.request.queryKeys)
      || !requestHeaderNamesMatch
      || (contractOperation.request.contentType ?? null) !== (request.contentType ?? null)
      || request.valuesPersisted !== false
      || (anonymousPublicShare && request.headerNames.some((name) => ['cookie', 'authorization', 'proxy-authorization'].includes(name.toLowerCase())))
      || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
      || observedMime !== contractMime
      || !Number.isSafeInteger(response.bytes) || response.bytes < 1
      || typeof response.bodySha256 !== 'string' || !SHA256.test(response.bodySha256)
      || response.framing !== contractOperation.response.framing) return false;
  if (operationName === 'settings_read'
      && (request.rpcId !== 'ESY5D' || JSON.stringify(request.preferenceFieldIds) !== JSON.stringify([41]))) return false;
  if (operationName === 'settings_update'
      && (request.rpcId !== 'L5adhe' || JSON.stringify(request.preferenceFieldIds) !== JSON.stringify([41])
        || request.preferenceArrayIndex !== 40 || request.preferenceVectorLength !== 41)) return false;
  if (operationName === 'model_list' && request.rpcId !== 'otAQ7b') return false;
  return true;
}

function validateDirectReplayEvidence(pair, feature, operationName, caseId, operation, contractHash, codeHash) {
  if (isRequestOnlyBatchMutation(operationName, operation)) {
    return validateRequestOnlyBatchMutationEvidence(pair, feature, operationName, caseId, operation, contractHash, codeHash);
  }
  const mediaOperation = isRequestOnlyMediaOperation(operationName, operation);
  if (!isRequestOnlyTextOperation(operationName, operation) && !mediaOperation) return false;
  if (!onlyKeys(pair, PAIR_KEYS) || !onlyKeys(pair.request, PAIR_REQUEST_KEYS)
      || !onlyKeys(pair.response, PAIR_RESPONSE_KEYS) || !onlyKeys(pair.directReplay, DIRECT_REPLAY_KEYS)
      || pair.schema !== 'gemini-feature-pair-evidence-v1'
      || pair.service !== SERVICE_ID || pair.featureId !== feature.id
      || pair.operationId !== operationName || pair.caseId !== caseId
      || pair.contractSha256 !== contractHash || pair.clientCodeSha256 !== codeHash
      || pair.executionHost !== 'linux_worker' || pair.transport !== 'direct_http'
      || pair.evidenceClass !== 'direct_http_live' || pair.mocked !== false || pair.publicOnly !== false
      || pair.requestResponsePaired !== false || pair.authenticatedOwnerVerified !== true
      || pair.expectedOutcomeVerified !== true || pair.secretsPersisted !== false
      || typeof pair.observedAt !== 'string' || !Number.isFinite(Date.parse(pair.observedAt))) return false;
  const request = pair.request;
  const response = pair.response;
  const direct = pair.directReplay;
  const observedMime = response.contentType.split(';', 1)[0].trim().toLowerCase();
  const requestContentTypeMatches = mediaOperation
    ? String(request.contentType ?? '').split(';', 1)[0].trim().toLowerCase()
      === String(operation.request.contentType ?? '').split(';', 1)[0].trim().toLowerCase()
    : request.contentType === operation.request.contentType;
  const requestMatches = request.method === operation.request.method
    && request.origin === operation.request.origin
    && request.path === operation.request.path
    && JSON.stringify(request.queryKeys) === JSON.stringify(operation.request.queryKeys)
    && JSON.stringify(request.bodyFieldNames) === JSON.stringify(operation.request.bodyFieldNames)
    && JSON.stringify(request.headerNames.map((name) => name.toLowerCase()).sort())
      === JSON.stringify(operation.request.headerNames.map((name) => name.toLowerCase()).sort())
    && requestContentTypeMatches
    && request.valuesPersisted === false
    && typeof request.correlationId === 'string' && /^[A-Za-z0-9_-]{12,100}$/.test(request.correlationId)
    && response.status === 200 && observedMime === 'application/json'
    && Number.isSafeInteger(response.bytes) && response.bytes > 0
    && typeof response.bodySha256 === 'string' && SHA256.test(response.bodySha256)
    && response.framing === 'utf16_length_frames';
  if (!requestMatches) return false;
  if (mediaOperation) {
    const expectedMime = operationName === 'image' ? 'image/png' : 'video/mp4';
    return direct.capability === operationName
      && direct.browserRequestAborted === true
      && direct.intentMatched === true
      && direct.directDispatchCount === 1
      && direct.retryCount === 0
      && direct.taskReadbackVerified === true
      && direct.apiIdEchoed === true
      && direct.routeBound === true
      && direct.journalReconciled === true
      && direct.artifactVerified === true
      && direct.artifactMime === expectedMime
      && Number.isSafeInteger(direct.artifactBytes) && direct.artifactBytes > 0
      && typeof direct.artifactSha256 === 'string' && SHA256.test(direct.artifactSha256)
      && direct.artifactMagicMatched === true;
  }
  return direct.browserRequestAborted === true
    && direct.networkIdMatched === true
    && direct.loadingFailedCount === 1
    && direct.browserResponseCount === 0
    && direct.intentMatched === true
    && direct.newTaskContextVerified === true
    && direct.directDispatchCount === 1
    && direct.retryCount === 0
    && direct.requestBodyMatchesCapture === true
    && direct.responseDecoded === true
    && direct.responseContractCaptured === false
    && Number.isSafeInteger(direct.nullSelectorFrameCount) && direct.nullSelectorFrameCount > 0
    && Number.isSafeInteger(direct.mainCandidateChunkCount) && direct.mainCandidateChunkCount > 0
    && direct.readbackPromptMatched === true
    && direct.readbackAssistantMarkerMatched === true
    && direct.readbackApiIdEchoed === true
    && direct.readbackRouteBound === true;
}

function capturedJsonShape(value, depth = 0) {
  if (depth > 16) return 'depth_limit';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (Array.isArray(value)) return {
    type: 'array', length: value.length,
    items: value.slice(0, 16).map((item) => capturedJsonShape(item, depth + 1)),
  };
  if (isRecord(value)) return { type: 'object', fieldCount: Object.keys(value).length };
  return 'unsupported';
}

function validCapturedArgsShape(value, depth = 0) {
  if (depth > 16) return false;
  if (value === 'null' || value === 'boolean' || value === 'number') return true;
  if (!isRecord(value) || !Number.isSafeInteger(value.length) || value.length < 0 || value.length > 200) return false;
  if (value.type === 'array') return Array.isArray(value.items) && value.items.length === Math.min(value.length, 16)
    && value.items.every((item) => validCapturedArgsShape(item, depth + 1));
  if (value.type === 'string') return Number.isSafeInteger(value.length) && value.length >= 0 && value.length <= 100_000;
  if (value.type === 'object') return Number.isSafeInteger(value.fieldCount) && value.fieldCount >= 0 && value.fieldCount <= 200;
  return false;
}

export function validateRequestOnlyBatchMutationEvidence(pair, feature, operationName, caseId, operation, contractHash, codeHash) {
  if (!onlyKeys(pair, PAIR_KEYS) || !onlyKeys(pair.request, PAIR_REQUEST_KEYS)
      || !onlyKeys(pair.response, PAIR_RESPONSE_KEYS) || !onlyKeys(pair.directReplay, DIRECT_REPLAY_KEYS)
      || pair.schema !== 'gemini-feature-pair-evidence-v1'
      || pair.service !== SERVICE_ID || pair.featureId !== feature.id
      || pair.operationId !== operationName || pair.caseId !== caseId
      || pair.contractSha256 !== contractHash || pair.clientCodeSha256 !== codeHash
      || pair.executionHost !== 'linux_worker' || pair.transport !== 'direct_http'
      || pair.evidenceClass !== 'direct_http_live' || pair.mocked !== false || pair.publicOnly !== false
      || pair.requestResponsePaired !== false || pair.authenticatedOwnerVerified !== true
      || pair.expectedOutcomeVerified !== true || pair.secretsPersisted !== false
      || typeof pair.observedAt !== 'string' || !Number.isFinite(Date.parse(pair.observedAt))) return false;
  const request = pair.request;
  const response = pair.response;
  const direct = pair.directReplay;
  const contractRequest = operation.request;
  const headers = [...request.headerNames].map((name) => String(name).toLowerCase()).sort();
  const contractHeaders = [...contractRequest.headerNames].map((name) => String(name).toLowerCase()).sort();
  const normalizedContentType = String(request.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  const requestMatches = request.method === 'POST'
    && request.method === contractRequest.method
    && request.origin === contractRequest.origin
    && request.path === contractRequest.path
    && JSON.stringify(request.queryKeys) === JSON.stringify(contractRequest.queryKeys)
    && JSON.stringify(request.bodyFieldNames) === JSON.stringify(contractRequest.bodyFieldNames)
    && JSON.stringify(headers) === JSON.stringify(contractHeaders)
    && normalizedContentType === 'application/x-www-form-urlencoded'
    && request.valuesPersisted === false
    && request.rpcId === contractRequest.rpcId
    && validCapturedArgsShape(request.rpcArgsShape)
    && JSON.stringify(request.rpcCallTailShape) === JSON.stringify(capturedJsonShape(contractRequest.rpcCallTail));
  const observedMime = String(response.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  const responseMatches = response.status === 200 && observedMime === 'application/json'
    && Number.isSafeInteger(response.bytes) && response.bytes > 0
    && typeof response.bodySha256 === 'string' && SHA256.test(response.bodySha256)
    && response.framing === 'batchexecute';
  const commonDirect = direct.evidenceType === 'request_only_batchexecute_mutation'
    && direct.sourceRpcMatched === true && direct.rpcArgsBoundExactlyOnce === true
    && direct.browserRequestAborted === true && direct.browserResponseCount === 0
    && direct.directDispatchCount === 1 && direct.retryCount === 0
    && direct.requestBodyMatchesCapture === true
    && typeof direct.responseRpcDecoded === 'boolean' && direct.responseContractCaptured === false
    && direct.ownerMatched === true && direct.exactTaskReadbackVerified === true
    && direct.journalReconciled === true;
  if (!requestMatches || !responseMatches || !commonDirect
      || typeof request.correlationId !== 'string' || !SHA256.test(request.correlationId)) return false;
  if (operationName === 'edit') {
    return request.conversationIdOccurrenceCount === 1 && request.newTitleOccurrenceCount === 1
      && direct.sameConversationIdReadback === true && direct.newTitleReadback === true
      && direct.promptContentPreserved === true;
  }
  if (operationName === 'delete') {
    return request.conversationIdOccurrenceCount === 1
      && direct.targetAbsentFromOwnerHistory === true && direct.targetAbsentFromSearch === true;
  }
  if (operationName === 'share_create') {
    return request.conversationIdOccurrenceCount === 1
      && direct.taskContentBoundByPublicRead === true && direct.ownerListTargetRowReadback === true;
  }
  return request.shareIdOccurrenceCount === 1
    && direct.targetShareRowPreflightMatched === true && direct.targetShareRowAbsentAfterReadback === true
    && direct.ownerListBaselineRestored === true && direct.unrelatedLinksPreserved === true;
}

export function validateLocalModelControlEvidence(value, feature, operationName, caseId, contractHash, codeHash) {
  const isSelection = operationName === 'model_select' && caseId === 'select';
  const isReadback = operationName === 'selection_state' && caseId === 'selected';
  if (feature?.id !== 'model_selection' || (!isSelection && !isReadback)) return false;
  const thinkingChoiceId = typeof value?.thinkingLevel === 'string'
    ? `thinking:${value.thinkingLevel.toLocaleLowerCase('en-US').replaceAll('_', '-')}` : null;
  if (!onlyKeys(value, LOCAL_CONTROL_KEYS)
      || value.schema !== 'gemini-feature-local-control-evidence-v1'
      || value.service !== SERVICE_ID || value.featureId !== feature.id
      || value.operationId !== operationName || value.caseId !== caseId
      || value.contractSha256 !== contractHash || value.clientCodeSha256 !== codeHash
      || value.executionHost !== 'linux_worker' || value.transport !== 'local_process'
      || value.evidenceClass !== 'local_control_live' || value.mocked !== false || value.publicOnly !== false
      || value.authenticatedOwnerVerified !== true || value.expectedOutcomeVerified !== true
      || value.secretsPersisted !== false || typeof value.observedAt !== 'string'
      || !Number.isFinite(Date.parse(value.observedAt))
      || typeof value.selectionCorrelationId !== 'string'
      || !/^[A-Za-z0-9_-]{12,100}$/.test(value.selectionCorrelationId)
      || typeof value.selectedModeId !== 'string' || !/^[0-9a-f]{16}$/.test(value.selectedModeId)
      || (value.modeCategory !== null && ![
        'MODE_CATEGORY_UNSPECIFIED', 'MODE_CATEGORY_FAST', 'MODE_CATEGORY_THINKING', 'MODE_CATEGORY_PRO',
        'MODE_CATEGORY_AUTO', 'MODE_CATEGORY_FAST_DYNAMIC_THINKING', 'MODE_CATEGORY_FLASH_LITE',
        'MODE_CATEGORY_FLASH_PLUS', 'MODE_CATEGORY_ULTRA',
      ].includes(value.modeCategory))
      || !['THINKING_LEVEL_STANDARD', 'THINKING_LEVEL_EXTENDED', 'THINKING_LEVEL_DEEP_THINK', 'THINKING_LEVEL_MEDIUM'].includes(value.thinkingLevel)
      || ![`model:${value.selectedModeId}`, thinkingChoiceId].includes(value.selectedChoiceId)
      || value.serverPreferenceWritePerformed !== false || value.businessRequestDispatched !== false
      || value.catalogModelIdMatched !== true || !isRecord(value.preparedRequestMetadata)) return false;
  if (isSelection) {
    if (value.readbackOfOperation !== undefined || value.readbackOfCaseId !== undefined) return false;
  } else if (value.readbackOfOperation !== 'model_select' || value.readbackOfCaseId !== 'select') {
    return false;
  }
  const metadata = value.preparedRequestMetadata;
  if (!onlyKeys(metadata, PREPARED_MODEL_METADATA_KEYS)
      || metadata.modeId !== value.selectedModeId
      || metadata.thinkingLevel !== value.thinkingLevel
      || typeof metadata.isTemporaryChat !== 'boolean') return false;
  return value.modeCategory === null
    ? !Object.hasOwn(metadata, 'modeCategory')
    : metadata.modeCategory === value.modeCategory;
}

function samePreparedModelMetadata(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftHasCategory = Object.hasOwn(left, 'modeCategory');
  const rightHasCategory = Object.hasOwn(right, 'modeCategory');
  return left.modeId === right.modeId && left.thinkingLevel === right.thinkingLevel
    && left.isTemporaryChat === right.isTemporaryChat && leftHasCategory === rightHasCategory
    && (!leftHasCategory || left.modeCategory === right.modeCategory);
}

export function matchesLocalModelSelectionReadback(writePair, readPair, binding) {
  return isRecord(writePair) && isRecord(readPair) && isRecord(binding)
    && binding.bindingKind === 'local_control_state'
    && typeof binding.correlationId === 'string'
    && writePair.selectionCorrelationId === binding.correlationId
    && readPair.selectionCorrelationId === binding.correlationId
    && readPair.readbackOfOperation === binding.writeOperation
    && readPair.readbackOfCaseId === binding.writeCaseId
    && writePair.selectedModeId === readPair.selectedModeId
    && writePair.modeCategory === readPair.modeCategory
    && writePair.thinkingLevel === readPair.thinkingLevel
    && writePair.selectedChoiceId === readPair.selectedChoiceId
    && samePreparedModelMetadata(writePair.preparedRequestMetadata, readPair.preparedRequestMetadata);
}

function validateReceiptHeader(receipt, feature) {
  if (!onlyKeys(receipt, RECEIPT_KEYS) || receipt.schema !== 'gemini-feature-live-receipt-v1'
      || receipt.service !== SERVICE_ID || receipt.featureId !== feature.id
      || receipt.outcome !== 'verified' || receipt.evidenceClass !== 'direct_http_live'
      || receipt.transport !== 'direct_http' || receipt.executionHost !== 'linux_worker'
      || receipt.mocked !== false || receipt.publicOnly !== false || receipt.authenticatedOwnerVerified !== true
      || receipt.secretsPersisted !== false || typeof receipt.checkedAt !== 'string' || !Number.isFinite(Date.parse(receipt.checkedAt))
      || typeof receipt.contractSha256 !== 'string' || !SHA256.test(receipt.contractSha256)
      || typeof receipt.implementationSetSha256 !== 'string' || !SHA256.test(receipt.implementationSetSha256)
      || !Array.isArray(receipt.implementationFiles) || receipt.implementationFiles.length === 0
      || !Array.isArray(receipt.operationEvidence) || !onlyKeys(receipt.ownerIdentityEvidence, IDENTITY_REF_KEYS)) return false;
  if (receipt.operationEvidence.some((item) => !onlyKeys(item, OPERATION_REF_KEYS))) return false;
  if (receipt.readbackBindings !== undefined
      && (!Array.isArray(receipt.readbackBindings) || receipt.readbackBindings.some((item) => !onlyKeys(item, READBACK_BINDING_KEYS)))) return false;
  if (receipt.readbackCases !== undefined) {
    const allowed = new Set([
      'featureId', 'writeOperation', 'writeCaseId', 'readOperation', 'readCaseId', 'correlationId',
      'sameOwner', 'requestCorrelationVerified', 'stateCorrelationVerified', 'expectedStateVerified',
      'bindingKind', 'boundToSameWrite',
    ]);
    if (!Array.isArray(receipt.readbackCases) || receipt.readbackCases.some((item) => !onlyKeys(item, allowed))) return false;
  }
  validateBooleanAssertions(receipt.readinessAssertions, SAFE_READINESS_KEYS);
  validateBooleanAssertions(receipt.persistenceAssertions, SAFE_PERSISTENCE_KEYS, true);
  return true;
}

function validSourceScopeShape(scope, featureId, operationNames) {
  if (!isRecord(scope) || !onlyKeys(scope, new Set([
    'schema', 'featureId', 'operationNames', 'authOperation', 'contractScopeSha256',
    'implementationUnits', 'implementationScopeSha256',
  ])) || scope.schema !== 'gemini-feature-source-scope-v1' || scope.featureId !== featureId
      || scope.authOperation !== 'identity'
      || !Array.isArray(scope.operationNames)
      || JSON.stringify([...scope.operationNames].sort()) !== JSON.stringify([...new Set(operationNames)].sort())
      || !SHA256.test(scope.contractScopeSha256 ?? '')
      || !SHA256.test(scope.implementationScopeSha256 ?? '')
      || !Array.isArray(scope.implementationUnits) || scope.implementationUnits.length === 0) return false;
  const seen = new Set();
  for (const unit of scope.implementationUnits) {
    if (!onlyKeys(unit, new Set(['path', 'sha256'])) || typeof unit.path !== 'string'
        || !/^(?:src|scripts)\/[a-zA-Z0-9._/-]+#[A-Za-z0-9_]+$/.test(unit.path)
        || unit.path.includes('..') || !SHA256.test(unit.sha256 ?? '') || seen.has(unit.path)) return false;
    seen.add(unit.path);
  }
  return true;
}

export function validateReadbackBindings(receipt, feature) {
  if (!feature.requiresReadback) return !receipt.readbackBindings || Array.isArray(receipt.readbackBindings);
  if (!Array.isArray(receipt.readbackBindings)
      || receipt.readbackBindings.length !== feature.requiredReadbackBindings.length) return false;
  const unique = new Set();
  for (const binding of receipt.readbackBindings) {
    if (!isRecord(binding)) return false;
    const key = `${binding.writeOperation}\0${binding.writeCaseId}\0${binding.readOperation}\0${binding.readCaseId}`;
    if (unique.has(key)) return false;
    unique.add(key);
  }
  for (const required of feature.requiredReadbackBindings) {
    const binding = receipt.readbackBindings.find((item) => item?.writeOperation === required.writeOperation
      && item?.writeCaseId === required.writeCaseId && item?.readOperation === required.readOperation
      && item?.readCaseId === required.readCaseId);
    const localStateReadback = feature.id === 'model_selection' && required.readOperation === 'selection_state';
    if (!binding || binding.sameOwner !== true
        || (localStateReadback
          ? binding.bindingKind !== 'local_control_state' || binding.stateCorrelationVerified !== true
            || binding.requestCorrelationVerified !== undefined
          : binding.requestCorrelationVerified !== true || binding.stateCorrelationVerified !== undefined
            || binding.bindingKind !== undefined)
        || binding.expectedStateVerified !== true || typeof binding.correlationId !== 'string'
        || !/^[A-Za-z0-9_-]{12,100}$/.test(binding.correlationId)) return false;
  }
  return true;
}

function result(status, reasons = []) {
  return { status, reasons };
}

async function verifyPairFile(root, relativePath, feature, operationName, caseId, operation, {
  expectedSha = null, contractHash, codeHash,
} = {}) {
  const expectedPath = `${PAIR_PREFIX}${feature.id}--${operationName}--${caseId}.json`;
  if (relativePath !== expectedPath || !safeRelativePath(relativePath, PAIR_PREFIX)) return { ok: false, missing: false };
  const file = await readRepoJson(root, relativePath, { optional: true });
  if (!file) return { ok: false, missing: true };
  const pairHash = sha256(file.bytes);
  if (expectedSha && pairHash !== expectedSha) return { ok: false, drift: true };
  const pairValid = VERIFIED_OPERATION_ADAPTERS[operationName]?.localControl === true
    ? validateLocalModelControlEvidence(file.value, feature, operationName, caseId, contractHash, codeHash)
    : isCapturedRequestResponseOperation(operation)
      ? validatePairEvidence(file.value, feature, operationName, caseId, operation, contractHash, codeHash)
      : validateDirectReplayEvidence(file.value, feature, operationName, caseId, operation, contractHash, codeHash);
  return {
    ok: pairValid,
    pairHash,
    value: file.value,
  };
}

async function verifyImplementationFiles(root, files, { requiredPaths = [] } = {}) {
  if (!Array.isArray(files) || files.length === 0) return { status: 'implementation_missing' };
  const names = new Set();
  for (const item of files) {
    const allowedPath = typeof item?.path === 'string'
      && ((item.path.startsWith('src/') && item.path.endsWith('.mjs')) || VERIFIED_SCRIPT_IMPLEMENTATION_PATHS.has(item.path));
    if (!isRecord(item) || !allowedPath || item.path.includes('\\')
        || item.path.split('/').some((part) => !part || part === '.' || part === '..')
        || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) || names.has(item.path)) {
      return { status: 'live_evidence_missing' };
    }
    names.add(item.path);
    const fullPath = path.resolve(root, item.path);
    const rootReal = await realpath(root);
    let fileReal;
    try { fileReal = await realpath(fullPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: 'needs_reverification' };
      throw new GeminiClientError('FEATURE_AUDIT_READ_FAILED', 'An implementation source file could not be inspected.');
    }
    if (!fileReal.startsWith(rootReal + path.sep)) return { status: 'live_evidence_missing' };
    const source = await readFile(fileReal);
    if (sha256(source) !== item.sha256) return { status: 'needs_reverification' };
  }
  if (requiredPaths.some((filePath) => !names.has(filePath))) return { status: 'implementation_missing' };
  return { status: 'ok', hash: implementationSetHash(files) };
}

function missingOperationAdapters(operationNames) {
  return operationNames.filter((name) => {
    const binding = VERIFIED_OPERATION_ADAPTERS[name];
    return !binding || typeof GeminiWebClient.prototype[binding.clientMethod] !== 'function'
      || (binding.artifactClientMethod && typeof GeminiWebClient.prototype[binding.artifactClientMethod] !== 'function');
  });
}

function operationAdapterContractMismatches(operationNames, contract) {
  return operationNames.filter((name) => {
    const binding = VERIFIED_OPERATION_ADAPTERS[name];
    if (binding?.localControl === true) return typeof GeminiWebClient.prototype[binding.clientMethod] !== 'function';
    const operation = contractOperationFor(name, contract);
    const artifactContractMissing = binding?.artifactCapability !== undefined
      && !contract?.mediaAssetDownload?.sources?.some((source) => source.capability === binding.artifactCapability);
    return !binding || !operation || !binding.matchesOperation(operation) || artifactContractMissing;
  });
}

function operationImplementationFiles(operationNames) {
  return [...new Set(operationNames.flatMap((name) => VERIFIED_OPERATION_ADAPTERS[name]?.implementationFiles ?? []))];
}

function hasPositiveProtocolDecoderTextProof(receipt) {
  const browser = receipt?.browserCapture;
  const direct = receipt?.directDispatch;
  const readback = receipt?.readback;
  const journal = receipt?.mutationJournal;
  const persistence = receipt?.persistence;
  return receipt?.schema === 'gemini-live-one-shot-receipt-v1' && receipt.service === SERVICE_ID
    && receipt.operation === 'text' && receipt.outcome === 'verified'
    && receipt.ownerMatched === true && receipt.anonymousOwnerAbsent === true
    && browser?.requestObserved === true && browser?.requestAbortAck === true
    && browser?.networkIdMatched === true && browser?.loadingFailedCount === 1
    && browser?.responseCount === 0 && browser?.exactPromptMatch === true
    && direct?.count === 1 && direct?.retryCount === 0 && direct?.httpStatus === 200
    && direct?.responseDecoded === true && typeof direct.responseSha256 === 'string' && SHA256.test(direct.responseSha256)
    && readback?.directDetailStatus === 200 && readback?.promptMatched === true
    && readback?.assistantMarkerMatched === true && readback?.apiIdEchoedInDetail === true
    && readback?.apiRouteBindingVerified === true && readback?.ownerMatched === true
    && journal?.dispatchCount === 1 && journal?.state === 'reconciled'
    && persistence?.credentialsPersisted === false && persistence?.cookiesPersisted === false
    && persistence?.tokensPersisted === false && persistence?.requestBodyPersisted === false
    && persistence?.responseBodyPersisted === false && persistence?.rawPromptPersisted === false;
}

function mediaRunRequestMatches(operation, textOperation, capability) {
  if (!isRecord(operation) || !isRecord(textOperation?.request)
      || !Array.isArray(operation.queryKeys) || !Array.isArray(operation.headerNames)
      || !Array.isArray(operation.bodyFieldNames) || !Array.isArray(textOperation.request.queryKeys)
      || !Array.isArray(textOperation.request.headerNames) || !Array.isArray(textOperation.request.bodyFieldNames)) return false;
  return (operation?.capability === undefined || operation.capability === capability)
    && operation.method === textOperation.request.method
    && operation.origin === textOperation.request.origin && operation.pathFamily === textOperation.request.path
    && JSON.stringify(operation.queryKeys) === JSON.stringify(textOperation.request.queryKeys)
    && JSON.stringify(operation.bodyFieldNames) === JSON.stringify(textOperation.request.bodyFieldNames)
    && JSON.stringify(operation.headerNames.map((name) => name.toLowerCase()).sort())
      === JSON.stringify(textOperation.request.headerNames.map((name) => name.toLowerCase()).sort())
    && operation.contentType?.split(';', 1)[0].toLowerCase()
      === textOperation.request.contentType?.split(';', 1)[0].toLowerCase();
}

async function inspectHistoricalProof(root, featureId, contract) {
  if (featureId === 'model_selection') {
    const file = await readRepoJson(root, 'discovery/gemini-model-selection-live-2026-10-06.json', { optional: true });
    const evidence = file?.value;
    const catalog = evidence?.catalogRead;
    const uiChoices = evidence?.uiChoices;
    const trials = evidence?.selectionTrials;
    const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
    const normalizedIds = Array.isArray(uiChoices) ? uiChoices.filter((choice) => {
      const modelId = choice?.dataModeIdMatchesCatalogModelId;
      return choice?.choiceKind === 'model' && typeof choice.label === 'string'
        && typeof modelId === 'string' && /^[0-9a-f]{16}$/.test(modelId)
        && catalogModels.some((model) => model?.modelId === modelId && model?.displayName === choice.label);
    }) : [];
    const thinking = Array.isArray(uiChoices) ? uiChoices.filter((choice) => choice?.choiceKind === 'thinking_level'
      && choice.modelId === null && choice.thinkingLevel === 'THINKING_LEVEL_EXTENDED') : [];
    const positive = evidence?.schema === 'gemini-model-selection-live-evidence-v1' && evidence.service === SERVICE_ID
      && evidence.ownerMatched === true && catalog?.rpcId === 'otAQ7b' && catalog.httpStatus === 200
      && catalog.modelCount === 3 && catalogModels.length === 3 && normalizedIds.length === 3 && thinking.length === 1
      && uiChoices.length === 4 && Array.isArray(trials) && trials.length >= 2
      && trials.every((trial) => trial.restoredToBaseline === true)
      && evidence.writeAndGenerationBoundary?.modelPreferenceWriteForwarded === false
      && evidence.writeAndGenerationBoundary?.chatOrMediaRequestForwarded === false
      && evidence.writeAndGenerationBoundary?.webSocketBusinessFramesForwarded === false
      && evidence.writeAndGenerationBoundary?.businessDispatchCount === 0
      && evidence.modelSelectionControl?.localStorageModelStateRestored === true;
    if (positive) {
      return {
        status: 'needs_reverification',
        reasons: [
          'the guarded UI capture proves three catalog-backed model IDs and a separate Extended Thinking control, including a reversible local selector trial; no canonical receipt binds current client, CLI, and source hashes',
          'model_list available/selected remain catalog reads; selected state and prepared request metadata need their own code-bound selection_state readback, and qpEbW has not been decoded into per-model eligibility',
        ],
        summary: {
          evidenceClass: 'historical_guarded_local_model_selection',
          source: 'discovery/gemini-model-selection-live-2026-10-06.json',
          catalogModelCount: 3,
          catalogBackedUiModelChoiceCount: normalizedIds.length,
          separateThinkingControlCount: thinking.length,
          reversibleLocalSelectionTrials: trials.length,
          serverPreferenceWriteForwarded: false,
          perModelQuotaEligibility: 'unknown',
          modeCategoryMapping: 'unresolved_for_catalog_rows',
          implementationHashesBound: false,
          currentNetworkVerified: false,
        },
      };
    }
  }
  if (featureId === 'text_generation' || featureId === 'history') {
    const file = await readRepoJson(root, 'verification/one-shot/gemini-protocol-decoder-verification-2026-10-06.json', { optional: true });
    const positive = file && hasPositiveProtocolDecoderTextProof(file.value);
    if (positive && featureId === 'text_generation') {
      return {
        status: 'needs_reverification',
        reasons: ['a verified historical text dispatch and exact hNvQHb prompt, assistant-marker, owner, and route readback exist, but no canonical receipt binds them to the current source hashes'],
        summary: {
          evidenceClass: 'historical_direct_http_one_shot',
          source: 'verification/one-shot/gemini-protocol-decoder-verification-2026-10-06.json',
          directDispatchCount: 1,
          retries: 0,
          responseDecoded: true,
          exactTaskDetailReadback: true,
          implementationHashesBound: false,
          currentNetworkVerified: false,
        },
      };
    }
    if (positive && featureId === 'history') {
      return {
        status: 'live_evidence_missing',
        reasons: ['a task-bound hNvQHb detail readback is recorded within the text run; independent history list and search operation cases still lack canonical receipts'],
        summary: {
          evidenceClass: 'historical_text_task_readback',
          source: 'verification/one-shot/gemini-protocol-decoder-verification-2026-10-06.json',
          taskDetailReadbackBoundToText: true,
          standaloneHistoryListReceipt: false,
          historySearchReceipt: false,
          implementationHashesBound: false,
          currentNetworkVerified: false,
        },
      };
    }
  }

  if (featureId === 'image_generation') {
    const file = await readRepoJson(root, 'discovery/media-browser-capture-2026-10-06.json', { optional: true });
    const textOperation = contractOperationFor('image', contract);
    const runs = Object.values(file?.value?.directMediaRunsByIntent ?? {}).filter((run) => {
      const direct = run?.directHttp;
      const readback = run?.postDispatchReadback;
      const download = readback?.browserFreeDownload;
      return mediaRunRequestMatches(run?.capture, textOperation, 'image')
        && run.ownerMatched === true && direct?.ownerMatched === true && direct?.anonymousOwnerAbsent === true
        && direct?.browserRequestAborted === true && direct?.directDispatchCount === 1 && direct?.retryCount === 0
        && direct?.httpStatus === 200 && direct?.credentialPropagated === true
        && typeof direct?.responseSha256 === 'string' && SHA256.test(direct.responseSha256)
        && readback?.exactTaskMatchCount === 1 && readback?.detailHttpStatus === 200
        && readback?.exactPromptMatched === true && readback?.apiConversationIdEchoed === true
        && readback?.routeBound === true && readback?.journalReconciled === true
        && download?.status === 'verified' && download?.mime === 'image/png'
        && download?.mimeMagicMatched === true && download?.independentFileReadback === true
        && download?.independentDimensionReadback === true;
    });
    if (runs.length === 1) {
      return {
        status: 'needs_reverification',
        reasons: ['the image direct run, exact same-task hNvQHb readback, and browser-free PNG file verification are recorded; no canonical feature receipt binds the run to current implementation hashes'],
        summary: {
          evidenceClass: 'historical_direct_media_run',
          source: 'discovery/media-browser-capture-2026-10-06.json',
          directDispatchCount: 1,
          exactTaskReadback: true,
          artifactDownloadVerified: true,
          artifactMagicAndFileReadbackVerified: true,
          implementationHashesBound: false,
          currentNetworkVerified: false,
        },
      };
    }
  }

  if (featureId === 'video_generation') {
    const [mediaFile, apiFile, verifyFile, downloadFile] = await Promise.all([
      readRepoJson(root, 'discovery/media-browser-capture-2026-10-06.json', { optional: true }),
      readRepoJson(root, 'discovery/media-api-readback-2026-10-06.json', { optional: true }),
      readRepoJson(root, 'discovery/media-asset-verify-2026-10-06.json', { optional: true }),
      readRepoJson(root, 'discovery/media-download-direct-2026-10-06.json', { optional: true }),
    ]);
    const media = mediaFile?.value;
    const writer = media?.directMediaRuns?.video;
    const textOperation = contractOperationFor('video', contract);
    const candidate = (apiFile?.value?.directHttp?.candidates ?? []).filter((item) => item?.matchedTaskCapabilities?.includes('video')
      && item.routeBindingVerified === true && item.httpStatus === 200 && item.apiIdEchoedInDetail === true
      && item.exactTaskPromptHashMatched === true && item.exactTaskTurnLocated === true);
    const verification = verifyFile?.value;
    const videoArtifact = downloadFile?.value?.directDownload;
    const writerVerified = mediaRunRequestMatches(writer?.capture, textOperation, 'video')
      && writer?.ownerMatched === true && writer.dispatchCount === 1 && writer.httpStatus === 200
      && writer.credentialPropagated === true && writer.redirectsFollowed === false
      && writer.responseInspection?.framing === 'utf16_length_frames';
    const taskVerified = candidate.length === 1 && verification?.thisPhase?.exactVideoTaskHashMatched === true
      && verification.thisPhase.directVideoDetailHttpStatus === 200
      && verification.thisPhase.apiConversationIdEchoed === true
      && verification.thisPhase.routeBindingVerified === true;
    const artifactVerified = downloadFile?.value?.schema === 'gemini-direct-media-download-receipt-v1'
      && downloadFile.value.service === SERVICE_ID && downloadFile.value.newGenerationRequests === 0
      && downloadFile.value.newHistoryDetailRequests === 0
      && downloadFile.value.priorExactTaskBindingReceipt === 'discovery/media-api-readback-2026-10-06.json'
      && videoArtifact?.capability === 'video' && videoArtifact.status === 'verified'
      && videoArtifact.httpStatus === 200 && videoArtifact.mime === 'video/mp4'
      && videoArtifact.mimeMagicMatched === true && videoArtifact.independentFileReadback === true
      && videoArtifact.artifact?.previousArtifactHashMatched === true;
    if (writerVerified && taskVerified && artifactVerified) {
      const installedVideoSource = contract?.mediaAssetDownload?.sources?.some((source) => source.capability === 'video') === true;
      return {
        status: 'needs_reverification',
        reasons: [
          'the historical video writer, exact task-hash hNvQHb readback, and MP4 file/hash readback are recorded; the canonical feature receipt lacks current implementation hashes',
          ...(installedVideoSource ? [] : ['the installed media download contract still has no video source entry']),
        ],
        summary: {
          evidenceClass: 'historical_direct_video_run',
          sources: [
            'discovery/media-browser-capture-2026-10-06.json',
            'discovery/media-api-readback-2026-10-06.json',
            'discovery/media-asset-verify-2026-10-06.json',
            'discovery/media-download-direct-2026-10-06.json',
          ],
          directDispatchCount: 1,
          exactTaskHashReadback: true,
          artifactDownloadVerified: true,
          artifactMagicAndPriorHashReadbackVerified: true,
          currentVideoDownloadSourceInstalled: installedVideoSource,
          implementationHashesBound: false,
          currentNetworkVerified: false,
        },
      };
    }
  }
  return null;
}

async function evaluateOne({ root, feature, contract, contractHash, receipt, identityOperationId, identityOperationCaseId }) {
  if (!receipt) {
    if (feature.id === 'model_selection') {
      const historical = await inspectHistoricalProof(root, feature.id, contract);
      if (historical) return { status: historical.status, reasons: historical.reasons, historicalEvidence: historical.summary };
    }
    if (feature.applicability !== 'required') {
      return result('applicability_unresolved', ['feature receipt is absent; applicability remains unknown']);
    }
    if (!contract) return result('captured_contract_missing', ['no installed validated observed contract']);
    const missing = feature.contractOperations.filter((name) => !contractOperationFor(name, contract) && !hasLocalControlAdapter(name));
    if (missing.length) return result('captured_contract_missing', missing.map((name) => `captured operation missing: ${name}`));
    const unpaired = feature.contractOperations.filter((name) => !hasLocalControlAdapter(name)
      && !isSupportedOperationContract(name, contractOperationFor(name, contract)));
    if (unpaired.length) return result('captured_contract_missing', unpaired.map((name) => `operation request/response pair is incomplete: ${name}`));
    const noAdapter = missingOperationAdapters(feature.contractOperations);
    if (noAdapter.length) return result('implementation_missing', noAdapter.map((name) => `operation-specific API adapter is not exported: ${name}`));
    const historical = await inspectHistoricalProof(root, feature.id, contract);
    if (historical) return {
      status: historical.status,
      reasons: historical.reasons,
      historicalEvidence: historical.summary,
    };
    const adapterMismatch = operationAdapterContractMismatches(feature.contractOperations, contract);
    if (adapterMismatch.length) return result('captured_contract_missing', adapterMismatch.map((name) => `captured request/response or task-media download contract does not match its exported adapter: ${name}`));
    return result('live_evidence_missing', ['operation adapters are installed, but the feature receipt is absent']);
  }
  if (!isRecord(receipt) || receipt.schema !== 'gemini-feature-live-receipt-v1'
      || receipt.service !== SERVICE_ID || receipt.featureId !== feature.id
      || !['verified', 'applicability_only'].includes(receipt.outcome)) {
    invalid(`The receipt for ${feature.id} has an invalid schema.`);
  }

  if (feature.applicability !== 'required') {
    const resolution = receipt.applicabilityResolution;
    if (!isRecord(resolution) || !['applicable', 'not_applicable'].includes(resolution.state)
        || !isRecord(resolution.evidence) || resolution.evidence.path !== `${PAIR_PREFIX}${feature.id}--applicability.json`
        || typeof resolution.evidence.sha256 !== 'string' || !SHA256.test(resolution.evidence.sha256)) {
      return result('applicability_unresolved', ['conditional or unknown applicability has no authenticated UI evidence']);
    }
    const evidenceFile = await readRepoJson(root, resolution.evidence.path, { optional: true });
    if (!evidenceFile) return result('applicability_unresolved', ['authenticated UI applicability evidence is absent']);
    if (sha256(evidenceFile.bytes) !== resolution.evidence.sha256) {
      return result('needs_reverification', ['applicability evidence hash changed']);
    }
    if (!validateApplicabilityEvidence(evidenceFile.value, feature.id, resolution.state)) {
      return result('applicability_unresolved', ['applicability evidence is not bound to the authenticated owner UI']);
    }
    if (resolution.state === 'not_applicable') {
      if (feature.applicability === 'required') return result('live_evidence_missing', ['required feature cannot be skipped']);
      return result('not_applicable', ['authenticated UI evidence confirms this conditional feature is unavailable']);
    }
  }
  if (receipt.outcome !== 'verified') return result('implementation_missing', ['applicability is resolved but implementation is not verified']);
  if (!contract) return result('captured_contract_missing', ['no installed validated observed contract']);
  const absent = feature.contractOperations.filter((name) => !contractOperationFor(name, contract) && !hasLocalControlAdapter(name));
  if (absent.length) return result('captured_contract_missing', absent.map((name) => `captured operation missing: ${name}`));
  const unpaired = feature.contractOperations.filter((name) => !hasLocalControlAdapter(name)
    && !isSupportedOperationContract(name, contractOperationFor(name, contract)));
  if (unpaired.length) return result('captured_contract_missing', unpaired.map((name) => `operation request/response pair is incomplete: ${name}`));
  const noAdapter = missingOperationAdapters(feature.contractOperations);
  if (noAdapter.length) return result('implementation_missing', noAdapter.map((name) => `operation-specific API adapter is not exported: ${name}`));
  const adapterMismatch = operationAdapterContractMismatches(feature.contractOperations, contract);
  if (adapterMismatch.length) return result('captured_contract_missing', adapterMismatch.map((name) => `captured request/response contract does not match its exported adapter: ${name}`));
  for (const [name, effect] of Object.entries(feature.requiredEffects)) {
    if (operationEffectFor(name, contract) !== effect) return result('captured_contract_missing', [`operation effect does not match checklist: ${name}`]);
  }
  if (!validateReceiptHeader(receipt, feature)) return result('live_evidence_missing', ['receipt lacks positive direct-HTTP evidence bound to an authenticated owner']);
  const scopedReceipt = receipt.sourceScope !== undefined;
  let featureCodeHash;
  let pairContractHash;
  if (scopedReceipt) {
    if (!validSourceScopeShape(receipt.sourceScope, feature.id, feature.contractOperations)) {
      return result('live_evidence_missing', ['feature source-scope record is malformed']);
    }
    let currentScope;
    try {
      currentScope = await snapshotFeatureSourceScope({
        root, contract, featureId: feature.id, operationNames: feature.contractOperations,
      });
    } catch {
      return result('implementation_missing', ['feature operation handler closure could not be resolved']);
    }
    if (!validateFeatureSourceScope(receipt.sourceScope, currentScope)
        || receipt.implementationSetSha256 !== currentScope.implementationScopeSha256) {
      return result('needs_reverification', ['feature operation or handler closure changed after verification']);
    }
    featureCodeHash = currentScope.implementationScopeSha256;
    // The scoped contract digest below proves the current relevant operations.
    // Keep the original full contract digest on pairs as historical provenance.
    pairContractHash = receipt.contractSha256;
  } else {
    if (receipt.contractSha256 !== contractHash) return result('needs_reverification', ['installed contract hash changed after verification']);
    const files = await verifyImplementationFiles(root, receipt.implementationFiles, {
      requiredPaths: operationImplementationFiles(feature.contractOperations),
    });
    if (files.status !== 'ok') return result(files.status, ['implementation source is absent, unsafe, or differs from its verified hash']);
    if (receipt.implementationSetSha256 !== files.hash) return result('needs_reverification', ['implementation set hash differs from the verified source list']);
    featureCodeHash = files.hash;
    pairContractHash = contractHash;
  }

  const identityRef = receipt.ownerIdentityEvidence;
  const identityCaseId = feature.ownerIdentityEvidenceCaseId ?? identityOperationCaseId;
  const identityEvidencePath = `${PAIR_PREFIX}identity--${identityOperationId}--${identityCaseId}.json`;
  if (identityRef.path !== identityEvidencePath
      || typeof identityRef.sha256 !== 'string' || !SHA256.test(identityRef.sha256)
      || !Array.isArray(identityRef.implementationFiles) || !identityRef.implementationFiles.length
      || typeof identityRef.implementationSetSha256 !== 'string' || !SHA256.test(identityRef.implementationSetSha256)
      || (identityRef.contractSha256 !== undefined && !SHA256.test(identityRef.contractSha256))) {
    return result('live_evidence_missing', ['receipt does not bind the authenticated owner identity read']);
  }
  let identityCodeHash;
  let identityPairContractHash;
  if (identityRef.sourceScope !== undefined) {
    if (!validSourceScopeShape(identityRef.sourceScope, 'identity', [identityOperationId])) {
      return result('live_evidence_missing', ['owner identity source-scope record is malformed']);
    }
    let currentIdentityScope;
    try {
      currentIdentityScope = await snapshotFeatureSourceScope({
        root, contract, featureId: 'identity', operationNames: [identityOperationId],
      });
    } catch {
      return result('implementation_missing', ['owner identity handler closure could not be resolved']);
    }
    if (!validateFeatureSourceScope(identityRef.sourceScope, currentIdentityScope)
        || identityRef.implementationSetSha256 !== currentIdentityScope.implementationScopeSha256
        || identityRef.contractSha256 !== pairContractHash) {
      return result('needs_reverification', ['owner identity operation or handler closure changed after verification']);
    }
    identityCodeHash = currentIdentityScope.implementationScopeSha256;
    identityPairContractHash = identityRef.contractSha256 ?? pairContractHash;
  } else {
    const identityCode = await verifyImplementationFiles(root, identityRef.implementationFiles, {
      requiredPaths: operationImplementationFiles([identityOperationId]),
    });
    if (identityCode.status !== 'ok') return result(identityCode.status, ['owner identity implementation is absent or changed']);
    if (identityRef.implementationSetSha256 !== identityCode.hash) {
      return result('needs_reverification', ['owner identity implementation set changed']);
    }
    identityCodeHash = identityCode.hash;
    identityPairContractHash = contractHash;
  }
  const identityFeature = { id: 'identity' };
  const identityOperation = contract.operations[identityOperationId];
  if (!identityOperation || !isCapturedRequestResponseOperation(identityOperation)) {
    return result('captured_contract_missing', ['captured identity request/response pair missing']);
  }
  const identityPair = await verifyPairFile(root, identityRef.path, identityFeature, identityOperationId, identityCaseId, identityOperation, {
    expectedSha: identityRef.sha256, contractHash: identityPairContractHash, codeHash: identityCodeHash,
  });
  if (!identityPair.ok) return result(identityPair.drift ? 'needs_reverification' : 'live_evidence_missing', ['authenticated identity evidence is missing or changed']);
  if (identityPair.value.identityMatchVerified !== true) return result('live_evidence_missing', ['owner identity was not verified by the captured response']);

  const receiptEvidence = new Map();
  for (const item of receipt.operationEvidence) {
    if (!isRecord(item) || typeof item.operationId !== 'string' || !ID.test(item.operationId)
        || typeof item.caseId !== 'string' || !ID.test(item.caseId) || typeof item.path !== 'string'
        || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      return result('live_evidence_missing', ['operation evidence index is incomplete']);
    }
    const key = `${item.operationId}\0${item.caseId}`;
    if (receiptEvidence.has(key)) return result('live_evidence_missing', ['operation evidence index is ambiguous']);
    receiptEvidence.set(key, item);
  }
  const verifiedPairs = new Map();
  for (const operationCase of feature.requiredOperationCases) {
    const operationName = operationCase.operation;
    const caseId = operationCase.caseId;
    const key = `${operationName}\0${caseId}`;
    const evidenceRef = receiptEvidence.get(key);
    if (!evidenceRef) return result('live_evidence_missing', [`live request/response evidence missing: ${operationName}/${caseId}`]);
    const pair = await verifyPairFile(root, evidenceRef.path, feature, operationName, caseId, contractOperationFor(operationName, contract), {
      expectedSha: evidenceRef.sha256, contractHash: pairContractHash, codeHash: featureCodeHash,
    });
    if (pair.drift) return result('needs_reverification', [`request/response evidence changed: ${operationName}/${caseId}`]);
    if (!pair.ok) return result('live_evidence_missing', [`positive direct replay evidence missing: ${operationName}/${caseId}`]);
    verifiedPairs.set(key, pair.value);
    if (feature.id === 'identity' && operationName === identityOperationId && pair.value.identityMatchVerified !== true) {
      return result('live_evidence_missing', ['owner identity was not verified by the captured response']);
    }
  }
  if (!validateReadbackBindings(receipt, feature)) {
    return result('live_evidence_missing', ['write operation is not tied to a positive same-owner readback']);
  }
  if (feature.requiresReadback) {
    for (const binding of receipt.readbackBindings) {
      const writeKey = `${binding.writeOperation}\0${binding.writeCaseId}`;
      const readKey = `${binding.readOperation}\0${binding.readCaseId}`;
      const writePair = verifiedPairs.get(writeKey);
      const readPair = verifiedPairs.get(readKey);
      if (feature.id === 'model_selection' && binding.readOperation === 'selection_state') {
        if (!matchesLocalModelSelectionReadback(writePair, readPair, binding)) {
          return result('live_evidence_missing', ['local selected model state and prepared request metadata are not tied to the same selection']);
        }
        continue;
      }
      if (!writePair || !readPair || writePair.request?.correlationId !== binding.correlationId
          || readPair.request?.correlationId !== binding.correlationId
          || readPair.readbackOfOperation !== binding.writeOperation
          || readPair.readbackOfCaseId !== binding.writeCaseId) {
        return result('live_evidence_missing', [`readback is not correlated to the same write: ${binding.writeOperation}/${binding.writeCaseId}`]);
      }
    }
  }
  if (feature.id === 'login') {
    const bootstrap = receipt.authBootstrapEvidence;
    if (receipt.sessionHandoffVerified !== true || !validateAuthBootstrapEvidence(bootstrap)) {
      return result('live_evidence_missing', ['native browser login and session handoff evidence is missing or malformed']);
    }
    if (bootstrap.ownerIdentityEvidenceSha256 !== identityRef.sha256) {
      return result('live_evidence_missing', ['native login evidence is not bound to the authenticated HTTP identity receipt']);
    }
    const bootstrapCode = await verifyImplementationFiles(root, bootstrap.implementationFiles, {
      requiredPaths: [...AUTH_BOOTSTRAP_IMPLEMENTATION_FILES],
    });
    if (bootstrapCode.status !== 'ok') return result(bootstrapCode.status, ['native session handoff implementation is absent or changed']);
    if (bootstrap.implementationSetSha256 !== bootstrapCode.hash) {
      return result('needs_reverification', ['native session handoff implementation set changed']);
    }
  }
  if (feature.id === 'session_renewal' && receipt.renewalOutcomeVerified !== true) {
    return result('live_evidence_missing', ['session renewal and post-renewal identity check are not verified']);
  }
  return result('complete', []);
}

export async function auditGeminiFeatures({ root = REPO_ROOT } = {}) {
  const checklistFile = await readRepoJson(root, FEATURE_CHECKLIST_PATH);
  if (!checklistFile) invalid('The Gemini feature checklist is missing.');
  const checklist = validateChecklist(checklistFile.value);
  const contractFile = await readRepoJson(root, OBSERVED_CONTRACT_PATH, { optional: true });
  let contract = null;
  let contractHash = null;
  if (contractFile) {
    try {
      contract = validateObservedContract(contractFile.value);
    } catch (error) {
      if (error instanceof GeminiClientError) invalid(`Installed observed contract failed validation (${error.code}).`);
      throw error;
    }
    contractHash = sha256(contractFile.bytes);
  }
  const features = [];
  for (const feature of checklist.features) {
    const receiptFile = await readRepoJson(root, feature.receiptPath, { optional: true });
    const evaluated = await evaluateOne({
      root, feature, contract, contractHash, receipt: receiptFile?.value ?? null,
      identityOperationId: checklist.policy.ownerIdentityOperationId,
      identityOperationCaseId: checklist.policy.ownerIdentityOperationCaseId,
    });
    features.push({
      id: feature.id,
      title: feature.title,
      applicability: feature.applicability,
      applicabilityClass: feature.applicability,
      basis: { ...feature.basis },
      status: evaluated.status === 'complete' ? 'stored_receipt_consistent' : evaluated.status,
      reasons: evaluated.reasons,
      contractOperations: [...feature.contractOperations],
      requiredOperationCases: feature.requiredOperationCases.map((item) => ({ ...item })),
      requiredReadbackBindings: (feature.requiredReadbackBindings ?? []).map((item) => ({ ...item })),
      recordedEvidence: receiptFile?.value ? {
        recordedAt: receiptFile.value.checkedAt ?? null,
        evidenceScope: 'same_authenticated_owner',
        ownerIdentityEvidenceSha256: receiptFile.value.ownerIdentityEvidence?.sha256 ?? null,
        liveEvidenceClass: receiptFile.value.evidenceClass ?? null,
        networkFreshnessChecked: false,
        ...(feature.id === 'login' && receiptFile.value.authBootstrapEvidence
          ? { nativeAuthObservedAt: receiptFile.value.authBootstrapEvidence.observedAt,
            nativeAuthRecordedAt: receiptFile.value.authBootstrapEvidence.recordedAt,
            passwordSubmittedToProviderApi: receiptFile.value.authBootstrapEvidence.passwordSubmittedToProviderApi }
          : {}),
      } : evaluated.historicalEvidence ?? null,
    });
  }
  for (const feature of checklist.features.filter((item) => item.requiresBoundReadbackCases?.length)) {
    const row = features.find((item) => item.id === feature.id);
    if (row.status !== 'stored_receipt_consistent') continue;
    const aggregateFile = await readRepoJson(root, feature.receiptPath, { optional: true });
    const cases = aggregateFile?.value?.readbackCases;
    let missingCase = null;
    for (const childId of feature.requiresBoundReadbackCases) {
      const child = features.find((item) => item.id === childId);
      if (child?.status === 'not_applicable') continue;
      if (child?.status !== 'stored_receipt_consistent') {
        missingCase = childId;
        break;
      }
      const childFeature = checklist.features.find((item) => item.id === childId);
      const childReceiptFile = await readRepoJson(root, childFeature.receiptPath, { optional: true });
      const childBindings = childReceiptFile?.value?.readbackBindings;
      for (const binding of childBindings ?? []) {
        const proof = Array.isArray(cases) ? cases.find((item) => item?.featureId === childId
          && item?.writeOperation === binding.writeOperation && item?.writeCaseId === binding.writeCaseId
          && item?.readOperation === binding.readOperation && item?.readCaseId === binding.readCaseId
          && item?.correlationId === binding.correlationId) : null;
        if (!proof || proof.sameOwner !== true || proof.requestCorrelationVerified !== true
            || proof.expectedStateVerified !== true || proof.boundToSameWrite !== true) {
          missingCase = childId;
          break;
        }
      }
      if (missingCase) break;
    }
    if (missingCase) {
      row.status = 'live_evidence_missing';
      row.reasons = [`bound readback case is missing or unverified: ${missingCase}`];
    }
  }
  const accepted = features.filter((feature) => ['stored_receipt_consistent', 'not_applicable'].includes(feature.status)).length;
  const unresolved = features.filter((feature) => !['stored_receipt_consistent', 'not_applicable'].includes(feature.status)).length;
  const recordedTimes = features.map((feature) => feature.recordedEvidence?.recordedAt)
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort();
  return {
    schema: 'gemini-feature-audit-result-v1',
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    checkedAt: new Date().toISOString(),
    status: unresolved === 0 ? 'stored_receipt_consistent' : 'incomplete',
    executionMode: 'offline_filesystem_only',
    evidenceFreshness: 'recorded_receipts_only_current_network_not_checked',
    currentNetworkVerified: false,
    lastRecordedEvidenceAt: recordedTimes.at(-1) ?? null,
    networkRequests: 0,
    providerInvocations: 0,
    browserProcessesCreated: 0,
    contract: contract ? { installed: true, sha256: contractHash } : { installed: false },
    summary: { total: features.length, accepted, unresolved, strictPass: unresolved === 0 },
    features,
  };
}
