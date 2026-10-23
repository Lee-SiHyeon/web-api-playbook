import { stdin, stdout } from 'node:process';
import { GeminiWebClient } from '../src/client.mjs';
import { loadObservedContract } from '../src/contract.mjs';
import { validateSessionBundle } from '../src/session.mjs';

const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

function print(value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code : 'ORIGINAL_IMAGE_DOWNLOAD_FAILED';
}

function errorClass(error) {
  return error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'InternalError';
}

function wipeStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else wipeStrings(value[index], seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = '';
      else wipeStrings(value[key], seen);
    } catch { /* Frozen contract data is not an input secret. */ }
  }
}

async function readEnvelope() {
  if (stdin.isTTY === true) throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_STDIN_REQUIRED' });
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_ENVELOPE_BYTES) throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_ENVELOPE_TOO_LARGE' });
    chunks.push(bytes);
  }
  if (!length) throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_STDIN_REQUIRED' });
  const raw = Buffer.concat(chunks, length);
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_ENVELOPE_INVALID' });
    }
    return value;
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_ENVELOPE_INVALID' });
  } finally {
    raw.fill(0);
  }
}

let envelope = null;
let contract = null;
let session = null;
let client = null;
try {
  if (process.argv.length !== 5 || process.argv[2] !== '--envelope-stdin'
      || process.argv[3] !== '--expect-owner' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.argv[4])) {
    throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_ARGUMENT_INVALID' });
  }
  const expectedOwner = process.argv[4];
  envelope = await readEnvelope();
  const fields = new Set([
    'session', 'apiConversationId', 'visibleRouteId', 'expectedIntent', 'preparedRequest',
    'artifactRoot', 'artifactName', 'expectedArtifactPath',
  ]);
  if (Object.keys(envelope).some((key) => !fields.has(key))
      || typeof envelope.apiConversationId !== 'string'
      || typeof envelope.visibleRouteId !== 'string'
      || typeof envelope.expectedIntent !== 'string'
      || typeof envelope.artifactRoot !== 'string'
      || typeof envelope.artifactName !== 'string') {
    throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_ENVELOPE_INVALID' });
  }
  contract = await loadObservedContract();
  session = validateSessionBundle(envelope.session, contract);
  client = new GeminiWebClient({ contract, session });
  const owner = await client.verifyOwner(expectedOwner);
  if (owner.ownerMatched !== true || owner.anonymousOwnerAbsent !== true) {
    throw Object.assign(new Error(), { code: 'ORIGINAL_IMAGE_OWNER_VERIFICATION_FAILED' });
  }
  const result = await client.downloadOriginalImageOnce({
    expectedOwner,
    apiConversationId: envelope.apiConversationId,
    visibleRouteId: envelope.visibleRouteId,
    expectedIntent: envelope.expectedIntent,
    preparedRequest: envelope.preparedRequest,
    artifactRoot: envelope.artifactRoot,
    artifactName: envelope.artifactName,
    expectedArtifactPath: envelope.expectedArtifactPath ?? null,
  });
  const taskReadback = result.taskReadback;
  print({
    outcome: result.outcome,
    ownerMatched: true,
    anonymousOwnerAbsent: true,
    taskHttpStatus: taskReadback.httpStatus,
    taskResponseSha256: taskReadback.responseSha256,
    taskPromptMatched: taskReadback.summary.taskIntentMatched,
    apiConversationIdMatched: taskReadback.summary.apiConversationIdMatched,
    routeBound: taskReadback.binding.bound,
    directReplay: {
      outcome: result.outcome,
      taskBinding: result.taskBinding,
      taskPromptMatched: result.taskPromptMatched,
      apiConversationIdMatched: result.apiConversationIdMatched,
      routeBound: result.routeBound,
      c8: result.c8,
      originalSizeTransform: result.originalSizeTransform,
      asset: {
        hops: result.asset.hops,
        httpStatus: result.asset.httpStatus,
        contentType: result.asset.contentType,
        bytes: result.asset.bytes,
        sha256: result.asset.sha256,
        dimensions: result.asset.dimensions,
        mimeMagicMatched: result.asset.mimeMagicMatched,
        bytesMatchedExpected: result.asset.bytesMatchedExpected,
        independentFileReadback: result.asset.independentFileReadback,
        artifact: result.asset.artifact,
      },
      credentialBinding: result.credentialBinding,
      rawValuesPersistedOrPrinted: false,
    },
    rawValuesPersistedOrPrinted: false,
  });
} catch (error) {
  print({ outcome: 'needs_review', failureCode: errorCode(error), errorClass: errorClass(error), rawValuesPersistedOrPrinted: false });
} finally {
  if (client) {
    client.transport.session = null;
    client.verifiedOwner = null;
  }
  client = null;
  session = null;
  contract = null;
  wipeStrings(envelope);
  envelope = null;
}
