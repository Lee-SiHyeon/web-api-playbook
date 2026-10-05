import test from 'node:test';
import assert from 'node:assert/strict';
import { createSephoraRakutenClient, createUltaImpactCatalogClient } from '../lib/commerce/brand-affiliates.mjs';

const ACCOUNT_SID = 'account-sid-secret-value';
const AUTH_TOKEN = 'impact-auth-token-secret-value';
const CATALOG_ID = 'ulta-catalog-us-1';
const PRODUCT_ID = 'ulta-item-42';
const RAKUTEN_TOKEN = 'rakuten-publisher-token-secret-value';
const SEPHORA_MID = '123456';
const NOW = Date.parse('2026-10-05T00:00:00.000Z');

function response(value, status = 200, mime = 'application/json; charset=utf-8') {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'content-type': mime },
  });
}

function rakutenXml({ mid = SEPHORA_MID, name = 'Sephora', currency = 'USD', items = 1 } = {}) {
  const rows = Array.from({ length: items }, (_, index) => `
    <item>
      <mid>${mid}</mid><merchantname>${name}</merchantname><linkid>sephora-link-${index + 1}</linkid>
      <createdon>2026-10-05/00:00:00</createdon><sku>SEPHORA-SKU-${index + 1}</sku>
      <productname>Hydrating Lip Color ${index + 1}</productname>
      <category><primary>Beauty</primary><secondary>Makeup</secondary></category>
      <price currency="${currency}">39.00</price><saleprice currency="${currency}">29.00</saleprice>
      <linkurl>https://click.linksynergy.com/link?id=publisher&amp;RD_PARM1=https%3A%2F%2Fwww.sephora.com%2Fproduct</linkurl>
      <imageurl>https://www.sephora.com/product-image.jpg</imageurl>
    </item>`).join('');
  return `<result><TotalMatches>${items}</TotalMatches><TotalPages>${items ? 1 : 0}</TotalPages><PageNumber>1</PageNumber>${rows}</result>`;
}

function sephoraHarness(xml) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://api.linksynergy.com');
    assert.equal(url.pathname, '/productsearch/1.0');
    assert.equal(url.searchParams.get('mid'), SEPHORA_MID);
    assert.equal(url.searchParams.get('language'), 'en_US');
    assert.equal(url.searchParams.has('accessToken'), false);
    assert.equal(init.headers.authorization, `Bearer ${RAKUTEN_TOKEN}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' } });
  };
  return {
    calls,
    client: createSephoraRakutenClient({ accessToken: RAKUTEN_TOKEN,
      advertiserMid: SEPHORA_MID, fetchImpl, now: () => NOW, sleepImpl: async () => {} }),
  };
}

function catalog(overrides = {}) {
  return {
    Id: CATALOG_ID,
    Name: 'Ulta Beauty US Catalog',
    AdvertiserId: 'advertiser-ulta-284',
    AdvertiserName: 'Ulta Beauty',
    CampaignId: 'campaign-ulta-us',
    CampaignName: 'Ulta Beauty US Publisher Program',
    NumberOfItems: '2',
    Language: 'en_US',
    Currency: 'USD',
    ServiceAreas: 'United States',
    ...overrides,
  };
}

function item(id, overrides = {}) {
  return {
    Id: id,
    CatalogId: CATALOG_ID,
    CatalogItemId: `source-${id}`,
    CampaignId: 'campaign-ulta-us',
    CampaignName: 'Ulta Beauty US Publisher Program',
    Name: id === PRODUCT_ID ? 'Daily Moisturizer' : 'Curl Shampoo',
    Url: `https://goto.impact.com/ulta/${id}`,
    ImageUrl: `https://media.ulta.com/${id}.jpg`,
    CurrentPrice: id === PRODUCT_ID ? '24.00' : '18.00',
    OriginalPrice: id === PRODUCT_ID ? '30.00' : null,
    Currency: 'USD',
    StockAvailability: 'InStock',
    Category: 'Beauty / Skincare',
    Manufacturer: 'Example Beauty Brand',
    Description: id === PRODUCT_ID ? 'Daily face moisturizer' : 'Curl shampoo',
    ...overrides,
  };
}

