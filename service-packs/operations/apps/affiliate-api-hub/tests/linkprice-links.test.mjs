import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { merchantFor, tistoryLink, linkableProducts, buildLinks, CLICK_LINK, SITES } from '../scripts/linkprice-links.mjs';

const click = (m, a, target) => `https://click.linkprice.com/click.php?m=${m}&a=${a}&l=9999&l_cd1=3&l_cd2=0&tu=${encodeURIComponent(target)}`;

test('approved merchants by host; 11번가 and 쿠팡 are not linkable', () => {
  assert.equal(merchantFor('https://www.lotteon.com/product/LO1').merchantId, 'lotteon');
  assert.equal(merchantFor('https://item.gmarket.co.kr/Item?goodscode=1').merchantId, 'gmarket');
  assert.equal(merchantFor('https://experiences.myrealtrip.com/products/1').merchantId, 'myrealtrip');
  assert.equal(merchantFor('https://www.11st.co.kr/products/1'), null);
  assert.equal(merchantFor('https://www.coupang.com/vp/products/1'), null);
});

test('the Tistory link swaps only the site id', () => {
  const naver = click('lotteon', SITES.naver, 'https://www.lotteon.com/product/LO1');
  assert.ok(CLICK_LINK.test(naver));
  assert.equal(tistoryLink(naver), click('lotteon', SITES.tistory, 'https://www.lotteon.com/product/LO1'));
  assert.equal(tistoryLink('https://www.lotteon.com/product/LO1'), null);
});

test('links are built once per product through the approved-merchant builder and hash-bound', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lp-'));
  writeFileSync(path.join(dir, 'article-brief.json'), JSON.stringify({ headline: 'h', evidence: { urls: ['https://www.lotteon.com/product/LO1', 'https://www.11st.co.kr/products/2'] },
    mustVerify: ['https://item.gmarket.co.kr/Item?goodscode=3 — 가격 재확인'] }));
  assert.deepEqual(linkableProducts(JSON.parse(readFileSync(path.join(dir, 'article-brief.json'), 'utf8'))).map(p => p.merchantId), ['lotteon', 'gmarket']);
  const calls = [];
  const link = async input => { calls.push(input); return input.merchantId === 'gmarket' ? { ok: false, code: 'MERCHANT_NOT_APPROVED' }
    : { ok: true, url: click(input.merchantId, input.affiliateId, input.targetUrl), subscriptionStatus: 'APR' }; };
  const r = await buildLinks(dir, { link });
  assert.equal(r.total, 1); assert.deepEqual(r.failed.map(f => f.code), ['MERCHANT_NOT_APPROVED']);
  assert.ok(calls.every(c => c.affiliateId === SITES.naver));
  const store = JSON.parse(readFileSync(path.join(dir, 'linkprice-links.json'), 'utf8'));
  assert.match(store.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(store.links['https://www.lotteon.com/product/LO1'].merchantId, 'lotteon');
  await buildLinks(dir, { link });
  assert.equal(calls.filter(c => c.merchantId === 'lotteon').length, 1); // an existing link is never rebuilt
});
