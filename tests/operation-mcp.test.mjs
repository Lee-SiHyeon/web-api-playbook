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
