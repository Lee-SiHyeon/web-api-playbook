import test from 'node:test';
import assert from 'node:assert/strict';
import { runOperationFlow, collectOperationPages } from '../lib/operation-flow.mjs';

// All executors are in-memory fixtures. No fetch, sessions, services or writes.
const saved = value => JSON.parse(JSON.stringify(value));
const ref = (step, pointer = '') => ({ $result: { step, pointer } });
const cursor = { kind: 'cursor', inputPath: '/query/cursor', itemsPointer: '/items', nextPointer: '/next', idPointer: '/id' };
const page = { kind: 'page', inputPath: '/query/page', itemsPointer: '/items', idPointer: '/id' };
const offset = { kind: 'offset', inputPath: '/body/variables/offset', itemsPointer: '/items', pageSize: 2, idPointer: '/id' };
const query = (pagination = cursor, rest = {}) => ({ operation: 'list', pagination, ...rest });
const fail = code => Object.assign(new Error(code), { code });

function fixture(responses) {
  const calls = [];
  const execute = async (operation, input, { signal }) => {
    calls.push({ operation, input: saved(input), signal });
    assert.equal(signal?.aborted ?? false, false);
    const response = responses[calls.length - 1];
    assert.notEqual(response, undefined, 'unexpected extra executor call');
    if (response instanceof Error) throw response;
    return saved(response);
  };
  return { execute, calls };
}

test('flow binds nested data from the registry envelope, preserving typed input and receipts', async () => {
  const definition = { steps: [
    { id: 'search', operation: 'search', input: { query: { term: 'fixture' } } },
    { id: 'detail', operation: 'detail', input: { path: { id: ref('search', '/items/0/id') },
      body: { selected: [ref('search', '/items/0'), ref('search', '/enabled'), ref('search', '/nothing')],
        literal: 'search.items[0].id', almostRef: { $result: { step: 'search', pointer: '/absent' }, literal: true } } } },
  ] };
  const original = saved(definition);
  const receipt = { operation: 'search', executionMode: 'existing_adapter' };
  const { execute, calls } = fixture([
    { data: { items: [{ id: 42 }], enabled: false, nothing: null }, pageInfo: { candidate: true }, receipt },
    { data: { id: 42, found: true }, receipt: { executionMode: 'pure_http' } },
  ]);
  const controller = new AbortController();
  const result = await runOperationFlow(definition, { execute, signal: controller.signal });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.terminal, true);
  assert.equal(result.reason, 'completed');
  assert.deepEqual(result.results.detail, { id: 42, found: true });
  assert.deepEqual(result.metadata.search, { pageInfo: { candidate: true }, receipt });
  assert.deepEqual(calls[1].input, { path: { id: 42 }, body: { selected: [{ id: 42 }, false, null],
    literal: 'search.items[0].id', almostRef: { $result: { step: 'search', pointer: '/absent' }, literal: true } } });
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(result.counters, { requests: 2, completed: 2, skipped: 0 });
  assert.deepEqual(definition, original);
  assert.deepEqual(saved(result.checkpoint), result.checkpoint);
  assert.equal(Object.hasOwn(result, 'healthy'), false);
});

test('flow accepts raw data, root pointers and escaped RFC6901 property names', async () => {
  const { execute, calls } = fixture([{ 'a/b': { '~key': ['id'] }, zero: 0, empty: '' }, null]);
  const result = await runOperationFlow({ steps: [
    { id: 'first', operation: 'one' },
    { id: 'second', operation: 'two', input: { body: { escaped: ref('first', '/a~1b/~0key/0'),
      all: ref('first'), zero: ref('first', '/zero'), empty: ref('first', '/empty') } } },
  ] }, { execute });
  assert.equal(result.ok, true);
  assert.equal(calls[1].input.body.escaped, 'id');
  assert.equal(calls[1].input.body.zero, 0);
  assert.equal(calls[1].input.body.empty, '');
  assert.deepEqual(calls[1].input.body.all, { 'a/b': { '~key': ['id'] }, zero: 0, empty: '' });
  assert.equal(result.results.second, null);
});

test('bound data is copied literally, never reinterpreted as another result binding', async () => {
  const literal = ref('nonexistent', '/do-not-evaluate');
  const local = fixture([{ value: literal }, { accepted: true }]);
  const result = await runOperationFlow({ steps: [{ id: 'first', operation: 'first' },
    { id: 'second', operation: 'second', input: { body: { literal: ref('first', '/value') } } }] }, local);
  assert.equal(result.ok, true);
  assert.deepEqual(local.calls[1].input.body.literal, literal);
});

test('a root reference must resolve to an object input, rather than dispatching an invalid input', async () => {
  const local = fixture([42]);
  const result = await runOperationFlow({ steps: [{ id: 'first', operation: 'first' },
    { id: 'second', operation: 'second', input: ref('first') }] }, local);
  assert.equal(result.error.code, 'FLOW_INPUT_INVALID');
  assert.equal(local.calls.length, 1);
});

test('an own data property always denotes an envelope; double-wrap a payload with data', async () => {
  const { execute } = fixture([{ data: { data: 'payload', items: [] }, pageInfo: {} }]);
  const result = await runOperationFlow({ steps: [{ id: 'one', operation: 'one' }] }, { execute });
  assert.deepEqual(result.results.one, { data: 'payload', items: [] });
});

test('missing flow bindings fail explicitly, stop following operations and remain terminal on resume', async () => {
  const definition = { steps: [
    { id: 'search', operation: 'search' },
    { id: 'detail', operation: 'detail', input: { path: { id: ref('search', '/items/0/id') } } },
    { id: 'never', operation: 'never' },
  ] };
  const { execute, calls } = fixture([{ items: [] }]);
  const result = await runOperationFlow(definition, { execute });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.terminal, true);
  assert.equal(result.reason, 'missing_result');
  assert.deepEqual(result.error, { code: 'RESULT_REFERENCE_MISSING', step: 'search', pointer: '/items/0/id' });
  assert.equal(calls.length, 1);
  const resumed = await runOperationFlow(definition, { execute, checkpoint: saved(result.checkpoint) });
  assert.deepEqual(resumed, result);
  assert.equal(calls.length, 1);
});

