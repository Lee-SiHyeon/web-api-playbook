// Common read health checks. Transport, input validation, and response validation
// belong to the injected executor; this module never opens a connection itself.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const UNRESOLVED = Symbol('unresolved result reference');
const INVALID = Symbol('invalid input');
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function problem(code) {
  return Object.assign(new TypeError(code), { code });
}

// Only prove that {} is sufficient for simple schemas. Combinators, references,
// and other unknown constraints require an explicit health check instead.
function emptyInputSchema(schema) {
  if (schema === undefined || schema === true) return true;
  if (!object(schema)) return false;
  const known = new Set(['type', 'title', 'description', '$schema', '$id', '$comment',
    'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties',
    'default', 'examples']);
  return Object.keys(schema).every(key => known.has(key))
    && (schema.type === undefined || schema.type === 'object')
    && (schema.required === undefined || Array.isArray(schema.required) && !schema.required.length)
    && (schema.minProperties === undefined || schema.minProperties === 0);
}

function needsNoInput(operation, schemaVersion) {
  // Legacy profile fields are all required. A v2 path template can run with {}
  // only when every placeholder has an explicit field default.
  if (typeof operation.path === 'string' && /[{}]/.test(operation.path)) {
    const placeholders = [...operation.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)];
    if (schemaVersion !== 2 || /[{}]/.test(operation.path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ''))
      || placeholders.some(([, key]) => !object(operation.inputs?.path?.[key])
        || !Object.hasOwn(operation.inputs.path[key], 'default') && !Object.hasOwn(operation.inputs.path[key].schema ?? {}, 'default'))) return false;
  }
  for (const key of ['queryFields', 'bodyFields', 'requiredInput']) {
    if (operation[key] !== undefined && (!Array.isArray(operation[key]) || operation[key].length)) return false;
  }
  if (operation.inputs !== undefined) {
    if (!object(operation.inputs)) return false;
    for (const [group, fields] of Object.entries(operation.inputs)) {
      if (!['path', 'query', 'body'].includes(group) || !object(fields)) return false;
      for (const field of Object.values(fields)) {
        if (!object(field) || field.required !== undefined && typeof field.required !== 'boolean' && !Array.isArray(field.required)) return false;
        if (field.required === true && !Object.hasOwn(field, 'default') && !Object.hasOwn(field.schema ?? {}, 'default')) return false;
      }
    }
  }
  return emptyInputSchema(operation.inputSchema);
}

function selectedChecks(profile, checks) {
  const selected = checks !== undefined ? checks : profile.health?.checks !== undefined ? profile.health.checks
    : Object.entries(profile.operations)
      .filter(([, op]) => object(op) && op.semantics === 'read' && needsNoInput(op, profile.schemaVersion))
      .map(([operation]) => ({ operation }));
  if (!Array.isArray(selected) || selected.some(check => !object(check)
    || typeof check.operation !== 'string' || !check.operation.length
    || check.input !== undefined && !object(check.input))) throw problem('OPERATION_HEALTH_CHECKS_INVALID');
  return selected;
}

function pointerValue(data, pointer) {
  if (typeof pointer !== 'string' || pointer !== '' && !pointer.startsWith('/')) return UNRESOLVED;
  let value = data;
  for (const token of pointer === '' ? [] : pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(token)) return UNRESOLVED;
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return UNRESOLVED;
    if (Array.isArray(value) && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return UNRESOLVED;
    value = value[key];
  }
  return value === undefined ? UNRESOLVED : value;
}

