import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAmazonProductDocument } from '../lib/retail/amazon-product.mjs';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { AMAZON_RETAIL_STORE, AMAZON_CONTEXT_LIMIT_MS, importAmazonRetailSession, amazonRetailStatus, getAmazonProduct } from '../lib/retail/amazon-retail-session.mjs';

const asin = 'B08KT2Z93D';
const html = await readFile(new URL('./fixtures/amazon/product-lotion.html', import.meta.url), 'utf8');
const minimal = extra => `<input name="ASIN" value="${asin}"><span id="productTitle">Sample product</span>${extra}`;

test('observed lotion document preserves identity, description and per-dimension child mappings', () => {
  const data = parseAmazonProductDocument(html, { asin });
  assert.match(data.title, /eos/); assert.equal(data.features.length, 5);
  assert.ok(data.description.length > 100); assert.equal(data.displayedPrice.currencyCode, 'KRW');
  assert.equal(data.displayedPrice.amount, '13363'); assert.equal(data.displayedReferencePrice.amount, '14730');
  assert.deepEqual(data.dimensions.map(d => d.choices.length), [15, 4]);
  assert.ok(data.dimensions.every(d => d.choices.some(c => c.asin === asin && c.selected)));
  assert.equal(data.dimensions.flatMap(d => d.choices).find(c => c.asin === 'B08KT5HM98').priceVerified, false);
  assert.ok(data.images.length > 1); assert.equal(data.coverage.completeGallery, false);
  assert.equal(data.coverage.optionOffersVerified, false); assert.equal(data.coverage.allReviews, false);
  assert.equal(data.availability.quantity, null);
});

test('HTTP 200 challenge, wrong ASIN and malformed document cannot become product success', () => {
  assert.throws(() => parseAmazonProductDocument('<form action="/errors_page/validateCaptcha"></form>', { asin }), { code: 'AMAZON_PRODUCT_CHALLENGE' });
  assert.throws(() => parseAmazonProductDocument(html, { asin: 'B004YAVF8I' }), { code: 'AMAZON_PRODUCT_IDENTITY_MISMATCH' });
  assert.throws(() => parseAmazonProductDocument('<title>Continue shopping</title>', { asin }), { code: 'AMAZON_PRODUCT_LAYOUT_CHANGED' });
});

test('price parsing does not choose unit price, infer dollars or fabricate image variants', () => {
  const data = parseAmazonProductDocument(minimal(`<div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-offscreen">KRW 1,000</span></span>
    <span class="a-price priceToPay"><span class="a-offscreen">$13.99</span></span></div>
    <div id="imageBlock"><img id="landingImage" src="https://evil.test/image.jpg"
      data-old-hires="https://m.media-amazon.com/images/I/public.jpg" data-a-dynamic-image='{"https://evil.test/huge.jpg":[100,100]}'></div>`), { asin });
  assert.equal(data.displayedPrice.amount, '13.99'); assert.equal(data.displayedPrice.currencyCode, null);
  assert.equal(data.displayedPrice.currencyVerified, false); assert.equal(data.displayedReferencePrice, null);
  assert.equal(data.images.length, 1); assert.equal(data.images[0].url, 'https://m.media-amazon.com/images/I/public.jpg');
  assert.equal(data.availability.status, 'unknown');
});

async function setup(t) {
  const base = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'amazon-session-test-'));
  assert.ok(path.resolve(directory).startsWith(base + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProtectedStore({ provider: 'memory', directory });
  const envelope = { capturedAt: new Date(Date.now() - 1000).toISOString(), origin: 'https://www.amazon.com', responseStatus: 200,
    cookies: ['session-id', 'sp-cdn'].map(name => ({ name, value: name === 'sp-cdn' ? '"SYNTHETIC:KR"' : 'SYNTHETIC_SESSION',
      domain: '.amazon.com', path: '/', secure: true, httpOnly: false, expires: (Date.now() + 3600000) / 1000 })) };
  await importAmazonRetailSession(envelope, { store });
  return { store, envelope };
}

test('protected bootstrap sends scoped quoted cookies and records rotation without exposing values', async t => {
  const { store } = await setup(t); let calls = 0;
  const result = await getAmazonProduct({ asin, store, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, `https://www.amazon.com/-/ko/dp/${asin}/`);
    assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET');
    assert.match(init.headers.get('cookie'), /sp-cdn="SYNTHETIC:KR"/);
    return new Response(html, { headers: { 'content-type': 'text/html',
      'set-cookie': 'session-id=ROTATED_SENTINEL; Domain=.amazon.com; Path=/; Secure; Max-Age=3600' } });
  } });
  assert.equal(calls, 1); assert.equal(result.asin, asin);
  assert.equal(result.receipt.credentialPropagated, false); // A mock is not a native wire observation.
  assert.equal(result.receipt.authenticationVerified, false); assert.equal(result.receipt.sessionRenewalVerified, false);
  assert.equal(result.receipt.sessionPersisted, true);
  assert.match(store.read(AMAZON_RETAIL_STORE), /ROTATED_SENTINEL/);
  for (const secret of ['SYNTHETIC_SESSION', 'SYNTHETIC:KR', 'ROTATED_SENTINEL']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(amazonRetailStatus({ store }).ready, true);
});

