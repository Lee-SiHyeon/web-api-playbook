import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseModetourDocument, collectModetourDocument, compareModetourDocumentToBrowser,
  MODETOUR_DOCUMENT_URL } from './modetour-document.mjs';

const fixture = await readFile(new URL('./fixtures/agent-modetour-document.sample.html', import.meta.url), 'utf8');
const queryKey = 'getPackageGetRecommendedProduct({"theme":"Package"})';
const htmlFrom = data => `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;
const dataFromFixture = () => JSON.parse(fixture.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
const rowsOf = data => data.props.pageProps.initialState.api.queries[queryKey].data.result.package;

test('Document embedded JSON keeps feed and master prices distinct without currency inference', () => {
  const result = parseModetourDocument(fixture);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].sellerProductId, '49617');
  assert.equal(result.items[0].summaryAmount, 329000);
  assert.equal(result.items[1].summaryAmount, 2049000);
  assert.equal(result.items[1].productMasterAmount, 2099000);
  assert.equal(result.items[1].currency, null);
  assert.equal(result.items[1].quotedBasis, null);
  assert.equal(result.source.resourceType, 'Document');
  assert.equal(result.coverage.snapshotComplete, false);
});

test('unrelated state and extra row credentials never leave the projection', () => {
  const data = dataFromFixture();
  data.props.pageProps.accessToken = 'SYNTHETIC_SECRET_SENTINEL';
  rowsOf(data)[0].authorization = 'SYNTHETIC_SECRET_SENTINEL';
  assert.ok(!JSON.stringify(parseModetourDocument(htmlFrom(data))).includes('SYNTHETIC_SECRET_SENTINEL'));
});

test('login or challenge HTML is a schema failure, not a successful empty catalog', () => {
  assert.throws(() => parseModetourDocument('<html><title>Sign in</title></html>'), { code: 'HTML_LAYOUT_CHANGED' });
  assert.throws(() => parseModetourDocument('<html><title>Just a moment</title></html>'), { code: 'HTML_LAYOUT_CHANGED' });
});

test('wrong page, duplicate scripts and empty feed fail closed', () => {
  const data = dataFromFixture();
  data.page = '/sign-in';
  assert.throws(() => parseModetourDocument(htmlFrom(data)), { code: 'HTML_LAYOUT_CHANGED' });
  assert.throws(() => parseModetourDocument(fixture + fixture), { code: 'HTML_LAYOUT_CHANGED' });
  const empty = dataFromFixture();
  rowsOf(empty).length = 0;
  assert.throws(() => parseModetourDocument(htmlFrom(empty)), { code: 'HTML_LAYOUT_CHANGED' });
});

test('changed price fields, duplicate product IDs and failed application envelopes are rejected', () => {
  const malformed = dataFromFixture();
  rowsOf(malformed)[0].price = 'ask for quote';
  assert.throws(() => parseModetourDocument(htmlFrom(malformed)), { code: 'DOCUMENT_PRODUCT_SCHEMA_CHANGED' });
  const duplicate = dataFromFixture();
  rowsOf(duplicate).push(rowsOf(duplicate)[0]);
  assert.throws(() => parseModetourDocument(htmlFrom(duplicate)), { code: 'DOCUMENT_DUPLICATE_PRODUCT' });
  const rejected = dataFromFixture();
  rejected.props.pageProps.initialState.api.queries[queryKey].data.isOK = false;
  assert.throws(() => parseModetourDocument(htmlFrom(rejected)), { code: 'HTML_LAYOUT_CHANGED' });
});

test('independent HTTP sends one fixed anonymous Document request and retains no raw HTML', async () => {
  const calls = [];
  const result = await collectModetourDocument({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(fixture, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'test=SECRET' } });
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MODETOUR_DOCUMENT_URL);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(Object.keys(calls[0].options.headers), ['accept']);
  assert.equal(result.response.status, 200);
  assert.equal(result.browserUsed, false);
  assert.equal(result.rawDocumentPersisted, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(!JSON.stringify(result).includes('<html>'));
});

test('redirect and incorrect MIME are not followed or parsed', async () => {
  let calls = 0;
  await assert.rejects(collectModetourDocument({ fetchImpl: async () => {
    calls++; return new Response('', { status: 302, headers: { location: 'https://example.invalid/login' } });
  } }), { code: 'DOCUMENT_HTTP_302' });
  assert.equal(calls, 1);
  await assert.rejects(collectModetourDocument({ fetchImpl: async () => new Response(fixture,
    { headers: { 'content-type': 'application/json' } }) }), { code: 'DOCUMENT_CONTENT_TYPE_INVALID' });
});

test('oversized declared and streaming bodies are cancelled', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; } });
    await assert.rejects(collectModetourDocument({ fetchImpl: async () => new Response(body,
      { headers: { 'content-type': 'text/html', ...(declared ? { 'content-length': '2097153' } : {}) } }) }),
    { code: 'DOCUMENT_BODY_TOO_LARGE' });
    assert.equal(cancelled, true);
  }
});

test('browser comparison checks every title and feed amount, not just card count or a detail price', () => {
  const { items } = parseModetourDocument(fixture);
  const rendered = items.map(item => ({ text: `${item.displayTitle} ${item.summaryAmount.toLocaleString('en-US')}원 ~` }));
  assert.equal(compareModetourDocumentToBrowser(items, rendered).ok, true);
  const changed = rendered.map(row => ({ ...row }));
  changed[1].text = changed[1].text.replace('2,049,000', '2,099,000');
  assert.equal(compareModetourDocumentToBrowser(items, changed).ok, false);
  assert.equal(compareModetourDocumentToBrowser(items, [rendered[0], rendered[0]]).ok, false);
  assert.equal(compareModetourDocumentToBrowser(items, rendered.slice(0, 1)).reason, 'CARD_COUNT_MISMATCH');
});
