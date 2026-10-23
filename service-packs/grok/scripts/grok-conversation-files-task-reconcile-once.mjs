#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInMemoryGrokConversationFilesRuntime } from '../src/grok-conversation-files-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = path.join(ROOT, 'verification/grok-conversation-files-task-cid-reconcile-live-2026-10-06.json');
const OWNER_SCOPE = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const EXPECTED_FILE_NAME = '07b2d9f8b7b4b2abfa1afcd2e5dce663.csv';
const MAX_PACKET_BYTES = 2 * 1024 * 1024;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function scrub(value, depth = 0, seen = new Set()) {
  if (depth > 24 || !value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else scrub(value[index], depth + 1, seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else scrub(value[key], depth + 1, seen);
  }
}
async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { await readFile(filePath); fail('FILES_TASK_RECONCILE_RECEIPT_EXISTS'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
async function readPacket() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PACKET_BYTES) fail('FILES_TASK_RECONCILE_PACKET_TOO_LARGE');
    chunks.push(bytes);
  }
  if (!size) fail('FILES_TASK_RECONCILE_PACKET_REQUIRED');
  const raw = Buffer.concat(chunks, size);
  let packet;
  try { packet = JSON.parse(raw.toString('utf8')); } catch { raw.fill(0); fail('FILES_TASK_RECONCILE_PACKET_INVALID'); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!plainObject(packet)
      || JSON.stringify(Object.keys(packet).sort()) !== JSON.stringify([
        'sessionBundle', 'expectedIdentity', 'conversationIdSha256', 'expectedPrompt', 'fileName',
      ].sort())
      || !plainObject(packet.sessionBundle)
      || typeof packet.expectedIdentity !== 'string' || !packet.expectedIdentity.trim()
      || sha256(packet.expectedIdentity.trim().toLowerCase()) !== OWNER_SCOPE
      || typeof packet.conversationIdSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packet.conversationIdSha256)
      || typeof packet.expectedPrompt !== 'string' || !packet.expectedPrompt.trim()
      || Buffer.byteLength(packet.expectedPrompt) > 4096
      || packet.fileName !== EXPECTED_FILE_NAME) {
    scrub(packet);
    fail('FILES_TASK_RECONCILE_PACKET_INVALID');
  }
  return packet;
}
function metadata(result) {
  return {
    status: result.status,
    responseBytes: result.responseBytes ?? null,
    requestDigest: result.requestDigest ?? null,
    responseDigest: result.rawResponseDigest ?? result.responseDigest ?? null,
  };
}
function senderKind(value) {
  const sender = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['user', 'human', 'you'].includes(sender)) return 'user';
  if (['assistant', 'model'].includes(sender)) return 'assistant';
  return 'other';
}
function responseIdsFrom(data) {
  if (!plainObject(data) || !Array.isArray(data.responseNodes) || !Array.isArray(data.inflightResponses)
      || data.responseNodes.length > 256 || data.inflightResponses.length > 256
      || data.responseNodes.some(row => !plainObject(row) || typeof row.responseId !== 'string')) {
    throw fail('FILES_TASK_RECONCILE_NODES_INVALID');
  }
  const ids = data.responseNodes.map(row => row.responseId);
  if (new Set(ids).size !== ids.length) throw fail('FILES_TASK_RECONCILE_NODES_INVALID');
  return ids;
}
function summarizeResponse(row, expectedPrompt, expectedFileName) {
  const message = typeof row.message === 'string' ? row.message : null;
  const responseId = row.responseId;
  const parentId = typeof row.parentResponseId === 'string' ? row.parentResponseId : null;
  return {
    sender: senderKind(row.sender),
    responseIdSha256: typeof responseId === 'string' ? sha256(responseId) : null,
    parentResponseIdSha256: parentId ? sha256(parentId) : null,
    messageSha256: message === null ? null : sha256(message),
    messageBytes: message === null ? null : Buffer.byteLength(message),
    exactTaskPromptMatched: senderKind(row.sender) === 'user' && message === expectedPrompt,
    taskFileNameMentioned: message === null ? false : message.includes(expectedFileName),
    createdAt: typeof row.createTime === 'string' ? row.createTime
      : typeof row.createdAt === 'string' ? row.createdAt : null,
  };
}
async function listFiles(files, conversationId, ownerScopeSha256) {
  const result = await files.listFiles({ conversationId, path: '/', pageSize: 100 }, {
    expectedOwnerScopeSha256: ownerScopeSha256,
  });
  const entries = result.files;
  const matching = entries.filter(file => !file.isDirectory && file.name === EXPECTED_FILE_NAME);
  const otherFiles = entries.filter(file => !file.isDirectory && file.name !== EXPECTED_FILE_NAME);
  return {
    status: result.status,
    responseBytes: result.responseBytes,
    requestDigest: result.requestDigest,
    responseDigest: result.rawResponseDigest ?? result.responseDigest,
    entryCount: entries.length,
    fileCount: entries.filter(file => !file.isDirectory).length,
    directoryCount: entries.filter(file => file.isDirectory).length,
    expectedFileMatchCount: matching.length,
    otherFileCount: otherFiles.length,
    fileNamesPersisted: false,
    filePathsPersisted: false,
  };
}

