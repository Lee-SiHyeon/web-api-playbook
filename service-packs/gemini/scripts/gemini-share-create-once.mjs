import { stdin, stdout } from 'node:process';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiClientError } from '../src/errors.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { validateSessionBundle } from '../src/session.mjs';
import { createConversationShareOnce } from '../src/lifecycle-mutation.mjs';

const MAX_ENVELOPE_BYTES = 3 * 1024 * 1024;
const ALLOWED_FIELDS = new Set([
  'session', 'expectedOwner', 'conversationId', 'callerIntent', 'confirmed',
  'rpcId', 'args', 'requestCapture', 'shareUrlHandoff',
]);
const CONVERSATION_ID = /^c_[0-9a-f]{16}$/;

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

async function readEnvelope() {
  if (!stdin || stdin.isTTY === true) fail('SHARE_ENVELOPE_STDIN_REQUIRED', 'A one-shot share envelope must be piped to stdin.');
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += bytes.length;
    if (size > MAX_ENVELOPE_BYTES) fail('SHARE_ENVELOPE_TOO_LARGE', 'The one-shot share envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!size) fail('SHARE_ENVELOPE_STDIN_REQUIRED', 'The one-shot share envelope was empty.');
  const raw = Buffer.concat(chunks, size);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); fail('SHARE_ENVELOPE_INVALID', 'The one-shot share envelope is not valid JSON.'); }
  raw.fill(0);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !ALLOWED_FIELDS.has(key))
      || envelope.confirmed !== true
      || typeof envelope.expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.expectedOwner)
      || typeof envelope.conversationId !== 'string' || !CONVERSATION_ID.test(envelope.conversationId)
      || typeof envelope.callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(envelope.callerIntent)
      || envelope.rpcId !== 'fuVx7' || !Array.isArray(envelope.args)
      || !envelope.requestCapture || typeof envelope.requestCapture !== 'object'
      || !envelope.session || typeof envelope.session !== 'object' || Array.isArray(envelope.session)
      || (envelope.shareUrlHandoff !== undefined && envelope.shareUrlHandoff !== true)) {
    fail('SHARE_ENVELOPE_INVALID', 'The one-shot share envelope has an unsupported shape.');
  }
  return envelope;
}

function findShareUrl(root) {
  const pending = [{ value: root, depth: 0 }];
  const seen = new Set();
  let visited = 0;
  while (pending.length && visited < 100_000) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > 24) continue;
    if (typeof value === 'string') {
      if (value.length <= 8192) {
        const text = value.trim();
        if (/^https:\/\//i.test(text)) {
          try {
            const url = new URL(text);
            const pathSegments = url.pathname.split('/').filter(Boolean);
            const hasShareRoute = pathSegments.some((part) => part.toLowerCase() === 'share');
            const shareQuery = [...url.searchParams.keys()].some((key) => /share|token|id/i.test(key));
            if (((url.hostname === 'gemini.google.com' || url.hostname === 'g.co')
                && (hasShareRoute || shareQuery)) && !seen.has(url.href)) {
              seen.add(url.href);
              return url.href;
            }
          } catch { /* Not a URL. */ }
        }
        const nested = text.trimStart();
        if ((nested.startsWith('[') || nested.startsWith('{')) && nested.length <= 2 * 1024 * 1024) {
          try { pending.push({ value: JSON.parse(nested), depth: depth + 1 }); } catch { /* Plain text. */ }
        }
      }
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push({ value: value[index], depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

function wipe(value, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) wipe(child, depth + 1);
    value.length = 0;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    wipe(child, depth + 1);
    if (typeof child === 'string' && ['value', 'expectedOwner', 'conversationId'].includes(key)) value[key] = '';
  }
}

export async function runShareCreateOnce(envelope, { handoffShareUrl = false } = {}) {
  if (handoffShareUrl && envelope.shareUrlHandoff !== true) {
    fail('SHARE_URL_HANDOFF_NOT_AUTHORIZED', 'A private in-memory share URL handoff was not requested by the local orchestrator.');
  }
  const contract = await loadObservedContract();
  const session = validateSessionBundle(envelope.session, contract);
  const client = new GeminiWebClient({ contract, session });
  try {
    const result = await createConversationShareOnce(client, {
      requestCapture: envelope.requestCapture,
      rpcId: envelope.rpcId,
      args: envelope.args,
      targetConversationId: envelope.conversationId,
      expectedOwner: envelope.expectedOwner,
      confirmed: envelope.confirmed,
      callerIntent: envelope.callerIntent,
    });
    const shareUrl = result.internal?.responseData === undefined ? null : findShareUrl(result.internal.responseData);
    if (handoffShareUrl && shareUrl) {
      const handoffFd = Number(process.env.GEMINI_SHARE_URL_FD || 3);
      if (!Number.isSafeInteger(handoffFd) || handoffFd < 3) {
        fail('SHARE_URL_HANDOFF_FD_INVALID', 'The private in-memory share link handoff is unavailable.');
      }
      writeSync(handoffFd, Buffer.from(`${shareUrl}\n`, 'utf8'));
    }
    if (result.internal?.responseData && typeof result.internal.responseData === 'object') {
      wipe(result.internal.responseData);
    }
    return Object.freeze({
      operation: 'share_create',
      rpcId: result.rpcId,
      ownerMatched: result.ownerMatched,
      anonymousOwnerAbsent: result.anonymousOwnerAbsent,
      preflightConversationIdMatched: result.preflightConversationIdMatched,
      preflightRouteBindingVerified: result.preflightRouteBindingVerified,
      mutationHttpStatus: result.response.httpStatus,
      mutationResponseBytes: result.response.responseBytes,
      mutationResponseSha256: result.response.responseSha256,
      responseContractCaptured: result.response.responseContractCaptured,
      responseRpcDecoded: result.response.responseRpcDecoded,
      shareUrlFoundInMemory: Boolean(shareUrl),
      journalPath: result.journalPath,
      journalId: result.jobId,
      intentKeyHash: result.intentKeyHash,
      wireBodyDigest: result.wireBodyDigest,
      shareUrlPersistedOrPrinted: false,
    });
  } finally {
    client.transport.session = null;
  }
}

async function main() {
  let envelope;
  try {
    envelope = await readEnvelope();
    const receipt = await runShareCreateOnce(envelope, {
      handoffShareUrl: process.env.GEMINI_SHARE_LINK_HANDOFF === '1',
    });
    stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  } finally {
    wipe(envelope);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
      ? error.code : 'SHARE_CREATE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
