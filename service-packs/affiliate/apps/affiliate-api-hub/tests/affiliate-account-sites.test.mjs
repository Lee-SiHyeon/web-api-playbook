import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const registry = JSON.parse(
  await readFile(new URL('../references/affiliate-account-sites.json', import.meta.url), 'utf8'),
);

test('affiliate account site registry has unique official HTTPS sites', () => {
  assert.equal(registry.schemaVersion, 1);
  assert.ok(registry.sites.length >= 9);
  const ids = new Set();
  for (const site of registry.sites) {
    assert.equal(ids.has(site.id), false, `duplicate site id: ${site.id}`);
    ids.add(site.id);
    assert.ok(Object.values(site.officialUrls).every(url => /^https:\/\//.test(url)));
    assert.ok(Array.isArray(site.operatorActions) && site.operatorActions.length > 0);
    assert.equal(site.payoutSetup.verifyInPortal, true);
  }
});

test('P0 onboarding list contains the four domestic operating accounts', () => {
  const p0 = registry.sites
    .filter(site => site.priority === 'P0')
    .map(site => site.id)
    .sort();
  assert.deepEqual(p0, [
    'coupang-partners',
    'linkprice-influencer',
    'myrealtrip-marketing-partner',
    'yeogi-marketing-partner',
  ]);
});

test('registry stores status only and excludes credential material', () => {
  const serialized = JSON.stringify(registry);
  assert.doesNotMatch(serialized, /Bearer\s+[A-Za-z0-9._-]+|NID_AUT|NID_SES/i);
  assert.doesNotMatch(serialized, /\b\d{3,6}-\d{2,6}-\d{3,8}\b/);
  assert.ok(registry.security.neverCommit.includes('password'));
  assert.ok(registry.security.neverCommit.includes('account_number'));
});

test('manual-review and excluded sites explain why they are not onboarding targets', () => {
  assert.ok(registry.excludedOrManualReview.length >= 5);
  for (const site of registry.excludedOrManualReview) {
    assert.match(site.url, /^https:\/\//);
    assert.ok(site.reason.length > 10);
  }
});