test('foreign cookies, expired bootstrap and tampered session cannot reach HTTP', async t => {
  const { store, envelope } = await setup(t);
  for (const mutate of [e => e.origin = 'https://evil.test', e => e.cookies[0].domain = '.evil.test',
    e => e.cookies[0].path = '/account', e => e.cookies[0].name = 'at-main',
    e => e.capturedAt = new Date(Date.now() - 31 * 60000).toISOString()]) {
    const changed = structuredClone(envelope); mutate(changed);
    await assert.rejects(importAmazonRetailSession(changed, { store }));
  }
  const before = JSON.parse(store.read(AMAZON_RETAIL_STORE));
  for (const mutate of [s => s.session.allowedOrigins.push('https://evil.test'),
    s => s.session.defaultHeaders.authorization = 'SYNTHETIC_AUTH',
    s => s.capturedAt = new Date(Date.now() - AMAZON_CONTEXT_LIMIT_MS - 1000).toISOString()]) {
    const state = structuredClone(before); mutate(state); store.write(AMAZON_RETAIL_STORE, JSON.stringify(state));
    await assert.rejects(getAmazonProduct({ asin, store, fetchImpl: () => assert.fail('network must not run') }));
    assert.equal(amazonRetailStatus({ store }).ready, false);
  }
});

test('challenge stops once and rejected session blocks subsequent reads', async t => {
  const { store } = await setup(t); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('<form action="/errors_page/validateCaptcha"></form>', { headers: { 'content-type': 'text/html' } }); };
  await assert.rejects(getAmazonProduct({ asin, store, fetchImpl }), { code: 'AMAZON_PRODUCT_CHALLENGE' });
  await assert.rejects(getAmazonProduct({ asin, store, fetchImpl }), { code: 'AMAZON_RETAIL_SESSION_REJECTED' });
  assert.equal(calls, 1); assert.equal(amazonRetailStatus({ store }).ready, false);
});

test('unexpected authentication cookie is neither accepted nor persisted', async t => {
  const { store } = await setup(t);
  await assert.rejects(getAmazonProduct({ asin, store, fetchImpl: async () => new Response(html, { headers: {
    'content-type': 'text/html', 'set-cookie': 'at-main=UNEXPECTED_SECRET; Domain=.amazon.com; Path=/; Secure' } }) }),
  { code: 'AMAZON_RETAIL_RESPONSE_COOKIE_SCOPE' });
  assert.equal(store.read(AMAZON_RETAIL_STORE).includes('UNEXPECTED_SECRET'), false);
});

test('required-cookie deletion or persistence failure cannot return a successful read', async t => {
  const { store, envelope } = await setup(t);
  await assert.rejects(getAmazonProduct({ asin, store, fetchImpl: async () => new Response(html, { headers: {
    'content-type': 'text/html', 'set-cookie': 'session-id=; Domain=.amazon.com; Path=/; Max-Age=0' } }) }),
  { code: 'AMAZON_RETAIL_SESSION_MISSING' });
  assert.equal(amazonRetailStatus({ store }).ready, false);
  const rejected = JSON.parse(store.read(AMAZON_RETAIL_STORE));
  assert.equal(rejected.lastFailure.code, 'AMAZON_RETAIL_SESSION_MISSING');
  assert.equal(rejected.session.cookieJar.cookies.find(c => c.key === 'session-id')?.maxAge, 0);
  await importAmazonRetailSession(envelope, { store });
  const brokenStore = { directory: store.directory, read: name => store.read(name), write: () => { throw Object.assign(new Error(), { code: 'PROTECTED_STORE_OPERATION_FAILED' }); } };
  await assert.rejects(getAmazonProduct({ asin, store: brokenStore, fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) }),
  { code: 'PROTECTED_STORE_OPERATION_FAILED' });
});

test('redirect never follows login and invalidates the rejected local session', async t => {
  const { store } = await setup(t); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://www.amazon.com/ap/signin' } }); };
  await assert.rejects(getAmazonProduct({ asin, store, fetchImpl }), { code: 'SCOPED_SESSION_REDIRECT_LIMIT' });
  await assert.rejects(getAmazonProduct({ asin, store, fetchImpl }), { code: 'AMAZON_RETAIL_SESSION_REJECTED' });
  assert.equal(calls, 1);
});
