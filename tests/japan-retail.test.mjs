import test from 'node:test';
import assert from 'node:assert/strict';
import { japanDocument, japanDestination, sha } from '../lib/retail/japan-http.mjs';
import { parseRakutenHome, parseRakutenListing, parseRakutenProduct } from '../lib/retail/rakuten-public-catalog.mjs';
import { parseYahooNavigation, parseYahooProduct } from '../lib/retail/yahoo-jp-public.mjs';
import { createJapanPublicClient, crawlJapanPublic } from '../lib/retail/japan-public.mjs';
import { createYahooShoppingJpClient } from '../lib/commerce/yahoo-shopping-jp.mjs';

const RURL = 'https://item.rakuten.co.jp/synthetic-shop/synthetic-item/';
const YURL = 'https://store.shopping.yahoo.co.jp/synthetic-shop/synthetic-item.html';
const NOW = Date.parse('2026-10-15T06:00:00Z');
const html = body => '<html><body>' + body + '</body></html>';
const script = (id, data) => '<script id="' + id + '" type="application/json">' + JSON.stringify(data).replaceAll('<', '\\u003c') + '</script>';
const response = (body, status = 200, type = 'text/html;charset=utf-8', headers = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } });
function rakItem() {
  return { shopId: '123', itemId: 456, manageNumber: 'synthetic-item', title: '日本のテスト商品',
    newProductDescription: '<p>Safe description</p><script>maliciousCode()</script>',
    media: { images: [{ location: 'https://tshop.r10s.jp/synthetic-shop/p.jpg?tracking=DROP' }] },
    variantSelectors: [{ key: 'color', label: 'カラー', values: [{ value: '白', label: '白' }, { value: '赤', label: '赤' }] }],
    sku: [{ variantId: 'v1', selectorValues: ['白'], taxIncludedPrice: 1200, hidden: false, images: [], attributes: [] },
      { variantId: 'v2', selectorValues: ['赤'], taxIncludedPrice: 1500, hidden: false, images: [], attributes: [] }],
    purchaseInfo: { sku: [{ variantId: 'v1', newPurchaseSku: { stockCondition: 'sold-out', quantity: 0 } },
      { variantId: 'v2', newPurchaseSku: { quantity: 9 } }, { variantId: 'orphan', newPurchaseSku: { quantity: 0 } }],
      axis: [{ values: [{ value: '白', isSoldOut: false }] }],
      purchaseBySellType: { normalPurchase: { price: { minPrice: 1200 } } } },
    itemReviewInfo: { summary: { itemReviewCount: 10, itemReviewRating: 4.5 } } };
}
function rakDoc(item = rakItem()) {
  return html('<input name="shop_bid" value="123"><input name="item_id" value="456"><input name="shopurl" value="synthetic-shop">'
    + script('item-page-app-data', { newApi: { itemInfoSku: item }, shop: { shopName: 'Synthetic Shop' },
      user: { postalCode: 'PRIVATE_VALUE_MUST_NOT_LEAK' }, apiConfig: { token: 'SYNTHETIC_SECRET_TOKEN' } })
    + '<a href="https://review.rakuten.co.jp/item/1/123_456/1.1/">レビュー</a>');
}
function listing(page = 1) {
  const state = { state: { data: {
    uiQuestion: { keywords: 'マウス', page, category: 100026 },
    ichibaSearch: { error: null, pagination: { numFound: 30, pageSize: 45 }, items: [{
      code: '456', shop: { id: 123, urlCode: 'synthetic-shop', name: 'Synthetic Shop' }, name: 'Test mouse',
      originalItemUrl: RURL + '?variantId=v1', price: 1200, images: [], hasPriceRange: true,
      variantId: 'v1', isSoldOut: false, itemOptions: { cpc: {} },
    }] }, genreTree: { parent_category: { id: 0, name: '', children: [{ id: 100026, name: 'PC', children: [] }] } },
    myDataToken: { token: 'SYNTHETIC_SECRET_TOKEN' },
  } }, locale: 'ja' };
  return html('<script>window.__INITIAL_STATE__ =' + JSON.stringify(state) + ';window.unrelated = 1;</script>'
    + '<a href="https://search.rakuten.co.jp/search/mall/%E3%83%9E%E3%82%A6%E3%82%B9/100026/?p=' + (page + 1) + '">次のページ</a>');
}
function yahooData() {
  return { seller: { id: 'synthetic-shop', name: 'Synthetic Shop', contactTel: 'DO_NOT_STORE' },
    item: { srid: 'synthetic-item', sellerManagedItemId: 'synthetic-item', name: 'Synthetic product', applicablePrice: 3000,
      images: { displayItemImageList: [{ src: 'https://item-shopping.c.yimg.jp/i/n/synthetic-shop_synthetic-item' }] },
      stock: { isAvailable: true, quantity: null }, axisNum: 1,
      individualItemList: [{ skuId: 'synthetic-sku', optionList: [{ name: 'サイズ', choiceName: 'Small' }],
        price: { applicablePrice: 2800 }, stock: { isAvailable: true, quantity: 2 } }],
      selectOptionList: [{ name: 'Shipping acknowledgement', choiceList: [{ name: 'Agree', isSelectable: true, charge: null }] }] },
    review: { reviewSummary: { count: 10, average: 4.0 }, itemReviews: [{
      id: 'synthetic-review-id', title: 'Title', body: 'A public review.', rating: 4, postedDate: '2026/10/15',
      maskYid: 'PRIVATE_AUTHOR', profiles: ['DO_NOT_STORE'],
    }] }, page: { crumb: 'SYNTHETIC_SECRET_TOKEN', remoteIp: 'DO_NOT_STORE' } };
}
function yahooDoc(data = yahooData(), currency = 'JPY') {
  return html('<link rel="canonical" href="' + YURL + '">'
    + script('__NEXT_DATA__', { props: { pageProps: data } })
    + '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Product',
      offers: { price: 3000, priceCurrency: currency, url: YURL } }) + '</script>');
}

