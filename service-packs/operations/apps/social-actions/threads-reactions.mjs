import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openMetaContext, metaRequest, sendMetaQuery, withMetaSessionLock } from './lib/meta-bootstrap.mjs';
import { THREADS_READBACK_CONTRACTS, buildThreadsTargetVariables } from '../affiliate-api-hub/scripts/sns/readers/threads-readback.mjs';
import { reserveThreadsReactionReadback } from './lib/threads-read-budget.mjs';

// Both mutation requests were intercepted before transmission on 2026-09-30. 2026-10-21: like doc id re-read from the
// current first-party useTHLikeMutationLikeMutation.threads.graphql module (variables shape unchanged).
export const THREADS_REACTION_CONTRACTS = Object.freeze({
  like: { operation: 'useTHLikeMutationLikeMutation', docId: '27990590487282317', state: 'liked' },
  repost: { operation: 'useTHCreateRepostMutation', docId: '31967938062853815', state: 'reposted' },
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = e => /^[A-Z][A-Z0-9_]+$/.test(e?.code || '') ? e.code : 'THREADS_REACTION_OUTCOME_UNKNOWN';
const JOURNAL_HISTORY_VERSION = 1;
const JOURNAL_HISTORY_MAX_ENTRIES = 8;
const JOURNAL_HISTORY_MAX_BYTES = 32_768;
const JOURNAL_EVIDENCE_FIELDS = new Set([
  'owner', 'operation', 'postId', 'target', 'status', 'code', 'checkedAt', 'currentState', 'writes',
  'dispatchStarted', 'writeSent', 'dispatchConfirmed', 'credential_propagated', 'httpStatus',
  'priorWriteHttpStatus', 'priorWriteCode', 'priorFailureCheckedAt', 'retryAfterSeconds', 'rateLimitReset',
]);

function historyFail() { fail('THREADS_REACTION_JOURNAL_HISTORY_INVALID'); }
function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function validHistoryTimestamp(value) {
  return value === null || typeof value === 'string' && value.length <= 128 && Number.isFinite(Date.parse(value));
}
function validateHistoryEvidence(evidence, identity) {
  if (!isPlainRecord(evidence) || Object.keys(evidence).some(key => !JOURNAL_EVIDENCE_FIELDS.has(key))
    || ['owner', 'operation', 'postId', 'target', 'writes', 'status', 'code', 'checkedAt', 'currentState',
      'dispatchStarted', 'writeSent', 'dispatchConfirmed', 'credential_propagated', 'httpStatus',
      'priorWriteHttpStatus', 'priorWriteCode', 'priorFailureCheckedAt', 'retryAfterSeconds', 'rateLimitReset']
      .some(key => !Object.hasOwn(evidence, key))
    || evidence.owner !== identity.owner || evidence.operation !== identity.operation
    || evidence.postId !== identity.postId || evidence.target !== identity.target
    || ![0, 1].includes(evidence.writes)
    || evidence.status !== null && (typeof evidence.status !== 'string' || evidence.status.length > 64)
    || evidence.code !== null && (typeof evidence.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,100}$/.test(evidence.code))
    || evidence.priorWriteCode !== null && (typeof evidence.priorWriteCode !== 'string'
      || !/^[A-Z][A-Z0-9_]{2,100}$/.test(evidence.priorWriteCode))
    || evidence.checkedAt === null || !validHistoryTimestamp(evidence.checkedAt)
    || !validHistoryTimestamp(evidence.priorFailureCheckedAt)
    || ['dispatchStarted', 'writeSent', 'dispatchConfirmed', 'credential_propagated']
      .some(key => evidence[key] !== null && typeof evidence[key] !== 'boolean')
    || evidence.httpStatus !== null && (!Number.isSafeInteger(evidence.httpStatus) || evidence.httpStatus < 100 || evidence.httpStatus > 599)
    || evidence.priorWriteHttpStatus !== null && ![400, 401, 403, 429].includes(evidence.priorWriteHttpStatus)
    || evidence.retryAfterSeconds !== null && (!Number.isSafeInteger(evidence.retryAfterSeconds)
      || evidence.retryAfterSeconds < 0 || evidence.retryAfterSeconds > 86_400)
    || evidence.rateLimitReset !== null && (!Number.isSafeInteger(evidence.rateLimitReset)
      || evidence.rateLimitReset < 1 || evidence.rateLimitReset > 99_999_999_999_999)) historyFail();

  const state = evidence.currentState;
  const stateFields = new Set(['id', 'author', 'authorId', 'code', 'url', 'liked', 'reposted']);
  if (!isPlainRecord(state) || Object.keys(state).some(key => !stateFields.has(key))
    || state.id !== identity.postId || typeof state.author !== 'string'
    || state.author.toLowerCase() !== identity.target.toLowerCase()
    || state.authorId !== undefined && (typeof state.authorId !== 'string' || !/^\d{1,30}$/.test(state.authorId))
    || state.code !== undefined && (typeof state.code !== 'string' || !/^[A-Za-z0-9_-]{5,64}$/.test(state.code))
    || state.url !== undefined && (typeof state.url !== 'string' || state.url.length > 512)
    || typeof state.liked !== 'boolean' || typeof state.reposted !== 'boolean') historyFail();
  return evidence;
}

function captureJournalEvidence(record) {
  const evidence = {
    owner: record.owner, operation: record.operation, postId: record.postId, target: record.target,
    status: record.status ?? null, code: record.code ?? null, checkedAt: record.checkedAt ?? null,
    currentState: record.currentState == null ? null : structuredClone(record.currentState),
    writes: record.writes,
    dispatchStarted: record.dispatchStarted ?? null, writeSent: record.writeSent ?? null,
    dispatchConfirmed: record.dispatchConfirmed ?? null, credential_propagated: record.credential_propagated ?? null,
    httpStatus: record.httpStatus ?? null, priorWriteHttpStatus: record.priorWriteHttpStatus ?? null,
    priorWriteCode: record.priorWriteCode ?? null, priorFailureCheckedAt: record.priorFailureCheckedAt ?? null,
    retryAfterSeconds: record.retryAfterSeconds ?? null, rateLimitReset: record.rateLimitReset ?? null,
  };
  validateHistoryEvidence(evidence, record);
  return evidence;
}

function reconciliationHistoryFor(existing) {
  const identity = { owner: existing.owner, operation: existing.operation, postId: existing.postId, target: existing.target };
  if (!Object.hasOwn(existing, 'reconciliationHistory')) {
    return { schemaVersion: JOURNAL_HISTORY_VERSION, entries: [captureJournalEvidence(existing)] };
  }
  const history = existing.reconciliationHistory;
  if (!isPlainRecord(history) || Object.keys(history).length !== 2
    || history.schemaVersion !== JOURNAL_HISTORY_VERSION || !Array.isArray(history.entries)
    || history.entries.length < 1 || history.entries.length > JOURNAL_HISTORY_MAX_ENTRIES) historyFail();
  for (const entry of history.entries) validateHistoryEvidence(entry, identity);
  if (Buffer.byteLength(JSON.stringify(history), 'utf8') > JOURNAL_HISTORY_MAX_BYTES) historyFail();
  return history;
}

function safeRateLimit(error) {
  return {
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599
      ? { httpStatus: error.httpStatus } : {}),
    ...(Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 && error.retryAfterSeconds <= 86_400
      ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(Number.isSafeInteger(error?.rateLimitReset) && error.rateLimitReset > 0 && error.rateLimitReset <= 99_999_999_999_999
      ? { rateLimitReset: error.rateLimitReset } : {}),
  };
}

function priorRejection(existing) {
  const status = existing?.priorWriteHttpStatus ?? existing?.httpStatus;
  if (![400, 401, 403, 429].includes(status)) return {};
  return { priorWriteHttpStatus: status,
    priorWriteCode: safeCode({ code: existing.priorWriteCode || existing.code }),
    priorFailureCheckedAt: existing.priorFailureCheckedAt || existing.checkedAt,
    ...(Number.isSafeInteger(existing.retryAfterSeconds) ? { retryAfterSeconds: existing.retryAfterSeconds } : {}),
    ...(Number.isSafeInteger(existing.rateLimitReset) ? { rateLimitReset: existing.rateLimitReset } : {}),
  };
}

export function decodeThreadsReactionPost(payload, postId, expectedAuthor, expectedActorId) {
  const m = payload?.data?.media;
  const id = String(m?.pk ?? m?.id ?? '').split('_')[0];
  const author = m?.user?.username?.toLowerCase();
  const authorId = String(m?.user?.pk ?? m?.user?.id ?? '');
  const app = m?.text_post_app_info;
  if (id !== postId || typeof author !== 'string' || !/^[a-z0-9_.]{1,30}$/.test(author)
    || expectedAuthor && author !== expectedAuthor.toLowerCase()
    || expectedActorId && authorId !== expectedActorId
    || typeof m?.has_liked !== 'boolean' || typeof app?.share_info?.is_reposted_by_viewer !== 'boolean'
    || typeof m?.code !== 'string' || !/^[A-Za-z0-9_-]{5,64}$/.test(m.code)) fail('THREADS_REACTION_POST_MISMATCH');
  return { id, author, ...(authorId ? { authorId } : {}), code: m.code, url: `https://www.threads.com/@${author}/post/${m.code}`,
    liked: m.has_liked, reposted: app.share_info.is_reposted_by_viewer };
}

export function buildThreadsReactionVariables(context, operation, postId) {
  if (!Object.hasOwn(THREADS_REACTION_CONTRACTS, operation) || !/^\d{10,25}$/.test(postId || '')) fail('THREADS_REACTION_INPUT');
  if (operation === 'like') {
    // Current first-party caller uses t?.field for every requestData field.
    // No navigation history, ranking token or browser telemetry is fabricated.
    const source = context.sources?.get('useTHLikeMutation')?.source || '';
    const relay = context.sources?.get('useTHLikeMutationLikeMutation.threads.graphql')?.source || '';
    if (!source.includes('requestData:{') || !source.includes('t==null?void 0:t.nav_chain')
      || !relay.includes('id:"27990590487282317"') || !relay.includes('name:"requestData"')) fail('THREADS_LIKE_SOURCE_CHANGED');
    return { mediaID: postId, requestData: {} };
  }
  return { mediaID: postId };
}

async function readPost(context, postId, author, send, expectedActorId) {
  const contract = THREADS_READBACK_CONTRACTS.target;
  const result = await send(context, metaRequest(context, contract.operation, contract.docId, buildThreadsTargetVariables(postId)));
  return decodeThreadsReactionPost(result.payload, postId, author, expectedActorId);
}

async function save(file, record) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}

