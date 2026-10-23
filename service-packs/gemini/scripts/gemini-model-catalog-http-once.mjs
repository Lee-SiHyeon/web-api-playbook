import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const { snapshotFeatureSourceScope, validateFeatureSourceScope } = await import('../src/source-scope.mjs');

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

async function sourceSnapshot() {
  const contractBytes = await readFile(path.join(ROOT, 'discovery/observed-contract.json'));
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const scope = await snapshotFeatureSourceScope({
    root: ROOT, contract, featureId: 'model_catalog', operationNames: ['model_list'],
  });
  return {
    contractSha256: sha(contractBytes),
    implementationFiles: scope.implementationUnits,
    implementationSetSha256: scope.implementationScopeSha256,
    sourceScope: scope,
    contractBytes,
  };
}

async function performModelRead(client, expectedOwner) {
  const handoff = await client.refreshSession(expectedOwner);
  if (handoff.ownerMatched !== true || handoff.anonymousOwnerAbsent !== true) {
    fail('OWNER_VERIFICATION_FAILED');
  }
  const identity = await client.verifyOwner(expectedOwner);
  if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true
      || identity.httpStatus !== 200 || identity.credentialPropagated !== true) {
    fail('OWNER_VERIFICATION_FAILED');
  }
  const result = await client.listModels({ expectedOwner });
  if (result.ownerMatched !== true || result.anonymousOwnerAbsent !== true
      || result.httpStatus !== 200 || result.contentType !== 'application/json'
      || result.rpcId !== 'otAQ7b' || result.credentialPropagated !== true
      || !Array.isArray(result.models) || result.models.length < 1) {
    fail('MODEL_CATALOG_READ_UNVERIFIED');
  }
  const uniqueModelIds = new Set(result.models.map((model) => model.modelId));
  if (uniqueModelIds.size !== result.models.length
      || result.models.some((model) => typeof model.modelId !== 'string' || !/^[0-9a-f]{16}$/.test(model.modelId))) {
    fail('MODEL_CATALOG_SHAPE_INVALID');
  }
  return { identity, result };
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_INPUT_BYTES) fail('MODEL_ENVELOPE_TOO_LARGE');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('MODEL_ENVELOPE_REQUIRED');
  const raw = Buffer.concat(chunks, length);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    fail('MODEL_ENVELOPE_INVALID');
  } finally {
    raw.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function main() {
  let packet;
  let client;
  let expectedOwner = '';
  try {
    packet = await readInput();
    if (!packet || typeof packet.expectedOwner !== 'string' || !packet.session
        || typeof packet.expectedOwner !== 'string'
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(packet.expectedOwner)) {
      fail('MODEL_ENVELOPE_INVALID');
    }
    expectedOwner = packet.expectedOwner;
    const ownerHashBefore = sha(expectedOwner.trim().toLowerCase());
    if (ownerHashBefore !== EXPECTED_OWNER_SHA256) fail('EXPECTED_OWNER_NOT_UNIQUE');
    const before = await sourceSnapshot();
    const [{ GeminiWebClient }, { validateObservedContract }] = await Promise.all([
      import('../src/client.mjs'), import('../src/contract.mjs'),
    ]);
    const contract = validateObservedContract(JSON.parse(before.contractBytes.toString('utf8')));
    client = new GeminiWebClient({ contract, session: packet.session });
    const { identity, result } = await performModelRead(client, expectedOwner);
    const after = await sourceSnapshot();
    if (!validateFeatureSourceScope(before.sourceScope, after.sourceScope)) {
      fail('MODEL_SOURCE_CHANGED_DURING_READ');
    }
    const ownerHashAfter = sha(expectedOwner.trim().toLowerCase());
    if (ownerHashAfter !== ownerHashBefore) fail('MODEL_OWNER_CHANGED_DURING_READ');
    process.stdout.write(JSON.stringify({
      schema: 'gemini-model-catalog-direct-read-v1',
      service: 'gemini-web',
      operation: 'model_list',
      outcome: 'verified_read',
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      expectedOwnerSha256: ownerHashBefore,
      expectedOwnerSha256AfterRun: ownerHashAfter,
      ownerImmutable: true,
      sessionHandoffVerified: true,
      sourceBeforeImports: {
        contractSha256: before.contractSha256,
        implementationFiles: before.implementationFiles,
        implementationSetSha256: before.implementationSetSha256,
        sourceScope: before.sourceScope,
      },
      sourceAfterRun: {
        contractSha256: after.contractSha256,
        implementationFiles: after.implementationFiles,
        implementationSetSha256: after.implementationSetSha256,
        sourceScope: after.sourceScope,
      },
      sourceStable: true,
      identity: {
        httpStatus: identity.httpStatus,
        contentType: 'text/html',
        responseBytes: identity.responseBytes,
        responseSha256: identity.responseSha256,
        anonymousHttpStatus: identity.anonymousHttpStatus,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        credentialPropagated: identity.credentialPropagated,
        request: identity.request,
      },
      catalog: {
        httpStatus: result.httpStatus,
        contentType: result.contentType,
        responseBytes: result.responseBytes,
        responseSha256: result.responseSha256,
        rpcId: result.rpcId,
        modelCount: result.models.length,
        credentialPropagated: result.credentialPropagated,
        request: result.request,
      },
      valuesPersisted: false,
    }) + '\n');
  } finally {
    if (client?.transport) client.transport.session = null;
    if (client) {
      client.verifiedOwner = null;
      client.modelSelection = null;
    }
    if (packet?.session?.cookies) {
      for (const cookie of packet.session.cookies) cookie.value = '';
      packet.session.cookies.length = 0;
    }
    if (packet?.session) {
      packet.session.headers = {};
      packet.session.requestHeaders = {};
      packet.session.batchContext = {};
    }
    if (packet) {
      packet.expectedOwner = '';
      packet.session = null;
    }
    expectedOwner = '';
  }
}

main().catch((error) => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code : 'MODEL_CATALOG_DIRECT_READ_FAILED';
  process.stdout.write(JSON.stringify({ service: 'gemini-web', operation: 'model_list', verified: false, error: code }) + '\n');
  process.exitCode = 1;
});
