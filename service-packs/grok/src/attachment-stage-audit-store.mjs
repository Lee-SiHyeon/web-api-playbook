import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';

const PRIVATE_FIELD = /^(?:cookieValue|sso|token|secret|signature|assetUrl|fileUri|fileMetadataId|uploadId|assetId|expectedIdentity|serviceJobId|body|responseBody|requestBody|url|etag)$/i;

function assertSafe(value, depth = 0) {
  if (depth > 16) throw fail('ATTACHMENT_STAGE_AUDIT_INVALID');
  if (Array.isArray(value)) return value.forEach(item => assertSafe(item, depth + 1));
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_FIELD.test(key)) throw fail('ATTACHMENT_STAGE_AUDIT_PRIVATE_FIELD');
      assertSafe(child, depth + 1);
    }
  } else if (typeof value === 'string' && /https?:\/\//i.test(value)) {
    throw fail('ATTACHMENT_STAGE_AUDIT_PRIVATE_FIELD');
  }
}

/** Default immutable response checkpoints contain metadata only, never signed URLs or file references. */
export async function persistGrokAttachmentStageAudit(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || typeof receipt.stageKey !== 'string' || receipt.stageKey.length > 256
    || typeof receipt.checkpoint !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(receipt.checkpoint)) {
    throw fail('ATTACHMENT_STAGE_AUDIT_INVALID');
  }
  assertSafe(receipt);
  const root = path.join(homedir(), '.nad-scratch', 'grok-attachment-stage-audits');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = createHash('sha256').update(receipt.stageKey).digest('hex');
  const filePath = path.join(root, `${stage}-${receipt.checkpoint}-${randomUUID()}.json`);
  const temporary = `${filePath}.partial`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt) + '\n');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try { await link(temporary, filePath); }
  finally { await unlink(temporary).catch(() => {}); }
  return filePath;
}
