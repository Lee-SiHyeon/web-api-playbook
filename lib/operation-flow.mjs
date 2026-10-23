/**
 * Profile-independent, network-free operation runners.
 *
 * execute(id, input, {signal}) may return JSON data directly, or an envelope
 * with an OWN `data` property ({data, pageInfo?, receipt?}). Such a property
 * always denotes an envelope; wrap a payload containing `data` once more.
 * Pointers and result bindings address the unwrapped data, not the envelope.
 * Metadata is retained, never interpreted as proof of capability/health.
 * Throws and returned {ok:false,...} failures stop execution (no auto-retries).
 * All input/data/checkpoints must be JSON values; configuration errors reject.
 * onCheckpoint receives isolated JSON snapshots. If persistence rejects, the
 * rejection has code CHECKPOINT_FAILED and the latest `.checkpoint` to resume.
 * Successful work is not replayed when resuming a saved checkpoint. Work whose
 * executor never acknowledged completion cannot have exactly-once guarantees.
 */

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const missing = Symbol('missing');

function problem(code, detail = {}) {
  return Object.assign(new Error(code), { code, ...detail });
}

function json(value, code = 'VALUE_NOT_JSON', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)
    || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw problem(code);
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let i = 0; i < value.length; i++) {
      if (!own(value, i)) throw problem(code);
      result.push(json(value[i], code, ancestors));
    }
  } else result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, json(child, code, ancestors)]));
  ancestors.delete(value);
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function tokens(pointer) {
  if (typeof pointer !== 'string' || pointer !== '' && !pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) throw problem('JSON_POINTER_INVALID');
  return pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function at(value, pointer) {
  for (const key of tokens(pointer)) {
    if (!own(value, key) || Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return missing;
    value = value[key];
  }
  return value;
}

function put(input, pointer, value) {
  const parts = tokens(pointer);
  if (!parts.length) throw problem('PAGINATION_INPUT_PATH_INVALID');
  let target = input;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (!object(target) && !Array.isArray(target)
      || Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > target.length)) throw problem('PAGINATION_INPUT_PATH_INVALID');
    if (i === parts.length - 1) Object.defineProperty(target, key, { value: json(value), writable: true, enumerable: true, configurable: true });
    else {
      if (!own(target, key)) Object.defineProperty(target, key, {
        value: /^(0|[1-9]\d*)$/.test(parts[i + 1]) ? [] : {}, writable: true, enumerable: true, configurable: true,
      });
      target = target[key];
    }
  }
  return input;
}

function dependencies({ execute, onCheckpoint, signal }) {
  if (typeof execute !== 'function' || onCheckpoint !== undefined && typeof onCheckpoint !== 'function'
    || signal !== undefined && !(signal instanceof AbortSignal)) throw problem('FLOW_DEPENDENCIES_INVALID');
}

function failure(value) {
  const source = object(value?.error) ? value.error : value;
  const status = [value?.status, value?.statusCode, value?.httpStatus, value?.response?.status,
    value?.receipt?.httpStatus, source?.status, source?.statusCode, source?.httpStatus].find(Number.isInteger);
  let code = typeof source?.code === 'string' ? source.code : 'OPERATION_FAILED';
  if (status === 403) code = 'ACCESS_DENIED';
  if (status === 429) code = 'RATE_LIMITED';
  if (source?.name === 'AbortError' || ['OPERATION_ABORTED', 'ABORT_ERR'].includes(code)) code = 'ABORTED';
  return { code, ...(status === undefined ? {} : { status }) };
}

function reasonFor(error) {
  return ({ ACCESS_DENIED: 'access_denied', RATE_LIMITED: 'rate_limited', ABORTED: 'aborted',
    DEADLINE_EXCEEDED: 'deadline', RESULT_REFERENCE_MISSING: 'missing_result' })[error.code] ?? 'error';
}