test('transport preserves EUC-JP and never sends cookies or follows unsafe redirects', async () => {
  const bytes = Buffer.concat([Buffer.from('<html><body>'), Buffer.from('c6fccbdc','hex'), Buffer.from('</body></html>')]);
  const result = await japanDocument('rakuten', RURL, { now: () => NOW, fetchImpl: async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).has('cookie'), false);
    return response(bytes, 200, 'text/html;charset=EUC-JP');
  } });
  assert.match(result.html, /日本/);
  assert.equal(result.requests[0].responseSha256, sha(bytes));
  await assert.rejects(japanDocument('yahoo', 'https://shopping.yahoo.co.jp/', {
    fetchImpl: async () => response(null, 302, 'text/html', { location: 'https://login.yahoo.co.jp/' }),
  }), { code: 'JAPAN_REDIRECT_REJECTED' });
});

test('transport permits observed same-origin category redirects, but rejects oversized, JSON and error pages', async () => {
  let count = 0;
  const r = await japanDocument('yahoo', 'https://shopping.yahoo.co.jp/category/2494/recommend', {
    fetchImpl: async () => ++count === 1 ? response(null, 301, 'text/html', { location: '/category/13457/2494/recommend' }) : response(html('OK')),
  });
  assert.equal(r.requests.length, 2);
  assert.equal(r.url, 'https://shopping.yahoo.co.jp/category/13457/2494/recommend');
  for (const [body, status, type, code] of [['{}',200,'application/json','JAPAN_MIME_INVALID'],
    ['oops',500,'text/html','JAPAN_HTTP_REJECTED'], ['x'.repeat(8 * 1024 * 1024 + 1),200,'text/html','JAPAN_RESPONSE_TOO_LARGE']]) {
    await assert.rejects(japanDocument('rakuten', RURL, { fetchImpl: async () => response(body,status,type) }), { code });
  }
});

test('URL boundary excludes accounts, mutation endpoints and cross-service hosts; drops tracking', () => {
  for (const bad of ['https://login.account.rakuten.com/', 'https://t3.basket.step.rakuten.co.jp/rms/mall/bs/cartall/',
    'https://www.rakuten.co.jp.evil.test/', 'http://www.rakuten.co.jp/', 'https://user:password@www.rakuten.co.jp/'])
    assert.equal(japanDestination('rakuten', bad), null);
  assert.equal(japanDestination('rakuten', RURL + '?token=SYNTHETIC_SECRET_TOKEN').url, RURL);
  assert.equal(japanDestination('yahoo', YURL + '?sc_i=tracking').url, YURL);
  assert.equal(japanDestination('yahoo', 'https://store.shopping.yahoo.co.jp/synthetic-shop/info.html'), null);
});

test('home menu preserves siblings and title-only item; blank genre root is structural', () => {
  const groups = [{ key: 'fashion', items: [{ key: 'ladies', link: 'https://www.rakuten.co.jp/category/100371/' }] },
    { key: 'hobby', items: [{ title: { ja: 'カタログ' }, link: 'https://www.rakuten.co.jp/category/101381/' }] }];
  const page = html('<div id="side-navi"><div irc="GenreWidget" data-items="' + JSON.stringify(groups).replaceAll('"','&quot;') + '"></div></div>');
  const nav = parseRakutenHome(page);
  assert.equal(nav.menus.length, 2); assert.equal(nav.links.length, 2); assert.equal(nav.rootDiscoveryComplete, true);
  const result = parseRakutenListing(listing(), 'https://search.rakuten.co.jp/search/mall/%E3%83%9E%E3%82%A6%E3%82%B9/100026/');
  assert.equal(result.categoryNodes[0].structuralRoot, true);
});

