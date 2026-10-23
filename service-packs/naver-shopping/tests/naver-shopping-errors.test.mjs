import test from 'node:test';
import assert from 'node:assert/strict';
import { NaverShoppingClient, isVerificationChallenge } from '../adapters/naver-shopping.mjs';
const api = 'https://brand.naver.com/n/v2/channels/fixture/products/123?withWindow=false';
const restrictedHtml = '<html>쇼핑 서비스 접속이 일시적으로 제한되었습니다.</html>';
for (const [status, expected] of [[429, 'RATE_LIMITED'], [418, 'WAF_BLOCKED']]) {
 test(`HTTP ${status} takes precedence over common restriction HTML`, async () => {
  const client = new NaverShoppingClient({ fetchImpl: async () => new Response(restrictedHtml, {status, headers:{'content-type':'text/html'}}) });
  await assert.rejects(client.request(api, {json:true}), e => e.code === expected && e.receipt.httpStatus === status);
 });
}
test('Retry-After is retained in the receipt without automatic retry', async () => {
 let calls = 0;
 const client = new NaverShoppingClient({ fetchImpl: async () => {calls++; return new Response(restrictedHtml, {status:429,headers:{'content-type':'text/html','retry-after':'60'}});} });
 await assert.rejects(client.request(api, {json:true}), e => e.code === 'RATE_LIMITED' && e.receipt.retryAfter === '60');
 assert.equal(calls,1);
});
test('a missing Retry-After remains unknown', async () => {
 const client = new NaverShoppingClient({ fetchImpl: async () => new Response(restrictedHtml, {status:429,headers:{'content-type':'text/html'}}) });
 await assert.rejects(client.request(api, {json:true}), e => e.receipt.retryAfter === null);
});

test('verification challenge detection ignores the ncaptcha widget config embedded in normal result pages', () => {
  const resultPage = '<html><head><title>효성팜 청도반시 : 네이버 검색</title></head><body><script>var c={"ncaptcha":{"hostname":"https://ncpt.naver.com","siteKey":{"nmap":"x"}}};</script></body></html>';
  assert.equal(isVerificationChallenge(resultPage), false);
  assert.equal(isVerificationChallenge('<html><title>네이버쇼핑</title><script>{"ncaptcha":{"hostname":"https://ncpt.naver.com","siteKey":{}}}</script></html>'), false);
  assert.equal(isVerificationChallenge('<iframe src="https://ncpt.naver.com/challenge"></iframe>'), true);
  assert.equal(isVerificationChallenge('<html><title>네이버</title><script src="https://ncpt.naver.com/v1/wtm_captcha.js"></script></html>'), true);
});

test('real verification challenge page is CAPTCHA_REQUIRED; normal result page with ncaptcha config is not', async () => {
  const url = new URL('https://search.naver.com/search.naver?where=nexearch&query=%EB%85%B8%ED%8A%B8%EB%B6%81');
  const mk = body => new NaverShoppingClient({ fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } }) });
  await assert.rejects(mk('<html><title>네이버</title><iframe src="https://ncpt.naver.com/challenge"></iframe></html>').request(url), e => e.code === 'CAPTCHA_REQUIRED');
  const ok = await mk('<html><head><title>노트북 : 네이버 검색</title></head><body><script>{"ncaptcha":{"hostname":"https://ncpt.naver.com"}}</script></body></html>').request(url);
  assert.equal(ok.receipt.httpStatus, 200);
});