function unpack(value) {
  if (value?.ok === false || [value?.status, value?.statusCode, value?.httpStatus, value?.receipt?.httpStatus].some(status => Number.isInteger(status) && status >= 400)) throw problem('OPERATION_FAILED', failure(value));
  const envelope = own(value, 'data');
  return { data: json(envelope ? value.data : value, 'RESULT_NOT_JSON'),
    metadata: Object.fromEntries(['pageInfo', 'receipt'].filter(key => envelope && value[key] !== undefined)
      .map(key => [key, json(value[key], 'RESULT_NOT_JSON')])) };
}

async function invoke(execute, operation, input, signal) {
  if (signal?.aborted) throw problem('ABORTED');
  let listener;
  try {
    const aborted = signal && new Promise((_, reject) => {
      listener = () => reject(problem('ABORTED'));
      signal.addEventListener('abort', listener, { once: true });
    });
    const pending = Promise.resolve().then(() => {
      if (signal?.aborted) throw problem('ABORTED');
      return execute(operation, json(input), { signal });
    });
    return unpack(await (aborted ? Promise.race([pending, aborted]) : pending));
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}

async function publish(state, onCheckpoint) {
  if (!onCheckpoint) return;
  try { await onCheckpoint(json(state)); }
  catch (cause) { throw problem('CHECKPOINT_FAILED', { checkpoint: json(state), cause }); }
}

function bind(value, results) {
  if (object(value) && Object.keys(value).length === 1 && own(value, '$result')) {
    const ref = value.$result;
    if (!object(ref) || Object.keys(ref).sort().join(',') !== 'pointer,step'
      || typeof ref.step !== 'string') throw problem('RESULT_REFERENCE_INVALID');
    tokens(ref.pointer);
    const result = own(results, ref.step) ? at(results[ref.step], ref.pointer) : missing;
    if (result === missing) throw problem('RESULT_REFERENCE_MISSING', { step: ref.step, pointer: ref.pointer });
    return json(result);
  }
  if (Array.isArray(value)) return value.map(child => bind(child, results));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bind(child, results)]));
  return value;
}

/**
 * Steps: {id, operation, input?: JSON object, onMissing?: 'fail'|'skip'}.
 * Only exact {$result:{step:'id',pointer:'/items/0/id'}} objects bind; other
 * objects/strings remain literal. IDs are unique. Execution is sequential.
 * results[id] contains data; metadata[id] retains pageInfo/receipt. A skipped
 * step has no result. complete means all steps handled, not all succeeded:
 * skips yield {complete:true, partial:true, ok:false}. Errors/abort are partial.
 * Resume retries only the unfinished step; completed/skipped steps stay saved.
 */
