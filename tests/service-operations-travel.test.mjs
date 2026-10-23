import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { definitions } from '../lib/service-operations/travel.mjs';
import { createOperationRegistry } from '../lib/operation-registry.mjs';

// Every transport in this file is an injected local fixture, never a live probe.
const definition = id => definitions.find(item => item.id === id);
const fixture = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const html = value => new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = value => Response.json(value);
const noIO = () => assert.fail('unexpected network/provider access');
const issuer = '2b2543f9-e758-4d91-8c52-a326df997841';
const bootstrap = () => html(`<script>window.agBootstrap = new Promise(resolve => resolve(${JSON.stringify({
  core: { userId: issuer, sessionId: 'private-bootstrap-session' }, secret: 'fixture-not-business-data',
})}));</script>`);
const fixedDate = () => new Date('2026-10-05T00:30:00.000Z');
const session = { token: 'fixture-token-never-output', expectedPartnerId: 42, expectedEmail: 'fixture-private@example.com' };
const envelope = data => ({ data, result: { status: 200 } });
const account = () => json(envelope({ id: 42, email: session.expectedEmail, rawAccount: 'private-raw-account' }));

function setup(id, options = {}) {
  const bundle = definition(id).createAdapters(options);
  const registry = createOperationRegistry(definition(id).profile, { adapters: bundle.adapters });
  return { ...registry, close: bundle.close };
}
function finite(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return; }
  assert.equal(typeof value, 'object', 'no undefined/functions/symbols');
  assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  for (const item of Object.values(value)) finite(item);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}
function fixtureReceipt(output) {
  finite(output);
  assert.equal(output.receipt.networkUsed, false);
  assert.equal(output.receipt.transportEvidence, 'injected_transport_network_not_asserted');
}
function privateFree(output) {
  assert.doesNotMatch(JSON.stringify(output), /fixture-token-never-output|fixture-private@example|private-raw-account|private-bootstrap-session|fixture-not-business-data/);
}

test('all four finite v2 definitions register lazily, expose concrete read adapters and bounded live-read checks', () => {
  assert.deepEqual(definitions.map(item => item.id), ['agoda', 'myrealtrip', 'video-sources', 'travel-ontology']);
  for (const item of definitions) {
    finite(item.profile); finite(item.verificationChecks);
    const concrete = item.createAdapters({ fetchImpl: noIO, credentialProvider: noIO });
    const instance = setup(item.id, { fetchImpl: noIO, credentialProvider: noIO });
    assert.equal(instance.list().length, Object.keys(item.profile.operations).length);
    finite(instance.list()); finite(instance.tools());
    for (const operation of instance.list()) {
      finite(instance.describe(operation.id));
      assert.equal(operation.semantics, 'read');
      assert.match(operation.evidence, /\.mjs/);
      assert.equal(typeof concrete.adapters[operation.adapter], 'function');
      assert.doesNotMatch(operation.id, /create-link|login|refresh|download|session-status/);
    }
    assert.equal(item.verificationChecks.length, 1);
    for (const check of item.verificationChecks) {
      assert.equal(check.kind, 'live_read');
      assert.ok(item.profile.operations[check.operation]);
      assert.equal('path' in check.input, false, 'no guessed object identifier');
    }
    instance.close(); concrete.close();
  }
});

test('Agoda campaigns uses the existing two-request contract and sanitized fixture projection', async () => {
  const payload = await fixture('./fixtures/agoda/campaigns.json');
  const calls = [];
  const instance = setup('agoda', { now: fixedDate, minIntervalMs: 0, credentialProvider: noIO,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return calls.length === 1 ? bootstrap() : json(payload); } });
  const output = await instance.execute('campaigns');
  assert.deepEqual(calls.map(call => call.url), ['https://www.agoda.com/ko-kr/', 'https://www.agoda.com/api/card/campaigns']);
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'POST']);
  for (const call of calls) {
    assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'manual');
    assert.equal(new Headers(call.init.headers).has('cookie'), false);
  }
  const native = output.data;
  assert.equal(native.metadata.auth, 'anonymous');
  assert.equal(native.metadata.status, 200);
  assert.equal(native.result.returnedCardCount, 9);
  assert.equal(native.result.cards.find(card => card.cardId === 248).content.description, 'Expires in 3 days');
  assert.equal(native.result.cards.find(card => card.cardId === 248).content.buttonUrl, 'https://www.agoda.com/promotion/redeem');
  assert.equal(native.result.execution.liveReplay, false);
  privateFree(output); assert.equal(JSON.stringify(output).includes(issuer), false); fixtureReceipt(output); instance.close();
});