test('listing uses exact query/page/category; listing variant does not prove option price', () => {
  const url = 'https://search.rakuten.co.jp/search/mall/%E3%83%9E%E3%82%A6%E3%82%B9/100026/';
  const r = parseRakutenListing(listing(), url);
  assert.equal(r.products[0].selectedVariantPriceVerified, false);
  assert.equal(r.products[0].price.basis, 'listing_minimum_or_range');
  assert.equal(r.products[0].sponsored, true);
  assert.equal(new URL(r.pagination.nextUrl).searchParams.get('p'), '2');
  assert.equal(JSON.stringify(r).includes('SYNTHETIC_SECRET_TOKEN'), false);
  assert.throws(() => parseRakutenListing(listing(), url + '?p=2'), { code: 'RAKUTEN_LISTING_PAGE_MISMATCH' });
  assert.throws(() => parseRakutenListing(listing(), url.replace('100026','100027')), { code: 'RAKUTEN_LISTING_CATEGORY_MISMATCH' });
  assert.throws(() => parseRakutenListing(listing().replace('/100026/?p=2', '/100027/?p=2'), url), { code: 'RAKUTEN_NEXT_PAGE_QUERY_MISMATCH' });
  const category = listing().replace('"keywords":"マウス",', '').replace('/%E3%83%9E%E3%82%A6%E3%82%B9/', '/-/');
  assert.ok(parseRakutenListing(category, 'https://www.rakuten.co.jp/category/100026/').pagination.nextUrl);
});

test('Rakuten SKU prices and purchase stock override an inconsistent display axis; secrets and script omitted', () => {
  const r = parseRakutenProduct(rakDoc(), RURL).product;
  assert.equal(r.variants[0].availability, 'unavailable');
  assert.equal(r.variants[1].price.amount, '1500');
  assert.equal(r.unmappedInventoryRows, 1);
  assert.equal(r.reviewUrl, 'https://review.rakuten.co.jp/item/1/123_456/1.1/');
  assert.equal(r.description, 'Safe description');
  assert.equal(JSON.stringify(r).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(r).includes('SECRET_TOKEN'), false);
  assert.throws(() => parseRakutenProduct(rakDoc({ ...rakItem(), itemId: 999 }), RURL), { code: 'RAKUTEN_PRODUCT_IDENTITY_MISMATCH' });
  const bad = rakItem(); bad.sku[0].selectorValues = ['blue'];
  assert.throws(() => parseRakutenProduct(rakDoc(bad), RURL), { code: 'RAKUTEN_VARIANT_INVALID' });
});

test('Yahoo keeps option-specific prices, treats acknowledgement separately, limits reviews to public preview', () => {
  const r = parseYahooProduct(yahooDoc(), YURL).product;
  assert.equal(r.price.amount, '3000');
  assert.equal(r.variants[0].price.amount, '2800');
  assert.equal(r.customizationOptions[0].inventoryVariant, false);
  assert.equal(r.previewReviews.length, 1);
  assert.equal(r.reviewPaginationVerified, false);
  assert.equal(JSON.stringify(r).includes('PRIVATE_AUTHOR'), false);
  assert.equal(JSON.stringify(r).includes('SYNTHETIC_SECRET_TOKEN'), false);
  assert.equal(JSON.stringify(r).includes('DO_NOT_STORE'), false);
  assert.throws(() => parseYahooProduct(yahooDoc(yahooData(), 'USD'), YURL), { code: 'YAHOO_PRODUCT_PRICE_MISMATCH' });
  const bad = yahooData(); bad.seller.id = 'other-shop';
  assert.throws(() => parseYahooProduct(yahooDoc(bad), YURL), { code: 'YAHOO_PRODUCT_IDENTITY_MISMATCH' });
  const missingPrice = yahooData(); missingPrice.item.individualItemList[0].price = null;
  const partial = parseYahooProduct(yahooDoc(missingPrice), YURL).product;
  assert.equal(partial.price.amount, '3000');
  assert.equal(partial.variants[0].price, null);
  assert.equal(partial.variants[0].selectedVariantPriceVerified, false);
  assert.equal(partial.variants[0].quantity, 2);
});

