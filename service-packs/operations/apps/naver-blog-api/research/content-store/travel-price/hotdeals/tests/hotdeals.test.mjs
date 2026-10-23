import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTravelEvent } from '../parsers/naver-travel-event.mjs';
import { parseSearchStays, parseStayDetail, buildSearchStaysRequest } from '../parsers/mrt-hotels.mjs';
import { parsePkgtourProducts, buildRequest } from '../parsers/naver-pkgtour-imminent.mjs';
import { parseTripDeals } from '../parsers/trip-kr-deals.mjs';
import { parseYeogiHome } from '../parsers/yeogi-home-deals.mjs';
import { parseWonRange, discountPct, toKst, nightsBetween } from '../parsers/lib.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const readJson = (f) => JSON.parse(read(f));

test('lib: price/range/kst helpers', () => {
  assert.deepEqual(parseWonRange('726,000원 → 308,000원~'), { original: 726000, sale: 308000, from: true });
  assert.deepEqual(parseWonRange('1,234,050원~'), { original: null, sale: 1234050, from: true });
  assert.equal(discountPct(726000, 308000), 58);
  assert.equal(discountPct(null, 1), null);
  assert.equal(toKst('2026-10-05T14:59:59.000Z'), '2026-10-05 23:59:59');
  assert.equal(nightsBetween('2026-11-20', '2026-11-23'), 3);
  assert.equal(nightsBetween('2026-11-23', '2026-11-20'), null);
});

test('naver travel-event: exclusive hotel + flicking hotel/package', () => {
  const r = parseTravelEvent(read('naver-travel-event.html'));
  assert.equal(r.sectionCount, 3);
  assert.equal(r.items.length, 8);
  const ex = r.items[0];
  assert.equal(ex.sectionType, 'exclusive');
  assert.equal(ex.name, '시그니엘 부산');
  assert.equal(ex.originalPrice, 1210000);
  assert.equal(ex.salePrice, 310500);
  assert.equal(ex.discountPct, 74);
  assert.equal(ex.endsAtKst, '2026-10-05 23:59:59');
  assert.deepEqual(ex.hotel, { hcd: '842054', checkin: '2026-12-03', checkout: '2026-12-04', adult: 2, eventCd: '20260929_HD1' });
  const hotel = r.items.find((i) => i.name === '웨스틴 조선 부산');
  assert.equal(hotel.discountPct, 58);
  assert.equal(hotel.endsAtKst, '2026-10-06 10:00:00');
  const pkg = r.items.find((i) => i.kind === 'package');
  assert.equal(pkg.package.seller, 'modetour');
  assert.equal(pkg.salePrice, 1234050);
  assert.equal(pkg.originalPrice, null);
  assert.ok(r.items.every((i) => i.endsAtUtc && i.landingUrl));
});

test('mrt hotels: searchStays request + dated per-night rows', () => {
  const req = buildSearchStaysRequest({ keyword: '서울', checkIn: '2026-11-20', checkOut: '2026-11-21', isDomestic: true });
  assert.equal(req.params.name, 'searchStays');
  assert.equal(req.params.arguments.adultCount, 2);
  const rows = parseSearchStays(readJson('mrt-mcp-searchStays-seoul.json'), { checkIn: '2026-11-20', checkOut: '2026-11-21', keyword: '서울' });
  assert.equal(rows.length, 5);
  const a = rows[0];
  assert.equal(a.gid, 2680384);
  assert.equal(a.pricePerNight, 406080);
  assert.equal(a.pricePerNightTaxIncluded, 446688);
  assert.equal(a.totalPriceComputed, 446688);
  assert.equal(a.nights, 1);
  assert.equal(a.starRating, 5);
  assert.equal(a.rating, 4.6);
  assert.equal(a.reviewCount, 922);
  assert.equal(a.freeCancel, true);
  assert.equal(a.productUrl, 'https://accommodation.myrealtrip.com/union/products/2680384?checkIn=2026-11-20&checkOut=2026-11-21');
  assert.equal(a.originalPrice, null);
  const noRate = rows.filter((r) => !r.hasRate);
  assert.ok(noRate.length >= 1, 'null price rows are flagged, not priced');
  assert.equal(noRate[0].pricePerNight, null);
});

test('mrt hotels: detail pricing and rooms', () => {
  const d = parseStayDetail(readJson('mrt-mcp-getStayDetail.json'));
  assert.equal(d.gid, 2680937);
  assert.equal(d.pricePerNight, 344850);
  assert.equal(d.totalPrice, 379335);
  assert.equal(d.originalPrice, null);
  assert.equal(d.discountPct, null);
  assert.equal(d.rooms.length, 2);
  assert.equal(d.rooms[0].freeCancel, true);
});

test('naver pkgtour graphql: imminent departures', () => {
  const rq = buildRequest('thisWeek');
  assert.equal(rq.operationName, 'GET_DEPARTURE_THIS_WEEK');
  const rows = parsePkgtourProducts(read('naver-pkgtour-departure-this-week.json'));
  assert.equal(rows.length, 8);
  assert.equal(rows[0].seller, 'ybtour');
  assert.equal(rows[0].pricePerPerson, 1163903);
  assert.equal(rows[0].endsAtKst, '2026-10-10 08:35:00');
  assert.equal(rows[0].pointAccrualPct, 4);
  assert.equal(rows[0].productUrl, 'https://pkgtour.naver.com/products/ybtour/CIP1010OZ00-20261010');
  assert.throws(() => parsePkgtourProducts({ errors: [{ message: 'x' }] }), /GraphQL error/);
});

test('trip.com kr deals: campaign end times (UTC+8 wall clock -> KST)', () => {
  const rows = parseTripDeals(read('trip-kr-deals.html'));
  assert.equal(rows.length, 14);
  assert.equal(rows[0].title, '제주항공 앵콜 라이브');
  assert.equal(rows[0].endsAtRaw, '2026-10-05 22:59:59');
  assert.equal(rows[0].endsAtKst, '2026-10-05 23:59:59');
  assert.equal(rows[0].kind, 'flight');
  assert.ok(rows.every((r) => r.landingUrl && r.endsAtKst));
});

test('yeogi home: banners with end dates and dated stay cards', () => {
  const r = parseYeogiHome(read('yeogi-home.html'));
  assert.equal(r.banners.length, 25);
  const hot = r.banners.find((b) => b.title === '10월 더블쿠폰 핫세일');
  assert.equal(hot.endsAt, '2026-10-10T23:59:59');
  assert.equal(hot.landingUrl, 'https://event.yeogi.com/pages/3628/index.html?aevno=3628');
  assert.ok(r.banners.some((b) => b.open));
  assert.equal(r.checkIn, '2026-10-05');
  assert.ok(r.stays.length >= 3);
  const s = r.stays.find((x) => x.id === 48951);
  assert.equal(s.originalPrice, 165000);
  assert.equal(s.pricePerNight, 153450);
  assert.equal(s.discountRate, '7%');
});
