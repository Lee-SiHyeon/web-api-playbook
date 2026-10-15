import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { coupangPublicUrl, parseTravelSearch, parseTravelRooms, parseTravelReviews, parseCoupangDocument,
  readCoupangTravelSearch, readCoupangTravelRooms, readCoupangRetailSearch, readCoupangDocument, parseTravelTicketOptions } from '../lib/retail/coupang-public.mjs';
const fixture = name => readFile(new URL(`./fixtures/coupang/${name}`, import.meta.url), 'utf8');

test('search preserves 24 records, public prices, pagination and distinct ID namespaces', async () => {
  const raw = JSON.parse(await fixture('travel-search.json'));
  raw.searchResult.products.accessPasses = ['DO_NOT_PERSIST'];
  const data = parseTravelSearch(raw);
  assert.equal(data.products.length, 24); assert.equal(data.pagination.page, 1); assert.equal(data.pagination.hasNext, true);
  assert.equal(data.products[0].productUrl, 'https://trip.coupang.com/tp/products/30000002620249');
  assert.notEqual(data.products[0].productId, data.products[0].packageProductId); assert.equal(data.products[0].price.accountApplied, false);
  assert.ok(!JSON.stringify(data).includes('DO_NOT_PERSIST'));
  raw.searchResult.products.result = [];
  assert.throws(() => parseTravelSearch(raw), { code: 'COUPANG_TRAVEL_EMPTY_PAGE' });
});
test('ticket option IDs preserve exact 19-digit strings and validity windows', async () => {
  const raw = JSON.parse(await fixture('travel-ticket-options.json'));
  const parsed = parseTravelTicketOptions(raw);
  assert.equal(parsed.options.length,3); assert.equal(parsed.options[0].travelItemId,'1060746269980381184');
  assert.equal(parsed.options[1].vendorItems[0].price.salePrice,25000);
  delete raw.travelItems[0].travelItemIdStr; raw.travelItems[0].travelItemId=1060746269980381184;
  assert.throws(()=>parseTravelTicketOptions(raw),{code:'COUPANG_TRAVEL_OPTION_SCHEMA'});
});
test('missing price is unknown, never zero or an invalid whole listing',async()=>{
  const raw=JSON.parse(await fixture('travel-search.json'));raw.searchResult.products.result[0].price.salePrice=null;
  const parsed=parseTravelSearch(raw);assert.equal(parsed.products[0].price.salePrice,null);assert.equal(parsed.products[0].price.priceAvailable,false);
});
test('room rates retain conditions while removing booking inputs', async () => {
  const raw = JSON.parse(await fixture('travel-rooms.json'));
  raw.rooms[0].rateCategories[0].blockId = 'DO_NOT_PERSIST';
  const data = parseTravelRooms(raw);
  assert.equal(data.rooms.length, 5); assert.ok(data.rooms[0].rates[0].conditions.includes('환불불가'));
  assert.equal(data.rooms[0].rates[0].price.description, '세금/봉사료 포함');
  assert.ok(!JSON.stringify(data).includes('DO_NOT_PERSIST'));
});
test('review metadata excludes authors, access passes and full content; unknown hasNext stays unknown', async () => {
  const raw = JSON.parse(await fixture('travel-reviews.json'));
  raw.result[0].reviewer = { name: 'DO_NOT_PERSIST' }; raw.accessPasses = ['DO_NOT_PERSIST'];
  const data = parseTravelReviews(raw);
  assert.equal(data.reviews.length, 3); assert.equal(data.pagination.hasNext, null);
  assert.ok(!JSON.stringify(data).includes('DO_NOT_PERSIST'));
});
test('observed no-review response has zero page size but remains a valid empty result',()=>{
 const raw={result:[],pagination:{countPerPage:0,hasNext:null,hasPrevious:null,page:0,totalCount:0,totalPages:1}};
 assert.equal(parseTravelReviews(raw).reviews.length,0);
 raw.pagination.totalCount=10;assert.throws(()=>parseTravelReviews(raw),{code:'COUPANG_PAGINATION_SCHEMA'});
});
test('general search DOM fixture keeps card fields and the login boundary', async () => {
  const data = parseCoupangDocument(await fixture('retail-search-dom.html'), 'https://www.coupang.com/np/search?q=mouse');
  assert.equal(data.products.length, 3); assert.ok(data.products.every(p => p.title && p.priceLabel && p.productId));
  assert.equal(data.pagination.authRequiredForMore, true); assert.equal(data.completeCatalog, false);
  assert.throws(() => parseCoupangDocument('<title>Access Denied</title>', 'https://www.coupang.com/'), { code: 'COUPANG_CHALLENGE' });
  assert.throws(() => parseCoupangDocument('<title>쿠팡</title><div id="app"></div>', 'https://www.coupang.com/'), { code: 'COUPANG_HTML_LAYOUT_CHANGED' });
});
test('URLs omit tracking and reject foreign origins; reader refuses write paths before network', async () => {
  assert.equal(coupangPublicUrl('https://trip.coupang.com/tp/products/123?searchId=secret&itemId=456'), 'https://trip.coupang.com/tp/products/123?itemId=456');
  assert.equal(coupangPublicUrl('https://trip.coupang.com.evil.test/tp/products/123'), null);
  await assert.rejects(readCoupangDocument('https://www.coupang.com/api/cart', { fetchImpl() { assert.fail('network'); } }), { code: 'COUPANG_URL_SCOPE' });
  assert.equal(new URL(coupangPublicUrl('https://trip.coupang.com/tp/search?q=car&pickUpDate=2026-10-22&pickUpTime=08%3A00&dropOffDate=2026-10-23&displayCategoryCode=32618&searchId=secret')).searchParams.get('pickUpDate'),'2026-10-22');
});
test('search pages use the observed read POST and never send credential headers', async () => {
  const template = JSON.parse(await readFile(new URL('../verification/coupang-discovery-2026-10-15/travel-search-request.json', import.meta.url), 'utf8'));
  const fixtureData = JSON.parse(await fixture('travel-search.json')); fixtureData.searchResult.products.pagination.page = 2;
  const fixtureText = JSON.stringify(fixtureData); let called = false;
  await readCoupangTravelSearch(template, { page: 2, resultsOnly: true, fetchImpl: async (url, init) => {
    called = true; assert.equal(url, 'https://trip.coupang.com/api/search/results-only');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual'); assert.equal(JSON.parse(init.body).searchCondition.page, 2);
    assert.equal(init.headers.cookie, undefined); return new Response(fixtureText, { headers: { 'content-type': 'application/json' } });
  } }); assert.equal(called, true);
  await assert.rejects(readCoupangTravelSearch(template, { fetchImpl: async () => new Response('<title>Access Denied</title>', { status: 403 }) }), { code: 'COUPANG_HTTP_403' });
  template.searchCondition.accessPass='DO_NOT_SEND';
  await assert.rejects(readCoupangTravelSearch(template,{fetchImpl(){assert.fail('network')}}),{code:'COUPANG_SEARCH_INPUT'});
});

