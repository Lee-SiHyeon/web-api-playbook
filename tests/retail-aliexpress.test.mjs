import test from 'node:test';
import assert from 'node:assert/strict';
import { createAliExpressPublicClient } from '../lib/retail/aliexpress.mjs';

const productId = '1005011947482958';
const subject = 'Public USB cable listing';
const origin = 'https://ko.aliexpress.com';
const body = {
  code: 200, success: true,
  body: {
    title: 'Public USB cable listing - AliExpress',
    description: 'Public item description',
    canonical: `<link rel="canonical" href="${origin}/item/${productId}.html" />`,
  },
};

test('replays the observed anonymous SEO XHR with exact query and scoped referer', async () => {
  let calls = 0;
  const fetchImpl = async (rawUrl, init) => {
    calls++;
    const url = new URL(rawUrl);
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/aeglodetailweb/api/seo/seodata');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      channel: 'detail', device: 'pc', productId, subject,
    });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.get('referer'), `${origin}/item/${productId}.html`);
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('authorization'), null);
    return Response.json(body);
  };
  const result = await createAliExpressPublicClient({ fetchImpl, now: () => 1_000 }).getProductSeo({ productId, subject });
  assert.equal(calls, 1);
  assert.equal(result.productId, productId);
  assert.equal(result.canonicalUrl, `${origin}/item/${productId}.html`);
  assert.equal(result.price, null);
  assert.equal(result.currency, null);
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.receipt.cookieSent, false);
  assert.equal(result.receipt.schemaVerified, true);
  assert.equal(result.receipt.responseBytes > 0, true);
});

test('fetches the same product metadata by ID alone with the independently verified optional subject', async () => {
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    assert.deepEqual([...url.searchParams.keys()], ['channel', 'device', 'productId']);
    assert.equal(init.headers.get('referer'), `${origin}/item/${productId}.html`);
    return Response.json(body);
  };
  const result = await createAliExpressPublicClient({ fetchImpl }).getProductSeo({ productId });
  assert.equal(result.productId, productId);
  assert.equal(result.receipt.schemaVerified, true);
});

test('rejects a redirected/challenge response without following it', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response('', { status: 302, headers: { location: '/p/error/404.html' } });
  };
  await assert.rejects(
    createAliExpressPublicClient({ fetchImpl }).getProductSeo({ productId, subject }),
    { code: 'ALIEXPRESS_REDIRECTED' },
  );
  assert.equal(calls, 1);
});

test('rejects a success envelope bound to another product', async () => {
  const wrong = structuredClone(body);
  wrong.body.canonical = '<link rel="canonical" href="https://ko.aliexpress.com/item/9999999999999999.html" />';
  const fetchImpl = async () => Response.json(wrong);
  await assert.rejects(
    createAliExpressPublicClient({ fetchImpl }).getProductSeo({ productId, subject }),
    { code: 'ALIEXPRESS_SCHEMA_INVALID' },
  );
});

test('requires a numeric product ID and validates any caller-supplied title before network access', async () => {
  const fetchImpl = async () => { throw new Error('network must not run'); };
  const client = createAliExpressPublicClient({ fetchImpl });
  for (const input of [
    { productId: '../private', subject },
    { productId, subject: '' },
    { productId, subject: 'a\nb' },
  ]) {
    await assert.rejects(client.getProductSeo(input), { code: 'ALIEXPRESS_INPUT_INVALID' });
  }
});
