import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationRegistry, validateOperationProfile, validateOperationValue } from '../lib/operation-registry.mjs';

const ORIGIN = 'https://example.invalid';
function profile(op = {}) {
  return { schemaVersion: 2, serviceId: 'fixture', allowedOrigins: [ORIGIN], operations: {
    search: { origin: ORIGIN, path: '/search', method: 'GET', semantics: 'read', evidence: 'synthetic fixture',
      expected: { status: 200, mime: 'application/json' },
      inputs: { query: { q: { type: 'string', required: true, minLength: 1 }, page: { type: 'integer', default: 1, minimum: 1 } } },
      response: { format: 'json', requiredPointers: ['/items'] },
      outputSchema: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] }, ...op },
  } };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('v2 input defaults, request encoding, structured output and generated tool use the same definition', async () => {
  let request;
  const registry = createOperationRegistry(profile(), { fetchImpl: async (url, init) => { request = { url, init }; return json({ items: [{ id: 'sku-1' }] }); } });
  const result = await registry.execute('search', { query: { q: '노트북 & 케이스' } });
  assert.equal(new URL(request.url).searchParams.get('q'), '노트북 & 케이스');
  assert.equal(new URL(request.url).searchParams.get('page'), '1');
  assert.equal(result.data.items[0].id, 'sku-1');
  assert.equal(result.receipt.executionMode, 'pure_http');
  assert.match(result.receipt.responseSha256, /^[a-f0-9]{64}$/);
  const tool = registry.tools()[0];
  assert.equal(tool.name, 'fixture__search');
  assert.equal(tool.inputSchema.properties.query.properties.page.type, 'integer');
  assert.deepEqual(tool.inputSchema.required, ['query']);
  assert.deepEqual(tool.inputSchema.properties.query.required, ['q']);
  assert.deepEqual((await registry.callTool(tool.name, { query: { q: 'x' } })).data, result.data);
});

test('typed validation fails before execution and does not coerce CLI strings', async () => {
  let calls = 0;
  const registry = createOperationRegistry(profile(), { fetchImpl: async () => { calls++; return json({ items: [] }); } });
  for (const input of [{}, { query: { q: '' } }, { query: { q: 'x', page: '2' } }, { query: { q: 'x', extra: true } }, { extra: {} }]) {
    await assert.rejects(registry.execute('search', input), error => /^OPERATION_INPUT_/.test(error.code));
  }
  assert.equal(calls, 0);
});

test('v1 profiles and response checks remain usable without migration', async () => {
  const legacy = { schemaVersion: 1, serviceId: 'legacy', allowedOrigins: [ORIGIN], operations: {
    items: { origin: ORIGIN, path: '/items', method: 'GET', semantics: 'read', evidence: 'synthetic', queryFields: ['page'],
      expected: { status: 200, mime: 'application/json', checks: [{ path: ['items'], type: 'array' }] } },
  } };
  const registry = createOperationRegistry(legacy, { fetchImpl: async () => json({ items: [] }) });
  assert.deepEqual((await registry.execute('items', { query: { page: '1' } })).data, { items: [] });
  await assert.rejects(registry.execute('items', { query: { page: 1 } }), /OPERATION_INPUT_INVALID/);
});

test('JSON GraphQL bodies preserve nested variable types and errors do not count as success', async () => {
  let body;
  const spec = profile({ method: 'POST', graphql: true, inputs: { body: {
    query: { type: 'string', default: 'query Search($page: Int!) { items(page: $page) { id } }' },
    variables: { required: true, schema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'], additionalProperties: false } },
  } }, outputSchema: undefined, response: { format: 'json' } });
  const registry = createOperationRegistry(spec, { fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return json({ data: { items: [] } }); } });
  await registry.execute('search', { body: { variables: { page: 2 } } });
  assert.equal(body.variables.page, 2);
  assert.match(body.query, /query Search/);
  const broken = createOperationRegistry(spec, { fetchImpl: async () => json({ errors: [{ message: 'private detail' }] }) });
  await assert.rejects(broken.execute('search', { body: { variables: { page: 2 } } }), /GRAPHQL_ERRORS/);
});

