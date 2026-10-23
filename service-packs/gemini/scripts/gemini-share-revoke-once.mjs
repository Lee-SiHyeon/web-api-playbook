import { stdin, stdout } from 'node:process';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiClientError } from '../src/errors.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { validateSessionBundle } from '../src/session.mjs';
import { revokePublicShareLinkOnce } from '../src/lifecycle-mutation.mjs';

const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const SHARE_ID = /^[A-Za-z0-9._~-]{8,256}$/;
const CALLER_INTENT = /^lifecycle:share:revoke:protocol42:20261006:[12]$/;

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

async function readEnvelope() {
  if (stdin.isTTY === true) fail('SHARE_REVOKE_ENVELOPE_REQUIRED', 'A one-shot owner revoke envelope must be piped to stdin.');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_ENVELOPE_BYTES) fail('SHARE_REVOKE_ENVELOPE_TOO_LARGE', 'The owner revoke envelope exceeded its bound.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('SHARE_REVOKE_ENVELOPE_REQUIRED', 'The owner revoke envelope was empty.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); fail('SHARE_REVOKE_ENVELOPE_INVALID', 'The owner revoke envelope is not valid JSON.'); }
  raw.fill(0);
  const allowed = new Set(['session', 'expectedOwner', 'targetConversationTitle', 'shares']);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !allowed.has(key))
      || typeof envelope.expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.expectedOwner)
      || typeof envelope.targetConversationTitle !== 'string' || !envelope.targetConversationTitle.trim()
      || envelope.targetConversationTitle.length > 160
      || !Array.isArray(envelope.shares) || envelope.shares.length !== 2
      || !envelope.session || typeof envelope.session !== 'object' || Array.isArray(envelope.session)) {
    wipe(envelope);
    fail('SHARE_REVOKE_ENVELOPE_INVALID', 'The owner revoke envelope has an unsupported shape.');
  }
  const ids = [];
  const intents = [];
  for (let index = 0; index < envelope.shares.length; index += 1) {
    const share = envelope.shares[index];
    if (!share || typeof share !== 'object' || Array.isArray(share)
        || Object.keys(share).some((key) => !['shareId', 'requestCapture', 'args', 'callerIntent'].includes(key))
        || typeof share.shareId !== 'string' || !SHARE_ID.test(share.shareId)
        || !share.requestCapture || typeof share.requestCapture !== 'object' || Array.isArray(share.requestCapture)
        || share.requestCapture.rpcId !== 'SgORbf' || !Array.isArray(share.args)
        || typeof share.callerIntent !== 'string' || !CALLER_INTENT.test(share.callerIntent)) {
      wipe(envelope);
      fail('SHARE_REVOKE_ENVELOPE_INVALID', 'A target share revoke entry has an unsupported shape.');
    }
    ids.push(share.shareId);
    intents.push(share.callerIntent);
  }
  if (new Set(ids).size !== 2 || new Set(intents).size !== 2) {
    wipe(envelope);
    fail('SHARE_REVOKE_ENVELOPE_DUPLICATE_TARGET', 'The two task share targets or intents were not distinct.');
  }
  return envelope;
}

export async function runShareRevokeOnce(envelope) {
  const contract = await loadObservedContract();
  const session = validateSessionBundle(envelope.session, contract);
  const client = new GeminiWebClient({ contract, session });
  const results = [];
  try {
    for (let index = 0; index < envelope.shares.length; index += 1) {
      const entry = envelope.shares[index];
      const result = await revokePublicShareLinkOnce(client, {
        requestCapture: entry.requestCapture,
        rpcId: entry.requestCapture.rpcId,
        args: entry.args,
        targetShareId: entry.shareId,
        targetConversationTitle: envelope.targetConversationTitle,
        expectedRemainingTaskLinkCount: 2 - index,
        expectedOwner: envelope.expectedOwner,
        confirmed: true,
        callerIntent: entry.callerIntent,
      });
      results.push(result);
      if (result.readbackVerified !== true || result.journalReconciled !== true) {
        return Object.freeze({
          operation: 'share_revoke',
          ownerMatched: true,
          directDispatchCount: results.length,
          stopBeforeNextTarget: true,
          readbackVerified: false,
          results,
        });
      }
    }
    return Object.freeze({
      operation: 'share_revoke',
      ownerMatched: true,
      directDispatchCount: results.length,
      stopBeforeNextTarget: false,
      finalTotalShareCount: results.at(-1)?.readbackTotalShareCount ?? null,
      finalTaskLinkCount: results.at(-1)?.readbackTaskRowCount ?? null,
      readbackVerified: results.length === 2 && results.every((item) => item.readbackVerified),
      results,
    });
  } finally {
    client.transport.session = null;
  }
}

async function main() {
  let envelope;
  try {
    envelope = await readEnvelope();
    stdout.write(`${JSON.stringify(await runShareRevokeOnce(envelope))}\n`);
    return 0;
  } finally {
    wipe(envelope);
  }
}

main().catch((error) => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'SHARE_REVOKE_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
