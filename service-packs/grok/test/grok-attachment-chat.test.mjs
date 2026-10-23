import assert from 'node:assert/strict';
import test from 'node:test';
import { createGrokAttachmentChatClient, GROK_ATTACHMENT_CHAT_OPERATION_ID } from '../src/grok-attachment-chat.mjs';

const ROLE = 'codex-grok-attachment-chat-20261006';
const OWNER_DIGEST = 'a'.repeat(64);
const FILE_ID = 'file-asset-id-12345678901234567890';
const CONVERSATION_ID = 'conversation-id-12345678901234567890';
const FILE = Object.freeze({
  fileName: 'codex-attachment-retain-20261007.txt',
  mimeType: 'text/plain',
  bytes: 20,
  sha256: 'e'.repeat(64),
});
const PROMPT = 'Read the attached text file and reply with its exact contents, with no additional text.';
const ANSWER = 'ATTACHMENT42:RETAIN';

function capture() {
  return {
    sourcePageRole: ROLE,
    browserWriteAbortVerified: true,
    browserBusinessFramesCaptured: 1,
    browserBusinessWritesDelivered: 0,
    browserControlFramesForwarded: 1,
    socketUrl: 'wss://grok.com/ws/mgw/?uid=opaque-captured-uid',
    controlFrameText: 'captured-control-frame',
    frameText: 'captured-business-frame',
  };
}

function readResult(data) {
  return { status: 200, contentType: 'application/json', responseBytes: 128, responseDigest: 'f'.repeat(64), data };
}

function makeHarness({
  ownerVerified = true,
  ownerDigest = OWNER_DIGEST,
  fileName = FILE.fileName,
  continuationState = 'completed',
  attachmentReadbackVerified = true,
  continuationError,
} = {}) {
  const reads = [];
  const continuationCalls = [];
  const client = {
    async status() { return { session: { ownerVerified } }; },
    async read(operationId, input) {
      reads.push({ operationId, input });
      if (operationId === 'attachment.assets.search') {
        return readResult({ assets: [{ assetId: FILE_ID, name: fileName, mimeType: FILE.mimeType, sizeBytes: FILE.bytes }] });
      }
      if (operationId === 'attachment.asset.read') {
        return readResult({ assetId: FILE_ID, name: FILE.fileName, mimeType: FILE.mimeType, sizeBytes: FILE.bytes, isDeleted: false });
      }
      if (operationId === 'attachment.file-metadata.read') {
        return readResult({ fileMetadataId: FILE_ID, fileName: FILE.fileName, fileMimeType: FILE.mimeType });
      }
      throw new Error(`unexpected read ${operationId}`);
    },
  };
  const sessionPersistence = {
    async read() {
      return {
        kind: 'grok-session',
        session: {
          generation: 'generation-1',
          ownerBinding: { generation: 'generation-1', identityDigest: ownerDigest },
          origins: [{ origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'memory-only-cookie' }] }],
        },
      };
    },
  };
  const operationJournal = { begin: async () => ({}), transition: async () => {} };
  const continuationSubmitImpl = async input => {
    continuationCalls.push(input);
    if (continuationError) throw Object.assign(new Error(continuationError), { code: continuationError });
    return {
      operation: 'chat.text.continuation.wss',
      state: continuationState,
      verified: continuationState === 'completed' && attachmentReadbackVerified,
      ownerVerified: true,
      fileAttachmentCount: input.fileAttachmentIds.length,
      fileAttachmentIdsReadbackVerified: attachmentReadbackVerified,
      conversationIdSha256: 'c'.repeat(64),
      readbackStatus: 200,
      directBusinessFrameSent: continuationState !== 'rejected',
    };
  };
  const attachmentChat = createGrokAttachmentChatClient({
    client,
    sessionPersistence,
    operationJournal,
    continuationSubmitImpl,
    expectedPageRole: ROLE,
    expectedOwnerIdentityDigest: OWNER_DIGEST,
  });
  return { attachmentChat, reads, continuationCalls };
}

function submitOptions(overrides = {}) {
  return {
    conversationId: CONVERSATION_ID,
    capture: capture(),
    file: FILE,
    prompt: PROMPT,
    expectedAssistantText: ANSWER,
    intentId: 'grok-retained-20b-attachment-chat-20261006-v1',
    confirm: true,
    ...overrides,
  };
}

test('attachment adapter owner-reads the reusable asset and delegates one same-CID source capture', async () => {
  const harness = makeHarness();
  const options = submitOptions();
  const result = await harness.attachmentChat.submit(options);

  assert.equal(result.operation, GROK_ATTACHMENT_CHAT_OPERATION_ID);
  assert.equal(result.continuationOperation, 'chat.text.continuation.wss');
  assert.equal(result.state, 'completed');
  assert.equal(result.ownerVerified, true);
  assert.equal(result.fileNameMatched, true);
  assert.equal(result.fileMimeTypeMatched, true);
  assert.equal(result.fileBytes, FILE.bytes);
  assert.equal(result.fileSha256, FILE.sha256);
  assert.equal(result.attachmentReadbackVerified, true);
  assert.equal('conversationId' in result, false);
  assert.equal(JSON.stringify(result).includes(FILE_ID), false);
  assert.deepEqual(harness.reads.map(item => item.operationId), [
    'attachment.assets.search', 'attachment.asset.read', 'attachment.file-metadata.read',
  ]);
  assert.equal(harness.continuationCalls.length, 1);
  assert.equal(harness.continuationCalls[0].conversationId, CONVERSATION_ID);
  assert.deepEqual(harness.continuationCalls[0].fileAttachmentIds, [FILE_ID]);
  assert.equal(harness.continuationCalls[0].expectedPrompt, PROMPT);
  assert.equal(harness.continuationCalls[0].expectedAssistantText, ANSWER);
  assert.equal(harness.continuationCalls[0].capture, options.capture);
});

test('wrong owner scope or identity fails before continuation dispatch', async () => {
  const wrongDigest = makeHarness({ ownerDigest: 'b'.repeat(64) });
  await assert.rejects(wrongDigest.attachmentChat.submit(submitOptions()), { code: 'OWNER_VERIFICATION_REQUIRED' });
  assert.equal(wrongDigest.continuationCalls.length, 0);

  const unverified = makeHarness({ ownerVerified: false });
  await assert.rejects(unverified.attachmentChat.submit(submitOptions()), { code: 'OWNER_VERIFICATION_REQUIRED' });
  assert.equal(unverified.continuationCalls.length, 0);
});

test('asset name mismatch blocks any WSS continuation', async () => {
  const harness = makeHarness({ fileName: 'different-file.txt' });
  await assert.rejects(harness.attachmentChat.submit(submitOptions()), { code: 'ATTACHMENT_CHAT_ASSET_NOT_FOUND' });
  assert.equal(harness.continuationCalls.length, 0);
});

test('uncertain generic continuation remains unknown and never becomes attachment success', async () => {
  const harness = makeHarness({ continuationState: 'outcome_unknown', attachmentReadbackVerified: false });
  const result = await harness.attachmentChat.submit(submitOptions());
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.verified, false);
  assert.equal(result.attachmentReadbackVerified, false);
  assert.equal(harness.continuationCalls.length, 1);
});

test('generic continuation error is propagated without a second call', async () => {
  const harness = makeHarness({ continuationError: 'OPERATION_ALREADY_COMPLETED' });
  await assert.rejects(harness.attachmentChat.submit(submitOptions()), { code: 'OPERATION_ALREADY_COMPLETED' });
  assert.equal(harness.continuationCalls.length, 1);
});