test('form encoding and typed path interpolation are reusable', async () => {
  let observed;
  const registry = createOperationRegistry(profile({ path: '/items/{id}', method: 'POST', bodyEncoding: 'form',
    inputs: { path: { id: { type: 'string', required: true } }, body: { title: { type: 'string', required: true } } },
  }), { fetchImpl: async (url, init) => { observed = { url, init }; return json({ items: [] }); } });
  await registry.execute('search', { path: { id: 'abc' }, body: { title: 'a & b' } });
  assert.equal(observed.url, `${ORIGIN}/items/abc`);
  assert.equal(observed.init.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(observed.init.body).get('title'), 'a & b');
});

test('existing adapters are injected, never imported or rewritten from profile strings', async () => {
  const spec = profile({ adapter: 'existing.search', outputSchema: { type: 'array' }, inputs: { query: { q: { type: 'string', required: true } } } });
  const registry = createOperationRegistry(spec, { adapters: { 'existing.search': async input => ({ data: [input.query.q], pageInfo: { next: 'b' } }) } });
  assert.deepEqual((await registry.execute('search', { query: { q: 'hello' } })).data, ['hello']);
  assert.equal((await registry.execute('search', { query: { q: 'hello' } })).receipt.executionMode, 'existing_adapter');
  await assert.rejects(createOperationRegistry(spec).execute('search', { query: { q: 'x' } }), /OPERATION_ADAPTER_REQUIRED/);
});

test('writes stay on an explicit existing writer; health/MCP cannot silently replay generic HTTP writes', async () => {
  let calls = 0;
  const spec = profile({ semantics: 'write' });
  const registry = createOperationRegistry(spec, { fetchImpl: async () => { calls++; return json({ items: [] }); } });
  await assert.rejects(registry.execute('search', { query: { q: 'x' } }), /WRITE_ADAPTER_REQUIRED/);
  assert.equal(calls, 0);
  const writer = createOperationRegistry(spec, { writeExecutor: async () => ({ data: { items: [] }, receipt: { readbackVerified: true } }) });
  assert.equal((await writer.execute('search', { query: { q: 'x' } })).receipt.readbackVerified, true);
});

test('output schema mismatch, HTTP 403/429 and invalid declarations remain explicit failures', async () => {
  const schemaMismatch = createOperationRegistry(profile({ response: { format: 'json' } }), { fetchImpl: async () => json({ items: 'not a list' }) });
  await assert.rejects(schemaMismatch.execute('search', { query: { q: 'x' } }), /OPERATION_OUTPUT_MISMATCH/);
  for (const status of [403, 429, 503]) {
    const registry = createOperationRegistry(profile(), { fetchImpl: async () => json({}, status) });
    await assert.rejects(registry.execute('search', { query: { q: 'x' } }), error => error.status === status);
  }
  assert.throws(() => validateOperationProfile(profile({ inputs: { query: { x: { type: 'string', pattern: 'ignored?' } } } })), /OPERATION_SCHEMA_INVALID/);
  assert.throws(() => validateOperationProfile(profile({ path: '/{undeclared}' })), /OPERATION_PATH_SCHEMA_INVALID/);
  assert.throws(() => validateOperationValue({ items: [1] }, { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } }), /OPERATION_INPUT_INVALID/);
});

