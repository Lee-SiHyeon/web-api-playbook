#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createInMemoryGrokConversationFilesRuntime } from '../src/grok-conversation-files-runtime.mjs';

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
async function readPacket() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PACKET_BYTES) fail('FILES_CID_LOCATE_PACKET_TOO_LARGE');
    chunks.push(bytes);
  }
  if (!size) fail('FILES_CID_LOCATE_PACKET_REQUIRED');
  const raw = Buffer.concat(chunks, size);
  let packet;
  try { packet = JSON.parse(raw.toString('utf8')); } catch { raw.fill(0); fail('FILES_CID_LOCATE_PACKET_INVALID'); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || JSON.stringify(Object.keys(packet).sort()) !== JSON.stringify(['sessionBundle', 'expectedIdentity', 'conversationIdSha256'].sort())
      || !packet.sessionBundle || typeof packet.sessionBundle !== 'object' || Array.isArray(packet.sessionBundle)
      || typeof packet.expectedIdentity !== 'string' || !packet.expectedIdentity.trim()
      || sha256(packet.expectedIdentity.trim().toLowerCase()) !== OWNER_SCOPE
      || typeof packet.conversationIdSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packet.conversationIdSha256)) {
    scrub(packet);
    fail('FILES_CID_LOCATE_PACKET_INVALID');
  }
  return packet;
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
    if (owner?.ownerVerified !== true || ownerScopeSha256 !== OWNER_SCOPE) fail('FILES_CID_LOCATE_OWNER_FAILED');
    const list = await runtime.client.read('conversation.list.read', { pageSize: 100 }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const rows = list?.data?.conversations;
    if (list.status !== 200 || !Array.isArray(rows)) fail('FILES_CID_LOCATE_LIST_FAILED');
    const candidates = rows.filter(row => typeof row?.conversationId === 'string'
      && sha256(row.conversationId) === packet.conversationIdSha256);
    if (candidates.length !== 1) fail('FILES_CID_LOCATE_TARGET_NOT_UNIQUE');
    conversationId = candidates[0].conversationId;
    const detail = await runtime.client.read('conversation.read', { conversationId }, {
      expectedOwnerScopeSha256: ownerScopeSha256,
    });
    const row = detail?.data?.conversation;
    if (detail.status !== 200 || row?.conversationId !== conversationId || row.viewerIsOwner !== true
        || row.isReadonly === true) fail('FILES_CID_LOCATE_DETAIL_FAILED');
    process.stdout.write(JSON.stringify({
      operationId: 'conversation.create.task-cid-locate',
      status: 'completed',
      ownerVerified: true,
      conversationId,
      conversationIdSha256: packet.conversationIdSha256,
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
    ? error.code : 'FILES_CID_LOCATE_FAILED';
  process.stdout.write(JSON.stringify({ operationId: 'conversation.create.task-cid-locate',
    status: 'needs_review', errorCode: code, rawIdentifiersPersisted: false, retryAllowed: false }) + '\n');
  process.exitCode = 1;
});
