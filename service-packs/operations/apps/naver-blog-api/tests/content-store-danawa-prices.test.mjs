import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDanawaSearch, parseDanawaProductPage, parseDanawaMallList, compareToMarket, matchDanawaResult, danawaQuery, fetchDanawaOffers }
  from '../research/content-store/danawa-prices.mjs';
import { checkGoldboxAgainstMarket, naverSameProduct, priceVerdict, selectGoldboxGeneralPrice,
  COUPANG_SHIPPING_READ_MINIMUM_PRICE_KRW } from '../research/content-store/goldbox-market-check.mjs';

// Trimmed from the 2026-09-24 responses (search.danawa.com, prod.danawa.com/info, getAllPriceCompareMallList.ajax.php).
const searchItem = (pcode, name, options) => `<li class="prod_item prod_layer" id="productItem${pcode}">
  <input type="hidden" id="min_price_${pcode}" value="${options[0]?.[2] ?? 0}" />
  <p class="prod_name"><a href="https://prod.danawa.com/info/?pcode=${pcode}">${name}</a></p>
  <div class="prod_pricelist"><ul>${options.map(([p, label, price]) => `<li id="productInfoDetail_${p}">
    <p class="price_sect"><a href="x"><strong>${price.toLocaleString('en-US')}</strong>원</a></p>
    <p class="memory_sect"><span class="rank">1위</span><span class="text"> ${label} </span></p></li>`).join('')}</ul></div></li>`;
const SEARCH = `<ul class="product_list">
${searchItem(18231185, '<b>미쟝센</b> <b>퍼펙트</b> <b>오리지널</b> <b>세럼</b> <b>200ml</b>', [[18231185, '1개', 14260], [27856208, '2개', 35400]])}
${searchItem(122665999, '<b>미쟝센</b> 퍼펙트 오리지널 <b>헤어</b> 세럼 200ml+80ml', [])}
</ul>`;
const LD_SEARCH = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[
  {"@type":"ListItem","name":"존바바토스 아티산 EDT (75ml)","url":"https://prod.danawa.com/info/?pcode=1612191"},
  {"@type":"ListItem","name":"존바바토스 아티산 블루 EDT (75ml)","url":"https://prod.danawa.com/info/?pcode=3812841"}]}</script>
${searchItem(1612191, '<b>존</b><b>바바토스</b> <b>아티산</b> EDT', [[1612191, '75ml', 25930]])}
${searchItem(3812841, '<b>존</b><b>바바토스</b> <b>아티산</b> 블루 EDT', [[3812841, '75ml', 32760]])}`;
const PRODUCT_PAGE = `<script>
  var oGlobalSetting = {
    nProductCode: 1612191,
    sProductName: "\\uc874\\ubc14\\ubc14\\ud1a0\\uc2a4 \\uc544\\ud2f0\\uc0b0 EDT (75ml)",
    nCategoryCode: "1833839", nCategoryCode1: "9875", nCategoryCode2: "228079", nCategoryCode3: "228424", nCategoryCode4: "0",
    sKeyword: "", nMinPrice: "25,930", makerCode: "24802", makerName: "\\uc874\\ubc14\\ubc14\\ud1a0\\uc2a4",
    powerLinkKeyword: "남자향수", sNaPm: ""
  };
  var oPriceCompareSetting = {
    sLoginUrl: "https://auth.danawa.com/login", sSortType: "warranty", sProductFullName: "존바바토스 아티산 EDT (75ml)",
    bWarrantyDefaultYN: "Y", nOpenMarketMoreCount: "50", bCoupangSortYN: "N"
  };
