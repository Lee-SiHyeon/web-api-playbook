import { createHash } from 'node:crypto';
import { assertStatus, fetchText } from '../trend-radar/lib/http.mjs';

const HF_DAILY_PAPERS_URL = 'https://huggingface.co/api/daily_papers';
const SIGNAL_REALTIME_URL = 'https://api.signal.bz/news/realtime';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPrimitive = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const isOptionalText = (record, key) => record[key] === undefined || record[key] === null || typeof record[key] === 'string';
const isOptionalCount = (record, key) => record[key] === undefined || record[key] === null
  || (typeof record[key] === 'number' && Number.isFinite(record[key]));
const schemaError = () => { throw new Error('SCHEMA'); };
const hash = text => createHash('sha256').update(text).digest('hex');

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('SOURCE_LIMIT');
}

async function getJson(sourceUrl, fetchImpl) {
  const { response, text } = await fetchText(sourceUrl, {
    fetchImpl,
    attempts: 1,
    timeoutMs: 12000,
    headers: { accept: 'application/json' },
  });
  assertStatus(response);
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('SOURCE_TOO_LARGE');

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('NOT_JSON'); }

  return { data, response, text };
}

function validateHfRows(data) {
  if (!Array.isArray(data)) schemaError();
  for (const row of data) {
    if (!isRecord(row) || !isRecord(row.paper)) schemaError();
    const paper = row.paper;
    if (typeof paper.id !== 'string' || !paper.id.trim()) schemaError();
    if (!(typeof row.title === 'string' || typeof paper.title === 'string')) schemaError();
    for (const [record, key] of [
      [row, 'title'], [row, 'summary'], [row, 'publishedAt'],
      [paper, 'title'], [paper, 'summary'], [paper, 'publishedAt'], [paper, 'submittedOnDailyAt'],
    ]) if (!isOptionalText(record, key)) schemaError();
    if (!isOptionalCount(paper, 'upvotes') || !isOptionalCount(row, 'numComments')) schemaError();
  }
}

function validateSignalData(data) {
  if (!isRecord(data) || !Array.isArray(data.top10)) schemaError();
  if (data.now !== undefined && !(typeof data.now === 'number' && Number.isFinite(data.now))) schemaError();
  for (const item of data.top10) {
    if (!isRecord(item) || !Number.isInteger(item.rank) || item.rank < 1
      || typeof item.keyword !== 'string' || !item.keyword.trim()) schemaError();
    for (const [key, value] of Object.entries(item)) {
      if (/state|change/i.test(key) && !isPrimitive(value)) schemaError();
    }
  }
}

function receiptFor({ response, sourceUrl, text, observedItems, fieldsObserved, responseTimestamp }) {
  return {
    httpStatus: response.status,
    sourceUrl,
    responseSha256: hash(text),
    observedItems,
    browserUsed: false,
    fieldsObserved,
    ...(responseTimestamp === undefined ? {} : { responseTimestamp }),
  };
}

export async function fetchHfDailyPapers(limit, { fetchImpl = globalThis.fetch } = {}) {
  validateLimit(limit);
  const result = await getJson(HF_DAILY_PAPERS_URL, fetchImpl);
  validateHfRows(result.data);

  const items = result.data.map(row => {
    const paper = row.paper;
    const title = row.title ?? paper.title;
    const summary = row.summary ?? paper.summary ?? '';
    return {
      title,
      url: `https://huggingface.co/papers/${encodeURIComponent(paper.id)}`,
      publishedAt: paper.publishedAt ?? paper.submittedOnDailyAt ?? row.publishedAt ?? null,
      publisher: 'Hugging Face Daily Papers',
      summary: summary.slice(0, 1500),
      engagement: {
        upvotes: paper.upvotes ?? null,
        comments: row.numComments ?? null,
      },
    };
  });
  const fieldsObserved = [...new Set(result.data.flatMap(row => Object.keys(row)))];

  return {
    items: items.slice(0, limit),
    receipt: receiptFor({
      ...result,
      sourceUrl: HF_DAILY_PAPERS_URL,
      observedItems: items.length,
      fieldsObserved,
    }),
  };
}

export async function fetchSignalRealtime(limit, { fetchImpl = globalThis.fetch } = {}) {
  validateLimit(limit);
  const result = await getJson(SIGNAL_REALTIME_URL, fetchImpl);
  validateSignalData(result.data);

  const items = result.data.top10.map(entry => {
    const signal = { kind: 'search_signal', rank: entry.rank };
    for (const [key, value] of Object.entries(entry)) {
      if (/state|change/i.test(key)) signal[key] = value;
    }
    if (result.data.now !== undefined) signal.responseTimestamp = result.data.now;
    return {
      title: entry.keyword,
      url: null,
      publishedAt: null,
      publisher: 'Signal.bz Real-time Search',
      summary: '',
      signal,
    };
  });
  return {
    items: items.slice(0, limit),
    receipt: receiptFor({
      ...result,
      sourceUrl: SIGNAL_REALTIME_URL,
      observedItems: items.length,
      fieldsObserved: Object.keys(result.data),
      responseTimestamp: result.data.now,
    }),
  };
}
