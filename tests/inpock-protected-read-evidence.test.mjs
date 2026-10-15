import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inpockProtectedRead } from '../lib/checklist/inpock-protected-read.mjs';

const proofUrl = new URL('../verification/remaining-readcaps-2026-10-16/inpock-protected-reads.json', import.meta.url);
const liveProof = JSON.parse(await readFile(proofUrl, 'utf8'));
const hashPaths = {
  'auth.owner': ['lib/web-auth/inpock.mjs', 'lib/protected-store.mjs', 'lib/scoped-session.mjs', 'scripts/inpock.mjs'],
  'auth.reuse': ['lib/web-auth/inpock.mjs', 'lib/protected-store.mjs', 'lib/scoped-session.mjs', 'scripts/inpock.mjs'],
  'cards.read': ['lib/web-auth/inpock.mjs', 'lib/protected-store.mjs', 'lib/scoped-session.mjs', 'lib/inpock-read.mjs', 'scripts/inpock.mjs'],
  'stats.read': ['lib/web-auth/inpock.mjs', 'lib/protected-store.mjs', 'lib/scoped-session.mjs', 'lib/inpock-read.mjs', 'scripts/inpock.mjs'],
};

function invoke(proof, capId) {
  const cap = { id: capId };
  const entry = { kind: 'inpock-protected-read-v1', service: 'inpock', files: ['proof.json'], hashPaths: hashPaths[capId] };
  return inpockProtectedRead([proof], entry, cap);
}

test('current DPAPI owner and stored-session receipts validate without claiming login', () => {
  assert.equal(invoke(liveProof, 'auth.owner'), true);
  assert.equal(invoke(liveProof, 'auth.reuse'), true);
  assert.match(liveProof.notReplayed['auth.login'], /No login POST was sent/);
});

test('current card pagination and statistics field contracts validate', () => {
  assert.equal(invoke(liveProof, 'cards.read'), true);
  assert.equal(invoke(liveProof, 'stats.read'), true);
  assert.equal(liveProof.operations['cards.read'].recordCount,
    liveProof.operations['cards.read'].receipts.reduce((sum, receipt) => sum + receipt.recordCount, 0));
});

test('unavailable or non-persistent credential providers cannot count as live reads', () => {
  const proof = structuredClone(liveProof);
  proof.providerReadiness.sessionAvailable = false;
  assert.equal(invoke(proof, 'auth.owner'), false);

  proof.providerReadiness.sessionAvailable = true;
  proof.credentialProvider = 'process-memory';
  assert.equal(invoke(proof, 'auth.reuse'), false);
});

test('protected-read evidence rejects leaked credentials and any write attempt', () => {
  const proof = structuredClone(liveProof);
  proof.cookie = 'must never be recorded';
  assert.equal(invoke(proof, 'auth.owner'), false);

  const writeAttempt = structuredClone(liveProof);
  writeAttempt.runner.writeRequestsSent = 1;
  assert.equal(invoke(writeAttempt, 'cards.read'), false);
});

test('auth reuse requires repeated protected owner reads and an explicit no-login boundary', () => {
  const proof = structuredClone(liveProof);
  proof.operations['auth.reuse'].receipts = proof.operations['auth.reuse'].receipts.slice(0, 1);
  assert.equal(invoke(proof, 'auth.reuse'), false);

  const loginAttempt = structuredClone(liveProof);
  loginAttempt.notReplayed['auth.login'] = 'login was attempted';
  assert.equal(invoke(loginAttempt, 'auth.reuse'), false);
});

test('card reads require successful server-end pagination with matching totals', () => {
  const badStatus = structuredClone(liveProof);
  badStatus.operations['cards.read'].receipts[1].httpStatus = 403;
  assert.equal(invoke(badStatus, 'cards.read'), false);

  const mismatch = structuredClone(liveProof);
  mismatch.operations['cards.read'].recordCount += 1;
  assert.equal(invoke(mismatch, 'cards.read'), false);

  const partial = structuredClone(liveProof);
  partial.operations['cards.read'].receipts.at(-1).hasNext = true;
  assert.equal(invoke(partial, 'cards.read'), false);
});

test('stats reads require the captured public field set and JSON response', () => {
  const missing = structuredClone(liveProof);
  missing.operations['stats.read'].fieldNames.pop();
  assert.equal(invoke(missing, 'stats.read'), false);

  const wrongMime = structuredClone(liveProof);
  wrongMime.operations['stats.read'].receipt.mime = 'text/html';
  assert.equal(invoke(wrongMime, 'stats.read'), false);
});

test('writes and unsupported capabilities cannot be reclassified as protected reads', () => {
  assert.equal(invoke(liveProof, 'cards.create'), false);
  assert.equal(invoke(liveProof, 'publishing.idempotency'), false);
});
