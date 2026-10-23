import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, fromHomeplus, fromLotteon, fromGmarket, kurlyOptions, PROCESSED, multiCut, summarize, collect, briefFrom } from '../research/content-store/grocery-compare.mjs';

const NOW = '2026-09-26T07:30:00Z';

test('name parsing: weight with pack counts, option lists, origin, storage and cut', () => {
  assert.equal(parseName('잡내없는 암돼지 삼겹살 500g x 2팩').grams, 1000);
  assert.equal(parseName('옛날 대패삼겹살 1kg 2팩').grams, 2000);
  const opt = parseName('[KF365] 한돈 삼겹살 구이용 600g/1kg (냉장)');
  assert.equal(opt.weightAmbiguous, true);
  assert.equal(opt.origin, 'domestic');
  assert.equal(opt.storage, 'chilled');
  assert.equal(parseName('덴마크산 초간편 냉동 대패삼겹살 800G(봉)').origin, 'imported');
  assert.equal(parseName('덴마크산 초간편 냉동 대패삼겹살 800G(봉)').cut, 'thin_sliced');
  assert.ok(PROCESSED.test('보먹돼 양념 숯불 벌집 삼겹살 600G'));
  assert.equal(multiCut('한돈 삼겹살/목살/항정살 택1', '삼겹살'), true);
  assert.equal(multiCut('한돈 삼겹살 구이용 1kg', '삼겹살'), false);
});

test('홈플러스: card discounts are left out of the comparison price, item discounts count, per-100 g from unit data', () => {
  const card = fromHomeplus({ itemNo: '1', itemNm: '보먹돼 삼겹살 100G/돼지고기', salePrice: 2760, dcPrice: 1650, dcType: 'CARD_DISCOUNT_PRICE',
    dcTooltip: { itemDcPrice: null, cardDcPrice: -1110, dcCardText: '7대 카드할인행사중', dcDateText: '2026.09.26 ~ 2026.09.30' },
    unitMeasure: 'G', totalUnitQty: 100, purchaseMinQty: 10, grade: 4.7, reviewCnt: 131615, deliveryLabelList: ['4만원↑무료배송'], storeType: 'HYPER' }, NOW);
  assert.equal(card.price, 2760);
  assert.equal(card.cardPrice, 1650);
  assert.equal(card.per100g, 2760);
  assert.equal(card.minOrderGrams, 1000);
  const item = fromHomeplus({ itemNo: '2', itemNm: '한돈 일품포크 삼겹살 100G/돼지고기', salePrice: 3800, dcPrice: 2660, dcType: 'ITEM_DISCOUNT_PRICE',
    dcTooltip: { itemDcPrice: -1140 }, unitMeasure: 'G', totalUnitQty: 100, purchaseMinQty: 6, grade: 4.6, reviewCnt: 70742 }, NOW);
  assert.equal(item.price, 2660);
  assert.equal(item.per100g, 2660);
});

test('롯데ON and 컬리 options', () => {
  const lo = fromLotteon({ sitmId: 'LO1_2', pdName: '한돈 삼겹살 500g x 2팩', pdLink: '/product/LO1', priceInfo: { finalPrice: '20000', original: '25000' },
    additionalFlagList: [{ type: 'DF', name: '3,000' }], brazeData: { categoryName: '국내산', reviewCount: 120, reviewScore: 4.8 } }, NOW);
  assert.equal(lo.per100g, 2000);
  assert.equal(lo.shipping, '배송비 3,000원');
  assert.equal(lo.origin, 'domestic');
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { product: { reviewCount: 131093, dealProducts: [
    { no: 1, name: '[KF365] 한돈 삼겹살 구이용 600g (냉장)', basePrice: 16900, retailPrice: 21200, isSoldOut: false, unitPriceText: '100g 당 2,817원' },
    { no: 2, name: '[KF365] 한돈 삼겹살 구이용 1kg (냉장)', basePrice: 25900, retailPrice: 34900, isSoldOut: false }] } } } })}</script>`;
  const base = { id: 'kurly:5056512', mall: 'kurly', reviews: 9999, reviewsCapped: true, origin: 'domestic', storage: 'chilled' };
  const opts = kurlyOptions(html, base);
  assert.deepEqual(opts.map(o => o.per100g), [2817, 2590]);
  assert.equal(opts[0].reviews, 131093);
  assert.equal(opts[0].reviewsCapped, false);
});

test('summary: segments are compared within themselves; trusted picks need enough reviews and rating', () => {
  const o = (mall, name, per100g, reviews, rating, extra = {}) => ({ mall, name, per100g, reviews, rating, url: `https://x/${name}`, ...parseName(name), ...extra });
  const s = summarize([
    o('homeplus', '한돈 삼겹살 100G', 2660, 70000, 4.6),
    o('lotteon', '한돈 삼겹살 1kg', 1900, 3, 5),
    o('lotteon', '스페인산 냉동 삼겹살 1kg', 1100, 200, 4.7),
    o('homeplus', '덴마크산 냉동 대패삼겹살 800G', 1485, 7767, 4.8)]);
  const dom = s.segments.find(x => x.id === 'domestic_chilled');
  assert.equal(dom.cheapestAny.per100g, 1900);
  assert.equal(dom.cheapestTrusted.per100g, 2660, 'three reviews are not enough to recommend');
  assert.equal(s.segments.find(x => x.id === 'imported').offers, 1);
  assert.equal(s.segments.find(x => x.id === 'thin_sliced').offers, 1);
});

