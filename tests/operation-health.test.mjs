import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { checkOperations } from '../lib/operation-health.mjs';

const read = extra => ({ semantics: 'read', ...extra });
const profile = (operations, extra) => ({ serviceId: 'fixture', operations, ...extra });
const check = (operation, input) => ({ operation, ...(input === undefined ? {} : { input }) });
const ref = (operation, pointer) => ({ $result: { operation, pointer } });
const error = (code, status) => Object.assign(new Error('arbitrary detail; not classification evidence'),
  code === undefined ? {} : { code }, status === undefined ? {} : { status });
const success = data => ({ data, pageInfo: {}, receipt: { executionMode: 'fixture' } });
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('health never dispatches writes or infers read semantics from HTTP methods', async () => {
  const p = profile({
    write: { semantics: 'write', method: 'GET' },
    undeclared: { method: 'GET' },
    postRead: read({ method: 'POST' }),
  });
  const calls = [];
  const result = await checkOperations(p, {
    checks: ['write', 'undeclared', 'postRead', 'unknown', 'toString'].map(id => check(id)),
    execute: async (...args) => { calls.push(args); return success([]); },
  });
  assert.deepEqual(calls, [['postRead', {}, { signal: undefined }]]);
  assert.deepEqual(result, {
    serviceId: 'fixture', verdict: 'partial', next: ['review_checks'], checks: [
      { operation: 'write', outcome: 'skipped', code: 'WRITE_OPERATION_SKIPPED' },
      { operation: 'undeclared', outcome: 'skipped', code: 'OPERATION_NOT_READ' },
      { operation: 'postRead', outcome: 'ok' },
      { operation: 'unknown', outcome: 'skipped', code: 'OPERATION_UNKNOWN' },
      { operation: 'toString', outcome: 'skipped', code: 'OPERATION_UNKNOWN' },
    ],
  });
});

test('automatic checks conservatively recognize grouped v2 and legacy required inputs', async () => {
  const p = freeze(profile({
    plain: read(),
    optional: read({ inputs: { query: { limit: { type: 'integer', required: false } } } }),
    defaulted: read({ inputs: { query: { limit: { type: 'integer', required: true, default: 0 } } } }),
    nestedOptional: read({ inputs: { body: { filters: { schema: {
      type: 'object', required: ['term'], properties: { term: { type: 'string' } },
    } } } } }),
    nestedDefault: read({ inputs: { body: { filters: { required: true, default: {}, schema: { type: 'object' } } } } }),
    requiredQuery: read({ inputs: { query: { term: { type: 'string', required: true } } } }),
    requiredBody: read({ inputs: { body: { filters: { required: true, schema: { type: 'object' } } } } }),
    requiredPath: read({ inputs: { path: { id: { type: 'integer', required: true } } } }),
    defaultedPath: read({ path: '/items/{id}', inputs: { path: { id: { type: 'integer', required: true, default: 1 } } } }),
    optionalPathWithoutDefault: read({ path: '/items/{id}', inputs: { path: { id: { type: 'integer' } } } }),
    inheritedDefault: read({ inputs: { query: { term: Object.assign(Object.create({ default: 'fixture' }), { required: true }) } } }),
    legacyQuery: read({ queryFields: ['term'] }),
    legacyBody: read({ bodyFields: ['term'] }),
    legacyPath: read({ path: '/items/{id}' }),
    badInputDefinition: read({ inputs: { query: { term: null } } }),
    unknownInputGroup: read({ inputs: { arguments: {} } }),
    write: { semantics: 'write' },
  }, { schemaVersion: 2 }));
  const calls = [];
  const result = await checkOperations(p, { execute: async (id, input) => {
    calls.push([id, input]); return success(null);
  } });
  assert.deepEqual(calls, ['plain', 'optional', 'defaulted', 'nestedOptional', 'nestedDefault', 'defaultedPath'].map(id => [id, {}]));
  assert.equal(result.verdict, 'ok');
  assert.deepEqual(result.next, []);
  assert.deepEqual(result.checks, calls.map(([operation]) => ({ operation, outcome: 'ok' })));
});

