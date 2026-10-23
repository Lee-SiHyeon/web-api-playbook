import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fetchEleventhStreetDeals } from '../research/content-store/eleventh-street-deals.mjs';

// Three product cards trimmed from the live EUC-KR HTML response; the final card
// repeats the first product link to exercise ID-based deduplication.
const RAW_FIXTURE = Buffer.from(
  'PGh0bWw+PGhlYWQ+PG1ldGEgaHR0cC1lcXVpdj0iQ29udGVudC1UeXBlIiBjb250ZW50PSJ0ZXh0L2h0bWw7IGNoYXJzZXQ9ZXVjLWtyIj48L2hlYWQ+PGJvZHk+PGxpIGlkPSIyNzYyNjY2OTQwIj48YSBocmVmPSJodHRwczovL3d3dy4xMXN0LmNvLmtyL3Byb2R1Y3RzLzI3NjI2NjY5NDA/dHJUeXBlQ2Q9MzQiPjxkaXYgY2xhc3M9ImluZm9fZmxhZyI+CjxlbT65q7fhuei82zwvZW0+Jm5ic3A7PHNwYW4gY2xhc3M9J2Jhcl8xMV9iYic+PC9zcGFuPiZuYnNwOzxlbT48c3BhbiBjbGFzcz0ibHNuIj4xMXBheTwvc3Bhbj4gw9a06zxzcGFuIGNsYXNzPSJwb2ludDIgbHNuIj43LDAwM1A8L3NwYW4+wPu4szwvZW0+CgkJCQkJCQkJICAgIAoJCQkJCQkJCQk8L2Rpdj48c3BhbiBjbGFzcz0ibnVtIj48c3BhbiBjbGFzcz0ic2tpcCI+x/bA5yCzssC6u/PHsDwvc3Bhbj48ZW0+NTAwsLM8L2VtPiCzssC9PC9zcGFuPjxwIGNsYXNzPSJuYW1lIj7FxLXwILChwLu9xbvzILOyL7+pILfOxtsvxt/Hwb26yPovvbq0z8S/we48L3A+PHNwYW4gY2xhc3M9InNhbGUiPjxzcGFuIGNsYXNzPSJza2lwIj7H0sDOPC9zcGFuPjE1PHNwYW4+JTwvc3Bhbj48L3NwYW4+PHMgY2xhc3M9Im5vcm1hbF9wcmljZSI+MTM0LDAwML/4PC9zPjxzdHJvbmcgY2xhc3M9InNhbGVfcHJpY2UiPjExMyw5MDA8L3N0cm9uZz48L2E+PC9saT48bGkgaWQ9IjkyMjAzMTE2NTEiPjxhIGhyZWY9Imh0dHBzOi8vd3d3LjExc3QuY28ua3IvcHJvZHVjdHMvOTIyMDMxMTY1MT90clR5cGVDZD0zNCI+PGRpdiBjbGFzcz0iaW5mb19mbGFnIj4KPGVtPrmrt+G56LzbPC9lbT4mbmJzcDs8c3BhbiBjbGFzcz0nYmFyXzExX2JiJz48L3NwYW4+Jm5ic3A7PGVtPjxzcGFuIGNsYXNzPSJsc24iPjExcGF5PC9zcGFuPiDD1rTrPHNwYW4gY2xhc3M9InBvaW50MiBsc24iPjEsMDYzUDwvc3Bhbj7A+7izPC9lbT4KCQkJCQkJCQkgICAgCgkJCQkJCQkJCTwvZGl2PjxzcGFuIGNsYXNzPSJudW0iPjxzcGFuIGNsYXNzPSJza2lwIj7H9sDnILOywLq788ewPC9zcGFuPjxlbT4zMTewszwvZW0+ILOywL08L3NwYW4+PHAgY2xhc3M9Im5hbWUiPrnMve5+sKHAuyBCRVNUIMDMv/kgxay4rr7ut7G9uiDGr7ChPC9wPjxzdHJvbmcgY2xhc3M9InNhbGVfcHJpY2UiPjE0LDkwMDwvc3Ryb25nPjwvYT48L2xpPjxsaSBpZD0iMjc2MjY2Njk0MCI+PGEgaHJlZj0iaHR0cHM6Ly93d3cuMTFzdC5jby5rci9wcm9kdWN0cy8yNzYyNjY2Njk0MD90clR5cGVDZD0zNCI+PGRpdiBjbGFzcz0iaW5mb19mbGFnIj4KPGVt+au34bnovNs8L2VtPiZuYnNwOzxzcGFuIGNsYXNzPSdiYXJfMTFfYmInPjwvc3Bhbj4mbmJzcDs8ZW0+PHNwYW4gY2xhc3M9ImxzbiI+MTFwYXk8L3NwYW4+IMPWtOs8c3BhbiBjbGFzcz0icG9pbnQyIGxzbiI+NywwMDNQPC9zcGFuPsD7uLM8L2VtPgoJCQkJCQkJCSAgICAKCQkJCQkJCQkJPC9kaXY+PHNwYW4gY2xhc3M9Im51bSI+PHNwYW4gY2xhc3M9InNraXAiPsf2wOcgs7LAurvzx7A8L3NwYW4+PGVtPjUwMLCzPC9lbT4gs7LAvTwvc3Bhbj48cCBjbGFzcz0ibmFtZSI+xcS18CCwocC7vcW78yCzsi+/qSC3zsbbL8bfx8G9usj6L726tM/Ev8HuPC9wPjxzcGFuIGNsYXNzPSJzYWxlIj48c3BhbiBjbGFzcz0ic2tpcCI+x9LAzjwvc3Bhbj4xNTxzcGFuPiU8L3NwYW4+PC9zcGFuPjxzIGNsYXNzPSJub3JtYWxfcHJpY2UiPjEzNCwwMDC/+Dwvcz48c3Ryb25nIGNsYXNzPSJzYWxlX3ByaWNlIj4xMTMsOTAwPC9zdHJvbmc+PC9hPjwvbGk+PC9ib2R5PjwvaHRtbD4=',
  'base64',
);
const FIXTURE = Buffer.from(
  RAW_FIXTURE.toString('latin1').replace('/products/27626666940?', '/products/2762666940?'),
  'latin1',
);

