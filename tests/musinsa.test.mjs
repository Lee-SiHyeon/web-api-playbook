import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CM29_CATEGORY_CODES, cm29BestUrl, cm29ImageSet, cm29ProductFromPage, createCm29Client, parseBestItems, parseListing, parseProductDetail,
  parseProductOptions,
} from '../lib/commerce/29cm.mjs';
import { createFashionHttp } from '../lib/commerce/fashion-http.mjs';
import { downloadImageSet } from '../lib/commerce/fashion-images.mjs';
import {
  MUSINSA_CATEGORY_CODES, musinsaImageSet, musinsaRankingUrl, parseGoodsDetail, parseGoodsOptions, parseRankingSection, parseSearchList,
} from '../lib/commerce/musinsa.mjs';

const noSleep = async () => {};

test('musinsa ranking URL uses section 199 women filter and period codes', () => {
  const u = new URL(musinsaRankingUrl({ categoryCode: '001000', period: 'weekly', startRank: 1 }));
  assert.equal(u.hostname, 'client.musinsa.com');
  assert.equal(u.pathname, '/api/home/web/v5/pans/ranking/sections/199');
  assert.equal(u.searchParams.get('gf'), 'F');
  assert.equal(u.searchParams.get('period'), 'WEEKLY');
  assert.equal(u.searchParams.get('eventPeriod'), 'BASIC_WEEKLY');
  assert.equal(u.searchParams.get('categoryCode'), '001000');
  assert.equal(u.searchParams.get('soldOut'), 'false');
  assert.equal(u.searchParams.get('offset'), '0');
  assert.equal(MUSINSA_CATEGORY_CODES.sunglasses, '101003');
  assert.throws(() => musinsaRankingUrl({ categoryCode: '001000', period: 'monthly' }), { code: 'MUSINSA_PERIOD_INVALID' });
});

const rankingFixture = (ranks, extra = {}) => ({
  data: {
    modules: [
      { type: 'SUB_PLATE', items: [] },
      {
        type: 'MULTICOLUMN',
        items: ranks.map((rank, i) => ({
          type: 'PRODUCT_COLUMN', id: String(7000000 + i),
          image: { rank, url: `https://image.msscdn.net/images/goods_img/x/${i}.jpg` },
          info: { brandName: '브랜드', productName: `상품 ${i}`, finalPrice: 10000 + i, discountRatio: 5, isSoldOut: false },
          onClick: { eventLog: { amplitude: { payload: { original_price: '20000', reviewCount: i === 0 ? '0' : '12', reviewScore: i === 0 ? '0' : '98' } } } },
        })),
      },
    ],
  },
  link: extra.link,
});

test('parseRankingSection keeps displayed ranks and nulls satisfaction when there are no reviews', () => {
  const parsed = parseRankingSection(rankingFixture([1, 2], { link: { next: 'https://client.musinsa.com/api/home/web/v5/pans/ranking/sections/199?page=2&startRank=102&offset=101' } }));
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].rank, 1);
  assert.equal(parsed.items[0].productUrl, 'https://www.musinsa.com/products/7000000');
  assert.equal(parsed.items[0].reviewCount, 0);
  assert.equal(parsed.items[0].satisfactionPercent, null);
  assert.equal(parsed.items[1].satisfactionPercent, 98);
  assert.deepEqual(parsed.items[1].price, { final: 10001, original: 20000, discountRate: 5 });
  assert.match(parsed.nextUrl, /startRank=102/);
});

test('parseRankingSection rejects duplicate ranks and foreign next links', () => {
  assert.throws(() => parseRankingSection(rankingFixture([1, 1])), { code: 'MUSINSA_RANK_INVALID' });
  const parsed = parseRankingSection(rankingFixture([1], { link: { next: 'https://evil.example/x' } }));
  assert.equal(parsed.nextUrl, null);
});

test('parseSearchList maps goods cards and keeps the server next page link', () => {
  const parsed = parseSearchList({
    data: {
      list: [{ goodsNo: 4636893, goodsName: 'Dress', brandName: '루루서울', brand: 'loulouseoul', finalPrice: 108000, normalPrice: 108000, couponPrice: null, saleRate: 0, isSoldOut: false, thumbnail: 'https://image.msscdn.net/a.jpg', reviewCount: 98, reviewScore: 98, isAd: false }],
      pagination: { totalCount: 235, page: 1, nextPageUrl: 'https://api.musinsa.com/api2/dp/v2/plp/goods?page=2&hmacId=abc' },
    },
  });
  assert.equal(parsed.totalCount, 235);
  assert.equal(parsed.items[0].productUrl, 'https://www.musinsa.com/products/4636893');
  assert.equal(parsed.items[0].satisfactionPercent, 98);
  assert.equal(parsed.nextUrl, 'https://api.musinsa.com/api2/dp/v2/plp/goods?page=2&hmacId=abc');
});

