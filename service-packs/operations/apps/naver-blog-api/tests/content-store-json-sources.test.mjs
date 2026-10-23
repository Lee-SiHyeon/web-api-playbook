import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchHfDailyPapers, fetchSignalRealtime } from '../research/content-store/json-sources.mjs';

// Small sanitized extracts from the inspected public responses: retain only adapter inputs.
const hfFixture = JSON.stringify([
  {
    paper: {
      id: '2609.26489',
      title: 'Calibration as a First-Class Criterion in LLM Evaluation',
      publishedAt: '2026-09-22T00:00:00.000Z',
      upvotes: 1,
    },
    publishedAt: '2026-09-22T00:00:00.000Z',
    title: 'Calibration as a First-Class Criterion in LLM Evaluation',
    summary: 'Calibration of language models — the alignment between expressed confidence and empirical correctness — is a well-studied subfield within NLP.',
  },
  {
    paper: {
      id: '2609.27657',
      title: 'FLEET: From Logits Entropy to Enhanced Trajectories in Text Generation',
      publishedAt: '2026-09-23T00:00:00.000Z',
      upvotes: 1,
    },
    publishedAt: '2026-09-23T00:00:00.000Z',
    title: 'FLEET: From Logits Entropy to Enhanced Trajectories in Text Generation',
    summary: 'Solutions based on large language models often rely on temperature sampling to improve accuracy and stability.',
  },
]);

const signalFixture = JSON.stringify({
  now: 1790245794147,
  top10: [
    { rank: 1, keyword: '아시안게임 수송 문제', state: 's' },
    { rank: 2, keyword: '추석 연휴 첫날 귀성객 몰려', state: 'n' },
  ],
});

function stubFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { status, text: async () => body };
  };
  return { fetchImpl, calls };
}

test('fetchHfDailyPapers maps inspected paper rows and includes nulls for missing engagement', async () => {
  const { fetchImpl, calls } = stubFetch(hfFixture);
  const { items, receipt } = await fetchHfDailyPapers(2, { fetchImpl });

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: 'Calibration as a First-Class Criterion in LLM Evaluation',
    url: 'https://huggingface.co/papers/2609.26489',
    publishedAt: '2026-09-22T00:00:00.000Z',
    publisher: 'Hugging Face Daily Papers',
    summary: 'Calibration of language models — the alignment between expressed confidence and empirical correctness — is a well-studied subfield within NLP.',
    engagement: { upvotes: 1, comments: null },
  });
  assert.deepEqual(items[1].engagement, { upvotes: 1, comments: null });
  assert.equal(receipt.httpStatus, 200);
  assert.equal(receipt.sourceUrl, 'https://huggingface.co/api/daily_papers');
  assert.equal(receipt.observedItems, 2);
  assert.equal(receipt.browserUsed, false);
  assert.ok(receipt.fieldsObserved.includes('paper'));
  assert.match(receipt.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 1);
});

test('fetchSignalRealtime marks search signals and records rank, state, and response timestamp', async () => {
  const { fetchImpl, calls } = stubFetch(signalFixture);
  const { items, receipt } = await fetchSignalRealtime(2, { fetchImpl });

  assert.deepEqual(items.map(item => item.title), ['아시안게임 수송 문제', '추석 연휴 첫날 귀성객 몰려']);
  assert.equal(items[0].url, null);
  assert.deepEqual(items[0].signal, {
    kind: 'search_signal', rank: 1, state: 's', responseTimestamp: 1790245794147,
  });
  assert.deepEqual(items[1].signal, {
    kind: 'search_signal', rank: 2, state: 'n', responseTimestamp: 1790245794147,
  });
  assert.equal(receipt.responseTimestamp, 1790245794147);
  assert.deepEqual(receipt.fieldsObserved, ['now', 'top10']);
  assert.equal(receipt.observedItems, 2);
  assert.equal(receipt.browserUsed, false);
  assert.match(receipt.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(calls[0].url, 'https://api.signal.bz/news/realtime');
});

test('missing Hugging Face engagement values remain null, never zero', async () => {
  const missingMetrics = JSON.stringify([{
    paper: { id: '2609.26489', title: 'Calibration as a First-Class Criterion in LLM Evaluation' },
    title: 'Calibration as a First-Class Criterion in LLM Evaluation',
  }]);
  const { items } = await fetchHfDailyPapers(1, { fetchImpl: stubFetch(missingMetrics).fetchImpl });
  assert.deepEqual(items[0].engagement, { upvotes: null, comments: null });
});

test('wrong response shapes throw SCHEMA for both adapters', async () => {
  await assert.rejects(fetchHfDailyPapers(1, { fetchImpl: stubFetch('{"items":[]}').fetchImpl }), { message: 'SCHEMA' });
  await assert.rejects(fetchSignalRealtime(1, { fetchImpl: stubFetch('{"top10":{}}').fetchImpl }), { message: 'SCHEMA' });
});

test('invalid JSON throws NOT_JSON for both adapters', async () => {
  await assert.rejects(fetchHfDailyPapers(1, { fetchImpl: stubFetch('<html>').fetchImpl }), { message: 'NOT_JSON' });
  await assert.rejects(fetchSignalRealtime(1, { fetchImpl: stubFetch('not-json').fetchImpl }), { message: 'NOT_JSON' });
});

test('both adapters respect the requested item limit', async () => {
  const hf = await fetchHfDailyPapers(1, { fetchImpl: stubFetch(hfFixture).fetchImpl });
  const signal = await fetchSignalRealtime(1, { fetchImpl: stubFetch(signalFixture).fetchImpl });
  assert.equal(hf.items.length, 1);
  assert.equal(hf.receipt.observedItems, 2);
  assert.equal(signal.items.length, 1);
  assert.equal(signal.receipt.observedItems, 2);
});

test('non-200 responses use assertStatus behavior', async () => {
  await assert.rejects(fetchSignalRealtime(1, { fetchImpl: stubFetch('{}', 503).fetchImpl }), error => {
    assert.equal(error.code, 'HTTP_STATUS');
    assert.equal(error.details.httpStatus, 503);
    return true;
  });
});

test('bodies larger than 2 MiB are rejected', async () => {
  const largeBody = ' '.repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(fetchSignalRealtime(1, { fetchImpl: stubFetch(largeBody).fetchImpl }), { message: 'SOURCE_TOO_LARGE' });
});
