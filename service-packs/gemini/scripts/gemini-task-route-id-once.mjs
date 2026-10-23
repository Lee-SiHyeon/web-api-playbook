import { stdin, stdout } from 'node:process';
import { writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiClientError } from '../src/errors.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { validateSessionBundle } from '../src/session.mjs';
import { listConversations } from '../src/conversation-lifecycle.mjs';

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function wipe(value, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (typeof value[i] === 'string') value[i] = '';
      else wipe(value[i], depth + 1);
    }
    value.length = 0;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') value[key] = '';
    else wipe(child, depth + 1);
  }
}

async function main() {
  if (stdin.isTTY === true) fail('TASK_ROUTE_ENVELOPE_REQUIRED', 'A task route envelope must be piped to stdin.');
  let raw = '';
  for await (const chunk of stdin) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (raw.length > 2 * 1024 * 1024) fail('TASK_ROUTE_ENVELOPE_TOO_LARGE', 'The task route envelope exceeded its bounded size.');
  }
  let envelope;
  try { envelope = JSON.parse(raw); }
  catch { fail('TASK_ROUTE_ENVELOPE_INVALID', 'The task route envelope is not valid JSON.'); }
  raw = '';
  const keys = new Set(['session', 'expectedOwner', 'taskTitle']);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !keys.has(key))
      || typeof envelope.expectedOwner !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.expectedOwner)
      || typeof envelope.taskTitle !== 'string' || !envelope.taskTitle.trim()
      || envelope.taskTitle.length > 160) {
    wipe(envelope);
    fail('TASK_ROUTE_ENVELOPE_INVALID', 'The task route envelope has an unsupported shape.');
  }
  let client;
  let listing;
  try {
    const contract = await loadObservedContract();
    const session = validateSessionBundle(envelope.session, contract);
    client = new GeminiWebClient({ contract, session });
    const identity = await client.refreshSession(envelope.expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
      fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
    }
    listing = await listConversations(client, { expectedOwner: envelope.expectedOwner });
    const matches = listing.conversations.filter((item) => item.title === envelope.taskTitle);
    if (matches.length !== 1) fail('TASK_CONVERSATION_NOT_UNIQUE', 'The exact task title did not select one history conversation.');
    const id = matches[0].conversationId;
    if (!/^c_[0-9a-f]{16}$/.test(id)) fail('TASK_CONVERSATION_ID_INVALID', 'The observed task conversation identifier was malformed.');
    const fd = Number(process.env.GEMINI_TASK_ROUTE_ID_FD || 3);
    if (!Number.isSafeInteger(fd) || fd < 3) fail('TASK_ROUTE_HANDOFF_FD_INVALID', 'The private in-memory route handoff is unavailable.');
    writeSync(fd, Buffer.from(`${id.slice(2)}\n`, 'utf8'));
    stdout.write(JSON.stringify({
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      exactTitleCount: 1,
      routeSuffixLength: 16,
      apiConversationIdSha256: createHash('sha256').update(id, 'utf8').digest('hex'),
    }) + '\n');
  } finally {
    if (listing?.data && typeof listing.data === 'object') wipe(listing.data);
    if (client?.transport) client.transport.session = null;
    wipe(envelope);
  }
}

main().catch((error) => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'TASK_ROUTE_READ_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