test('room response must match the requested hotel identity',async()=>{
  const raw=await fixture('travel-rooms.json');
  await assert.rejects(readCoupangTravelRooms({url:'https://trip.coupang.com/api/lodging/hotels/999/rooms',body:{action:'selectorTrigger'}},
    {fetchImpl:async()=>new Response(raw,{headers:{'content-type':'application/json'}})}),{code:'COUPANG_PRODUCT_MISMATCH'});
});

test('retail search uses observed public fields and never promotes a navigation shell into search success',async()=>{
  await assert.rejects(readCoupangRetailSearch('무선 마우스',{sorter:'salePriceAsc',freeDelivery:true,fetchImpl:async(url,init)=>{
    const u=new URL(url);assert.equal(u.pathname,'/np/search');assert.equal(u.searchParams.get('q'),'무선 마우스');
    assert.equal(u.searchParams.get('filterType'),'free');assert.equal(init.headers.cookie,undefined);
    return new Response('<title>Access Denied</title>',{status:403});
  }}),{code:'COUPANG_HTTP_403'});
  await assert.rejects(readCoupangRetailSearch('mouse',{fetchImpl:async()=>new Response('<a href="/np/categories/1">category</a>',{headers:{'content-type':'text/html'}})}),{code:'COUPANG_RETAIL_LISTING_MISSING'});
  const html=await fixture('retail-search-dom.html');
  const listing=parseCoupangDocument(html+'<a href="/np/categories/178255?page=2">다음</a>','https://www.coupang.com/np/categories/178255');
  assert.equal(listing.pagination.hasNext,true);assert.equal(listing.pagination.nextUrl,'https://www.coupang.com/np/categories/178255?page=2');
});
