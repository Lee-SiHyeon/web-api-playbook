import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkHotdeals } from '../../naver-blog-api/research/content-store/travel-price/hotdeals/hotdeal-check.mjs';
import { parseTtangAirfares, fetchPlatformDeals } from '../../naver-blog-api/research/content-store/travel-deals-platforms.mjs';
import { mapTravelRows, mapTravelSnapshot, load, getDiagnostics } from '../scripts/hub-ontology/travel.mjs';
import { validateHubItem } from '../scripts/hub-ontology/contract.mjs';
import { publicFetch } from '../scripts/hub-ontology/travel-ranking-data.mjs';

const now = new Date('2026-10-11T03:00:00Z');
const validate = items => { assert.ok(items.length); for (const item of items) assert.deepEqual(validateHubItem(item), [], item.id); };
const hotdealFixture = readFileSync(new URL('../../naver-blog-api/research/content-store/travel-price/hotdeals/fixtures/naver-travel-event.html', import.meta.url), 'utf8');

test('existing travel-hotdeal fixture maps current packages without issuing links', async () => {
  let issueCalls = 0;
  const data = await checkHotdeals({ now, limit: 200, fetchImpl: async () => new Response(hotdealFixture), issue: async () => { issueCalls++; return { links: {}, failed: [] }; } });
  const items = mapTravelSnapshot(data, { now });
  validate(items);
  assert.equal(items.length, data.rows.length);
  assert.equal(issueCalls, 1);
  assert.ok(items.every(i => i.source === 'naver_travel' && i.affiliateUrl === null && i.kind === 'travel'));
  assert.ok(items.every(i => data.rows.some(r => r.landingUrl === i.sourceUrl)));
  assert.ok(items.every(i => i.summary.includes('표시 시작가')));
});

test('existing airfare parser retains base-fare scope and future departure', () => {
  const html = '<table><tr><td>인천</td><td>오사카</td><td>티웨이</td><td>직항</td><td>2026.10.24~2026.10.27</td><td>왕복</td><td class="price">150,000원</td><td data-adtFare="150000" data-arrCity="KIX" data-depCity="ICN" data-airlineCode="TW" data-gubun="VV"></td></tr></table>';
  const parsed = parseTtangAirfares(html, now);
  const items = mapTravelRows(parsed.items, { now, checkedAt: now.toISOString() });
  validate(items);
  assert.equal(items[0].store, '땡처리닷컴');
  assert.equal(items[0].priceKrw, 150000);
  assert.match(items[0].summary, /기본운임/);
  assert.equal(items[0].sourceUrl, parsed.items[0].url);
  assert.equal(items[0].expiresAt, '2026-10-23T15:00:00.000Z');
});