test('v1 query/body fields and path placeholders are never automatically called, even with v2-like defaults', async () => {
  const p = profile({
    plain: read({ path: '/items', queryFields: [], bodyFields: [] }),
    query: read({ queryFields: ['q'] }), body: read({ bodyFields: ['id'] }),
    path: read({ path: '/items/{id}', inputs: { path: { id: { required: true, default: 1 } } } }),
  }, { schemaVersion: 1 });
  const calls = [];
  await checkOperations(p, { execute: id => { calls.push(id); return success([]); } });
  assert.deepEqual(calls, ['plain']);
});

test('automatic checks do not guess empty inputs for constrained JSON schemas', async () => {
  const p = profile({
    empty: read({ inputSchema: { type: 'object', required: [], properties: { query: { required: ['term'] } } } }),
    required: read({ inputSchema: { type: 'object', required: ['query'] } }),
    combinator: read({ inputSchema: { anyOf: [{ required: ['query'] }] } }),
    reference: read({ inputSchema: { $ref: '#/$defs/Query' } }),
    nonempty: read({ inputSchema: { minProperties: 1 } }),
    impossible: read({ inputSchema: false }),
    legacyRequired: read({ requiredInput: ['term'] }),
  });
  const calls = [];
  const result = await checkOperations(p, { execute: id => { calls.push(id); return success({}); } });
  assert.deepEqual(calls, ['empty']);
  assert.equal(result.verdict, 'ok');
});

test('no runnable default checks yields no_checks without executing anything', async () => {
  const result = await checkOperations(profile({ write: { semantics: 'write' }, detail: read({ path: '/{id}' }) }), {
    execute: () => assert.fail('no operation should execute'),
  });
  assert.deepEqual(result, { serviceId: 'fixture', verdict: 'no_checks', checks: [], next: ['configure_health_checks'] });
  assert.deepEqual(await checkOperations(profile({}), { execute: () => assert.fail('empty profile must not dispatch') }), result);
});

test('explicit checks override profile health checks, and [] never falls back', async () => {
  const p = profile({ automatic: read(), configured: read(), explicit: read() }, {
    health: { checks: [check('configured', { query: { limit: 1 } })] },
  });
  const calls = [];
  const execute = async (id, input) => { calls.push([id, input]); return success([]); };
  await checkOperations(p, { execute });
  await checkOperations(p, { execute, checks: [check('explicit')] });
  const empty = await checkOperations(p, { execute, checks: [] });
  const configuredEmpty = await checkOperations({ ...p, health: { checks: [] } }, { execute });
  assert.deepEqual(calls, [['configured', { query: { limit: 1 } }], ['explicit', {}]]);
  assert.equal(empty.verdict, 'no_checks');
  assert.equal(configuredEmpty.verdict, 'no_checks');
});

test('configured write-only checks are skipped rather than replaced by successful reads', async () => {
  const result = await checkOperations(profile({ write: { semantics: 'write' }, other: read() }, {
    health: { checks: [check('write')] },
  }), { execute: () => assert.fail('configured write must not execute') });
  assert.equal(result.verdict, 'no_checks');
  assert.deepEqual(result.checks, [{ operation: 'write', outcome: 'skipped', code: 'WRITE_OPERATION_SKIPPED' }]);
});

test('explicit checks may supply required grouped inputs without flattening or defaulting them', async () => {
  const p = profile({ search: read({ inputs: { query: {
    term: { required: true, type: 'string' }, page: { type: 'integer' }, active: { type: 'boolean' },
  } } }) }, { schemaVersion: 2 });
  const input = freeze({ query: { term: 'fixture', page: 0, active: false } });
  const result = await checkOperations(p, { checks: [check('search', input)], execute: (id, supplied) => {
    assert.equal(id, 'search'); assert.deepEqual(supplied, input); return success([]);
  } });
  assert.equal(result.verdict, 'ok');
});

