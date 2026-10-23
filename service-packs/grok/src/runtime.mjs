import { GrokWebClient, loadContractRegistry } from './client.mjs';
import { OperationJournal } from './journal.mjs';
import { NonSecretJsonFileStore } from './nonsecret-json-store.mjs';
import { ProtectedJsonStore } from './protected-json-store.mjs';
import { createAuthenticatedChromeFetch } from './authenticated-chrome-fetch.mjs';
import { createGrokConversationClient } from './grok-conversations.mjs';
import { createGrokWorkspaceClient } from './grok-workspaces.mjs';
import { createGrokModelSelectionClient } from './grok-model-selection.mjs';
import { submitGrokTextInSelectedMode } from './grok-mode-selected-text.mjs';
import { createGrokAttachmentUploadClient } from './grok-attachment-upload.mjs';
import { createGrokCffiAttachmentAssetReader } from './grok-attachment-asset-reader.mjs';
import { createGrokAttachmentPresignedUploadClient } from './grok-attachment-presigned-upload.mjs';
import { persistGrokAttachmentStageAudit } from './attachment-stage-audit-store.mjs';
import { createGrokUploadReferenceStore } from './grok-upload-reference-store.mjs';
import { createGrokNativeGoogleAuthClient } from './grok-native-google-auth.mjs';
import { fail } from './errors.mjs';

const MODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Create a Linux client with process-memory session credentials and a durable nonsecret journal. */
export async function createInMemoryGrokRuntime({ registry, fetchImpl, pythonExecutable, timeoutMs, journalPersistence, journalFilePath } = {}) {
  const resolvedRegistry = registry ?? await loadContractRegistry();
  const sessionPersistence = new ProtectedJsonStore({ provider: 'memory' });
  const resolvedJournalPersistence = journalPersistence ?? new NonSecretJsonFileStore({ filePath: journalFilePath });
  const journal = new OperationJournal({ store: resolvedJournalPersistence });
  const resolvedFetchImpl = fetchImpl ?? createAuthenticatedChromeFetch({
    registry: resolvedRegistry,
    pythonExecutable: pythonExecutable ?? process.env.GROK_CHROME_PYTHON ?? 'python3',
    timeoutMs,
  });
  const client = new GrokWebClient({
    registry: resolvedRegistry,
    sessionPersistence,
    journal,
    fetchImpl: resolvedFetchImpl,
    timeoutMs,
  });
  return Object.freeze({ client, sessionPersistence, journalPersistence: resolvedJournalPersistence, journal });
}

/** Create the process-memory Grok client with owner-bound workspace read and mutation methods. */
export async function createInMemoryGrokWorkspaceRuntime(options = {}) {
  const runtime = await createInMemoryGrokRuntime(options);
  const workspaces = createGrokWorkspaceClient({ client: runtime.client, journal: runtime.journal });
  return Object.freeze({ ...runtime, workspaces });
}

/** Create the process-memory Grok client with owner-bound conversation and history methods. */
export async function createInMemoryGrokConversationRuntime(options = {}) {
  const runtime = await createInMemoryGrokRuntime(options);
  const conversations = createGrokConversationClient({ client: runtime.client, journal: runtime.journal });
  return Object.freeze({ ...runtime, conversations });
}

/** Create a process-memory runtime that classifies native Google login applicability from the owner session. */
export async function createInMemoryGrokNativeGoogleAuthRuntime(options = {}) {
  const runtime = await createInMemoryGrokRuntime(options);
  const nativeGoogleAuth = createGrokNativeGoogleAuthClient({ client: runtime.client });
  return Object.freeze({ ...runtime, nativeGoogleAuth });
}

