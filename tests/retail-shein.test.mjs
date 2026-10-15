import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSheinPublicClient, parseSheinHomeDocument } from '../lib/retail/shein.mjs';

const fixture = await readFile(new URL('./fixtures/retail/shein-home.html', import.meta.url), 'utf8');
const html = (body, status = 200, mime = 'text/html; charset=utf-8') => new Response(body, { status, headers: { 'content-type': mime } });

test('observed home cards preserve currency, raw labels and separate category/collection identities', () => {
  const result = parseSheinHomeDocument(fixture);
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].salePrice.amount, '3732');
  assert.equal(result.products[0].salePrice.displayText, '3,732원');
  assert.equal(result.products[0].retailPrice.amount, '5890');
  assert.equal(result.context.currency, 'KRW');
  assert.equal(result.context.shipToCountry, null);
  assert.equal(result.products[0].productUrl, null);
  assert.equal(result.products[0].stock, null);
  assert.equal(result.products[0].options, null);
  assert.equal(result.navigation[0].idNamespace, 'category');
  assert.equal(result.navigation[1].idNamespace, 'collection');
  assert.equal(result.coverage.completeCatalog, false);
});

test('runtime reads only the fixed home Document without credentials and projects public fields', async () => {
  const contaminated = fixture.replace('"SiteUID":"kr"', '"_traceId":"PRIVATE_TRACE","sessionToken":"PRIVATE_TOKEN","SiteUID":"kr"');
  let calls = 0;
  const result = await createSheinPublicClient({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://kr.shein.com/');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'text/html' });
    return html(contaminated);
  } }).getHomeCatalog();
  assert.equal(calls, 1);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.schemaVerified, true);
  assert.equal(result.receipt.rawBodyPersisted, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|usdAmount|sessionToken|_traceId/);
});

test('unknown currency stays unknown despite a Korean locale and won labels', () => {
  const result = parseSheinHomeDocument(fixture.replace('"currency":"KRW"', '"currency":"UNKNOWN"'));
  assert.equal(result.context.currency, null);
  assert.equal(result.products[0].salePrice.currencyVerified, false);
});

test('challenge, missing navigation, missing data, malformed JS and wrong market fail closed', () => {
  for (const [body, code] of [
    ['<html><title>Just a moment...</title></html>', 'SHEIN_CHALLENGE'],
    [fixture.replace('aria-label="Category menu"', 'aria-label="Changed"'), 'SHEIN_HTML_LAYOUT_CHANGED'],
    [fixture.replace('gbRawData', 'otherData'), 'SHEIN_HTML_LAYOUT_CHANGED'],
    [fixture.replace('window.gbRawData = {', 'window.gbRawData = build({'), 'SHEIN_EMBEDDED_JSON_INVALID'],
    [fixture.replace('"SiteUID":"kr"', '"SiteUID":"us"'), 'SHEIN_SCHEMA_INVALID'],
    [fixture.replace('"amount":"3732"', '"amount":"3,732"'), 'SHEIN_PRICE_SCHEMA_INVALID'],
  ]) assert.throws(() => parseSheinHomeDocument(body), { code });
});

test('script suffixes never execute and braces in JSON strings are parsed as strings', () => {
  const changed = fixture.replace('중국풍 탑', '중국풍 } ] 탑').replace(';</script>', '; throw new Error("DO_NOT_EXECUTE");</script>');
  assert.match(parseSheinHomeDocument(changed).products[0].title, /} ]/);
});

test('duplicate embedded assignments are rejected', () => {
  assert.throws(() => parseSheinHomeDocument(fixture.replace('</body>', '<script>window.gbRawData = {};</script></body>')),
    { code: 'SHEIN_HTML_LAYOUT_CHANGED' });
});

test('HTTP failures and redirect responses are not retried or accepted as catalogs', async () => {
  for (const status of [302, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(createSheinPublicClient({ fetchImpl: async () => { calls++; return html('', status); } }).getHomeCatalog(),
      error => error instanceof Error && error.receipt.httpStatus === status);
    assert.equal(calls, 1);
  }
  await assert.rejects(createSheinPublicClient({ fetchImpl: async () => html(fixture, 200, 'application/json') }).getHomeCatalog(),
    { code: 'SHEIN_RESPONSE_INVALID' });
});

test('response stream is bounded before parsing', async () => {
  await assert.rejects(createSheinPublicClient({ fetchImpl: async () => html('x'.repeat(4 * 1024 * 1024 + 1)) }).getHomeCatalog(),
    { code: 'SHEIN_RESPONSE_TOO_LARGE' });
});
