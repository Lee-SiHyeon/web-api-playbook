import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GeminiWebClient } from './client.mjs';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--canary-readback') options.canaryReadback = true;
  else if (args[i] === '--receipt' && args[i + 1]) options.receipt = args[++i];
  else throw new Error('Use --receipt FILE and optionally --canary-readback.');
}
const receipt = { version: 1, startedAt: new Date().toISOString(), mode: 'pure_http',
  credentialProvider: 'Windows DPAPI CurrentUser', browserUsedForRecurringReads: false,
  generationRequests: 0, externalMutations: 0, checks: {}, requests: [] };
const client = new GeminiWebClient();
try {
  await client.start();
  const conversations = await client.listConversations();
  receipt.checks.conversationCount = conversations.length;
  receipt.checks.authenticatedList = true;
  if (conversations.length) {
    const conversation = await client.readConversation(conversations[0].id);
    receipt.checks.existingConversationRead = true;
    receipt.checks.rowCount = conversation.rows.length;
    receipt.checks.conversationIdMatched = conversation.id === conversations[0].id;
    if (options.canaryReadback) {
      const pending = [conversation.rows];
      let promptFound = false, replyFound = false;
      while (pending.length) {
        const value = pending.pop();
        if (Array.isArray(value)) pending.push(...value);
        else if (typeof value === 'string') {
          promptFound ||= value.includes('XHR 연결 점검입니다. 다른 설명 없이 연결 확인 이라고만 답해주세요.');
          replyFound ||= value.trim() === '연결 확인';
        }
      }
      receipt.checks.browserCanaryPromptReadback = promptFound;
      receipt.checks.browserCanaryReplyReadback = replyFound;
      if (!promptFound || !replyFound) throw Object.assign(new Error('Canary readback did not match.'), { code: 'GEMINI_CANARY_READBACK_MISMATCH' });
    }
  }
  receipt.passed = receipt.checks.authenticatedList === true;
} catch (error) {
  receipt.passed = false;
  receipt.error = { code: typeof error.code === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.code)
    ? error.code : 'GEMINI_VERIFICATION_FAILED', httpStatus: error.httpStatus, rpcId: error.rpcId,
    transportCode: typeof error.transportCode === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.transportCode)
      ? error.transportCode : undefined };
} finally {
  receipt.requests = client.evidence;
  receipt.finishedAt = new Date().toISOString();
}
if (options.receipt) {
  await mkdir(path.dirname(path.resolve(options.receipt)), { recursive: true });
  await writeFile(options.receipt, JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify(receipt, null, 2));
if (!receipt.passed) process.exitCode = 1;
