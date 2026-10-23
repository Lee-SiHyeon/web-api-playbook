import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseBunjangSearch, parseJoongnaSearch, parseHellomarketSearch, parseDaangnSearch, filterListings, quantile,
  medianCoverage, usedPrice, realCost, realCostLine, fetchUsedListings,
} from '../used-price.mjs';

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const listing = (price, extra = {}) => ({ source: 'bunjang', id: String(price), title: '아이폰15 128GB', price, kind: 'asking', status: 'selling', listedAt: '2026-10-05T00:00:00.000Z', ...extra });
const many = (prices, extra) => prices.map((p, i) => listing(p, { id: `${p}-${i}`, ...extra }));

test('parsers read the four captured shapes', () => {
  const b = parseBunjangSearch(fx('bunjang-search.json'));
  assert.ok(b.length >= 20 && b.every(x => x.source === 'bunjang' && x.kind === 'asking' && Number.isSafeInteger(x.price)));
  const j = parseJoongnaSearch(fx('joongna-search.html'));
  assert.equal(j.length, 25); assert.ok(j.every(x => x.status === 'selling' && x.listedAt?.endsWith('Z')));
  const h = parseHellomarketSearch(fx('hellomarket-search.html'));
  assert.equal(h.length, 20); assert.ok(h.some(x => x.conditionRaw));
  const d = parseDaangnSearch(fx('daangn-search.html'));
  assert.equal(d.length, 15); assert.ok(d.every(x => x.price > 0 && x.status === 'selling'));
  assert.throws(() => parseBunjangSearch({ result: 'fail' }), { code: 'BUNJANG_SCHEMA' });
  assert.throws(() => parseJoongnaSearch('<html></html>'), { code: 'JOONGNA_SCHEMA' });
  assert.throws(() => parseHellomarketSearch('<html></html>'), { code: 'HELLOMARKET_SCHEMA' });
  assert.throws(() => parseDaangnSearch('<html></html>'), { code: 'DAANGN_SCHEMA' });
});

test('filterListings drops the multi-model bait seen in the Bunjang capture and sibling models', () => {
  const b = parseBunjangSearch(fx('bunjang-search.json'));
  const { kept, dropped } = filterListings(b, { include: ['아이폰15'] });
  assert.ok(dropped.some(x => x.dropReason === 'multi_model_bait' && x.price === 90000));
  assert.ok(kept.every(x => /아이폰\s*15/.test(x.title)));
  const t = filterListings([listing(500000, { title: '아이폰15 프로맥스 256' }), listing(400000)], { include: ['아이폰15'], exclude: ['프로맥스'] });
  assert.equal(t.kept.length, 1);
  assert.equal(filterListings([listing(1, { title: '아이폰15 삽니다 매입' })], {}).dropped[0].dropReason, 'excluded_signal');
});

test('quantile matches linear interpolation and medianCoverage matches 1-2*0.5^n', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10, 20, 30, 40, 50], 0.25), 20);
  assert.equal(medianCoverage(5), 0.9375);
  assert.equal(medianCoverage(6), 0.96875);
});

test('usedPrice: below 6 samples no number; 6-19 median only; 20+ quartiles; label is 호가', () => {
  const few = usedPrice('아이폰15', many([700, 710, 720, 730, 740].map(x => x * 1000)));
  assert.equal(few.median, null); assert.equal(few.status, 'insufficient_sample'); assert.equal(few.sampleSize, 5);
  const mid = usedPrice('아이폰15', many([680, 690, 700, 710, 720, 730].map(x => x * 1000)));
  assert.equal(mid.status, 'median_only'); assert.equal(mid.median, 705000); assert.equal(mid.p25, null);
  assert.equal(mid.label, '호가'); assert.equal(mid.priceKind, 'asking'); assert.equal(mid.medianCoverage, 0.969);
  const prices = Array.from({ length: 20 }, (_, i) => 600_000 + i * 10_000);
  const full = usedPrice('아이폰15', many(prices));
  assert.equal(full.status, 'ok'); assert.equal(full.sampleSize, 20);
  assert.equal(full.median, 695000); assert.equal(full.p25, 647500); assert.equal(full.p75, 742500);
  assert.deepEqual(full.window, { from: '2026-10-05T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z', collectedAt: full.window.collectedAt });
});

