import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fetchYanoljaHotelSearch, parseYanoljaHotelHome, parseYanoljaHotelSearchResults, YANOLJA_MAX_DOCUMENT_BYTES } from './seller-adapters/yanolja-hotel.mjs';

const fixture = async name => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parses public hotel-home starting prices without inventing stay dates', async () => {
  const html = await fixture('yanolja-hotel-sub-home.html');
  const parsed = parseYanoljaHotelHome(html, { checkedAt: '2026-10-04T22:50:43.038Z' });
  const seoul = parsed.cards.find(card => card.hotelId === '3001558');
  const unavailable = parsed.cards.find(card => card.hotelId === '3016266');

  assert.equal(parsed.anchorCount, 52);
  assert.equal(parsed.resultCount, 51);
  assert.equal(parsed.duplicateAnchorCount, 1);
  assert.equal(parsed.pricedCount, 46);
  assert.equal(parsed.discountedCount, 34);
  assert.equal(seoul.title, '롯데시티호텔 마포');
  assert.equal(seoul.prices[0].salePriceKrw, 215600);
  assert.equal(seoul.prices[0].discountRatePercent, 44);
  assert.equal(seoul.searchContext.checkInDate, null);
  assert.match(seoul.prices[0].priceScope, /stay dates are absent/);
  assert.equal(unavailable.prices.length, 0);
  assert.equal(unavailable.priceUnavailableLabel, '다른 날짜 확인');
});

test('parses keyword search SSR cards with exact date and occupancy context', async () => {
  const html = await fixture('yanolja-hotel-search-results-gangneung.html');
  const parsed = parseYanoljaHotelSearchResults(html, {
    url: 'https://nol.yanolja.com/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION?q=%EA%B0%95%EB%A6%89',
    checkedAt: '2026-10-04T22:51:00.000Z',
  });
  const hotel = parsed.cards.find(card => card.hotelId === '3013417');

  assert.equal(parsed.search.keyword, '강릉');
  assert.equal(parsed.totalResultCount, 898);
  assert.deepEqual(parsed.page, { isLast: false, currentPage: 1, totalPages: 45 });
  assert.equal(parsed.returnedCardCount, 8);
  assert.equal(hotel.title, '강릉 세인트존스호텔');
  assert.equal(hotel.sponsored, true);
  assert.equal(hotel.location, '강문해변 인근');
  assert.equal(hotel.reviewScore, 4.7);
  assert.equal(hotel.reviewCount, 13454);
  assert.equal(hotel.prices[0].originalPriceKrw, 129000);
  assert.equal(hotel.prices[0].salePriceKrw, 119000);
  assert.equal(hotel.prices[0].discountRatePercent, 7);
  assert.equal(hotel.prices[0].checkInTime, '16:00');
  assert.equal(hotel.searchContext.checkInDate, '2026-10-05');
  assert.equal(hotel.searchContext.checkOutDate, '2026-10-06');
  assert.equal(hotel.searchContext.adultCount, 2);
  assert.equal(parsed.coverage.paginationReplayed, false);
  assert.equal(hotel.prices[0].taxesIncluded, null);
});

test('omits opaque filter values from the parsed record', async () => {
  const html = await fixture('yanolja-hotel-search-results-gangneung.html');
  const opaque = 'opaque-filter-test-value';
  const parsed = parseYanoljaHotelSearchResults(html, {
    url: `https://nol.yanolja.com/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION?filter=${opaque}&q=%EA%B0%95%EB%A6%89`,
  });
  const serialized = JSON.stringify(parsed);

  assert.equal(parsed.search.filterParameter.present, true);
  assert.equal(parsed.search.filterParameter.length, opaque.length);
  assert.equal(serialized.includes(opaque), false);
  assert.equal(serialized.includes('filter (opaque; value omitted)'), true);
});

test('search client uses the observed canonical Document GET without browser or credential headers', async () => {
  const html = (await fixture('yanolja-hotel-search-results-gangneung.html'))
    .replace('<body>', '<body><nav><a href="/login">Sign in</a></nav>');
  let observed;
  const read = await fetchYanoljaHotelSearch({
    keyword: '강릉',
    fetchImpl: async (url, options) => {
      observed = { url: String(url), options };
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  const requested = new URL(observed.url);

  assert.equal(requested.pathname, '/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION');
  assert.deepEqual([...requested.searchParams.keys()], ['q']);
  assert.equal(requested.searchParams.get('q'), '강릉');
  assert.equal(observed.options.method, 'GET');
  assert.equal(observed.options.headers['user-agent'], undefined);
  assert.equal(observed.options.headers.cookie, undefined);
  assert.equal(read.metadata.status, 200);
  assert.equal(read.result.returnedCardCount, 8);
  assert.deepEqual(read.metadata.challengeScan, {
    performed: true,
    detector: 'yanolja-public-document-strong-markers-v1',
    detected: false,
    signals: [],
    bodyCharactersScanned: read.metadata.challengeScan.bodyCharactersScanned,
  });
});

test('rejects a streamed response over the byte cap, cancels it, and returns a fixed-size error', async () => {
  let cancelled = false;
  const oversizedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(YANOLJA_MAX_DOCUMENT_BYTES + 1));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchYanoljaHotelSearch({
    keyword: '강릉',
    fetchImpl: async () => new Response(oversizedBody, {
      status: 200,
      headers: { 'content-type': `text/html; ${'x'.repeat(5000)}` },
    }),
  }), error => {
    assert.equal(error.code, 'YANOLJA_HOTEL_RESPONSE_TOO_LARGE');
    assert.equal(error.message, 'Yanolja hotel Document exceeded the configured response byte limit');
    assert.equal(error.metadata.maxBytes, YANOLJA_MAX_DOCUMENT_BYTES);
    assert.equal(error.metadata.bytesRead, YANOLJA_MAX_DOCUMENT_BYTES + 1);
    assert.equal(error.metadata.contentType.length, 128);
    assert.equal(JSON.stringify(error).includes('<html'), false);
    return true;
  });
  assert.equal(cancelled, true);
});

test('rejects an HTTP 200 challenge fixture before the hotel listing parser runs', async () => {
  const html = await fixture('yanolja-challenge-200.html');
  await assert.rejects(fetchYanoljaHotelSearch({
    keyword: '강릉',
    fetchImpl: async () => new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  }), error => {
    assert.equal(error.code, 'YANOLJA_HOTEL_CHALLENGE_PAGE');
    assert.equal(error.metadata.status, 200);
    assert.deepEqual(error.metadata.challengeScan.signals, ['strong-title-marker', 'strong-body-marker']);
    assert.equal(error.metadata.challengeScan.detected, true);
    return true;
  });
});

test('flags a changed search page instead of returning an empty success', () => {
  assert.throws(() => parseYanoljaHotelSearchResults('<html><head><title>wrong</title></head><body></body></html>', {
    url: 'https://nol.yanolja.com/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION?q=%EA%B0%95%EB%A6%89',
  }), /does not match the observed result Document/);
});
