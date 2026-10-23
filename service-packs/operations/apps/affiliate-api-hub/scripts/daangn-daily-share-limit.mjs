// One global Daangn share reservation per KST day. A reservation is held after
// any uncertain attempt; release requires reconciliation of the same writer journal.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DAANGN_DAILY_LIMIT_FILE = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  'affiliate-content-operations',
  'daangn',
  'daily-share-limit.jsonl'
);

const fail = code => { throw Object.assign(new Error(code), { code }); };
const kstDay = at => new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const reservationId = runId => createHash('sha256').update(String(runId)).digest('hex').slice(0, 20);
const line = value => JSON.stringify(value) + '\n';

async function readEvents(file) {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(value => JSON.parse(value)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function withLock(file, callback) {
  await mkdir(path.dirname(file), { recursive: true });
  let lock;
  try { lock = await open(file + '.lock', 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') return { allowed: false, code: 'DAANGN_DAILY_LIMIT_LOCKED' };
    throw error;
  }
  try { return await callback(); }
  finally { await lock.close(); await unlink(file + '.lock').catch(() => {}); }
}

export async function reserveDailyDaangnShare({ file = DEFAULT_DAANGN_DAILY_LIMIT_FILE, runId, now = new Date(), limit = 1 } = {}) {
  if (!runId) fail('DAANGN_DAILY_LIMIT_RUN_ID_REQUIRED');
  return withLock(file, async () => {
    const events = await readEvents(file);
    const id = reservationId(runId);
    const prior = events.filter(event => event.reservationId === id).at(-1);
    if (prior && prior.state !== 'reconciled_not_posted') {
      return { allowed: false, code: 'DAANGN_DAILY_LIMIT_PREVIOUS_ATTEMPT_UNRESOLVED', reservationId: id, journalId: prior.journalId };
    }
    const day = kstDay(now);
    const latest = new Map();
    for (const event of events) latest.set(event.reservationId, event);
    const used = [...latest.values()].filter(event => event.kstDay === day && event.state === 'reserved').length;
    if (used >= limit) return { allowed: false, code: 'DAANGN_DAILY_LIMIT_REACHED', used, limit };
    const journalId = prior?.journalId || 'daangn-run-' + id;
    const attempt = (prior?.attempt || 0) + 1;
    const event = { reservationId: id, runId: String(runId), journalId, attempt, kstDay: day, reservedAt: new Date(now).toISOString(), state: 'reserved' };
    await appendFile(file, line(event), 'utf8');
    return { allowed: true, reservationId: id, journalId, attempt, kstDay: day };
  });
}

export async function reconcileDailyDaangnShare({ file = DEFAULT_DAANGN_DAILY_LIMIT_FILE, runId, reservation, journalId, outcome, readbackCompared = false, evidence = '', now = new Date() } = {}) {
  if (!runId || !reservation || !journalId) fail('DAANGN_DAILY_LIMIT_RECONCILE_ID_REQUIRED');
  if (outcome !== 'not_posted' || readbackCompared !== true || typeof evidence !== 'string' || evidence.trim().length < 10) {
    fail('DAANGN_DAILY_LIMIT_RECONCILE_EVIDENCE_REQUIRED');
  }
  return withLock(file, async () => {
    const events = await readEvents(file);
    const id = reservationId(runId);
    const prior = events.filter(event => event.reservationId === id).at(-1);
    if (!prior || prior.reservationId !== reservation || prior.journalId !== journalId || prior.state !== 'reserved') {
      fail('DAANGN_DAILY_LIMIT_RECONCILE_JOURNAL_MISMATCH');
    }
    const event = { ...prior, state: 'reconciled_not_posted', evidence: evidence.trim(), reconciledAt: new Date(now).toISOString() };
    await appendFile(file, line(event), 'utf8');
    return { reconciled: true, reservationId: id, journalId, state: event.state };
  });
}
