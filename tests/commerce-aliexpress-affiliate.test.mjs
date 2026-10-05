import test from 'node:test';
import assert from 'node:assert/strict';
import { createAliExpressAffiliateClient } from '../lib/commerce/aliexpress-affiliate.mjs';

const origin = 'https://eco.taobao.com';
const appKey = 'test-app-key';
const appSecret = 'private-test-secret';
const now = () => Date.parse('2026-10-04T16:00:00.000Z');

function product(productId = '1005001234567890') {
  return {
    product_id: productId,
    product_title: 'Sample product',
    product_detail_url: `https://www.aliexpress.com/item/${productId}.html?spm=tracking`,
    product_main_image_url: 'https://ae01.alicdn.com/kf/sample.jpg',
    product_small_image_urls: { string: ['https://ae01.alicdn.com/kf/sample.jpg', 'https://ae01.alicdn.com/kf/sample-alt.jpg'] },
    product_video_url: 'https://ae01.alicdn.com/kf/sample.mp4',
    shop_id: 12345, shop_url: 'https://www.aliexpress.com/store/12345',
    platform_product_type: 'TMALL', discount: '20%', evaluate_rate: '92.1%', ship_to_days: 'ship to US in 7 days',
    sale_price: '15.90', sale_price_currency: 'USD',
    original_price: '22.00', original_price_currency: 'USD',
    app_sale_price: '14.90', app_sale_price_currency: 'USD',
    target_sale_price: '15.90', target_sale_price_currency: 'USD',
    target_original_price: '22.00', target_original_price_currency: 'USD',
    target_app_sale_price: '14.90', target_app_sale_price_currency: 'USD',
    commission_rate: '5%', lastest_volume: 120,
    first_level_category_id: 100, first_level_category_name: 'Home',
    second_level_category_id: 200, second_level_category_name: 'Lighting',
  };
}

function queryResponse(products = [product()]) {
  return {
    aliexpress_affiliate_product_query_response: {
      resp_result: {
        resp_code: 200, resp_msg: 'success',
        result: {
          current_page_no: 2, current_record_count: products.length,
          total_page_no: 9, total_record_count: 81,
          products: { product: products },
        },
      },
    },
  };
}

function detailResponse(products = [product()]) {
  const detailProducts = products.map(value => {
    const copy = { ...value };
    delete copy.ship_to_days;
    return copy;
  });
  return {
    aliexpress_affiliate_productdetail_get_response: {
      resp_result: { resp_code: 200, resp_msg: 'success', result: {
        current_record_count: detailProducts.length, products: { product: detailProducts },
      } },
    },
  };
}

function socialResponse() {
  return {
    aliexpress_social_item_search_response: { result: {
      results: { item_search_result: [{
        item_id: 10000021628274,
        item_title: 'Social catalog sample',
        item_url: 'https://www.aliexpress.com/item/-/10000021628274.html',
        item_main_pic: 'https://ae01.alicdn.com/kf/example.jpg',
        item_pics: 'https://ae01.alicdn.com/kf/example.jpg,https://ae01.alicdn.com/kf/example-2.jpg',
        item_videos: 'https://ae01.alicdn.com/kf/example.mp4',
        shop_url: 'https://www.aliexpress.com/store/12345', pub_time: '1710000000000',
        item_origin_price_min: 'US $1.36', item_origin_price_max: 'US $5.33',
        item_price_discount_min: 'US $1.09', item_price_discount_max: 'US $4.26',
        item_discount_rate: '20', commission_rate: '3', comment_score: '4.5',
        seller_layer: 'Good', sales30_day_semantic: '100+', comment30_day_semantic: '20+', favorite_cnt_semantic: '300+',
      }] },
      page_no: 1, page_size: 1, total_count: 100, success: true, error_code: '', error_msg: '',
    } },
  };
}

function client(fetchImpl) {
  return createAliExpressAffiliateClient({ appKey, appSecret, fetchImpl, now });
}

