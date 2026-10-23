import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/overseas-retail.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });

test('status retains AliExpress, Temu, SHEIN and iHerb scope without network', () => {
  const result = run(['status']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.networkUsed, false);
  assert.deepEqual(Object.keys(body.supported), ['aliexpress', 'iherb', 'shein', 'temu']);
  assert.equal(body.services.find(row => row.service === 'aliexpress').currentRun.directHttpCalls, 0);
});

test('unsupported shopping operations and unsafe continuation inputs fail before network', () => {
  const unsupported = run(['temu', 'search']);
  assert.equal(unsupported.status, 2);
  assert.equal(JSON.parse(unsupported.stdout).networkUsed, false);
  for (const args of [
    ['iherb', 'sitemap-products', '--offset=100'],
    ['aliexpress', 'sitemap-products', '--shard-index=-1'],
    ['shein', 'home', '--url=https://other.test/'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).code, /ARGUMENT_INVALID|SNAPSHOT_REQUIRED_FOR_RESUME/);
  }
});
