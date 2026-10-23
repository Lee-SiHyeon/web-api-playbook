#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInMemoryGrokConversationFilesRuntime } from '../src/grok-conversation-files-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = path.join(ROOT, 'verification/grok-conversation-files-create-cid-reconcile-live-2026-10-06.json');
const OWNER_SCOPE = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const MAX_PACKET_BYTES = 2 * 1024 * 1024;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
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
  try { await readFile(filePath); fail('FILES_CID_RECONCILE_RECEIPT_EXISTS'); }
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
    if (size > MAX_PACKET_BYTES) fail('FILES_CID_RECONCILE_PACKET_TOO_LARGE');
    chunks.push(bytes);
  }
  if (!size) fail('FILES_CID_RECONCILE_PACKET_REQUIRED');
  const raw = Buffer.concat(chunks, size);
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { raw.fill(0); fail('FILES_CID_RECONCILE_PACKET_INVALID'); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['sessionBundle', 'expectedIdentity', 'conversationIdSha256'].sort())
      || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
      || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
      || sha256(value.expectedIdentity.trim().toLowerCase()) !== OWNER_SCOPE
      || typeof value.conversationIdSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.conversationIdSha256)) {
    scrub(value);
    fail('FILES_CID_RECONCILE_PACKET_INVALID');
  }
  return value;
}
function metadata(result) {
  return {
    status: result.status,
    responseBytes: result.responseBytes ?? null,
    requestDigest: result.requestDigest ?? null,
    responseDigest: result.rawResponseDigest ?? result.responseDigest ?? null,
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
    if (owner?.ownerVerified !== true || ownerScopeSha256 !== OWNER_SCOPE) fail('FILES_CID_RECONCILE_OWNER_FAILED');

    const listed = await runtime.client.read('conversation.list.read', { pageSize: 100 }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const rows = listed?.data?.conversations;
    if (listed.status !== 200 || !Array.isArray(rows)) fail('FILES_CID_RECONCILE_LIST_FAILED');
    const matches = rows.filter(row => typeof row?.conversationId === 'string'
      && sha256(row.conversationId) === packet.conversationIdSha256);
    if (matches.length !== 1) fail('FILES_CID_RECONCILE_TARGET_NOT_UNIQUE');
    conversationId = matches[0].conversationId;
    const detail = await runtime.client.read('conversation.read', { conversationId }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const detailRow = detail?.data?.conversation;
    if (detail.status !== 200 || detailRow?.conversationId !== conversationId || detailRow.viewerIsOwner !== true
        || detailRow.isReadonly === true || detailRow.isDeleted === true) fail('FILES_CID_RECONCILE_DETAIL_FAILED');
    const nodes = await runtime.client.read('history.response-nodes', { conversationId }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    if (nodes.status !== 200 || !Array.isArray(nodes.data?.responseNodes)
        || !Array.isArray(nodes.data?.inflightResponses)
        || nodes.data.responseNodes.length !== 0 || nodes.data.inflightResponses.length !== 0) {
      fail('FILES_CID_RECONCILE_NOT_EMPTY');
    }
    const receipt = {
      schemaVersion: 1,
      serviceId: 'grok-web',
      operationId: 'conversation.create.task-cid-reconcile',
      recordedAt: new Date().toISOString(),
      status: 'completed',
      ownerVerified: true,
      ownerScopeSha256,
      conversationIdSha256: sha256(conversationId),
      createReceiptPath: 'verification/grok-conversation-files-create-live-2026-10-06.json',
      firstPageSize: 100,
      firstPageCandidateCount: rows.length,
      exactHashMatchCount: matches.length,
      sameOwnerDetailVerified: true,
      responseNodesStatus: nodes.status,
      responseCount: 0,
      inflightCount: 0,
      list: metadata(listed),
      detail: metadata(detail),
      responseNodes: metadata(nodes),
      rawConversationIdPersisted: false,
      rawConversationIdsPersisted: false,
      responseBodiesPersisted: false,
      conversationContentRead: false,
    };
    let shouldWriteReceipt = true;
    try {
      const existing = JSON.parse(await readFile(RECEIPT, 'utf8'));
      if (existing?.operationId !== receipt.operationId || existing.status !== 'completed'
          || existing.ownerScopeSha256 !== ownerScopeSha256
          || existing.conversationIdSha256 !== receipt.conversationIdSha256
          || existing.responseCount !== 0 || existing.inflightCount !== 0) {
        fail('FILES_CID_RECONCILE_RECEIPT_MISMATCH');
      }
      shouldWriteReceipt = false;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (shouldWriteReceipt) await atomicJson(RECEIPT, receipt);
    process.stdout.write(JSON.stringify({
      operationId: receipt.operationId,
      status: receipt.status,
      ownerVerified: true,
      conversationId,
      conversationIdSha256: receipt.conversationIdSha256,
      emptyOwnerTargetVerified: true,
      receiptPath: 'verification/grok-conversation-files-create-cid-reconcile-live-2026-10-06.json',
    }) + '\n');
  } finally {
    conversationId = '';
    if (runtime?.client) await runtime.client.clearSession().catch(() => {});
    if (packet) {
      packet.expectedIdentity = '';
      packet.conversationIdSha256 = '';
      scrub(packet.sessionBundle);
    }
  }
}
main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'FILES_CID_RECONCILE_FAILED';
  process.stdout.write(JSON.stringify({ operationId: 'conversation.create.task-cid-reconcile',
    status: 'needs_review', errorCode: code, rawIdentifiersPersisted: false, retryAllowed: false }) + '\n');
  process.exitCode = 1;
});