function responseFor(body, status = 200, headers = { 'content-type': 'text/html' }) {
  return new Response(body, { status, headers });
}

test('decodes the EUC-KR fixture, extracts fields, and deduplicates products by ID', async () => {
  let calls = 0;
  const result = await fetchEleventhStreetDeals(10, {
    fetchImpl: async () => {
      calls++;
      return responseFor(FIXTURE);
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.charset, 'euc-kr');
  assert.equal(result.receipt.dataSource, 'html');
  assert.equal(result.receipt.observedItems, 3);
  assert.equal(result.receipt.uniqueProducts, 2);
  assert.equal(result.receipt.responseSha256, createHash('sha256').update(FIXTURE).digest('hex'));
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.items.length, 2);

  assert.equal(result.items[0].title, '탠디 가을신상 남/여 로퍼/펌프스힐/스니커즈');
  assert.equal(result.items[0].url, 'https://www.11st.co.kr/products/2762666940?trTypeCd=34');
  assert.equal(result.items[0].publishedAt, null);
  assert.equal(result.items[0].publisher, '11번가 쇼킹딜');
  assert.deepEqual(result.items[0].deal, {
    productId: '2762666940',
    price: 134000,
    salePrice: 113900,
    discountRate: 15,
    deliveryText: '무료배송',
    quantityText: '현재 남은상품 500개 남음',
  });
  assert.match(result.items[0].summary, /판매가 113,900원/);

  assert.equal(result.items[1].title, '미쏘~가을 BEST 이월 클리어런스 특가');
  assert.deepEqual(result.items[1].deal, {
    productId: '9220311651',
    price: null,
    salePrice: 14900,
    discountRate: null,
    deliveryText: '무료배송',
    quantityText: '현재 남은상품 317개 남음',
  });
});

test('throws SCHEMA for a product link with no usable title', async () => {
  const malformed = '<html><body><li><a href="https://www.11st.co.kr/products/12345">상품</a></li></body></html>';
  await assert.rejects(
    fetchEleventhStreetDeals(5, { fetchImpl: async () => responseFor(malformed) }),
    error => error.code === 'SCHEMA',
  );
});

test('throws ACCESS_BLOCKED on HTTP 403 and a bot challenge without retrying', async () => {
  for (const blockedResponse of [
    responseFor('Forbidden', 403),
    responseFor('<html><body>Access Denied: verify you are human</body></html>'),
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchEleventhStreetDeals(5, {
        fetchImpl: async () => {
          calls++;
          return blockedResponse;
        },
      }),
      error => error.code === 'ACCESS_BLOCKED',
    );
    assert.equal(calls, 1);
  }
});
