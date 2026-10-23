import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NaverTravelClient, summarizeFlightPriceGraph } from '../adapters/naver-travel.mjs';

// Live capture 2026-10-16 17:4x KST: ICN-SPN 10/26~10/30, adult 1, Y, 카드요금 on. The flight.naver.com page showed
// 최저 211,800 / 최고 320,200 / 평균 258,987 and "최근 2주 평균보다 16% 낮습니다".
const FIXTURE = readFileSync(new URL('./fixtures/flight-price-graph.icn-spn-20261026-20261030.json', import.meta.url), 'utf8');

function client(body = FIXTURE, seen = []) {
  return new NaverTravelClient({ fetchImpl: async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }); } });
}

test('price graph: request mirrors the site (searchKey, lowercase location types, card fares on)', async () => {
  const seen = [];
  const r = await client(FIXTURE, seen).flightPriceGraph({ itinerary: [
    { departureDate: '2026-10-26', origin: 'ICN', destination: 'SPN' }, { departureDate: '20261030', origin: 'SPN', destination: 'ICN' }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://flight-api.naver.com/graphql');
  assert.match(seen[0].body.query, /^query GET_PRICE_GRAPH\(/);
  assert.deepEqual(seen[0].body.variables, { searchKey: 'Y20261026ICNSPN20261030SPNICN', includeEventFare: true, nonstop: false, period: 60,
    departureLocationType: 'airport', arrivalLocationType: 'airport' });
  assert.equal(r.scope, 'naver_flight_price_graph');
  assert.equal(r.series.length, 60);
  assert.equal(r.series.filter(s => s.lowestFareKrw === null).length, 1);
  assert.equal(r.averageLowestFare2w, 272779);
  assert.equal(r.vs2WeekAvg, null);
});

test('price graph: summary with the current fare matches the page numbers', async () => {
  const r = await client().flightPriceGraph({ itinerary: [{ departureDate: '20261026', origin: 'ICN', destination: 'SPN' }, { departureDate: '20261030', origin: 'SPN', destination: 'ICN' }], currentMinFare: 230420 });
  assert.deepEqual(r.summary, { minFareKrw: 211800, maxFareKrw: 320200, averageFareKrw: 258987, points: 60, includesCurrent: true });
  assert.deepEqual(r.vs2WeekAvg, { currentMinFareKrw: 230420, pct: 16, direction: 'lower' });
});

test('price graph: within 2% of the 2-week average is "similar", above is "higher"', () => {
  const g = { averageLowestFare: 100000, fares: [{ lowestFare: 100000, searchDate: '2026-10-15' }] };
  assert.equal(summarizeFlightPriceGraph(g, { currentMinFare: 101900 }).vs2WeekAvg.direction, 'similar');
  assert.deepEqual(summarizeFlightPriceGraph(g, { currentMinFare: 108000 }).vs2WeekAvg, { currentMinFareKrw: 108000, pct: 8, direction: 'higher' });
  assert.equal(summarizeFlightPriceGraph(null).available, false);
});

test('price graph: schema drift, GraphQL errors and bad input fail closed', async () => {
  await assert.rejects(client(JSON.stringify({ data: { priceGraph: { fares: 'x' } } })).flightPriceGraph({ itinerary: [{ departureDate: '20261026', origin: 'ICN', destination: 'SPN' }] }), e => e.code === 'SCHEMA_CHANGED');
  await assert.rejects(client(JSON.stringify({ errors: [{ message: 'Invalid input value.' }] })).flightPriceGraph({ itinerary: [{ departureDate: '20261026', origin: 'ICN', destination: 'SPN' }] }), e => e.code === 'GRAPHQL_ERROR');
  await assert.rejects(client().flightPriceGraph({ itinerary: [{ departureDate: '20261026', origin: 'icn', destination: 'SPN' }] }), e => e.code === 'INPUT');
  await assert.rejects(client().flightPriceGraph({ itinerary: [{ departureDate: '20261026', origin: 'ICN', destination: 'SPN' }], departureLocationType: 'AIRPORT' }), e => e.code === 'INPUT');
});

test('hotel price trend: HotelDailyMinPrices series, summary and the page ratio', async () => {
  const seen = [];
  const body = JSON.stringify({ data: { hotelDailyMinPrices: [
    { checkIn: '2026-10-26', price: 200000, roomName: '스탠다드', logDate: '2026-10-01' },
    { checkIn: '2026-10-26', price: 220000, roomName: '스탠다드', logDate: '2026-10-02' },
    { checkIn: '2026-10-26', price: 240000, roomName: '디럭스', logDate: '2026-10-03' }] } });
  const c = new NaverTravelClient({ fetchImpl: async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const r = await c.hotelPriceTrend({ hotelId: '11583218', checkIn: '2026-10-26', currentNightlyPrice: 198000 });
  assert.equal(seen[0].url, 'https://hermes-hotel-svc-api.naver.com/graphql');
  assert.deepEqual(seen[0].body.variables, { hotelId: '11583218', checkIn: '2026-10-26' });
  assert.deepEqual(r.summary, { minNightlyKrw: 200000, maxNightlyKrw: 240000, averageNightlyKrw: 220000, points: 3 });
  assert.deepEqual(r.vsAverage, { currentNightlyKrw: 198000, ratioPct: -10 });
  await assert.rejects(c.hotelPriceTrend({ hotelId: '11583218', checkIn: '20261026' }), e => e.code === 'INPUT');
});