</script>`;
const row = (link, mall, price, ship, title) => `<div class="diff_item " data-linkProduct="${link}"><div class="diff_box">
  <div class="d_mall"><a href="x"><img src="//img.danawa.com/${link}.gif" alt="${mall}"></a><div class="report"></div></div>
  <div class="d_dsc"><div class="prc_line"><a href="x"><span class="price"><em class="prc_c">${price}</em>원</span></a>
  <span class="ship">${ship}</span></div><div class="info_line"><a href="x" class="link">${title}</a></div></div></div></div>`;
const MALLS = `<div class="diff_list"><div class="diff_tit"><h4>백화점 / 홈쇼핑 / 종합몰</h4></div>
${row('TLC16_LE1', '롯데ON', '50,870', '(배송비 3,000원)', '[롯데백화점] 존바바토스 아티산 EDT 75ml')}
${row('TLC16_LE1', '롯데백화점', '50,870', '(배송비 3,000원)', '[롯데백화점] 존바바토스 아티산 EDT 75ml')}
<input type="hidden" id="openMarketWarrantyCount" value="2"></div>
<div class="diff_list"><div class="diff_tit"><h4>오픈마켓</h4></div>
${row('EE128_4862298917', 'G마켓', '25,930', '(무료배송)', '존바바토스 아티산 오 드 뚜왈렛 75ml')}
${row('EE715_1', '옥션', '29,100', '(무료배송)', '존바바토스 아티산 오 드 뚜왈렛 75ml')}
${row('TH201_1', '11번가', '33,610', '(배송비 3,000원)', '존바바토스 아티산 EDT 75ml')}
${row('TP40F_1', '쿠팡', '24,000', '(배송비 3,000원)', '존바바토스 아티산 오 드 뚜왈렛 75ml 1개')}</div>`;

test('search rows: one per priced option, bold-split names joined, ld+json names preferred', () => {
  const rows = parseDanawaSearch(SEARCH);
  assert.deepEqual(rows.map(r => [r.pcode, r.name, r.label, r.minPrice]), [
    ['18231185', '미쟝센 퍼펙트 오리지널 세럼 200ml', '1개', 14260],
    ['27856208', '미쟝센 퍼펙트 오리지널 세럼 200ml', '2개', 35400],
    ['122665999', '미쟝센 퍼펙트 오리지널 헤어 세럼 200ml+80ml', null, null],
  ]);
  assert.equal(parseDanawaSearch(LD_SEARCH)[0].name, '존바바토스 아티산 EDT (75ml)');
});

test('matching needs brand, the same sizes both ways, the same pack count and a unique best name', () => {
  const m = matchDanawaResult('미쟝센 퍼펙트 오리지널 헤어 세럼, 200ml, 1개', parseDanawaSearch(SEARCH));
  assert.equal(m.pcode, '18231185'); // the 200ml+80ml bundle and the 2개 option are not the same product
  assert.equal(matchDanawaResult('존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', parseDanawaSearch(LD_SEARCH)).pcode, '1612191'); // 블루 costs a point
  assert.equal(matchDanawaResult('미쟝센 퍼펙트 오리지널 헤어 세럼, 200ml, 2개', parseDanawaSearch(SEARCH)).pcode, '27856208');
  assert.equal(matchDanawaResult('미쟝센 퍼펙트 오리지널 헤어 세럼, 200ml, 3개', parseDanawaSearch(SEARCH)), null);
  assert.equal(matchDanawaResult('미쟝센 헤어 세럼', parseDanawaSearch(SEARCH)), null); // no size, no comparison
  const tie = [{ pcode: '1', name: '브랜드 크림 50ml', label: '1개', minPrice: 1 }, { pcode: '2', name: '브랜드 세라 크림 50ml', label: '1개', minPrice: 1 },
    { pcode: '3', name: '브랜드 라이트 크림 50ml', label: '1개', minPrice: 1 }];
  assert.equal(matchDanawaResult('브랜드 크림 세라 라이트, 50ml, 1개', tie), null);
  assert.equal(danawaQuery('존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개'), '존바바토스 아티산 오 드 뚜왈렛 75ml');
});

test('product page yields the same form common.min.js posts', () => {
  const page = parseDanawaProductPage(PRODUCT_PAGE);
  assert.equal(page.pcode, '1612191'); assert.equal(page.name, '존바바토스 아티산 EDT (75ml)'); assert.equal(page.minPrice, 25930);
  assert.equal(page.form.cate3, '228424'); assert.equal(page.form.UICategoryCode, '1833839'); assert.equal(page.form.sSortType, 'warranty');
  assert.equal(page.form.makerName, '존바바토스'); assert.equal('sLoginUrl' in page.form, false);
  assert.throws(() => parseDanawaProductPage('<html>'), /SCHEMA/);
});

test('mall list: mall, price, shipping, section; warranty-section duplicates collapse', () => {
  const offers = parseDanawaMallList(MALLS);
  assert.equal(offers.length, 5);
  assert.deepEqual(offers.find(o => o.mall === 'G마켓'), { mall: 'G마켓', mallCode: 'EE128', price: 25930, shipping: 0, total: 25930, shippingText: '(무료배송)',
    title: '존바바토스 아티산 오 드 뚜왈렛 75ml', section: '오픈마켓', couponRequired: false, warranty: false });
  assert.equal(offers.find(o => o.mall === '11번가').total, 36610);
  assert.equal(offers[0].section, '백화점 / 홈쇼핑 / 종합몰');
});

test('market comparison excludes the seller itself and lists the cheapest shipped offer per mall', () => {
  const offers = parseDanawaMallList(MALLS);
  const c = compareToMarket(31270, offers, { excludeMall: '쿠팡' });
  assert.equal(c.offersCompared, 4); assert.equal(c.lowestOther.mall, 'G마켓'); assert.equal(c.deltaVsLowestTotal, 5340);
  assert.equal(c.cheaperOffers, 2); assert.equal(c.beatsMarket, false);
  assert.deepEqual(c.lowestByMall.map(o => [o.mall, o.total]), [['G마켓', 25930], ['옥션', 29100], ['11번가', 36610], ['롯데ON', 53870]]);
  assert.equal(compareToMarket(25000, offers, { excludeMall: '쿠팡' }).beatsMarket, true);
  // Beating every shipped total is not enough when another mall's item price is lower before shipping.
  assert.equal(compareToMarket(25000, [{ mall: 'A', price: 24000, shipping: 3000, total: 27000 }]).beatsMarket, false);
});

const fakeDanawa = (log = [], mallHtml = MALLS) => async (url, init = {}) => {
  log.push([init.method ?? 'GET', url]);
  if (url.startsWith('https://search.danawa.com/')) return new Response(LD_SEARCH, { status: 200 });
  if (url.startsWith('https://prod.danawa.com/info/?pcode=')) return new Response(PRODUCT_PAGE, { status: 200 });
  if (url.endsWith('getAllPriceCompareMallList.ajax.php')) {
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('pcode'), '1612191'); assert.equal(form.get('makerCode'), '24802');
    assert.equal(init.headers['x-requested-with'], 'XMLHttpRequest');
    return new Response(mallHtml, { status: 200 });
  }
  return new Response('', { status: 404 });
};

// Market-status fixtures need a selected public general quote and shipping bound to that same quote.
// Keep transport mocked and fail if a comparison unexpectedly falls through to a live shipping reader.
const publicQuoteDeal = (salePrice, extra = {}) => {
  const valid = Number.isSafeInteger(salePrice) && salePrice > 0;
  return {
    productId: '1', itemId: '11', vendorItemId: '111', salePrice,
    ...(valid ? {
      publicOfferGeneralPrice: { amount: salePrice, currency: 'KRW', basis: 'public_offer_list' },
      publicOfferGeneralPriceReadStatus: 'matched_public_offer_general_price',
      publicShippingGeneralPrice: { amount: salePrice, currency: 'KRW', basis: 'public_offer_list',
        priceKind: 'offer_list_general_sale_price', source: 'coupang_public_offer_list' },
      shippingReadStatus: 'verified',
      shipping: { fee: { amount: 0, currency: 'KRW', basis: 'public_offer_list', priceKind: 'public_offer_list_shipping_fee' },
        sourceScope: 'consumer_public_offer_list', memberEligibilityVerified: false,
        sourcePaths: ['vendorItemSaleInfo.deliveryFee.shippingFee'] },
    } : {}),
    ...extra,
  };
};
const noShippingRead = async () => assert.fail('the exact public quote fixture must prevent another shipping read');
const selectedSkuShippingRead = async ({ item, generalPrice }) => {
  assert.deepEqual([item.deal.productId, item.deal.itemId, item.deal.vendorItemId, generalPrice.amount], ['p1', 'i1', 'v1', 20000]);
  return { feeKRW: 0, source: 'coupang_public_offer_list', readStatus: 'verified', basis: 'public_offer_list',
    scope: 'consumer_public_offer_list', memberEligibilityVerified: false, status: 200,
    sourcePaths: ['vendorItemSaleInfo.deliveryFee.shippingFee'] };
};

test('fetchDanawaOffers: page then the page\'s own mall-list POST; blocked fails closed', async () => {
  const log = [];
  const r = await fetchDanawaOffers('1612191', { fetchImpl: fakeDanawa(log) });
  assert.equal(r.offers.length, 5); assert.equal(r.receipt.credentialsUsed, false);
  assert.deepEqual(log.map(([m]) => m), ['GET', 'POST']);
  await assert.rejects(fetchDanawaOffers('1612191', { fetchImpl: async () => new Response('', { status: 403 }) }), /ACCESS_BLOCKED/);
  await assert.rejects(fetchDanawaOffers('x'), /PCODE/);
});

test('goldbox check labels beats_market / not_lowest / no_match and stops on a block', async () => {
  const item = (title, salePrice) => ({ title, url: 'https://www.coupang.com/vp/products/1?itemId=11&vendorItemId=111', deal: publicQuoteDeal(salePrice, { eventEnd: '2026-09-24T21:59:59.059Z' }) });
  const rows = await checkGoldboxAgainstMarket([item('존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', 43600), item('존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', 24900),
    item('다른 상품, 10ml, 1개', 1000), item('가격없음, 1개', null)], { fetchImpl: fakeDanawa(), delayMs: 0, shippingReader: noShippingRead });
  assert.deepEqual(rows.map(r => r.status), ['not_lowest', 'beats_market', 'no_match', 'no_price']);
  assert.equal(rows[0].market.lowestOther.mall, 'G마켓');
  const blocked = await checkGoldboxAgainstMarket([item('a, 1ml, 1개', 1), item('b, 1ml, 1개', 1)],
    { fetchImpl: async () => new Response('', { status: 403 }), delayMs: 0, shippingReader: noShippingRead });
  assert.deepEqual(blocked.map(r => [r.status, r.error]), [['error', 'ACCESS_BLOCKED']]);
});

test('a Danawa win is re-checked against same-product Naver cards, coupon price included', async () => {
  const item = { title: '존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', url: 'https://www.coupang.com/vp/products/1?itemId=11&vendorItemId=111', deal: publicQuoteDeal(24900) };
  const card = (title, price, couponPrice = null, couponEligibilityVerified = false) => ({ title, price, couponPrice, couponEligibilityVerified, shipping: 0, seller: '공식스토어', url: null });
  const run = async cards => (await checkGoldboxAgainstMarket([item], { fetchImpl: fakeDanawa(), delayMs: 0, naverCards: async () => cards, shippingReader: noShippingRead }))[0];
  const cheaperWithCoupon = await run([card('존바바토스 아티산 오드뚜왈렛 75ml', 26000, 24000, true), card('존바바토스 아티산 오드뚜왈렛 125ml', 20000)]);
  assert.equal(cheaperWithCoupon.status, 'not_lowest_naver');
  assert.deepEqual([cheaperWithCoupon.naver.matched, cheaperWithCoupon.naver.lowest.couponPrice], [1, 24000]);
  const unverifiedCoupon = await run([card('존바바토스 아티산 오드뚜왈렛 75ml', 26000, 10000, false)]);
  assert.equal(unverifiedCoupon.status, 'beats_market', 'an unverified coupon does not replace the public card price');
  assert.equal(unverifiedCoupon.naver.lowest.price, 26000);
  const coupangOwnCard = await run([{ ...card('존바바토스 아티산 오드뚜왈렛 75ml', 24900), seller: '쿠팡' }]);
  assert.deepEqual([coupangOwnCard.status, coupangOwnCard.naver.matched], ['beats_market', 0]);
  const pricier = await run([card('존바바토스 아티산 오드뚜왈렛 75ml', 26000)]);
  assert.equal(pricier.status, 'beats_market');
  assert.equal(pricier.naver.lowest.price, 26000);
  const otherSizeOnly = await run([card('존바바토스 아티산 오드뚜왈렛 125ml', 20000)]);
  assert.deepEqual([otherSizeOnly.status, otherSizeOnly.naver.matched], ['beats_market', 0]);
  const failed = await checkGoldboxAgainstMarket([item], { fetchImpl: fakeDanawa(), delayMs: 0, naverCards: async () => { throw Object.assign(new Error('x'), { code: 'NAVER_RATE_LIMITED' }); }, shippingReader: noShippingRead });
  assert.deepEqual([failed[0].status, failed[0].naver], ['beats_market', { compared: false, error: 'NAVER_RATE_LIMITED' }]);
});

test('an unknown-shipping Naver lower bound clears the Danawa-only beats_market headline', async () => {
  const item = { title: '존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', url: 'https://www.coupang.com/vp/products/1?itemId=11&vendorItemId=111',
    deal: publicQuoteDeal(25000) };
  const [row] = await checkGoldboxAgainstMarket([item], { fetchImpl: fakeDanawa(), delayMs: 0,
    naverCards: async () => [{ title: '존바바토스 아티산 오드뚜왈렛 EDT 75ml', price: 24000, shipping: null, seller: '미지 네이버몰' }], shippingReader: noShippingRead });
  assert.deepEqual([row.market.danawaBeatsMarket, row.market.beatsMarket, row.status, row.verdict.route],
    [true, null, 'comparison_shipping_unverified', 'comparison_shipping_unverified']);
  assert.deepEqual([row.verdict.best.seller, row.verdict.best.payable, row.verdict.best.shippingKnown], ['미지 네이버몰', null, false]);
});

test('priceVerdict ranks payable prices (coupon + shipping) and routes to the affiliate that is cheapest', () => {
  const mall = (m, price, shipping = 0) => ({ mall: m, price, shipping, total: price + shipping, couponRequired: false });
  const danawa = [mall('쿠팡', 14740, 0), mall('11번가', 28700), mall('G마켓', 16900, 3000)];
  const card = (seller, price, couponPrice = null, shipping = 0, couponEligibilityVerified = false) => ({ title: 'x', seller, price, couponPrice, shipping, couponEligibilityVerified });
  const coupangWins = priceVerdict({ title: 't', salePrice: 14740, coupangShipping: 0, wowPromotion: true, promotionSoldPercent: 35, danawaOffers: danawa, naverSame: [card('라이온코리아', 16500, 15800, 0, true)] });
  assert.deepEqual([coupangWins.route, coupangWins.sources, coupangWins.best.seller], ['coupang_partners', 3, '쿠팡']);
  assert.equal(coupangWins.offers.find(o => o.seller === 'G마켓').payable, 19900, 'shipping is added');
  assert.equal(coupangWins.offers.find(o => o.seller === '라이온코리아').payable, 15800, 'coupon price counts');
  assert.deepEqual(coupangWins.wow, { promotionPresent: true, soldPercent: 35, memberPriceVerified: false });
  assert.deepEqual(priceVerdict({ title: 't', salePrice: 14740, wowPromotionRate: 60 }).wow,
    { promotionPresent: true, soldPercent: null, memberPriceVerified: false }, 'old mislabeled rates never become a discount');
  const connectWins = priceVerdict({ title: 't', salePrice: 19900, danawaOffers: [mall('쿠팡', 19900), mall('현대Hmall', 22900), mall('롯데ON', 24110)],
    naverSame: [card('G마켓', 22000)], connectSame: [{ storeName: '센토 공식스토어', price: 18900, shipping: 0, productId: '9', commissionRate: 5 }] });
  assert.deepEqual([connectWins.route, connectWins.best.seller], ['naver_connect', '센토 공식스토어']);
  const tie = priceVerdict({ title: 't', salePrice: 19900, coupangShipping: 0, danawaOffers: [mall('쿠팡', 19900), mall('현대Hmall', 22900), mall('롯데ON', 24110)],
    connectSame: [{ storeName: '센토 공식스토어', price: 19900, shipping: 0, productId: '9' }] });
  assert.deepEqual([tie.route, tie.ties], ['coupang_partners', ['naver_connect:센토 공식스토어']], 'known free Coupang shipping keeps the Coupang link on a tie');
  const tieUnknown = priceVerdict({ title: 't', salePrice: 19900, danawaOffers: [mall('현대Hmall', 22900), mall('롯데ON', 24110), mall('SSG', 25000)],
    connectSame: [{ storeName: '센토 공식스토어', price: 19900, productId: '9' }] });
  assert.deepEqual([tieUnknown.route, tieUnknown.best.payable, tieUnknown.best.shippingKnown], ['comparison_shipping_unverified', null, false], 'unknown own and Connect shipping cannot establish a cheapest seller');
  assert.equal(priceVerdict({ title: '고당도 감귤, 1kg, 1개', salePrice: 14900, danawaOffers: [mall('G마켓', 16900), mall('11번가', 30400), mall('옥션', 17000)], naverSame: [card('x', 20000)] }).route, 'generic_product');
  const otherWins = priceVerdict({ title: 't', salePrice: 19800, danawaOffers: [mall('쿠팡', 19800), mall('현대Hmall', 20750), mall('G마켓', 21000)], naverSame: [card('어떤스토어', 15290)] });
  assert.equal(otherWins.route, 'lowest_not_affiliate');
  const gim = [mall('G마켓', 26150), mall('신세계몰', 26440), mall('SSG.COM', 26440)], gimCard = [card('대천김주식회사', 26000, 25000, 0)];
  const thin = priceVerdict({ title: 't', salePrice: 23600, danawaOffers: gim, naverSame: gimCard });
  assert.deepEqual([thin.route, thin.best.payable, thin.shipping.payable, thin.shipping.payableLowerBound],
    ['coupang_shipping_unverified', null, null, 23600], 'unknown shipping preserves a lower bound and never invents a delivery fee');
  const known = priceVerdict({ title: 't', salePrice: 23600, coupangShipping: 0, danawaOffers: [mall('쿠팡', 23600, 0), ...gim], naverSame: gimCard });
  assert.equal(known.route, 'coupang_partners');
  const soap = priceVerdict({ title: 't', salePrice: 14740, danawaOffers: [mall('11번가', 28700), mall('G마켓', 6437250)], naverSame: [card('11번가', 25550), card('G마켓', 6437250)] });
  assert.deepEqual([soap.route, soap.sources], ['too_few_sellers', 1], 'duplicate malls count once and a 6,437,250원 listing is not comparable');
  const few = priceVerdict({ title: 't', salePrice: 10220, danawaOffers: [mall('쿠팡', 10220), mall('G마켓', 18330)] });
  assert.deepEqual([few.route, few.sources], ['too_few_sellers', 1]);
});

test('Naver card counts in 캔/팩 match Coupang titles counted in 개', () => {
  const same = naverSameProduct('대천김 곱창캔김, 30g, 5개', [
    { title: '대천김 곱창 김 캔김 30g 5캔', price: 26000, couponPrice: 25000 },
    { title: '대천맛김 대천김 곱창 김 선물세트 30g x 6개입, 1개', price: 26690 }]);
  assert.deepEqual(same.map(c => [c.best, c.payable, c.couponPrice]), [[26000, null, null]], 'unknown eligibility and shipping keep the displayed public price separate');
  const verified = naverSameProduct('대천김 곱창캔김, 30g, 5개', [
    { title: '대천김 곱창 김 캔김 30g 5캔', price: 26000, couponPrice: 25000, couponEligibilityVerified: true, shipping: 0 }]);
  assert.deepEqual(verified.map(c => [c.best, c.payable, c.couponPrice]), [[25000, 25000, 25000]]);
});

test('unknown competitor shipping lower bounds block false affiliate wins at lower/equal prices but not at higher prices', () => {
  const otherMalls = [
    { mall: '다나와몰A', price: 12000, shipping: 0 },
    { mall: '다나와몰B', price: 13000, shipping: 0 },
    { mall: '다나와몰C', price: 14000, shipping: 0 },
  ];
  const compare = price => priceVerdict({ title: '테스트 세제 2L', salePrice: 10000, coupangShipping: 0,
    danawaOffers: otherMalls, naverSame: [{ seller: '네이버몰', title: '테스트 세제 2L', price, shipping: null }] });
  const lower = compare(9500), same = compare(10000), higher = compare(10500);
  assert.deepEqual([lower.route, lower.best.payable, lower.best.shippingKnown], ['comparison_shipping_unverified', null, false]);
  assert.deepEqual([same.route, same.best.payable, same.best.shippingKnown], ['comparison_shipping_unverified', null, false]);
  assert.deepEqual([higher.route, higher.best.seller, higher.best.payable], ['coupang_partners', '쿠팡', 10000]);
  assert.equal(higher.offers.find(o => o.seller === '네이버몰').payable, null, 'unknown shipping remains null in the offer ledger');
});

test('all-unknown shipping resolves only when a lower-bound candidate is provably ahead', () => {
  const unknownDanawa = [
    { mall: '다나와몰A', price: 12000, shipping: null },
    { mall: '다나와몰B', price: 13000, shipping: null },
    { mall: '다나와몰C', price: 14000, shipping: null },
  ];
  const cpgCouldWin = priceVerdict({ title: '테스트 세제 2L', salePrice: 10000, danawaOffers: unknownDanawa,
    naverSame: [{ seller: '네이버몰', title: '테스트 세제 2L', price: 15000, shipping: null }] });
  assert.deepEqual([cpgCouldWin.route, cpgCouldWin.best.seller, cpgCouldWin.best.payable, cpgCouldWin.shipping.payable],
    ['coupang_shipping_unverified', '쿠팡', null, null]);
  const anotherCouldWin = priceVerdict({ title: '테스트 세제 2L', salePrice: 10000, coupangShipping: 0, danawaOffers: unknownDanawa,
    naverSame: [{ seller: '네이버몰', title: '테스트 세제 2L', price: 9000, shipping: null }] });
  assert.deepEqual([anotherCouldWin.route, anotherCouldWin.best.seller, anotherCouldWin.best.payable],
    ['comparison_shipping_unverified', '네이버몰', null]);
});

test('Danawa coupon-required prices remain conditional and never enter unconditional ranking', () => {
  const danawaOffers = Array.from({ length: 8 }, (_, i) => ({ mall: `몰${i}`, price: 12000 + i * 100, shipping: 0, couponRequired: false }))
    .concat({ mall: '쿠폰 필요몰', price: 100, shipping: 0, couponRequired: true });
  const verdict = priceVerdict({ title: '테스트 세제 2L', salePrice: 10000, coupangShipping: 0, danawaOffers });
  assert.deepEqual([verdict.route, verdict.best.payable, verdict.sources], ['coupang_partners', 10000, 8]);
  assert.equal(verdict.offers.some(o => o.seller === '쿠폰 필요몰'), false);
  assert.deepEqual(verdict.conditionalOffers, [{ channel: 'danawa', seller: '쿠폰 필요몰', price: null, advertisedCouponPrice: 100,
    couponEligibilityVerified: false, conditionalPrice: { amount: 100, currency: 'KRW', basis: 'danawa_coupon_required', eligibilityVerified: false },
    couponRequired: true, shipping: 0, payable: null, shippingKnown: true }]);
});

test('Goldbox Danawa market-check removes coupon-required offers from the unconditional lowest-price proof', async () => {
  const conditionalMalls = MALLS.replace('25,930', '5,000').replace('alt="G마켓"', 'alt="G마켓 쿠폰 적용"');
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://search.danawa.com/')) return new Response(LD_SEARCH, { status: 200 });
    if (url.startsWith('https://prod.danawa.com/info/?pcode=')) return new Response(PRODUCT_PAGE, { status: 200 });
    if (url.endsWith('getAllPriceCompareMallList.ajax.php')) return new Response(conditionalMalls, { status: 200 });
    return new Response('', { status: 404 });
  };
  const item = { title: '존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', url: 'https://www.coupang.com/vp/products/1?itemId=11&vendorItemId=111',
    deal: publicQuoteDeal(10000) };
  const [row] = await checkGoldboxAgainstMarket([item], { fetchImpl, delayMs: 0, shippingReader: noShippingRead });
  assert.deepEqual([row.status, row.market.lowestOther.mall, row.market.lowestOtherTotal], ['beats_market', '옥션', 29100]);
  assert.deepEqual(row.market.conditionalOffers, [{ mall: 'G마켓 쿠폰 적용', advertisedCouponPrice: 5000,
    couponEligibilityVerified: false, eligibilityStatus: 'required_coupon_not_verified', shipping: 0, payable: null }]);
});

test('Goldbox price selection uses widget general, then exact public offer general, then an unverified listing fallback', () => {
  const widget = selectGoldboxGeneralPrice({ salePrice: 24900,
    widgetFinalPrice: { amount: 20000, currency: 'KRW', basis: 'widget_final_price_field' },
    widgetPriceReadStatus: 'matched_conditional_coupon',
    publicOfferGeneralPrice: { amount: 19000, currency: 'KRW', basis: 'public_offer_list' },
    publicOfferGeneralPriceReadStatus: 'matched_public_offer_general_price' });
  assert.deepEqual([widget.amount, widget.source, widget.verified, widget.matchesListingSalePrice],
    [20000, 'coupang_mlp_goldbox_widget', true, false], 'the exact widget general price wins even when it differs from the old listing field');
  const publicOffer = selectGoldboxGeneralPrice({ salePrice: 24900,
    widgetFinalPrice: { amount: 20000, currency: 'KRW' }, widgetPriceReadStatus: 'not_found_in_complete_catalog_scan',
    publicOfferGeneralPrice: { amount: 19000, currency: 'KRW' }, publicOfferGeneralPriceReadStatus: 'matched_public_offer_general_price' });
  assert.deepEqual([publicOffer.amount, publicOffer.source, publicOffer.verified, publicOffer.matchesListingSalePrice],
    [19000, 'coupang_public_offer_list', true, false]);
  const fallback = selectGoldboxGeneralPrice({ salePrice: 24900,
    publicOfferGeneralPrice: { amount: 19000, currency: 'KRW' }, publicOfferGeneralPriceReadStatus: 'unmatched_public_general_price' });
  assert.deepEqual([fallback.amount, fallback.source, fallback.verified, fallback.verificationStatus],
    [24900, 'coupang_goldbox_listing', false, 'unverified_listing_fallback']);
  assert.equal(selectGoldboxGeneralPrice({ salePrice: 24900, widgetFinalPrice: { amount: '20000', currency: 'KRW' },
    widgetPriceReadStatus: 'matched_explicit_wow_price' }).amount, 24900, 'malformed price amounts are not accepted');
});

test('Goldbox market comparison uses selected general price, retains conditional specials and flags without inferring eligibility', async () => {
  const item = { title: '존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', url: 'https://www.coupang.com/vp/products/1', deal: {
    productId: 'p1', itemId: 'i1', vendorItemId: 'v1',
    salePrice: 24900,
    widgetFinalPrice: { amount: 20000, currency: 'KRW', basis: 'widget_final_price_field' },
    widgetPriceReadStatus: 'matched_conditional_coupon',
    publicOfferGeneralPrice: { amount: 19000, currency: 'KRW', basis: 'public_offer_list' },
    publicOfferGeneralPriceReadStatus: 'matched_public_offer_general_price',
    advertisedWowPrice: { amount: 10000, currency: 'KRW', label: 'new price label', boxEnabled: false, dimmed: true, eligibilityVerified: false },
    wowSalePrice: 15000,
    conditionalCouponPrice: { amount: 10000, currency: 'KRW', label: '가입 쿠폰가', eligibilityVerified: false },
    memberPriceVerified: false,
  } };
  const [row] = await checkGoldboxAgainstMarket([item], { fetchImpl: fakeDanawa(), delayMs: 0, shippingReader: selectedSkuShippingRead });
  assert.deepEqual([row.salePrice, row.listingSalePrice, row.generalPrice.source, row.generalPrice.matchesListingSalePrice],
    [20000, 24900, 'coupang_mlp_goldbox_widget', false]);
  assert.deepEqual([row.productId, row.itemId, row.vendorItemId], ['p1', 'i1', 'v1'], 'comparison retains the exact selected product/item/vendor SKU identity');
  assert.deepEqual([row.market.coupangPayable, row.verdict.best.payable, row.verdict.generalPrice.amount], [20000, 20000, 20000]);
  assert.deepEqual(row.specialPrices.advertisedWowPrice, item.deal.advertisedWowPrice, 'unfamiliar label and display flags stay evidence only');
  assert.deepEqual(row.specialPrices.conditionalCouponPrice, item.deal.conditionalCouponPrice);
  assert.equal(row.verdict.offers.find(o => o.affiliate === 'coupang_partners').payable, 20000, 'conditional coupon and advertised WOW amount do not lower the baseline');
});

test('unknown Coupang shipping stays null even with Rocket badges or the old 19,800원 threshold', async () => {
  const { mapFeedProduct } = await import('../research/content-store/goldbox-market-check.mjs');
  const danawaOffers = [{ mall: 'G마켓', price: 20500, shipping: 0 }, { mall: '옥션', price: 20600, shipping: 0 }, { mall: '11번가', price: 20700, shipping: 0 },
    ...Array.from({ length: 6 }, (_, i) => ({ mall: `몰${i}`, price: 21000 + i, shipping: 0 }))];
  const unknown = priceVerdict({ title: '테스트 세제 2L', salePrice: 19800, danawaOffers });
  assert.deepEqual([unknown.route, unknown.coupangShippingKnown, unknown.best.payable, unknown.shipping.payable, unknown.shipping.payableLowerBound],
    ['coupang_shipping_unverified', false, null, null, 19800]);
  const knownFree = priceVerdict({ title: '테스트 세제 2L', salePrice: 19800, danawaOffers, coupangShipping: 0 });
  assert.deepEqual([knownFree.route, knownFree.coupangShippingKnown, knownFree.best.payable], ['coupang_partners', true, 19800]);
  const rocketDeal = { title: '존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', url: 'https://www.coupang.com/vp/products/1', deal: { salePrice: 19800, rocket: 'ROCKET' } };
  const [rocketRow] = await checkGoldboxAgainstMarket([rocketDeal], { fetchImpl: fakeDanawa(), delayMs: 0,
    naverCards: async () => [{ title: '존바바토스 아티산 오드뚜왈렛 EDT 75ml', price: 30000, shipping: 0, seller: '다른 네이버 판매처' }] });
  assert.deepEqual([rocketRow.coupangShippingKnown, rocketRow.verdict.route, rocketRow.verdict.best.payable, rocketRow.verdict.shipping.payable],
    [false, 'coupang_shipping_unverified', null, null]);
  const row = mapFeedProduct({ productId: '9152882331', itemId: '1', vendorItemId: '2', title: '비오레 바디로션', feedTitle: '오늘의 할인', salePriceKrw: 11890, basePriceKrw: 19820,
    discountRatePercent: 40, cleanUrl: 'https://www.coupang.com/vp/products/9152882331?itemId=1&vendorItemId=2' });
  assert.equal(row.deal.salePrice, 11890); assert.equal(row.deal.rocket, null); assert.equal(row.publisher, '쿠팡 오늘의 할인');
  assert.equal(mapFeedProduct({ title: 'x', cleanUrl: 'https://evil.example/vp/products/1', salePriceKrw: 100 }), null);
});

test('sub-20,000 Goldbox rows skip shipping reads and route only after the charged-shipping worst case clears the tie margin', async () => {
  assert.equal(COUPANG_SHIPPING_READ_MINIMUM_PRICE_KRW, 20000);
  const item = price => ({ title: '존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', url: 'https://www.coupang.com/vp/products/1', deal: {
    productId: 'p1', itemId: 'i1', vendorItemId: 'v1', salePrice: price,
    widgetFinalPrice: { amount: price, currency: 'KRW', basis: 'widget_final_price_field' },
    widgetPriceReadStatus: 'matched_no_explicit_wow_price',
  } });
  const run = async (lowestMallPrice) => {
    let shippingReads = 0;
    const malls = MALLS.replace('25,930', lowestMallPrice.toLocaleString('en-US'));
    const [row] = await checkGoldboxAgainstMarket([item(18000)], { fetchImpl: fakeDanawa([], malls), delayMs: 0,
      naverCards: async () => [{ title: '존바바토스 아티산 오드뚜왈렛 EDT 75ml', price: 30000, shipping: 0, seller: '별도 네이버 판매처' }],
      shippingReader: async () => { shippingReads += 1; throw new Error('under-threshold shipping must not be read'); } });
    return { row, shippingReads };
  };
  const passes = await run(22000), fails = await run(21999);
  assert.deepEqual([passes.shippingReads, passes.row.shippingReadAttempted, passes.row.shippingReadSkipped,
    passes.row.coupangShippingFee, passes.row.coupangShippingKnown],
    [0, false, 'below_20000_assumed_charged', null, false]);
  assert.deepEqual([passes.row.verdict.route, passes.row.verdict.shipping.chargedUnknown,
    passes.row.verdict.shipping.worstCaseComparison.assumedShippingFeeKRW, passes.row.verdict.shipping.worstCaseComparison.marginKRW,
    passes.row.verdict.shipping.worstCaseComparison.win], ['coupang_partners', true, 3000, 1000, true]);
  assert.deepEqual([fails.row.verdict.route, fails.row.verdict.shipping.worstCaseComparison.marginKRW,
    fails.row.verdict.shipping.worstCaseComparison.win], ['coupang_shipping_unverified', 999, false]);
});

test('sold-out Goldbox items are excluded before price comparison network reads', async () => {
  let calls = 0;
  const [row] = await checkGoldboxAgainstMarket([{ title: '품절 상품, 1개', url: 'https://www.coupang.com/vp/products/1',
    deal: { salePrice: 100, soldOut: true } }], { fetchImpl: async () => { calls += 1; throw new Error('should not fetch'); }, delayMs: 0 });
  assert.equal(row.status, 'sold_out');
  assert.equal(calls, 0);
});