test('explicit skip propagates missing results without inventing successful results', async () => {
  const { execute, calls } = fixture([{ items: [] }, { finished: true }]);
  const result = await runOperationFlow({ steps: [
    { id: 'search', operation: 'search' },
    { id: 'skip', operation: 'detail', input: { path: { id: ref('search', '/items/0/id') } }, onMissing: 'skip' },
    { id: 'dependent', operation: 'dependent', input: { body: { value: ref('skip') } }, onMissing: 'skip' },
    { id: 'done', operation: 'done' },
  ] }, { execute });
  assert.equal(result.complete, true);
  assert.equal(result.partial, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'completed_with_skips');
  assert.equal(Object.hasOwn(result.results, 'skip'), false);
  assert.deepEqual(result.steps.map(step => step.status), ['completed', 'skipped', 'skipped', 'completed']);
  assert.deepEqual(result.counters, { requests: 2, completed: 2, skipped: 2 });
  assert.equal(calls.length, 2);
});

test('bindings reject malformed exact references and never evaluate strings or inherited paths', async t => {
  for (const [name, reference, expected] of [
    ['missing step', ref('unknown'), 'RESULT_REFERENCE_MISSING'],
    ['inherited path', ref('first', '/constructor'), 'RESULT_REFERENCE_MISSING'],
    ['array non-index', ref('first', '/items/length'), 'RESULT_REFERENCE_MISSING'],
    ['leading zero index', ref('first', '/items/00'), 'RESULT_REFERENCE_MISSING'],
    ['invalid escape', ref('first', '/a~2b'), 'JSON_POINTER_INVALID'],
    ['invalid shape', { $result: { step: 'first', pointer: '', fallback: 1 } }, 'RESULT_REFERENCE_INVALID'],
  ]) await t.test(name, async () => {
    const { execute, calls } = fixture([{ items: [1] }]);
    const result = await runOperationFlow({ steps: [
      { id: 'first', operation: 'one' }, { id: 'next', operation: 'two', input: { body: { value: reference } } },
    ] }, { execute });
    assert.equal(result.error.code, expected);
    assert.equal(calls.length, 1);
  });
});

test('flow snapshots resume only unfinished steps after an executor error; terminal resume is inert', async () => {
  const definition = { steps: [{ id: 'first', operation: 'one' },
    { id: 'second', operation: 'two', input: { path: { id: ref('first', '/id') } } }] };
  const first = fixture([{ data: { id: '001' }, receipt: { executionMode: 'existing_adapter' } }, fail('TRANSPORT')]);
  const result = await runOperationFlow(definition, first);
  assert.equal(result.reason, 'error');
  assert.equal(result.terminal, false);
  assert.deepEqual(result.results, { first: { id: '001' } });
  const second = fixture([{ data: { recovered: true }, receipt: { executionMode: 'existing_adapter' } }]);
  const resumed = await runOperationFlow(definition, { execute: second.execute, checkpoint: saved(result.checkpoint) });
  assert.deepEqual(second.calls.map(call => [call.operation, call.input]), [['two', { path: { id: '001' } }]]);
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.counters, { requests: 3, completed: 2, skipped: 0 });
  assert.equal(Object.hasOwn(resumed, 'error'), false);
  const terminal = await runOperationFlow(definition, { execute: second.execute, checkpoint: saved(resumed.checkpoint) });
  assert.deepEqual(terminal, resumed);
  assert.equal(second.calls.length, 1);
});

test('flow checkpoints are isolated from callback and executor mutation', async () => {
  const checkpoints = [];
  const definition = { steps: [{ id: 'a', operation: 'one', input: { body: { original: true } } },
    { id: 'b', operation: 'two', input: { body: { copy: ref('a', '/value') } } }] };
  const result = await runOperationFlow(definition, {
    execute: async (_operation, input) => { input.body.changed = true; return { value: { original: true } }; },
    onCheckpoint: snapshot => { checkpoints.push(saved(snapshot)); snapshot.results.a = null; snapshot.nextStep = 999; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.a, { value: { original: true } });
  assert.equal(definition.steps[0].input.body.changed, undefined);
  const restarted = fixture([{ value: 'second' }]);
  const resumed = await runOperationFlow(definition, { execute: restarted.execute, checkpoint: checkpoints[0] });
  assert.equal(resumed.ok, true);
  assert.equal(restarted.calls[0].operation, 'two');
});

test('flow recovers the acknowledged checkpoint when persistence fails', async () => {
  const definition = { steps: [{ id: 'a', operation: 'one' }, { id: 'b', operation: 'two' }] };
  const first = fixture([{ id: 1 }]);
  let checkpoint;
  await assert.rejects(runOperationFlow(definition, { execute: first.execute, onCheckpoint: () => { throw new Error('fixture disk full'); } }), error => {
    assert.equal(error.code, 'CHECKPOINT_FAILED'); checkpoint = saved(error.checkpoint); return true;
  });
  assert.equal(checkpoint.nextStep, 1);
  const second = fixture([{ id: 2 }]);
  const resumed = await runOperationFlow(definition, { execute: second.execute, checkpoint });
  assert.equal(resumed.ok, true);
  assert.equal(second.calls[0].operation, 'two');
});

test('cursor pages retain registry metadata, dedupe exact typed IDs, preserve nested inputs, and stop naturally', async () => {
  const input = { path: { owner: '001' }, query: { filter: { enabled: true } }, body: { selected: [1] } };
  const original = saved(input);
  const { execute, calls } = fixture([
    { data: { items: [{ id: '001', v: 1 }, { id: 1 }, { id: '1' }, { id: 0 }, { id: false }], next: 'a' },
      pageInfo: { candidate: true }, receipt: { operation: 'list', executionMode: 'existing_adapter' } },
    { data: { items: [{ id: '001', v: 2 }, { id: 1 }, { id: '01' }, { noId: true }, { noId: true }, { id: null }], next: null },
      pageInfo: { candidate: false }, receipt: { operation: 'list', executionMode: 'existing_adapter' } },
  ]);
  const result = await collectOperationPages(query(cursor, { input }), { execute });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'missing_continuation');
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.terminal, true);
  assert.deepEqual(result.records, [{ id: '001', v: 1 }, { id: 1 }, { id: '1' }, { id: 0 }, { id: false },
    { id: '01' }, { noId: true }, { noId: true }, { id: null }]);
  assert.deepEqual(result.counters, { requests: 2, pages: 2, items: 9, duplicates: 2 });
  assert.deepEqual(result.pageInfo, { candidate: false });
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[0].executionMode, 'existing_adapter');
  assert.deepEqual(calls[0].input, original);
  assert.deepEqual(calls[1].input, { ...original, query: { ...original.query, cursor: 'a' } });
  assert.deepEqual(input, original);
  assert.deepEqual(saved(result), result);
  assert.equal(Object.hasOwn(result, 'healthy'), false);
});

