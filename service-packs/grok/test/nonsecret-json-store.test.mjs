import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OperationJournal } from '../src/journal.mjs';
import { NonSecretJsonFileStore } from '../src/nonsecret-json-store.mjs';

test('Linux journal survives a new client and persists digests only with owner-only permissions', async t => {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const journal = new OperationJournal({ store: new NonSecretJsonFileStore({ filePath }) });
  const prompt = 'private task prompt never written to this journal';
  const entry = await journal.begin({
    contractId: 'chat.create',
    requestDigest: createHash('sha256').update(prompt).digest('hex'),
    intentDigest: createHash('sha256').update('owner\nchat.create\nintent-1').digest('hex'),
  });
  await journal.transition(entry.localOperationId, 'outcome_unknown', { reasonCode: 'HTTP_TRANSPORT_FAILED' });

  const bytes = await readFile(filePath);
  const serialized = bytes.toString('utf8');
  bytes.fill(0);
  assert.equal(serialized.includes(prompt), false);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const restarted = new OperationJournal({ store: new NonSecretJsonFileStore({ filePath }) });
  assert.equal((await restarted.list())[0].intentDigest, createHash('sha256').update('owner\nchat.create\nintent-1').digest('hex'));
  await assert.rejects(restarted.begin({
    contractId: 'chat.create', requestDigest: 'b'.repeat(64),
    intentDigest: createHash('sha256').update('owner\nchat.create\nintent-1').digest('hex'),
  }), { code: 'OPERATION_ALREADY_HELD' });
});

test('nonsecret journal store rejects extra fields before persistence', async t => {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-journal-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new NonSecretJsonFileStore({ filePath: path.join(directory, 'operations.json') });
  await assert.rejects(store.write({ kind: 'grok-operation-journal', schemaVersion: 1, entries: [], prompt: 'must not persist' }), { code: 'NONSECRET_JOURNAL_SHAPE_INVALID' });
});