test('searches the documented Affiliate product API with an exact signed POST and keeps price meanings separate', async () => {
  let calls = 0;
  const fetchImpl = async (rawUrl, init) => {
    calls++;
    assert.equal(rawUrl, `${origin}/router/rest`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.get('content-type'), 'application/x-www-form-urlencoded;charset=utf-8');
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('authorization'), null);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('method'), 'aliexpress.affiliate.product.query');
    assert.equal(params.get('app_key'), appKey);
    assert.equal(params.get('sign_method'), 'hmac');
    assert.equal(params.get('timestamp'), '2026-10-05 00:00:00');
    assert.equal(params.get('v'), '2.0');
    assert.equal(params.get('format'), 'json');
    assert.equal(params.get('keywords'), 'desk lamp');
    assert.equal(params.get('page_no'), '2');
    assert.equal(params.get('page_size'), '3');
    assert.equal(params.get('ship_to_country'), 'US');
    assert.equal(params.get('target_currency'), 'USD');
    assert.equal(params.get('target_language'), 'EN');
    const fields = params.get('fields').split(',');
    for (const field of ['evaluate_rate', 'product_small_image_urls', 'product_video_url', 'shop_id', 'shop_url', 'discount']) {
      assert.ok(fields.includes(field), `documented product field requested: ${field}`);
    }
    assert.equal(fields.includes('promotion_link'), false);
    assert.equal(fields.includes('code_promotionurl'), false);
    assert.equal(params.get('tracking_id'), null);
    assert.equal(params.get('sign'), '9AFD0F430F83FC4238FF8193F3B396EA');
    assert.equal(params.has('session'), false);
    assert.equal(params.has('app_secret'), false);
    return Response.json(queryResponse());
  };

  const result = await client(fetchImpl).searchProducts({ query: 'desk lamp', page: 2, limit: 3 });
  assert.equal(calls, 1);
  assert.equal(result.query, 'desk lamp');
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 9);
  assert.equal(result.totalCount, 81);
  assert.deepEqual(result.products[0].salePrice, { amount: '15.90', currency: 'USD' });
  assert.deepEqual(result.products[0].listPrice, { amount: '22.00', currency: 'USD' });
  assert.deepEqual(result.products[0].appSalePrice, { amount: '14.90', currency: 'USD' });
  assert.deepEqual(result.products[0].targetSalePrice, { amount: '15.90', currency: 'USD' });
  assert.equal(result.products[0].url, 'https://www.aliexpress.com/item/1005001234567890.html');
  assert.deepEqual(result.products[0].images, [
    { role: 'primary', url: 'https://ae01.alicdn.com/kf/sample.jpg' },
    { role: 'gallery', url: 'https://ae01.alicdn.com/kf/sample-alt.jpg' },
  ]);
  assert.equal(result.products[0].videoUrl, 'https://ae01.alicdn.com/kf/sample.mp4');
  assert.deepEqual(result.products[0].store, { id: '12345', url: 'https://www.aliexpress.com/store/12345' });
  assert.equal(result.products[0].platformProductType, 'TMALL');
  assert.equal(result.products[0].discountRate, '20%');
  assert.deepEqual(result.products[0].ratingMetadata, {
    value: '92.1', unit: 'percent_positive_reviews', sourceField: 'evaluate_rate',
  });
  assert.equal(result.products[0].shippingEstimate, 'ship to US in 7 days');
  assert.equal(result.products[0].description, null);
  assert.equal(result.products[0].options, null);
  assert.equal(result.products[0].sku, null);
  assert.equal(result.products[0].availability, null);
  assert.equal(result.products[0].reviewPhotos, null);
  assert.ok(result.products[0].unavailableFields.includes('stockQuantity'));
  assert.equal(Object.hasOwn(result.products[0], 'promotionLink'), false);
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.receipt.cookiesSent, false);
  assert.equal(result.receipt.userSessionSent, false);
  assert.equal(result.receipt.credentialsPersisted, false);
  assert.equal(result.receipt.priceFieldsVerified, true);
});

test('forwards only caller-supplied tracking parameters and valid filter fields', async () => {
  const fetchImpl = async (_url, init) => {
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('tracking_id'), 'owned-publisher-code');
    assert.equal(params.get('app_signature'), 'portal-signature-value');
    assert.equal(params.get('category_ids'), '111,222');
    assert.equal(params.get('min_sale_price'), '1.25');
    assert.equal(params.get('max_sale_price'), '90');
    assert.equal(params.get('delivery_days'), '7');
    assert.equal(params.get('sort'), 'SALE_PRICE_ASC');
    assert.equal(params.get('platform_product_type'), 'ALL');
    return Response.json(queryResponse());
  };
  await createAliExpressAffiliateClient({ appKey, appSecret, fetchImpl, now,
    trackingId: 'owned-publisher-code', appSignature: 'portal-signature-value' })
    .searchProducts({ query: 'lamp', categoryIds: [111, 222], minPrice: '1.25', maxPrice: '90', deliveryDays: 7 });
});

test('retrieves details by product ID and binds the response to that requested ID', async () => {
  let calls = 0;
  const fetchImpl = async (rawUrl, init) => {
    calls++;
    assert.equal(rawUrl, `${origin}/router/rest`);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('method'), 'aliexpress.affiliate.productdetail.get');
    assert.equal(params.get('product_ids'), '1005001234567890');
    assert.equal(params.get('country'), 'KR');
    assert.equal(params.get('target_currency'), 'KRW');
    return Response.json(detailResponse());
  };
  const result = await client(fetchImpl).getProduct({ productId: '1005001234567890', country: 'KR', currency: 'KRW' });
  assert.equal(calls, 1);
  assert.equal(result.product.productId, '1005001234567890');
  assert.deepEqual(result.product.salePrice, { amount: '15.90', currency: 'USD' });
  assert.deepEqual(result.product.ratingMetadata, {
    value: '92.1', unit: 'percent_positive_reviews', sourceField: 'evaluate_rate',
  });
  assert.equal(result.product.shippingEstimate, null);
  assert.equal(result.receipt.productIdMatched, true);
});

