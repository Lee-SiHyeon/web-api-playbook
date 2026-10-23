import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMyrealtripReceipt, verifyMyrealtripRedirect, targetIdentity } from '../research/content-store/myrealtrip.mjs';
import { normalizeAffiliates } from '../research/content-store/bundle.mjs';
import { affiliateGate, judge } from '../research/content-store/judge.mjs';
const fingerprint = 'a'.repeat(64);
const target = 'https://accommodation.myrealtrip.com/union/products/123?checkIn=2026-11-03&checkOut=2026-11-05&adultCount=2&childCount=0';
const receipt = { source: 'independent_http', status: 200, ownerVerified: true, accountFingerprint: fingerprint, operation: 'myrealtripCreateLink', checkedAt: '2026-09-21T00:00:00Z', targetUrl: target, data: { id: 456, mylink: 'https://myrealt.rip/abc' } };
const product = { title: 'Hotel', productUrl: target, checkedAt: receipt.checkedAt, description: 'Two nights' };
const row = () => fromMyrealtripReceipt(receipt, product, fingerprint);
test('receipt binds owner and exact product; private capture fields do not leave importer', () => {
  assert.throws(() => fromMyrealtripReceipt(receipt, product, 'b'.repeat(64)), /MRT_OWNER/);
  assert.throws(() => fromMyrealtripReceipt(receipt, { ...product, productUrl: target + '1' }, fingerprint), /BINDING/);
  const imported = row();
  assert.equal(imported.accountFingerprint, undefined);
  assert.equal(normalizeAffiliates([{ ...imported, cookie: 'secret', landingVerified: true }])[0].landingVerified, false);
  assert.equal(normalizeAffiliates([imported])[0].description, 'Two nights');
  assert.throws(() => targetIdentity('https://evil.test/promotions/x'));
});
const redirect = destination => new Response(null, { status: 301, headers: { location: 'https://www.myrealtrip.com/main/bridge/marketing?return_url=' + encodeURIComponent(destination) } });
test('independent redirect validates dates, party and attribution without fetching destination', async () => {
  let calls = 0;
  const ok = await verifyMyrealtripRedirect(row(), { fetchImpl: async (_, options) => { calls++; assert.equal(options.redirect, 'manual'); assert.equal(options.headers['partner-access-token'], undefined); return redirect(target + '&mylink_id=456'); } });
  assert.equal(ok.verified, true); assert.equal(calls, 1);
  const wrong = await verifyMyrealtripRedirect(row(), { fetchImpl: async () => redirect(target.replace('adultCount=2', 'adultCount=3') + '&mylink_id=456') });
  assert.equal(wrong.reason, 'MRT_VARIANT');
  assert.equal((await verifyMyrealtripRedirect(row(), { fetchImpl: async () => redirect(target + '&mylink_id=999') })).reason, 'MRT_ATTRIBUTION');
  assert.ok(affiliateGate({ ...row(), landingVerified: true }, new Date('2026-09-23')).includes('stale_product_observation'));
});
test('all travel products are considered, including fifth provider entry', async () => {
  const supervisor = { evaluate: async ({ questions }) => ({ providerResult: 'ok', comparisons: Object.fromEntries(Object.keys(questions).map(k => [k, { eligible: true, confidence: .99, remote: { choice: k.startsWith('pair') ? 'fit' : 'travel' } }])) }) };
  const report = await judge({ collection: { candidates: [{ id: 't', field: 'travel', title: 'Hotel trip', summary: '', urls: [] }] }, affiliates: Array.from({ length: 5 }, (_, i) => ({ ...row(), productId: String(i) })) }, { supervisor });
  assert.equal(report.pairs.length, 5);
  assert.equal(report.pairs[4].provider, 'myrealtrip');
});