test('usedPrice removes Tukey outliers and labels sold prices only when every sample is sold', () => {
  const prices = [...Array.from({ length: 12 }, (_, i) => 700_000 + i * 5000), 90_000];
  const r = usedPrice('아이폰15', many(prices));
  assert.equal(r.droppedOutliers, 1); assert.equal(r.sampleSize, 12);
  const sold = usedPrice('아이폰15', many(prices, { kind: 'sold', status: 'sold' }));
  assert.equal(sold.priceKind, 'sold'); assert.equal(sold.label, '거래완료가');
  const mixed = usedPrice('x', [...many(prices.slice(0, 6), { kind: 'sold' }), ...many([700000, 701000, 702000], { kind: 'asking' })]);
  assert.equal(mixed.priceKind, 'asking');
});

test('usedPrice maxAgeDays drops stale asks but keeps undated ones', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const rows = [...many([700, 705, 710, 715, 720, 725].map(x => x * 1000), { listedAt: '2026-09-30T00:00:00Z' }),
    ...many([400000, 410000], { listedAt: '2026-01-01T00:00:00Z' }), ...many([702000], { listedAt: null })];
  const r = usedPrice('x', rows, { now, maxAgeDays: 90 });
  assert.equal(r.sampleSize, 7); assert.ok(r.median > 700000);
  assert.equal(usedPrice('x', rows, { now }).sampleSize >= 7, true);
});

test('usedPrice on the real fixtures with a spec reports per-source counts', () => {
  const all = [...parseBunjangSearch(fx('bunjang-search.json')), ...parseJoongnaSearch(fx('joongna-search.html')), ...parseHellomarketSearch(fx('hellomarket-search.html'))];
  const r = usedPrice('아이폰15', all, { spec: { include: ['아이폰15'] } });
  assert.ok(r.sampleSize >= 6 && r.median > 300_000 && r.median < 1_500_000);
  assert.ok(Object.keys(r.sources).length >= 2);
  assert.equal(r.priceKind, 'asking');
});

test('realCost uses p25, haircut and fee; asking basis is flagged; assumptions are returned', () => {
  const used = { median: 700_000, p25: 650_000, p75: 750_000, sampleSize: 40, priceKind: 'asking', status: 'ok', sources: { bunjang: 40 } };
  const r = realCost(1_200_000, used, 12);
  assert.equal(r.resaleValue, Math.round(650_000 * 0.92 * 0.965));
  assert.equal(r.realCost, 1_200_000 - r.resaleValue); assert.equal(r.perMonth, Math.round(r.realCost / 12));
  assert.ok(r.flags.includes('asking_price_basis')); assert.equal(r.assumptions.provenance, 'assumption_uncited');
  const line = realCostLine(r);
  assert.match(line, /12개월/); assert.match(line, /호가/); assert.match(line, /흥정 8%/); assert.match(line, /예측이 아닙니다/);
  assert.equal(realCost(1_200_000, used, 12, { resaleBasis: 'median', negotiationHaircut: 0, sellerFeeRate: 0 }).resaleValue, 700_000);
});

test('realCost refuses when data or inputs do not support a number', () => {
  const ok = { p25: 650_000, median: 700_000, sampleSize: 40, priceKind: 'asking', status: 'ok' };
  assert.equal(realCost(1_200_000, { median: 700_000, p25: null, sampleSize: 8, status: 'median_only', priceKind: 'asking' }, 12).error, 'USED_PRICE_INSUFFICIENT');
  assert.equal(realCost(500_000, ok, 12).error, 'USED_NOT_BELOW_NEW');
  assert.equal(realCost(-1, ok, 12).error, 'NEW_PRICE_INVALID');
  assert.equal(realCost(1_200_000, ok, 0).error, 'MONTHS_INVALID');
  assert.equal(realCost(1_200_000, ok, 12, { sellerFeeRate: 1.2 }).error, 'ASSUMPTION_INVALID');
  assert.equal(realCostLine({ error: 'X' }), null);
});

test('fetchUsedListings skips Daangn by default and records per-source errors', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('bunjang')) return new Response(fx('bunjang-search.json'), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('joongna')) return new Response('', { status: 403 });
    return new Response(fx('hellomarket-search.html'), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const r = await fetchUsedListings('아이폰15', { fetchImpl });
  assert.equal(calls.length, 3); assert.ok(!calls.some(u => u.includes('daangn')));
  assert.equal(r.errors.joongna, 'HTTP_403');
  assert.ok(r.listings.some(l => l.source === 'bunjang') && r.listings.some(l => l.source === 'hellomarket'));
});
