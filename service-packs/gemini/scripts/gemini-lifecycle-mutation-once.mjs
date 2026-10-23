import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiClientError } from '../src/errors.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { validateSessionBundle } from '../src/session.mjs';
import { readConversation, listConversations, extractConversationSummaries, searchConversations } from '../src/conversation-lifecycle.mjs';
import { mutateConversationOnce, reconcileLifecycleMutation } from '../src/lifecycle-mutation.mjs';

const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const ACTIONS = new Set(['rename', 'delete']);
const TOP_KEYS = new Set([
  'session', 'expectedOwner', 'action', 'confirmed', 'callerIntent', 'conversationId',
  'newTitle', 'verificationQuery', 'rpcId', 'args', 'requestCapture',
]);
const CID = /^c_[0-9a-f]{16}$/;

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

async function readEnvelope() {
  if (!stdin || stdin.isTTY === true) fail('LIFECYCLE_MUTATION_ENVELOPE_REQUIRED', 'A one-shot lifecycle mutation envelope must be piped to stdin.');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_ENVELOPE_BYTES) fail('LIFECYCLE_MUTATION_ENVELOPE_TOO_LARGE', 'The one-shot lifecycle mutation envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('LIFECYCLE_MUTATION_ENVELOPE_REQUIRED', 'A one-shot lifecycle mutation envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); fail('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'The one-shot lifecycle mutation envelope is not valid JSON.'); }
  raw.fill(0);
  return validateEnvelope(envelope);
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !TOP_KEYS.has(key))
      || !ACTIONS.has(value.action)
      || value.confirmed !== true
      || typeof value.expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.expectedOwner)
      || typeof value.callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.callerIntent)
      || typeof value.conversationId !== 'string' || !CID.test(value.conversationId)
      || (value.rpcId !== undefined && typeof value.rpcId !== 'string')
      || (value.args !== undefined && !Array.isArray(value.args))
      || (value.requestCapture !== undefined && (!value.requestCapture || typeof value.requestCapture !== 'object'))
      || typeof value.session !== 'object' || !value.session) {
    fail('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'The one-shot lifecycle mutation envelope has an unsupported shape.');
  }
  if (value.action === 'rename'
      && (typeof value.newTitle !== 'string' || !value.newTitle.trim() || value.newTitle.length > 160
        || value.verificationQuery !== value.newTitle)) {
    fail('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'A rename requires a bounded title and matching readback query.');
  }
  if (value.action === 'delete'
      && (typeof value.verificationQuery !== 'string' || !value.verificationQuery.trim() || value.verificationQuery.length > 256)) {
    fail('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'A delete requires the previous title for a bounded absence query.');
  }
  if (value.action === 'rename' && value.rpcId !== undefined && value.rpcId !== 'MUAZcd') {
    fail('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'The rename must use the captured Gemini update RPC.');
  }
  if (value.action === 'delete' && value.rpcId !== undefined && value.rpcId !== 'GzXR5e') {
    fail('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'The delete must use the captured Gemini delete RPC.');
  }
  return value;
}

function wipe(value, depth = 0) {
  if (depth > 20 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) wipe(child, depth + 1);
    value.length = 0;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    wipe(child, depth + 1);
    if (typeof child === 'string' && ['value', 'expectedOwner', 'newTitle', 'verificationQuery', 'conversationId'].includes(key)) {
      value[key] = '';
    }
  }
}

function collectConversationIds(root) {
  const output = new Set();
  const pending = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 100_000) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > 24) continue;
    if (typeof value === 'string') {
      if (CID.test(value)) output.add(value);
      const text = value.trimStart();
      if (text.length <= 2 * 1024 * 1024 && (text.startsWith('[') || text.startsWith('{'))) {
        try { pending.push({ value: JSON.parse(text), depth: depth + 1 }); } catch { /* Plain text. */ }
      }
    } else if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return output;
}

function containsSameRow(root, conversationId, title) {
  const pending = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 100_000) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > 24) continue;
    if (Array.isArray(value)) {
      if (value.includes(conversationId) && value.includes(title)) return true;
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      const values = Object.values(value);
      if (values.includes(conversationId) && values.includes(title)) return true;
      for (const child of values) pending.push({ value: child, depth: depth + 1 });
    } else if (typeof value === 'string') {
      const text = value.trimStart();
      if (text.length <= 2 * 1024 * 1024 && (text.startsWith('[') || text.startsWith('{'))) {
        try { pending.push({ value: JSON.parse(text), depth: depth + 1 }); } catch { /* Plain text. */ }
      }
    }
  }
  return false;
}

