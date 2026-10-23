import { submitCapturedGrokConversationContinuationOnce } from './grok-conversation-continuation.mjs';
import { fail } from './errors.mjs';

export const GROK_ATTACHMENT_CHAT_OPERATION_ID = 'conversation.attach-file';
export const GROK_ATTACHMENT_CHAT_PAGE_ROLE = 'codex-grok-attachment-chat-20261006';

const SHA256 = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIME = /^[A-Za-z0-9.+-]{1,80}\/[A-Za-z0-9.+-]{1,80}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeId(value, code, max = 512) {
  if (typeof value !== 'string' || value.length < 16 || value.length > max || /[\r\n\0]/.test(value)) {
    throw fail(code);
  }
  return value;
}

function safeText(value, code, max = 4_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw fail(code);
  }
  return value;
}

function validateFileProof(value) {
  if (!isObject(value) || !NAME.test(value.fileName)
    || typeof value.mimeType !== 'string' || !MIME.test(value.mimeType)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 157_286_400
    || !SHA256.test(value.sha256)) throw fail('ATTACHMENT_CHAT_FILE_PROOF_INVALID');
  return Object.freeze({
    fileName: value.fileName,
    mimeType: value.mimeType.toLowerCase(),
    bytes: value.bytes,
    sha256: value.sha256,
  });
}

async function requireRead(client, operationId, input, ownerDigest) {
  const result = await client.read(operationId, input, { expectedOwnerScopeSha256: ownerDigest });
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300
    || !isObject(result.data)) throw fail('ATTACHMENT_CHAT_READ_FAILED');
  return result;
}

async function verifyReusableAsset(client, file, ownerDigest) {
  const search = await requireRead(client, 'attachment.assets.search', { query: file.fileName, pageSize: 50 }, ownerDigest);
  const assets = Array.isArray(search.data.assets) ? search.data.assets : [];
  const exact = assets.filter(item => isObject(item) && item.name === file.fileName
    && String(item.mimeType ?? '').toLowerCase() === file.mimeType
    && item.isDeleted !== true
    && (item.sizeBytes === undefined || Number(item.sizeBytes) === file.bytes));
  if (exact.length !== 1 || typeof exact[0].assetId !== 'string' || exact[0].assetId.length < 16
    || (typeof search.data.nextPageToken === 'string' && search.data.nextPageToken)) {
    throw fail(exact.length > 1 ? 'ATTACHMENT_CHAT_ASSET_AMBIGUOUS' : 'ATTACHMENT_CHAT_ASSET_NOT_FOUND');
  }
  const assetId = exact[0].assetId;
  const assetRead = await requireRead(client, 'attachment.asset.read', { assetId }, ownerDigest);
  const asset = assetRead.data;
  if ((asset.name ?? asset.fileName) !== file.fileName
    || String(asset.mimeType ?? asset.fileMimeType ?? '').toLowerCase() !== file.mimeType
    || (asset.assetId !== undefined && asset.assetId !== assetId)
    || asset.isDeleted === true
    || (asset.sizeBytes !== undefined && Number(asset.sizeBytes) !== file.bytes)) {
    throw fail('ATTACHMENT_CHAT_ASSET_METADATA_MISMATCH');
  }
  const fileMetadata = await requireRead(client, 'attachment.file-metadata.read', { fileMetadataId: assetId }, ownerDigest);
  if (fileMetadata.data.fileMetadataId !== assetId || fileMetadata.data.fileName !== file.fileName
    || String(fileMetadata.data.fileMimeType ?? '').toLowerCase() !== file.mimeType) {
    throw fail('ATTACHMENT_CHAT_FILE_METADATA_MISMATCH');
  }
  return assetId;
}

/** Attach one owner-read existing file to an empty task-created conversation using the captured SDK continuation. */
export function createGrokAttachmentChatClient({
  client,
  sessionPersistence,
  operationJournal,
  continuationSubmitImpl,
  continuationPythonExecutable,
  expectedPageRole = GROK_ATTACHMENT_CHAT_PAGE_ROLE,
  expectedOwnerIdentityDigest,
} = {}) {
  if (!client || typeof client.status !== 'function' || typeof client.read !== 'function'
    || !sessionPersistence || typeof sessionPersistence.read !== 'function'
    || !operationJournal || typeof operationJournal.begin !== 'function' || typeof operationJournal.transition !== 'function') {
    throw fail('ATTACHMENT_CHAT_RUNTIME_REQUIRED');
  }
  if (typeof expectedPageRole !== 'string' || !/^codex-grok-[A-Za-z0-9-]{8,96}$/.test(expectedPageRole)) {
    throw fail('ATTACHMENT_CHAT_ROLE_INVALID');
  }
  if (typeof expectedOwnerIdentityDigest !== 'string' || !SHA256.test(expectedOwnerIdentityDigest)) {
    throw fail('ATTACHMENT_CHAT_EXPECTED_OWNER_REQUIRED');
  }
  const submitContinuation = continuationSubmitImpl ?? (input => submitCapturedGrokConversationContinuationOnce({
    ...input,
    pythonExecutable: continuationPythonExecutable,
  }));
  if (typeof submitContinuation !== 'function') throw fail('ATTACHMENT_CHAT_RUNTIME_REQUIRED');

  return Object.freeze({
    async submit({ conversationId, capture, file, prompt, expectedAssistantText, intentId, confirm = false } = {}) {
      if (confirm !== true) throw fail('ATTACHMENT_CHAT_CONFIRMATION_REQUIRED');
      if (typeof intentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intentId)) {
        throw fail('ATTACHMENT_CHAT_INTENT_INVALID');
      }
      const conversation = safeId(conversationId, 'ATTACHMENT_CHAT_CONVERSATION_ID_INVALID');
      const safeFile = validateFileProof(file);
      const message = safeText(prompt, 'ATTACHMENT_CHAT_PROMPT_INVALID');
      const expected = safeText(expectedAssistantText, 'ATTACHMENT_CHAT_EXPECTED_RESPONSE_INVALID');

      const stored = await sessionPersistence.read();
      const session = stored?.session;
      const ownerDigest = session?.ownerBinding?.identityDigest;
      if (stored?.kind !== 'grok-session' || !session || session.generation !== session.ownerBinding?.generation
        || typeof ownerDigest !== 'string' || !SHA256.test(ownerDigest)
        || ownerDigest !== expectedOwnerIdentityDigest) throw fail('OWNER_VERIFICATION_REQUIRED');
      if ((await client.status())?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');

      const assetId = await verifyReusableAsset(client, safeFile, ownerDigest);
      const continuation = await submitContinuation({
        client,
        sessionPersistence,
        operationJournal,
        capture,
        conversationId: conversation,
        intentId,
        expectedPrompt: message,
        expectedAssistantText: expected,
        expectedSourcePageRole: expectedPageRole,
        fileAttachmentIds: [assetId],
        confirm: true,
      });
      const attachmentReadbackVerified = continuation?.fileAttachmentIdsReadbackVerified === true;
      const result = {
        ...continuation,
        operation: GROK_ATTACHMENT_CHAT_OPERATION_ID,
        continuationOperation: continuation?.operation ?? 'chat.text.continuation.wss',
        ownerVerified: continuation?.ownerVerified === true,
        state: continuation?.state ?? 'needs_review',
        fileNameMatched: true,
        fileMimeTypeMatched: true,
        fileBytes: safeFile.bytes,
        fileSha256: safeFile.sha256,
        attachmentReadbackVerified,
      };
      if (result.state === 'completed' && !attachmentReadbackVerified) {
        return { ...result, state: 'needs_review', verified: false };
      }
      return result;
    },
  });
}