test('searches official social affiliate catalog and parses only its documented en_US USD price strings', async () => {
  let calls = 0;
  const fetchImpl = async (rawUrl, init) => {
    calls++;
    assert.equal(rawUrl, `${origin}/router/rest`);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('method'), 'aliexpress.social.item.search');
    assert.equal(params.get('keyword'), 'desk lamp');
    assert.equal(params.get('page_no'), '1');
    assert.equal(params.get('page_size'), '10');
    assert.equal(params.get('ship_to'), 'US');
    assert.equal(params.get('currency'), 'USD');
    assert.equal(params.get('locale'), 'en_US');
    assert.equal(params.get('alliance_item'), 'true');
    assert.equal(params.get('cate_id'), '100');
    assert.equal(params.get('session'), null);
    return Response.json(socialResponse());
  };
  const result = await client(fetchImpl).searchSocialProducts({ keyword: 'desk lamp', categoryId: 100 });
  assert.equal(calls, 1);
  assert.equal(result.totalCount, 100);
  assert.deepEqual(result.products[0].listPriceRange, {
    min: { amount: '1.36', currency: 'USD' }, max: { amount: '5.33', currency: 'USD' },
  });
    assert.deepEqual(result.products[0].salePriceRange, {
    min: { amount: '1.09', currency: 'USD' }, max: { amount: '4.26', currency: 'USD' },
  });
    assert.equal(result.products[0].url, 'https://www.aliexpress.com/item/10000021628274.html');
  assert.deepEqual(result.products[0].images, [
    { role: 'primary', url: 'https://ae01.alicdn.com/kf/example.jpg' },
    { role: 'gallery', url: 'https://ae01.alicdn.com/kf/example-2.jpg' },
  ]);
  assert.equal(result.products[0].videoUrl, 'https://ae01.alicdn.com/kf/example.mp4');
  assert.deepEqual(result.products[0].ratingMetadata, { score: '4.5', scale: null, sourceField: 'comment_score' });
  assert.equal(result.products[0].recentSalesSemantic, '100+');
  assert.equal(result.products[0].recentCommentsSemantic, '20+');
  assert.equal(result.products[0].favoritesSemantic, '300+');
  assert.equal(result.products[0].description, null);
  assert.equal(result.products[0].reviewPhotos, null);
  assert.equal(result.receipt.currencyParser, 'documented_USD_en_US_prefix');
});

test('rejects a product detail response for a different product', async () => {
  const fetchImpl = async () => Response.json(detailResponse([product('1005009876543210')]));
  await assert.rejects(client(fetchImpl).getProduct({ productId: '1005001234567890' }),
    { code: 'ALIEXPRESS_AFFILIATE_PRODUCT_ID_MISMATCH' });
});

test('does not send requests without app credentials or for invalid inputs', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected request'); };
  assert.throws(() => createAliExpressAffiliateClient({ appSecret, fetchImpl }),
    { code: 'ALIEXPRESS_AFFILIATE_CREDENTIALS_REQUIRED' });
  const api = client(fetchImpl);
  for (const input of [
    {}, { query: 'x\ny' }, { query: 'a', page: 0 }, { query: 'a', limit: 51 },
    { query: 'a', currency: 'ZZZ' }, { query: 'a', categoryIds: ['1', '../'] },
    { query: 'a', minPrice: '1e3' }, { query: 'a', minPrice: '5', maxPrice: '2' },
  ]) {
    await assert.rejects(api.searchProducts(input), { code: 'ALIEXPRESS_AFFILIATE_INPUT_INVALID' });
  }
  await assert.rejects(api.getProduct({ productId: 'https://example.com/1005001234567890' }),
    { code: 'ALIEXPRESS_AFFILIATE_INPUT_INVALID' });
  await assert.rejects(api.searchSocialProducts({ keyword: 'lamp', currency: 'KRW', locale: 'ko_KR' }),
    { code: 'ALIEXPRESS_AFFILIATE_INPUT_INVALID' });
  assert.equal(calls, 0);
});

test('returns classified remote errors without exposing the raw server response', async () => {
  const payload = { error_response: { code: 50, sub_code: 'isv.invalid-parameter',
    msg: 'private-test-secret should never escape' } };
  const fetchImpl = async () => Response.json(payload);
  await assert.rejects(client(fetchImpl).searchProducts({ query: 'lamp' }), error => {
    assert.equal(error.code, 'ALIEXPRESS_AFFILIATE_REMOTE_ERROR');
    assert.equal(error.remoteCode, 'isv.invalid-parameter');
    assert.equal(error.receipt.httpStatus, 200);
    assert.equal(error.receipt.credentialsPersisted, false);
    assert.equal(error.message.includes(appSecret), false);
    assert.equal(JSON.stringify(error).includes(appKey), false);
    return true;
  });
});

test('does not follow redirects or retry writes/reads', async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://www.aliexpress.com/' } });
  };
  await assert.rejects(client(fetchImpl).searchProducts({ query: 'lamp' }),
    { code: 'ALIEXPRESS_AFFILIATE_REDIRECTED' });
  assert.equal(calls, 1);
});