export async function reactThreads({ operation, postId, expectedAuthor, expectedActorId, execute = false, reconcile = false } = {}, {
  contextLoader = openMetaContext, querySender = sendMetaQuery, sessionLock = withMetaSessionLock,
  beforeWrite = async () => true,
  reserveReadback = contextLoader===openMetaContext && querySender===sendMetaQuery ? reserveThreadsReactionReadback : async()=>null,
  journalRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'threads-reactions'),
} = {}) {
  if (!Object.hasOwn(THREADS_REACTION_CONTRACTS, operation) || !/^\d{10,25}$/.test(postId || '') || !/^[A-Za-z0-9_.]{1,30}$/.test(expectedAuthor || '')
    || expectedActorId !== undefined && !/^\d{1,25}$/.test(expectedActorId)
    || typeof beforeWrite !== 'function' || typeof reserveReadback!=='function'
    || typeof execute !== 'boolean' || typeof reconcile !== 'boolean' || execute && reconcile) fail('THREADS_REACTION_INPUT');
  const contract = THREADS_REACTION_CONTRACTS[operation];
  return sessionLock('threads', async () => {
    const context = await contextLoader('threads', expectedAuthor);
    if (context.bundle?.owner !== 'lifehack__ailab' || context.bundle?.service !== 'threads'
      || !/^\d{1,30}$/.test(context.bundle?.ownerId || '')
      || !context.documentReceipt?.ownerVerified) fail('THREADS_REACTION_OWNER_MISMATCH');
    if (expectedAuthor.toLowerCase() === context.bundle.owner) fail('THREADS_REACTION_SELF_TARGET');
    const before = await readPost(context, postId, expectedAuthor, querySender, expectedActorId);
    const variables = buildThreadsReactionVariables(context, operation, postId);
    const receipt = { owner: context.bundle.owner, operation, postId, target: before.author,
      executionMode: 'pure_http', browserUsed: false, captured: true, client_exists: true, remnant_free: true,
      credential_propagated: false, readCredentialPropagated: true, live_replay: false, writes: 0, currentState: before, ready: true,
      request: { method: 'POST', path: '/api/graphql', operation: contract.operation, docId: contract.docId },
      checkedAt: new Date().toISOString() };
    if (!execute && !reconcile) return receipt;
    await mkdir(journalRoot, { recursive: true });
    const journalPath = path.join(journalRoot, `${context.bundle.ownerId}-${operation}-${postId}.json`);
    let existing;
    try { existing = JSON.parse(await readFile(journalPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') fail('THREADS_REACTION_JOURNAL_INVALID'); }
    if (existing && (existing.postId !== postId || existing.operation !== operation || existing.owner !== receipt.owner
      || existing.target !== before.author || ![0, 1].includes(existing.writes))) fail('THREADS_REACTION_JOURNAL_MISMATCH');
    if (reconcile) {
      if (!existing || existing.postId !== postId || existing.operation !== operation || existing.owner !== receipt.owner
        || existing.target !== before.author) fail('THREADS_REACTION_JOURNAL_MISMATCH');
      const reconciliationHistory = reconciliationHistoryFor(existing);
      const verified = before[contract.state] === true;
      const result = { ...receipt, ...priorRejection(existing), writes: existing.writes, success: verified, readbackVerified: verified,
        credential_propagated: existing.dispatchConfirmed === true,
        dispatchConfirmed: existing.dispatchConfirmed === true,
        live_replay: verified && existing.dispatchConfirmed === true,
        ...(existing.writes === 0 && existing.notSentVerified === true ? { notSentVerified: true } : {}),
        status: verified ? 'verified' : existing.writes === 0 && existing.notSentVerified === true ? 'not_sent' : 'needs_reconciliation',
        reconciliationHistory, journalPath };
      await save(journalPath, result); return result;
    }
    if (existing && !(existing.writes === 0 && existing.notSentVerified === true)) {
      if (existing.status === 'verified'
        && before[contract.state]) return { ...receipt, ...priorRejection(existing), success: true, noOp: true, readbackVerified: true, journalPath };
      fail('THREADS_REACTION_RECONCILE_FIRST');
    }
    if (before[contract.state]) return { ...receipt, success: true, noOp: true, readbackVerified: true };
    const readbackReservation=await reserveReadback({ownerId:context.bundle.ownerId,handle:before.author,postId,
      ...(context.readBudgetRoot?{root:context.readBudgetRoot}:{}),...(context.readBudgetLimits?{limits:context.readBudgetLimits}:{})});
    const request = metaRequest(context, contract.operation, contract.docId, variables);
    const record = { ...receipt, writes: 1, dispatchConfirmed: false, status: 'write_reserved', journalPath };
    if (existing) await save(journalPath, record);
    else {
      let file;
      try { file = await open(journalPath, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') fail('THREADS_REACTION_RECONCILE_FIRST'); throw e; }
      try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); } finally { await file.close(); }
    }
    let allowed, guardError;
    try { allowed = await beforeWrite({ ...receipt, journalPath }); }
    catch (error) { guardError = error; allowed = false; }
    if (allowed === false) {
      const stopped = { ...receipt, status: 'not_sent', success: false, readbackVerified: false, writes: 0,
        notSentVerified: true, journalPath, code: guardError ? safeCode(guardError) : 'THREADS_OUTREACH_STOP_REQUESTED' };
      await save(journalPath, stopped); return stopped;
    }
    let response, failure, failureMeta={};
    try { response = await querySender(context, request); }
    catch (e) { failure = safeCode(e); failureMeta=safeRateLimit(e); }
    const dispatchConfirmed = querySender === sendMetaQuery && response?.receipt?.httpStatus === 200;
    await save(journalPath, { ...record, status: 'needs_reconciliation', dispatchConfirmed,
      credential_propagated: dispatchConfirmed, ...(failure ? { code: failure } : {}) });
    let after;
    try {
      const fresh = await contextLoader('threads', expectedAuthor,readbackReservation?{readBudgetReservation:readbackReservation}:{});
      if(fresh.bundle?.ownerId!==context.bundle.ownerId || fresh.bundle?.owner!==context.bundle.owner
        || fresh.bundle?.service!=='threads' || fresh.documentReceipt?.ownerVerified!==true) fail('THREADS_REACTION_OWNER_MISMATCH');
      after = await readPost(fresh, postId, expectedAuthor, querySender, expectedActorId);
    }
    catch (e) { failure ||= safeCode(e); if(!Object.keys(failureMeta).length) failureMeta=safeRateLimit(e); }
    const verified = after?.[contract.state] === true;
    const result = { ...record, currentState: after || before, success: verified, readbackVerified: verified,
      live_replay: verified && dispatchConfirmed, dispatchConfirmed, credential_propagated: dispatchConfirmed,
      status: verified ? 'verified' : 'needs_reconciliation',
      ...(failure ? { code: failure } : {}), ...failureMeta,
      ...(response?.receipt ? { httpStatus: response.receipt.httpStatus } : {}),
      checkedAt: new Date().toISOString() };
    await save(journalPath, result); return result;
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [operation, postId, expectedAuthor, flag] = process.argv.slice(2);
  if (process.argv.length > 6 || flag && !['--execute', '--reconcile'].includes(flag)) {
    console.log(JSON.stringify({ ok: false, code: 'THREADS_REACTION_INPUT' })); process.exitCode = 1;
  } else reactThreads({ operation, postId, expectedAuthor, execute: flag === '--execute', reconcile: flag === '--reconcile' })
    .then(r => { console.log(JSON.stringify(r)); if (r.success === false) process.exitCode = 2; })
    .catch(e => { console.log(JSON.stringify({ ok: false, code: safeCode(e) })); process.exitCode = 1; });
}