test('parseGoodsDetail normalizes protocol-relative images and keeps only selected material attributes', () => {
  const goods = parseGoodsDetail({
    data: {
      goodsNo: 6704396, goodsNm: 'Knit', thumbnailImageUrl: '/images/goods_img/t.jpg',
      goodsImages: [{ imageUrl: '/images/prd_img/g1.jpg' }, { imageUrl: '/images/prd_img/g2.jpg' }],
      goodsContents: '<img alt="" src="//image.msscdn.net/images/prd_img/d1.jpg"><img src="https://cdn.example.com/d2.png">',
      goodsReview: { totalCount: 124, satisfactionScore: 4.9 },
      goodsMaterial: { materials: [{ name: '핏', items: [{ name: '루즈', isSelected: true }, { name: '슬림', isSelected: false }] }, { name: '두께', items: [{ name: '보통', isSelected: false }] }] },
      brand: 'x', brandInfo: { brandName: '무신사 스탠다드 우먼' }, category: { categoryDepth1Title: '상의', categoryDepth2Title: '후드' },
    },
  });
  assert.equal(goods.images.thumbnail, 'https://image.msscdn.net/images/goods_img/t.jpg');
  assert.deepEqual(goods.images.gallery, ['https://image.msscdn.net/images/prd_img/g1.jpg', 'https://image.msscdn.net/images/prd_img/g2.jpg']);
  assert.deepEqual(goods.images.description, ['https://image.msscdn.net/images/prd_img/d1.jpg', 'https://cdn.example.com/d2.png']);
  assert.deepEqual(goods.materialAttributes, [{ name: '핏', selected: ['루즈'] }]);
  assert.equal(goods.reviews.satisfactionScore, 4.9);
  assert.equal(goods.category.depth1, '상의');
  assert.equal(musinsaImageSet(goods).length, 1 + 2 + 2);
});

test('parseGoodsOptions lists groups, color names and combined variant labels', () => {
  const options = parseGoodsOptions({
    data: {
      basic: [
        { name: '컬러', displayType: 'COLOR_CHIP', optionValues: [{ name: '블랙', isDeleted: false }, { name: '크림', isDeleted: false }] },
        { name: '사이즈', displayType: 'DROPDOWN', optionValues: [{ name: 'S' }, { name: 'M', isDeleted: true }] },
      ],
      optionItems: [
        { managedCode: '블랙^S', price: 0, activated: true, isDeleted: false, optionValues: [{ name: '블랙' }, { name: 'S' }] },
        { managedCode: '크림^S', price: 3000, activated: false, isDeleted: true, optionValues: [{ name: '크림' }, { name: 'S' }] },
      ],
    },
  });
  assert.deepEqual(options.colors, ['블랙', '크림']);
  assert.deepEqual(options.groups[1].values, ['S']);
  assert.deepEqual(options.variants, [{ label: '블랙 / S', managedCode: '블랙^S', additionalPrice: 0, activated: true }]);
});

test('29CM best items: list order is the rank, images are absolute, categories are the documented codes', () => {
  assert.equal(new URL(cm29BestUrl({ categoryCode: CM29_CATEGORY_CODES.dress, period: 'daily' })).searchParams.get('periodSort'), 'ONE_DAY');
  const items = parseBestItems({
    data: {
      content: [
        { itemNo: 4234558, itemName: 'Jacket', frontBrandNameKor: '비터셀즈', lastSalePrice: 107100, consumerPrice: 119000, lastSalePercent: 10, reviewCount: 2, reviewAveragePoint: 5, imageUrl: '/item/202610/a.jpg', isSoldOut: false, heartCount: 10843, frontCategoryInfo: [{ category1Name: '여성의류', category2Name: '아우터', category3Name: '플리스' }] },
        { itemNo: 4099024, itemName: 'Knit', frontBrandNameKor: '플리즈프로젝트', lastSalePrice: 53100, consumerPrice: 59000, lastSalePercent: 10, reviewCount: 45, reviewAveragePoint: 5, imageUrl: '/item/202608/b.jpg', isSoldOut: false, heartCount: 534, frontCategoryInfo: [] },
      ],
    },
  }, { limit: 1 });
  assert.equal(items.length, 1);
  assert.equal(items[0].rank, 1);
  assert.equal(items[0].image, 'https://img.29cm.co.kr/item/202610/a.jpg');
  assert.equal(items[0].productUrl, 'https://www.29cm.co.kr/products/4234558');
  assert.equal(items[0].category.depth3, '플리스');
});

test('29CM listing drops ads and maps display and original prices', () => {
  const parsed = parseListing({
    data: {
      list: [
        { itemId: 4000383, itemInfo: { productName: '비키니', brandName: '바이누', brandId: 18895, displayPrice: 97580, originalPrice: 119000, saleRate: 18, thumbnailUrl: 'https://img.29cm.co.kr/item/x.jpg', isSoldOut: false, reviewScore: 5, reviewCount: 30, likeCount: 10695 }, itemEvent: { eventProperties: { isAd: false } } },
        { itemId: 1, itemInfo: { productName: 'ad' }, itemEvent: { eventProperties: { isAd: true } } },
      ],
      pagination: { totalCount: 2738, page: 1, hasNext: true },
    },
  });
  assert.equal(parsed.items.length, 1);
  assert.deepEqual(parsed.items[0].price, { final: 97580, normal: 119000, discountRate: 18 });
  assert.equal(parsed.hasNext, true);
});