test('injected offline runner does not auto-call live Gmarket while 11st stays in the direct HTTP path', async () => {
  const requested = [];
  const unavailable = async url => { requested.push(String(url)); throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); };
  const r = await collect('삼겹살', { fetchImpl: unavailable, sleepImpl: async () => {} });
  assert.ok(!requested.some(url => /gmarket\.co\.kr/.test(url)));
  assert.ok(requested.some(url => /apis\.11st\.co\.kr/.test(url)));
  assert.equal(r.sites.gmarket, undefined);
  assert.equal(r.sites.elevenst.error, 'OFFLINE');
  assert.ok(r.excluded.some(x => x.site === 'G마켓'));
  assert.ok(!r.excluded.some(x => x.site === '11번가'));
  assert.doesNotMatch(briefFrom(r, summarize(r.offers)).headline, /G마켓/);
});

test('Coupang Partners stays off by default even when a reader is available', async () => {
  const requested = [];
  let partnerCalls = 0;
  const unavailable = async url => { requested.push(String(url)); throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); };
  const r = await collect('삼겹살', { fetchImpl: unavailable, sleepImpl: async () => {}, includeGmarket: false,
    includeCoupangDanawa: false, coupangPartnersRead: async () => { partnerCalls++; throw new Error('unexpected partner call'); } });

  assert.equal(partnerCalls, 0);
  assert.equal(r.sites.coupang, undefined);
  assert.ok(!r.offers.some(offer => offer.via === 'partners_web_search'));
  assert.ok(requested.every(url => !/partners\.coupang\.com/.test(url)));
});

test('Coupang Partners remains available only with explicit opt-in', async () => {
  const requested = [];
  let partnerCalls = 0;
  const unavailable = async url => { requested.push(String(url)); throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); };
  const product = { productId: 'p-1', itemId: 'i-1', vendorItemId: 'v-1',
    title: '한돈 국내산 냉동 삼겹살 1kg', url: 'https://www.coupang.com/vp/products/p-1',
    price: 10000, listPrice: 12000, currency: 'KRW', rating: 4.8, reviewCount: 100, freeShipping: true, soldOut: false };
  const r = await collect('삼겹살', { fetchImpl: unavailable, sleepImpl: async () => {}, includeGmarket: false,
    includeCoupangDanawa: false, includeCoupangPartners: true,
    coupangPartnersRead: async ({ query, limit }) => {
      partnerCalls++;
      assert.equal(query, '삼겹살');
      assert.equal(limit, 36);
      return { products: [product], total: 1, receipt: { credentialPropagated: true, checkedAt: NOW } };
    } });

  assert.equal(partnerCalls, 1);
  assert.equal(r.sites.coupang.via, 'partners_web_search');
  assert.equal(r.sites.coupang.liveReplay, true);
  assert.equal(r.offers.filter(offer => offer.via === 'partners_web_search').length, 1);
  assert.equal(r.offers[0].reviews, null);
  assert.equal(r.offers[0].partnerMetadata.reviewCount, 100);
  assert.ok(summarize(r.offers).segments.every(segment => segment.cheapestTrusted === null && segment.bestReviewed === null));
  assert.ok(requested.every(url => !/partners\.coupang\.com/.test(url)));
});