/** Create the API attachment facade with process-memory credentials and the same durable journal. */
export async function createInMemoryGrokAttachmentRuntime(options = {}) {
  const { assetReader: suppliedAssetReader, signedUrlPolicy, signedPutImpl, onUploadStageReceipt,
    getUploadRequestMetadataHeaders, onUploadInitResponse, onUploadCompleteResponse, ...runtimeOptions } = options;
  if (signedUrlPolicy !== undefined && typeof signedUrlPolicy !== 'function') throw fail('ATTACHMENT_SIGNED_URL_POLICY_REQUIRED');
  const runtime = await createInMemoryGrokRuntime(runtimeOptions);
  const assetReader = suppliedAssetReader ?? createGrokCffiAttachmentAssetReader({
    pythonExecutable: runtimeOptions.pythonExecutable ?? process.env.GROK_CHROME_PYTHON ?? 'python3',
  });
  const attachments = createGrokAttachmentUploadClient({ client: runtime.client, journal: runtime.journal, assetReader });
  const getVerifiedOwnerScopeSha256 = async () => {
    const status = await runtime.client.status();
    if (status.session.ownerVerified !== true) return null;
    const state = await runtime.sessionPersistence.read();
    return state?.session?.ownerBinding?.identityDigest ?? null;
  };
  const uploadReferences = createGrokUploadReferenceStore({ getVerifiedOwnerScopeSha256, operationJournal: runtime.journal });
  const presignedAttachments = signedUrlPolicy ? createGrokAttachmentPresignedUploadClient({
    client: runtime.client,
    operationJournal: runtime.journal,
    signedUrlPolicy,
    ...(signedPutImpl ? { putImpl: signedPutImpl } : {}),
    onStageReceipt: onUploadStageReceipt ?? persistGrokAttachmentStageAudit,
    getRequestMetadataHeaders: getUploadRequestMetadataHeaders,
    onInitResponse: onUploadInitResponse,
    onCompleteResponse: onUploadCompleteResponse,
    getVerifiedOwnerScopeSha256,
    discoveryPermits: {
      init: 'first-live:attachment.upload.init',
      complete: 'first-live:attachment.upload.complete',
      status: 'first-read:attachment.upload.status',
      abort: 'first-live:attachment.upload.abort',
      fileMetadata: 'first-read:attachment.file-metadata.read',
    },
  }) : null;
  return Object.freeze({ ...runtime, attachments, presignedAttachments, uploadReferences });
}

/** Create a process-local adapter matching the Grok SDK's selectedModeId/user setter contract. */
export function createInMemoryGrokModeStore({ selectedModeId = null } = {}) {
  if (selectedModeId !== null && (typeof selectedModeId !== 'string' || !MODE_ID.test(selectedModeId))) {
    throw fail('MODEL_MODE_STORE_INVALID');
  }
  let currentModeId = selectedModeId;
  const setSelectedModeId = (modeId, options = {}) => {
    if (options?.source !== 'user') throw fail('MODEL_MODE_SOURCE_INVALID');
    if (typeof modeId !== 'string' || !MODE_ID.test(modeId)) throw fail('MODEL_MODE_ID_INVALID');
    currentModeId = modeId;
  };
  return Object.freeze({
    getState() {
      return Object.freeze({ selectedModeId: currentModeId, setSelectedModeId });
    },
  });
}

/** Create a session-backed mode reader with an in-memory selectedModeId state mirror. */
export async function createInMemoryGrokModelSelectionRuntime(options = {}) {
  const { selectedModeId = null, modeStore: suppliedModeStore, websocketPythonExecutable, ...runtimeOptions } = options;
  const runtime = await createInMemoryGrokRuntime(runtimeOptions);
  const modeStore = suppliedModeStore ?? createInMemoryGrokModeStore({ selectedModeId });
  const selectionReader = createGrokModelSelectionClient({ client: runtime.client, modeStore });
  const submitTextInSelectedMode = async ({ locale = 'en', ...input } = {}) => {
    const catalogResult = await selectionReader.modes(locale);
    if (catalogResult.status < 200 || catalogResult.status >= 300) throw fail('MODEL_MODES_READ_FAILED');
    return submitGrokTextInSelectedMode({
      ...input,
      sessionPersistence: runtime.sessionPersistence,
      operationJournal: runtime.journal,
      client: runtime.client,
      modeStore,
      catalog: catalogResult.data,
      pythonExecutable: websocketPythonExecutable,
    });
  };
  const modelSelection = Object.freeze({
    ...selectionReader,
    submitTextInSelectedMode,
  });
  return Object.freeze({ ...runtime, modeStore, modelSelection, modeSelection: modelSelection,
    submitTextInSelectedMode });
}
