import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { collect, parseNews, validateConfig } from '../research/content-store/collect.mjs';
import { affiliateGate, validateDriveInput, judge } from '../research/content-store/judge.mjs';
import { normalizeAffiliates, verifyCoupangRedirect } from '../research/content-store/bundle.mjs';
import { applyBrowserChecks } from '../research/content-store/apply-browser-checks.mjs';
import { JevSupervisor, jevConfig } from '../workflows/affiliate-content-e2e/jev-supervisor.mjs';

const evalCases = JSON.parse(readFileSync(new URL('../research/evaluations/collector-classifier-regression-v1.json', import.meta.url), 'utf8')).cases;
const config = { schemaVersion: 1, perSourceLimit: 2, sources: [{ id: 'news-ai', field: 'ai', kind: 'google_news_rss', query: 'AI' }] };
test('RSS keeps headline provenance rather than claiming a full article', async () => {
  const xml = '<rss><channel><item><title><![CDATA[A &amp; B]]></title><link>https://news.google.com/a</link><source>Publisher</source></item></channel></rss>';
  assert.equal(parseNews(xml)[0].title, 'A & B');
  const result = await collect(config, { fetchImpl: async () => new Response(xml) });
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].originalArticleFetched, false);
  assert.equal(result.candidates[0].summary, '');
});
test('failed sources stay explicit and cannot become empty successes', async () => {
  const result = await collect(config, { fetchImpl: async () => new Response('Forbidden', { status: 403 }) });
  assert.equal(result.sources[0].status, 'failed'); assert.equal(result.candidates.length, 0);
});
test('source config rejects arbitrary endpoints and duplicate ids', () => {
  assert.throws(() => validateConfig({ ...config, sources: [{ ...config.sources[0], kind: 'arbitrary_url' }] }));
  assert.throws(() => validateConfig({ ...config, sources: [config.sources[0], config.sources[0]] }));
});
test('Drive hash and parent binding fail before inference on modified bytes', () => {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'content_store_bundle', collection: { candidates: [] }, affiliates: [] }));
  const metadata = { id: 'f', parents: ['folder'], mimeType: 'application/json', sha256: createHash('sha256').update(bytes).digest('hex'), connectorReadback: true };
  assert.ok(validateDriveInput(bytes, metadata, 'folder'));
  assert.throws(() => validateDriveInput(Buffer.from('{}'), metadata, 'folder'), /DRIVE_BYTES_MISMATCH/);
  assert.throws(() => validateDriveInput(bytes, metadata, 'other'), /DRIVE_PROVENANCE_REQUIRED/);
});
test('high semantic fit cannot bypass ownership, expiry or landing validation', async () => {
  const now = new Date('2026-09-22T00:00:00Z');
  const product = { provider: 'coupang', field: 'travel', title: '여행 파우치', productId: '123', affiliateUrl: 'https://link.coupang.com/a/test', collectedAt: now.toISOString(), landingVerified: false };
  assert.deepEqual(affiliateGate(product, now), ['ownership_unverified', 'landing_unverified']);
  const supervisor = { evaluate: async ({ questions }) => ({ providerResult: 'ok',
    comparisons: Object.fromEntries(Object.keys(questions).map(k => [k, { eligible: true, confidence: .99, remote: { choice: k.startsWith('pair') ? 'fit' : 'travel' } }])),
    adopted: Object.fromEntries(Object.keys(questions).map(k => [k, { choice: k.startsWith('pair') ? 'fit' : 'travel', source: 'jev_active' }])) }) };
  const report = await judge({ collection: { candidates: [{ id: 't1', field: 'travel', title: '여행 짐싸기', summary: '', urls: [] }] }, affiliates: [product] }, { supervisor, now });
  assert.equal(report.pairs[0].semanticFit, 'fit'); assert.equal(report.pairs[0].selection, 'hold_or_exclude');
  assert.equal(report.pairs[0].publicationReady, false);
});
test('field without collected affiliate products legitimately has no links', async () => {
  const supervisor = { evaluate: async () => ({ providerResult: 'provider_unavailable', comparisons: { item0: { eligible: false, confidence: 0 } } }) };
  const report = await judge({ collection: { candidates: [{ id: 't', field: 'finance', title: '경제', summary: '', urls: [] }] }, affiliates: [] }, { supervisor });
  assert.equal(report.pairs.length, 0);
});

