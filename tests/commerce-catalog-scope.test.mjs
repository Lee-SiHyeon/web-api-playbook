import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogScopeAudit } from '../lib/commerce/catalog-checklist-scope.mjs';

test('catalog scope excludes link creation without marking it complete or excluding missing reviews', () => {
  const audit = { service: 'example', capabilities: [
    { id: 'catalog.search', priority: 'required', gatePassed: true, status: 'recorded_live' },
    { id: 'reviews.items', priority: 'required', gatePassed: false, status: 'unimplemented' },
    { id: 'affiliate.link_generation', priority: 'required', gatePassed: false, status: 'blocked' },
    { id: 'auth.login', priority: 'required', gatePassed: false, status: 'unimplemented' },
  ], summary: { requiredGaps: ['reviews.items', 'affiliate.link_generation', 'auth.login'], strictPassed: false } };
  const scoped = catalogScopeAudit(audit);
  assert.deepEqual(scoped.summary.requiredGaps, ['reviews.items']); assert.equal(scoped.summary.strictPassed, false);
  assert.deepEqual(scoped.excludedFromScope, ['affiliate.link_generation', 'auth.login']);
  assert.equal(audit.capabilities[2].status, 'blocked'); assert.equal(audit.capabilities.length, 4);
});

test('affiliated offer reads remain in the read scope while registrations and payouts remain separate', () => {
  const scoped = catalogScopeAudit({ capabilities: [
    { id: 'affiliate.catalog_search', priority: 'required', gatePassed: false, status: 'blocked' },
    { id: 'affiliate.product_lookup', priority: 'required', gatePassed: false, status: 'pending_live' },
    { id: 'account.profile_payout', priority: 'required', gatePassed: false, status: 'unimplemented' },
  ], summary: {} });
  assert.deepEqual(scoped.summary.requiredGaps, ['affiliate.catalog_search', 'affiliate.product_lookup']);
  assert.equal(scoped.summary.strictPassed, false);
});

test('store-prefixed detail/review capabilities remain in scope', () => {
  const scoped = catalogScopeAudit({ capabilities: [
    { id: 'colourpop.catalog.reviews', priority: 'required', gatePassed: false, status: 'pending_live' },
    { id: 'allbirds.catalog.product_detail', priority: 'required', gatePassed: true, status: 'recorded_live' },
    { id: 'listing.description', priority: 'required', gatePassed: false, status: 'unimplemented' },
  ], summary: {} });
  assert.deepEqual(scoped.summary.requiredGaps, ['colourpop.catalog.reviews', 'listing.description']); assert.equal(scoped.summary.recordedLive, 1);
});
