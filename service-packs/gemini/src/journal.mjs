import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OPERATION_NAMES, SERVICE_ID } from './constants.mjs';
import { GeminiClientError } from './errors.mjs';

export const JOB_DIR = path.join(os.homedir(), '.config', 'gemini-web-xhr-client', 'jobs');
const LOCK_DIRNAME = 'dispatch-locks';
const RESOLVED_STATES = new Set(['reconciled', 'confirmed_rejected', 'preflight_failed']);
const INTERNAL_MUTATION_CAPABILITIES = new Set(['attachment_upload_transfer', 'attachment_upload_cancel']);
const tickets = new WeakMap();

function supportedJournalCapability(capability) {
  return OPERATION_NAMES.includes(capability) || INTERNAL_MUTATION_CAPABILITIES.has(capability);
}

export function digestBody(body) {
  if (typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new GeminiClientError('MUTATION_BODY_INVALID', 'A mutation journal requires the exact encoded request body in memory.');
  }
  return createHash('sha256').update(body).digest('hex');
}

function jobPath(root, jobId) {
  return path.join(root, jobId + '.json');
}

function lockPath(root, capability, intentKeyHash) {
  return path.join(root, LOCK_DIRNAME, capability + '-' + intentKeyHash + '.lock');
}

export function mutationIntentDigest({ capability, actor, callerIntent } = {}) {
  if (!supportedJournalCapability(capability)
      || typeof actor !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.trim())
      || typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A stable caller intent and authenticated actor are required for a mutation.');
  }
  const canonical = JSON.stringify([SERVICE_ID, capability, actor.trim().toLowerCase(), callerIntent]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function writeAtomic(filePath, record) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = filePath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tempPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function cleanCode(code) {
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNCLASSIFIED';
}

export async function loadJournal(filePath) {
  let job;
  try { job = JSON.parse(await readFile(filePath, 'utf8')); }
  catch { throw new GeminiClientError('JOURNAL_INVALID', 'The mutation journal could not be read.'); }
  const legacy = job?.version === 1;
  const validDigests = legacy
    ? /^[a-f0-9]{64}$/.test(job?.bodyDigest)
    : job?.version === 2 && /^[a-f0-9]{64}$/.test(job?.intentKeyHash) && /^[a-f0-9]{64}$/.test(job?.wireBodyDigest);
  if ((!legacy && job?.version !== 2) || typeof job.jobId !== 'string' || !supportedJournalCapability(job.capability)
      || !validDigests || !Number.isInteger(job.dispatchCount)
      || typeof job.state !== 'string' || !Number.isFinite(Date.parse(job.createdAt))) {
    throw new GeminiClientError('JOURNAL_INVALID', 'The mutation journal has an unsupported shape.');
  }
  return Object.freeze({ ...job, jobPath: path.resolve(filePath) });
}

export async function findUnresolvedMutation(capability, intentKeyHash, { root = JOB_DIR } = {}) {
  if (!supportedJournalCapability(capability) || !/^[a-f0-9]{64}$/.test(intentKeyHash || '')) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'The mutation intent lookup key is invalid.');
  }
  let names;
  try { names = await readdir(root); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new GeminiClientError('JOURNAL_UNREADABLE', 'The mutation journal directory could not be read.');
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const job = await loadJournal(path.join(root, name));
    if (job.capability !== capability || RESOLVED_STATES.has(job.state)) continue;
    if (job.version === 1 || job.intentKeyHash === intentKeyHash) return job;
  }
  return undefined;
}

async function findPriorMutationIntent(capability, intentKeyHash, { root = JOB_DIR } = {}) {
  let names;
  try { names = await readdir(root); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new GeminiClientError('JOURNAL_UNREADABLE', 'The mutation journal directory could not be read.');
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const job = await loadJournal(path.join(root, name));
    if (job.capability === capability && job.version === 2 && job.intentKeyHash === intentKeyHash) return job;
    if (job.capability === capability && job.version === 1 && !RESOLVED_STATES.has(job.state)) return job;
  }
  return undefined;
}

