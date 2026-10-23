import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPublicPage, isStrongPublicChallenge, safeUrl, textContent, readPublicPage, readPublicResource, publicPageInternals } from '../lib/cps-public-reader.mjs';

test('safeUrl keeps observed HTTP(S) URLs and redacts sensitive query values', () => {
  assert.equal(safeUrl('/goods/42?ref=home&session=secret#details', 'https://shop.example/goods'),
    'https://shop.example/goods/42?ref=home&session=REDACTED');
  assert.equal(safeUrl('javascript:alert(1)', 'https://shop.example/'), null);
  assert.equal(safeUrl('https://user:pass@shop.example/item'), null);
  assert.equal(safeUrl('https://shop.example:8443/item'), null);
});

test('extracts page-linked Product fields, evidence, variants and aggregate reviews', () => {
  const url = 'https://shop.example/product/sku-77';
  const html = `<!doctype html><html><head>
    <title>  무선 이어폰  </title><meta name="description" content="공식 상품 설명">
    <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'Organization', name: '판매자 이름', url: 'https://shop.example/' },
      { '@type': 'Product', '@id': url, url, sku: 'sku-77', name: '무선 이어폰', description: '노이즈 캔슬링', brand: { '@type': 'Brand', name: '예시 브랜드' },
        offers: { '@type': 'Offer', price: '129000', priceCurrency: 'KRW' },
        aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.7', bestRating: '5', reviewCount: '82', ratingCount: 80 },
        hasVariant: [{ '@type': 'Product', sku: 'sku-77-black', name: '블랙' }],
        review: [{ '@type': 'Review', name: '좋아요', reviewBody: '배송이 빨라요', reviewRating: { ratingValue: '5' }, author: { '@type': 'Person', name: '구매자' } }],
      },
      { '@type': 'Product', url: 'https://shop.example/product/other', name: '추천 상품' },
    ] })}</script>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { productId: 'sku-77', accessToken: 'do-not-return', email: 'buyer@example.com' } } })}</script>
    </head><body><a href="/review/sku-77">후기 보기</a><a href="javascript:alert(1)">bad</a></body></html>`;
  const page = { ok: true, url, html, receipt: { id: 'receipt-1' } };
  const result = extractPublicPage(page, { merchantId: 'sample-shop' });

  assert.equal(result.title, '무선 이어폰');
  assert.equal(result.description, '공식 상품 설명');
  assert.deepEqual(result.links.map(link => link.url), ['https://shop.example/review/sku-77']);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0], {
    type: 'RetailProduct', sourceSchemaType: 'Product', sourceLocalId: 'sku-77', title: '무선 이어폰', url,
    description: '노이즈 캔슬링', brand: '예시 브랜드',
    price: { amount: 129000, currency: 'KRW', priceText: '129000' },
    offers: [{ amount: 129000, currency: 'KRW', priceText: '129000', lowPrice: null, highPrice: null, type: 'Offer', availability: 'unknown', seller: null, validFrom: null, validUntil: null, condition: null, url: null }],
    rating: { value: 4.7, best: 5, worst: null, reviewCount: 82, ratingCount: 80 },
    variants: [{ sourceLocalId: 'sku-77-black', title: '블랙', url: null, price: { amount: null, currency: null, priceText: null }, offers: [] }],
    reviewSamples: [{ title: '좋아요', body: null, bodyAvailable: true, rating: 5, publishedAt: null, reviewer: null }],
    evidence: [{ receiptId: 'receipt-1', locator: 'script[type="application/ld+json"]:1', fields: ['type', 'sourceLocalId', 'title', 'description', 'brand', 'price', 'offers', 'rating', 'variants', 'reviewSamples', 'url'] }],
  });
  assert.equal(result.jsonLd.find(row => row.name === '판매자 이름').name, '판매자 이름');
  assert.equal(result.embeddedJson[0].value.props.pageProps.accessToken, '[REDACTED]');
  assert.equal(result.embeddedJson[0].value.props.pageProps.email, '[REDACTED]');
  assert.equal(JSON.stringify(result.jsonLd).includes('구매자'), false);
  assert.equal(JSON.stringify(result.jsonLd).includes('배송이 빨라요'), false);
  assert.equal(result.records[0].reviewSamples[0].body, null);
  assert.equal(result.records[0].reviewSamples[0].bodyAvailable, true);
  assert.equal(result.merchantId, 'sample-shop');
});