test('Agoda rates preserves caller dates, allowed occupancy and separate KRW price bases', async () => {
  const payload = await fixture('./fixtures/agoda/property-summary-vietnam.json');
  payload.data.propertySummarySearch.properties = payload.data.propertySummarySearch.properties.filter(row => row.propertyId === 25575116);
  const calls = [];
  const instance = setup('agoda', { now: fixedDate, minIntervalMs: 0, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init }); return calls.length === 1 ? bootstrap() : json(payload);
  } });
  const query = { checkIn: '2026-10-13', checkOut: '2026-10-14', propertyIds: [25575116] };
  const output = await instance.execute('rates', { query });
  const request = JSON.parse(calls[1].init.body);
  assert.equal(request.operationName, 'propertySummarySearch');
  assert.deepEqual(request.variables.PropertySummarySearchRequest.propertyIds, [25575116]);
  assert.equal(request.variables.PricingSummaryRequest.pricing.localCheckInDate, query.checkIn);
  assert.equal(request.variables.PricingSummaryRequest.pricing.localCheckoutDate, query.checkOut);
  const property = output.data.result.properties[0];
  assert.deepEqual(property.stay, { checkIn: query.checkIn, checkOut: query.checkOut,
    nights: 1, adults: 2, children: 0, rooms: 1, currency: 'KRW' });
  assert.equal(property.rooms[0].prices[0].exclusive.amount, 24396);
  assert.equal(property.rooms[0].prices[0].inclusive.amount, 27665);
  assert.equal(property.rooms[0].prices[0].perBook.basis, 'perBook inclusive');
  assert.equal(output.data.result.coverage.checkoutPriceVerified, false);
  assert.equal(calls.length, 2); privateFree(output); fixtureReceipt(output); instance.close();
});

test('nested schema and native Agoda validation reject unsupported inputs before IO', async () => {
  const instance = setup('agoda', { fetchImpl: noIO, now: fixedDate, minIntervalMs: 0 });
  for (const query of [
    { checkIn: '2026-10-13', checkOut: '2026-10-14', adults: 3 },
    { checkIn: '2026-10-13', checkOut: '2026-10-14', currency: 'USD' },
    { checkIn: '2026-10-13', checkOut: '2026-10-14', rawHeaders: {} },
    { checkIn: '2026-10-13', checkOut: '2026-10-14', propertyIds: [1] },
    { checkIn: '2026-02-30', checkOut: '2026-03-01' },
  ]) await assert.rejects(instance.execute('rates', { query }), error => ['OPERATION_INPUT_INVALID', 'AGODA_INPUT_INVALID'].includes(error.code));
  await assert.rejects(instance.execute('rates', { checkIn: '2026-10-13' }), { code: 'OPERATION_INPUT_INVALID' });
  instance.close();
});

test('MyRealTrip verification acquires a provider lazily, performs exactly one owner GET and returns no identity', async () => {
  let acquired = 0; const calls = [];
  const instance = setup('myrealtrip', { credentialProvider: async id => { acquired++; assert.equal(id, 'myrealtrip'); return session; },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return account(); } });
  instance.list(); assert.equal(acquired, 0);
  const output = await instance.execute('verify');
  assert.equal(acquired, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api3-backoffice.myrealtrip.com/partner/v1/partners');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['partner-access-token'], session.token);
  assert.equal(output.data.identityVerified, true); assert.equal(output.data.rawAccountReturned, false);
  assert.equal(session.token, 'fixture-token-never-output', 'provider-owned object is not mutated');
  privateFree(output); fixtureReceipt(output); instance.close();
  await assert.rejects(instance.execute('verify'), { code: 'SESSION_CLOSED' });
});