test('Yahoo navigation preserves root and children; brand cards are candidates, not manufactured products', () => {
  const cat = (gid, name) => ({ gid, name, link: 'https://shopping.yahoo.co.jp/category/' + gid + '/recommend' });
  const data = { categoryEntity: { bigCategories: [{ categories: [cat(1,'one')], childCategories: [
    { category: cat(1,'one'), childCategories: [cat(2,'two')] }] }] }, token: 'SYNTHETIC_SECRET_TOKEN' };
  const result = parseYahooNavigation(html(script('__NEXT_DATA__', { props: { pageProps: data } })
    + '<a class="item-link" href="' + YURL + '">Brand</a>'), 'https://shopping.yahoo.co.jp/');
  assert.equal(result.categoryNodes.length, 2); assert.equal(result.edges.length, 2);
  assert.equal(result.identityCandidates.length, 1); assert.equal(result.products.length, 0);
  assert.equal(JSON.stringify(result).includes('SECRET_TOKEN'), false);
});

test('crawler checkpoint resumes without rereading completed roots, retains pagination and independent siblings', async () => {
  const root = 'https://www.rakuten.co.jp/', cat = 'https://www.rakuten.co.jp/category/100026/';
  const cat2 = 'https://www.rakuten.co.jp/category/100371/';
  const calls = [], saved = [];
  const client = { async read(url) { calls.push(url); return { checkedAt: new Date(NOW).toISOString(),
    data: { links: url === root ? [{url:cat,kind:'category'},{url:cat2,kind:'category'}]
      : [{url:RURL,kind:'product'}], products: [], pagination: url === cat ? {
        nextUrl: 'https://search.rakuten.co.jp/search/mall/-/100026/?p=2' } : null } }; } };
  const first = await crawlJapanPublic({ service:'rakuten', maxPages:1, client, checkpoint: async s => saved.push(structuredClone(s)) });
  assert.equal(first.collection.pending, 2);
  const second = await crawlJapanPublic({ service:'rakuten', state:first, maxPages:1, client });
  assert.deepEqual(calls, [root,cat]); assert.equal(saved.length,2);
  assert.equal(second.nodes.find(n=>n.url===cat2).state,'pending');
  assert.ok(second.edges.some(e=>e.relation==='listing_next_page'));
  const forged = structuredClone(first); forged.nodes.push({url:'https://evil.test/',state:'pending',depth:1});
  await assert.rejects(crawlJapanPublic({ service:'rakuten',state:forged,client }), { code:'JAPAN_FRONTIER_INVALID' });
});

test('client binds sanitized data to receipts and keeps anonymous execution and affiliate readiness separate', async () => {
  const r = await createJapanPublicClient({ service:'rakuten', now:()=>NOW, fetchImpl:async()=>response(rakDoc()) }).read(RURL);
  const y = await createJapanPublicClient({ service:'yahoo', now:()=>NOW, fetchImpl:async()=>response(yahooDoc()) }).read(YURL);
  for (const run of [r,y]) {
    assert.equal(run.dataSha256, sha(JSON.stringify(run.data)));
    assert.equal(run.data.product.identityVerified,true);
    assert.equal(run.requests.at(-1).httpStatus,200);
    assert.equal(run.requests.at(-1).cookiesSent,false);
    assert.equal(run.writesSubmitted,0); assert.equal(run.affiliateLinkVerified,false);
    assert.equal(run.data.product.price.currency,'JPY');
  }
});

test('official Yahoo search needs caller app ID, enforces window, binds query, and redacts credentials', async () => {
  let calls = 0;
  assert.throws(()=>createYahooShoppingJpClient(), {code:'YAHOO_APP_ID_REQUIRED'});
  const key = 'SYNTHETIC_YAHOO_APP_ID';
  const client = createYahooShoppingJpClient({ appId:key, now:()=>NOW, fetchImpl:async(input,init)=>{
    calls++; const url = new URL(input);
    assert.equal(url.origin,'https://shopping.yahooapis.jp'); assert.equal(url.searchParams.get('appid'),key);
    assert.equal(init.redirect,'manual'); assert.equal(init.credentials,'omit');
    return response(JSON.stringify({totalResultsAvailable:2,totalResultsReturned:1,firstResultsPosition:1,request:{query:'mouse'},
      hits:[{code:'synthetic-shop_synthetic-item',name:'Mouse',seller:{sellerId:'synthetic-shop'},url:YURL,
        price:1000,inStock:true,affiliateRate:2}]}),200,'application/json');
  } });
  await assert.rejects(client.search({query:'mouse',start:990,results:20}),{code:'YAHOO_SEARCH_INPUT_INVALID'});
  assert.equal(calls,0);
  const result = await client.search({query:'mouse'});
  assert.equal(result.credentialsUsed,true); assert.equal(result.request.anonymous,false);
  assert.equal(result.accountOwnerVerified,false); assert.equal(result.affiliateLinkVerified,false);
  assert.equal(JSON.stringify(result).includes(key),false);
  assert.equal(result.items[0].identityVerified,true);
  await assert.rejects(client.search({query:'different'}), {code:'YAHOO_SEARCH_SCHEMA_INVALID'});
});
