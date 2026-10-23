import path from 'node:path';
import os from 'node:os';
import { mkdir, open, readFile, readdir, rename, unlink, link } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSelfProcessIdentityResolver, requireWriterIdentity, writerIdentityIsAlive } from './self-process-identity.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const runProcess = promisify(execFile);
const runtimeRoot = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'affiliate-content-operations', 'social-actions');
export const safeCode = e => /^[A-Z][A-Z0-9_]{2,90}$/.test(e?.code || '') ? e.code : 'SOCIAL_ACTION_FAILED';

// Journal only caller identifiers and explicitly safe receipt fields, never raw request/response material.
export function safeReceipt(value) {
  const result = {};
  const primitives = ['service', 'operation', 'target', 'normalizedTarget', 'ownerFingerprint', 'ready', 'noOp', 'status',
    'success', 'code', 'captured', 'contractEvidence', 'responseSchemaEvidence', 'sourceSha256', 'client_exists', 'remnant_free',
    'credential_propagated', 'credential_propagated_for_write', 'live_replay', 'browserUsed', 'mutationCount',
    'readbackVerified', 'responseVerified', 'needs_reconciliation', 'reconciledAfterAmbiguousResponse',
    'requestEnvelopeEvidence', 'writeEnvelopeLiveVerified', 'writeSent', 'httpStatus', 'retryAfterSeconds', 'rateLimitReset',
    'priorWriteHttpStatus', 'priorWriteCode', 'priorResponseUnverified', 'priorFailureCheckedAt',
    'notSentVerified', 'dispatchStarted', 'providerErrorCode', 'providerErrorSummary', 'rejectedVerified'];
  for (const key of primitives) if (['string', 'boolean', 'number'].includes(typeof value?.[key])) result[key] = value[key];
  for (const key of ['currentState', 'auth', 'readReceipt']) {
    const fields = key === 'currentState' ? ['following', 'outgoingRequest', 'blocking', 'subscribed', 'neighbor', 'mutual', 'pending', 'relation', 'requested', 'isBuddy', 'isNeighbor', 'isMutual']
      : key === 'auth' ? ['ownerVerified', 'authenticated', 'provider', 'freshContext', 'sessionRenewalVerified', 'mode']
        : ['httpStatus', 'bytes', 'bootstrap', 'browserUsed', 'ownerVerified', 'tokenValuesRecorded', 'method', 'path', 'source', 'operation', 'live_replay', 'checkedAt'];
    if (value?.[key]) result[key] = Object.fromEntries(fields.filter(f => ['string', 'boolean', 'number'].includes(typeof value[key][f])).map(f => [f, value[key][f]]));
  }
  if (value?.request) {
    result.request = {};
    for (const key of ['method', 'path', 'operation', 'docId']) if (typeof value.request[key] === 'string') result.request[key] = value.request[key];
    for (const key of ['bodyFields', 'variableFields']) if (Array.isArray(value.request[key])) result.request[key] = value.request[key].filter(v => typeof v === 'string');
  }
  return result;
}

function storedInput(input, prepared) {
  const result = { service: prepared.service, operation: prepared.operation,
    target: String(prepared.service === 'tistory' ? prepared.normalizedTarget : prepared.target) };
  if (typeof input.groupId === 'string') result.groupId = input.groupId;
  if (typeof input.message === 'string') result.messageSha256 = digest(input.message);
  return result;
}

async function writeNew(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function update(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeNew(temporary, value);
  await rename(temporary, file);
}

async function reserve(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeNew(temporary, value);
  try {
    // Linking a complete file creates the reservation atomically and refuses an existing target.
    await link(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

function identity(receipt) {
  if (!receipt?.normalizedTarget && !receipt?.target) fail('SOCIAL_TARGET_IDENTITY_MISSING');
  return [receipt.service, receipt.ownerFingerprint || 'configured_owner', String(receipt.normalizedTarget || receipt.target).toLowerCase()].join(':');
}

async function release(pendingPath, journalId) {
  const record = JSON.parse(await readFile(pendingPath, 'utf8'));
  if (record.journalId !== journalId) fail('SOCIAL_JOURNAL_LOCK_MISMATCH');
  await unlink(pendingPath);
}

async function processIdentity(pid, { timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4096 });
      const ticks = stdout.trim();
      return /^\d{15,20}$/.test(ticks) ? 'win32:' + ticks : null;
    }
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      return /^\d+$/.test(startTicks) && /^[a-f0-9-]{36}$/.test(bootId) ? `linux:${bootId}:${startTicks}` : null;
    }
  } catch { /* An unavailable identity is not evidence that a writer has stopped. */ }
  return null;
}

const readSelfProcessIdentity = createSelfProcessIdentityResolver({
  probe: processIdentity,
  maxAttempts: 2,
  timeoutMs: 15_000,
  retryDelayMs: 100,
});

async function writerAlive(pid, expectedIdentity) {
  return writerIdentityIsAlive(pid, expectedIdentity, {
    processAlive: targetPid => {
      try { process.kill(targetPid, 0); return true; }
      catch (error) { return error?.code !== 'ESRCH'; }
    },
    probeIdentity: processIdentity,
  });
}

