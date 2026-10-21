import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadServiceDefinitions } from '../lib/service-operations/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function cli(args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/playbook.mjs', ...args], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture timed out')); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

test('all shipped service definitions validate without opening credentials or a transport', async () => {
  const entries = await loadServiceDefinitions();
  assert.ok(entries.length >= 45);
  assert.ok(entries.reduce((count, entry) => count + Object.keys(entry.profile.operations).length, 0) >= 150);
  assert.ok(entries.every(entry => Object.values(entry.profile.operations).every(op => op.semantics === 'read')));
});

test('CLI list includes executable services and separates unimplemented checklist scopes', async () => {
  const result = await cli(['list', '--all']);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.networkUsed, false);
  assert.ok(data.summary.connectedServices >= 45);
  assert.equal(data.services.find(service => service.id === 'ably').connection, 'connected');
  assert.equal(data.services.find(service => service.id === 'temu').connection, 'not_connected');
  assert.equal(data.services.find(service => service.id === 'operation-runtime').connection, 'scope_only');
});

test('CLI describe and tools share typed service action schemas', async () => {
  const described = await cli(['describe', '--service=ably', '--operation=search']);
  const tools = await cli(['tools', '--service=ably']);
  assert.equal(described.status, 0, described.stderr); assert.equal(tools.status, 0, tools.stderr);
  const operation = JSON.parse(described.stdout), tool = JSON.parse(tools.stdout).tools.find(tool => tool.name === 'ably__search');
  assert.deepEqual(tool.inputSchema, operation.inputSchema);
  assert.equal(operation.adapter, 'ably.search');
  assert.equal(operation.inputSchema.properties.query.properties.query.type, 'string');
});

test('a named protected CLI check reports missing provider, never synthetic success', async () => {
  const result = await cli(['check', '--service=aliexpress-partner', '--timeout=1000']);
  assert.equal(result.status, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.checks[0].code, 'PROVIDER_MISSING');
  assert.notEqual(value.verdict, 'ok');
});

test('single-service verification produces operation-level honest failure evidence', async () => {
  const result = await cli(['verify', '--service=aliexpress-partner', '--timeout=1000', '--progress']);
  assert.equal(result.status, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.results[0].checks[0].code, 'PROVIDER_MISSING');
  assert.equal(value.summary.liveReadChecksPassed, 0);
  assert.equal(value.summary.selected, 1);
  assert.equal(JSON.parse(result.stderr).serviceId, 'aliexpress-partner');
});

test('credentials are service-bound on stdin and never accepted as CLI argument values', async () => {
  const mismatched = await cli(['run', '--service=aliexpress-partner', '--operation=search', '--credentials-stdin'],
    JSON.stringify({ service: 'wrong', credentials: { appSecret: 'fixture-secret-must-not-appear' } }));
  assert.equal(mismatched.status, 1);
  assert.equal(JSON.parse(mismatched.stderr).code, 'CREDENTIAL_SERVICE_MISMATCH');
  assert.equal(mismatched.stdout.includes('fixture-secret'), false); assert.equal(mismatched.stderr.includes('fixture-secret'), false);
  const invalid = await cli(['run', '--service=aliexpress-partner', '--operation=search', '--credentials-stdin=secret']);
  assert.equal(JSON.parse(invalid.stderr).code, 'ARGUMENT_INVALID');
});

test('CLI rejects unknown services and ambiguous selectors before any service action', async () => {
  const unknown = await cli(['describe', '--service=not-a-connected-service']);
  assert.equal(JSON.parse(unknown.stderr).code, 'SERVICE_NOT_CONNECTED');
  for (const args of [['verify'], ['verify', '--all', '--service=ably'], ['describe', '--service=ably', '--profile=missing.json']]) {
    const result = await cli(args); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'ARGUMENT_INVALID');
  }
});

test('MCP service binding lists real actions and reports provider failure via the same registry', async () => {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aliexpress-partner__search', arguments: { query: { query: 'shirt', limit: 1 } } } },
  ];
  const result = await cli(['mcp', '--service=aliexpress-partner'], `${messages.map(value => JSON.stringify(value)).join('\n')}\n`);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.find(line => line.id === 2).result.tools.some(tool => tool.name === 'aliexpress-partner__search'));
  assert.equal(lines.find(line => line.id === 3).result.isError, true);
  assert.equal(JSON.parse(lines.find(line => line.id === 3).result.content[0].text).code, 'PROVIDER_MISSING');
});