test('29CM product page DTO is resolved from React Flight rows', () => {
  const rows = [
    '1:["$2"]',
    '2:{"itemNo":4000383,"itemName":"비키니","sellPrice":119000,"consumerPrice":119000,"discountRate":0,"itemDescriptions":"<img src=\\"//img.29cm.co.kr/d.jpg\\">","itemImages":"$3","itemDetailsList":"$4","frontBrand":"$5","frontCategoryInfo":[{"category1Name":"레저","category2Name":"수영","category3Name":"비키니"}],"reviewAggregation":{"totalCount":30,"averagePoint":5,"totalPhotoReviewCount":22},"frontItemStockStatus":"ON_STOCK","badge":[]}',
    '3:[{"imageUrl":"/item/202605/a.jpg"}]',
    '4:[{"itemDetailsTitles":"제품 소재","itemDetailsValue":"상세 페이지 참고"}]',
    '5:{"brandNameKor":"바이누","brandNameEng":"bynoo","frontBrandNo":18895}',
  ].join('\n');
  const html = `<html><script>self.__next_f.push([1,${JSON.stringify(rows)}])</script></html>`;
  const product = cm29ProductFromPage(html, 4000383);
  assert.equal(product.itemImages[0].imageUrl, '/item/202605/a.jpg');
  const detail = parseProductDetail({ data: product });
  assert.equal(detail.brand.english, 'bynoo');
  assert.deepEqual(detail.images.gallery, ['https://img.29cm.co.kr/item/202605/a.jpg']);
  assert.deepEqual(detail.images.description, ['https://img.29cm.co.kr/d.jpg']);
  assert.equal(detail.specs[0].title, '제품 소재');
  assert.equal(cm29ProductFromPage(html, 1), null);
  assert.deepEqual(parseProductOptions({ data: { layout: ['SIZE'], list: [{ title: 'FREE', frontOptionStockStatus: 'ON_STOCK', sellPrice: 0, isLimitedQty: true }] } }).variants[0].label, 'FREE');
  assert.equal(cm29ImageSet(detail).length, 2);
});

test('fashion HTTP stops on 403 and 429 without retry, and rejects hosts outside the allowlist', async () => {
  let calls = 0;
  const fetch403 = async () => { calls++; return new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }); };
  const http = createFashionHttp({ service: 'musinsa', allowedHosts: ['client.musinsa.com'], minIntervalMs: 0, fetchImpl: fetch403, sleep: noSleep });
  await assert.rejects(http.request('https://client.musinsa.com/a'), { code: 'MUSINSA_HTTP_ERROR', httpStatus: 403 });
  assert.equal(calls, 1);
  assert.equal(http.receipts[0].cookieSent, false);
  assert.equal(http.receipts[0].credentialsUsed, false);
  await assert.rejects(http.request('https://evil.example/a'), { code: 'MUSINSA_ORIGIN_INVALID' });
  const http429 = createFashionHttp({ service: 'musinsa', allowedHosts: ['client.musinsa.com'], minIntervalMs: 0, fetchImpl: async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }), sleep: noSleep });
  await assert.rejects(http429.request('https://client.musinsa.com/a'), { code: 'MUSINSA_RATE_LIMITED' });
});

test('fashion HTTP paces requests to the minimum interval', async () => {
  const waits = [];
  let clock = 1_000_000;
  const http = createFashionHttp({
    service: 'musinsa', allowedHosts: ['client.musinsa.com'], minIntervalMs: 3000,
    fetchImpl: async () => new Response('{"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } }),
    sleep: async ms => { waits.push(ms); clock += ms; }, now: () => clock,
  });
  await http.request('https://client.musinsa.com/a');
  await http.request('https://client.musinsa.com/b');
  assert.deepEqual(waits, [3000]);
});

test('29CM client rejects unknown sort values before any request', async () => {
  let calls = 0;
  const client = createCm29Client({ fetchImpl: async () => { calls++; return new Response('{}'); }, minIntervalMs: 3000, sleep: noSleep });
  await assert.rejects(client.search({ keyword: '비키니', sort: 'POPULAR' }), { code: 'CM29_SORT_INVALID' });
  assert.equal(calls, 0);
});

test('image download writes only image types into the given local folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'musinsa-test-'));
  try {
    const fetchImpl = async url => {
      if (String(url).endsWith('/html')) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    const result = await downloadImageSet({
      items: [{ url: 'https://image.msscdn.net/a.jpg', kind: 'gallery' }, { url: 'https://image.msscdn.net/html', kind: 'desc' }, { url: 'http://insecure.example/x.jpg', kind: 'desc' }],
      dir, prefix: '6704396', fetchImpl, sleep: noSleep, minIntervalMs: 0,
    });
    assert.equal(result.saved.length, 1);
    assert.equal(result.saved[0].file, '6704396-01-gallery.jpg');
    assert.deepEqual(result.skipped.map(s => s.code), ['IMAGE_TYPE_REJECTED', 'IMAGE_URL_INVALID']);
    assert.equal((await readFile(path.join(dir, result.saved[0].file))).length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