test('HTTP status classification is deterministic, including auth/access operational codes', async t => {
  const cases = [
    [0, 'unreachable', 'HTTP_0'], [301, 'unreachable', 'AUTH_REQUIRED'],
    [302, 'unreachable', 'AUTH_REQUIRED'], [303, 'unreachable', 'AUTH_REQUIRED'],
    [307, 'unreachable', 'AUTH_REQUIRED'], [308, 'unreachable', 'AUTH_REQUIRED'],
    [304, 'site_changed', 'HTTP_304'], [400, 'site_changed', 'HTTP_400'],
    [401, 'unreachable', 'AUTH_REQUIRED'], [403, 'unreachable', 'ACCESS_DENIED'],
    [404, 'site_changed', 'HTTP_404'], [405, 'site_changed', 'HTTP_405'],
    [408, 'unreachable', 'HTTP_408'], [410, 'site_changed', 'HTTP_410'],
    [422, 'site_changed', 'HTTP_422'], [425, 'unreachable', 'HTTP_425'],
    [429, 'rate_limited', 'RATE_LIMITED'], [500, 'unreachable', 'HTTP_500'],
    [502, 'unreachable', 'HTTP_502'], [503, 'unreachable', 'HTTP_503'],
    [504, 'unreachable', 'HTTP_504'], ['429', 'rate_limited', 'RATE_LIMITED'],
  ];
  for (const [status, outcome, code] of cases) await t.test(String(status), async () => {
    const result = await checkOperations(profile({ list: read() }), { execute: () => { throw error(undefined, status); } });
    assert.deepEqual(result.checks, [{ operation: 'list', outcome, code }]);
    assert.equal(result.verdict, outcome);
  });
});

test('existing v1 and registry error codes are classified without parsing messages', async t => {
  const cases = [
    ['APPLICATION_SCHEMA_MISMATCH', 'site_changed'], ['APPLICATION_RESULT_MISMATCH', 'site_changed'],
    ['RESPONSE_JSON_INVALID', 'site_changed'], ['RESPONSE_CHECK_INVALID', 'site_changed'],
    ['MIME_UNEXPECTED', 'site_changed'], ['OPERATION_OUTPUT_MISMATCH', 'site_changed'],
    ['GRAPHQL_ERRORS', 'site_changed'], ['HTTP_UNEXPECTED', 'site_changed'],
    ['HTTP_404', 'site_changed'], ['SCHEMA_VALIDATION_FAILED', 'site_changed'],
    ['RATE_LIMITED', 'rate_limited'], ['FIXTURE_RATE_LIMITED', 'rate_limited'],
    ['HTTP_429', 'rate_limited'], ['AUTH_REQUIRED', 'unreachable'],
    ['ACCESS_DENIED', 'unreachable'], ['PROVIDER_MISSING', 'unreachable'],
    ['ECONNREFUSED', 'unreachable'], ['ENOTFOUND', 'unreachable'],
    ['ETIMEDOUT', 'unreachable'], ['HTTP_503', 'unreachable'],
    ['UNKNOWN_FAILURE', 'unreachable'], ['OPERATION_INPUT_REQUIRED', 'skipped'],
    ['OPERATION_INPUT_INVALID', 'skipped'], ['PARAMETERS_INVALID', 'skipped'],
    ['PATH_PARAMETER_INVALID', 'skipped'], ['QUERY_FIELDS_INVALID', 'skipped'],
    ['BODY_FIELDS_INVALID', 'skipped'], ['OPERATION_ADAPTER_REQUIRED', 'skipped'],
    ['OPERATION_SCHEMA_INVALID', 'skipped'], ['EXTRACT_CONFIG_INVALID', 'skipped'],
    ['EXTRACT_SELECTOR_INVALID', 'skipped'], ['GET_BODY_FORBIDDEN', 'skipped'],
  ];
  for (const [code, outcome] of cases) await t.test(code, async () => {
    const result = await checkOperations(profile({ list: read() }), { execute: () => { throw error(code); } });
    assert.deepEqual(result.checks, [{ operation: 'list', outcome, code }]);
    assert.equal(result.verdict, outcome === 'skipped' ? 'no_checks' : outcome);
  });
  const messageOnly = await checkOperations(profile({ list: read() }), {
    execute: () => { throw new Error('RATE_LIMITED HTTP 429 SCHEMA_MISMATCH'); },
  });
  assert.deepEqual(messageOnly.checks, [{ operation: 'list', outcome: 'unreachable', code: 'EXECUTION_FAILED' }]);
  const invalidJson = await checkOperations(profile({ list: read() }), { execute: () => JSON.parse('{') });
  assert.equal(invalidJson.verdict, 'site_changed');
  const network = await checkOperations(profile({ list: read() }), {
    execute: () => { throw new TypeError('fetch failed', { cause: error('ECONNRESET') }); },
  });
  assert.deepEqual(network.checks, [{ operation: 'list', outcome: 'unreachable', code: 'ECONNRESET' }]);
});