test('numeric page traversal increments only the declared field, ignores short pages and stops on empty', async () => {
  const { execute, calls } = fixture([{ items: [{ id: 1 }] }, { items: [{ id: 2 }] }, { items: [] }]);
  const result = await collectOperationPages(query({ ...page, start: 3, step: 2, pageSize: 20 },
    { input: { query: { term: 'local' } } }), { execute });
  assert.deepEqual(calls.map(call => call.input), [3, 5, 7].map(number => ({ query: { term: 'local', page: number } })));
  assert.equal(result.reason, 'empty_page');
  assert.equal(result.complete, true);
  assert.deepEqual(result.records, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(result.counters, { requests: 3, pages: 3, items: 2, duplicates: 0 });
});

test('existing numeric strings remain strings, including v1-style page query fields', async () => {
  const { execute, calls } = fixture([{ items: [{ id: 1 }] }, { items: [] }]);
  await collectOperationPages(query(page, { input: { query: { page: '10' } } }), { execute });
  assert.deepEqual(calls.map(call => call.input.query.page), ['10', '11']);
});

test('offset traverses nested body input using declared pageSize, preserving GraphQL-style values', async () => {
  const { execute, calls } = fixture([{ items: [{ id: 1 }, { id: 2 }] }, { items: [{ id: 3 }] }, { items: [] }]);
  const input = { body: { query: 'fixture-only', variables: { selected: true } } };
  const result = await collectOperationPages(query(offset, { input }), { execute });
  assert.deepEqual(calls.map(call => call.input.body.variables.offset), [0, 2, 4]);
  assert.equal(calls.every(call => call.input.body.query === 'fixture-only' && call.input.body.variables.selected === true), true);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 3);
});

test('page and offset nextPointer is authoritative, including zero and missing termination', async t => {
  for (const kind of ['page', 'offset']) await t.test(kind, async () => {
    const { execute, calls } = fixture([{ items: [{ id: 1 }], next: 0 }, { items: [{ id: 2 }], next: 8 }, { items: [{ id: 3 }] }]);
    const result = await collectOperationPages(query({ ...page, kind, nextPointer: '/next', start: 5 }), { execute });
    assert.deepEqual(calls.map(call => call.input.query.page), [5, 0, 8]);
    assert.equal(result.reason, 'missing_continuation');
    assert.equal(result.complete, true);
  });
});

test('offset step overrides pageSize and explicit observed input overrides start', async () => {
  const { execute, calls } = fixture([{ items: [{ id: 1 }] }, { items: [] }]);
  await collectOperationPages(query({ ...offset, start: 100, step: 5 }, { input: { body: { variables: { offset: 7 } } } }), { execute });
  assert.deepEqual(calls.map(call => call.input.body.variables.offset), [7, 12]);
});

test('next_url stays an opaque declared input value; no URL resolution or network is performed', async () => {
  const pagination = { kind: 'next_url', inputPath: '/query/continuation', itemsPointer: '/items', nextPointer: '/links/next' };
  const { execute, calls } = fixture([
    { data: { items: [1], links: { next: 'https://fixture.invalid/opaque?page=2' } } },
    { data: { items: [2], links: { next: '../not-resolved' } } },
    { data: { items: [], links: { next: 'unused' } } },
  ]);
  const result = await collectOperationPages(query(pagination), { execute });
  assert.deepEqual(calls.map(call => call.input), [{}, { query: { continuation: 'https://fixture.invalid/opaque?page=2' } },
    { query: { continuation: '../not-resolved' } }]);
  assert.deepEqual(calls.map(call => call.operation), ['list', 'list', 'list']);
  assert.equal(result.complete, true);
});

test('cursor start and zero-valued cursor are passed exactly as declared', async () => {
  const { execute, calls } = fixture([{ items: [1], next: 0 }, { items: [2], next: '' }]);
  const result = await collectOperationPages(query({ ...cursor, start: 'first' }), { execute });
  assert.deepEqual(calls.map(call => call.input.query.cursor), ['first', 0]);
  assert.equal(result.complete, true);
});

test('empty pages stop even if a continuation is present; missing items is an explicit partial error', async () => {
  const empty = fixture([{ items: [], next: 'unused' }]);
  const result = await collectOperationPages(query(), empty);
  assert.equal(result.complete, true);
  assert.equal(result.reason, 'empty_page');
  assert.equal(empty.calls.length, 1);
  const absent = fixture([{ other: [], next: 'unused' }]);
  const partial = await collectOperationPages(query(), absent);
  assert.equal(partial.complete, false);
  assert.equal(partial.partial, true);
  assert.equal(partial.error.code, 'PAGINATION_ITEMS_INVALID');
  assert.equal(partial.counters.pages, 0);
  assert.deepEqual(partial.checkpoint.nextInput, {});
});

