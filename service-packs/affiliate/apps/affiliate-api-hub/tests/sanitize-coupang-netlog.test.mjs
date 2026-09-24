import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetLogText, sanitizeNetLog, sanitizeUrl } from '../scripts/sanitize-coupang-netlog.mjs';

test('URL sanitizer removes values and redacts opaque path segments', () => {
  assert.deepEqual(sanitizeUrl('https://partners.coupang.com/api/v1/product/123456789?keyword=secret&token=private'), {
    origin: 'https://partners.coupang.com',
    host: 'partners.coupang.com',
    path: '/api/v1/product/:number',
    queryFields: ['keyword', 'token'],
    firstParty: true,
  });
});

test('NetLog sanitizer never persists cookie, auth, query values or bodies', () => {
  const fixture = {
    constants: { logEventTypes: { URL_REQUEST_START_JOB: 1, HTTP_TRANSACTION_SEND_REQUEST_HEADERS: 2 } },
    events: [
      { type: 1, source: { type: 1, id: 10 }, params: { url: 'https://partners.coupang.com/api/v1/product/search?q=private-value&token=secret-token', method: 'GET' } },
      { type: 2, source: { type: 1, id: 10 }, params: { headers: ['Cookie: SID=private-cookie', 'Authorization: Bearer private-auth', 'Accept: application/json'], line: 'GET /api/v1/product/search HTTP/1.1' } },
      { type: 1, params: { url: 'https://external.invalid/collect?secret=value', method: 'POST', upload_data: 'private-body' } },
    ],
  };
  const record = sanitizeNetLog(fixture, { sourceName: 'fixture.json', now: () => new Date('2026-09-19T00:00:00Z') });
  assert.equal(record.firstPartyEndpoints, 1);
  assert.equal(record.endpoints[0].path, '/api/v1/product/search');
  assert.deepEqual(record.endpoints[0].queryFields, ['q', 'token']);
  assert.equal(record.endpoints[0].likelyApi, true);
  const text = JSON.stringify(record);
  for (const secret of ['private-value', 'secret-token', 'private-cookie', 'private-auth', 'private-body']) {
    assert.doesNotMatch(text, new RegExp(secret));
  }
  assert.equal(record.cookieValuesPersisted, false);
  assert.equal(record.authorizationValuesPersisted, false);
  assert.equal(record.requestBodiesPersisted, false);
  assert.equal(record.mutationRequestsSent, 0);
  assert.equal(record.observedRequests.length, 1);
  assert.equal(record.observedRequests[0].requestObserved, true);
  assert.deepEqual(record.observedRequests[0].methods, ['GET']);
});

test('an active Chrome NetLog snapshot is closed only at a complete trailing event boundary', () => {
  const partial = '{"constants":{"logEventTypes":{"A":1}},"events":[{"type":1,"params":{"url":"https://partners.coupang.com/api/v1/product"}},\n';
  const parsed = parseNetLogText(partial);
  assert.equal(parsed.sourceComplete, false);
  assert.equal(parsed.repairedTrailingEventsArray, true);
  assert.equal(parsed.data.events.length, 1);
  assert.throws(() => parseNetLogText(partial.slice(0, -5)));
});
