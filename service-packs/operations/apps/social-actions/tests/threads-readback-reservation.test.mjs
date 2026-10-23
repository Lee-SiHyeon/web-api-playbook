import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reserveThreadsRead, reserveThreadsReactionReadback, consumeThreadsReadReservation } from '../lib/threads-read-budget.mjs';

const ownerId = '12345678901';
const handle = 'reader_test';
const postId = '2104967565558886629';
const t0 = Date.parse('2026-10-05T00:00:00.000Z');
const scope = { ownerId, handle, postId };
const limits = { perMinute: 30, perHour: 300 };

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-readback-reservation-'));
  try { await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function reservationFiles(root) {
  const directory = path.join(root, 'read-reservations');
  try { return (await readdir(directory)).filter(name => name.endsWith('.json')).map(name => path.join(directory, name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function readLedger(root) {
  try { return JSON.parse(await readFile(path.join(root, 'read-budget.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { events: [] }; throw error; }
}

async function readTicket(reservation) {
  return JSON.parse(await readFile(path.join(reservation.root, 'read-reservations', `${reservation.id}.json`), 'utf8'));
}

function safeCode(error) { return error?.code || error?.message; }

test('a two-read ticket is all-or-nothing when minute quota cannot fit both credits', async () => {
  await withRoot(async root => {
    const caps = { perMinute: 2, perHour: 10 };
    await reserveThreadsRead({ operation: 'PriorRead', root, now: t0, limits: caps });
    await assert.rejects(reserveThreadsReactionReadback({ ...scope, root, now: t0 + 1, limits: caps }), error => {
      assert.equal(safeCode(error), 'THREADS_READ_BUDGET_WAIT');
      assert.equal(error.dispatchStarted, false); assert.equal(error.writeSent, false);
      return true;
    });
    assert.equal((await readLedger(root)).events.length, 1);
    assert.deepEqual(await reservationFiles(root), []);
  });
});

test('a two-read ticket is all-or-nothing at the hourly boundary', async () => {
  await withRoot(async root => {
    const caps = { perMinute: 2, perHour: 2 };
    const ticket = await reserveThreadsReactionReadback({ ...scope, root, now: t0, limits: caps });
    assert.equal(ticket.postId, postId);
    await assert.rejects(reserveThreadsReactionReadback({ ...scope, root, now: t0 + 1, limits: caps }), error => {
      assert.equal(safeCode(error), 'THREADS_READ_BUDGET_WAIT');
      assert.equal(error.dispatchStarted, false); assert.equal(error.writeSent, false);
      return true;
    });
    assert.equal((await readLedger(root)).events.length, 2);
    assert.equal((await reservationFiles(root)).length, 1);
  });
});

test('reservation tickets keep both read slots occupied after their numeric charges age past one minute', async () => {
  await withRoot(async root => {
    const ticket = await reserveThreadsReactionReadback({ ...scope, root, now: t0, limits: { perMinute: 2, perHour: 20 } });
    await assert.rejects(reserveThreadsRead({ operation: 'OtherRead', root, now: t0 + 61_000,
      limits: { perMinute: 2, perHour: 20 } }), error => {
      assert.equal(safeCode(error), 'THREADS_READ_BUDGET_WAIT'); return true;
    });
    assert.equal((await readLedger(root)).events.length, 2);
    assert.equal((await readTicket(ticket)).operations.BarcelonaPostPageTargetQuery.consumedAt, null);
  });
});

test('the first delayed ticket consume is charged at its actual read time', async () => {
  await withRoot(async root => {
    const ticket = await reserveThreadsReactionReadback({ ...scope, root, now: t0, limits });
    const consumedAt = t0 + 75_000;
    await consumeThreadsReadReservation({ reservation: ticket, operation: 'ThreadsProfileDocumentRead', ...scope, now: consumedAt });
    const record = await readTicket(ticket);
    assert.equal(record.operations.ThreadsProfileDocumentRead.consumedAt, consumedAt);
    const ledger = await readLedger(root);
    assert.ok(ledger.events.includes(consumedAt), `expected actual consume charge ${consumedAt} in ${JSON.stringify(ledger.events)}`);
  });
});

test('concurrent consumers cannot spend the same single-use ticket credit twice', async () => {
  await withRoot(async root => {
    const ticket = await reserveThreadsReactionReadback({ ...scope, root, now: t0, limits });
    const results = await Promise.allSettled([
      consumeThreadsReadReservation({ reservation: ticket, operation: 'ThreadsProfileDocumentRead', ...scope, now: t0 + 1 }),
      consumeThreadsReadReservation({ reservation: ticket, operation: 'ThreadsProfileDocumentRead', ...scope, now: t0 + 2 }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await readTicket(ticket)).operations.ThreadsProfileDocumentRead.consumedAt != null, true);
  });
});

test('ticket consumption enforces expiry, owner, handle, post, operation, and read order', async () => {
  await withRoot(async root => {
    const ticket = await reserveThreadsReactionReadback({ ...scope, root, now: t0, limits });
    const rejects = async (operation, overrides = {}, now = t0 + 1) => assert.rejects(
      consumeThreadsReadReservation({ reservation: ticket, operation, ...scope, ...overrides, now }),
    );
    await rejects('BarcelonaPostPageTargetQuery', {}, t0 + 1);
    await rejects('ThreadsProfileDocumentRead', { ownerId: '987654321' });
    await rejects('ThreadsProfileDocumentRead', { handle: 'other_reader' });
    await rejects('ThreadsProfileDocumentRead', { postId: '2104967565558886620' });
    await rejects('UnrelatedQuery');
    await rejects('ThreadsProfileDocumentRead', {}, t0 + 20 * 60_000);
    assert.equal((await readTicket(ticket)).operations.ThreadsProfileDocumentRead.consumedAt, null);
  });
});

test('an interrupted consuming marker stays held and cannot double-charge or authorize replay', async () => {
  await withRoot(async root => {
    const ticket = await reserveThreadsReactionReadback({ ...scope, root, now: t0, limits });
    const file = path.join(root, 'read-reservations', `${ticket.id}.json`);
    const record = await readTicket(ticket);
    record.operations.ThreadsProfileDocumentRead.consumingAt = t0 + 10;
    await writeFile(file, JSON.stringify(record));
    const before = await readLedger(root);
    await assert.rejects(consumeThreadsReadReservation({ reservation: ticket, operation: 'ThreadsProfileDocumentRead', ...scope, now: t0 + 11 }));
    assert.deepEqual((await readLedger(root)).events, before.events);
    const after = await readTicket(ticket);
    assert.equal(after.operations.ThreadsProfileDocumentRead.consumingAt, t0 + 10);
    assert.equal(after.operations.ThreadsProfileDocumentRead.consumedAt, null);
  });
});

test('a ticket persistence failure never refunds the already charged pair', async () => {
  await withRoot(async root => {
    let writes = 0;
    const persist = async (file, value) => {
      writes += 1;
      if (writes === 2) throw new Error('ticket-store-failed');
      await writeFile(file, JSON.stringify(value));
    };
    await assert.rejects(reserveThreadsReactionReadback({ ...scope, root, now: t0, limits, persist }), /ticket-store-failed/);
    assert.equal(writes, 2);
    assert.equal((await readLedger(root)).events.length, 2);
  });
});

test('the legacy events-only writer leaves separately persisted reservation tickets intact', async () => {
  await withRoot(async root => {
    const ticket = await reserveThreadsReactionReadback({ ...scope, root, now: t0, limits });
    const before = await readTicket(ticket);
    await reserveThreadsRead({ operation: 'LegacyEventsOnlyRead', root, now: t0 + 1, limits });
    assert.deepEqual(await readTicket(ticket), before);
  });
});