function resolveInput(value, results, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') {
    return ['function', 'symbol', 'bigint'].includes(typeof value) ? INVALID : value;
  }
  if (ancestors.has(value)) return INVALID;
  const keys = Object.keys(value);
  if (!Array.isArray(value) && keys.length === 1 && keys[0] === '$result') {
    const reference = value.$result;
    if (!object(reference) || Object.keys(reference).length !== 2
      || !Object.hasOwn(reference, 'operation') || typeof reference.operation !== 'string'
      || !Object.hasOwn(reference, 'pointer') || !results.has(reference.operation)) return UNRESOLVED;
    const found = pointerValue(results.get(reference.operation), reference.pointer);
    if (found === UNRESOLVED) return UNRESOLVED;
    // Referenced data is literal, not another input template. Copy it so an
    // executor cannot alter another check's input or a preceding result.
    try { return structuredClone(found); } catch { return UNRESOLVED; }
  }
  ancestors.add(value);
  const entries = [];
  for (const key of keys) {
    const child = resolveInput(value[key], results, ancestors);
    if (child === UNRESOLVED || child === INVALID) { ancestors.delete(value); return child; }
    entries.push([key, child]);
  }
  ancestors.delete(value);
  return Array.isArray(value) ? Object.assign(new Array(value.length), Object.fromEntries(entries)) : Object.fromEntries(entries);
}

function aborted(error) {
  return error?.name === 'AbortError' || /(?:^|_)(?:ABORTED|ABORT_ERR)$/.test(String(error?.code ?? '').toUpperCase());
}

function failure(error) {
  if (aborted(error)) return { outcome: 'skipped', code: 'ABORTED' };
  const suppliedCode = typeof error?.code === 'string' && error.code.length ? error.code
    : typeof error?.cause?.code === 'string' ? error.cause.code : undefined;
  const tag = suppliedCode?.toUpperCase() ?? '';
  const rawStatus = error?.status ?? /(?:^|_)HTTP_(\d{3})$/.exec(tag)?.[1];
  const status = typeof rawStatus === 'number' ? rawStatus
    : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : undefined;
  const result = (outcome, code) => ({ outcome, code: suppliedCode ?? code });
  if (status === 429 || /(?:^|_)RATE_LIMIT(?:ED|ING)?(?:_|$)/.test(tag)) return result('rate_limited', 'RATE_LIMITED');
  if (status === 401 || status === 403 || REDIRECTS.has(status)
    || /(?:^|_)(?:AUTH_REQUIRED|AUTH_REJECTED|ACCESS_DENIED|PROVIDER_MISSING|OWNER_MISMATCH)(?:_|$)/.test(tag)) {
    return result('unreachable', status === 403 ? 'ACCESS_DENIED' : 'AUTH_REQUIRED');
  }
  if (/(?:^|_)(?:INPUT|PARAMETERS|PATH_PARAMETER|QUERY_FIELDS|QUERY_VALUE|BODY_FIELDS|BODY_VALUE)(?:_|$)/.test(tag)
    || ['OPERATION_UNKNOWN', 'OPERATION_ADAPTER_REQUIRED', 'OPERATION_SCHEMA_INVALID', 'OPERATION_PROFILE_INVALID',
      'EXTRACT_CONFIG_INVALID', 'EXTRACT_SELECTOR_INVALID', 'GET_BODY_FORBIDDEN'].includes(tag)) {
    return result('skipped', 'CHECK_INPUT_INVALID');
  }
  if (status === 0 || status === 408 || status === 425 || status >= 500 && status <= 599) return result('unreachable', `HTTP_${status}`);
  if (status >= 300 && status <= 499) return result('site_changed', `HTTP_${status}`);
  if (error?.name === 'SyntaxError' || /(?:SCHEMA|MIME|JSON|EXTRACT|SELECTOR)/.test(tag)
    || /(?:^|_)(?:SITE_CHANGED|OUTPUT_MISMATCH|RESPONSE_CHECK_INVALID|APPLICATION_RESULT_MISMATCH|GRAPHQL_ERRORS|HTTP_UNEXPECTED)(?:_|$)/.test(tag)) {
    return result('site_changed', 'RESPONSE_INVALID');
  }
  // Unknown executor/transport failures are not evidence of a changed site.
  // Never infer a result from free-form exception messages.
  return result('unreachable', 'EXECUTION_FAILED');
}

function runCheck(execute, operation, input, signal) {
  if (!signal) return Promise.resolve().then(() => execute(operation, input, { signal }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (ok) resolve(value); else reject(value);
    };
    const onAbort = () => finish(false, problem('ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      Promise.resolve(execute(operation, input, { signal })).then(
        value => finish(true, value), error => finish(false, error));
    } catch (error) { finish(false, error); }
  });
}