export async function createMutationJournal({ capability, body, actor, callerIntent, root = JOB_DIR }) {
  if (!supportedJournalCapability(capability)) throw new GeminiClientError('OPERATION_UNSUPPORTED', 'The mutation capability is not in the observed operation catalog.');
  const intentKeyHash = mutationIntentDigest({ capability, actor, callerIntent });
  const wireBodyDigest = digestBody(body);
  const prior = await findPriorMutationIntent(capability, intentKeyHash, { root });
  if (prior && prior.state !== 'preflight_failed') {
    const code = RESOLVED_STATES.has(prior.state) ? 'MUTATION_INTENT_ALREADY_USED' : 'MUTATION_PENDING';
    throw new GeminiClientError(code, 'A mutation with the same caller intent already exists.');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = lockPath(root, capability, intentKeyHash);
  let lockHandle;
  try {
    await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
    lockHandle = await open(lock, 'wx', 0o600);
    const jobId = randomUUID();
    await lockHandle.writeFile(JSON.stringify({ jobId, capability, intentKeyHash }) + '\n', 'utf8');
    await lockHandle.close();
    lockHandle = null;
    const job = {
      version: 2,
      jobId,
      service: SERVICE_ID,
      capability,
      intentKeyHash,
      wireBodyDigest,
      state: 'intent_recorded',
      dispatchCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const target = jobPath(root, jobId);
    await writeAtomic(target, job);
    return Object.freeze({ ...job, jobPath: target, root });
  } catch (error) {
    if (lockHandle) await lockHandle.close().catch(() => {});
    if (error?.code === 'EEXIST') {
      throw new GeminiClientError('MUTATION_PENDING', 'An unresolved mutation with the same request digest already exists.');
    }
    await rm(lock, { force: true }).catch(() => {});
    if (error instanceof GeminiClientError) throw error;
    throw new GeminiClientError('JOURNAL_WRITE_FAILED', 'The mutation intent could not be recorded.');
  }
}

export async function reserveMutationDispatch(job) {
  const latest = await loadJournal(job.jobPath);
  if (latest.version !== 2 || latest.state !== 'intent_recorded' || latest.dispatchCount !== 0) {
    throw new GeminiClientError('MUTATION_REPLAY_BLOCKED', 'This journal does not permit another mutation dispatch.');
  }
  const updatedAt = new Date().toISOString();
  const next = {
    version: 2,
    jobId: latest.jobId,
    service: SERVICE_ID,
    capability: latest.capability,
    intentKeyHash: latest.intentKeyHash,
    wireBodyDigest: latest.wireBodyDigest,
    state: 'dispatching',
    dispatchCount: 1,
    dispatchStartedAt: updatedAt,
    createdAt: latest.createdAt,
    updatedAt,
  };
  await writeAtomic(latest.jobPath, next);
  const ticket = Object.freeze({});
  tickets.set(ticket, {
    jobPath: latest.jobPath,
    root: job.root || path.dirname(latest.jobPath),
    capability: latest.capability,
    intentKeyHash: latest.intentKeyHash,
    wireBodyDigest: latest.wireBodyDigest,
    consumed: false,
  });
  return ticket;
}

export function consumeMutationDispatch(ticket, capability, wireBodyDigest) {
  const record = ticket && tickets.get(ticket);
  if (!record || record.consumed || record.capability !== capability || record.wireBodyDigest !== wireBodyDigest) {
    throw new GeminiClientError('MUTATION_REPLAY_BLOCKED', 'The mutation dispatch ticket is missing, spent, or scoped to another request.');
  }
  record.consumed = true;
}

export function mutationDispatchConsumed(ticket) {
  const record = ticket && tickets.get(ticket);
  return record?.consumed === true;
}

export async function settleMutationDispatch(ticket, {
  state, httpStatus, failureCode, responseBytes, responseSha256, dispatchStartedAt, responseReceivedAt,
} = {}) {
  const record = ticket && tickets.get(ticket);
  if (!record) throw new GeminiClientError('MUTATION_TICKET_INVALID', 'The mutation dispatch ticket is no longer available.');
  const allowed = record.consumed
    ? new Set(['response_received', 'outcome_unknown'])
    : new Set(['preflight_failed']);
  if (!allowed.has(state)) throw new GeminiClientError('MUTATION_STATE_INVALID', 'The mutation result state is invalid for its dispatch boundary.');
  const latest = await loadJournal(record.jobPath);
  if (latest.state !== 'dispatching') throw new GeminiClientError('JOURNAL_STATE_CONFLICT', 'The mutation journal changed before dispatch settlement.');
  const next = {
    version: 2,
    jobId: latest.jobId,
    service: SERVICE_ID,
    capability: latest.capability,
    intentKeyHash: latest.intentKeyHash,
    wireBodyDigest: latest.wireBodyDigest,
    state,
    dispatchCount: latest.dispatchCount,
    ...(typeof (dispatchStartedAt ?? latest.dispatchStartedAt) === 'string'
      ? { dispatchStartedAt: dispatchStartedAt ?? latest.dispatchStartedAt } : {}),
    createdAt: latest.createdAt,
    updatedAt: new Date().toISOString(),
  };
  if (Number.isInteger(httpStatus)) next.httpStatus = httpStatus;
  if (failureCode) next.failureCode = cleanCode(failureCode);
  if (Number.isSafeInteger(responseBytes) && responseBytes >= 0) next.responseBytes = responseBytes;
  if (typeof responseSha256 === 'string' && /^[a-f0-9]{64}$/.test(responseSha256)) next.responseSha256 = responseSha256;
  if (typeof responseReceivedAt === 'string' && Number.isFinite(Date.parse(responseReceivedAt))) {
    next.responseReceivedAt = responseReceivedAt;
  }
  await writeAtomic(latest.jobPath, next);
  if (RESOLVED_STATES.has(state)) {
    await rm(lockPath(record.root, record.capability, record.intentKeyHash), { force: true }).catch(() => {});
  }
  tickets.delete(ticket);
  return Object.freeze({ ...next, jobPath: latest.jobPath });
}

export async function markMutationReconciled(filePath, { found, resultCategory } = {}) {
  const latest = await loadJournal(filePath);
  if (!['response_received', 'outcome_unknown', 'dispatching'].includes(latest.state)) {
    throw new GeminiClientError('JOURNAL_STATE_CONFLICT', 'The mutation journal is not awaiting reconciliation.');
  }
  if (found !== true) {
    return latest;
  }
  const next = {
    version: latest.version,
    jobId: latest.jobId,
    service: SERVICE_ID,
    capability: latest.capability,
    ...(latest.version === 1
      ? { bodyDigest: latest.bodyDigest }
      : { intentKeyHash: latest.intentKeyHash, wireBodyDigest: latest.wireBodyDigest }),
    state: 'reconciled',
    dispatchCount: latest.dispatchCount,
    createdAt: latest.createdAt,
    updatedAt: new Date().toISOString(),
    ...(latest.dispatchStartedAt ? { dispatchStartedAt: latest.dispatchStartedAt } : {}),
    ...(latest.responseReceivedAt ? { responseReceivedAt: latest.responseReceivedAt } : {}),
    ...(Number.isInteger(latest.httpStatus) ? { httpStatus: latest.httpStatus } : {}),
    ...(Number.isSafeInteger(latest.responseBytes) ? { responseBytes: latest.responseBytes } : {}),
    ...(typeof latest.responseSha256 === 'string' ? { responseSha256: latest.responseSha256 } : {}),
  };
  if (typeof resultCategory === 'string' && /^[a-z0-9_-]{1,40}$/i.test(resultCategory)) next.resultCategory = resultCategory;
  await writeAtomic(latest.jobPath, next);
  const lockDigest = latest.version === 1 ? latest.bodyDigest : latest.intentKeyHash;
  await rm(lockPath(path.dirname(latest.jobPath), latest.capability, lockDigest), { force: true }).catch(() => {});
  return Object.freeze({ ...next, jobPath: latest.jobPath });
}
