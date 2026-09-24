import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource } from '../scripts/analyze-coupang-public-scripts.mjs';

test('public bundle analysis extracts endpoint metadata without values or source body', () => {
  const source = `const q='/api/v1/search?keyword=private'; client.post(q,{secret:'body'}); const x='/api/v1/deeplink/create'; axios.post(x); const r='/#affiliate/report'; const s='affiliate/ws'; function affiliateReport() {}`;
  const result = analyzeSource(source, 'https://partners.coupang.com/static/js/main.test.js');
  assert.deepEqual(result.candidates.map(item => item.path), ['/api/v1/deeplink/create', '/api/v1/search']);
  assert.deepEqual(result.candidates.find(item => item.path === '/api/v1/search').queryFields, ['keyword']);
  assert.ok(result.candidates.every(item => item.executable === false && item.valuesObserved === false));
  assert.deepEqual(result.routeHints, ['/#affiliate/report', '/affiliate/ws']);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /private|secret|body/);
});
