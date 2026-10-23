import { createHash } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { buildHistoryDetailRequest } from '../src/history-detail.mjs';
import { readGeminiHistoryTurnResponse } from '../src/history-turn-response.mjs';
import { readSessionBundleFromStdin } from '../src/session.mjs';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const CID = /^c_[0-9a-f]{16}$/;
const sha = (value) => createHash('sha256').update(value).digest('hex');

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function wipeTree(value, depth = 0) {
  if (depth > 32 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else wipeTree(value[index], depth + 1);
    }
    value.length = 0;
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else wipeTree(value[key], depth + 1);
    delete value[key];
  }
}

async function readPacket() {
  if (!stdin || stdin.isTTY === true) fail('LIFECYCLE_DETAIL_ENVELOPE_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) fail('LIFECYCLE_DETAIL_ENVELOPE_TOO_LARGE');
    chunks.push(Buffer.from(bytes));
  }
  if (!size) fail('LIFECYCLE_DETAIL_ENVELOPE_REQUIRED');
  const raw = Buffer.concat(chunks, size);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { fail('LIFECYCLE_DETAIL_ENVELOPE_INVALID'); }
  finally {
    raw.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function ReadableFromPacket(session) {
  const serialized = JSON.stringify(session);
  return Object.assign((async function* yieldText() { yield serialized; })(), { isTTY: false });
}

function requestMetadata(requestSpec, operation, headers) {
  return {
    method: requestSpec.method,
    origin: operation.request.origin,
    path: requestSpec.path,
    queryKeys: requestSpec.query.map(([name]) => name),
    headerNames: [...new Set([...Object.keys(headers), 'content-type'].map((name) => name.toLowerCase()))].sort(),
    bodyFieldNames: [...new URLSearchParams(requestSpec.body).keys()],
    contentType: requestSpec.contentType,
    valuesPersisted: false,
  };
}

async function run(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || Object.keys(packet).some((key) => !['session', 'expectedOwner', 'apiConversationId', 'expectedPrompt'].includes(key))
      || typeof packet.expectedOwner !== 'string' || typeof packet.expectedPrompt !== 'string'
      || !packet.expectedPrompt.trim() || packet.expectedPrompt.length > 8000 || /[\0]/.test(packet.expectedPrompt)
      || typeof packet.apiConversationId !== 'string' || !CID.test(packet.apiConversationId)) fail('LIFECYCLE_DETAIL_ENVELOPE_INVALID');
  const ownerSha256 = sha(packet.expectedOwner.trim().toLowerCase());
  if (ownerSha256 !== OWNER_SHA256) fail('EXPECTED_OWNER_NOT_UNIQUE');
  const contract = await loadObservedContract();
  const session = await readSessionBundleFromStdin(contract, {
    input: ReadableFromPacket(packet.session), maxBytes: MAX_INPUT_BYTES,
  });
  const client = new GeminiWebClient({ contract, session });
  let detail;
  try {
    const identity = await client.refreshSession(packet.expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) fail('OWNER_VERIFICATION_FAILED');
    const operation = contract.operations.history_read;
    const requestId = String(client.nextHistoryRequestId);
    const built = buildHistoryDetailRequest(contract, client.transport.session, {
      apiConversationId: packet.apiConversationId,
      visibleRouteId: packet.apiConversationId.slice(2),
      requestId,
    });
    detail = await client.readHistoryDetail({
      apiConversationId: packet.apiConversationId,
      visibleRouteId: packet.apiConversationId.slice(2),
      expectedIntent: packet.expectedPrompt,
    });
    const sourceTurn = detail.payload
      ? readGeminiHistoryTurnResponse(detail.payload, { prompt: packet.expectedPrompt }) : null;
    const exactPromptMatched = sourceTurn?.matched === true && sourceTurn.exactPromptTurnCount === 1;
    return {
      operation: 'history_read',
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      httpStatus: detail.httpStatus,
      contentType: detail.contentType,
      responseBytes: detail.responseBytes,
      responseSha256: detail.responseSha256,
      credentialPropagated: detail.credentialPropagated,
      responseFraming: detail.summary?.framing ?? null,
      responseFrameCount: detail.summary?.frameCount ?? 0,
      responseRpcMatchCount: detail.summary?.rpcMatchCount ?? 0,
      apiConversationIdEchoMatched: detail.summary?.apiConversationIdMatched === true,
      routeBindingVerified: detail.binding?.bound === true && detail.binding?.rawApiIdUsedInRequest === true
        && detail.binding?.prefixRemovedFromRequest === false,
      taskPromptMatched: detail.summary?.taskIntentMatched === true && exactPromptMatched,
      structuredContentPresent: sourceTurn?.structuredContentPresent === true,
      structuredTextCandidateCount: sourceTurn?.structuredTextCandidateCount ?? 0,
      structuredSourceShapeComplete: sourceTurn?.structuredSourceShapeComplete === true,
      request: requestMetadata(built.requestSpec, operation,
        client.transport.session.requestHeaders?.history_read ?? client.transport.session.requestHeaders?.history_list ?? {}),
      secretsOrContentPersisted: false,
    };
  } finally {
    client.transport.session = null;
    if (detail?.payload) wipeTree(detail.payload);
    packet.expectedOwner = '';
    packet.expectedPrompt = '';
    packet.apiConversationId = '';
    packet.session = null;
  }
}

async function main() {
  let packet;
  try {
    packet = await readPacket();
    stdout.write(JSON.stringify(await run(packet)) + '\n');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'LIFECYCLE_DETAIL_READ_FAILED';
    stdout.write(JSON.stringify({ operation: 'history_read', verified: false, error: code,
      secretsOrContentPersisted: false }) + '\n');
    process.exitCode = 1;
  } finally {
    if (packet) wipeTree(packet);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
