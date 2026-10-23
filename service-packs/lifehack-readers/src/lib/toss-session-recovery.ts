import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from './supabase/admin';
import { deriveServiceSessionOwnerDigest } from './service-session-crypto';
import { validateTossBundle, type TossSessionState } from './toss-session-core';
const TABLE = 'toss_http_login_attempts';
export const TOSS_RECOVERY_RECEIPT = 'TOSS_WEB_COOKIE_RECOVERY';
const MAX_AGE_MS = 15 * 60_000;
function owner() {
  const email = process.env.TOSS_SHARELINK_OWNER_EMAIL?.trim().toLowerCase();
  if (!email || process.env.VERCEL !== '1' || process.env.VERCEL_ENV !== 'production') throw Error('TOSS_RECOVERY_SCOPE_REQUIRED');
  return { email, digest: deriveServiceSessionOwnerDigest(email, 'toss_sharelink') };
}
function key(): Buffer {
  const value = Buffer.from(process.env.SESSION_VAULT_KEY ?? '', 'base64url');
  if (value.length !== 32) { value.fill(0); throw Error('TOSS_RECOVERY_KEY_REQUIRED'); }
  return value;
}
function aad(digest: string, id: string, revision: number): Buffer {
  return Buffer.from(`toss/web-cookie-recovery/v1/${digest}/${id}/${revision}`);
}
/** Quarantined, expiring retry material. This never grants ready status or permits business writes. */
export async function saveTossCookieRecovery(bytes: Uint8Array, revision: number, expiresAt = Date.now() + MAX_AGE_MS): Promise<boolean> {
  const identity = owner();
  if (!Number.isSafeInteger(revision) || revision < 1) throw Error('TOSS_RECOVERY_REVISION_INVALID');
  const state = JSON.parse(Buffer.from(bytes).toString()) as TossSessionState;
  if (state.version !== 1 || state.provider !== 'toss_sharelink' || state.ownerEmail !== identity.email) throw Error('TOSS_RECOVERY_OWNER_MISMATCH');
  validateTossBundle(state.bundle);
  const id = randomUUID(), iv = randomBytes(12), secret = key();
  let envelope;
  try {
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(aad(identity.digest, id, revision));
    envelope = { iv: iv.toString('base64url'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  } finally { secret.fill(0); for (const cookie of state.bundle.cookies) cookie.value = ''; }
  const db = getSupabaseAdminClient();
  await db.from(TABLE).update({ status: 'rejected', encrypted_context: {} }).eq('owner_digest', identity.digest)
    .eq('receipt->>code', TOSS_RECOVERY_RECEIPT).lt('expires_at', new Date().toISOString());
  const saved = await db.from(TABLE).insert({ id, owner_digest: identity.digest, session_revision: revision,
    status: 'needs_reconciliation', encrypted_context: envelope,
    receipt: { code: TOSS_RECOVERY_RECEIPT, ready: false, stored: false, ownerVerified: false, revision },
    expires_at: new Date(Math.min(expiresAt, Date.now() + MAX_AGE_MS)).toISOString() });
  return !saved.error;
}
export async function loadTossCookieRecovery(revision: number): Promise<{ id: string; bytes: Buffer; expiresAt: number } | null> {
  const identity = owner(), db = getSupabaseAdminClient();
  await db.from(TABLE).update({ status: 'rejected', encrypted_context: {} }).eq('owner_digest', identity.digest)
    .eq('receipt->>code', TOSS_RECOVERY_RECEIPT).lt('expires_at', new Date().toISOString());
  const found = await db.from(TABLE).select('id,encrypted_context,created_at,expires_at,session_revision')
    .eq('owner_digest', identity.digest).eq('receipt->>code', TOSS_RECOVERY_RECEIPT)
    .eq('status', 'needs_reconciliation').eq('session_revision', revision)
    .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (found.error || !found.data) return null;
  const row = found.data, age = Date.now() - Date.parse(row.created_at);
  if (!Number.isFinite(age) || age < -5000 || age > MAX_AGE_MS || Date.parse(row.expires_at) - Date.parse(row.created_at) > MAX_AGE_MS + 5000) return null;
  const envelope = row.encrypted_context, secret = key();
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad(identity.digest, row.id, revision)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return { id: row.id, bytes: Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]), expiresAt: Date.parse(row.expires_at) };
  } finally { secret.fill(0); }
}
export async function clearTossCookieRecovery(): Promise<void> {
  const identity = owner();
  await getSupabaseAdminClient().from(TABLE).update({ status: 'rejected', encrypted_context: {} })
    .eq('owner_digest', identity.digest).eq('receipt->>code', TOSS_RECOVERY_RECEIPT).eq('status', 'needs_reconciliation');
}
