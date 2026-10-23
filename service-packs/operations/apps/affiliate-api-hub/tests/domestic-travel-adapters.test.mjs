import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateDomesticTravelRegistry } from '../scripts/validate-domestic-travel-adapters.mjs';

const registry = JSON.parse(
  await readFile(new URL('../references/domestic-travel-adapters.json', import.meta.url), 'utf8'),
);

test('domestic travel affiliate registry satisfies common and domestic contracts', () => {
  assert.equal(validateDomesticTravelRegistry(registry), true);
  assert.equal(registry.market, 'KR');
  assert.ok(registry.adapters.length >= 8);
});

test('MyRealTrip and Yeogi are the P0 direct publisher programs', () => {
  const p0Direct = registry.adapters
    .filter(adapter => adapter.priority === 'P0' && adapter.programType === 'direct_publisher_affiliate')
    .map(adapter => adapter.id)
    .sort();
  assert.deepEqual(p0Direct, ['myrealtrip-marketing-partner', 'yeogi-marketing-partner']);
  for (const id of p0Direct) {
    const adapter = registry.adapters.find(item => item.id === id);
    assert.ok(adapter.capabilities.includes('links.create') || adapter.capabilities.some(value => value.endsWith('.links')));
    assert.ok(adapter.roles.includes('attribution'));
  }
});

test('supplier and corporate B2B portals cannot masquerade as blog affiliate adapters', () => {
  const excluded = registry.adapters.filter(adapter => adapter.priority === 'EXCLUDE');
  assert.ok(excluded.some(adapter => adapter.id === 'nol-supplier-partner'));
  assert.ok(excluded.some(adapter => adapter.id === 'modetour-b2b'));
  assert.ok(excluded.every(adapter => adapter.accessState === 'excluded'));
  assert.ok(excluded.every(adapter => !adapter.roles.includes('attribution')));
});

test('public bundle observations are metadata-only and contain no credentials', () => {
  const observed = registry.adapters.filter(adapter => adapter.observedPublicBundle);
  assert.ok(observed.length >= 3);
  for (const adapter of observed) {
    assert.equal(adapter.observedPublicBundle.executable, false);
    assert.equal(adapter.observedPublicBundle.credentialValuesCaptured, false);
    assert.doesNotMatch(JSON.stringify(adapter.observedPublicBundle), /Bearer\s+[A-Za-z0-9._-]+|NID_AUT|NID_SES/i);
  }
});

test('inbound Korea programs remain separate from Korean outbound priority', () => {
  for (const id of ['creatrip-affiliate', 'trazy-affiliate']) {
    const adapter = registry.adapters.find(item => item.id === id);
    assert.ok(adapter.verticals.includes('korea_inbound'));
    assert.notEqual(adapter.priority, 'P0');
  }
});