test('all eight MyRealTrip business reads reuse the owner-checked source client and sanitizer', async t => {
  const airport = Object.fromEntries(['airportCode', 'airportKoName', 'airportEnName', 'cityCode', 'cityKoName', 'cityEnName',
    'countryCode', 'countryKoName', 'countryEnName', 'isoCode'].map(field => [field, field === 'airportCode' ? 'ICN' : 'fixture']));
  const airline = { airlineCd: 'KE', airlineKorNm: '대한항공', airlineEngNm: 'Korean Air', airlineImgUrl: 'https://example.com/fixture.png' };
  const summary = { quantity: 1, commissionBase: 200, salePrice: 210, partnershipCommission: 2, settlementAmount: 208, taxCharges: 1 };
  for (const operation of ['search-airports', 'search-airlines', 'reservations', 'flight-reservations', 'sales', 'sales-summary', 'flight-sales', 'flight-sales-summary']) {
    await t.test(operation, async () => {
      const calls = [];
      const query = operation.startsWith('search-') ? { keyword: '대한 & test' }
        : operation.includes('reservations') ? { startDate: '2026-09-01', endDate: '2026-09-21', ...(operation === 'reservations' ? { page: 2 } : {}) }
          : { fromDate: '2026-09-01', toDate: '2026-09-21' };
      const instance = setup('myrealtrip', { credentialProvider: async () => session, fetchImpl: async (url, init) => {
        calls.push({ url: new URL(url), init });
        if (calls.length === 1) return account();
        if (operation === 'search-airports') return json(envelope([{ ...airport, rawAccount: 'private-raw-account' }]));
        if (operation === 'search-airlines') return json(envelope({ airlines: [{ ...airline, rawAccount: 'private-raw-account' }] }));
        if (operation.endsWith('summary')) return json(envelope({ ...summary, rawAccount: 'private-raw-account' }));
        return json({ ...envelope([{ unobserved: 'private-raw-account' }]),
          ...(operation === 'reservations' ? { meta: { pagination: { page: 2, pageSize: 15, totalCount: 16 } } } : {}) });
      } });
      const output = await instance.execute(operation, { query });
      assert.equal(calls.length, 2);
      assert.ok(calls.every(call => call.init.method === 'GET' && call.url.origin === 'https://api3-backoffice.myrealtrip.com'));
      assert.ok(calls.every(call => call.init.body === undefined));
      if (operation.startsWith('search-')) assert.equal(calls[1].url.searchParams.get('keyword'), query.keyword);
      else if (operation === 'reservations') {
        assert.equal(calls[1].url.searchParams.get('dateSearchType'), 'TRIP_END_DATE');
        assert.equal(calls[1].url.searchParams.get('pageSize'), '15');
        assert.equal(output.data.pagination.page, 2);
      }
      if (operation.endsWith('summary')) assert.deepEqual(output.data, summary);
      if (!operation.startsWith('search-') && !operation.endsWith('summary')) {
        assert.equal(output.data.recordCount, 1); assert.equal(output.data.rowsReturned, false); assert.equal(output.data.rowSchemaVerified, false);
      }
      privateFree(output); fixtureReceipt(output); instance.close();
    });
  }
});

test('existing MyRealTrip link verification is credential-free, bounded and never follows or creates links', async () => {
  const target = 'https://www.myrealtrip.com/offers/174730';
  let calls = 0;
  const instance = setup('myrealtrip', { credentialProvider: noIO, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://myrealt.rip/fixture'); assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, { accept: 'text/html' }); assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 301, headers: { location: 'https://www.myrealtrip.com/main/bridge/marketing?return_url=' + encodeURIComponent(target + '?mylink_id=100&t_scope=web') } });
  } });
  const output = await instance.execute('verify-link', { query: { link: 'https://myrealt.rip/fixture', expectedTarget: target, expectedLinkId: 100 } });
  assert.equal(calls, 1); assert.equal(output.data.verified, true); assert.equal(output.data.followedRedirect, false);
  fixtureReceipt(output); instance.close();
});

test('stored MyRealTrip state is reused read-only with sessionName, without invoking auth renewal', async () => {
  const names = [];
  const instance = setup('myrealtrip', { sessionName: 'fixture-custom-session', storeDirectory: 'unused-with-injected-store',
    store: { read: name => { names.push(name); return JSON.stringify({ version: 1, accessToken: session.token, partnerId: 42, email: session.expectedEmail }); }, write: noIO },
    fetchImpl: async () => account() });
  const output = await instance.execute('verify');
  assert.deepEqual(names, ['fixture-custom-session']); privateFree(output); fixtureReceipt(output); instance.close();
  const missing = setup('myrealtrip', { store: { read: () => null, write: noIO }, fetchImpl: noIO });
  await assert.rejects(missing.execute('verify'), { code: 'PROVIDER_MISSING' }); missing.close();
});