export async function runLifecycleMutation(envelope, { contractPath } = {}) {
  validateEnvelope(envelope);
  const contract = await loadObservedContract(contractPath);
  const session = validateSessionBundle(envelope.session, contract);
  const client = new GeminiWebClient({ contract, session });
  try {
    const expectedPayload = envelope.action === 'rename' ? [envelope.newTitle] : [];
    const result = await mutateConversationOnce(client, {
      operationName: envelope.action === 'rename' ? 'edit' : 'delete',
      requestCapture: envelope.requestCapture,
      rpcId: envelope.rpcId,
      args: envelope.args,
      targetConversationId: envelope.conversationId,
      requiredPayloadValues: expectedPayload,
      expectedOwner: envelope.expectedOwner,
      confirmed: envelope.confirmed,
      callerIntent: envelope.callerIntent,
    });

    const detail = envelope.action === 'rename'
      ? await readConversation(client, {
        expectedOwner: envelope.expectedOwner,
        conversationId: envelope.conversationId,
      })
      : null;
    const listed = await listConversations(client, { expectedOwner: envelope.expectedOwner, maxItems: 500 });
    const listSummaries = listed.conversations;
    const sameIdRow = listSummaries.find((row) => row.conversationId === envelope.conversationId);
    const search = await searchConversations(client, {
      expectedOwner: envelope.expectedOwner,
      query: envelope.verificationQuery,
    });
    const searchIds = collectConversationIds(search.data);
    const searchSummaries = extractConversationSummaries(search.data, { maxItems: 100 });
    let readbackVerified;
    if (envelope.action === 'rename') {
      const titlePresent = sameIdRow?.title === envelope.newTitle
        || containsSameRow(search.data, envelope.conversationId, envelope.newTitle)
        || searchSummaries.some((row) => row.conversationId === envelope.conversationId && row.title === envelope.newTitle);
      readbackVerified = titlePresent
        && detail?.summary?.apiConversationIdMatched === true
        && detail?.binding?.bound === true;
    } else {
      readbackVerified = !searchIds.has(envelope.conversationId)
        && !listSummaries.some((row) => row.conversationId === envelope.conversationId);
    }
    let journalState = 'unresolved';
    if (readbackVerified) {
      await reconcileLifecycleMutation(result.journalPath, {
        found: true,
        resultCategory: envelope.action === 'rename' ? 'conversation_rename_readback' : 'conversation_delete_readback',
      });
      journalState = 'reconciled';
    }
    const receipt = Object.freeze({
      operation: envelope.action,
      rpcId: result.rpcId,
      ownerMatched: result.ownerMatched,
      anonymousOwnerAbsent: result.anonymousOwnerAbsent,
      targetConversationIdLength: envelope.conversationId.length,
      preflightConversationIdMatched: result.preflightConversationIdMatched,
      preflightRouteBindingVerified: result.preflightRouteBindingVerified,
      mutationHttpStatus: result.response.httpStatus,
      mutationResponseBytes: result.response.responseBytes,
      mutationResponseSha256: result.response.responseSha256,
      responseContractCaptured: result.response.responseContractCaptured,
      mutationResponseRpcDecoded: result.response.responseRpcDecoded,
      historyDetailHttpStatus: detail?.httpStatus ?? null,
      historyDetailResponseBytes: detail?.responseBytes ?? null,
      historyDetailResponseSha256: detail?.responseSha256 ?? null,
      historyDetailConversationIdMatched: detail?.summary?.apiConversationIdMatched === true,
      historyDetailRouteBindingVerified: detail?.binding?.bound === true,
      historyListHttpStatus: listed.httpStatus,
      historyListContentType: listed.contentType,
      historyListResponseBytes: listed.responseBytes,
      historyListResponseSha256: listed.responseSha256,
      historyListRequest: {
        method: listed.request.method,
        origin: listed.request.origin,
        path: listed.request.path,
        queryKeys: listed.request.queryKeys,
        headerNames: listed.request.headerNames,
        bodyFieldNames: listed.request.formFieldNames,
        contentType: listed.request.contentType,
        valuesPersisted: false,
      },
      historyListSameIdRowPresent: Boolean(sameIdRow),
      historyListTitleLength: sameIdRow?.title?.length ?? null,
      searchHttpStatus: search.httpStatus,
      searchContentType: search.contentType,
      searchResponseBytes: search.responseBytes,
      searchResponseSha256: search.responseSha256,
      searchRequest: {
        method: search.request.method,
        origin: search.request.origin,
        path: search.request.path,
        queryKeys: search.request.queryKeys,
        headerNames: search.request.headerNames,
        bodyFieldNames: search.request.formFieldNames,
        contentType: search.request.contentType,
        valuesPersisted: false,
      },
      searchResultCount: searchIds.size,
      searchTargetIdPresent: searchIds.has(envelope.conversationId),
      readbackVerified,
      journalState,
      journalId: result.jobId,
      intentKeyHash: result.intentKeyHash,
      wireBodyDigest: result.wireBodyDigest,
    });
    if (Array.isArray(listed.data)) listed.data.length = 0;
    if (search.data && typeof search.data === 'object') {
      if (Array.isArray(search.data)) search.data.length = 0;
      else for (const key of Object.keys(search.data)) delete search.data[key];
    }
    if (detail.payload && typeof detail.payload === 'object') {
      if (Array.isArray(detail.payload)) detail.payload.length = 0;
      else for (const key of Object.keys(detail.payload)) delete detail.payload[key];
    }
    for (const id of searchIds) searchIds.delete(id);
    client.transport.session = null;
    return receipt;
  } catch (error) {
    client.transport.session = null;
    throw error;
  }
}

async function main() {
  let envelope;
  try {
    envelope = await readEnvelope();
    const result = await runLifecycleMutation(envelope);
    stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.readbackVerified) process.exitCode = 2;
  } finally {
    wipe(envelope);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
      ? error.code : 'LIFECYCLE_MUTATION_FAILED';
    stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
