import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFICATION_ROOT = path.join(REPO_ROOT, 'verification');
const NAME_PATTERN = /^grok-attachment-upload-api-(?:live-\d{4}-\d{2}-\d{2}(?:-[a-f0-9]{16})?|test-[0-9]+)\.json$/;
const PRIVATE_KEY = /^(?:cookieValue|sso|token|secret|signature|assetUrl|fileUri|fileMetadataId|uploadId|assetId|expectedIdentity|serviceJobId)$/i;

function assertSafeReceipt(value, depth = 0) {
  if (depth > 16) throw fail('ATTACHMENT_AUDIT_DEPTH_LIMIT');
  if (Array.isArray(value)) {
    for (const item of value) assertSafeReceipt(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /https?:\/\//i.test(value)) throw fail('ATTACHMENT_AUDIT_URL_REJECTED');
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) throw fail('ATTACHMENT_AUDIT_PRIVATE_FIELD_REJECTED');
    assertSafeReceipt(child, depth + 1);
  }
}

export async function persistGrokAttachmentApiAudit(value, { fileName = 'grok-attachment-upload-api-live-2026-10-06.json' } = {}) {
  if (!NAME_PATTERN.test(fileName) || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('ATTACHMENT_AUDIT_INPUT_INVALID');
  }
  assertSafeReceipt(value);
  await mkdir(VERIFICATION_ROOT, { recursive: true, mode: 0o700 });
  const target = path.join(VERIFICATION_ROOT, fileName);
  try { await lstat(target); throw fail('ATTACHMENT_AUDIT_ALREADY_EXISTS'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = path.join(VERIFICATION_ROOT, `.${fileName}.${process.pid}.${Date.now()}.partial`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  // link is atomic and fails if another writer created target after lstat.
  // Unlike rename it cannot silently replace the earlier audit receipt.
  try { await link(temporary, target); await unlink(temporary); }
  catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}
