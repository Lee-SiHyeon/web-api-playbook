import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AgodaHotelClient,
  AGODA_OBSERVED_PROPERTY_IDS,
  AGODA_PUBLIC_ROUTES,
} from '../lib/travel/agoda.mjs';

const fixtures = new URL('./fixtures/agoda/', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
const issuerId = '2b2543f9-e758-4d91-8c52-a326df997841';
const searchId = '9804cc83-f5bb-4aa5-a92b-a459d9381147';
const fixedNow = () => new Date('2026-10-05T00:30:00.000Z');

function bootstrapHtml(userId = issuerId) {
  const bootstrap = { core: { userId, sessionId: '0123456789abcdef01234567' }, unusedPrivateData: 'do-not-retain' };
  return `<!doctype html><html><head><title>Agoda</title></head><body><script>window.agBootstrap = new Promise((resolve) => { resolve(${JSON.stringify(bootstrap)}); });</script></body></html>`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function createClient(fetchImpl, overrides = {}) {
  return new AgodaHotelClient({
    fetchImpl,
    minHostIntervalMs: 0,
    randomUUIDImpl: () => searchId,
    now: fixedNow,
    ...overrides,
  });
}

test('replays the observed property-summary request, keeps only eligible KRW quotes, and does not expose bootstrap IDs', async () => {
  const responseFixture = await readJson('property-summary-vietnam.json');
  const requests = [];
  const client = createClient(async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1
      ? htmlResponse(bootstrapHtml())
      : jsonResponse(responseFixture);
  });

  const { metadata, result } = await client.rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' });
  const first = result.properties.find(property => property.propertyId === 25575116);
  const unavailable = result.properties.find(property => property.propertyId === 78339970);
  const request = JSON.parse(requests[1].options.body);
  const rateHeaders = Object.fromEntries(Object.entries(requests[1].options.headers).map(([key, value]) => [key.toLowerCase(), value]));

  assert.deepEqual(requests.map(item => item.url), [AGODA_PUBLIC_ROUTES.home, AGODA_PUBLIC_ROUTES.propertySummary]);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.credentials, 'omit');
  assert.deepEqual(rateHeaders, {
    'content-type': 'application/json',
    'ag-language-locale': 'ko-kr',
    'ag-page-type-id': '90000',
  });
  for (const { options } of requests) {
    const headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['user-agent'], undefined);
  }
  assert.equal(request.operationName, 'propertySummarySearch');
  assert.deepEqual(request.variables.PropertySummarySearchRequest.propertyIds, AGODA_OBSERVED_PROPERTY_IDS);
  assert.equal(request.variables.PricingSummaryRequest.context.clientInfo.userId, issuerId);
  assert.equal(request.variables.PricingSummaryRequest.context.clientInfo.searchId, searchId);
  assert.equal(request.variables.PricingSummaryRequest.pricing.bookingDate, '2026-10-05T00:30:00.000Z');
  assert.deepEqual(request.variables.PricingSummaryRequest.pricing.occupancy, {
    adults: 2, children: 0, childAges: [], rooms: 1, childrenTypes: [],
  });
  assert.equal(request.variables.ContentSummaryRequest.context.rawUserId, undefined);
  assert.equal(result.returnedPropertyCount, 16);
  assert.equal(result.pricedPropertyCount, 14);
  assert.equal(result.quoteCount, 14);
  assert.equal(result.identityCoverage.status, 'complete');
  assert.equal(result.priceCoverage.status, 'partial');
  assert.equal(result.priceCoverage.unpricedPropertyCount, 2);
  assert.equal(result.priceCoverage.unpricedReasonCounts.pricing_missing_or_no_offers, 2);
  assert.equal(unavailable.priceCoverage.reason, 'pricing_missing_or_no_offers');
  assert.equal(result.execution.liveReplay, false);
  assert.equal(metadata.auth, 'anonymous');
  assert.equal(metadata.path, '/graphql/search');
  assert.equal(first.city, '달랏');
  assert.equal(first.country, '베트남');
  assert.equal(first.rating, 2);
  assert.equal(first.rooms[0].prices.length, 1);
  assert.deepEqual(first.rooms[0].prices[0], {
    currency: 'KRW',
    basis: 'perRoomPerNight',
    exclusive: { amount: 24396, crossedOutAmount: 30761 },
    inclusive: { amount: 27665, crossedOutAmount: 34030 },
    perBook: { amount: 27665, crossedOutAmount: 34030, basis: 'perBook inclusive' },
    totalDiscount: 21,
  });
  assert.equal(unavailable.availability.quotePermitted, false);
  assert.deepEqual(unavailable.rooms, []);
  assert.equal(result.properties.some(property => property.rooms.some(room => room.prices.some(price => price.currency !== 'KRW'))), false);
  const output = JSON.stringify({ metadata, result });
  assert.equal(output.includes(issuerId), false);
  assert.equal(output.includes('0123456789abcdef01234567'), false);
  assert.equal(output.includes(searchId), false);
  assert.equal(output.includes('do-not-retain'), false);
});