test('missing/invalid providers, expired sessions and unknown provider failures are stable and sanitized', async () => {
  for (const [credentialProvider, code] of [[async () => null, 'PROVIDER_MISSING'], [async () => ({}), 'SESSION_MISSING'],
    [async () => { throw new Error('fixture-token-never-output'); }, 'PROVIDER_FAILED']]) {
    const instance = setup('myrealtrip', { credentialProvider, fetchImpl: noIO });
    await assert.rejects(instance.execute('verify'), error => { assert.equal(error.code, code); privateFree(error); assert.equal(error.message, code); return true; }); instance.close();
  }
  let calls = 0;
  const expired = setup('myrealtrip', { credentialProvider: async () => session,
    fetchImpl: async (url, init) => { calls++; assert.equal(init.method, 'GET'); return new Response('private-raw-account', { status: 401 }); } });
  await assert.rejects(expired.execute('verify'), { code: 'REAUTH_REQUIRED' });
  assert.equal(calls, 1, 'no refresh/login retry'); expired.close();
});

const mtopCookie = { name: '_m_h5_tk', value: '0123456789abcdef0123456789abcdef_1792234094258' };
const aliMedia = { PRODUCT_TITLE: { text: 'Fixture piano' }, HEADER_IMAGE_PC: {
  imagePathList: ['https://ae-pic-a1.aliexpress-media.com/kf/fixture.jpg'], productVideo: { videoId: 5000512850330,
    videoPlayInfo: { webUrl: 'https://video.aliexpress-media.com/play/u/ae_sg_item/2215427586775/p/1/e/6/t/10301/5000512850330.mp4' } },
}, rawAccount: 'private-raw-account' };
const amazonPdp = () => `<html>${'x'.repeat(2100)}<span id="productTitle">Fixture folding piano</span><script>{"videos":${JSON.stringify([
  { isVideo: true, mediaObjectId: '07469fc7b2784a66aa', aciContentId: 'amzn1.ive.seller.video.fixture', videoWidth: '1080', videoHeight: '1920',
    url: 'https://m.media-amazon.com/fixture/default.jobtemplate.hls.m3u8', title: 'Seller fixture', durationTimestamp: '00:19' },
  { isVideo: true, mediaObjectId: 'ffffffffffffffffff', aciContentId: 'amzn1.ive.creator.video.fixture', url: 'https://m.media-amazon.com/creator/default.jobtemplate.hls.m3u8' },
])}}</script></html>`;
const offerDocument = () => `<html>${'x'.repeat(1200)}<script>${JSON.stringify({ offerTitle: 'Fixture 折叠钢琴',
  video: { videoId: 418199150043, state: 6, videoUrl: 'https://cloud.video.taobao.com/play/u/2215570254123/p/2/e/6/t/1/418199150043.mp4' },
  companyName: 'Fixture supplier', sellerUserId: 2215570254123, sellerLoginId: 'fixture-business-seller' })}</script></html>`;

function amazonDiscoveryStream({ query = 'folding piano keyboard', page = 1, count = 22 } = {}) {
  const frame = (name, payload) => JSON.stringify(['dispatch', name, payload]);
  const asin = 'B0DS23X39K';
  return [
    frame('data-search-metadata', { metadata: { keywords: query, page, asinOnPageCount: count,
      totalResultCount: 100, marketplaceId: 'ATVPDKIKX0DER', locale: 'en_US' } }),
    frame('data-title-and-meta', { title: 'Amazon.com: folding piano keyboard', html: '' }),
    frame('data-main-slot:search-result-1', { asin, index: 1,
      html: `<div data-asin="${asin}"><h2><span>Fixture folding piano</span></h2><a href="/dp/${asin}/ref=search?tag=not-retained">Product</a>`
        + '<span class="a-price"><span class="a-offscreen">$129.50</span></span>'
        + '<img class="s-image" src="https://m.media-amazon.com/images/I/fixture.jpg"></div>' }),
    frame('data-pagination', { html: `<a class="s-pagination-next" href="/s?k=${encodeURIComponent(query)}&page=${page + 1}">Next</a>` }),
  ].join('\n&&&\n');
}