async function main() {
  let packet;
  let runtime;
  let conversationId = '';
  try {
    packet = await readPacket();
    runtime = await createInMemoryGrokConversationFilesRuntime({});
    await runtime.client.importSession(packet.sessionBundle);
    const owner = await runtime.client.verifyOwner(packet.expectedIdentity);
    const stored = await runtime.sessionPersistence.read();
    const ownerScopeSha256 = stored?.session?.ownerBinding?.identityDigest;
    if (owner?.ownerVerified !== true || ownerScopeSha256 !== OWNER_SCOPE) fail('FILES_TASK_RECONCILE_OWNER_FAILED');

    const listed = await runtime.client.read('conversation.list.read', { pageSize: 100 }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const rows = listed?.data?.conversations;
    if (listed.status !== 200 || !Array.isArray(rows)) fail('FILES_TASK_RECONCILE_LIST_FAILED');
    const matches = rows.filter(row => typeof row?.conversationId === 'string'
      && sha256(row.conversationId) === packet.conversationIdSha256);
    if (matches.length !== 1) fail('FILES_TASK_RECONCILE_TARGET_NOT_UNIQUE');
    conversationId = matches[0].conversationId;

    const detail = await runtime.client.read('conversation.read', { conversationId }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const conversation = detail?.data?.conversation;
    if (detail.status !== 200 || conversation?.conversationId !== conversationId
        || conversation.viewerIsOwner !== true || conversation.isReadonly === true) {
      fail('FILES_TASK_RECONCILE_DETAIL_FAILED');
    }
    const nodes = await runtime.client.read('history.response-nodes', { conversationId }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const responseIds = responseIdsFrom(nodes?.data);
    if (nodes.status !== 200 || nodes.data.inflightResponses.length > 0) fail('FILES_TASK_RECONCILE_INFLIGHT_PRESENT');
    let loaded = null;
    let responses = [];
    if (responseIds.length > 0) {
      loaded = await runtime.client.read('history.load-responses', { conversationId, responseIds }, {
        expectedOwnerScopeSha256: ownerScopeSha256,
      });
      responses = loaded?.data?.responses;
      if (loaded.status !== 200 || !Array.isArray(responses)) fail('FILES_TASK_RECONCILE_LOAD_FAILED');
    }
    const rowSummaries = responses.map(row => summarizeResponse(row, packet.expectedPrompt, packet.fileName));
    const userRows = responses.filter(row => senderKind(row.sender) === 'user');
    const assistantRows = responses.filter(row => senderKind(row.sender) === 'assistant');
    const exactPromptRows = userRows.filter(row => row.message === packet.expectedPrompt);
    const matchingFiles = await listFiles(runtime.files, conversationId, ownerScopeSha256).catch(error => ({
      status: Number.isInteger(error?.details?.status) ? error.details.status : null,
      errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
        ? error.code : 'FILES_TASK_RECONCILE_FILES_LIST_FAILED',
      expectedFileMatchCount: null,
      fileCount: null,
      entryCount: null,
      fileNamesPersisted: false,
      filePathsPersisted: false,
    }));
    const exactUsers = exactPromptRows.length;
    const parentMatches = exactPromptRows.length === 1
      ? assistantRows.filter(row => row.parentResponseId === exactPromptRows[0].responseId).length : 0;
    const receipt = {
      schemaVersion: 1,
      serviceId: 'grok-web',
      operationId: 'conversation.files.task-cid-reconcile',
      recordedAt: new Date().toISOString(),
      status: 'completed',
      ownerVerified: true,
      ownerScopeSha256,
      conversationIdSha256: sha256(conversationId),
      createReceiptPath: 'verification/grok-conversation-files-create-live-2026-10-06.json',
      cidRecoveryReceiptPath: 'verification/grok-conversation-files-create-cid-reconcile-live-2026-10-06.json',
      expectedPromptSha256: sha256(packet.expectedPrompt),
      expectedPromptBytes: Buffer.byteLength(packet.expectedPrompt),
      expectedFileNameSha256: sha256(packet.fileName),
      list: { ...metadata(listed), pageSize: 100, candidateCount: rows.length, exactHashMatchCount: matches.length },
      detail: { ...metadata(detail), viewerIsOwner: true },
      responseNodes: { ...metadata(nodes), responseCount: responseIds.length, inflightCount: nodes.data.inflightResponses.length },
      loadResponses: loaded ? { ...metadata(loaded), responseCount: responses.length } : null,
      historySemanticSummary: {
        userResponseCount: userRows.length,
        assistantResponseCount: assistantRows.length,
        exactPromptUserResponseCount: exactUsers,
        assistantChildOfExactPromptUserCount: parentMatches,
        responses: rowSummaries,
        rawMessageBodiesPersisted: false,
        rawResponseIdsPersisted: false,
      },
      filesList: matchingFiles,
      sourceCodeSnapshotSha256: {
        continuation: sha256(await readFile(path.join(ROOT, 'src/grok-conversation-continuation.mjs'))),
        fileClient: sha256(await readFile(path.join(ROOT, 'src/grok-conversation-files.mjs'))),
      },
      persistenceAssertions: {
        credentialsPersisted: false,
        cookiesPersisted: false,
        rawConversationIdsPersisted: false,
        rawResponseIdsPersisted: false,
        promptPersisted: false,
        assistantTextPersisted: false,
        fileNamesPersisted: false,
        filePathsPersisted: false,
      },
    };
    await atomicJson(RECEIPT, receipt);
    process.stdout.write(JSON.stringify({
      operationId: receipt.operationId,
      status: receipt.status,
      ownerVerified: true,
      conversationIdSha256: receipt.conversationIdSha256,
      responseNodeCount: receipt.responseNodes.responseCount,
      userResponseCount: userRows.length,
      assistantResponseCount: assistantRows.length,
      exactTaskPromptMatched: exactUsers === 1,
      assistantParentMatched: parentMatches === 1,
      fileApiStatus: matchingFiles.status,
      expectedFileMatchCount: matchingFiles.expectedFileMatchCount,
      receiptPath: 'verification/grok-conversation-files-task-cid-reconcile-live-2026-10-06.json',
      rawIdentifiersPersisted: false,
      rawBodiesPersisted: false,
    }) + '\n');
  } finally {
    conversationId = '';
    if (runtime?.client) await runtime.client.clearSession().catch(() => {});
    if (packet) {
      packet.expectedIdentity = '';
      packet.conversationIdSha256 = '';
      packet.expectedPrompt = '';
      packet.fileName = '';
      scrub(packet.sessionBundle);
    }
  }
}

main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'FILES_TASK_RECONCILE_FAILED';
  process.stdout.write(JSON.stringify({ operationId: 'conversation.files.task-cid-reconcile',
    status: 'needs_review', errorCode: code, rawIdentifiersPersisted: false, retryAllowed: false }) + '\n');
  process.exitCode = 1;
});