export async function runOperationFlow({ steps } = {}, { execute, checkpoint, signal, onCheckpoint } = {}) {
  dependencies({ execute, signal, onCheckpoint });
  if (!Array.isArray(steps)) throw problem('FLOW_STEPS_INVALID');
  const spec = json(steps, 'FLOW_STEPS_INVALID');
  const ids = new Set();
  for (const step of spec) {
    if (!object(step) || typeof step.id !== 'string' || !step.id || ids.has(step.id)
      || typeof step.operation !== 'string' || !step.operation || step.input !== undefined && !object(step.input)
      || step.onMissing !== undefined && !['fail', 'skip'].includes(step.onMissing)) throw problem('FLOW_STEPS_INVALID');
    ids.add(step.id);
  }
  let state = { version: 1, type: 'operation-flow', definition: spec, nextStep: 0, results: {}, metadata: {}, steps: [],
    counters: { requests: 0, completed: 0, skipped: 0 }, complete: false, terminal: false, reason: null };
  if (checkpoint !== undefined) {
    state = json(checkpoint, 'CHECKPOINT_INVALID');
    if (state?.version !== 1 || state.type !== 'operation-flow' || canonical(state.definition) !== canonical(spec)) throw problem('CHECKPOINT_MISMATCH');
    if (!Number.isSafeInteger(state.nextStep) || state.nextStep < 0 || state.nextStep > spec.length
      || !object(state.results) || !object(state.metadata) || !Array.isArray(state.steps) || state.steps.length !== state.nextStep
      || !validCounters(state.counters, ['requests', 'completed', 'skipped']) || typeof state.terminal !== 'boolean'
      || typeof state.complete !== 'boolean' || state.reason !== null && typeof state.reason !== 'string'
      || state.counters.completed + state.counters.skipped !== state.nextStep || state.counters.completed > state.counters.requests
      || state.complete && (!state.terminal || state.nextStep !== spec.length)
      || state.steps.some((step, index) => !object(step) || step.id !== spec[index].id || step.operation !== spec[index].operation
        || !['completed', 'skipped'].includes(step.status) || (step.status === 'completed') !== own(state.results, step.id))
      || Object.keys(state.results).length !== state.counters.completed) throw problem('CHECKPOINT_INVALID');
  }
  const result = () => json({ ok: state.complete && !state.counters.skipped, complete: state.complete,
    partial: !state.complete || state.counters.skipped > 0, terminal: state.terminal, reason: state.reason,
    results: state.results, metadata: state.metadata, steps: state.steps, counters: state.counters,
    ...(state.error ? { error: state.error } : {}), checkpoint: state });
  const finish = async (reason, terminal = false, complete = false, error) => {
    Object.assign(state, { reason, terminal, complete });
    if (error) state.error = error;
    await publish(state, onCheckpoint);
    return result();
  };
  if (state.terminal) return result();
  state.reason = null;
  delete state.error;
  while (state.nextStep < spec.length) {
    if (signal?.aborted) return finish('aborted', false, false, { code: 'ABORTED' });
    const step = spec[state.nextStep];
    let input;
    try {
      input = bind(step.input ?? {}, state.results);
      if (!object(input)) throw problem('FLOW_INPUT_INVALID');
    }
    catch (error) {
      if (error.code !== 'RESULT_REFERENCE_MISSING' || step.onMissing !== 'skip') {
        return finish(reasonFor(error), true, false, { ...failure(error),
          ...(error.step ? { step: error.step, pointer: error.pointer } : {}) });
      }
      state.steps.push({ id: step.id, operation: step.operation, status: 'skipped', reason: 'missing_result' });
      state.counters.skipped++;
      state.nextStep++;
      await publish(state, onCheckpoint);
      continue;
    }
    let executed;
    try {
      state.counters.requests++;
      executed = await invoke(execute, step.operation, input, signal);
    } catch (cause) {
      const error = signal?.aborted ? { code: 'ABORTED' } : failure(cause);
      return finish(reasonFor(error), false, false, error);
    }
    Object.defineProperty(state.results, step.id, { value: executed.data, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(state.metadata, step.id, { value: executed.metadata, writable: true, enumerable: true, configurable: true });
    state.steps.push({ id: step.id, operation: step.operation, status: 'completed' });
    state.counters.completed++;
    state.nextStep++;
    await publish(state, onCheckpoint);
  }
  return finish(state.counters.skipped ? 'completed_with_skips' : 'completed', true, true);
}

function validCounters(counters, keys) {
  return object(counters) && keys.every(key => Number.isSafeInteger(counters[key]) && counters[key] >= 0);
}

function declaration(pagination) {
  if (!object(pagination)) throw problem('PAGINATION_INVALID');
  const spec = json(pagination, 'PAGINATION_INVALID');
  if (!['page', 'cursor', 'offset', 'next_url'].includes(spec.kind) || !tokens(spec.inputPath).length) throw problem('PAGINATION_INVALID');
  tokens(spec.itemsPointer);
  for (const key of ['nextPointer', 'idPointer']) if (spec[key] !== undefined) tokens(spec[key]);
  if (['cursor', 'next_url'].includes(spec.kind) && spec.nextPointer === undefined) throw problem('PAGINATION_CONTINUATION_REQUIRED');
  if (spec.step !== undefined && (!Number.isSafeInteger(spec.step) || spec.step <= 0)
    || spec.pageSize !== undefined && (!Number.isSafeInteger(spec.pageSize) || spec.pageSize <= 0)) throw problem('PAGINATION_INVALID');
  return spec;
}

const absentContinuation = value => value === missing || value === null || value === '' || value === false;
function continuation(value, kind) {
  if (absentContinuation(value)) return;
  if (kind === 'next_url') {
    if (typeof value !== 'string') throw problem('PAGINATION_CONTINUATION_INVALID');
  } else if (['page', 'offset'].includes(kind)) {
    if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw problem('PAGINATION_CONTINUATION_INVALID');
  } else if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw problem('PAGINATION_CONTINUATION_INVALID');
}

function nextPage(input, data, spec) {
  let value;
  if (spec.nextPointer !== undefined) {
    value = at(data, spec.nextPointer);
    if (absentContinuation(value)) return null;
  } else {
    const current = at(input, spec.inputPath);
    continuation(current, spec.kind);
    if (absentContinuation(current)) throw problem('PAGINATION_CONTINUATION_INVALID');
    const increment = spec.step ?? (spec.kind === 'offset' ? spec.pageSize ?? 1 : 1);
    value = Number(current) + increment;
    if (!Number.isSafeInteger(value)) throw problem('PAGINATION_CONTINUATION_INVALID');
    if (typeof current === 'string') value = String(value);
  }
  continuation(value, spec.kind);
  return put(json(input), spec.inputPath, value);
}

function identity(record, spec) {
  if (spec.idPointer === undefined) return missing;
  const id = at(record, spec.idPointer);
  return ['string', 'number', 'boolean'].includes(typeof id) ? canonical(id) : missing;
}

function pageSignature(items, spec) {
  const ids = items.map(item => identity(item, spec));
  return ids.every(id => id !== missing) ? `ids:${canonical(ids)}` : `records:${canonical(items)}`;
}

/**
 * pagination: {kind:'page'|'cursor'|'offset'|'next_url', inputPath, itemsPointer,
 *   nextPointer?, start?, step?, pageSize?, idPointer?} (RFC 6901 pointers).
 * Existing nested input is preserved. Numeric page/offset start defaults to
 * 1/0; offset advances by step ?? pageSize ?? 1, page by step ?? 1. Numeric
 * strings remain strings. pageSize does NOT invent/send a page-size parameter.
 * Declared nextPointer is authoritative: missing/null/''/false ends traversal;
 * 0 is valid. Cursor/next_url require nextPointer. next_url is passed verbatim
 * to the declared input path: this module never fetches or resolves a URL.
 * No inferred endpoints, sorting, totals, has-more flags or short-page rules.
 *
 * budget: per-invocation {maxPages:100,maxItems:10000,deadlineMs:30000}; zero
 * prevents new requests. Already-buffered records can consume an item budget
 * without using a page budget. Deadline is elapsed milliseconds, not an epoch timestamp.
 * counters are cumulative: requests includes failed attempts, pages includes
 * accepted responses (empty/repeated too), items is records.length, duplicates
 * counts item-level ID suppression (not whole discarded repeated pages).
 * IDs are exact typed scalars; missing/null/non-scalar
 * IDs are not deduped. First record for an ID wins. Ordering is server order.
 *
 * Returns {ok,complete,partial,terminal,reason,records,counters,pageInfo,
 * receipts,error?,checkpoint}. Only empty_page/missing_continuation are natural
 * completion; repeats and invalid continuations are terminal PARTIAL results.
 * An invalid continuation retains the accepted page rather than refetching it.
 * Budgets/executor errors/abort are resumable. A checkpoint retains nextInput, buffered unconsumed page records,
 * dedupe records, loop history and counters; resume never refetches an accepted
 * page, including when maxItems stopped in its middle. Terminal checkpoints
 * make no executor calls. Snapshot durability is the caller's responsibility.
 */
export async function collectOperationPages({ operation, input = {}, pagination, budget = {} } = {},
  { execute, checkpoint, signal, onCheckpoint } = {}) {
  dependencies({ execute, signal, onCheckpoint });
  if (typeof operation !== 'string' || !operation || !object(input) || !object(budget)) throw problem('PAGINATION_INVALID');
  const spec = declaration(pagination);
  const initial = json(input, 'PAGINATION_INPUT_INVALID');
  const limits = { maxPages: 100, maxItems: 10000, deadlineMs: 30000, ...budget };
  if (Object.keys(budget).some(key => !['maxPages', 'maxItems', 'deadlineMs'].includes(key))
    || !['maxPages', 'maxItems', 'deadlineMs'].every(key => Number.isSafeInteger(limits[key]) && limits[key] >= 0)
    || limits.deadlineMs > 2147483647) throw problem('PAGINATION_BUDGET_INVALID');
  const definition = { operation, input: initial, pagination: spec };
  let state = { version: 1, type: 'operation-pages', definition, nextInput: json(initial), records: [], pending: [], end: null,
    counters: { requests: 0, pages: 0, items: 0, duplicates: 0 }, seenInputs: [], seenPages: [],
    pageInfo: null, receipts: [], terminal: false, complete: false, reason: null };
  if (checkpoint !== undefined) {
    state = json(checkpoint, 'CHECKPOINT_INVALID');
    if (state?.version !== 1 || state.type !== 'operation-pages' || canonical(state.definition) !== canonical(definition)) throw problem('CHECKPOINT_MISMATCH');
    if (!Array.isArray(state.records) || !Array.isArray(state.pending) || !Array.isArray(state.receipts)
      || !Array.isArray(state.seenInputs) || !Array.isArray(state.seenPages)
      || ![...state.seenInputs, ...state.seenPages].every(value => typeof value === 'string')
      || !validCounters(state.counters, ['requests', 'pages', 'items', 'duplicates']) || state.counters.items !== state.records.length
      || typeof state.terminal !== 'boolean' || typeof state.complete !== 'boolean' || !own(state, 'pageInfo')
      || state.reason !== null && typeof state.reason !== 'string' || state.counters.pages > state.counters.requests
      || state.seenInputs.length !== state.counters.pages || state.seenPages.length > state.counters.pages
      || state.receipts.length > state.counters.pages || state.terminal && state.pending.length > 0
      || state.complete && (!state.terminal || state.end?.complete !== true)
      || state.nextInput !== null && !object(state.nextInput)
      || state.end !== null && (!object(state.end) || typeof state.end.reason !== 'string' || typeof state.end.complete !== 'boolean')) throw problem('CHECKPOINT_INVALID');
  } else {
    let current = at(state.nextInput, spec.inputPath);
    if (current === missing && (own(spec, 'start') || ['page', 'offset'].includes(spec.kind))) {
      put(state.nextInput, spec.inputPath, own(spec, 'start') ? spec.start : spec.kind === 'page' ? 1 : 0);
      current = at(state.nextInput, spec.inputPath);
    }
    continuation(current, spec.kind);
    if (['page', 'offset'].includes(spec.kind) && absentContinuation(current)) throw problem('PAGINATION_CONTINUATION_INVALID');
  }
  const result = () => json({ ok: state.complete, complete: state.complete, partial: !state.complete,
    terminal: state.terminal, reason: state.reason, records: state.records, counters: state.counters,
    pageInfo: state.pageInfo, receipts: state.receipts, ...(state.error ? { error: state.error } : {}), checkpoint: state });
  if (state.terminal) return result();
  state.reason = null;
  delete state.error;
  if (state.end?.error) state.error = state.end.error;
  const ids = new Set(state.records.map(record => identity(record, spec)).filter(id => id !== missing));
  const seenInputs = new Set(state.seenInputs), seenPages = new Set(state.seenPages);
  const controller = new AbortController();
  const started = Date.now();
  let runPages = 0, runItems = 0, timedOut = false;
  const stopReason = () => signal?.aborted ? 'aborted' : timedOut || Date.now() - started >= limits.deadlineMs ? 'deadline' : null;
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; forwardAbort(); }, limits.deadlineMs);
  const finish = async (reason, terminal = false, complete = false, error) => {
    Object.assign(state, { reason, terminal, complete });
    if (error) state.error = error;
    await publish(state, onCheckpoint);
    return result();
  };
  try {
    while (true) {
      if (state.pending.length) {
        let consumed = 0, stop;
        for (const record of state.pending) {
          if ((stop = stopReason())) break;
          const id = identity(record, spec);
          if (id !== missing && ids.has(id)) state.counters.duplicates++;
          else {
            if (runItems >= limits.maxItems) { stop = 'max_items'; break; }
            state.records.push(record);
            if (id !== missing) ids.add(id);
            runItems++;
            state.counters.items++;
          }
          consumed++;
        }
        state.pending = state.pending.slice(consumed);
        if (stop) return finish(stop);
        if (!state.end && !stopReason() && runPages < limits.maxPages && runItems < limits.maxItems) await publish(state, onCheckpoint);
      }
      if (state.end) return finish(state.end.reason, true, state.end.complete, state.end.error);
      const stop = stopReason();
      if (stop) return finish(stop);
      if (runItems >= limits.maxItems) return finish('max_items');
      if (runPages >= limits.maxPages) return finish('max_pages');
      if (!state.nextInput) throw problem('CHECKPOINT_INVALID');
      const requestInput = json(state.nextInput);
      const requestKey = canonical(requestInput);
      if (seenInputs.has(requestKey)) return finish(['cursor', 'next_url'].includes(spec.kind) ? 'repeated_cursor' : 'repeated_page', true);
      let executed, items, signature, next, end;
      try {
        state.counters.requests++;
        executed = await invoke(execute, operation, requestInput, controller.signal);
        items = at(executed.data, spec.itemsPointer);
        if (!Array.isArray(items)) throw problem('PAGINATION_ITEMS_INVALID');
        signature = pageSignature(items, spec);
        end = !items.length ? { reason: 'empty_page', complete: true }
          : seenPages.has(signature) ? { reason: 'repeated_page', complete: false } : null;
      } catch (cause) {
        const stopped = stopReason();
        const error = stopped ? { code: stopped === 'aborted' ? 'ABORTED' : 'DEADLINE_EXCEEDED' } : failure(cause);
        return finish(reasonFor(error), false, false, error);
      }
      // A valid page is acknowledged even if its continuation is malformed.
      // Keep its records and stop honestly; do not retry that successful input.
      try {
        next = end ? null : nextPage(requestInput, executed.data, spec);
        if (!end && next === null) end = { reason: 'missing_continuation', complete: true };
        if (!end && (seenInputs.has(canonical(next)) || canonical(next) === requestKey)) {
          end = { reason: ['cursor', 'next_url'].includes(spec.kind) ? 'repeated_cursor' : 'repeated_page', complete: false };
          next = null;
        }
      } catch (cause) {
        const error = failure(cause);
        end = { reason: reasonFor(error), complete: false, error };
        state.error = error;
        next = null;
      }
      state.counters.pages++;
      runPages++;
      seenInputs.add(requestKey);
      state.seenInputs.push(requestKey);
      if (!seenPages.has(signature)) { seenPages.add(signature); state.seenPages.push(signature); }
      state.pending = end?.reason === 'repeated_page' ? [] : items;
      state.end = end;
      state.nextInput = next;
      state.pageInfo = executed.metadata.pageInfo ?? null;
      if (executed.metadata.receipt !== undefined) state.receipts.push(executed.metadata.receipt);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
