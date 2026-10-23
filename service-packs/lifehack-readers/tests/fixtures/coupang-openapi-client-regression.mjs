import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildCoupangOpenApiAuthorization,
  issueCoupangPartnerLink,
} from '../../src/lib/coupang-openapi.ts';

const credentials = Object.freeze({
  accessKey: 'synthetic-access-key',
  secretKey: 'synthetic-secret-key',
});
const timestamp = new Date('2026-10-08T10:05:06.000Z');
const signedTarget = '/v2/providers/affiliate_open_api/apis/openapi/v1/products/search?keyword=usb%20c';
const authorization = buildCoupangOpenApiAuthorization('GET', signedTarget, credentials, timestamp);
const message = '261008T100506ZGET/v2/providers/affiliate_open_api/apis/openapi/v1/products/searchkeyword=usb%20c';
const expectedSignature = createHmac('sha256', credentials.secretKey).update(message, 'utf8').digest('hex');
assert.equal(authorization,
  'CEA algorithm=HmacSHA256, access-key=synthetic-access-key, signed-date=261008T100506Z, signature=' + expectedSignature);
assert.equal(authorization.includes(credentials.secretKey), false);

const productUrl = 'https://www.coupang.com/vp/products/9536051541?itemId=28441863454&vendorItemId=95393217933';
const landingUrl = 'https://link.coupang.com/re/AFFSDP?lptag=AF1234567&pageKey=9536051541&itemId=28441863454&vendorItemId=95393217933&traceid=V0-183-test';
function makeJournal(events, prepareResult = { reserved: true, reservationId: 'test-reservation-01' }) {
  return {
    async prepare(intent) {
      events.push({ kind: 'prepare', intent });
      return prepareResult;
    },
    async finish(receipt) {
      events.push({ kind: 'finish', receipt });
    },
  };
}

let calls = 0;
let requestRecord;
const events = [];
const fetchImpl = async (input, init) => {
  calls += 1;
  events.push({ kind: 'fetch' });
  requestRecord = { url: String(input), init, body: JSON.parse(String(init.body)) };
  const response = new Response(JSON.stringify({
    rCode: '0',
    rMessage: '',
    data: [{ originalUrl: productUrl, shortenUrl: 'https://coupa.ng/testCode7', landingUrl }],
  }), { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } });
  assert.equal((await response.clone().json()).rCode, '0');
  return response;
};

const issued = await issueCoupangPartnerLink(productUrl, {
  credentials,
  journal: makeJournal(events),
  fetchImpl,
  now: () => timestamp,
  expectedAffiliateCode: 'AF1234567',
  subId: 'registered-test-channel',
});
assert.equal(calls, 1, 'deeplink POST is never retried');
assert.equal(requestRecord.url,
  'https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink');
assert.equal(requestRecord.init.method, 'POST');
assert.equal(requestRecord.init.redirect, 'error');
assert.deepEqual(requestRecord.body, { coupangUrls: [productUrl], subId: 'registered-test-channel' });
assert.match(new Headers(requestRecord.init.headers).get('authorization') ?? '', /^CEA algorithm=HmacSHA256, access-key=synthetic-access-key,/);
assert.equal(issued.shortUrl, 'https://coupa.ng/testCode7');
assert.equal(issued.productUrl, productUrl);
assert.equal(issued.destinationVerified, true);
assert.equal(issued.attributionVerified, true);
assert.equal(issued.ownerVerified, false, 'a signed API key response is not owner-email proof');
assert.equal(issued.independentReadbackVerified, false);
assert.equal(Object.hasOwn(issued, 'lptag'), false, 'the raw affiliate code is not returned');
assert.deepEqual(events.map((event) => event.kind), ['prepare', 'fetch', 'finish'], 'intent is durable before dispatch');
assert.deepEqual(Object.keys(events[0].intent).sort(), ['fingerprint', 'method', 'path', 'payloadDigest', 'productUrl', 'service']);
assert.equal(events[0].intent.productUrl, productUrl);
assert.equal(events[0].intent.path, '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink');
assert.deepEqual(events[2].receipt, {
  reservationId: 'test-reservation-01', outcome: 'acknowledged', httpStatus: 200, responseCode: 'ISSUED',
});

