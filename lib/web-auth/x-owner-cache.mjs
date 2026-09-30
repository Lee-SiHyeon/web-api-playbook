import { createHash } from 'node:crypto';
const proofs = new Map();
export const ownerProofTtlMilliseconds = 300000;
const key = (handle, token) => createHash('sha256').update(handle.toLowerCase()).update('\0').update(token).digest('hex');
export function cachedXOwner(handle, token, now = Date.now()) {
  const entry = proofs.get(key(handle, token));
  if (!entry || now < entry.checkedAt || now - entry.checkedAt >= ownerProofTtlMilliseconds) return null;
  return { ...entry.proof, receipt: { ...entry.proof.receipt, ownerVerificationCached: true, ownerVerifiedAt: new Date(entry.checkedAt).toISOString() } };
}
export function rememberXOwner(handle, token, proof, now = Date.now()) {
  if (!token || proof.screen_name?.toLowerCase() !== handle.toLowerCase() || proof.receipt?.ownerVerified !== true) throw Object.assign(new Error('X_OWNER_CACHE_INPUT'),{code:'X_OWNER_CACHE_INPUT'});
  for(const [id, entry] of proofs) if(now - entry.checkedAt >= ownerProofTtlMilliseconds) proofs.delete(id);
  proofs.set(key(handle, token), { proof, checkedAt: now });
}
export function forgetXOwner(handle, token) { proofs.delete(key(handle, token)); }
