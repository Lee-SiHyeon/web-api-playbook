import test from 'node:test';
import assert from 'node:assert/strict';
import { coupangForbiddenCode } from '../lib/web-auth/coupang-response.mjs';

const deniedHtml = '<!doctype html><html><head><title>Access Denied</title></head><body>private response details</body></html>';

test('classifies only a 403 HTML response with an Access Denied title', () => {
  assert.equal(coupangForbiddenCode({
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    raw: Buffer.from(deniedHtml),
  }), 'COUPANG_HTTP_ACCESS_DENIED');
});

test('matches header and title casing without exposing response content', () => {
  const result = coupangForbiddenCode({
    status: 403,
    headers: { 'Content-Type': 'TEXT/HTML; Charset=UTF-8' },
    raw: Buffer.from('<HTML><HEAD><TITLE>  ACCESS   DENIED </TITLE></HEAD></HTML>'),
  });
  assert.equal(result, 'COUPANG_HTTP_ACCESS_DENIED');
  assert.equal(JSON.stringify(result).includes('private response details'), false);
});

test('leaves JSON and non-HTML 403 responses in the generic forbidden class', () => {
  for (const contentType of ['application/json', 'text/plain', 'application/xhtml+xml', '']) {
    assert.equal(coupangForbiddenCode({
      status: 403,
      headers: { 'content-type': contentType },
      raw: Buffer.from(deniedHtml),
    }), 'AUTH_FORBIDDEN');
  }
});

test('does not label HTML 403 without the exact denied page title', () => {
  for (const raw of [
    '<html><title>Login</title></html>',
    '<html><body>Access Denied</body></html>',
    '<html><title>Access denied by policy</title></html>',
    Buffer.alloc(0),
  ]) {
    assert.equal(coupangForbiddenCode({ status: 403, headers: { 'content-type': 'text/html' }, raw }), 'AUTH_FORBIDDEN');
  }
});

test('checks a bounded body prefix and falls back safely on malformed responses', () => {
  const overLimit = Buffer.concat([Buffer.alloc(64 * 1024, 0x20), Buffer.from(deniedHtml)]);
  assert.equal(coupangForbiddenCode({ status: 403, headers: { 'content-type': 'text/html' }, raw: overLimit }), 'AUTH_FORBIDDEN');
  assert.equal(coupangForbiddenCode(null), 'AUTH_FORBIDDEN');
  assert.equal(coupangForbiddenCode({ status: 403, headers: null, raw: Buffer.from(deniedHtml) }), 'AUTH_FORBIDDEN');
  assert.equal(coupangForbiddenCode({ status: 200, headers: { 'content-type': 'text/html' }, raw: Buffer.from(deniedHtml) }), 'AUTH_FORBIDDEN');
});
