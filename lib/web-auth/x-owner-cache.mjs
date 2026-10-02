import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Owner proofs are shared across bot processes on disk. Every X worker used to re-verify through
// /1.1/account/settings.json every five minutes from its own memory, and that endpoint's small rate limit
// (HTTP 429, code 88) then put all workers into cooldown together. Only a hash of handle+auth token is
// stored, never the token; a new token never matches an old proof.
const proofs = new Map();
export const ownerProofTtlMilliseconds = 30 * 60000;
export const ownerProofStaleIfRateLimitedMilliseconds = 6 * 3600000;
const key = (handle, token) => createHash('sha256').update(handle.toLowerCase()).update('\0').update(token).digest('hex');
const defaultFile = () => process.env.NODE_TEST_CONTEXT ? null
  : path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'affiliate-content-operations', 'x-owner-proof-cache.json');
let cacheFile = defaultFile();
export function setXOwnerCacheFile(file) { cacheFile = file; proofs.clear(); }

function readShared() {
  if (!cacheFile) return {};
  try { const value = JSON.parse(readFileSync(cacheFile, 'utf8')); return value?.version === 1 && value.entries && typeof value.entries === 'object' ? value.entries : {}; }
  catch { return {}; }
}
function writeShared(entries) {
  if (!cacheFile) return;
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    renameSync(tmp, cacheFile);
  } catch { /* the in-memory proof still applies */ }
}
const validEntry = entry => entry && Number.isFinite(entry.checkedAt) && typeof entry.proof?.screen_name === 'string' && entry.proof.receipt?.ownerVerified === true;
function lookup(id) {
  return [proofs.get(id), readShared()[id]].filter(validEntry).sort((a, b) => b.checkedAt - a.checkedAt)[0] || null;
}
export function cachedXOwner(handle, token, now = Date.now(), { maxAgeMs = ownerProofTtlMilliseconds } = {}) {
  if (!token) return null;
  const entry = lookup(key(handle, token));
  if (!entry || now < entry.checkedAt || now - entry.checkedAt >= maxAgeMs) return null;
  if (entry.proof.screen_name.toLowerCase() !== handle.toLowerCase()) return null;
  return { ...entry.proof, receipt: { ...entry.proof.receipt, ownerVerificationCached: true, ownerVerifiedAt: new Date(entry.checkedAt).toISOString() } };
}
export function rememberXOwner(handle, token, proof, now = Date.now()) {
  if (!token || proof.screen_name?.toLowerCase() !== handle.toLowerCase() || proof.receipt?.ownerVerified !== true) throw Object.assign(new Error('X_OWNER_CACHE_INPUT'),{code:'X_OWNER_CACHE_INPUT'});
  for(const [id, entry] of proofs) if(now - entry.checkedAt >= ownerProofStaleIfRateLimitedMilliseconds) proofs.delete(id);
  const id = key(handle, token);
  const entry = { proof: { screen_name: proof.screen_name, receipt: { ownerVerified: true, ownerVerificationMethod: proof.receipt.ownerVerificationMethod ?? null } }, checkedAt: now };
  proofs.set(id, entry);
  const shared = readShared();
  for (const [k, v] of Object.entries(shared)) if (!validEntry(v) || now - v.checkedAt >= ownerProofStaleIfRateLimitedMilliseconds) delete shared[k];
  shared[id] = entry;
  writeShared(shared);
}
export function forgetXOwner(handle, token) {
  const id = key(handle, token);
  proofs.delete(id);
  const shared = readShared();
  if (shared[id]) { delete shared[id]; writeShared(shared); }
}