function harness({ catalogs = [catalog()], items = [item(PRODUCT_ID), item('ulta-item-99')],
  catalogStatus = 200, itemStatus = 200, itemMime = 'application/json; charset=utf-8' } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://api.impact.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('authorization'), `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`);
    if (/\/Catalogs$/.test(url.pathname)) return response({ Catalogs: catalogs }, catalogStatus);
    if (url.pathname === `/Mediapartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items`) {
      assert.equal(url.searchParams.has('Query'), false, 'the brand adapter must not invent Impact Query syntax');
      return response({ Items: items }, itemStatus, itemMime);
    }
    if (url.pathname === `/Mediapartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items/${PRODUCT_ID}`) {
      const found = items.find(value => value.Id === PRODUCT_ID);
      return response(found ?? { error: 'not found' }, found ? itemStatus : 404, itemMime);
    }
    throw new Error(`unexpected Impact path ${url.pathname}`);
  };
  return {
    calls,
    client: createUltaImpactCatalogClient({ accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN,
      catalogId: CATALOG_ID, fetchImpl, now: () => NOW }),
  };
}

test('verifies one exact Ulta advertiser catalog and explicit US metadata before reading products', async () => {
  const h = harness();
  const result = await h.client.verifyCatalog();
  assert.equal(result.brand, 'ulta-beauty');
  assert.equal(result.network, 'impact');
  assert.equal(result.market, 'US');
  assert.equal(result.catalog.id, CATALOG_ID);
  assert.equal(result.catalog.advertiserId, 'advertiser-ulta-284');
  assert.equal(result.catalog.advertiserName, 'Ulta Beauty');
  assert.equal(result.catalog.currency, 'USD');
  assert.equal(result.receipt.request.path, '/Mediapartners/{AccountSID}/Catalogs');
  assert.equal(JSON.stringify(result).includes(ACCOUNT_SID), false);
  assert.equal(JSON.stringify(result).includes(AUTH_TOKEN), false);
  assert.equal(h.calls.length, 1);
});

test('loads only the verified catalog, filters a bounded response locally, and preserves Impact USD prices', async () => {
  const h = harness();
  const result = await h.client.searchProducts({ keyword: 'moisturizer', limit: 5 });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url.pathname, `/Mediapartners/${ACCOUNT_SID}/Catalogs/${CATALOG_ID}/Items`);
  assert.equal(result.search.mode, 'local_substring_filter');
  assert.equal(result.search.remoteSearchUsed, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].productId, PRODUCT_ID);
  assert.deepEqual(result.items[0].price, { amount: '24.00', currency: 'USD', kind: 'retail_current' });
  assert.equal(result.items[0].listPrice.amount, '30.00');
  assert.equal(result.items[0].url, `https://goto.impact.com/ulta/${PRODUCT_ID}`);
  assert.equal(result.coverage, 'provider_limited');
  assert.equal(result.completeness, 'unknown_catalog_response_cap_and_no_paging_contract');
  assert.equal(result.counts.catalogItemsReturned, 2);
  assert.equal(result.counts.keywordMatches, 1);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[0].request.path.includes(ACCOUNT_SID), false);
  assert.equal(result.receipts[1].request.path.includes(ACCOUNT_SID), false);
  assert.equal(JSON.stringify(result).includes(ACCOUNT_SID), false);
  assert.equal(JSON.stringify(result).includes(AUTH_TOKEN), false);
});

test('accepts only exact advertiser aliases, not brand-name substrings', async () => {
  for (const name of ['Ulta Beauty Partners', 'My Ulta Beauty', 'Ulta']) {
    const h = harness({ catalogs: [catalog({ AdvertiserName: name })] });
    await assert.rejects(h.client.verifyCatalog(), error => error.code === 'BRAND_AFFILIATE_CATALOG_ADVERTISER_MISMATCH');
    assert.equal(h.calls.length, 1, 'the product catalog must not be read after a brand mismatch');
  }
  const alias = harness({ catalogs: [catalog({ AdvertiserName: ' ULTA BEAUTY, INC. ' })] });
  assert.equal((await alias.client.verifyCatalog()).catalog.advertiserName, ' ULTA BEAUTY, INC. ');
});