export async function listPendingActions() {
  const directory = path.join(runtimeRoot(), 'pending');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const output = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    try {
      const raw = await readFile(path.join(directory, entry.name), 'utf8');
      if (raw.length > 8192) continue;
      const item = JSON.parse(raw);
      if (typeof item.journalPath === 'string' && /^[a-f0-9-]{36}$/.test(item.journalId || '')) output.push({ journalId: item.journalId, journalPath: item.journalPath });
    } catch { output.push({ code: 'SOCIAL_PENDING_RECORD_UNREADABLE', record: entry.name }); }
  }
  return output;
}

// A durable per-owner/target reservation prevents opposite or repeated writes after an uncertain outcome.
export async function executeJournaled(input, provider, { journalPath, beforeWrite } = {}) {
  if(beforeWrite!==undefined && typeof beforeWrite!=='function') fail('SOCIAL_BEFORE_WRITE_GUARD_INVALID');
  const prepared = await provider.prepare(input);
  if (prepared.ready !== true) return { ...safeReceipt(prepared), status: 'blocked', mutationCount: 0 };
  const writerIdentity = await requireWriterIdentity(readSelfProcessIdentity);
  const targetIdentity = identity(prepared);
  const root = runtimeRoot();
  await mkdir(path.join(root, 'pending'), { recursive: true });
  await mkdir(path.join(root, 'journals'), { recursive: true });
  const id = randomUUID();
  const file = path.resolve(journalPath || path.join(root, 'journals', id + '.json'));
  await mkdir(path.dirname(file), { recursive: true });
  const pendingPath = path.join(root, 'pending', digest(targetIdentity) + '.json');
  const journal = { version: 1, journalId: id, writerPid: process.pid, writerIdentity, createdAt: new Date().toISOString(), input: storedInput(input, prepared),
    targetIdentity, pendingPath, status: 'prepared', attempts: 0, prepared: safeReceipt(prepared) };
  // A durable journal exists before the reservation. A crash here cannot hide a possible send.
  try { await writeNew(file, journal); }
  catch (error) { if (error.code === 'EEXIST') fail('SOCIAL_JOURNAL_EXISTS_RECONCILE_FIRST'); throw error; }
  try { await reserve(pendingPath, { journalId: id, journalPath: file }); }
  catch (error) {
    journal.status = 'blocked'; journal.code = error.code === 'EEXIST' ? 'SOCIAL_PENDING_ACTION_RECONCILE_FIRST' : 'SOCIAL_RESERVATION_FAILED';
    await update(file, journal);
    return { success: false, status: 'blocked', code: journal.code, journalPath: file, mutationCount: 0 };
  }
  let result, beforeWriteEntered = false, dispatchGuardBlocked = false;
  try {
    result = await provider.execute(input, { beforeWrite: async receipt => {
      if (beforeWriteEntered || journal.attempts !== 0) fail('SOCIAL_DUPLICATE_SEND_BLOCKED');
      beforeWriteEntered = true;
      if (identity(receipt) !== targetIdentity || receipt.operation !== prepared.operation) fail('SOCIAL_PREFLIGHT_CHANGED');
      if(beforeWrite) {
        try {
          if(await beforeWrite({...safeReceipt(receipt),journalPath:file})===false) fail('SOCIAL_ACTION_STOPPED_BEFORE_WRITE');
        } catch(error) { dispatchGuardBlocked=true;throw error; }
      }
      const next = { ...journal, status: 'write_started', attempts: 1, writeStartedAt: new Date().toISOString(), prepared: safeReceipt(receipt) };
      await update(file, next);
      Object.assign(journal, next);
    } });
  } catch (error) {
    result = { service: input.service, operation: input.operation, target: input.target, success: false,
      status: journal.attempts ? 'outcome_unknown' : dispatchGuardBlocked ? 'not_sent' : 'blocked', code: safeCode(error), mutationCount: journal.attempts,
      needs_reconciliation: journal.attempts > 0, writeSent: journal.attempts ? undefined : false, live_replay: false,
      ...(dispatchGuardBlocked && journal.attempts===0 ? {notSentVerified:true,dispatchStarted:false} : {}) };
  }
  if (result.writeSent === false && result.mutationCount === 0) { journal.attempts = 0; journal.notSentVerified = true; }
  const receipt = safeReceipt(result);
  const completed = result.success === true && result.readbackVerified === true;
  if (completed) receipt.status = journal.attempts ? 'succeeded' : 'no_op';
  else if (!receipt.status) receipt.status = 'blocked';
  if (journal.attempts && !completed) { receipt.status = 'outcome_unknown'; receipt.needs_reconciliation = true; }
  journal.status = completed ? (journal.attempts ? 'succeeded' : 'no_op') : (journal.attempts ? 'needs_reconciliation' : 'blocked');
  journal.result = receipt; journal.updatedAt = new Date().toISOString();
  try { await update(file, journal); }
  catch {
    return { success: false, status: journal.attempts ? 'outcome_unknown' : 'blocked', code: 'SOCIAL_JOURNAL_UPDATE_FAILED',
      needs_reconciliation: true, journalPath: file, mutationCount: journal.attempts };
  }
  if (completed || journal.attempts === 0) {
    try { await release(pendingPath, id); }
    catch {
      return { ...receipt, status: completed ? 'confirmed_pending_cleanup' : 'blocked',
        code: 'SOCIAL_RESERVATION_RELEASE_FAILED', needs_reconciliation: true, journalPath: file, mutationCount: journal.attempts };
    }
  }
  return { ...receipt, journalPath: file, mutationCount: journal.attempts };
}