test('HTTP ASIN discovery is separate from CDP, credential-free and retains partial source cards/prices/pagination without claiming videos', async () => {
  const calls = [];
  const instance = setup('video-sources', { credentialProvider: noIO, createFetcher: noIO, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(amazonDiscoveryStream(), { headers: { 'content-type': 'application/json-amazonui-streaming' } });
  } });
  const output = await instance.execute('amazon-asin-discovery', { query: { query: 'folding piano keyboard' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.amazon.com/s/query?k=folding+piano+keyboard&page=1');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].init.body), { 'customer-action': 'pagination' });
  assert.equal(Object.keys(calls[0].init.headers).some(key => /cookie|authorization/i.test(key)), false);
  assert.equal(output.data.items[0].asin, 'B0DS23X39K');
  assert.equal(output.data.items[0].productUrl, 'https://www.amazon.com/dp/B0DS23X39K');
  assert.deepEqual(output.data.items[0].currentDisplayPrice, { displayText: '$129.50', amount: '129.50',
    currencyCode: null, currencyCodeExplicit: false, currencyVerified: false });
  assert.equal(output.data.partial, true); assert.equal(output.data.reportedAsinsOnPage, 22); assert.equal(output.data.allAsinsOnPageCovered, false);
  assert.deepEqual(output.pageInfo, { observed: true, hasNext: true, nextPage: 2, terminationVerified: false });
  assert.equal(output.receipt.browserUsed, false); assert.equal(output.receipt.cookieSent, false);
  assert.equal(output.receipt.sourcingStage, 'asin_discovery'); assert.equal(output.receipt.videoMetadataFetched, false);
  assert.equal(output.receipt.videoPresenceVerified, false); assert.equal(output.receipt.mediaDownloaded, false);
  assert.equal(Object.hasOwn(output.data, 'videos'), false); fixtureReceipt(output); instance.close();
  assert.deepEqual(definition('video-sources').verificationChecks, [{ operation: 'amazon-asin-discovery',
    input: { query: { query: 'folding piano keyboard', page: 1 } }, kind: 'live_read' }]);
});

test('HTTP ASIN discovery never falls back to CDP on challenge/invalid stream and rejects missing or out-of-range inputs before IO', async () => {
  let calls = 0;
  const instance = setup('video-sources', { credentialProvider: noIO, createFetcher: noIO, fetchImpl: async () => {
    calls++; return html('<title>Amazon challenge fixture</title>');
  } });
  await assert.rejects(instance.execute('amazon-asin-discovery', { query: { query: 'folding piano keyboard' } }), { code: 'AMAZON_RESPONSE_NOT_XHR' });
  assert.equal(calls, 1);
  await assert.rejects(instance.execute('amazon-asin-discovery', {}), { code: 'OPERATION_INPUT_REQUIRED' });
  await assert.rejects(instance.execute('amazon-asin-discovery', { query: { query: 'folding piano keyboard', page: 21 } }), { code: 'OPERATION_INPUT_INVALID' });
  assert.equal(calls, 1); instance.close();
});

test('all six video operations call existing parsers/clients via injected tabs, return metadata and never fetch media', async t => {
  const cases = [
    ['amazon-search', { keyword: 'folding piano keyboard' }, '<div data-asin="B0DS23X39K" data-component-type="s-search-result"><h2>Fixture piano</h2></div>', output => assert.equal(output.asins[0], 'B0DS23X39K')],
    ['amazon-product-videos', { asin: 'B0DS23X39K' }, amazonPdp(), output => { assert.equal(output.videos.length, 1); assert.equal(output.videos[0].kind, 'seller_product_video'); }],
    ['aliexpress-search', { keyword: '접이식 피아노' }, 'x'.repeat(2100) + JSON.stringify({ productId: '1005013075520990', title: { displayTitle: 'Fixture piano' }, prices: { salePrice: { minPrice: 12345, currencyCode: 'KRW' } } }),
      output => { assert.equal(output.items[0].price, 12345); assert.equal(output.items[0].currency, 'KRW'); }],
    ['aliexpress-product-media', { productId: '1005013075520990' }, JSON.stringify({ ret: ['SUCCESS::ok'], data: { result: aliMedia } }), output => assert.equal(output.video.videoId, '5000512850330')],
    ['alibaba1688-search', { keyword: '折叠电子钢琴', page: 2 }, JSON.stringify({ ret: ['SUCCESS::ok'], data: { data: { OFFER: { items: [{ data: {
      offerId: '1047106487219', title: '<b>折叠</b>钢琴', priceInfo: { price: '129.50' }, bookedCount: '49', offerRepurchaseRate: '38%',
    } }] } } } }), output => { assert.equal(output.page, 2); assert.equal(output.items[0].priceCny, '129.50'); }],
    ['alibaba1688-offer-media', { offerId: '1047106487219' }, offerDocument(), output => assert.equal(output.video.videoId, '418199150043')],
  ];
  for (const [operation, query, response, check] of cases) await t.test(operation, async () => {
    const configs = [], calls = [];
    const instance = setup('video-sources', { minIntervalMs: 0, now: () => 1792234094258, fetchImpl: noIO,
      credentialProvider: async id => { assert.equal(id, 'video-sources'); return { cdpEndpoint: 'http://127.0.0.1:9555' }; },
      createFetcher: config => { configs.push(config); return { cookies: async () => [mtopCookie], fetchText: async url => {
        calls.push(new URL(url)); return { status: 200, text: response };
      } }; } });
    instance.list(); assert.equal(configs.length, 0);
    const output = await instance.execute(operation, { query });
    assert.equal(calls.length, 1); assert.ok(configs.every(config => config.openUrl === undefined));
    assert.ok(configs.every(config => config.endpoint === 'http://127.0.0.1:9555'));
    assert.ok(calls.every(url => !/\.(?:mp4|m3u8|jpg|png)$/.test(url.pathname)), 'metadata only, no media fetches');
    check(output.data); privateFree(output); fixtureReceipt(output); instance.close();
  });
});

test('video reads with no matching tab fail without opening a tab or starting login', async () => {
  const calls = [];
  const instance = setup('video-sources', { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init }); assert.match(String(url), /\/json\/list$/); return json([]);
  } });
  await assert.rejects(instance.execute('amazon-search', { query: { keyword: 'folding piano keyboard' } }), { code: 'CDP_PAGE_MISSING' });
  assert.equal(calls.length, 1); assert.ok(calls.every(call => !call.url.includes('/json/new'))); instance.close();
});