test('known status takes precedence over a generic HTTP error and preserves the original code', async () => {
  const result = await checkOperations(profile({ list: read() }), {
    execute: () => { throw error('HTTP_UNEXPECTED', 503); },
  });
  assert.equal(result.verdict, 'unreachable');
  assert.equal(result.checks[0].code, 'HTTP_UNEXPECTED');
});

test('partial failures stay honest, continue independent reads, and never retry', async () => {
  const p = profile(Object.fromEntries(['first', 'changed', 'limited', 'offline', 'last'].map(id => [id, read()])));
  const calls = [];
  const result = await checkOperations(p, { execute: id => {
    calls.push(id);
    if (id === 'changed') throw error('OPERATION_OUTPUT_MISMATCH');
    if (id === 'limited') throw error('RATE_LIMITED');
    if (id === 'offline') throw error('ECONNRESET');
    return success([]);
  } });
  assert.deepEqual(calls, ['first', 'changed', 'limited', 'offline', 'last']);
  assert.equal(result.verdict, 'partial');
  assert.deepEqual(result.checks.map(item => item.outcome), ['ok', 'site_changed', 'rate_limited', 'unreachable', 'ok']);
  assert.deepEqual(result.next, ['review_operation_contract', 'retry_later', 'check_availability']);
});

test('mixed failures are partial even without successes; homogeneous failures retain their verdict', async () => {
  const p = profile({ a: read(), b: read() });
  const mixed = await checkOperations(p, { execute: id => { throw error(id === 'a' ? 'RATE_LIMITED' : 'ENOTFOUND'); } });
  assert.equal(mixed.verdict, 'partial');
  const same = await checkOperations(p, { checks: [check('a'), check('b'), check('missing')],
    execute: () => { throw error('APPLICATION_SCHEMA_MISMATCH'); } });
  assert.equal(same.verdict, 'site_changed');
  assert.deepEqual(same.next, ['review_operation_contract', 'review_checks']);
});

test('the registry envelope is accepted without exposing data or mutating candidate evidence', async () => {
  const p = freeze(profile({ list: read({ state: 'candidate', evidence: 'fixture only' }) }));
  const snapshot = JSON.stringify(p);
  const execute = () => ({ data: { status: 503, errors: ['literal application data'] },
    pageInfo: { nextCursor: 'fixture-cursor' }, receipt: { state: 'candidate', privateDetail: 'fixture-detail' } });
  const a = await checkOperations(p, { execute });
  const b = await checkOperations(p, { execute });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { serviceId: 'fixture', verdict: 'ok', checks: [{ operation: 'list', outcome: 'ok' }], next: [] });
  assert.equal(JSON.stringify(p), snapshot);
  assert.equal(p.operations.list.state, 'candidate');
});