test('caller cancellation reaches the HTTP transport and stops the current read', async () => {
  const controller = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const registry = createOperationRegistry(profile(), { fetchImpl: async (_url, init) => {
    entered();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const call = registry.execute('search', { query: { q: 'x' } }, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(call, /OPERATION_ABORTED/);
});

test('HTML relative links use the final redirected directory while existing response shape stays opt-in', async () => {
  let calls = 0;
  const registry = createOperationRegistry(profile({ path: '/old', inputs: {}, expected: { status: 200, mime: 'text/html' },
    outputSchema: { type: 'array' }, response: { format: 'html', html: { items: 'article', fields: { title: { selector: 'h2' } },
      page: { next: { selector: 'a.next', attribute: 'href', absoluteUrl: true } } } },
  }), { fetchImpl: async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: '/catalog/page/' } })
    : new Response('<article><h2>item</h2></article><a class="next" href="../2">next</a>', { headers: { 'content-type': 'text/html' } }) });
  const result = await registry.execute('search');
  assert.equal(result.pageInfo.next, `${ORIGIN}/catalog/2`);
  assert.equal(calls, 2);
});

test('registry definitions and tool schemas cannot mutate the registered runtime', async () => {
  const registry = createOperationRegistry(profile(), { fetchImpl: async () => json({ items: [] }) });
  assert.throws(() => { registry.profile.operations.search.semantics = 'write'; }, TypeError);
  const tool = registry.tools()[0]; tool.inputSchema.properties.query.properties.page.default = 999;
  assert.equal(registry.describe('search').inputSchema.properties.query.properties.page.default, 1);
  assert.equal(tool.outputSchema.properties.data.type, 'object');
});

test('JSON fields reject non-JSON values and object enum equality ignores key ordering', () => {
  for (const value of [NaN, Infinity, 1n, Symbol('x'), () => 1, new Date(), { value: undefined }]) {
    assert.throws(() => validateOperationValue(value, { type: 'json' }), /OPERATION_INPUT_INVALID/);
  }
  const circular = {}; circular.self = circular;
  assert.throws(() => validateOperationValue(circular, {}), /OPERATION_INPUT_INVALID/);
  assert.deepEqual(validateOperationValue({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }), { b: 2, a: 1 });
  assert.equal(validateOperationValue(-0, { enum: [0] }), -0);
});

test('Unicode string bounds count code points and duplicate required names are rejected', () => {
  assert.equal(validateOperationValue('😀', { type: 'string', maxLength: 1 }), '😀');
  assert.throws(() => validateOperationValue('😀', { type: 'string', minLength: 2 }), /OPERATION_INPUT_INVALID/);
  assert.throws(() => validateOperationProfile(profile({ outputSchema: { type: 'object', required: ['id', 'id'] } })), /OPERATION_SCHEMA_INVALID/);
});

test('nested field defaults agree between execution and generated MCP schemas', async () => {
  let input;
  const registry = createOperationRegistry(profile({ adapter: 'fixture', outputSchema: { type: 'object' },
    inputs: { query: { page: { required: true, schema: { type: 'integer', default: 2 } } } },
  }), { adapters: { fixture: async value => { input = value; return { data: {} }; } } });
  await registry.execute('search');
  assert.equal(input.query.page, 2);
  assert.deepEqual(registry.tools()[0].inputSchema.required, []);
  assert.equal(registry.tools()[0].inputSchema.properties.query.properties.page.default, 2);
});

test('malformed adapter payloads and metadata fail before JSON serialization', async () => {
  for (const value of [{ data: 1n }, { data: { price: NaN } }, { data: {}, pageInfo: { cursor: undefined } }, { data: {}, receipt: { checkedAt: new Date() } }]) {
    const registry = createOperationRegistry(profile({ adapter: 'fixture', inputs: {} }), { adapters: { fixture: async () => value } });
    await assert.rejects(registry.execute('search'), /OPERATION_ADAPTER_RESULT_INVALID/);
  }
});

test('adapter cancellation normalizes native reasons and does not await an ignoring executor', async () => {
  for (const ignores of [false, true]) {
    const controller = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const registry = createOperationRegistry(profile({ adapter: 'fixture', inputs: {} }), { adapters: { fixture: async (_input, { signal }) => {
      started(); return new Promise((_resolve, reject) => {
        if (!ignores) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } } });
    const call = registry.execute('search', {}, { signal: controller.signal });
    await ready; controller.abort();
    await assert.rejects(call, /OPERATION_ABORTED/);
  }
});