test('does not turn homepage organizations or unrelated recommendation products into records', () => {
  const page = {
    url: 'https://shop.example/',
    html: `<script type="application/ld+json">${JSON.stringify({ '@graph': [
      { '@type': 'Organization', name: 'Shop', url: 'https://shop.example/' },
      { '@type': 'Product', name: '추천 상품', url: 'https://shop.example/product/other' },
    ] })}</script>`,
  };
  assert.equal(extractPublicPage(page).records.length, 0);

  const detailPage = { ...page, url: 'https://shop.example/product/current' };
  assert.equal(extractPublicPage(detailPage).records.length, 0);
});

test('keeps a strongly identified homepage Service offering and ignores generic homepage Product nodes', () => {
  const url = 'https://jeju.example/';
  const page = {
    url,
    html: `<script type="application/ld+json">${JSON.stringify({ '@graph': [
      { '@type': 'Organization', name: '제주패스', url },
      { '@type': 'Product', name: '추천 목록 항목', url },
      { '@type': 'Service', '@id': `${url}#service`, url, name: '제주패스 서비스', description: '여행 예약 서비스',
        aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: 230 } },
    ] })}</script>`,
    receipt: { id: 'home-receipt' },
  };
  const result = extractPublicPage(page);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].type, 'ServiceOffering');
  assert.equal(result.records[0].title, '제주패스 서비스');
  assert.equal(result.records[0].rating.reviewCount, 230);
});

test('does not merge products that share a path but have different identity query values', () => {
  const page = {
    url: 'https://shop.example/goods/view.php?goodsNo=42',
    html: `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', '@id': 'https://shop.example/goods/view.php?goodsNo=41',
      url: 'https://shop.example/goods/view.php?goodsNo=41', productGroupID: 'group-41', name: '다른 상품', offers: { price: 10 } })}</script>`,
  };
  assert.equal(extractPublicPage(page).records.length, 0);
});

test('retains aggregate price ranges, every child offer, ProductGroup identity, and variant offers', () => {
  const url = 'https://shop.example/products/group-7';
  const page = {
    url,
    html: `<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', url, productGroupID: 'group-7', name: '상품군',
      offers: { '@type': 'AggregateOffer', lowPrice: '100', highPrice: '200', priceCurrency: 'KRW', offers: [
        { '@type': 'Offer', price: '120', priceCurrency: 'KRW', seller: { name: '판매처 A' } },
        { '@type': 'Offer', price: '180', priceCurrency: 'KRW', seller: { name: '판매처 B' } },
      ] },
      hasVariant: [{ '@type': 'Product', sku: 'group-7-black', name: '검정', offers: { '@type': 'Offer', price: '150', priceCurrency: 'KRW' } }],
    })}</script>`,
  };
  const [record] = extractPublicPage(page).records;
  assert.equal(record.sourceLocalId, 'group-7');
  assert.deepEqual(record.price, { amount: null, currency: 'KRW', priceText: '100–200 KRW' });
  assert.equal(record.offers.length, 3);
  assert.deepEqual(record.offers.map(offer => offer.amount), [null, 120, 180]);
  assert.equal(record.variants[0].sourceLocalId, 'group-7-black');
  assert.equal(record.variants[0].price.amount, 150);
  assert.equal(record.variants[0].offers.length, 1);
});

test('extracts only observed form targets and fields without form values', () => {
  const result = extractPublicPage({
    url: 'https://shop.example/search',
    html: '<form id="search" action="/search" method="get"><input name="keyword" type="search" placeholder="상품 검색"><input name="csrf" type="hidden" value="secret"><button>검색</button></form>',
  });
  assert.deepEqual(result.forms, [{ id: 'search', action: 'https://shop.example/search', method: 'GET', controls: [
    { name: 'keyword', type: 'search', label: '상품 검색', value: null },
    { name: 'csrf', type: 'hidden', label: null, value: null },
    { name: null, type: 'button', label: null, value: null },
  ] }]);
});

test('challenge detection requires strong visible/header evidence, not a generic script mention', () => {
  assert.equal(isStrongPublicChallenge({}, '<html><script>const title="captcha provider"</script><h1>상품 목록</h1></html>'), false);
  assert.equal(isStrongPublicChallenge({}, '<html><title>Just a moment...</title><body>Please wait</body></html>'), true);
  assert.equal(isStrongPublicChallenge({ 'cf-mitigated': 'challenge' }, '<html><title>Store</title></html>'), true);
  assert.equal(isStrongPublicChallenge({}, '<html><title>자동 입력 방지</title><body>확인이 필요합니다.</body></html>'), true);
  assert.equal(isStrongPublicChallenge({}, '<html><title>상품</title><script>const label="자동 입력 방지"</script><body>상품 정보</body></html>'), false);
});

test('textContent decodes HTML text and ignores executable content', () => {
  assert.equal(textContent('<div>상품&nbsp;정보<script>doNotRead()</script><style>.x{}</style></div>'), '상품 정보');
});

test('readPublicPage reports invalid scope without making a request', async () => {
  const result = await readPublicPage('ftp://shop.example/product/1', { allowedHosts: ['shop.example'] });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'HTTP_SCHEME_REJECTED');
  assert.equal(result.blocked, false);
  assert.equal(result.receipt, null);
});

test('allows ordinary port 80 pages in the supplied host scope', () => {
  const validated = publicPageInternals.validateRequestUrl('http://shop.example/product/1', ['shop.example']);
  assert.equal(validated.url.protocol, 'http:');
  assert.equal(publicPageInternals.validateRequestUrl('http://shop.example:8080/product/1', ['shop.example']).error, 'NONSTANDARD_PORT_REJECTED');
});

test('decodes a declared Korean legacy charset and rejects private IPv4 destinations', () => {
  assert.equal(publicPageInternals.decodeHtml(Buffer.from([0xbb, 0xf3, 0xc7, 0xb0]), 'text/html; charset=euc-kr'), '상품');
  assert.equal(publicPageInternals.isPublicIpv4('127.0.0.1'), false);
  assert.equal(publicPageInternals.isPublicIpv4('192.168.1.20'), false);
  assert.equal(publicPageInternals.isPublicIpv4('8.8.8.8'), true);
});

test('requires a supplied host allowlist before any DNS or HTTP work', async () => {
  const result = await readPublicPage('https://shop.example/product/1');
  assert.equal(result.stopReason, 'ALLOWED_HOSTS_REQUIRED');
  assert.equal(result.receipt, null);
});

test('public resources accept only JS or JSON MIME types and keep response text transient', async () => {
  assert.equal(publicPageInternals.isAcceptedResourceMime('application/json'), true);
  assert.equal(publicPageInternals.isAcceptedResourceMime('application/vnd.api+json'), true);
  assert.equal(publicPageInternals.isAcceptedResourceMime('text/javascript'), true);
  assert.equal(publicPageInternals.isAcceptedResourceMime('text/html'), false);
  const result = await readPublicResource('ftp://shop.example/assets/catalog.js', { allowedHosts: ['shop.example'] });
  assert.equal(result.ok, false);
  assert.equal(result.body, null);
  assert.equal(result.stopReason, 'HTTP_SCHEME_REJECTED');
  assert.equal(result.receipt, null);
});