export async function reconcileJournal(file, providerFor, overrides = {}) {
  file = path.resolve(file);
  const raw = await readFile(file, 'utf8');
  if (raw.length > 200_000) fail('SOCIAL_JOURNAL_INVALID');
  const journal = JSON.parse(raw);
  if (journal.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal.journalId || '') || !journal.input || !journal.targetIdentity
    || typeof journal.pendingPath !== 'string' || ![0, 1].includes(journal.attempts)
    || !['naver', 'tistory', 'x', 'threads', 'instagram'].includes(journal.input.service)
    || !['prepared', 'write_started', 'blocked', 'needs_reconciliation', 'succeeded', 'no_op', 'reconciled'].includes(journal.status)
    || journal.input.operation !== journal.prepared?.operation || journal.input.service !== journal.prepared?.service
    || !Number.isSafeInteger(journal.writerPid) || journal.writerPid <= 0
    || typeof journal.writerIdentity !== 'string' || !/^(?:win32:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/.test(journal.writerIdentity)
    || typeof journal.input.target !== 'string' || journal.input.target.length > 200
    || journal.targetIdentity !== identity(journal.prepared)) fail('SOCIAL_JOURNAL_INVALID');
  const expectedPending = path.join(runtimeRoot(), 'pending', digest(journal.targetIdentity) + '.json');
  if (path.resolve(journal.pendingPath) !== expectedPending) fail('SOCIAL_JOURNAL_SCOPE_INVALID');
  const alreadyCompleted = ['succeeded', 'no_op', 'reconciled'].includes(journal.status);
  if (['prepared', 'write_started'].includes(journal.status)
    && await writerAlive(journal.writerPid, journal.writerIdentity)) fail('SOCIAL_JOURNAL_WRITER_ACTIVE');
  const input = { ...journal.input };
  if (overrides.message !== undefined) {
    if (digest(overrides.message) !== journal.input.messageSha256) fail('SOCIAL_JOURNAL_INPUT_MISMATCH');
    input.message = overrides.message;
  }
  const provider = await providerFor(input.service);
  const prepared = await provider.prepare(input);
  if (identity(prepared) !== journal.targetIdentity) fail('SOCIAL_READBACK_IDENTITY_CHANGED');
  const confirmed = prepared.ready === true && prepared.noOp === true;
  const noSend = journal.attempts === 0;
  const prior = journal.result || {};
  const priorStatus = prior.priorWriteHttpStatus ?? prior.httpStatus;
  const priorFailure = [400, 401, 403, 429].includes(priorStatus) || journal.attempts === 1
    && (prior.responseVerified === false || prior.priorResponseUnverified === true);
  const result = { ...safeReceipt(prepared), success: confirmed,
    status: confirmed ? 'reconciled' : noSend ? 'not_sent' : alreadyCompleted ? 'current_state_changed' : 'outcome_unknown',
    readbackVerified: confirmed, needs_reconciliation: !confirmed && !noSend && !alreadyCompleted, mutationCount: journal.attempts, reconciliationOnly: true,
    alreadyCompleted,
    // A present desired state confirms the outcome, not which actor caused it.
    live_replay: false,
    ...(priorFailure ? {
      ...([400, 401, 403, 429].includes(priorStatus) ? { priorWriteHttpStatus: priorStatus } : {}),
      ...(prior.priorWriteCode || prior.code ? { priorWriteCode: safeCode({ code: prior.priorWriteCode || prior.code }) } : {}),
      ...(prior.responseVerified === false || prior.priorResponseUnverified === true ? { priorResponseUnverified: true } : {}),
      priorFailureCheckedAt: prior.priorFailureCheckedAt || journal.updatedAt,
      ...(Number.isSafeInteger(prior.retryAfterSeconds) ? { retryAfterSeconds: prior.retryAfterSeconds } : {}),
      ...(Number.isSafeInteger(prior.rateLimitReset) ? { rateLimitReset: prior.rateLimitReset } : {}),
    } : {}),
  };
  journal.reconciliation = { ...result, checkedAt: new Date().toISOString() };
  if (confirmed || noSend) { journal.status = confirmed ? 'reconciled' : 'blocked'; journal.result = result; }
  await update(file, journal);
  if (confirmed || noSend) {
    try { await release(expectedPending, journal.journalId); }
    catch (error) {
      // A previous completed or pre-send-blocked journal may already have released its reservation.
      if (!(error.code === 'ENOENT' && (alreadyCompleted || noSend))
        && !(error.code === 'SOCIAL_JOURNAL_LOCK_MISMATCH' && noSend)) throw error;
    }
  }
  return { ...result, journalPath: file };
}
