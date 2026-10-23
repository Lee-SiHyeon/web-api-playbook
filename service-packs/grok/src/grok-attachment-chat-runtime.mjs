import { createInMemoryGrokRuntime } from './runtime.mjs';
import { createGrokAttachmentChatClient } from './grok-attachment-chat.mjs';
import { fail } from './errors.mjs';

export async function createInMemoryGrokAttachmentChatRuntime({
  expectedOwnerIdentityDigest,
  expectedPageRole = 'codex-grok-attachment-chat-20261006',
  continuationPythonExecutable,
  continuationSubmitImpl,
  ...runtimeOptions
} = {}) {
  if (typeof expectedOwnerIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedOwnerIdentityDigest)) {
    throw fail('ATTACHMENT_CHAT_EXPECTED_OWNER_REQUIRED');
  }
  const runtime = await createInMemoryGrokRuntime(runtimeOptions);
  const attachmentChat = createGrokAttachmentChatClient({
    client: runtime.client,
    sessionPersistence: runtime.sessionPersistence,
    operationJournal: runtime.journal,
    continuationPythonExecutable,
    continuationSubmitImpl,
    expectedPageRole,
    expectedOwnerIdentityDigest,
  });
  return Object.freeze({ ...runtime, attachmentChat });
}
