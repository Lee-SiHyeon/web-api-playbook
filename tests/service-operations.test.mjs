import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServiceRegistry, listServiceOperations, validateServiceDefinitions } from '../lib/service-operations/index.mjs';
import { verifyServiceOperations } from '../lib/service-operations/verify.mjs';

function definition(id = 'demo', { execute = async () => ({ data: { items: [{ id: 'one' }] }, receipt: { networkUsed: true } }),
  kind = 'live_read', close = async () => {}, onBind = () => {} } = {}) {
  return { id, title: id, aliases: [`${id}-alias`], checklistIds: [id],
    profile: { schemaVersion: 2, serviceId: id, allowedOrigins: [], operations: {
      search: { adapter: `${id}.search`, semantics: 'read', evidence: 'synthetic fixture', inputs: { query: { q: { type: 'string', default: 'test' } } } },
    } }, verificationChecks: [{ operation: 'search', input: { query: { q: 'test' } }, kind }],
    createAdapters(options) { onBind(options); return { adapters: { [`id_unused`]: () => {}, [`${id}.search`]: execute }, close }; },
  };
}

test('service metadata can be described without binding clients, providers or network', async () => {
  let bound = 0;
  const definitions = [definition('demo', { onBind: () => bound++ })];
  const registry = await createServiceRegistry('demo-alias', { definitions, bind: false });
  assert.equal(registry.profile.serviceId, 'demo');
  assert.equal(registry.tools()[0].name, 'demo__search');
  assert.equal(bound, 0);
  await registry.close();
});

test('service aliases execute the same real binding and clients close exactly once', async () => {
  let calls = 0, closes = 0, options;
  const definitions = [definition('demo', { execute: async input => { calls++; return { data: input.query }; }, close: async () => closes++, onBind: value => { options = value; } })];
  const registry = await createServiceRegistry('demo-alias', { definitions, sessionName: 'existing-provider' });
  assert.equal(options.sessionName, 'existing-provider');
  assert.deepEqual((await registry.execute('search')).data, { q: 'test' });
  await registry.callTool('demo__search', { query: { q: 'next' } });
  await registry.close(); await registry.close();
  assert.equal(calls, 2); assert.equal(closes, 1);
  assert.throws(() => registry.execute('search'), /SERVICE_REGISTRY_CLOSED/);
});

test('invalid, colliding and non-read adapters fail before execution', async () => {
  assert.throws(() => validateServiceDefinitions([definition(), definition()]), /SERVICE_NAME_COLLISION/);
  const write = definition(); write.profile.operations.search.semantics = 'write';
  assert.throws(() => validateServiceDefinitions([write]), /SERVICE_READ_ADAPTER_REQUIRED/);
  await assert.rejects(createServiceRegistry('missing', { definitions: [definition()] }), /SERVICE_NOT_CONNECTED/);
  const missing = definition(); missing.createAdapters = () => ({ adapters: {} });
  await assert.rejects(createServiceRegistry('demo', { definitions: [missing] }), /SERVICE_ADAPTER_BINDING_INCOMPLETE/);
});

test('whole inventory shows unconnected checklists without advertising fictitious operations', async t => {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(path.join(parent, 'service-inventory-'));
  t.after(async () => { const target = await realpath(directory); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('service-inventory-')); await rm(target, { recursive: true, force: true }); });
  for (const id of ['demo', 'unsupported']) await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ service: id, capabilities: [{ implementation: { files: [] } }] }));
  const result = await listServiceOperations({ definitions: [definition()], checklistDirectory: directory });
  assert.equal(result.networkUsed, false);
  assert.equal(result.summary.connectedServices, 1);
  assert.equal(result.summary.unconnectedChecklistScopes, 1);
  assert.deepEqual(result.services.find(service => service.id === 'unsupported').operations, []);
  assert.equal(result.services.find(service => service.id === 'unsupported').connection, 'not_connected');
});

test('verification distinguishes network reads, local checks, missing providers and absent checks', async () => {
  const absent = definition('no-checks'); absent.verificationChecks = [];
  const definitions = [definition('live'), definition('local', { kind: 'local', execute: async () => ({ data: [], receipt: { networkUsed: false } }) }),
    definition('protected', { execute: async () => { throw Object.assign(new Error('never expose provider contents'), { code: 'PROVIDER_MISSING' }); } }), absent];
  const result = await verifyServiceOperations({ definitions });
  assert.equal(result.summary.liveReadChecksPassed, 1);
  assert.equal(result.results[0].observations[0].data.counts.items, 1);
  assert.match(result.results[0].observations[0].data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.results[1].checks[0].liveReadVerified, false);
  assert.equal(result.results[2].checks[0].code, 'PROVIDER_MISSING');
  assert.equal(result.results[3].verdict, 'no_checks');
  assert.equal(result.summary.notFullyVerified, 2);
  assert.equal(JSON.stringify(result).includes('never expose'), false);
});

test('successful adapter output without current network proof does not become live evidence', async () => {
  const result = await verifyServiceOperations({ definitions: [definition('unknown', { execute: async () => ({ data: {} }) })] });
  assert.equal(result.results[0].verdict, 'ok');
  assert.equal(result.results[0].checks[0].liveReadVerified, false);
  assert.equal(result.summary.liveReadChecksPassed, 0);
});

test('duplicate action checks keep their individual network evidence scopes', async () => {
  let call = 0;
  const service = definition('mixed', { execute: async () => ({ data: {}, receipt: { networkUsed: ++call === 1 } }) });
  service.verificationChecks.push({ operation: 'search', kind: 'live_read' });
  const result = await verifyServiceOperations({ definitions: [service] });
  assert.deepEqual(result.results[0].checks.map(check => check.liveReadVerified), [true, false]);
});

test('403/429 share a failure boundary rather than retrying later checks', async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const service = definition('limited', { execute: async () => { calls++; throw Object.assign(new Error('status'), { code: status === 429 ? 'RATE_LIMITED' : 'ACCESS_DENIED', status }); } });
    service.verificationChecks.push({ operation: 'search', kind: 'live_read' });
    const result = await verifyServiceOperations({ definitions: [service] });
    assert.equal(calls, 1); assert.equal(result.summary.liveReadChecksPassed, 0);
  }
});

test('verification deadlines bound ignoring adapters and still close their clients', async () => {
  let closes = 0;
  const service = definition('stalled', { execute: async () => new Promise(() => {}), close: async () => closes++ });
  // Keep the event loop alive independently of AbortSignal.timeout's unref timer.
  const alive = setInterval(() => {}, 1000);
  try {
    const result = await verifyServiceOperations({ definitions: [service], timeoutMs: 10 });
    assert.equal(result.results[0].checks[0].code, 'ABORTED'); assert.equal(closes, 1);
  } finally { clearInterval(alive); }
});