test('MyRealTrip public collector mapping uses only observed promotion/product URLs', async () => {
  const productUrl = 'https://experiences.myrealtrip.com/products/3417849';
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['main', 'contents'], state: { data: { rankProduct: { list: [{ products: [{ title: '시드니 투어', productUrl, tags: ['특가'], discountText: '50,000원' }] }] } } } }] } } } })}</script>`;
  const data = await fetchPlatformDeals(20, { now, sites: ['myrealtrip'], fetchImpl: async () => new Response(html) });
  const items = mapTravelSnapshot(data, { now, checkedAt: now.toISOString(), links: { [productUrl]: 'https://myrealt.rip/alreadyIssued' } });
  validate(items);
  assert.equal(items[0].sourceUrl, productUrl);
  assert.equal(items[0].source, 'myrealtrip');
  assert.equal(items[0].affiliateUrl, 'https://myrealt.rip/alreadyIssued');
});

test('verified flight fixture keeps collector URL and expires on departure', () => {
  const row = { route: '인천→오사카', deal: true, checkedAt: now.toISOString(), priceScope: 'calendar_min_fare_per_adult', cheapest: [{ departureDate: '20261024', returnDate: '20261027' }],
    verified: { ok: true, price: 190000, airline: '티웨이', nonstop: true, link: 'https://flight.naver.com/flights/international/ICN-KIX-20261024/KIX-ICN-20261027?adult=1' } };
  const items = mapTravelRows([row], { now });
  validate(items);
  assert.equal(items[0].priceKrw, 190000);
  assert.equal(items[0].sourceUrl, row.verified.link);
  assert.equal(items[0].affiliateUrl, null);
  assert.match(items[0].summary, /직항/);
  assert.equal(mapTravelRows([{ ...row, verified: { ...row.verified, ok: false } }], { now }).length, 0);
});

test('mixed Connect snapshots exclude shopping and retain discounted price, provider and departure variants', () => {
  const good = { channel: 'travel', productId: '1_AAA', name: '하노이 패키지', storeName: '참좋은여행', url: 'https://pkgtour.naver.com/products/verygoodtour/AAA-20261103',
    discountedPrice: 474050, salePrice: 499000, shortUrl: 'https://naver.me/issuedPreviously', detail: { startDate: '2026-11-03', duration: '3박 5일' } };
  const data = { checkedAt: now.toISOString(), products: [good, { ...good, channel: 'shopping', productId: 'shopping', name: '노트북', url: 'https://smartstore.naver.com/store/products/123' },
    { ...good, url: 'https://pkgtour.naver.com/products/verygoodtour/AAA-20261109', detail: { startDate: '2026-11-09' } }] };
  const items = mapTravelSnapshot(data, { now });
  validate(items);
  assert.equal(items.length, 2);
  assert.equal(items[0].priceKrw, 474050);
  assert.equal(items[0].store, '참좋은여행');
  assert.equal(items[0].affiliateUrl, good.shortUrl);
  assert.equal(items[0].expiresAt, '2026-11-02T15:00:00.000Z');
  assert.notEqual(items[0].id, items[1].id);
});

test('travel excludes expired, departed, stale, sold-out and missing-URL rows; dedupes and caps', () => {
  const good = { productId: 'a', title: '여행 특가', url: 'https://experiences.myrealtrip.com/products/1', checkedAt: now.toISOString(), priceKrw: 0, tags: Array(20).fill('x'.repeat(40)) };
  const bad = [{ ...good, endsAtUtc: now.toISOString() }, { ...good, startDate: '2026-10-10' }, { ...good, checkedAt: '2026-10-01T00:00:00Z' }, { ...good, soldOut: true }, { ...good, url: null }, { ...good, url: 'http://example.com/item' }];
  assert.deepEqual(mapTravelRows(bad, { now }), []);
  const items = mapTravelRows([good, good, ...Array.from({ length: 230 }, (_, i) => ({ ...good, productId: 'item ' + i, url: `https://experiences.myrealtrip.com/products/${i + 2}` }))], { now });
  validate(items);
  assert.equal(items.length, 200);
  assert.equal(new Set(items.map(i => i.id)).size, 200);
  assert.equal(items[0].priceKrw, 0);
});

test('load with fixture readers returns valid current rows without remote mutations', async () => {
  const methods = [];
  const items = await load({ now, roots: [], catalog: false, fetchImpl: async (url, init) => {
    methods.push(init.method ?? 'GET');
    return String(url) === 'https://travel-event.naver.com/' ? new Response(hotdealFixture) : new Response('', { status: 403 });
  } });
  validate(items);
  assert.ok(methods.every(m => m === 'GET'));
  assert.ok(getDiagnostics().sources.some(r => r.endpoint === 'https://travel-event.naver.com/'));
});

test('public transport refuses authentication and mutations before fetching', async () => {
  let calls = 0;
  const read = publicFetch(async () => { calls++; return new Response('{}'); });
  for (const [url, init] of [['https://example.com/', { method: 'POST' }], ['https://example.com/', { headers: { cookie: 'forbidden' } }], ['https://example.com/', { headers: { authorization: 'forbidden' } }],
    ['https://flight-api.naver.com/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation write { x }' }) }],
    ['https://flight-api.naver.com/graphql', { method: 'POST', body: JSON.stringify({ query: 'query minPricesByDate { x }' }) }]]) await assert.rejects(read(url, init), { code: 'PUBLIC_READ_ONLY' });
  assert.equal(calls, 0);
});
