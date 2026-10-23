import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyHistory } from '../scripts/verify-history.mjs';
import { auditGeminiFeatures } from '../src/feature-checklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CID = 'c_0123456789abcdef';
const PROMPT = 'An existing private verification prompt';
const OWNER = 'private-owner@example.invalid';
const RESPONSE = { httpStatus: 200, responseBytes: 123, responseSha256: 'a'.repeat(64), credentialPropagated: true };
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'gemini-history-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'scripts', 'discovery']) await mkdir(path.join(root, directory));
  for (const file of await readdir(path.join(ROOT, 'src'))) {
    if (file.endsWith('.mjs')) await writeFile(path.join(root, 'src', file), await readFile(path.join(ROOT, 'src', file)));
  }
  for (const file of ['scripts/verify-history.mjs', 'discovery/observed-contract.json', 'discovery/feature-checklist.json']) {
    await writeFile(path.join(root, file), await readFile(path.join(ROOT, file)));
  }
  return root;
}

async function installExistingIdentityProof(root) {
  const paths = [
    'verification/feature-evidence/identity--identity--owner.json',
    'verification/features/identity.json',
  ];
  for (const relative of paths) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  for (const relative of paths) {
    await writeFile(path.join(root, relative), await readFile(path.join(ROOT, relative)));
  }
}

function packet() {
  return { expectedOwner: OWNER, session: { privateCookie: 'PRIVATE_COOKIE_VALUE' }, query: 'private marker', expectedIntent: PROMPT };
}

function client(overrides = {}) {
  return {
    transport: { session: {} },
    verifyOwner: async () => ({ ...RESPONSE, ownerMatched: true, anonymousOwnerAbsent: true }),
    refreshSession: async () => ({}),
    listHistory: async () => ({ ...RESPONSE, data: [[[CID, 'Private conversation title']]] }),
    searchHistory: async () => ({ ...RESPONSE, data: [[CID]], request: { headerNames: ['content-type'] } }),
    readHistoryDetail: async () => ({ ...RESPONSE,
      summary: { rpcMatchCount: 1, taskIntentMatched: true, apiConversationIdMatched: true }, binding: { bound: true },
    }),
    ...overrides,
  };
}

test('canonical history evidence binds list/search/detail without persisting private values', async (t) => {
  const root = await fixture(t);
  const fake = client();
  const result = await verifyHistory(packet(), { root, createClient: () => fake });
  assert.equal(result.verified, true);
  assert.equal(fake.transport.session, null);
  for (const directory of ['features', 'feature-evidence']) {
    for (const file of await readdir(path.join(root, 'verification', directory))) {
      const value = await readFile(path.join(root, 'verification', directory, file), 'utf8');
      for (const secret of [OWNER, CID, PROMPT, 'PRIVATE_COOKIE_VALUE', 'Private conversation title']) assert.equal(value.includes(secret), false);
    }
  }
  const audit = await auditGeminiFeatures({ root });
  assert.equal(audit.features.find((feature) => feature.id === 'history').status, 'stored_receipt_consistent');
  assert.equal(audit.features.find((feature) => feature.id === 'identity').status, 'stored_receipt_consistent');
});

test('history refresh writes a fresh owner pair while preserving existing identity evidence and backing up history receipts', async (t) => {
  const root = await fixture(t);
  await installExistingIdentityProof(root);
  const prior = new Map();
  const oldFiles = [
    'verification/features/history.json',
    'verification/feature-evidence/history--history_list--list.json',
    'verification/feature-evidence/history--history_search--search.json',
    'verification/feature-evidence/history--history_read--conversation.json',
  ];
  for (const [index, relative] of oldFiles.entries()) {
    const bytes = Buffer.from(`previous history evidence ${index}\n`);
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
    prior.set(relative, bytes);
  }
  const identityPairPath = path.join(root, 'verification/feature-evidence/identity--identity--owner.json');
  const identityReceiptPath = path.join(root, 'verification/features/identity.json');
  const identityPairBefore = await readFile(identityPairPath);
  const identityReceiptBefore = await readFile(identityReceiptPath);
  const result = await verifyHistory({ ...packet(), preserveExistingIdentityEvidence: true }, {
    root, createClient: () => client(),
  });
  assert.equal(result.verified, true);
  assert.equal(result.identityEvidenceFresh, true);
  assert.equal(result.existingIdentityEvidencePreserved, true);
  assert.equal(result.currentIdentityEvidencePath, 'verification/feature-evidence/identity--identity--history_owner.json');
  assert.equal(result.priorHistoryEvidenceBackupCount, 4);
  assert.deepEqual(await readFile(identityPairPath), identityPairBefore);
  assert.deepEqual(await readFile(identityReceiptPath), identityReceiptBefore);
  for (const [relative, bytes] of prior) {
    const suffix = sha(bytes).slice(0, 12);
    const basename = path.basename(relative, '.json');
    assert.deepEqual(await readFile(path.join(root, 'verification/one-shot', `gemini-history-before-refresh-${basename}-${suffix}.json`)), bytes);
  }
  const audit = await auditGeminiFeatures({ root });
  assert.equal(audit.features.find((feature) => feature.id === 'history').status, 'stored_receipt_consistent');
  // The preserved checked-in identity receipt predates the current handler source
  // snapshot; history refresh must not restamp it as current.
  assert.equal(audit.features.find((feature) => feature.id === 'identity').status, 'needs_reverification');
});

test('search without a matching owner-list conversation cannot create success receipts', async (t) => {
  const root = await fixture(t);
  const fake = client({ searchHistory: async () => ({ ...RESPONSE, data: [['c_fedcba9876543210']] }) });
  await assert.rejects(verifyHistory(packet(), { root, createClient: () => fake }), { code: 'HISTORY_SEARCH_NO_LIST_MATCH' });
  await assert.rejects(readdir(path.join(root, 'verification')), { code: 'ENOENT' });
  assert.equal(fake.transport.session, null);
});

test('source drift during a successful read prevents canonical success evidence', async (t) => {
  const root = await fixture(t);
  const fake = client({ readHistoryDetail: async () => {
    await writeFile(path.join(root, 'src/client.mjs'), '// changed during the run\n');
    return { ...RESPONSE, summary: { rpcMatchCount: 1, taskIntentMatched: true, apiConversationIdMatched: true }, binding: { bound: true } };
  } });
  await assert.rejects(verifyHistory(packet(), { root, createClient: () => fake }), { code: 'SOURCE_CHANGED_DURING_VERIFICATION' });
  await assert.rejects(readdir(path.join(root, 'verification')), { code: 'ENOENT' });
});
