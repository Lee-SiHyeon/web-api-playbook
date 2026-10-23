import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MutationJournal, sha256 } from '../src/journal.mjs';

const deadPid = 2_000_000_000;
const staleTime = () => new Date(Date.now() - 10 * 60_000).toISOString();

function lockPath(directory, operationId, targetHash) {
  return path.join(directory, `.${sha256(`${operationId}\0${targetHash}`).slice(0, 32)}.lock`);
}

async function writeLock(directory, data) {
  await writeFile(lockPath(directory, data.operationId, data.targetHash), `${JSON.stringify(data)}\n`);
}

test('mutation journal hashes payload/target and holds uncertain outcomes without retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-journal-'));
  try {
    const journal = new MutationJournal({ directory });
    const requestBytes = Buffer.from(JSON.stringify({ text: 'private prompt text' }));
    const first = await journal.begin({ operationId: 'text.send.synthetic', requestBytes, targetValue: 'private-conversation-id' });
    await journal.markDispatchStarted(first.journalId);
    await journal.markOutcomeUnknown(first.journalId);
    const stored = await readFile(path.join(directory, `${first.journalId}.json`), 'utf8');
    assert.equal(stored.includes('private prompt text'), false);
    assert.equal(stored.includes('private-conversation-id'), false);
    await assert.rejects(journal.begin({ operationId: 'text.send.synthetic', requestBytes: Buffer.from('edited prompt'),
      targetValue: 'private-conversation-id' }), (error) => error.code === 'MUTATION_OUTCOME_UNKNOWN_HOLD');
    const held = await journal.recordReconciliation(first.journalId, { outcome: 'absent', authoritative: false,
      readbackOperationId: 'history.read.synthetic' });
    assert.equal(held.state, 'held');
    await assert.rejects(journal.begin({ operationId: 'text.send.synthetic', requestBytes: Buffer.from('edited prompt'),
      targetValue: 'private-conversation-id' }), (error) => error.code === 'MUTATION_OUTCOME_UNKNOWN_HOLD');
    const resolved = await journal.recordReconciliation(first.journalId, { outcome: 'absent', authoritative: true,
      readbackOperationId: 'history.read.synthetic' });
    assert.equal(resolved.state, 'reconciled_absent');
    await assert.rejects(journal.begin({ operationId: 'text.send.synthetic', requestBytes, targetValue: 'private-conversation-id' }),
      (error) => error.code === 'MUTATION_ALREADY_JOURNALED');
    const safe = await journal.listSafe();
    assert.equal(safe[0].readbackOutcome, 'absent');
    assert.equal(JSON.stringify(safe).includes('private prompt text'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dead pre-dispatch lock recovers, while an unresolved dispatched write remains locked', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-journal-crash-'));
  try {
    const journal = new MutationJournal({ directory });
    const operationId = 'text.send.synthetic';
    const targetValue = 'synthetic-target';
    const targetHash = sha256(JSON.stringify(targetValue));
    const initial = await journal.begin({ operationId, requestBytes: Buffer.from('first synthetic request'), targetValue });
    const initialRecordPath = path.join(directory, `${initial.journalId}.json`);
    const initialRecord = JSON.parse(await readFile(initialRecordPath, 'utf8'));
    initialRecord.ownerPid = deadPid;
    await writeFile(initialRecordPath, JSON.stringify(initialRecord));
    await writeLock(directory, { version: 1, journalId: initial.journalId, operationId, targetHash,
      ownerPid: deadPid, createdAt: staleTime() });

    await assert.rejects(journal.begin({ operationId, requestBytes: Buffer.from('changed request'), targetValue }),
      (error) => error.code === 'MUTATION_OUTCOME_UNKNOWN_HOLD');
    await assert.rejects(readFile(lockPath(directory, operationId, targetHash), 'utf8'), (error) => error.code === 'ENOENT');

    const recovered = await journal.reconcilePreDispatchCrash(initial.journalId, { processExited: true });
    assert.equal(recovered.state, 'reconciled_absent');
    assert.equal(recovered.recovery, 'pre_dispatch_process_exit');
    const next = await journal.begin({ operationId, requestBytes: Buffer.from('different explicit request'), targetValue });
    assert.equal(next.state, 'intent_logged');

    const otherTarget = 'second-target';
    const otherTargetHash = sha256(JSON.stringify(otherTarget));
    const unresolved = await journal.begin({ operationId, requestBytes: Buffer.from('unknown request'), targetValue: otherTarget });
    await journal.markDispatchStarted(unresolved.journalId);
    await journal.markOutcomeUnknown(unresolved.journalId);
    const unresolvedRecordPath = path.join(directory, `${unresolved.journalId}.json`);
    const unresolvedRecord = JSON.parse(await readFile(unresolvedRecordPath, 'utf8'));
    unresolvedRecord.ownerPid = deadPid;
    await writeFile(unresolvedRecordPath, JSON.stringify(unresolvedRecord));
    await writeLock(directory, { version: 1, journalId: unresolved.journalId, operationId,
      targetHash: otherTargetHash, ownerPid: deadPid, createdAt: staleTime() });

    await assert.rejects(journal.begin({ operationId, requestBytes: Buffer.from('another request'), targetValue: otherTarget }),
      (error) => error.code === 'MUTATION_JOURNAL_BUSY');
    assert.equal((await readFile(lockPath(directory, operationId, otherTargetHash), 'utf8')).includes(unresolved.journalId), true);
    await assert.rejects(journal.reconcilePreDispatchCrash(unresolved.journalId, { processExited: true }),
      (error) => error.code === 'JOURNAL_PRE_DISPATCH_RECOVERY_UNSAFE');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stale lock with a live PID and fresh dead-PID lock are preserved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-journal-live-lock-'));
  try {
    const journal = new MutationJournal({ directory });
    const operationId = 'text.send.synthetic';
    const targetValue = 'live-target';
    const targetHash = sha256(JSON.stringify(targetValue));
    const lockFile = lockPath(directory, operationId, targetHash);
    await writeLock(directory, { version: 1, journalId: randomUUID(), operationId, targetHash,
      ownerPid: process.pid, createdAt: staleTime() });
    await assert.rejects(journal.begin({ operationId, requestBytes: Buffer.from('request'), targetValue }),
      (error) => error.code === 'MUTATION_JOURNAL_BUSY');
    assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).ownerPid, process.pid);

    await writeLock(directory, { version: 1, journalId: randomUUID(), operationId, targetHash,
      ownerPid: deadPid, createdAt: new Date().toISOString() });
    await assert.rejects(journal.begin({ operationId, requestBytes: Buffer.from('request'), targetValue }),
      (error) => error.code === 'MUTATION_JOURNAL_BUSY');
    assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).ownerPid, deadPid);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent stale-lock recovery serializes cleanup and creates only one intent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-journal-recovery-race-'));
  try {
    const journal = new MutationJournal({ directory });
    const operationId = 'text.send.synthetic';
    const targetValue = 'race-target';
    const targetHash = sha256(JSON.stringify(targetValue));
    await writeLock(directory, { version: 1, journalId: randomUUID(), operationId, targetHash,
      ownerPid: deadPid, createdAt: staleTime() });

    const results = await Promise.allSettled([
      journal.begin({ operationId, requestBytes: Buffer.from('request one'), targetValue }),
      journal.begin({ operationId, requestBytes: Buffer.from('request two'), targetValue }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const records = await journal.readAll();
    assert.equal(records.filter((record) => record.targetHash === targetHash && record.state === 'intent_logged').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
