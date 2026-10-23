import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withBotDebugScope, recordProtectedBotError } from './bot-debug-log.mjs';

const queues = new Map(), lastEvents = new Map(), logHealth = new Map(), capturedErrors = new WeakMap();
const debugService = bot => bot.startsWith('threads-') ? 'threads' : bot.startsWith('x-') ? 'x' : null;
const BOT_NAMES = new Set(['threads-benefits', 'threads-outreach', 'threads-watchdog', 'x-followback-bot',
  'x-invite-bot', 'x-reflection-bot', 'x-quickfact-bot', 'x-quickfact-blog-bot', 'x-supervisor', 'x-maintenance-watch', 'social-bot-reports']);
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(value) ? value : null;
const label = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(value) ? value : null;
const knownNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'TimeoutError', 'AbortError']);
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const stages = new Set(['fetch', 'cooldown_gate', 'response_body', 'decode', 'cookie_persistence', 'credential_read', 'credential_write',
  'bootstrap', 'local_open', 'local_write', 'local_sync', 'local_close', 'local_rename', 'local_cleanup', 'session_cleanup']);

// Request URLs, headers, bodies, error messages and arbitrary detail objects are
// deliberately absent. Paths are route templates supplied by our own clients.
export function safeRequestDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  if (methods.has(value.method)) result.method = value.method;
  if (typeof value.path === 'string' && /^\/(?:[A-Za-z0-9_.{}-]+\/)*[A-Za-z0-9_.{}-]*$/.test(value.path)
    && value.path.length <= 160) result.path = value.path;
  if (label(value.operation)) result.operation = value.operation;
  if (stages.has(value.stage)) result.stage = value.stage;
  if (['state', 'status', 'worker-status', 'journal', 'other'].includes(value.fileKind)) result.fileKind = value.fileKind;
  for (const key of ['elapsedMs', 'timeoutMs', 'bytes']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
  if (typeof value.writeSent === 'boolean') result.writeSent = value.writeSent;
  if (typeof value.bodyHash === 'string' && /^[0-9a-f]{64}$/.test(value.bodyHash)) result.bodyHash = value.bodyHash;
  if (typeof value.mime === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(value.mime)) result.mime = value.mime;
  const debug = safeDebugReferences(value.protectedDebugRecords);
  if (debug.length) result.protectedDebugRecords = debug;
  return Object.keys(result).length ? result : null;
}
export function safeDebugReferences(values) {
  return (Array.isArray(values)?values:[]).filter(value=>value&&['x','threads'].includes(value.service)
    && /^[0-9a-f-]{36}$/.test(value.id||'')&&typeof value.recorded==='boolean').slice(-12)
    .map(value=>({id:value.id,service:value.service,recorded:value.recorded,...(code(value.code)?{code:value.code}:{})}));
}

export function annotateBotError(error, request) {
  if (!error || typeof error !== 'object') return error;
  const diagnostic = safeRequestDiagnostic(request);
  try { if (diagnostic) error.requestDiagnostic = diagnostic; } catch { /* Frozen provider errors remain intact. */ }
  return error;
}

export async function traceBotRequest(metadata, operation) {
  const startedAt = Date.now(), diagnostic = { ...metadata, stage: 'fetch' };
  const records = new Map();
  const onRecord = record => { records.set(record.id,record);diagnostic.protectedDebugRecords=[...records.values()].slice(-12); };
  const trace = {
    stage(stage, response) {
      diagnostic.stage = stage;
      if (response) {
        diagnostic.httpStatus = response.status;
        const mime = response.headers?.get?.('content-type') || response.headers?.['content-type'];
        diagnostic.mime = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : null;
      }
    },
    body(text) { diagnostic.bytes = Buffer.byteLength(text); },
  };
  try { return await withBotDebugScope(onRecord,()=>operation(trace)); }
  catch (error) {
    const service=diagnostic.protectedDebugRecords?.at(-1)?.service;
    if(service&&!process.env.NODE_TEST_CONTEXT)onRecord(await recordProtectedBotError(service,error,{...diagnostic,elapsedMs:Date.now()-startedAt}));
    annotateBotError(error, { ...diagnostic, elapsedMs: Date.now() - startedAt }); throw error;
  }
}