test('AliExpress HTTP metadata reuses stored cookies with persistence disabled; signed URLs and secrets stay private', async () => {
  let reads = 0, calls = 0;
  const credential = { version: 1, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/158.0.0.0', cookies: [
    { ...mtopCookie, domain: '.aliexpress.com', path: '/', secure: true },
    { name: '_m_h5_tk_enc', value: 'fixture-encrypted-token', domain: '.aliexpress.com', path: '/', secure: true },
    { name: 'cna', value: 'fixture-cna-secret', domain: '.aliexpress.com', path: '/', secure: true },
  ] };
  const instance = setup('video-sources', { sessionName: 'fixture-ali-state', minIntervalMs: 0, now: () => 1792234094258,
    store: { read: name => { reads++; assert.equal(name, 'fixture-ali-state'); return JSON.stringify(credential); }, write: noIO },
    fetchImpl: async (url, init) => {
      calls++; const requested = new URL(url); assert.equal(requested.origin, 'https://acs.aliexpress.com');
      assert.equal(new Headers(init.headers).get('cookie').includes('fixture-cna-secret'), true);
      return json({ ret: ['SUCCESS::ok'], data: { result: aliMedia } });
    } });
  const output = await instance.execute('aliexpress-product-media', { query: { productId: '1005013075520990', transport: 'http' } });
  assert.equal(reads, 1); assert.equal(calls, 1); assert.equal(output.data.receipt.transport, 'stored_session_http');
  assert.doesNotMatch(JSON.stringify(output), /fixture-cna-secret|fixture-encrypted-token|0123456789abcdef0123456789abcdef|[?&]sign=/);
  privateFree(output); fixtureReceipt(output); instance.close();
});

