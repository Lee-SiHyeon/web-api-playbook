import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { collect, fromElevenst, fromKurly, fromLotteon, fromSsg } from '../../naver-blog-api/research/content-store/grocery-compare.mjs';
import { normalizeCpsRetailOffers } from '../adapters/cps-commerce-ontology.mjs';
import { readCpsProductPage } from '../adapters/cps-product-jsonld.mjs';

const checkedAt = '2026-09-27T00:00:00.000Z';
const fixtureMerchant = { merchant_id: 'fixture', site_name: 'fixture', site_url: 'https://8.8.8.8' };

async function withProductHtml(html, operation) {
  const originalRequest = https.request;
  https.request = (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from([Buffer.from(html)]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8' };
      queueMicrotask(() => onResponse(response));
    };
    return request;
  };
  try {
    return await operation();
  } finally {
    https.request = originalRequest;
  }
}

const cases = [
  {
    label: '11st',
    merchant: { merchant_id: '11st', site_name: '11번가', site_url: 'https://www.11st.co.kr' },
    sourceId: 'elevenst',
    offer: () => fromElevenst({ id: 'p1', title: '상품', sellerLogBody: { link_url: 'https://www.11st.co.kr/products/123' } }, checkedAt),
  },
  {
    label: 'SSG',
    merchant: { merchant_id: 'emart', site_name: '이마트몰', site_url: 'https://www.ssg.com' },
    sourceId: 'ssg',
    offer: () => fromSsg({ itemId: 'p1', itemNm: '상품', itemLnkd: '/item/itemView.ssg?itemId=p1' }, checkedAt),
  },
  {
    label: 'Kurly',
    merchant: { merchant_id: 'kurly', site_name: '컬리', site_url: 'https://www.kurly.com' },
    sourceId: 'kurly',
    offer: () => fromKurly({ no: 'p1', name: '상품', discountedPrice: 1000 }, checkedAt),
  },
  {
    label: 'LotteON',
    merchant: { merchant_id: 'lotteon', site_name: '롯데온', site_url: 'https://www.lotteon.com' },
    sourceId: 'lotteon',
    offer: () => fromLotteon({ pdId: 'p1', pdName: '상품' }, checkedAt),
  },
];

for (const item of cases) {
  test(`${item.label} missing reviews and stock remain unknown`, () => {
    const raw = item.offer();
    const [normalized] = normalizeCpsRetailOffers([raw], {
      merchant: item.merchant, sourceId: item.sourceId, checkedAt,
    });

    assert.deepEqual({
      availability: normalized.offerObservation.availability,
      ratingAggregate: normalized.ratingAggregate,
    }, { availability: 'unknown', ratingAggregate: null });
  });
}

test('scoped product search does not apply grocery-only exclusion rules', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    data: [{ groupName: 'list', items: [{
      id: 'gas-range-1',
      title: '가스레인지 3구',
      sellerLogBody: { link_url: 'https://www.11st.co.kr/products/123' },
      selPrc: 129000,
    }] }],
    totalCount: 1,
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const result = await collect('가스레인지', {
    onlySources: ['elevenst'], fetchImpl, sleepImpl: async () => {},
  });

  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].name, '가스레인지 3구');
});

test('ProductGroup variants retain their identities and variant-specific offers', async () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': 'ProductGroup', '@id': 'https://8.8.8.8/product/phone',
      url: 'https://8.8.8.8/product/phone', name: 'Phone', productGroupID: 'phone-1',
      hasVariant: [
        { '@type': 'Product', sku: 'phone-red', name: 'Phone Red', offers: { '@type': 'Offer', price: '10.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } },
        { '@type': 'Product', sku: 'phone-blue', name: 'Phone Blue', offers: { '@type': 'Offer', price: '11.50', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' } },
      ],
    }],
  })}</script>`;

  const result = await withProductHtml(html, () => readCpsProductPage({
    merchant: fixtureMerchant, productUrl: 'https://8.8.8.8/product/phone', now: () => new Date(checkedAt),
  }));

  assert.deepEqual(result.productVariants?.map(variant => variant.variantLocalId), ['phone-red', 'phone-blue']);
  assert.deepEqual(result.offerObservations?.map(offer => [offer.variantLocalId, offer.amountMinor, offer.currency]), [
    ['phone-red', 1000, 'USD'], ['phone-blue', 1150, 'USD'],
  ]);
});

test('three-decimal currencies use their ISO minor-unit precision', async () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product',
    url: 'https://8.8.8.8/product/coin', name: 'Coin',
    offers: { '@type': 'Offer', price: '1.234', priceCurrency: 'KWD' },
  })}</script>`;

  const result = await withProductHtml(html, () => readCpsProductPage({
    merchant: fixtureMerchant, productUrl: 'https://8.8.8.8/product/coin', now: () => new Date(checkedAt),
  }));

  assert.equal(result.offerObservations[0].amountMinor, 1234);
  assert.equal(result.offerObservations[0].currency, 'KWD');
});