test('rejects missing, duplicate, and wrong-region catalog identities before product reads', async () => {
  const absent = harness({ catalogs: [catalog({ Id: 'another-catalog' })] });
  await assert.rejects(absent.client.verifyCatalog(), error => error.code === 'BRAND_AFFILIATE_CATALOG_ID_NOT_FOUND');

  const duplicate = harness({ catalogs: [catalog(), catalog({ CampaignId: 'second-campaign' })] });
  await assert.rejects(duplicate.client.verifyCatalog(), error => error.code === 'BRAND_AFFILIATE_CATALOG_ID_AMBIGUOUS');

  for (const overrides of [
    { Currency: 'SGD', ServiceAreas: 'Singapore' },
    { Currency: 'USD', ServiceAreas: 'North America' },
    { Currency: 'USD', ServiceAreas: 'not US' },
    { Currency: undefined, ServiceAreas: 'United States' },
  ]) {
    const wrongRegion = harness({ catalogs: [catalog(overrides)] });
    await assert.rejects(wrongRegion.client.verifyCatalog(), error => error.code === 'BRAND_AFFILIATE_CATALOG_REGION_UNVERIFIED');
    assert.equal(wrongRegion.calls.length, 1);
  }
});

test('rejects returned rows whose source catalog or price currency conflicts with the verified US catalog', async () => {
  const wrongCatalog = harness({ items: [item(PRODUCT_ID, { CatalogId: 'different-catalog' })] });
  await assert.rejects(wrongCatalog.client.listProducts(), error => error.code === 'BRAND_AFFILIATE_ITEM_CATALOG_IDENTITY_MISMATCH');

  const wrongCurrency = harness({ items: [item(PRODUCT_ID, { Currency: 'CAD' })] });
  await assert.rejects(wrongCurrency.client.listProducts(), error => error.code === 'BRAND_AFFILIATE_ITEM_CURRENCY_MISMATCH');
});