test('root array items and scalar IDs use empty JSON pointers', async () => {
  const pagination = { ...page, itemsPointer: '', idPointer: '' };
  const { execute } = fixture([[1, '1', false, 1], []]);
  const result = await collectOperationPages(query(pagination), { execute });
  assert.deepEqual(result.records, [1, '1', false]);
  assert.equal(result.counters.duplicates, 1);
});

test('no idPointer means no guessed dedupe and missing/non-scalar IDs are retained', async () => {
  const first = fixture([{ items: [{ id: 1 }, { id: 1 }], next: null }]);
  const undeduped = await collectOperationPages(query({ ...cursor, idPointer: undefined }), first).catch(error => error);
  assert.equal(undeduped.code, 'PAGINATION_INVALID', 'undefined is not a serializable declaration value');
  const { idPointer: _unused, ...withoutID } = cursor;
  const plain = await collectOperationPages(query(withoutID), fixture([{ items: [{ id: 1 }, { id: 1 }] }]));
  assert.equal(plain.records.length, 2);
  const nonscalar = await collectOperationPages(query(), fixture([{ items: [{ id: {} }, { id: {} }, { id: null }, { id: null }] }]));
  assert.equal(nonscalar.records.length, 4);
});

test('repeated cursor stops before a third request and reports terminal partial data', async () => {
  const { execute, calls } = fixture([{ items: [{ id: 1 }], next: 'a' }, { items: [{ id: 2 }], next: 'a' }]);
  const result = await collectOperationPages(query(), { execute });
  assert.equal(result.reason, 'repeated_cursor');
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.equal(result.terminal, true);
  assert.deepEqual(result.records, [{ id: 1 }, { id: 2 }]);
  assert.equal(calls.length, 2);
  const resumed = await collectOperationPages(query(), { execute, checkpoint: saved(result.checkpoint) });
  assert.deepEqual(resumed, result);
  assert.equal(calls.length, 2);
});

test('cursor cycles of more than one page stop before refetching a successful input', async () => {
  const { execute, calls } = fixture([{ items: [1], next: 'a' }, { items: [2], next: 'b' }, { items: [3], next: 'a' }]);
  const result = await collectOperationPages(query(), { execute });
  assert.equal(result.reason, 'repeated_cursor');
  assert.deepEqual(result.records, [1, 2, 3]);
  assert.equal(calls.length, 3);
});

test('repeated page contents stop page and offset traversal, including changing non-ID fields', async t => {
  for (const pagination of [page, offset]) await t.test(pagination.kind, async () => {
    const { execute, calls } = fixture([{ items: [{ id: 1, timestamp: 1 }] }, { items: [{ id: 1, timestamp: 2 }] }]);
    const result = await collectOperationPages(query(pagination), { execute });
    assert.equal(result.reason, 'repeated_page');
    assert.equal(result.terminal, true);
    assert.equal(result.complete, false);
    assert.deepEqual(result.records, [{ id: 1, timestamp: 1 }]);
    assert.equal(result.counters.pages, 2);
    assert.equal(calls.length, 2);
  });
});

test('repeated raw records compare canonically rather than object insertion order', async () => {
  const { idPointer: _unused, ...withoutID } = page;
  const { execute, calls } = fixture([{ items: [{ a: 1, b: 2 }] }, { items: [{ b: 2, a: 1 }] }]);
  const result = await collectOperationPages(query(withoutID), { execute });
  assert.equal(result.reason, 'repeated_page');
  assert.equal(calls.length, 2);
  assert.equal(result.records.length, 1);
});

