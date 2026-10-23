import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiClientError } from '../src/errors.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { validateSessionBundle } from '../src/session.mjs';
import {
  GEMINI_READABLE_PREFERENCE_KEYS,
  listConversations,
  readConversation,
  readModels,
  readSettings,
  searchConversations,
  searchListedConversationDetails,
} from '../src/conversation-lifecycle.mjs';

const MAX_ENVELOPE_BYTES = 1024 * 1024;
const ALLOWED_FIELDS = new Set([
  'session', 'expectedOwner', 'action', 'query', 'conversationId', 'preferenceKeys', 'maxConversations',
]);
const ACTIONS = new Set([
  'history-list', 'history-read', 'history-search', 'history-search-listed-details', 'models', 'settings',
]);

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

async function readEnvelope() {
  if (!stdin || stdin.isTTY === true) fail('LIFECYCLE_ENVELOPE_STDIN_REQUIRED', 'A one-shot lifecycle envelope must be piped to stdin.');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_ENVELOPE_BYTES) fail('LIFECYCLE_ENVELOPE_TOO_LARGE', 'The one-shot lifecycle envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('LIFECYCLE_ENVELOPE_STDIN_REQUIRED', 'A one-shot lifecycle envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); fail('LIFECYCLE_ENVELOPE_INVALID', 'The one-shot lifecycle envelope is not valid JSON.'); }
  raw.fill(0);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !ALLOWED_FIELDS.has(key))
      || !ACTIONS.has(envelope.action)
      || typeof envelope.expectedOwner !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.expectedOwner)
      || !envelope.session || typeof envelope.session !== 'object' || Array.isArray(envelope.session)) {
    fail('LIFECYCLE_ENVELOPE_INVALID', 'The one-shot lifecycle envelope has an unsupported shape.');
  }
  return envelope;
}

function wipeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return;
  const session = envelope.session;
  if (Array.isArray(session?.cookies)) {
    for (const cookie of session.cookies) if (cookie && typeof cookie === 'object') cookie.value = '';
    session.cookies.length = 0;
  }
  if (session && typeof session === 'object') {
    session.headers = {};
    session.requestHeaders = {};
    session.batchContext = {};
  }
  envelope.expectedOwner = '';
  envelope.query = '';
  envelope.conversationId = '';
  if (Array.isArray(envelope.preferenceKeys)) envelope.preferenceKeys.length = 0;
}

export function validateLifecycleEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !ALLOWED_FIELDS.has(key))
      || !ACTIONS.has(envelope.action)
      || typeof envelope.expectedOwner !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.expectedOwner)
      || !envelope.session || typeof envelope.session !== 'object' || Array.isArray(envelope.session)) {
    fail('LIFECYCLE_ENVELOPE_INVALID', 'The one-shot lifecycle envelope has an unsupported shape.');
  }
  if (envelope.action === 'history-search' || envelope.action === 'history-search-listed-details') {
    if (typeof envelope.query !== 'string' || !envelope.query.trim() || envelope.query.length > 256 || /[\0\r\n]/.test(envelope.query)) {
      fail('LIFECYCLE_ENVELOPE_INVALID', 'A bounded history search query is required.');
    }
  }
  if (envelope.action === 'history-read'
      && (typeof envelope.conversationId !== 'string' || !/^c_[0-9a-f]{16}$/.test(envelope.conversationId))) {
    fail('LIFECYCLE_ENVELOPE_INVALID', 'A captured API conversation identifier is required.');
  }
  if (envelope.action === 'settings' && envelope.preferenceKeys !== undefined
      && (!Array.isArray(envelope.preferenceKeys) || envelope.preferenceKeys.length > GEMINI_READABLE_PREFERENCE_KEYS.length
        || envelope.preferenceKeys.some((key) => !GEMINI_READABLE_PREFERENCE_KEYS.includes(key)))) {
    fail('LIFECYCLE_ENVELOPE_INVALID', 'The settings request contains an unsupported preference key.');
  }
  if (envelope.action === 'history-search-listed-details' && envelope.maxConversations !== undefined
      && (!Number.isSafeInteger(envelope.maxConversations) || envelope.maxConversations < 1 || envelope.maxConversations > 40)) {
    fail('LIFECYCLE_ENVELOPE_INVALID', 'The local history detail search limit must be from 1 to 40.');
  }
  return envelope;
}

export async function runLifecycleRead(envelope, { contractPath } = {}) {
  validateLifecycleEnvelope(envelope);
  const contract = await loadObservedContract(contractPath);
  const session = validateSessionBundle(envelope.session, contract);
  const client = new GeminiWebClient({ contract, session });
  try {
    const refreshed = await client.refreshSession(envelope.expectedOwner);
    if (refreshed.ownerMatched !== true || refreshed.anonymousOwnerAbsent !== true) {
      fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
    }
    switch (envelope.action) {
      case 'history-list':
        return await listConversations(client, { expectedOwner: envelope.expectedOwner });
      case 'history-read':
        return await readConversation(client, {
          expectedOwner: envelope.expectedOwner,
          conversationId: envelope.conversationId,
        });
      case 'history-search':
        return await searchConversations(client, {
          expectedOwner: envelope.expectedOwner,
          query: envelope.query,
        });
      case 'history-search-listed-details':
        return await searchListedConversationDetails(client, {
          expectedOwner: envelope.expectedOwner,
          query: envelope.query,
          maxConversations: envelope.maxConversations ?? 20,
        });
      case 'models':
        return await readModels(client, { expectedOwner: envelope.expectedOwner });
      case 'settings':
        return await readSettings(client, {
          expectedOwner: envelope.expectedOwner,
          keys: envelope.preferenceKeys ?? GEMINI_READABLE_PREFERENCE_KEYS,
        });
      default:
        fail('LIFECYCLE_ACTION_UNSUPPORTED', 'The requested Gemini read action is unsupported.');
    }
  } finally {
    // This client is one-shot: drop the copied cookie/session references after
    // the result has been decoded in memory.
    client.transport.session = null;
  }
}

async function main() {
  let envelope;
  try {
    envelope = await readEnvelope();
    const result = await runLifecycleRead(envelope);
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    wipeEnvelope(envelope);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
      ? error.code : 'LIFECYCLE_READ_FAILED';
    stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
