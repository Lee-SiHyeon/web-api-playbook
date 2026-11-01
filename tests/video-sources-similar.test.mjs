import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVerdicts, dHashFromGray9x8, findSimilarProducts, hammingHex, interleaveBySource, keywordList, scoreCandidate, titleSimilarity } from '../lib/video-sources/similar.mjs';
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

import { parseCoupangProductSeed } from '../lib/video-sources/coupang-seed.mjs';
test('Coupang product seed: og:title without site suffix, protocol-relative og:image on the CDN', () => {
  const html = `<html><head><meta property="og:title" content="토이게이트 88건반 플로리다 접이식 전자 피아노 - 디지털피아노 | 쿠팡">`
    + `<meta property="og:image" content="//thumbnail.coupangcdn.com/thumbnails/remote/640x640ex/image/retail/images/6771.jpg"></head>${'x'.repeat(2000)}</html>`;
  const s = parseCoupangProductSeed(html, 'https://www.coupang.com/vp/products/8733070301');
  assert.equal(s.title, '토이게이트 88건반 플로리다 접이식 전자 피아노');
  assert.equal(s.image, 'https://thumbnail.coupangcdn.com/thumbnails/remote/640x640ex/image/retail/images/6771.jpg');
  assert.equal(s.productId, '8733070301');
  const evil = parseCoupangProductSeed(html.replace('//thumbnail.coupangcdn.com', 'https://evil.example'), 'https://www.coupang.com/vp/products/1');
  assert.equal(evil.image, null);
});

test('coverage: every keyword variant and page is searched, judging is batched across sources, unjudged count is reported', async () => {
  assert.deepEqual(keywordList({ zh: '吸黑头仪', zhAlt: ['电动吸黑头仪 白色', '吸黑头仪', ' '] }, 'zh'), ['吸黑头仪', '电动吸黑头仪 白色']);
  assert.deepEqual(interleaveBySource([{ source: 'a', score: 0.9 }, { source: 'a', score: 0.8 }, { source: 'b', score: 0.1 }]).map(c => c.source), ['a', 'b', 'a']);
  const calls = [];
  const mk = (prefix, n) => Array.from({ length: n }, (_, i) => ({ offerId: `${prefix}${String(i).padStart(9, '0')}`, title: `t${i}`, imageUrl: 'y' }));
  const clients = {
    1688: { search: async ({ keyword, page = 1 }) => { calls.push(['1688', keyword, page]); return { items: mk(`${keyword.length}${page}`, 60) }; } },
    amazon: { search: async ({ keyword }) => { calls.push(['amazon', keyword]); return { items: [{ asin: 'B000000001', title: 'x', imageUrl: 'z' }] }; } },
  };
  const batches = [];
  // the "same" listing is the 1688 page-2 result of the specific keyword: invisible to a single generic top-30 search
  const target = `${'电动吸黑头仪 白色'.length}2000000005`;
  const judge = async ({ candidates }) => { batches.push(candidates.length); return { verdicts: candidates.map(c => ({ id: c.id, source: c.source, verdict: c.id === target ? 'same' : 'different' })) }; };
  const r = await findSimilarProducts({ seed: { title: 's', image: null }, keywords: { zh: '吸黑头仪', zhAlt: ['电动吸黑头仪 白色'], en: 'blackhead vacuum' },
    clients, perSource: 300, pages: { 1688: 2 }, judge, judgeTop: 300, judgeBatch: 10, hash: async () => null });
  assert.deepEqual(calls.filter(c => c[0] === '1688').map(c => c.slice(1)), [['吸黑头仪', 1], ['吸黑头仪', 2], ['电动吸黑头仪 白色', 1], ['电动吸黑头仪 白色', 2]]);
  assert.equal(r.candidates.find(c => c.id === target)?.verdict, 'same');
  assert.ok(batches.every(n => n <= 10));
  assert.equal(r.coverage['1688'].used, 240); assert.equal(r.coverage['1688'].unjudged, 0); assert.equal(r.coverage['1688'].same, 1);
  // a capped judge leaves candidates unjudged, and the funnel says so
  const capped = await findSimilarProducts({ seed: { title: 's' }, keywords: { zh: '吸黑头仪' }, clients, perSource: 60, judge, judgeTop: 20, hash: async () => null });
  assert.equal(capped.coverage['1688'].judged, 20); assert.equal(capped.coverage['1688'].unjudged, 40);
});

test('productKeywords keeps valid alternates and drops bad ones without failing', async () => {
  const k = await productKeywords({ title: '진공 피지 흡입기', runPrompt: async () => '{"ko":"피지 흡입기","zh":"吸黑头仪","en":"blackhead vacuum","zhAlt":["电动吸黑头仪 白色",7,""],"enAlt":"x"}' });
  assert.deepEqual(k.zhAlt, ['电动吸黑头仪 白色']); assert.deepEqual(k.enAlt, []); assert.deepEqual(k.koAlt, []);
});

test('the per-source cap is shared rank by rank across queries, so the first query cannot take every slot', async () => {
  const mk = (p) => Array.from({ length: 60 }, (_, i) => ({ offerId: `${p}${String(i).padStart(9, '0')}`, title: 't', imageUrl: 'y' }));
  const clients = { 1688: { search: async ({ keyword, page = 1 }) => ({ items: mk(`${keyword === 'a' ? 1 : 2}${page}`) }) } };
  const r = await findSimilarProducts({ seed: { title: 's' }, keywords: { zh: 'a', zhAlt: ['b'] }, clients, perSource: 60, pages: { 1688: 2 }, hash: async () => null });
  assert.deepEqual(r.sources['1688'].queries.map(q => q.added), [15, 15, 15, 15]);
});