let mismatchedCalls = 0;
const mismatchEvents = [];
const mismatch = await issueCoupangPartnerLink(productUrl, {
  credentials,
  journal: makeJournal(mismatchEvents),
  fetchImpl: async () => {
    mismatchedCalls += 1;
    return new Response(JSON.stringify({
      rCode: '0', rMessage: '',
      data: [{ originalUrl: productUrl, shortenUrl: 'https://coupa.ng/testCode7',
        landingUrl: landingUrl.replace('AF1234567', 'AF7654321') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
  now: () => timestamp,
  expectedAffiliateCode: 'AF1234567',
});
assert.equal(mismatchedCalls, 1);
assert.equal(mismatch.destinationVerified, true);
assert.equal(mismatch.attributionVerified, false);
assert.equal(mismatch.attributionMismatch, true);

let unknownCalls = 0;
const unknownEvents = [];
await assert.rejects(issueCoupangPartnerLink(productUrl, {
  credentials,
  journal: makeJournal(unknownEvents),
  fetchImpl: async () => {
    unknownCalls += 1;
    return new Response(JSON.stringify({
      rCode: '0', rMessage: '',
      data: [{ originalUrl: productUrl, shortenUrl: 'https://coupa.ng/testCode7', landingUrl: 'https://evil.example/' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
  now: () => timestamp,
}), (error) => error?.code === 'COUPANG_OPENAPI_OUTCOME_UNKNOWN');
assert.equal(unknownCalls, 1, 'an unverified successful response is outcome-unknown and is not retried');
assert.equal(unknownEvents.at(-1).receipt.outcome, 'outcome_unknown');

let rejectedCalls = 0;
const rejectedEvents = [];
await assert.rejects(issueCoupangPartnerLink(productUrl, {
  credentials,
  journal: makeJournal(rejectedEvents),
  fetchImpl: async () => {
    rejectedCalls += 1;
    return new Response('sensitive provider body must stay hidden', { status: 429, headers: { 'content-type': 'text/plain' } });
  },
  now: () => timestamp,
}), (error) => error?.code === 'COUPANG_OPENAPI_RATE_LIMITED'
  && !error.message.includes('sensitive provider body'));
assert.equal(rejectedCalls, 1);
assert.equal(rejectedEvents.at(-1).receipt.outcome, 'rejected');

let transportCalls = 0;
const transportEvents = [];
await assert.rejects(issueCoupangPartnerLink(productUrl, {
  credentials,
  journal: makeJournal(transportEvents),
  fetchImpl: async () => { transportCalls += 1; throw new Error('synthetic transport failure'); },
  now: () => timestamp,
}), (error) => error?.code === 'COUPANG_OPENAPI_OUTCOME_UNKNOWN'
  && !error.message.includes('synthetic transport failure'));
assert.equal(transportCalls, 1, 'a lost POST response is not automatically retried');
assert.equal(transportEvents.at(-1).receipt.outcome, 'outcome_unknown');

let unjournaledCalls = 0;
await assert.rejects(issueCoupangPartnerLink(productUrl, {
  credentials,
  journal: {
    async prepare() { throw new Error('synthetic journal unavailable'); },
    async finish() { throw new Error('must not run'); },
  },
  fetchImpl: async () => { unjournaledCalls += 1; return new Response('{}'); },
  now: () => timestamp,
}), (error) => error?.code === 'COUPANG_OPENAPI_INTENT_RESERVATION_FAILED'
  && !error.message.includes('synthetic journal unavailable'));
assert.equal(unjournaledCalls, 0, 'no mutation is sent before the issue journal reserves its fingerprint');

let duplicateCalls = 0;
await assert.rejects(issueCoupangPartnerLink(productUrl, {
  credentials,
  journal: makeJournal([], null),
  fetchImpl: async () => { duplicateCalls += 1; return new Response('{}'); },
  now: () => timestamp,
}), (error) => error?.code === 'COUPANG_OPENAPI_INTENT_ALREADY_RESERVED');
assert.equal(duplicateCalls, 0, 'a previously reserved intent cannot be retried automatically');

let invalidUrlCalls = 0;
await assert.rejects(issueCoupangPartnerLink('https://evil.example/vp/products/1', {
  credentials,
  fetchImpl: async () => { invalidUrlCalls += 1; return new Response('{}'); },
  now: () => timestamp,
}), (error) => error?.code === 'COUPANG_OPENAPI_PRODUCT_URL_INVALID');
assert.equal(invalidUrlCalls, 0, 'validation fails before transport');