test('nested JSON Pointer references use only preceding .data and preserve path/query/body types', async () => {
  const p = profile({ list: read(), detail: read(), full: read() });
  const data = freeze({ items: [{ id: 42 }], 'a/b': { '~key': 'escaped' }, values: [0, false, '', null],
    payload: { body: { filter: true } } });
  const inputs = [];
  const result = await checkOperations(p, { checks: [check('list'), check('detail', {
    path: { id: ref('list', '/items/0/id') },
    query: { escaped: ref('list', '/a~1b/~0key'), values: [0, 1, 2, 3].map(index => ref('list', `/values/${index}`)) },
    body: { whole: ref('list', ''), nested: [{ id: ref('list', '/items/0/id') }] },
  }), check('full', ref('list', '/payload'))], execute: (id, input) => {
    inputs.push([id, input]); return success(id === 'list' ? data : {});
  } });
  assert.equal(result.verdict, 'ok');
  assert.deepEqual(inputs, [
    ['list', {}], ['detail', {
      path: { id: 42 }, query: { escaped: 'escaped', values: [0, false, '', null] },
      body: { whole: data, nested: [{ id: 42 }] },
    }], ['full', { body: { filter: true } }],
  ]);
});

test('JSON Pointer supports empty property names and decodes escape sequences exactly once', async () => {
  const result = await checkOperations(profile({ list: read(), detail: read() }), {
    checks: [check('list'), check('detail', { query: { empty: ref('list', '/'), tildeOne: ref('list', '/~01'),
      numericKey: ref('list', '/00'), nestedEmpty: ref('list', '/nested//') } })],
    execute: (id, input) => {
      if (id === 'list') return success({ '': 0, '~1': 'tilde-one', '00': 'object key', nested: { '': { '': false } } });
      assert.deepEqual(input, { query: { empty: 0, tildeOne: 'tilde-one', numericKey: 'object key', nestedEmpty: false } });
      return success(null);
    },
  });
  assert.equal(result.verdict, 'ok');
});

test('only exact $result objects are templates and fetched data is never interpreted as a template', async () => {
  const literal = { $result: { operation: 'missing', pointer: '' } };
  const withSibling = { $result: { operation: 'missing', pointer: '' }, literal: true };
  const calls = [];
  const result = await checkOperations(profile({ list: read(), detail: read() }), {
    checks: [check('list'), check('detail', { body: { literal: withSibling, fetched: ref('list', '/template') } })],
    execute: (id, input) => { calls.push(input); return success({ template: literal }); },
  });
  assert.equal(result.verdict, 'ok');
  assert.deepEqual(calls[1], { body: { literal: withSibling, fetched: literal } });
});

test('unresolved, invalid, inherited, and forward references skip without dispatch', async () => {
  const invalid = [
    ref('missing', ''), ref('list', '/items/2/id'), ref('list', '/missing'),
    ref('list', '/items/00/id'), ref('list', '/items/-'), ref('list', '/items/length'),
    ref('list', '/toString'), ref('list', '/items/0/id/x'), ref('list', '#/items/0/id'),
    ref('list', '/bad~2key'), ref('list', '/bad~'), ref('list', 0),
    { $result: { operation: 'list' } }, { $result: { pointer: '' } },
    { $result: { operation: 'list', pointer: '', extra: true } },
    { $result: null }, ref('list', '/data/items/0/id'), ref('list', '/pageInfo'),
  ];
  const calls = [];
  const result = await checkOperations(profile({ list: read(), detail: read() }), {
    checks: [check('detail', { path: { id: ref('list', '/items/0/id') } }), check('list'),
      ...invalid.map(id => check('detail', { path: { id } }))],
    execute: id => { calls.push(id); return success({ items: [{ id: 1 }] }); },
  });
  assert.deepEqual(calls, ['list']);
  assert.equal(result.verdict, 'partial');
  assert.equal(result.checks.filter(item => item.outcome === 'skipped').length, invalid.length + 1);
  assert.ok(result.checks.filter(item => item.outcome === 'skipped').every(item => item.code === 'RESULT_REFERENCE_UNRESOLVED'));
});

