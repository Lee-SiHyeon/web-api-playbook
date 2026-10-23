import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { snapshotFeatureSourceScope } from '../src/source-scope.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const operationNames = ['model_list'];

async function copyScopeFiles(scope, targetRoot) {
  for (const item of scope.implementationUnits) {
    const relative = item.path.split('#', 1)[0];
    const target = path.join(targetRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(repo, relative)));
  }
}

test('scoped contract ignores unrelated operations and includes auth and required operations', async (t) => {
  const contract = JSON.parse(await readFile(path.join(repo, 'discovery/observed-contract.json'), 'utf8'));
  const base = await snapshotFeatureSourceScope({ root: repo, contract, featureId: 'model_catalog', operationNames });
  const unrelated = structuredClone(contract);
  unrelated.operations.unrelated_new_reader = { effect: 'read', request: { method: 'GET', path: '/other' } };
  const unrelatedScope = await snapshotFeatureSourceScope({ root: repo, contract: unrelated, featureId: 'model_catalog', operationNames });
  assert.equal(unrelatedScope.contractScopeSha256, base.contractScopeSha256);

  const changedOperation = structuredClone(contract);
  changedOperation.operations.model_list.request.rpcId = 'changed';
  const operationScope = await snapshotFeatureSourceScope({ root: repo, contract: changedOperation, featureId: 'model_catalog', operationNames });
  assert.notEqual(operationScope.contractScopeSha256, base.contractScopeSha256);

  const changedAuth = structuredClone(contract);
  changedAuth.auth.cookieNames.push('new-auth-cookie');
  const authScope = await snapshotFeatureSourceScope({ root: repo, contract: changedAuth, featureId: 'model_catalog', operationNames });
  assert.notEqual(authScope.contractScopeSha256, base.contractScopeSha256);
});

test('scoped implementation follows the selected handler closure, not unrelated CLI branches', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.homedir(), '.nad-scratch/tmp/gemini-source-scope-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const contract = JSON.parse(await readFile(path.join(repo, 'discovery/observed-contract.json'), 'utf8'));
  const base = await snapshotFeatureSourceScope({ root: repo, contract, featureId: 'model_catalog', operationNames });
  await copyScopeFiles(base, tempRoot);
  const baseTemp = await snapshotFeatureSourceScope({ root: tempRoot, contract, featureId: 'model_catalog', operationNames });
  assert.equal(baseTemp.implementationScopeSha256, base.implementationScopeSha256);

  const cliPath = path.join(tempRoot, 'src/cli.mjs');
  const cli = await readFile(cliPath, 'utf8');
  await writeFile(cliPath, `${cli}\nfunction unrelatedCliBranch() { return false; }\n`);
  const unrelated = await snapshotFeatureSourceScope({ root: tempRoot, contract, featureId: 'model_catalog', operationNames });
  assert.equal(unrelated.implementationScopeSha256, base.implementationScopeSha256);

  const clientPath = path.join(tempRoot, 'src/client.mjs');
  const client = await readFile(clientPath, 'utf8');
  const needle = 'async listModels({ expectedOwner } = {}) {\n    return readModels(this, { expectedOwner });\n  }';
  assert.ok(client.includes(needle));
  await writeFile(clientPath, client.replace(needle, needle.replace('return readModels', 'return Promise.resolve(readModels')));
  const changed = await snapshotFeatureSourceScope({ root: tempRoot, contract, featureId: 'model_catalog', operationNames });
  assert.notEqual(changed.implementationScopeSha256, base.implementationScopeSha256);
});
