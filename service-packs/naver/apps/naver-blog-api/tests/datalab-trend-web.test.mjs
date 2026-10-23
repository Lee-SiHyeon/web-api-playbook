import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSearchTrend, parseTrendResult, serializeGroups, summarizeSeries } from '../research/trend-radar/sources/naver-datalab-trend-web.mjs';

const series = [{ title: '챗GPT', data: Array.from({ length: 14 }, (_, i) => ({ period: `202609${String(i + 1).padStart(2, '0')}`, value: i < 7 ? 40 : 60 })) }];
const resultHtml = `<div class="inner_graph_area"><div id="graph_data" style="display:none" data-timedimension="date">${JSON.stringify(series)}</div></div>`;

function fakeFetch({ ack = { success: true, hashKey: 'N_d1ce993e164b48abfc20ce6d316083a9' }, html = resultHtml } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', headers: options.headers, body: options.body });
    const u = String(url);
    if (u.startsWith('https://lcs.naver.com')) return new Response('', { status: 200, headers: [['set-cookie', 'NNB=abc; Path=/'], ['set-cookie', 'BUC=def; Path=/']] });
    if (u.endsWith('/keyword/trendSearch.naver')) return new Response('<html></html>', { status: 200 });
    if (u.endsWith('/qcHash.naver')) return new Response(JSON.stringify(ack), { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } });
    if (u.includes('/keyword/trendResult.naver')) return new Response(html, { status: 200 });
    return new Response('', { status: 404 });
  };
  return { impl, calls };
}

test('groups serialize exactly as the page script does', () => {
  assert.equal(serializeGroups([{ name: '챗GPT' }, { name: '제미나이', keywords: ['제미나이', 'Gemini'] }]), '챗GPT__SZLIG__챗GPT__OUML__제미나이__SZLIG__제미나이,Gemini');
  assert.throws(() => serializeGroups([]), /1-5/);
  assert.throws(() => serializeGroups([{ name: 'a__b' }]), /without/);
});

test('two-step flow posts YYYYMMDD dates with anonymous cookies and parses graph_data', async () => {
  const { impl, calls } = fakeFetch();
  const r = await fetchSearchTrend({ groups: [{ name: '챗GPT' }], startDate: '2026-09-01', endDate: '2026-09-14' }, { fetchImpl: impl });
  const post = calls.find(c => c.url.endsWith('/qcHash.naver'));
  const body = new URLSearchParams(post.body);
  assert.equal(body.get('startDate'), '20260901'); assert.equal(body.get('endDate'), '20260914'); assert.equal(body.get('qcType'), 'N');
  assert.match(post.headers.cookie, /NNB=abc/); assert.equal(post.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(r.series[0].data[0].period, '2026-09-01');
  assert.deepEqual(r.receipt.bootstrapCookieNames, ['NNB', 'BUC']);
  assert.equal(r.receipt.valueScale, 'relative_0_100_within_query');
  assert.equal(r.summary[0].change, 0.5, 'recent 7-day mean 60 vs previous 40');
});

test('rejected query and changed page shape fail closed', async () => {
  await assert.rejects(fetchSearchTrend({ groups: [{ name: 'x' }], startDate: '20260901', endDate: '20260914' },
    { fetchImpl: fakeFetch({ ack: { success: false, code: 'INVALID_PARAMS' } }).impl }), /rejected/);
  await assert.rejects(fetchSearchTrend({ groups: [{ name: 'x' }], startDate: '20260901', endDate: '20260914' },
    { fetchImpl: fakeFetch({ html: '<div>no data</div>' }).impl }), /graph_data element not found/);
  assert.throws(() => parseTrendResult('<div id="graph_data" data-timedimension="date">[{"title":"x","data":[{"period":"bad","value":1}]}]</div>'), /Unexpected/);
  await assert.rejects(fetchSearchTrend({ groups: [{ name: 'x' }], startDate: '2026.09.01', endDate: '20260914' }, { fetchImpl: fakeFetch().impl }), /Dates/);
});

test('summary handles short series without inventing a change', () => {
  const [s] = summarizeSeries([{ title: 'x', data: [{ period: '2026-09-01', value: 10 }] }]);
  assert.equal(s.previousMean, null); assert.equal(s.change, null);
});