test('failed sources skip dependent checks while independent reads still run', async () => {
  const calls = [];
  const result = await checkOperations(profile({ list: read(), detail: read(), independent: read() }), {
    checks: [check('list'), check('detail', { path: { id: ref('list', '/items/0/id') } }), check('independent')],
    execute: id => { calls.push(id); if (id === 'list') throw error('RATE_LIMITED'); return success([]); },
  });
  assert.deepEqual(calls, ['list', 'independent']);
  assert.equal(result.verdict, 'partial');
  assert.deepEqual(result.checks[1], { operation: 'detail', outcome: 'skipped', code: 'RESULT_REFERENCE_UNRESOLVED' });
});

test('a skipped write cannot supply a dependent result', async () => {
  const result = await checkOperations(profile({ write: { semantics: 'write' }, detail: read() }), {
    checks: [check('write'), check('detail', { query: { id: ref('write', '/id') } })],
    execute: () => assert.fail('neither write nor unresolved dependent may execute'),
  });
  assert.equal(result.verdict, 'no_checks');
  assert.deepEqual(result.checks.map(item => item.code), ['WRITE_OPERATION_SKIPPED', 'RESULT_REFERENCE_UNRESOLVED']);
});

test('a repeated failed check invalidates its previous successful result', async () => {
  let calls = 0;
  const result = await checkOperations(profile({ list: read(), detail: read() }), {
    checks: [check('list'), check('list'), check('detail', { path: { id: ref('list', '/id') } })],
    execute: id => { assert.equal(id, 'list'); if (++calls === 2) throw error('ECONNRESET'); return success({ id: 1 }); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.checks.map(item => item.outcome), ['ok', 'unreachable', 'skipped']);
});

test('repeated operations can consume their immediately preceding result', async () => {
  const calls = [];
  const result = await checkOperations(profile({ list: read() }), {
    checks: [check('list'), check('list', { query: { cursor: ref('list', '/cursor') } })],
    execute: (id, input) => { calls.push(input); return success({ cursor: 'next' }); },
  });
  assert.deepEqual(calls, [{}, { query: { cursor: 'next' } }]);
  assert.equal(result.verdict, 'ok');
});

test('executors may mutate copied input without mutating checks or previous results', async () => {
  const data = freeze({ payload: { value: 1 } });
  const checks = freeze([check('list'), check('detail', { body: ref('list', '/payload') }),
    check('detail', { body: ref('list', '/payload') }), check('literal', { body: { value: 2 } })]);
  const received = [];
  await checkOperations(profile({ list: read(), detail: read(), literal: read() }), { checks, execute: (id, input) => {
    if (id === 'list') return success(data);
    received.push(input.body.value);
    input.body.value = 99;
    return success({});
  } });
  assert.deepEqual(received, [1, 1, 2]);
  assert.equal(checks[3].input.body.value, 2);
  assert.equal(data.payload.value, 1);
});

test('pre-aborted runs skip every check without invoking the executor', async () => {
  const signal = AbortSignal.abort('fixture reason');
  const result = await checkOperations(profile({ list: read(), detail: read() }), {
    signal, execute: () => assert.fail('aborted run must not dispatch'),
  });
  assert.equal(result.verdict, 'no_checks');
  assert.deepEqual(result.next, ['rerun_checks']);
  assert.deepEqual(result.checks, ['list', 'detail'].map(operation => ({ operation, outcome: 'skipped', code: 'ABORTED' })));
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('in-flight abort finishes even when the executor ignores signal and prevents later dispatch', async () => {
  const controller = new AbortController();
  const pending = Promise.withResolvers();
  const calls = [];
  const result = await checkOperations(profile({ first: read(), pending: read(), last: read() }), {
    signal: controller.signal, execute: (id, input, { signal }) => {
      assert.equal(signal, controller.signal);
      calls.push(id);
      if (id === 'first') return success({});
      controller.abort();
      return pending.promise;
    },
  });
  // The abandoned promise still has a rejection handler, so this must not
  // become an unhandled rejection after the health runner has finished.
  pending.reject(error('LATE_EXECUTOR_FAILURE'));
  await Promise.resolve();
  assert.deepEqual(calls, ['first', 'pending']);
  assert.equal(result.verdict, 'partial');
  assert.deepEqual(result.checks.map(item => [item.outcome, item.code]), [['ok', undefined], ['skipped', 'ABORTED'], ['skipped', 'ABORTED']]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a success that arrives after abort is never reported as ok', async () => {
  const controller = new AbortController();
  const result = await checkOperations(profile({ list: read() }), {
    signal: controller.signal, execute: () => { controller.abort(); return success({}); },
  });
  assert.equal(result.verdict, 'no_checks');
  assert.equal(result.checks[0].code, 'ABORTED');
});

test('executor abort codes and AbortError stop subsequent dispatch with no required signal', async t => {
  for (const cause of [error('OPERATION_ABORTED'), error('ABORT_ERR'), new DOMException('fixture', 'AbortError')]) {
    await t.test(String(cause.code), async () => {
      let calls = 0;
      const result = await checkOperations(profile({ first: read(), last: read() }), {
        execute: () => { calls++; throw cause; },
      });
      assert.equal(calls, 1);
      assert.deepEqual(result.checks.map(item => item.code), ['ABORTED', 'ABORTED']);
    });
  }
});

test('abort listeners are cleaned up after synchronous throws, rejections, and successful checks', async t => {
  for (const [name, execute] of [
    ['throw', () => { throw error('ECONNRESET'); }],
    ['reject', () => Promise.reject(error('ECONNRESET'))],
    ['success', () => success({})],
  ]) await t.test(name, async () => {
    const controller = new AbortController();
    await checkOperations(profile({ list: read() }), { execute, signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

test('invalid executor results are not successful health evidence', async () => {
  for (const value of [undefined, null, {}, { pageInfo: {} }]) {
    const result = await checkOperations(profile({ list: read() }), { execute: () => value });
    assert.equal(result.verdict, 'unreachable');
    assert.equal(result.checks[0].code, 'OPERATION_ADAPTER_RESULT_INVALID');
  }
});

test('cyclic check input is skipped locally without execution', async () => {
  const input = {}; input.body = input;
  const result = await checkOperations(profile({ list: read() }), {
    checks: [check('list', input)], execute: () => assert.fail('cyclic input should not execute'),
  });
  assert.equal(result.verdict, 'no_checks');
  assert.equal(result.checks[0].code, 'CHECK_INPUT_INVALID');
});

test('root references resolving to non-object inputs are skipped locally', async () => {
  for (const data of [null, 42, 'fixture', false, []]) {
    let calls = 0;
    const result = await checkOperations(profile({ list: read(), detail: read() }), {
      checks: [check('list'), check('detail', ref('list', ''))],
      execute: id => { calls++; assert.equal(id, 'list'); return success(data); },
    });
    assert.equal(calls, 1);
    assert.equal(result.verdict, 'partial');
    assert.deepEqual(result.checks[1], { operation: 'detail', outcome: 'skipped', code: 'CHECK_INPUT_INVALID' });
  }
});

test('invalid configuration fails before dispatch instead of inventing health evidence', async () => {
  const p = profile({ list: read() });
  const execute = () => assert.fail('invalid configuration must not dispatch');
  for (const value of [undefined, null, {}, profile([])]) {
    await assert.rejects(checkOperations(value, { execute }), { code: 'OPERATION_HEALTH_PROFILE_INVALID' });
  }
  await assert.rejects(checkOperations(p), { code: 'OPERATION_HEALTH_EXECUTOR_REQUIRED' });
  await assert.rejects(checkOperations(p, { execute, signal: {} }), { code: 'OPERATION_HEALTH_SIGNAL_INVALID' });
  for (const checks of [null, {}, [null], [check('')], [check('list', [])], [check('list'), { operation: 1 }]]) {
    await assert.rejects(checkOperations(p, { execute, checks }), { code: 'OPERATION_HEALTH_CHECKS_INVALID' });
  }
});