export function safeBotFailure(error) {
  const receipt = error?.receipt || {}, diagnostic = error?.requestDiagnostic || error?.cause?.requestDiagnostic;
  const result = { name: knownNames.has(error?.name) ? error.name : 'unknown', code: code(error?.code),
    causeCode: code(error?.cause?.code) || code(receipt.causeCode), frames: [...String(error?.stack || '').matchAll(
      /[/\\](social-actions|web-api-playbook|naver-blog-api|tistory-api)[/\\]([a-z0-9./\\_-]+\.mjs):(\d{1,7}):(\d{1,7})/gi)]
      .slice(0, 6).map(m => `${m[1]}/${m[2].replaceAll('\\', '/')}:${m[3]}:${m[4]}`) };
  const debug = safeDebugReferences(error?.protectedDebugRecords);
  if (debug.length) result.protectedDebugRecords=debug;
  const schema = error?.responseSchema;
  if (schema && typeof schema === 'object') {
    result.responseSchema = {};
    for (const key of ['dataType', 'createType', 'resultType']) {
      if (['null', 'undefined', 'object', 'array', 'string', 'number', 'boolean'].includes(schema[key])) result.responseSchema[key] = schema[key];
    }
    for (const [key, allowed] of [['dataKeys', ['create_tweet']], ['createKeys', ['tweet_results']], ['resultKeys', ['tweet', 'rest_id', 'legacy', '__typename']]]) {
      if (Array.isArray(schema[key])) result.responseSchema[key] = [...new Set(schema[key].filter(value => allowed.includes(value)))];
    }
    if (Number.isSafeInteger(schema.errorCount) && schema.errorCount >= 0 && schema.errorCount <= 100) result.responseSchema.errorCount = schema.errorCount;
    if (['Tweet', 'TweetWithVisibilityResults', 'TweetTombstone', 'TweetUnavailable'].includes(schema.type)) result.responseSchema.type = schema.type;
  }
  const request = safeRequestDiagnostic(diagnostic);
  if (request) result.request = request;
  const cleanup = safeRequestDiagnostic(error?.cleanupDiagnostic);
  if (cleanup) result.cleanup = cleanup;
  if (error?.cleanupStore && typeof error.cleanupStore === 'object') {
    result.cleanupStore = {};
    if (typeof error.cleanupStore.timedOut === 'boolean') result.cleanupStore.timedOut = error.cleanupStore.timedOut;
    if (Number.isInteger(error.cleanupStore.exitStatus)) result.cleanupStore.exitStatus = error.cleanupStore.exitStatus;
    if (label(error.cleanupStore.stage)) result.cleanupStore.stage = error.cleanupStore.stage;
  }
  const store = /^CREDENTIAL_STORE_|^PROTECTED_STORE_/.test(error?.code || '') ? error.detail : receipt.store;
  if (store && typeof store === 'object') {
    result.localStore = {};
    if (typeof store.timedOut === 'boolean') result.localStore.timedOut = store.timedOut;
    if (Number.isInteger(store.exitStatus)) result.localStore.exitStatus = store.exitStatus;
    if (label(store.stage)) result.localStore.stage = store.stage;
  }
  if (['open', 'write', 'fsync', 'close', 'rename', 'unlink', 'read', 'readFile', 'spawn'].includes(error?.syscall)) result.syscall = error.syscall;
  for (const key of ['httpStatus', 'providerErrorCode', 'rateLimitReset', 'retryAfterSeconds', 'bytes']) {
    const value = receipt[key] ?? error?.[key];
    if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  for (const key of ['writeSent', 'needsReconciliation', 'writeCountUnknown']) {
    const value = receipt[key] ?? error?.[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  if (label(receipt.operation)) result.operation = receipt.operation;
  if (Array.isArray(receipt.errorCodes)) result.errorCodes = receipt.errorCodes.filter(Number.isSafeInteger).slice(0, 12);
  return result;
}

function safeStoredFailure(value) {
  if (!value || typeof value !== 'object') return null;
  // Re-sanitize persisted diagnostics too; old status files are not trusted logs.
  const result = safeBotFailure({ ...value, name: value.name, requestDiagnostic: value.request,
    cleanupDiagnostic: value.cleanup, receipt: { ...value, store: value.localStore } });
  result.frames = Array.isArray(value.frames) ? value.frames.filter(frame => typeof frame === 'string'
    && /^(?:(?:social-actions|web-api-playbook|naver-blog-api|tistory-api)\/)?[a-z0-9./_-]+\.mjs:\d{1,7}:\d{1,7}$/i.test(frame)).slice(0, 6) : [];
  return result;
}

export function safeBotEvent(bot, event, now = Date.now()) {
  if (!BOT_NAMES.has(bot)) throw Object.assign(new Error('BOT_LOG_INPUT_INVALID'), { code: 'BOT_LOG_INPUT_INVALID' });
  return { schemaVersion: 1, at: new Date(now).toISOString(), bot, pid: Number.isSafeInteger(event.pid) && event.pid > 0 ? event.pid : process.pid,
    event: ['started', 'finished', 'failure', 'worker_exit', 'target_hold', 'target_retry_deferred', 'historical_failure', 'read_budget_wait'].includes(event.event) ? event.event : 'failure',
    runStartedAt: Number.isFinite(Date.parse(event.runStartedAt || '')) ? new Date(event.runStartedAt).toISOString() : null,
    status: label(event.status), phase: label(event.phase), code: code(event.code),
    ...(['saved_write', 'live_write'].includes(event.failureOrigin) ? { failureOrigin: event.failureOrigin } : {}),
    ...(Number.isFinite(Date.parse(event.originalWriteAt || '')) ? { originalWriteAt: new Date(event.originalWriteAt).toISOString() } : {}),
    ...(BOT_NAMES.has(event.worker) ? { worker: event.worker } : {}),
    ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}),
    ...(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGABRT'].includes(event.signal) ? { signal: event.signal } : {}),
    ...(event.failure ? { failure: safeStoredFailure(event.failure) } : {}),
    ...(Number.isFinite(Date.parse(event.retryAt || '')) ? { retryAt: new Date(event.retryAt).toISOString() } : {}) };
}

export async function recordBotEvent(bot, root, event, { maxBytes = 1_000_000, archives = 4, now = Date.now } = {}) {
  const file = path.resolve(root, 'failures.jsonl'), safe = safeBotEvent(bot, event, now());
  const operation = async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const size = await stat(file).then(value => value.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
    const line = JSON.stringify(safe) + '\n';
    if (size && size + Buffer.byteLength(line) > maxBytes) {
      await rename(file, path.join(path.dirname(file), `failures-${Date.now()}-${randomUUID()}.jsonl`));
      const old = (await readdir(path.dirname(file))).filter(name => /^failures-\d+-[0-9a-f-]{36}\.jsonl$/.test(name)).sort().reverse();
      for (const name of old.slice(archives)) await unlink(path.join(path.dirname(file), name));
    }
    await appendFile(file, line, { mode: 0o600 });
  };
  const prior = queues.get(file) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  queues.set(file, current);
  try { await current; return { healthy: true }; }
  catch (error) { return { healthy: false, code: code(error?.code) || 'BOT_LOG_WRITE_FAILED' }; }
  finally { if (queues.get(file) === current) queues.delete(file); }
}

export async function recordBotFailure(bot, root, error, context = {}) {
  const failure = safeBotFailure(error), service = debugService(bot);
  if(service&&!process.env.NODE_TEST_CONTEXT){
    const reference=await recordProtectedBotError(service,error,{bot,...context});
    failure.protectedDebugRecords=[...(failure.protectedDebugRecords||[]),reference].slice(-12);
  }
  return recordBotEvent(bot, root,{ ...context, event: context.event || 'failure', code: code(error?.code) || context.code || 'BOT_FAILED', failure });
}

export function captureBotFailure(status, error, phase = status.workPhase || 'orchestration') {
  if(error&&typeof error==='object')capturedErrors.set(status,error);
  status.diagnostic = safeBotFailure(error);
  status.failurePhase = label(phase) || 'orchestration';
}

export async function recordBotStatus(bot, root, status) {
  const key = path.resolve(root) + ':' + bot;
  if (logHealth.has(key)) status.logging = logHealth.get(key);
  let event;
  if (status.status === 'starting' || status.status === 'running' && status.startedAt && !status.lastScanAt && !status.lastPollAt) event = 'started';
  if (code(status.code) || ['blocked', 'failed', 'cooldown', 'waiting_for_network', 'waiting_for_session', 'waiting_for_protected_store'].includes(status.status)) event = 'failure';
  if (event === 'failure' && status.status === 'waiting_for_reply_restriction' && status.failureOrigin === 'saved_write') event = 'historical_failure';
  if (event === 'failure' && status.code === 'THREADS_READ_BUDGET_WAIT'
    && status.cooldownReason === 'shared_read_budget' && status.deadlineSource === 'local_budget'
    && Number(status.httpStatus) !== 429 && status.rateLimited !== true
    && ['waiting_for_read_budget', 'waiting_for_queue', 'running'].includes(status.status)) event = 'read_budget_wait';
  if (status.finishedAt && ['stopped', 'expired', 'completed_once'].includes(status.status)) event = 'finished';
  if (!event) return;
  const rawError=capturedErrors.get(status),service=debugService(bot);
  if(rawError&&service&&!process.env.NODE_TEST_CONTEXT){
    const reference=await recordProtectedBotError(service,rawError,{bot,phase:status.failurePhase,status:status.status});
    status.diagnostic={...(status.diagnostic||safeBotFailure(rawError)),protectedDebugRecords:[...(status.diagnostic?.protectedDebugRecords||[]),reference].slice(-12)};
    status.debugLogging={healthy:reference.recorded,...reference};
    capturedErrors.delete(status);
  }
  const failureEvent = ['failure', 'historical_failure', 'read_budget_wait'].includes(event);
  const codeValue = code(status.code) || (failureEvent ? code(status.lastTransientCode) || 'BOT_FAILED' : null);
  const failure = status.diagnostic || status.lastReadTimeout?.failure || status.failure ||
    safeBotFailure({ code: codeValue, receipt: status.receipt, httpStatus: status.httpStatus });
  // Rechecking a durable refused write is not another dispatch or another incident.
  const fingerprint = event === 'historical_failure'
    ? JSON.stringify([event, codeValue, status.replyRestriction?.firstWriteAt || null, status.blockedScope || null])
    : event === 'read_budget_wait'
      ? JSON.stringify([event, status.startedAt, codeValue, status.retryAt])
    : JSON.stringify([event, status.startedAt, status.status, codeValue, status.retryAt,
      status.lastReadTimeout?.at, failure, event === 'finished' ? status.finishedAt : null]);
  if (lastEvents.get(key) === fingerprint) return;
  if (event === 'historical_failure') {
    const previous = await readBotFailureLog(root, { limit: 100 }).catch(() => []);
    if (previous.some(row => row.event === event && row.bot === bot && row.code === codeValue
      && row.originalWriteAt === status.replyRestriction?.firstWriteAt)) {
      lastEvents.set(key, fingerprint);
      return;
    }
  }
  const logging = await recordBotEvent(bot, root, { event, status: status.status, runStartedAt: status.startedAt,
    code: codeValue, phase: status.failurePhase || status.lastReadTimeout?.phase || status.workPhase,
    ...(failureEvent ? { failure } : {}), retryAt: status.retryAt,
    failureOrigin: status.failureOrigin, originalWriteAt: status.replyRestriction?.firstWriteAt });
  status.logging = logging;
  logHealth.set(key, logging);
  if (logging.healthy) lastEvents.set(key, fingerprint);
}

export async function readBotFailureLog(root, { limit = 20 } = {}) {
  const file = path.resolve(root, 'failures.jsonl');
  const raw = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return raw.trim().split('\n').filter(Boolean).slice(-Math.min(100, Math.max(1, limit))).map(line => {
    try { const value = JSON.parse(line); return safeBotEvent(value.bot, value, Date.parse(value.at)); } catch { return { code: 'BOT_LOG_LINE_INVALID' }; }
  });
}
