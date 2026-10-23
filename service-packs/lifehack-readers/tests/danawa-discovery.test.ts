import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDanawaSearch, readDanawaProductOffers, searchDanawaProducts } from '../src/lib/collectors/danawa-discovery.mjs';

import { matchesDanawaDiscoveryTerm, runDanawaDiscoveryCandidate, runDanawaDiscoverySearch } from '../src/lib/product-discovery-core';

const productHtml = `
<script>
var oGlobalSetting = {
  nProductCode: "98765432",
  sProductName: "LG전자 울트라기어 27GP850 (27인치)",
  makerName: "LG전자",
};
var oPriceCompareSetting = { nProductCode: "98765432", sProductFullName: "LG전자 울트라기어 27GP850 (27인치)" };
</script>`;

const mallHtml = `
<h4>일반 전문몰 (3)</h4>
<div class="diff_item row" data-linkProduct="AAA01_123"><div class="d_mall"><img alt="판매처 가"></div><div class="report"></div><em class="prc_c">400,000</em><span class="ship">무료배송</span><div class="info_line">LG전자 울트라기어 27GP850</div></div>
<div class="diff_item row" data-linkProduct="BBB02_456"><div class="d_mall"><img alt="판매처 나"></div><div class="report"></div><em class="prc_c">390,000</em><span class="ship">배송비 3,000원</span><div class="info_line">LG전자 울트라기어 27GP850</div></div>
<div class="diff_item row" data-linkProduct="CCC03_789"><div class="d_mall"><img alt="판매처 다"></div><div class="report"></div><em class="prc_c">380,000</em><span class="ship">배송비 별도</span><div class="info_line">LG전자 울트라기어 27GP850</div></div>
<div class="diff_item row" data-linkProduct="DDD04_111"><div class="d_mall"><img alt="쿠폰 판매처"></div><div class="report"></div><div class="coupon">쿠폰</div><em class="prc_c">100,000</em><span class="ship">무료배송</span><div class="info_line">LG전자 울트라기어 27GP850</div></div>
<input type="hidden" value="end">`;

