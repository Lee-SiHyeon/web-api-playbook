import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractGrokSourceUnit, snapshotGrokProofSourceScope, grokProofSourceScopeMatches } from '../src/grok-proof-source-scope.mjs';

const SOURCE = `const boundary = 17;
function helper(a) { return /[{}]/.test(a) ? \`literal { \${a} } \` : '}' }
export class Client {
  #counter = 0;
  async read({ value = { marker: '}' } } = {}) { return helper(value.marker); }
  unrelated() { return 'old'; }
}
export function facade() { return { async settings() { return helper('{}'); } }; }
`;
const registry = { schemaVersion: 1, serviceId: 'grok-web', serviceOrigin: 'https://grok.com',
  allowedOrigins: ['https://grok.com'], identityOperationId: 'auth.owner.read', operations: [
    { id: 'auth.owner.read', method: 'GET', urlTemplate: 'https://grok.com/api/auth/session' },
    { id: 'settings.read', method: 'GET', urlTemplate: 'https://grok.com/rest/user-settings' },
  ] };
const units = [{ file: 'src/client.mjs', selectors: ['boundary', 'helper', 'Client.#counter', 'Client.read', 'facade.settings'] },
  { file: 'scripts/transport.py', selectors: ['__module__'] }];

test('AST source units handle regex, templates, nested parameters and private fields', () => {
  assert.match(extractGrokSourceUnit(SOURCE, 'helper'), /literal/);
  assert.match(extractGrokSourceUnit(SOURCE, 'Client.read'), /value\.marker/);
  assert.equal(extractGrokSourceUnit(SOURCE, 'Client.#counter'), '#counter = 0;');
  assert.match(extractGrokSourceUnit(SOURCE, 'facade.settings'), /helper/);
  assert.throws(() => extractGrokSourceUnit(SOURCE, 'missing'), { code: 'SOURCE_SCOPE_UNIT_MISSING' });
});

test('scope ignores unrelated methods and operations but invalidates auth, handlers and transport changes', async () => {
  const base = path.join(homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'grok-proof-scope-'));
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'scripts'));
  const client = path.join(root, 'src/client.mjs');
  const transport = path.join(root, 'scripts/transport.py');
  try {
    await writeFile(client, SOURCE); await writeFile(transport, 'verified_tls = True\n');
    const snapshot = () => snapshotGrokProofSourceScope({ root, registry, operationIds: ['settings.read'], units });
    const first = await snapshot();
    await writeFile(client, SOURCE.replace("return 'old'", "return 'new unrelated behavior'"));
    registry.operations.push({ id: 'conversation.restore', method: 'POST', urlTemplate: 'https://grok.com/restore' });
    assert.equal(grokProofSourceScopeMatches(first, await snapshot()), true);
    await writeFile(client, SOURCE.replace('boundary = 17', 'boundary = 18'));
    assert.equal(grokProofSourceScopeMatches(first, await snapshot()), false);
    await writeFile(client, SOURCE);
    registry.operations[0].urlTemplate = 'https://grok.com/other-owner';
    assert.equal(grokProofSourceScopeMatches(first, await snapshot()), false);
    registry.operations[0].urlTemplate = 'https://grok.com/api/auth/session';
    await writeFile(transport, 'verified_tls = False\n');
    assert.equal(grokProofSourceScopeMatches(first, await snapshot()), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe descriptors cannot select outside the repo or hide missing units', async () => {
  await assert.rejects(snapshotGrokProofSourceScope({ root: process.cwd(), registry,
    operationIds: ['settings.read'], units: [{ file: '../outside.mjs', selectors: ['__module__'] }] }),
  { code: 'SOURCE_SCOPE_FILE_INVALID' });
});
