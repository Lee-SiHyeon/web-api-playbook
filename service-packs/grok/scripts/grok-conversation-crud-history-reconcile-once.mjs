#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInMemoryGrokConversationRuntime } from '../src/runtime.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_PATH = path.join(REPO, 'verification/grok-conversation-crud-history-reconciliation-2026-10-06.json');
const MAX_PACKET_BYTES = 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function scrub(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else scrub(value[index], seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else scrub(value[key], seen);
  }
}

async function readPacket() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_PACKET_BYTES) fail('CRUD_READBACK_PACKET_TOO_LARGE');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('CRUD_READBACK_PACKET_REQUIRED');
  const raw = Buffer.concat(chunks, length);
  let packet;
  try { packet = JSON.parse(raw.toString('utf8')); } catch { raw.fill(0); fail('CRUD_READBACK_PACKET_INVALID'); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  const expectedKeys = ['baselineIdSetSha256', 'expectedIdentity', 'expectedOwnerScopeDigest', 'sessionBundle'];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || Object.keys(packet).sort().join(',') !== expectedKeys.join(',')
      || typeof packet.expectedIdentity !== 'string'
      || typeof packet.expectedOwnerScopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(packet.expectedOwnerScopeDigest)
      || typeof packet.baselineIdSetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packet.baselineIdSetSha256)
      || !packet.sessionBundle || typeof packet.sessionBundle !== 'object') {
    scrub(packet);
    fail('CRUD_READBACK_PACKET_INVALID');
  }
  return packet;
}

async function atomicJson(value) {
  await mkdir(path.dirname(RECEIPT_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${RECEIPT_PATH}.${process.pid}.pending`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, RECEIPT_PATH);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  let packet;
  let runtime;
  try {
    packet = await readPacket();
    let existing;
    try { existing = await readFile(RECEIPT_PATH); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (existing) fail('CRUD_HISTORY_RECONCILE_RECEIPT_ALREADY_EXISTS');
    runtime = await createInMemoryGrokConversationRuntime({
      pythonExecutable: '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python',
    });
    await runtime.client.importSession(packet.sessionBundle);
    const owner = await runtime.client.verifyOwner(packet.expectedIdentity);
    if (owner?.ownerVerified !== true || owner?.source !== 'direct_http_identity_read') fail('CRUD_READBACK_OWNER_VERIFICATION_FAILED');
    const sessionState = await runtime.sessionPersistence.read();
    const ownerScopeDigest = sessionState?.session?.ownerBinding?.identityDigest;
    if (ownerScopeDigest !== packet.expectedOwnerScopeDigest) fail('CRUD_READBACK_OWNER_SCOPE_CHANGED');

    const ids = new Set();
    const seenTokens = new Set();
    let token;
    let pages = 0;
    let rowCount = 0;
    let duplicateIdCount = 0;
    let status = null;
    let complete = false;
    for (; pages < 20; pages += 1) {
      const result = await runtime.conversations.list({ pageSize: 1_000, ...(token ? { pageToken: token } : {}) });
      status = result?.status ?? null;
      if (status !== 200 || !Array.isArray(result?.data?.conversations)) fail('CRUD_READBACK_HISTORY_LIST_FAILED');
      for (const row of result.data.conversations) {
        if (!row || typeof row.conversationId !== 'string' || !row.conversationId) fail('CRUD_READBACK_HISTORY_SHAPE_INVALID');
        rowCount += 1;
        if (ids.has(row.conversationId)) duplicateIdCount += 1;
        ids.add(row.conversationId);
      }
      const next = result.data.nextPageToken;
      scrub(result.data);
      if (typeof next !== 'string' || !next) { complete = true; pages += 1; break; }
      if (seenTokens.has(next)) fail('CRUD_READBACK_CURSOR_CYCLE');
      seenTokens.add(next);
      token = next;
    }
    const currentIdSetSha256 = sha256(JSON.stringify([...ids].sort()));
    const idSetMatchesBaseline = complete && duplicateIdCount === 0
      && currentIdSetSha256 === packet.baselineIdSetSha256;
    const receipt = {
      schemaVersion: 1,
      operationId: 'conversation.crud.history-reconcile',
      status: idSetMatchesBaseline ? 'verified' : 'needs_review',
      ownerVerified: true,
      ownerScopeDigest,
      historyListStatus: status,
      completePagination: complete,
      pageCount: pages,
      conversationCount: ids.size,
      observedRowCount: rowCount,
      duplicateIdCount,
      baselineConversationIdSetSha256: packet.baselineIdSetSha256,
      currentConversationIdSetSha256: currentIdSetSha256,
      conversationIdSetMatchesBaseline: idSetMatchesBaseline,
      conversationIdsPersisted: false,
      titlesPersisted: false,
      responseBodiesPersisted: false,
      expectedIdentityPersisted: false,
      cookiesOrTokensPersisted: false,
      deleteWasNotRetried: true,
      detail404WasNotRequiredBySoftDeleteContract: true,
    };
    await atomicJson(receipt);
    process.stdout.write(`${JSON.stringify({
      status: receipt.status,
      operationId: receipt.operationId,
      ownerVerified: receipt.ownerVerified,
      historyListStatus: receipt.historyListStatus,
      completePagination: receipt.completePagination,
      pageCount: receipt.pageCount,
      conversationCount: receipt.conversationCount,
      baselineSetMatched: receipt.conversationIdSetMatchesBaseline,
      receiptPath: 'verification/grok-conversation-crud-history-reconciliation-2026-10-06.json',
      conversationIdsPersisted: false,
    })}\n`);
    if (receipt.status !== 'verified') process.exitCode = 1;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
      ? error.code : 'CRUD_HISTORY_RECONCILE_FAILED';
    process.stdout.write(`${JSON.stringify({ status: 'needs_review', operationId: 'conversation.crud.history-reconcile', errorCode: code,
      directMutationRequests: 0, rawConversationIdPersisted: false })}\n`);
    process.exitCode = 1;
  } finally {
    if (runtime?.client) await runtime.client.clearSession().catch(() => {});
    if (packet) {
      packet.expectedIdentity = '';
      packet.expectedOwnerScopeDigest = '';
      packet.baselineIdSetSha256 = '';
      scrub(packet.sessionBundle);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