test('reads campaign cards with the observed anonymous POST and returns a safe display-only projection', async () => {
  const fixture = await readJson('campaigns.json');
  const requests = [];
  const client = createClient(async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1 ? htmlResponse(bootstrapHtml()) : jsonResponse(fixture);
  });

  const { result } = await client.campaigns();
  const campaignRequest = requests[1];
  const requestBody = JSON.parse(campaignRequest.options.body);
  const coupon = result.cards.find(card => card.cardId === 248);
  const requestHeaders = Object.fromEntries(Object.entries(campaignRequest.options.headers).map(([key, value]) => [key.toLowerCase(), value]));

  assert.deepEqual(requests.map(item => item.url), [AGODA_PUBLIC_ROUTES.home, AGODA_PUBLIC_ROUTES.campaigns]);
  assert.equal(campaignRequest.options.method, 'POST');
  assert.equal(requestHeaders['content-type'], 'application/json');
  assert.deepEqual(requestHeaders, {
    'content-type': 'application/json',
    'ag-language-id': '1',
    'ag-language-locale': 'en-us',
    'cr-currency-code': 'KRW',
    'cr-currency-id': '26',
    'x-client-id': '2000',
  });
  assert.deepEqual(requestBody.clientInfo, {
    userId: issuerId, memberId: 0, clientVersion: '1.0', applicationName: 3,
  });
  assert.equal(requestBody.platformInfo.pageTypeId, 88);
  assert.equal(result.returnedCardCount, 9);
  assert.equal(result.cards.length, 9);
  assert.equal(coupon.content.description, 'Expires in 3 days');
  assert.equal(coupon.content.buttonText, 'CLAIM COUPON');
  assert.equal(coupon.content.buttonUrl, 'https://www.agoda.com/promotion/redeem');
  assert.equal('price' in coupon, false);
  assert.equal('imageRedirectLink' in coupon.content, false);
  for (const card of result.cards) {
    const url = card.content.buttonUrl;
    if (url) {
      assert.equal(new URL(url).hostname, 'www.agoda.com');
      assert.equal(new URL(url).search, '');
      assert.equal(new URL(url).hash, '');
    }
  }
  assert.equal(result.execution.liveReplay, false);
  assert.equal(JSON.stringify(result).includes(issuerId), false);
});

test('rejects invalid date, occupancy and unobserved property inputs before making a request', async () => {
  let calls = 0;
  const client = createClient(async () => { calls += 1; throw new Error('must not run'); });
  for (const input of [
    { checkIn: '2026-02-30', checkOut: '2026-03-01' },
    { checkIn: '2026-10-04', checkOut: '2026-10-05' },
    { checkIn: '2026-10-13', checkOut: '2026-10-13' },
    { checkIn: '2026-10-13', checkOut: '2026-10-14', adults: 3 },
    { checkIn: '2026-10-13', checkOut: '2026-10-14', destination: 'Hanoi' },
    { checkIn: '2026-10-13', checkOut: '2026-10-14', propertyIds: [99999999] },
    { checkIn: '2026-10-13', checkOut: '2026-10-14', propertyIds: [AGODA_OBSERVED_PROPERTY_IDS[0], AGODA_OBSERVED_PROPERTY_IDS[0]] },
  ]) {
    await assert.rejects(client.rates(input), { code: 'AGODA_INPUT_INVALID' });
  }
  assert.equal(calls, 0);
});