function response(body: BodyInit | null, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

test('search parser yields bounded exact option pcodes, variants, and prices', () => {
  const html = `
  <script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"url":"https://prod.danawa.com/info/?pcode=98765432","name":"LG전자 울트라기어 27GP850"}]}</script>
  <li id="productItem98765430"><p class="prod_name">LG전자 울트라기어 27GP850</p>
    <ul><li id="productInfoDetail_98765432"><p class="memory_sect"><span class="text">정품</span></p><p class="price_sect"><strong>450,250</strong></p></li>
    <li id="productInfoDetail_98765433"><p class="memory_sect"><span class="text">해외구매</span></p><p class="price_sect"><strong>799,000</strong></p></li></ul></li>
  <li id="productItem98765434"><p class="prod_name">삼성전자 Odyssey OLED</p><input id="min_price_98765434" value="1,200,000"></li>`;
  assert.deepEqual(parseDanawaSearch(html), [
    { pcode: '98765432', basePcode: '98765430', name: 'LG전자 울트라기어 27GP850', label: '정품', minPrice: 450250 },
    { pcode: '98765433', basePcode: '98765430', name: 'LG전자 울트라기어 27GP850', label: '해외구매', minPrice: 799000 },
    { pcode: '98765434', basePcode: '98765434', name: '삼성전자 Odyssey OLED', label: null, minPrice: 1200000 },
  ]);
  assert.deepEqual(parseDanawaSearch('<div>검색 결과가 없습니다</div>'), []);
  assert.throws(() => parseDanawaSearch('<html><body>unrecognized page</body></html>'), /DANAWA_SEARCH_SCHEMA/);
});

test('reviewed query identity keeps adjacent product generations out of the discovery queue', () => {
  assert.equal(matchesDanawaDiscoveryTerm('audio-wh1000xm5', 'SONY WH-1000XM5', '정품'), true);
  assert.equal(matchesDanawaDiscoveryTerm('audio-wh1000xm5', 'SONY WH-1000XM4', '정품'), false);
  assert.equal(matchesDanawaDiscoveryTerm('monitor-27gp850', 'LG전자 울트라기어 27GP850 (해외구매)'), true);
  assert.equal(matchesDanawaDiscoveryTerm('storage-990-pro', '삼성전자 990 PRO M.2 NVMe (2TB)'), true);
  assert.equal(matchesDanawaDiscoveryTerm('unreviewed-term', 'any item'), false);
});

test('product reader follows the reviewed search/product/mall hosts and preserves three seller observations', async () => {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const result = await readDanawaProductOffers('98765432', {
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
      return response(init?.method === 'GET' ? productHtml : mallHtml);
    },
    sleepImpl: async () => {},
  });
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['https://prod.danawa.com/info/?pcode=98765432', 'GET'],
    ['https://prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php', 'POST'],
  ]);
  assert.match(calls[1].body ?? '', /pcode=98765432/);
  assert.deepEqual(result, {
    pcode: '98765432',
    name: 'LG전자 울트라기어 27GP850 (27인치)',
    brand: 'LG전자',
    conditions: [],
    offers: [
      { mallCode: 'BBB02', seller: '판매처 나', itemPrice: 390000, shipping: 3000, conditions: [] },
      { mallCode: 'AAA01', seller: '판매처 가', itemPrice: 400000, shipping: 0, conditions: [] },
      { mallCode: 'CCC03', seller: '판매처 다', itemPrice: 380000, shipping: null, conditions: [] },
    ],
  });

  await assert.rejects(searchDanawaProducts('test', { fetchImpl: async () => response('', 302) }), /DANAWA_REDIRECT_REJECTED/);
  await assert.rejects(readDanawaProductOffers('98765432', {
    fetchImpl: async () => response('', 429), sleepImpl: async () => {},
  }), /DANAWA_RATE_LIMITED/);

  const overseasProduct = productHtml.replaceAll('27GP850 (27인치)', '27GP850 (해외구매)');
  const overseas = await readDanawaProductOffers('98765432', {
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => response(init?.method === 'GET' ? overseasProduct : mallHtml),
    sleepImpl: async () => {},
  });
  assert.deepEqual(overseas.conditions, ['해외구매 · 관세·통관비 미확인']);
  assert.ok(overseas.offers.every((offer) => offer.conditions.includes('해외구매 · 관세·통관비 미확인')));
});

function listing(id: string, price: number, url = `https://merchant.example/items/${id}`, title = 'LG전자 울트라기어 27GP850', shipping = '무료배송'): string {
  return `<div class="diff_item row" data-linkProduct="${id}"><div class="d_mall"><img alt="판매처"></div><div class="report"></div><a href="${url}">상품</a><em class="prc_c">${price}</em><span class="ship">${shipping}</span><div class="info_line">${title}</div></div>`;
}

function readListings(html: string) {
  return readDanawaProductOffers('98765432', {
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => response(init?.method === 'GET' ? productHtml : `<h4>일반 전문몰</h4>${html}<input type="hidden" value="end">`),
    sleepImpl: async () => {},
  });
}

test('discovery excludes an ambiguous marketplace instead of choosing its cheapest listing', async () => {
  const result = await readListings(listing('AAA01_123', 100000) + listing('AAA01_456', 200000)
    + listing('BBB02_789', 300000));
  assert.deepEqual(result.offers, [
    { mallCode: 'BBB02', seller: '판매처', itemPrice: 300000, shipping: 0, conditions: [] },
  ]);
});

test('equal prices do not merge different listing IDs, URLs, options, or shipping conditions', async () => {
  const cases = [
    [listing('AAA01_123', 100000), listing('AAA01_456', 100000)],
    [listing('AAA01_123', 100000, 'https://merchant.example/items/a'), listing('AAA01_123', 100000, 'https://merchant.example/items/b')],
    [listing('AAA01_123', 100000), listing('AAA01_123', 100000, undefined, '27GP850 해외구매')],
    [listing('AAA01_123', 100000, undefined, undefined, '배송비 별도'), listing('AAA01_123', 100000, undefined, undefined, '착불 배송')],
  ];
  for (const rows of cases) await assert.rejects(readListings(rows.join('')), /DANAWA_OFFER_AMBIGUOUS/);
});

