import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVerdicts, dHashFromGray9x8, findSimilarProducts, hammingHex, scoreCandidate, titleSimilarity } from '../lib/video-sources/similar.mjs';
import { parseAliExpressSearchItems } from '../lib/video-sources/aliexpress-search.mjs';
import { extractJson, productKeywords } from '../lib/video-sources/llm.mjs';

test('dHash and hamming distance', () => {
  const flat = Buffer.alloc(72, 10);
  assert.equal(dHashFromGray9x8(flat), '0000000000000000');
  const ramp = Buffer.from(Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 20));
  assert.equal(dHashFromGray9x8(ramp), 'ffffffffffffffff');
  assert.equal(hammingHex('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hammingHex('00000000000000ff', '0000000000000000'), 8);
  assert.equal(hammingHex('xyz', '0000000000000000'), null);
});

test('title similarity is language-local and scoring falls back to image only across languages', () => {
  assert.ok(titleSimilarity('접이식 디지털 피아노 88키', '88키 접이식 디지털 피아노 블루투스') > 0.4);
  assert.ok(titleSimilarity('접이식 피아노', '스테인리스 냄비') < 0.1);
  const s = scoreCandidate({ seedHash: '0000000000000000', seedTitle: '접이식 피아노', seedLang: 'ko' },
    { imageHash: '00000000000000ff', title: '折叠电钢琴', lang: 'zh' });
  assert.equal(s.titleSimilarity, null);
  assert.equal(s.score, 0.875);
});

test('verdicts order candidates same > type > unjudged > different', () => {
  const cands = [{ source: 'a', id: '1', score: 0.9 }, { source: 'b', id: '2', score: 0.5 }, { source: 'c', id: '3', score: 0.7 }, { source: 'd', id: '4', score: 0.95 }];
  applyVerdicts(cands, [{ source: 'a', id: '1', verdict: 'different' }, { source: 'b', id: '2', verdict: 'same' }, { source: 'c', id: '3', verdict: 'type' }]);
  assert.deepEqual(cands.map(c => c.id), ['2', '3', '4', '1']);
});

test('findSimilarProducts searches each source with its language keyword and survives a failing source', async () => {
  const calls = [];
  const clients = {
    aliexpress: { search: async ({ keyword }) => { calls.push(['aliexpress', keyword]); return { items: [{ productId: '1005', title: '접이식 피아노 88키', imageUrl: 'x', price: 1, currency: 'KRW' }] }; } },
    1688: { search: async ({ keyword }) => { calls.push(['1688', keyword]); throw Object.assign(new Error('x'), { code: 'ALIBABA1688_CHALLENGE_REQUIRED' }); } },
    amazon: { search: async ({ keyword }) => { calls.push(['amazon', keyword]); return { items: [{ asin: 'B0DS23X39K', title: 'Folding piano', imageUrl: 'y' }] }; } },
  };
  const hash = async src => (src === 'seed' ? '0000000000000000' : src === 'x' ? '0000000000000001' : 'ffffffffffffffff');
  const judge = async ({ candidates }) => ({ verdicts: candidates.map((c, i) => ({ i, id: c.id, source: c.source, verdict: c.source === 'amazon' ? 'same' : 'type' })) });
  const r = await findSimilarProducts({ seed: { title: '접이식 피아노', image: 'seed' }, keywords: { ko: '접이식 피아노', zh: '折叠钢琴', en: 'folding piano' }, clients, hash, judge });
  assert.deepEqual(calls, [['aliexpress', '접이식 피아노'], ['1688', '折叠钢琴'], ['amazon', 'folding piano']]);
  assert.equal(r.sources['1688'].error, 'ALIBABA1688_CHALLENGE_REQUIRED');
  assert.deepEqual(r.candidates.map(c => [c.source, c.verdict]), [['amazon', 'same'], ['aliexpress', 'type']]);
});

test('AliExpress KR search cards: Korean title, KRW price, sold text, rating', () => {
  const card = id => `{"productId":"${id}","image":{"imgUrl":"//ae-pic-a1.aliexpress-media.com/kf/S1.jpg"},"title":{"displayTitle":"접이식 \\"피아노\\" 61키"},"prices":{"salePrice":{"discount":7,"priceType":"sale_price","currencyCode":"KRW","minPrice":38522,"formattedPrice":"₩ 38,522"}},"trade":{"tradeDesc":"124 판매"},"evaluation":{"starRating":4.6}}`;
  const html = `<html>${'x'.repeat(2000)}<script>window._dida_config_={"_init_data_":{"itemList":{"content":[${card('1005012672861109')},${card('1005012672861109')},${card('1005013172785776')}]}}}</script>`;
  const items = parseAliExpressSearchItems(html);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { productId: '1005012672861109', title: '접이식 "피아노" 61키', imageUrl: 'https://ae-pic-a1.aliexpress-media.com/kf/S1.jpg',
    price: 38522, currency: 'KRW', sold: '124 판매', rating: 4.6, productUrl: 'https://ko.aliexpress.com/item/1005012672861109.html' });
});

test('LLM keyword helper parses fenced JSON and rejects bad output', async () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  const kw = await productKeywords({ title: 'IRIN PJ88C 접이식 피아노', runPrompt: async () => 'ok {"ko":"접이식 피아노","zh":"折叠钢琴","en":"folding piano"}' });
  assert.equal(kw.zh, '折叠钢琴');
  await assert.rejects(productKeywords({ title: 't', runPrompt: async () => '{"ko":"a"}' }), { code: 'LLM_OUTPUT_INVALID' });
});

import { modelCodes } from '../lib/video-sources/similar.mjs';
test('model codes are language independent and drop spec tokens', () => {
  assert.deepEqual(modelCodes('IRIN PJ88C 접이식 디지털 피아노 88키 USB MIDI 128음색'), ['PJ88C']);
  assert.deepEqual(modelCodes('科汇兴PJ88C折叠电钢琴88键便携式'), ['PJ88C']);
  assert.deepEqual(modelCodes('跨境多功能手提式88键电子钢琴88037儿童'), ['88037']);
  assert.deepEqual(modelCodes('Folding piano 61 keys 1000mAh'), []);
  const s = scoreCandidate({ seedHash: null, seedTitle: 'IRIN PJ88C 피아노', seedLang: 'ko' }, { title: '科汇兴PJ88C折叠电钢琴', lang: 'zh' });
  assert.deepEqual(s.modelMatch, ['PJ88C']);
  assert.equal(s.score, 0.4);
});
