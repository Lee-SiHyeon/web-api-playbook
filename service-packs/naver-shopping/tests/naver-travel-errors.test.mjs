import test from 'node:test';
import assert from 'node:assert/strict';
import { NaverTravelClient } from '../adapters/naver-travel.mjs';

const mk = (body, type = 'text/html; charset=UTF-8') => new NaverTravelClient({ fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': type } }) });

// The JSON MIME check runs before body inspection, so challenge bodies are served with a JSON content-type here.
test('travel: real verification challenge page is CAPTCHA_REQUIRED', async () => {
  await assert.rejects(mk('<html><title>네이버</title><iframe src="https://ncpt.naver.com/challenge"></iframe></html>', 'application/json').flightCards(), e => e.code === 'CAPTCHA_REQUIRED');
  await assert.rejects(mk('<html><script src="https://ncpt.naver.com/v1/wtm_captcha.js"></script></html>', 'application/json').flightCards(), e => e.code === 'CAPTCHA_REQUIRED');
});

test('travel: embedded ncaptcha widget config is not reported as CAPTCHA_REQUIRED', async () => {
  const body = JSON.stringify({ data: { flightsCards: [] }, config: { ncaptcha: { hostname: 'https://ncpt.naver.com', siteKey: {} } } });
  const result = await mk(body, 'application/json').flightCards().catch(e => e);
  assert.notEqual(result?.code, 'CAPTCHA_REQUIRED');
});