test('video challenges fail with a stable code and no retry or raw provider error state', async () => {
  let calls = 0;
  const instance = setup('video-sources', { minIntervalMs: 0, createFetcher: () => ({ cookies: async () => [mtopCookie],
    fetchText: async () => { calls++; return { status: 200, text: JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM'], raw: 'private-raw-account' }) }; } }) });
  await assert.rejects(instance.execute('aliexpress-product-media', { query: { productId: '1005013075520990' } }), error => {
    assert.equal(error.code, 'ALIEXPRESS_CHALLENGE_REQUIRED'); assert.deepEqual(Object.keys(error), ['code']); return true;
  }); assert.equal(calls, 1); instance.close();
});

test('non-finite native video numbers are rejected rather than silently serialized as fabricated null values', async () => {
  const instance = setup('video-sources', { minIntervalMs: 0, createFetcher: () => ({
    fetchText: async () => ({ status: 200, text: amazonPdp().replace('"videoWidth":"1080"', '"videoWidth":"Infinity"') }),
  }) });
  await assert.rejects(instance.execute('amazon-product-videos', { query: { asin: 'B0DS23X39K' } }), { code: 'OPERATION_ADAPTER_RESULT_INVALID' });
  instance.close();
});

test('unknown source transport failures expose only a stable code, not messages, headers or provider detail', async () => {
  const instance = setup('video-sources', { minIntervalMs: 0, createFetcher: () => ({ fetchText: async () => {
    throw Object.assign(new Error('fixture-token-never-output'), { detail: { cookie: 'fixture-token-never-output' }, headers: { token: 'private-raw-account' } });
  } }) });
  await assert.rejects(instance.execute('amazon-search', { query: { keyword: 'folding piano keyboard' } }), error => {
    assert.equal(error.message, 'VIDEO_SOURCES_OPERATION_FAILED'); assert.deepEqual(Object.keys(error), ['code']); privateFree(error); return true;
  }); instance.close();
});

async function modeFetcher({ detail = false, invalidContext = false, blocked = false } = {}) {
  const list = await fixture('../service-packs/ontology/src/travel-price/fixtures/agent-modetour-recommendations.sample.json');
  const master = await fixture('../service-packs/ontology/src/travel-price/fixtures/agent-modetour-product-master.sample.json');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url); calls.push({ url: parsed, init }); assert.equal(init.method, 'GET');
    if (blocked) return new Response('challenge fixture', { status: 403 });
    if (parsed.origin === 'https://www.modetour.com') {
      const response = html('anonymous public context fixture');
      if (!invalidContext) Object.defineProperty(response.headers, 'getSetCookie', { value: () => ['ModeEcommerceContext=' + encodeURIComponent(JSON.stringify({
        webSiteNo: 7, companyNo: 8, deviceType: 'PC', apiKey: 'fixture-mode-context-secret',
      })) + '; Path=/; HttpOnly'] });
      return response;
    }
    assert.equal(parsed.origin, 'https://b2c-api.modetour.com');
    assert.ok(Object.keys(init.headers).some(key => key.toLowerCase() === 'modewebapireqheader'));
    if (parsed.pathname === '/Package/GetRecommendedProduct') return json({ isOK: true, result: { package: list.products } });
    assert.equal(detail, true); assert.equal(parsed.pathname, '/Package/GetProductMasterByIds');
    assert.equal(parsed.searchParams.get('productMasterNos'), '49617'); assert.equal(parsed.searchParams.get('searchFrom'), '2026-10-16');
    return json({ isOK: true, result: { productMaster: master.products } });
  };
  return { calls, fetchImpl };
}

test('ontology ModeTour default is two limited-feed reads; optional detail stays within three and preserves unknowns', async () => {
  for (const detail of [false, true]) {
    const { calls, fetchImpl } = await modeFetcher({ detail });
    const instance = setup('travel-ontology', { fetchImpl, minIntervalMs: 0, credentialProvider: noIO });
    const output = await instance.execute('modetour-packages', { query: { destination: '다낭', maxProductsPerDestination: detail ? 1 : 0 } });
    assert.equal(calls.length, detail ? 3 : 2);
    assert.equal(output.data.verdict, detail ? 'usable_limited' : 'list_only');
    assert.equal(output.data.products[0].priceQuote.currency, null); assert.equal(output.data.products[0].priceQuote.quotedBasis, null);
    assert.equal(output.data.products[0].priceQuote.summaryAmount, 329000);
    assert.equal(output.data.products[0].minimumObservedDepartureDate, '2026-10-16');
    assert.deepEqual(output.data.products[0].departures, []); assert.equal(output.data.products[0].departureAvailability, null);
    assert.match(output.data.sourceScope, /not a destination-complete/);
    assert.equal(output.data.httpIndependentLive, false); assert.equal(output.data.fiveStates.live_replay, false, 'fixture success is not live replay');
    assert.doesNotMatch(JSON.stringify(output), /fixture-mode-context-secret|ModeEcommerceContext=/);
    fixtureReceipt(output); instance.close();
  }
});

test('ontology ModeTour missing context/access failures are errors, not successful empty catalogs', async () => {
  for (const [options, code] of [[{ invalidContext: true }, 'MODETOUR_CONTEXT_UNAVAILABLE'], [{ blocked: true }, 'MODETOUR_CHALLENGE_REQUIRED']]) {
    const { calls, fetchImpl } = await modeFetcher(options);
    const instance = setup('travel-ontology', { fetchImpl, minIntervalMs: 0 });
    await assert.rejects(instance.execute('modetour-packages'), { code }); assert.equal(calls.length, 1); instance.close();
  }
});

test('ontology Naver list/rates are separate single GraphQL reads with exact destination, stay and price semantics', async () => {
  const stay = { checkIn: '2026-10-27', checkOut: '2026-10-29', adultCnt: 2, childAges: [7] };
  const calls = [];
  const instance = setup('travel-ontology', { minIntervalMs: 0, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://hermes-hotel-svc-api.naver.com/graphql'); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit');
    const body = JSON.parse(init.body); calls.push(body);
    if (body.operationName === 'overseasHotelList') return json({ data: { overseasHotelList: {
      total: 1, pageInfo: { pageSize: 20, totalPages: 1 }, itemList: [{ id: 'fixture-list', serviceType: 'HOTEL', hotel: { id: '100', title: 'Fixture hotel', priceMinRate: '45000' } }],
    } } });
    assert.equal(body.operationName, 'overseasHotelListRatesV2');
    return json({ data: { overseasHotelListRates: [{ xbuId: '100', otaMinRates: [{ otaCode: 'AGODA', stay: { id: 'fixture-stay', roomId: 'fixture-room',
      rate: { userRate: 45000, localRate: { currencyCode: 'USD', rate: 32.50 }, bookUrl: 'https://example.com/private-tracking?token=fixture-not-business-data' } } }] }] } });
  } });
  const listing = await instance.execute('naver-overseas-search', { query: { ...stay, query: '다낭', placeId: 'WOF:12345' } });
  assert.equal(calls.length, 1); assert.equal(calls[0].variables.input.placeId, 'WOF:12345');
  assert.equal(calls[0].variables.input.checkIn, stay.checkIn); assert.deepEqual(calls[0].variables.input.childAges, [7]);
  assert.equal(listing.data.items[0].hotel.priceMinRate, 45000); assert.deepEqual(listing.pageInfo, { pageSize: 20, totalPages: 1 });
  const rates = await instance.execute('naver-overseas-rates', { query: { ...stay, query: '다낭', nPlaceId: '다낭', xbuIds: ['100'] } });
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].variables.xbuIds, ['100']); assert.equal(calls[1].variables.includeTax, true);
  assert.equal(rates.data.stay.nights, 2); assert.equal(rates.data.priceCoverage.status, 'quoted');
  assert.deepEqual(rates.data.rows[0].otaMinRates[0].stays[0].rate.localRate, { currencyCode: 'USD', rate: 32.5 });
  assert.match(rates.data.quoteBasis, /does not establish tax arithmetic or a checkout total/);
  privateFree(rates); fixtureReceipt(listing); fixtureReceipt(rates); instance.close();
});

test('ontology Yanolja uses the existing document parser or reports its actual missing optional dependency', async () => {
  const document = await readFile(new URL('../service-packs/ontology/src/travel-price/fixtures/yanolja-hotel-search-results-gangneung-trimmed.html', import.meta.url), 'utf8');
  let calls = 0;
  const instance = setup('travel-ontology', { fetchImpl: async () => { calls++; return html(document); } });
  try {
    const output = await instance.execute('yanolja-search', { query: { keyword: '강릉' } });
    assert.equal(calls, 1); assert.equal(output.data.receipt.priceSemantics.totalVsNightly, 'unknown'); fixtureReceipt(output);
  } catch (error) {
    assert.equal(error.code, 'DEPENDENCY_MISSING'); assert.equal(calls, 0, 'import failure is not a network read or live success');
  } finally { instance.close(); }
});

test('abort propagates to an in-flight existing HTTP read; pre-aborted calls never acquire a provider', async () => {
  const before = setup('myrealtrip', { fetchImpl: noIO, credentialProvider: noIO });
  const already = new AbortController(); already.abort();
  await assert.rejects(before.execute('verify', {}, { signal: already.signal }), { code: 'OPERATION_ABORTED' }); before.close();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const instance = setup('myrealtrip', { credentialProvider: async () => session, fetchImpl: async (url, init) => {
    started(); return await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const pending = instance.execute('verify', {}, { signal: controller.signal });
  await ready; controller.abort(); await assert.rejects(pending, { code: 'OPERATION_ABORTED' }); instance.close();
});