test('single listings and truly identical duplicate rows remain eligible', async () => {
  const row = listing('AAA01_123', 100000);
  const one = await readListings(row);
  const duplicate = await readListings(row + row);
  assert.deepEqual(duplicate.offers, one.offers);
  assert.deepEqual(one.offers, [
    { mallCode: 'AAA01', seller: '판매처', itemPrice: 100000, shipping: 0, conditions: [] },
  ]);
});

test('search stage sends only six unique, priced exact codes to its fenced persistence RPC', async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === 'claim_danawa_discovery_term') return { data: {
      claimed: true, termKey: 'monitor-27gp850', category: '모니터', query: 'LG 27GP850', leaseToken: 'lease-search-1',
    }, error: null };
    return { data: { queued: (args.p_candidates as unknown[]).length }, error: null };
  };
  const seen = await runDanawaDiscoverySearch({
    rpc,
    search: async () => [
      ...Array.from({ length: 9 }, (_value, index) => ({
        pcode: String(10000000 + index), name: `LG전자 울트라기어 27GP850 Product ${index}`, label: null, minPrice: 1000 + index,
      })),
      { pcode: '20000000', name: 'LG전자 울트라기어 27GP850', label: '중고', minPrice: 100 },
      { pcode: '30000000', name: 'LG전자 울트라기어 27GP850', label: null, minPrice: null },
      { pcode: '10000000', name: 'LG전자 울트라기어 27GP850 duplicate', label: null, minPrice: 50 },
    ],
  });
  assert.deepEqual(seen, { claimed: true, queued: 6, results: 6 });
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[1].name, 'complete_danawa_discovery_term');
  const candidates = rpcCalls[1].args.p_candidates as Array<{ pcode: string }>;
  assert.deepEqual(candidates.map((item) => item.pcode), [
    '10000000', '10000001', '10000002', '10000003', '10000004', '10000005',
  ]);
});

test('candidate stage requires the claimed pcode and commits exact seller evidence without affiliate fabrication', async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === 'claim_danawa_discovery_candidate') return { data: {
      claimed: true, pcode: '98765432', termKey: 'monitor-27gp850', category: '모니터',
      searchName: 'LG전자 울트라기어 27GP850', label: '정품', leaseToken: 'lease-product-1',
    }, error: null };
    return { data: { status: 'registered', slug: 'danawa-98765432', observations: (args.p_result as { offers: unknown[] }).offers.length }, error: null };
  };
  const result = await runDanawaDiscoveryCandidate({
    rpc,
    readProduct: async () => ({
      pcode: '98765432', name: 'LG전자 울트라기어 27GP850 (27인치)', brand: 'LG전자', conditions: [],
      offers: [{ mallCode: 'AAA01', seller: '판매처 가', itemPrice: 400000, shipping: 0, conditions: [] }],
    }),
  });
  assert.deepEqual(result, { claimed: true, registered: true, alreadyRegistered: false, pcode: '98765432',
    slug: 'danawa-98765432', status: 'registered', observations: 1 });
  assert.equal(rpcCalls[1].name, 'complete_danawa_discovery_candidate');
  const productResult = rpcCalls[1].args.p_result as { product: Record<string, unknown>; offers: Array<Record<string, unknown>> };
  assert.deepEqual(productResult, {
    product: { title: 'LG전자 울트라기어 27GP850 (27인치)', brand: 'LG전자', variant: '정품' },
    offers: [{ mallCode: 'AAA01', seller: '판매처 가', itemPrice: 400000, shipping: 0, conditions: [] }],
  });
  assert.equal(JSON.stringify(productResult).includes('affiliate'), false);

  const fenced = await runDanawaDiscoveryCandidate({
    rpc: async (name: string) => name === 'claim_danawa_discovery_candidate'
      ? { data: { claimed: true, pcode: '98765432', termKey: 'monitor-27gp850', category: '모니터', searchName: 'x', label: null, leaseToken: 'lease-2' }, error: null }
      : { data: true, error: null },
    readProduct: async () => ({ pcode: '98765431', name: 'Wrong exact pcode', brand: '', conditions: [], offers: [] }),
  });
  assert.deepEqual(fenced, { claimed: true, failed: true, pcode: '98765432', status: 'retry_scheduled',
    retryScheduled: true, code: 'source_identity_changed' });
});