test('page request budget resumes from the actual next input with cumulative history and exact dedupe', async () => {
  const options = query(cursor, { budget: { maxPages: 1 } });
  const first = fixture([{ items: [{ id: 1 }, { id: 2 }], next: 'a' }]);
  const result = await collectOperationPages(options, first);
  assert.equal(result.reason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.terminal, false);
  assert.deepEqual(result.checkpoint.nextInput, { query: { cursor: 'a' } });
  const checkpoint = saved(result.checkpoint);
  const second = fixture([{ items: [{ id: 2 }, { id: 3 }], next: 'b' }]);
  const resumed = await collectOperationPages(options, { execute: second.execute, checkpoint });
  assert.deepEqual(second.calls[0].input, { query: { cursor: 'a' } });
  assert.deepEqual(resumed.records, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(resumed.counters, { requests: 2, pages: 2, items: 3, duplicates: 1 });
  assert.deepEqual(checkpoint, result.checkpoint, 'resume never mutates the caller checkpoint');
  const third = fixture([{ items: [], next: null }]);
  const done = await collectOperationPages(options, { execute: third.execute, checkpoint: saved(resumed.checkpoint) });
  assert.deepEqual(third.calls[0].input, { query: { cursor: 'b' } });
  assert.equal(done.complete, true);
  assert.equal(done.counters.pages, 3);
});

test('page and offset checkpoints resume the next numeric request without refetching prior pages', async t => {
  for (const [pagination, pointer, values] of [[page, input => input.query.page, [1, 2]], [offset, input => input.body.variables.offset, [0, 2]]]) {
    await t.test(pagination.kind, async () => {
      const options = query(pagination, { budget: { maxPages: 1 } });
      const first = fixture([{ items: [{ id: 'first' }] }]);
      const partial = await collectOperationPages(options, first);
      const second = fixture([{ items: [] }]);
      const result = await collectOperationPages(options, { execute: second.execute, checkpoint: saved(partial.checkpoint) });
      assert.deepEqual([pointer(first.calls[0].input), pointer(second.calls[0].input)], values);
      assert.equal(result.complete, true);
      assert.deepEqual(result.records, [{ id: 'first' }]);
    });
  }
});

test('item budget buffers a whole accepted page and resumes without record loss or refetch', async () => {
  const options = query(cursor, { budget: { maxItems: 2 } });
  const first = fixture([{ items: [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], next: 'next' }]);
  const result = await collectOperationPages(options, first);
  assert.equal(result.reason, 'max_items');
  assert.deepEqual(result.records, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(result.checkpoint.pending, [{ id: 3 }, { id: 4 }, { id: 5 }]);
  assert.equal(result.counters.duplicates, 2);
  assert.deepEqual(result.checkpoint.nextInput, { query: { cursor: 'next' } });
  const noCalls = fixture([]);
  const more = await collectOperationPages(options, { execute: noCalls.execute, checkpoint: saved(result.checkpoint) });
  assert.equal(noCalls.calls.length, 0);
  assert.deepEqual(more.records, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.deepEqual(more.checkpoint.pending, [{ id: 5 }]);
  const last = fixture([{ items: [{ id: 5 }, { id: 6 }], next: null }]);
  const done = await collectOperationPages(options, { execute: last.execute, checkpoint: saved(more.checkpoint) });
  assert.equal(done.complete, true);
  assert.equal(done.reason, 'missing_continuation');
  assert.deepEqual(done.records.map(item => item.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(done.counters, { requests: 2, pages: 2, items: 6, duplicates: 3 });
  assert.deepEqual(last.calls[0].input, { query: { cursor: 'next' } });
});

test('final-page item budget defers completion until buffered records are consumed, without another request', async () => {
  const options = query(cursor, { budget: { maxItems: 1 } });
  const first = fixture([{ items: [1, 2, 3], next: null }]);
  const result = await collectOperationPages(options, first);
  assert.equal(result.complete, false);
  assert.equal(result.terminal, false);
  assert.equal(result.checkpoint.nextInput, null);
  assert.deepEqual(result.checkpoint.end, { reason: 'missing_continuation', complete: true });
  const rest = fixture([]);
  const more = await collectOperationPages(options, { execute: rest.execute, checkpoint: saved(result.checkpoint) });
  const done = await collectOperationPages(options, { execute: rest.execute, checkpoint: saved(more.checkpoint) });
  assert.equal(rest.calls.length, 0);
  assert.equal(done.complete, true);
  assert.deepEqual(done.records, [1, 2, 3]);
  assert.equal(done.counters.pages, 1);
});

test('natural completion wins over an exactly exhausted page/item budget', async () => {
  const result = await collectOperationPages(query(cursor, { budget: { maxPages: 1, maxItems: 1 } }), fixture([{ items: [1] }]));
  assert.equal(result.complete, true);
  assert.equal(result.reason, 'missing_continuation');
});

test('defaults provide an actual finite request bound even without explicit budgets', async () => {
  let count = 0;
  const result = await collectOperationPages(query(page), { execute: async () => ({ items: [{ id: ++count }] }) });
  assert.equal(count, 100);
  assert.equal(result.reason, 'max_pages');
  assert.equal(result.complete, false);
});

test('zero budgets prevent executor calls and remain resumable', async t => {
  for (const [budget, expected] of [[{ maxPages: 0 }, 'max_pages'], [{ maxItems: 0 }, 'max_items'], [{ deadlineMs: 0 }, 'deadline']]) {
    await t.test(expected, async () => {
      const local = fixture([]);
      const result = await collectOperationPages(query(page, { budget }), local);
      assert.equal(result.reason, expected);
      assert.equal(result.terminal, false);
      assert.equal(result.counters.requests, 0);
      assert.equal(local.calls.length, 0);
      const done = await collectOperationPages(query(page), { execute: fixture([{ items: [] }]).execute, checkpoint: saved(result.checkpoint) });
      assert.equal(done.complete, true);
    });
  }
});

test('shared returned and thrown 403/429 failures stop both runners with honest partial state', async t => {
  for (const [name, response, code, reason] of [
    ['thrown 403', Object.assign(new Error('fixture'), { status: 403 }), 'ACCESS_DENIED', 'access_denied'],
    ['thrown 429', Object.assign(new Error('fixture'), { statusCode: 429 }), 'RATE_LIMITED', 'rate_limited'],
    ['returned 403', { ok: false, status: 403, code: 'UNEXPECTED' }, 'ACCESS_DENIED', 'access_denied'],
    ['returned 429', { data: {}, receipt: { httpStatus: 429 } }, 'RATE_LIMITED', 'rate_limited'],
    ['nested 429', { ok: false, error: { code: 'RATE_LIMITED', httpStatus: 429 } }, 'RATE_LIMITED', 'rate_limited'],
    ['shared code', fail('ACCESS_DENIED'), 'ACCESS_DENIED', 'access_denied'],
  ]) await t.test(name, async () => {
    const local = fixture([{ items: [{ id: 1 }], next: 'a' }, response]);
    const result = await collectOperationPages(query(), local);
    assert.equal(result.error.code, code);
    assert.equal(result.reason, reason);
    assert.equal(result.partial, true);
    assert.equal(result.complete, false);
    assert.equal(result.terminal, false);
    assert.deepEqual(result.records, [{ id: 1 }]);
    assert.deepEqual(result.counters, { requests: 2, pages: 1, items: 1, duplicates: 0 });
    assert.deepEqual(result.checkpoint.nextInput, { query: { cursor: 'a' } });
    assert.equal(local.calls.length, 2);
    const definition = { steps: [{ id: 'one', operation: 'one' }, { id: 'two', operation: 'two' }, { id: 'never', operation: 'never' }] };
    const flow = await runOperationFlow(definition, fixture([{ data: { id: 1 } }, response]));
    assert.equal(flow.error.code, code);
    assert.equal(flow.reason, reason);
    assert.deepEqual(flow.results, { one: { id: 1 } });
    assert.equal(flow.counters.requests, 2);
  });
});

test('a failed page is retried only on explicit resume and the prior successful page stays saved', async () => {
  const first = fixture([{ items: [1], next: 'a' }, fail('TRANSPORT')]);
  const result = await collectOperationPages(query(), first);
  assert.equal(result.error.code, 'TRANSPORT');
  assert.equal(result.reason, 'error');
  const second = fixture([{ items: [2], next: null }]);
  const resumed = await collectOperationPages(query(), { execute: second.execute, checkpoint: saved(result.checkpoint) });
  assert.equal(second.calls.length, 1);
  assert.deepEqual(second.calls[0].input, { query: { cursor: 'a' } });
  assert.equal(resumed.complete, true);
  assert.deepEqual(resumed.records, [1, 2]);
  assert.equal(resumed.counters.requests, 3);
  assert.equal(Object.hasOwn(resumed, 'error'), false);
});

test('terminal pagination checkpoints are inert even with an aborted signal or zero budget', async () => {
  const definition = query();
  const result = await collectOperationPages(definition, fixture([{ items: [1] }]));
  const signal = AbortSignal.abort();
  const local = fixture([]);
  const resumed = await collectOperationPages({ ...definition, budget: { maxPages: 0, deadlineMs: 0 } },
    { execute: local.execute, signal, checkpoint: saved(result.checkpoint) });
  assert.deepEqual(resumed, result);
  assert.equal(local.calls.length, 0);
});

test('pre-aborted flow and pagination make no requests and can resume with a fresh signal', async () => {
  const signal = AbortSignal.abort();
  const local = fixture([]);
  const definition = { steps: [{ id: 'one', operation: 'one' }] };
  const flow = await runOperationFlow(definition, { execute: local.execute, signal });
  const pages = await collectOperationPages(query(), { execute: local.execute, signal });
  assert.equal(flow.reason, 'aborted');
  assert.equal(pages.reason, 'aborted');
  assert.equal(local.calls.length, 0);
  assert.equal(flow.counters.requests, 0);
  assert.equal(pages.counters.requests, 0);
  const resumed = await collectOperationPages(query(), { execute: fixture([{ items: [] }]).execute, checkpoint: saved(pages.checkpoint) });
  assert.equal(resumed.complete, true);
});

test('abort after checkpoint preserves accepted records and next input without dispatching another request', async () => {
  const controller = new AbortController();
  const local = fixture([{ items: [1], next: 'a' }]);
  const result = await collectOperationPages(query(), { execute: local.execute, signal: controller.signal,
    onCheckpoint: snapshot => { if (snapshot.counters.pages === 1) controller.abort(); } });
  assert.equal(result.reason, 'aborted');
  assert.deepEqual(result.records, [1]);
  assert.equal(local.calls.length, 1);
  assert.deepEqual(result.checkpoint.nextInput, { query: { cursor: 'a' } });
  const next = fixture([{ items: [2] }]);
  const resumed = await collectOperationPages(query(), { execute: next.execute, checkpoint: saved(result.checkpoint) });
  assert.deepEqual(resumed.records, [1, 2]);
  assert.equal(next.calls.length, 1);
});

test('in-flight abort is bounded even when an injected executor ignores its signal', async () => {
  for (const kind of ['flow', 'pages']) {
    const controller = new AbortController();
    let started;
    const began = new Promise(resolve => { started = resolve; });
    const execute = async (_operation, _input, { signal }) => { started(signal); return new Promise(() => {}); };
    const promise = kind === 'flow' ? runOperationFlow({ steps: [{ id: 'one', operation: 'one' }] }, { execute, signal: controller.signal })
      : collectOperationPages(query(), { execute, signal: controller.signal });
    const actualSignal = await began;
    controller.abort();
    const result = await promise;
    assert.equal(actualSignal.aborted, true);
    assert.equal(result.reason, 'aborted');
    assert.equal(result.terminal, false);
    assert.equal(result.counters.requests, 1);
  }
});

test('executor abort errors are classified as cancellation even without a caller signal', async () => {
  for (const error of [fail('OPERATION_ABORTED'), fail('ABORT_ERR'), new DOMException('fixture', 'AbortError')]) {
    const pages = await collectOperationPages(query(), fixture([error]));
    assert.equal(pages.reason, 'aborted');
    assert.equal(pages.error.code, 'ABORTED');
    const flow = await runOperationFlow({ steps: [{ id: 'one', operation: 'one' }] }, fixture([error]));
    assert.equal(flow.reason, 'aborted');
    assert.equal(flow.error.code, 'ABORTED');
  }
});

test('deadline stops a hanging executor via an injected signal (deterministic mock timer)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const promise = collectOperationPages(query(cursor, { budget: { deadlineMs: 100 } }), {
    execute: async (_operation, _input, { signal }) => { began(signal); return new Promise(() => {}); },
  });
  const signal = await started;
  t.mock.timers.tick(100);
  const result = await promise;
  assert.equal(signal.aborted, true);
  assert.equal(result.reason, 'deadline');
  assert.equal(result.error.code, 'DEADLINE_EXCEEDED');
  assert.equal(result.counters.requests, 1);
  assert.equal(result.counters.pages, 0);
  assert.deepEqual(result.checkpoint.nextInput, {});
});

test('elapsed deadline between pages retains the accepted page without fetching the next', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let count = 0;
  const result = await collectOperationPages(query(cursor, { budget: { deadlineMs: 100 } }), {
    execute: async () => { count++; return { items: [1], next: 'a' }; },
    onCheckpoint: () => { now = 1101; },
  });
  assert.equal(result.reason, 'deadline');
  assert.equal(count, 1);
  assert.deepEqual(result.records, [1]);
  assert.deepEqual(result.checkpoint.nextInput, { query: { cursor: 'a' } });
});

test('pagination callback checkpoints are isolated and carry consumable records, counters, and next inputs', async () => {
  const snapshots = [];
  const local = fixture([{ data: { items: [{ id: 1 }], next: 'a' }, pageInfo: { candidate: true }, receipt: { operation: 'list' } },
    { data: { items: [{ id: 2 }], next: null }, pageInfo: { candidate: true }, receipt: { operation: 'list' } }]);
  const result = await collectOperationPages(query(), { execute: local.execute, onCheckpoint: snapshot => {
    snapshots.push(saved(snapshot)); snapshot.records.length = 0; snapshot.nextInput = null; snapshot.counters.pages = 999;
  } });
  assert.deepEqual(result.records, [{ id: 1 }, { id: 2 }]);
  assert.equal(result.counters.pages, 2);
  assert.deepEqual(snapshots[0].records, [{ id: 1 }]);
  assert.deepEqual(snapshots[0].nextInput, { query: { cursor: 'a' } });
  const second = fixture([{ items: [{ id: 2 }] }]);
  const resumed = await collectOperationPages(query(), { execute: second.execute, checkpoint: snapshots[0] });
  assert.deepEqual(resumed.records, result.records);
  assert.equal(second.calls.length, 1);
});

test('pagination persistence failure exposes acknowledged progress without reclassifying it as executor failure', async () => {
  const local = fixture([{ items: [1], next: 'a' }]);
  let checkpoint;
  await assert.rejects(collectOperationPages(query(), { execute: local.execute, onCheckpoint: () => { throw fail('DISK_FULL'); } }), error => {
    assert.equal(error.code, 'CHECKPOINT_FAILED'); checkpoint = saved(error.checkpoint); return true;
  });
  assert.equal(checkpoint.counters.pages, 1);
  assert.deepEqual(checkpoint.records, [1]);
  assert.deepEqual(checkpoint.nextInput, { query: { cursor: 'a' } });
  const next = fixture([{ items: [2] }]);
  const result = await collectOperationPages(query(), { execute: next.execute, checkpoint });
  assert.deepEqual(next.calls[0].input, { query: { cursor: 'a' } });
  assert.deepEqual(result.records, [1, 2]);
});

test('checkpoints cannot silently resume a different operation, input, pagination declaration or flow', async () => {
  const result = await collectOperationPages(query(cursor, { budget: { maxPages: 0 } }), fixture([]));
  for (const definition of [query(cursor, { operation: 'different' }), query(cursor, { input: { query: { other: true } } }), query({ ...cursor, nextPointer: '/different' })]) {
    await assert.rejects(collectOperationPages(definition, { execute: fixture([]).execute, checkpoint: saved(result.checkpoint) }), { code: 'CHECKPOINT_MISMATCH' });
  }
  const definition = { steps: [{ id: 'one', operation: 'one' }] };
  const flow = await runOperationFlow(definition, { execute: fixture([]).execute, signal: AbortSignal.abort() });
  await assert.rejects(runOperationFlow({ steps: [{ id: 'one', operation: 'two' }] },
    { execute: fixture([]).execute, checkpoint: flow.checkpoint }), { code: 'CHECKPOINT_MISMATCH' });
  const invalid = saved(result.checkpoint); invalid.counters.items = 10;
  await assert.rejects(collectOperationPages(query(), { execute: fixture([]).execute, checkpoint: invalid }), { code: 'CHECKPOINT_INVALID' });
});

test('declarations, dependencies, budgets and non-JSON results fail explicitly before unsupported work', async t => {
  for (const [name, definition] of [
    ['missing cursor continuation', query({ ...cursor, nextPointer: undefined })],
    ['unknown kind', query({ ...cursor, kind: 'guess' })],
    ['root input path', query({ ...cursor, inputPath: '' })],
    ['bad pointer', query({ ...cursor, itemsPointer: 'items' })],
    ['zero step', query({ ...page, step: 0 })],
    ['negative budget', query(cursor, { budget: { maxPages: -1 } })],
    ['infinite budget', query(cursor, { budget: { maxItems: Infinity } })],
    ['unknown budget', query(cursor, { budget: { maxRequests: 1 } })],
    ['bad numeric input', query(page, { input: { query: { page: 'one' } } })],
    ['scalar nested input', query(page, { input: { query: 1 } })],
  ]) await t.test(name, async () => {
    const local = fixture([]);
    await assert.rejects(collectOperationPages(definition, local));
    assert.equal(local.calls.length, 0);
  });
  await assert.rejects(collectOperationPages(query()), { code: 'FLOW_DEPENDENCIES_INVALID' });
  await assert.rejects(runOperationFlow({ steps: [] }), { code: 'FLOW_DEPENDENCIES_INVALID' });
  await assert.rejects(runOperationFlow({ steps: [{ id: 'a', operation: 'a' }, { id: 'a', operation: 'b' }] }, fixture([])), { code: 'FLOW_STEPS_INVALID' });
  const nonJSON = await collectOperationPages(query(), { execute: async () => ({ items: [1n] }) });
  assert.equal(nonJSON.complete, false);
  assert.equal(nonJSON.error.code, 'RESULT_NOT_JSON');
  const cyclic = {}; cyclic.self = cyclic;
  const flow = await runOperationFlow({ steps: [{ id: 'a', operation: 'a' }] }, { execute: async () => cyclic });
  assert.equal(flow.error.code, 'RESULT_NOT_JSON');
});

test('invalid continuation values are partial errors, not guessed routes or natural completion', async t => {
  for (const [kind, value] of [['cursor', {}], ['next_url', 1], ['page', true], ['offset', -1]]) await t.test(kind, async () => {
    const pagination = { ...cursor, kind };
    const local = fixture([{ items: [1], next: value }]);
    const result = await collectOperationPages(query(pagination), local);
    assert.equal(result.complete, false);
    assert.equal(result.error.code, 'PAGINATION_CONTINUATION_INVALID');
    assert.equal(result.terminal, true);
    assert.deepEqual(result.records, [1], 'retain the valid acknowledged page even though its continuation is malformed');
    assert.equal(result.counters.pages, 1);
    assert.equal(result.counters.requests, 1);
    const resumed = await collectOperationPages(query(pagination), { execute: local.execute, checkpoint: saved(result.checkpoint) });
    assert.deepEqual(resumed, result);
    assert.equal(local.calls.length, 1);
  });
});

test('invalid continuation plus item budget preserves buffered records and the terminal error on resume', async () => {
  const options = query(cursor, { budget: { maxItems: 1 } });
  const local = fixture([{ items: [1, 2], next: {} }]);
  const result = await collectOperationPages(options, local);
  assert.equal(result.reason, 'max_items');
  assert.equal(result.terminal, false);
  assert.equal(result.error.code, 'PAGINATION_CONTINUATION_INVALID');
  const resumed = await collectOperationPages(options, { execute: local.execute, checkpoint: saved(result.checkpoint) });
  assert.deepEqual(resumed.records, [1, 2]);
  assert.equal(resumed.reason, 'error');
  assert.equal(resumed.complete, false);
  assert.equal(resumed.terminal, true);
  assert.equal(resumed.error.code, 'PAGINATION_CONTINUATION_INVALID');
  assert.equal(local.calls.length, 1);
});

test('large string IDs are compared exactly without numeric coercion or prefix matching', async () => {
  const local = fixture([{ items: [{ id: '9007199254740992' }, { id: '9007199254740993' }, { id: '001' }], next: 'a' },
    { items: [{ id: '9007199254740993' }, { id: '001x' }, { id: '01' }, { id: '1' }] }]);
  const result = await collectOperationPages(query(), local);
  assert.deepEqual(result.records.map(item => item.id), ['9007199254740992', '9007199254740993', '001', '001x', '01', '1']);
  assert.equal(result.counters.duplicates, 1);
});

test('declared input and response pointers support escaped keys and nested array slots', async () => {
  const pagination = { kind: 'cursor', inputPath: '/body/variables/filters/0/a~1b',
    itemsPointer: '/payload/a~1b', nextPointer: '/payload/~0next', idPointer: '/a~1b' };
  const local = fixture([{ payload: { 'a/b': [{ 'a/b': 'id' }], '~next': 'second' } }, { payload: { 'a/b': [], '~next': null } }]);
  const input = { body: { variables: { filters: [{ keep: false }] } } };
  const result = await collectOperationPages(query(pagination, { input }), local);
  assert.deepEqual(local.calls[1].input, { body: { variables: { filters: [{ keep: false, 'a/b': 'second' }] } } });
  assert.deepEqual(result.records, [{ 'a/b': 'id' }]);
  assert.equal(result.complete, true);
});

test('repeated small-budget resumes preserve every record without repeated requests across all four kinds', async t => {
  for (const kind of ['page', 'offset', 'cursor', 'next_url']) await t.test(kind, async () => {
    const continuations = kind === 'page' ? [1, 2, 3, 4] : kind === 'offset' ? [0, 3, 6, 9]
      : kind === 'cursor' ? ['first', 'a', 'b', 'c'] : ['seed', 'opaque:a', './b', 'https://fixture.invalid/c'];
    const pages = [[{ id: 'a' }, { id: 1 }, { id: 'a' }], [{ id: 1 }, { id: '1' }, { id: 0 }],
      [{ id: false }, { id: '9007199254740993' }], []];
    const requested = [];
    const pagination = { kind, inputPath: '/body/state/token', itemsPointer: '/items', idPointer: '/id', start: continuations[0],
      ...(['cursor', 'next_url'].includes(kind) ? { nextPointer: '/next' } : kind === 'offset' ? { step: 3 } : {}) };
    const definition = query(pagination, { budget: { maxPages: 1, maxItems: 1 } });
    const execute = async (_operation, input) => {
      const continuation = input.body.state.token;
      assert.equal(requested.includes(continuation), false, 'never refetch an acknowledged page');
      const index = continuations.indexOf(continuation);
      assert.notEqual(index, -1);
      requested.push(continuation);
      return { data: { items: pages[index], next: continuations[index + 1] ?? null },
        receipt: { executionMode: 'existing_adapter' }, pageInfo: { candidate: true } };
    };
    let checkpoint, result;
    for (let run = 0; run < 20; run++) {
      const previousSize = checkpoint?.records.length ?? 0;
      result = await collectOperationPages(definition, { execute, ...(checkpoint ? { checkpoint } : {}) });
      assert.ok(result.records.length >= previousSize);
      assert.equal(result.partial, !result.complete);
      checkpoint = saved(result.checkpoint);
      if (result.terminal) break;
    }
    assert.equal(result.complete, true);
    assert.deepEqual(result.records.map(record => record.id), ['a', 1, '1', 0, false, '9007199254740993']);
    assert.deepEqual(requested, continuations);
    assert.deepEqual(result.counters, { requests: 4, pages: 4, items: 6, duplicates: 2 });
    assert.equal(result.receipts.length, 4);
  });
});

test('empty flows complete and remain inert on resume', async () => {
  const local = fixture([]);
  const result = await runOperationFlow({ steps: [] }, local);
  assert.equal(result.ok, true);
  assert.equal(result.terminal, true);
  assert.deepEqual(result.counters, { requests: 0, completed: 0, skipped: 0 });
  const resumed = await runOperationFlow({ steps: [] }, { execute: local.execute, checkpoint: saved(result.checkpoint) });
  assert.deepEqual(resumed, result);
  assert.equal(local.calls.length, 0);
});