test('Gmarket protected document results enter the optional collector with coupon prices excluded from picks', async () => {
  const item = (id, priceRequiresCoupon) => ({ productId: String(id), title: `국내산 냉장 삼겹살 500g ${id}`,
    url: `https://item.gmarket.co.kr/Item?goodscode=${id}`, currentPriceKRW: priceRequiresCoupon ? 9000 : 10000,
    originalPriceKRW: 12000, priceRequiresCoupon, shippingText: '배송비 3,500원', shippingFeeKRW: 3500,
    rating: 4.8, reviewCount: 100, soldOut: false, sponsored: false, seller: '테스트', placement: 'organic', dataOrigin: 'next-data' });
  const normalized = fromGmarket(item(1, true), NOW);
  assert.equal(normalized.per100g, 1800);
  assert.equal(normalized.priceRequiresCoupon, true);
  const unavailable = async () => { throw Object.assign(Error(), { code: 'OFFLINE' }); };
  const r = await collect('삼겹살', { fetchImpl: unavailable, sleepImpl: async () => {}, includeGmarket: true,
    gmarketRead: async () => ({ productCount: 2, products: [item(1, true), item(2, false)], pagination: { page: 1 },
      browserUsed: false, state: { credential_propagated: true, live_replay: true } }) });
  assert.equal(r.sites.gmarket.listed, 2);
  assert.equal(r.sites.gmarket.credentialPropagated, true);
  assert.equal(r.offers.length, 2);
  assert.ok(!r.excluded.some(x => x.site === 'G마켓'));
  const summary = summarize(r.offers);
  assert.equal(summary.couponPriceExcluded, 1);
  assert.equal(summary.priced, 1);
  assert.equal(summary.segments.find(x => x.id === 'domestic_chilled').cheapestTrusted.id, 'gmarket:2');
  assert.match(briefFrom(r, summary).headline, /G마켓/);
});

test('Danawa marketplace candidates retain Gmarket and Auction prices without entering recommendations', async () => {
  const unavailable = async () => { throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); };
  const r = await collect('삼겹살', { fetchImpl: unavailable, sleepImpl: async () => {}, includeMarketReference: true,
    marketSearch: async () => ({ results: [{ pcode: '123', name: '수입산 삼겹살 1kg', minPrice: 10000 }] }),
    marketRead: async () => ({ name: '수입산 삼겹살 1kg', pageUrl: 'https://prod.danawa.com/info/?pcode=123', checkedAt: NOW,
      offers: [{ mall: 'G마켓', title: '삼겹살 1kg 3팩', price: 11000, shipping: 0, total: 11000, couponRequired: false },
        { mall: '옥션', title: '수입산 삼겹살 1kg', price: 12000, shipping: 0, total: 12000, couponRequired: false }] }) });
  assert.deepEqual(r.marketReference.marketplaceCounts, { 'G마켓': 1, '옥션': 1 });
  assert.equal(r.marketReference.candidates[0].sizeMatches, false);
  assert.ok(r.marketReference.candidates.every(x => x.sameProductVerified === false && x.eligibleForPicks === false));
  assert.equal(r.offers.length, 0);
  assert.equal(summarize(r.offers).priced, 0);
  assert.equal(briefFrom(r, summarize(r.offers)).evidence.data.marketReference.candidates.length, 2);
});

test('market reference uses the caller HTTP runner and reports transport failure without live fallback', async () => {
  const requested = [];
  const fetchImpl = async url => { requested.push(String(url)); throw new Error('offline'); };
  const r = await collect('삼겹살', { fetchImpl, sleepImpl: async () => {}, includeMarketReference: true });
  assert.ok(requested.some(url => url.startsWith('https://search.danawa.com/?query=')));
  assert.equal(r.marketReference.error, 'TRANSPORT');
  assert.equal(r.marketReference.candidates.length, 0);
});