test('rejects catalog rows that echo credentials and suppresses credential-bearing request paths in errors', async () => {
  const echoedCatalog = harness({ catalogs: [catalog({ AdvertiserName: AUTH_TOKEN })] });
  await assert.rejects(echoedCatalog.client.verifyCatalog(), error => {
    assert.equal(error.code, 'BRAND_AFFILIATE_RESPONSE_CONTAINS_CREDENTIAL');
    assert.equal(JSON.stringify(error).includes(AUTH_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(ACCOUNT_SID), false);
    return true;
  });

  const echoed = harness({ items: [item(PRODUCT_ID, { Description: `sentinel ${AUTH_TOKEN}` })] });
  await assert.rejects(echoed.client.listProducts(), error => {
    assert.equal(error.code, 'BRAND_AFFILIATE_RESPONSE_CONTAINS_CREDENTIAL');
    assert.equal(JSON.stringify(error).includes(AUTH_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(ACCOUNT_SID), false);
    return true;
  });

  const denied = harness({ catalogStatus: 403 });
  await assert.rejects(denied.client.verifyCatalog(), error => {
    assert.equal(error.code, 'BRAND_AFFILIATE_IMPACT_READ_FAILED');
    assert.equal(JSON.stringify(error).includes(AUTH_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(ACCOUNT_SID), false);
    assert.equal(JSON.stringify(error).includes('Basic '), false);
    return true;
  });
});

test('validates local search and result limits without sending a remote filter', async () => {
  const h = harness();
  await assert.rejects(h.client.listProducts({ keyword: '   ' }), error => error.code === 'BRAND_AFFILIATE_KEYWORD_INVALID');
  await assert.rejects(h.client.listProducts({ limit: 1_001 }), error => error.code === 'BRAND_AFFILIATE_LIMIT_INVALID');
  assert.equal(h.calls.length, 0);

  const result = await h.client.listProducts({ limit: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.counts.resultLimit, 1);
  assert.equal(h.calls[1].url.searchParams.has('Query'), false);
});

test('detail reads bind the product and catalog while returning the unchanged Impact offer', async () => {
  const h = harness();
  const result = await h.client.getProduct({ productId: PRODUCT_ID });
  assert.equal(h.calls.length, 2);
  assert.equal(result.item.productId, PRODUCT_ID);
  assert.equal(result.item.source.catalogId, CATALOG_ID);
  assert.equal(result.item.price.amount, '24.00');
  assert.equal(result.item.price.currency, 'USD');
  assert.equal(result.item.url, `https://goto.impact.com/ulta/${PRODUCT_ID}`);
  assert.equal(JSON.stringify(result).includes(AUTH_TOKEN), false);
  assert.equal(JSON.stringify(result).includes(ACCOUNT_SID), false);
});

test('requires an explicit catalog ID and rejects item IDs containing path controls', async () => {
  assert.throws(() => createUltaImpactCatalogClient({ accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN }),
    error => error.code === 'BRAND_AFFILIATE_CATALOG_ID_INVALID');
  const h = harness();
  await assert.rejects(h.client.getProduct({ productId: '../secret' }),
    error => error.code === 'BRAND_AFFILIATE_PRODUCT_ID_INVALID');
  await assert.rejects(h.client.listProducts(null), error => error.code === 'BRAND_AFFILIATE_SEARCH_OPTIONS_INVALID');
  await assert.rejects(h.client.getProduct(null), error => error.code === 'BRAND_AFFILIATE_PRODUCT_OPTIONS_INVALID');
  assert.equal(h.calls.length, 0);
});

test('Sephora Rakuten facade pins caller MID and en_US, then verifies exact network advertiser and USD price', async () => {
  const h = sephoraHarness(rakutenXml());
  const result = await h.client.verifyMerchant();
  assert.equal(h.calls.length, 1);
  assert.equal(result.provider, 'rakuten-advertising');
  assert.equal(result.brand, 'sephora');
  assert.equal(result.market, 'US');
  assert.equal(result.advertiser.advertiserMid, SEPHORA_MID);
  assert.equal(result.advertiser.advertiserName, 'Sephora');
  assert.equal(result.advertiser.identityVerified, true);
  assert.equal(result.items[0].variantId, 'SEPHORA-SKU-1');
  assert.equal(result.items[0].price.currency, 'USD');
  assert.equal(result.items[0].salePrice.currency, 'USD');
  assert.equal(result.finalDomainVerified, false);
  assert.equal(JSON.stringify(result).includes(RAKUTEN_TOKEN), false);
});

test('Sephora MID is never guessed, advertiser names are exact, and empty catalogs remain unverified', async () => {
  assert.throws(() => createSephoraRakutenClient({ accessToken: RAKUTEN_TOKEN }),
    error => error.code === 'BRAND_AFFILIATE_SEPHORA_MID_REQUIRED');

  const wrongName = sephoraHarness(rakutenXml({ name: 'Sephora Partners' }));
  await assert.rejects(wrongName.client.verifyMerchant(), error => {
    assert.equal(error.code, 'BRAND_AFFILIATE_RAKUTEN_ADVERTISER_MISMATCH');
    assert.equal(JSON.stringify(error).includes(RAKUTEN_TOKEN), false);
    return true;
  });

  const empty = sephoraHarness(rakutenXml({ items: 0 }));
  const result = await empty.client.verifyMerchant();
  assert.equal(result.advertiser.identityVerified, false);
  assert.equal(result.market, null);
  assert.equal(result.items.length, 0);
});

test('Sephora facade rejects MID or region overrides and does not mislabel non-USD data', async () => {
  const h = sephoraHarness(rakutenXml());
  await assert.rejects(h.client.searchProducts({ keyword: 'lip color', advertiserMid: '999999' }),
    error => error.code === 'BRAND_AFFILIATE_SEPHORA_RAKUTEN_MID_OVERRIDE_REJECTED');
  await assert.rejects(h.client.searchProducts({ keyword: 'lip color', language: 'fr_FR' }),
    error => error.code === 'BRAND_AFFILIATE_SEPHORA_RAKUTEN_LANGUAGE_REJECTED');
  assert.equal(h.calls.length, 0);

  const nonUsd = sephoraHarness(rakutenXml({ currency: 'CAD' }));
  await assert.rejects(nonUsd.client.verifyMerchant(), error =>
    error.code === 'BRAND_AFFILIATE_SEPHORA_RAKUTEN_CURRENCY_MISMATCH');
});
