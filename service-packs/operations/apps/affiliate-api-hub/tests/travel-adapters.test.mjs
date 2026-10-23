import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTravelRegistry } from '../scripts/validate-travel-adapters.mjs';

const registry = JSON.parse(
  await readFile(new URL('../references/travel-adapters.json', import.meta.url), 'utf8'),
);

test('travel adapter registry satisfies common adapter contracts', () => {
  assert.equal(validateTravelRegistry(registry), true);
  assert.ok(registry.adapters.length >= 12);
});

test('travel content coverage includes monetization and evidence-only paths', () => {
  const roles = new Set(registry.adapters.flatMap(adapter => adapter.roles));
  for (const role of ['monetization', 'inventory', 'attribution', 'enrichment', 'evidence', 'reservation_watch']) {
    assert.ok(roles.has(role), `missing role: ${role}`);
  }
  const capabilities = new Set(registry.adapters.flatMap(adapter => adapter.capabilities));
  for (const capability of [
    'lodging.search',
    'flights.search.live',
    'activities.search',
    'esim.catalog',
    'currency.rates',
    'official_reservation.watch',
  ]) {
    assert.ok(capabilities.has(capability), `missing capability: ${capability}`);
  }
});

test('high-stakes insurance remains blocked behind manual review', () => {
  const insurance = registry.adapters.find(adapter => adapter.id === 'travel-insurance-affiliate');
  assert.equal(insurance.accessState, 'manual_review');
  assert.ok(insurance.riskFlags.includes('high_stakes_financial_content'));
  assert.notEqual(insurance.verification, 'live_write_verified');
});

test('design-only watch adapters do not claim live verification', () => {
  const watches = registry.adapters.filter(adapter => adapter.verification === 'design_only');
  assert.ok(watches.length >= 2);
  assert.ok(watches.every(adapter => adapter.roles.includes('reservation_watch')));
});