test('keyword matching ignores spaces and reads a storage-prefixed keyword from the title (냉동삼겹살, 2026-09-27)', async () => {
  const { matchesKeyword, SEGMENTS } = await import('../research/content-store/grocery-compare.mjs');
  assert.ok(matchesKeyword('한돈 냉동 삼겹살 600g', '냉동삼겹살'));
  assert.ok(matchesKeyword('[냉동/스페인산] 만능대패 삼겹살 1kg', '냉동삼겹살'));
  assert.ok(matchesKeyword('국내산 삼겹살(냉동) 1kg', '냉동삼겹살'));
  assert.ok(!matchesKeyword('국내산 냉장 삼겹살 500g', '냉동삼겹살'));
  assert.ok(!matchesKeyword('냉동 목살 1kg', '냉동삼겹살'));
  assert.ok(matchesKeyword('암돼지 삼겹살 500g', '삼겹살'));
  const seg = id => SEGMENTS.find(s => s.id === id).test;
  assert.ok(seg('domestic_frozen')({ origin: 'domestic', storage: 'frozen', cut: 'grill' }));
  assert.ok(!seg('domestic_chilled')({ origin: 'domestic', storage: 'frozen', cut: 'grill' }));
});

test('frozen pork brief names only represented segments and does not compare it to the chilled KAMIS average', () => {
  const offer = { mall: 'elevenst', id: 'elevenst:1', name: '한돈 냉동 삼겹살 600g',
    url: 'https://www.11st.co.kr/products/1', price: 12000, per100g: 2000,
    reviews: 50, rating: 4.8, sponsored: false, priceRequiresCoupon: false,
    ...parseName('한돈 냉동 삼겹살 600g') };
  const run = { keyword: '냉동삼겹살', checkedAt: NOW, offers: [offer], sites: {}, excluded: [], marketReference: null };
  const brief = briefFrom(run, summarize(run.offers));
  assert.match(brief.draftingNotes[0], /국내산 냉동/);
  assert.doesNotMatch(brief.draftingNotes[0], /국내산 냉장/);
  assert.match(brief.draftingNotes.find(note => note.includes('KAMIS')), /냉동·수입 상품의 전국 평균으로 부르지 않는다/);
});

test('쿠팡 prices through Danawa: origin/cut query variants, deduplicated catalogs, cheapest 쿠팡 offer, never a review pick (2026-09-27)', async () => {
  const { collectCoupangViaDanawa, summarize } = await import('../research/content-store/grocery-compare.mjs');
  const searched = [];
  const catalogs = {
    '냉동삼겹살': [{ pcode: 1, name: '하이포크 한돈 냉동 삼겹살 500g' }, { pcode: 2, name: '냉동 삼겹살 양념구이 500g' }],
    '한돈 냉동삼겹살': [{ pcode: 1, name: '하이포크 한돈 냉동 삼겹살 500g' }],
    '수입 냉동삼겹살': [{ pcode: 3, name: '스페인산 냉동 삼겹살 1kg' }],
    '냉동 대패삼겹살': [{ pcode: 4, name: '대패삼겹살 냉동 1kg' }],
  };
  const search = async q => { searched.push(q); return { results: catalogs[q] ?? [] }; };
  const read = async pcode => ({ pageUrl: `https://prod.danawa.com/info/?pcode=${pcode}`, checkedAt: '2026-09-27T07:00:00Z', name: Object.values(catalogs).flat().find(x => x.pcode === pcode).name,
    offers: pcode === 1 ? [{ mall: '쿠팡', price: 18000, shipping: 0 }, { mall: '쿠팡', price: 17310, shipping: 0 }, { mall: '11번가', price: 15000, shipping: 3000 }]
      : pcode === 3 ? [{ mall: 'G마켓', price: 12000, shipping: 0 }] : [{ mall: '쿠팡', price: 10950, shipping: null, shippingText: '무료배송' }] });
  const r = await collectCoupangViaDanawa('냉동삼겹살', { search, read, sleepImpl: async () => {} });
  assert.deepEqual(searched, ['냉동삼겹살', '한돈 냉동삼겹살', '수입 냉동삼겹살', '냉동 대패삼겹살']);
  assert.equal(r.candidates, 3); // pcode 1 once, the 양념 catalog dropped
  assert.deepEqual(r.offers.map(o => [o.danawaPcode, o.price, o.per100g]), [['1', 17310, 3462], ['4', 10950, 1095]]);
  assert.equal(r.offers[0].origin, 'domestic'); assert.equal(r.offers[1].cut, 'thin_sliced');
  const s = summarize(r.offers);
  assert.equal(s.segments.find(x => x.id === 'domestic_frozen').mallBest.coupang.per100g, 3462);
  assert.ok(s.segments.every(x => x.cheapestTrusted === null)); // no reviews → never a pick
});