test('fails closed on GraphQL errors and never copies server error text or IDs into the thrown error', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls += 1;
    return calls === 1
      ? htmlResponse(bootstrapHtml())
      : jsonResponse({ errors: [{ message: `${issuerId} private server detail` }] });
  });
  await assert.rejects(client.rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), error => {
    assert.equal(error.code, 'AGODA_GRAPHQL_ERRORS');
    assert.equal(error.message.includes(issuerId), false);
    assert.equal(JSON.stringify(error.metadata ?? {}).includes(issuerId), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('marks missing result rows partial, rejects duplicate or unexpected IDs, and omits unavailable or nonpositive quotes', async () => {
  const original = await readJson('property-summary-vietnam.json');
  const missing = structuredClone(original);
  missing.data.propertySummarySearch.properties.pop();
  const makeClient = payload => {
    let calls = 0;
    return createClient(async () => {
      calls += 1;
      return calls === 1 ? htmlResponse(bootstrapHtml()) : jsonResponse(payload);
    });
  };
  const partial = await makeClient(missing).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' });
  assert.equal(partial.result.identityCoverage.status, 'partial');
  assert.equal(partial.result.identityCoverage.missingPropertyCount, 1);
  assert.equal(partial.result.priceCoverage.status, 'partial');

  const onlyPriced = structuredClone(original);
  onlyPriced.data.propertySummarySearch.properties = [original.data.propertySummarySearch.properties[0]];
  const sparse = await makeClient(onlyPriced).rates({
    propertyIds: original.data.propertySummarySearch.properties.slice(0, 2).map(property => property.propertyId),
    checkIn: '2026-10-13', checkOut: '2026-10-14',
  });
  assert.equal(sparse.result.pricedPropertyCount, 1);
  assert.equal(sparse.result.identityCoverage.status, 'partial');
  assert.equal(sparse.result.priceCoverage.status, 'partial');

  const duplicate = structuredClone(original);
  duplicate.data.propertySummarySearch.properties.push(duplicate.data.propertySummarySearch.properties[0]);
  await assert.rejects(makeClient(duplicate).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_PROPERTY_SET_MISMATCH' });

  const unexpected = structuredClone(original);
  unexpected.data.propertySummarySearch.properties[0].propertyId = 99999999;
  await assert.rejects(makeClient(unexpected).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_PROPERTY_SET_MISMATCH' });

  const nonpositive = structuredClone(original);
  const firstProperty = nonpositive.data.propertySummarySearch.properties[0];
  const krw = firstProperty.pricing.offers[0].roomOffers[0].room.pricing.find(entry => entry.currency === 'KRW');
  krw.price.perRoomPerNight.exclusive.display = 0;
  krw.price.perRoomPerNight.inclusive.display = 0;
  krw.price.perBook.inclusive.display = 0;
  const noPriceObject = nonpositive.data.propertySummarySearch.properties[2];
  noPriceObject.pricing.offers[0].roomOffers[0].room.pricing.find(entry => entry.currency === 'KRW').price = null;
  nonpositive.data.propertySummarySearch.properties[3].pricing.isReady = false;
  const normalized = await makeClient(nonpositive).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' });
  const zeroPriceHotel = normalized.result.properties[0];
  const emptyPriceHotel = normalized.result.properties[2];
  const notReadyHotel = normalized.result.properties[3];
  assert.equal(zeroPriceHotel.rooms[0].prices.length, 0);
  assert.equal(zeroPriceHotel.priceCoverage.reason, 'invalid_amounts');
  assert.equal(emptyPriceHotel.rooms[0].prices.length, 0);
  assert.equal(emptyPriceHotel.priceCoverage.reason, 'pricing_missing_or_no_offers');
  assert.equal(notReadyHotel.availability.quotePermitted, false);
  assert.equal(notReadyHotel.priceCoverage.reason, 'not_ready');
  assert.deepEqual(notReadyHotel.rooms, []);
  assert.equal(normalized.result.priceCoverage.invalidAmountCount, 1);
});

test('separates no quotes and unsupported currencies from identity coverage and unavailable properties', async () => {
  const original = await readJson('property-summary-vietnam.json');
  const makeClient = payload => {
    let calls = 0;
    return createClient(async () => {
      calls += 1;
      return calls === 1 ? htmlResponse(bootstrapHtml()) : jsonResponse(payload);
    });
  };

  const noQuotes = structuredClone(original);
  noQuotes.data.propertySummarySearch.properties = noQuotes.data.propertySummarySearch.properties.map(property => ({
    ...property,
    pricing: null,
  }));
  const none = await makeClient(noQuotes).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' });
  assert.equal(none.result.identityCoverage.status, 'complete');
  assert.equal(none.result.priceCoverage.status, 'no_quotes');
  assert.equal(none.result.priceCoverage.pricedPropertyCount, 0);
  assert.equal(none.result.priceCoverage.unpricedPropertyCount, 16);
  assert.equal(none.result.priceCoverage.unpricedReasonCounts.pricing_missing_or_no_offers, 16);
  assert.equal(none.result.properties[0].priceCoverage.reason, 'pricing_missing_or_no_offers');
  assert.equal(none.result.properties[0].availability.isAvailable, null);

  const foreignOnly = structuredClone(original);
  const hotel = foreignOnly.data.propertySummarySearch.properties[0];
  const roomPricing = hotel.pricing.offers[0].roomOffers[0].room.pricing;
  hotel.pricing.offers[0].roomOffers[0].room.pricing = roomPricing.filter(entry => entry.currency !== 'KRW');
  const mixed = await makeClient(foreignOnly).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' });
  assert.equal(mixed.result.priceCoverage.status, 'partial');
  assert.equal(mixed.result.priceCoverage.unsupportedCurrencyCount, 1);
  assert.deepEqual(mixed.result.properties[0].priceCoverage.currenciesObserved, ['USD', 'VND']);
  assert.equal(mixed.result.properties[0].priceCoverage.reason, 'unsupported_currency');
  assert.equal(mixed.result.priceCoverage.unpricedReasonCounts.unavailable, undefined);
});

test('fails closed on price response type drift and a non-array GraphQL errors field', async () => {
  const original = await readJson('property-summary-vietnam.json');
  const makeClient = payload => {
    let calls = 0;
    return createClient(async () => {
      calls += 1;
      return calls === 1 ? htmlResponse(bootstrapHtml()) : jsonResponse(payload);
    });
  };

  const badOffers = structuredClone(original);
  badOffers.data.propertySummarySearch.properties[0].pricing.offers = 'one offer';
  await assert.rejects(makeClient(badOffers).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_PRICE_SCHEMA' });

  const badRoomOffers = structuredClone(original);
  badRoomOffers.data.propertySummarySearch.properties[0].pricing.offers[0].roomOffers = {};
  await assert.rejects(makeClient(badRoomOffers).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_PRICE_SCHEMA' });

  const badDisplay = structuredClone(original);
  badDisplay.data.propertySummarySearch.properties[0].pricing.offers[0].roomOffers[0].room.pricing
    .find(entry => entry.currency === 'KRW').price.perRoomPerNight.exclusive.display = { amount: 24396 };
  await assert.rejects(makeClient(badDisplay).rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_PRICE_SCHEMA' });

  await assert.rejects(makeClient({ ...original, errors: { message: 'must not be echoed' } })
    .rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_GRAPHQL_SCHEMA' });
});

test('does not interpret or retain page scripts beyond the observed bootstrap literal', async () => {
  let calls = 0;
  const html = '<!doctype html><script>window.__ran = true; window.agBootstrap = new Promise((resolve) => { resolve({ core: { userId: "not-a-uuid" } }); });</script>';
  const client = createClient(async () => { calls += 1; return htmlResponse(html); });
  await assert.rejects(client.rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_BOOTSTRAP_INVALID' });
  assert.equal(calls, 1);
});

test('enforces bounded bootstrap body size before parsing', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls += 1;
    return htmlResponse('x'.repeat(1100));
  }, { maxBodyBytes: 1024 });
  await assert.rejects(client.rates({ checkIn: '2026-10-13', checkOut: '2026-10-14' }), { code: 'AGODA_RESPONSE_TOO_LARGE' });
  assert.equal(calls, 1);
});

test('rejects a changed campaign schema and does not attempt a second request after failure', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls += 1;
    return calls === 1 ? htmlResponse(bootstrapHtml()) : jsonResponse({ isSuccess: false, result: null });
  });
  await assert.rejects(client.campaigns(), { code: 'AGODA_CAMPAIGN_ERROR' });
  assert.equal(calls, 2);
});

test('does not accept a campaign envelope with a non-null error even when isSuccess is true', async () => {
  let calls = 0;
  const fixture = await readJson('campaigns.json');
  const client = createClient(async () => {
    calls += 1;
    if (calls === 1) return htmlResponse(bootstrapHtml());
    return jsonResponse({ ...fixture, error: { message: 'private server detail' } });
  });
  await assert.rejects(client.campaigns(), error => {
    assert.equal(error.code, 'AGODA_CAMPAIGN_ERROR');
    assert.equal(error.message.includes('private server detail'), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('CLI help and bounded invalid stdin return safe results without starting a request', () => {
  const script = fileURLToPath(new URL('../scripts/agoda.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /maximum 32 KiB/);

  for (const [input, expectedCode] of [
    ['private-body-must-not-be-echoed', 'INPUT_JSON_INVALID'],
    ['x'.repeat(32 * 1024 + 1), 'INPUT_SIZE'],
  ]) {
    const child = spawnSync(process.execPath, [script, 'rates'], { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 2);
    const output = JSON.parse(child.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, expectedCode);
    assert.equal(child.stdout.includes('private-body-must-not-be-echoed'), false);
  }
});
