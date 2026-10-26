import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createOperationRegistry } from '../lib/operation-registry.mjs';
import { createOperationMcpHandler, serveOperationMcp } from '../lib/operation-mcp.mjs';

function registry(adapter = async input => ({ data: { text: input.query.text } })) {
  return createOperationRegistry({ schemaVersion: 2, serviceId: 'fixture', allowedOrigins: [], operations: {
    echo: { adapter: 'echo', semantics: 'read', evidence: 'synthetic adapter',
      inputs: { query: { text: { type: 'string', required: true } } }, outputSchema: { type: 'object' } },
  } }, { adapters: { echo: adapter } });
}
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = handle => handle(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }));

test('MCP initialization, tools/list and tools/call run the same registry', async () => {
  const core = registry(), handle = createOperationMcpHandler(core);
  assert.equal((await handle(request(0, 'tools/list'))).error.code, -32000);
  const init = await initialize(handle);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const listing = await handle(request(2, 'tools/list'));
  assert.deepEqual(listing.result.tools, core.tools());
  const result = await handle(request(3, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: '한글\nline' } } }));
  assert.equal(result.result.isError, false);
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
  assert.equal(result.result.structuredContent.data.text, '한글\nline');
});

test('MCP distinguishes protocol failures from execution errors without leaking exception text', async () => {
  const handle = createOperationMcpHandler(registry()); await initialize(handle);
  assert.equal((await handle(request(2, 'missing'))).error.code, -32601);
  assert.equal((await handle(request(3, 'tools/call', { name: 'unknown' }))).error.code, -32602);
  assert.equal((await handle([])).error.code, -32600);
  const failed = await handle(request(4, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: 2 } } }));
  assert.equal(failed.result.isError, true);
  assert.equal(JSON.parse(failed.result.content[0].text).code, 'OPERATION_INPUT_INVALID');
  const unexpected = createOperationMcpHandler(registry(async () => { throw new Error('private upstream body'); }));
  await initialize(unexpected);
  assert.equal(JSON.stringify(await unexpected(request(5, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: 'x' } } }))).includes('private'), false);
});

test('MCP preserves only an explicit safe Kmong collection partial result and keeps it an error', async () => {
  const scope = { keyword: 'synthetic', pageSize: 40 };
  const state = {
    schemaVersion: 1, service: 'kmong', operation: 'search', scope,
    items: [], pages: [], requests: [],
    attempts: [{ page: 1, code: 'KMONG_HTTP_TIMEOUT', observedAt: '2026-10-26T08:00:00.000Z', requestIndexes: [] }],
    issues: [], nextPage: 1, totalItemCount: null, lastPage: null, complete: false, resumeAllowed: true,
  };
  const partialResult = {
    kind: 'kmong_read_only_collection', operation: 'kmong-search-collect',
    data: {
      schemaVersion: 1, service: 'kmong', operation: 'search', status: 'partial',
      observedAt: null, checkpointProvenance: 'collector_created', checkpointAuthenticated: false,
      networkUsed: true, scope, items: [], pages: [], newPages: [],
      pagination: { page: null, pageSize: 40, pagesWalked: 0, totalItemCount: null, lastPage: null,
        complete: false, sourceWindowComplete: false, completeCatalog: false, nextPage: 1,
        pageWalked: true, resumable: true },
      state, attempts: state.attempts, issues: [], requests: [], currentRequests: [],
      error: { code: 'KMONG_HTTP_TIMEOUT', requestIndexes: [] }, limitations: [],
      contractProvenance: { kind: 'first_party_bundle' },
    },
  };
  const safePartial = registry(async () => {
    const error = new Error('do not expose arbitrary error text');
    error.code = 'KMONG_HTTP_TIMEOUT';
    error.receipt = { private: 'arbitrary receipt must stay hidden' };
    error.partialResult = partialResult;
    throw error;
  });
  const handle = createOperationMcpHandler(safePartial); await initialize(handle);
  const result = await handle(request(9, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: 'x' } } }));
  assert.equal(result.result.isError, true);
  assert.deepEqual(result.result.structuredContent, { ok: false, code: 'KMONG_HTTP_TIMEOUT', partialResult });
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
  assert.equal(JSON.stringify(result).includes('arbitrary receipt'), false);
  assert.equal(JSON.stringify(result).includes('do not expose arbitrary'), false);

  const generic = createOperationMcpHandler(registry(async () => {
    const error = new Error('ordinary error');
    error.code = 'KMONG_HTTP_TIMEOUT';
    error.receipt = { arbitrary: 'must remain private' };
    throw error;
  }));
  await initialize(generic);
  const genericResult = await generic(request(10, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: 'x' } } }));
  assert.deepEqual(JSON.parse(genericResult.result.content[0].text), { ok: false, code: 'KMONG_HTTP_TIMEOUT' });
  assert.equal(Object.hasOwn(genericResult.result, 'structuredContent'), false);
  assert.equal(JSON.stringify(genericResult).includes('must remain private'), false);
});

test('MCP cancellation propagates to the in-flight adapter', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const handle = createOperationMcpHandler(registry(async (_input, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { code: 'OPERATION_ABORTED' })), { once: true }));
  }));
  await initialize(handle);
  const call = handle(request(7, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: 'x' } } }));
  await ready;
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'fixture' } }), undefined);
  assert.equal(JSON.parse((await call).result.content[0].text).code, 'OPERATION_ABORTED');
});

test('stdio emits only newline-delimited JSON-RPC, including malformed-message errors', async () => {
  const messages = [JSON.stringify(request(1, 'initialize', { protocolVersion: '2025-06-18' })), '{broken',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), JSON.stringify(request(2, 'tools/list')),
    JSON.stringify(request(3, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: 'hello' } } }))];
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  await serveOperationMcp(registry(), { input: Readable.from([messages.join('\n') + '\n']), output });
  const lines = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.ok(lines.every(line => line.jsonrpc === '2.0'));
  assert.equal(lines.find(line => line.error)?.error.code, -32700);
  assert.equal(lines.find(line => line.id === 3).result.structuredContent.data.text, 'hello');
});

test('stdio EOF cancels an uncooperative adapter after the shutdown grace period', async () => {
  const messages = [request(1, 'initialize', { protocolVersion: '2025-06-18' }),
    request(2, 'tools/call', { name: 'fixture__echo', arguments: { query: { text: 'x' } } })];
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  await serveOperationMcp(registry(async () => new Promise(() => {})), {
    input: Readable.from([messages.map(value => JSON.stringify(value)).join('\n') + '\n']), output, shutdownGraceMs: 5,
  });
  const reply = text.trim().split('\n').map(line => JSON.parse(line)).find(line => line.id === 2);
  assert.equal(reply.result.isError, true);
  assert.equal(JSON.parse(reply.result.content[0].text).code, 'OPERATION_ABORTED');
});