test('cross-field URL dedup retains all fields and shadow suggestions cannot select an affiliate pair', async () => {
  const sample = evalCases.crossFieldDedup;
  const rss = `<rss><channel><item><title>${sample.title}</title><link>${sample.url}</link><source>Publisher</source></item></channel></rss>`;
  const collection = await collect({ schemaVersion: 1, perSourceLimit: 2, sources: sample.sources.map(source => ({ ...source, kind: 'google_news_rss', query: source.field })) }, { fetchImpl: async () => new Response(rss) });
  assert.equal(collection.candidates.length, 1);
  assert.deepEqual(collection.candidates[0].fields, sample.expectedFields);
  assert.deepEqual(collection.candidates[0].sourceIds, sample.expectedSourceIds);
  assert.equal(collection.coverage.ai, 1);
  assert.equal(collection.coverage.travel, 1);

  const supervisor = new JevSupervisor({
    config: jevConfig({}, { mode: 'shadow', provider: 'custom', customEndpoint: 'https://fixture.test', customKey: 'fixture' }),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, {
        type: 'choice', choice: id.startsWith('pair') ? 'fit' : 'travel', confidence: 0.99,
      }]));
      return new Response(JSON.stringify({ answers }), { status: 200 });
    },
  });
  const report = await judge({ collection, affiliates: [{ provider: 'coupang', field: 'travel', title: 'Travel item', productId: '123',
    affiliateUrl: 'https://link.coupang.com/a/test', collectedAt: new Date().toISOString(), landingVerified: false }] }, { supervisor });
  assert.equal(report.topics[0].category, 'unknown');
  assert.equal(report.topics[0].suggestedCategory, 'travel');
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].semanticFit, 'insufficient');
  assert.equal(report.pairs[0].suggestedSemanticFit, 'fit');
  assert.equal(report.pairs[0].selection, 'hold_or_exclude');
});

test('affiliate import projects fields and discards captured secrets and asserted verification', () => {
  const [p] = normalizeAffiliates([{ provider: 'coupang', field: 'travel', title: 'P', productId: '1', itemId: '2', vendorItemId: '3', affiliateUrl: 'https://link.coupang.com/a/abc', collectedAt: new Date().toISOString(), cookie: 'secret', landingVerified: true }]);
  assert.equal(p.cookie, undefined); assert.equal(p.landingVerified, false); assert.equal(p.ownershipEvidence, 'unverified');
});
test('HTTP block is not misreported as a product mismatch', async () => {
  const result = await verifyCoupangRedirect({ affiliateUrl: 'https://link.coupang.com/a/abc' }, { fetchImpl: async () => new Response('', { status: 403 }) });
  assert.equal(result.reason, 'landing_http_blocked'); assert.equal(result.verified, false);
});
test('redirects cannot leave the observed provider hosts', async () => {
  let calls = 0;
  const result = await verifyCoupangRedirect({ affiliateUrl: 'https://link.coupang.com/a/abc' }, { fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }); } });
  assert.equal(calls, 1); assert.equal(result.reason, 'unexpected_redirect_host');
});
test('browser verification must bind exact item and keeps missing vendor blocked', () => {
  const now = new Date();
  const p = { productId: '1', itemId: '2', vendorItemId: '3' };
  const check = { ...p, method: 'browser_public_landing', checkedAt: now.toISOString(), productMatched: true, itemMatched: true, titleMatched: true, attributionPresent: true, vendorObserved: false };
  const result = applyBrowserChecks({ affiliates: [p] }, [check], now);
  assert.equal(result.affiliates[0].landingVerified, true);
  assert.ok(affiliateGate(result.affiliates[0], now).includes('vendor_unverified'));
  assert.equal(applyBrowserChecks({ affiliates: [p] }, [{ ...check, itemId: '999' }], now).affiliates[0].landingVerified, undefined);
});