function summarize(serviceId, checks) {
  const completed = checks.filter(check => check.outcome !== 'skipped');
  const verdict = !completed.length ? 'no_checks' : checks.every(check => check.outcome === 'ok') ? 'ok'
    : completed[0].outcome !== 'ok' && completed.every(check => check.outcome === completed[0].outcome) ? completed[0].outcome : 'partial';
  const next = new Set();
  if (verdict === 'no_checks' && !checks.some(check => check.code === 'ABORTED')) next.add('configure_health_checks');
  for (const check of checks) {
    if (check.outcome === 'site_changed') next.add('review_operation_contract');
    if (check.outcome === 'rate_limited') next.add('retry_later');
    if (check.outcome === 'unreachable') next.add('check_availability');
    if (check.outcome === 'skipped') next.add(check.code === 'ABORTED' ? 'rerun_checks' : 'review_checks');
  }
  return { serviceId, verdict, checks, next: [...next] };
}

/**
 * Run ordered, read-only health checks with an injected executor. Explicit
 * checks override profile.health.checks (including []); otherwise only explicit
 * reads with no required caller input are selected. No profile/evidence state
 * is promoted or mutated, and no request is retried.
 *
 * execute(id, input, {signal}) resolves to {data, pageInfo?, receipt?}; the
 * executor owns response validation. Exact {$result:{operation,pointer}}
 * templates address earlier successful .data values using JSON Pointer.
 *
 * Outcomes: ok, site_changed, rate_limited, unreachable, skipped. All skipped
 * yields no_checks, all ok yields ok, homogeneous failures yield their outcome,
 * and mixed/incomplete success yields partial. next is an ordered, deduplicated
 * array of operational action codes. Abort yields skipped/ABORTED and prevents
 * later dispatch; an executor must honor signal to cancel its own in-flight IO.
 */
export async function checkOperations(profile, { execute, checks, signal } = {}) {
  if (!object(profile) || typeof profile.serviceId !== 'string' || !profile.serviceId.length
    || !object(profile.operations)) throw problem('OPERATION_HEALTH_PROFILE_INVALID');
  if (typeof execute !== 'function') throw problem('OPERATION_HEALTH_EXECUTOR_REQUIRED');
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function')) throw problem('OPERATION_HEALTH_SIGNAL_INVALID');
  const selected = selectedChecks(profile, checks);
  const results = new Map(), observations = [];
  let cancelled = false;
  for (const check of selected) {
    const operation = check.operation;
    const definition = Object.hasOwn(profile.operations, operation) ? profile.operations[operation] : undefined;
    let observation;
    if (cancelled || signal?.aborted) observation = { outcome: 'skipped', code: 'ABORTED' };
    else if (!object(definition)) observation = { outcome: 'skipped', code: 'OPERATION_UNKNOWN' };
    else if (definition.semantics !== 'read') observation = { outcome: 'skipped',
      code: definition.semantics === 'write' ? 'WRITE_OPERATION_SKIPPED' : 'OPERATION_NOT_READ' };
    else {
      const input = resolveInput(check.input ?? {}, results);
      // A repeated check replaces its previous result, even when the new check
      // fails or is skipped. Dependents must never reuse a stale success.
      results.delete(operation);
      if (input === UNRESOLVED || input === INVALID || !object(input)) observation = { outcome: 'skipped',
        code: input === UNRESOLVED ? 'RESULT_REFERENCE_UNRESOLVED' : 'CHECK_INPUT_INVALID' };
      else {
        try {
          const response = await runCheck(execute, operation, input, signal);
          if (signal?.aborted) throw problem('ABORTED');
          if (!object(response) || !Object.hasOwn(response, 'data')) throw problem('OPERATION_ADAPTER_RESULT_INVALID');
          results.set(operation, response.data);
          observation = { outcome: 'ok' };
        } catch (error) {
          observation = failure(error);
          cancelled = observation.code === 'ABORTED';
        }
      }
    }
    if (observation.outcome !== 'ok') results.delete(operation);
    observations.push({ operation, ...observation });
  }
  return summarize(profile.serviceId, observations);
}
