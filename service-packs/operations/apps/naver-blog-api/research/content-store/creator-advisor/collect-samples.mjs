// Pure HTTP, same owner, bounded diagnostic progression and one sample set.
// Credentials stay in the DPAPI provider/request memory; only safe metadata is journalled.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadClient } from './creator-advisor.mjs';

const directory = new URL('./samples/', import.meta.url);
const receiptUrl = new URL('./live-receipt.json', import.meta.url);
const channelId = 'aicandoanything', date = '2026-10-02';
const variants = ['deduplicate-ca', 'referer', 'content-type', 'fetch-site', 'fetch-mode', 'fetch-dest'];
let variant = variants[0], diagnosticRequests = 0, collecting = false;
let receipt = { startedAt: new Date().toISOString(), mode: 'pure_http', channelId, date,
  previousWorkerRequests: 'unknown, conservatively reserve two diagnostic requests',
  diagnosticLimit: 10, reservedUnknownRequests: 2, requests: [], samples: [], status: 'running' };
try {
  const existing = JSON.parse(await readFile(receiptUrl, 'utf8'));
  if (!process.argv.includes('--resume') || existing.status === 'complete')
    throw Object.assign(new Error('ALREADY_STARTED'), { code: 'ALREADY_STARTED' });
  if (existing.channelId !== channelId || existing.date !== date || existing.requests.some(r => r.status === 'pending'))
    throw Object.assign(new Error('RECONCILIATION_REQUIRED'), { code: 'RECONCILIATION_REQUIRED' });
  receipt = existing;
  receipt.resumedAt = new Date().toISOString();
  receipt.status = 'running';
  diagnosticRequests = receipt.diagnosticRequestCount ?? receipt.requests.filter(r => r.phase === 'diagnostic'
    || new URL(r.url).pathname === '/api/v6/accounts/channels').length;
  variant = receipt.successfulVariant || variants[0];
  collecting = !!receipt.successfulVariant;
}
catch (error) { if (error.code !== 'ENOENT') throw error; }
const checkpoint = () => {
  receipt.diagnosticRequestCount = diagnosticRequests;
  return writeFile(receiptUrl, JSON.stringify(receipt, null, 2) + '\n');
};
await checkpoint();
console.log(JSON.stringify({ event: 'started', mode: 'pure_http', channelId, date }));

const privateField = /^(?:cookie|cookies|set-cookie|authorization|csrf|csrfToken|accessToken|refreshToken|token|signature|sig|password|sessionId|email|phone|userId|memberId|nickname|profileImage|avatar)$/i;
function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateField.test(key)).map(([key, item]) => [key, publicData(item)]));
  if (typeof value === 'string') {
    // A signed URL is never retained, including nested query values in image URLs.
    if (/https?:\/\//i.test(value) && /[?&](?:token|sig|signature|expires|auth|key|credential|x-amz-[^=]*)=/i.test(value)) return '[signed URL omitted]';
  }
  return value;
}
const save = async (name, data, params) => {
  await mkdir(directory, { recursive: true });
  const safe = publicData(data);
  await writeFile(new URL(`${name}.json`, directory), JSON.stringify({ endpoint: name, request: params, data: safe }, null, 2) + '\n');
  receipt.samples.push({ endpoint: name, file: `samples/${name}.json`, topLevelKeys: Object.keys(safe) });
  await checkpoint();
};
try {
  const client = await loadClient({ minIntervalMs: 2100, fetchImpl: async (url, options) => {
    const isBootstrap = new URL(url).pathname === '/api/v6/accounts/channels';
    if ((!collecting || isBootstrap) && ++diagnosticRequests + receipt.reservedUnknownRequests > receipt.diagnosticLimit)
      throw Object.assign(new Error('LIVE_ATTEMPT_LIMIT'), { code: 'LIVE_ATTEMPT_LIMIT' });
    const headers = { ...options.headers };
    const index = variants.indexOf(variant);
    if (index >= 1) headers.referer = 'https://creator-advisor.naver.com/naver_blog/aicandoanything';
    if (index >= 2) headers['content-type'] = 'application/json';
    if (index >= 3) headers['sec-fetch-site'] = 'same-origin';
    if (index >= 4) headers['sec-fetch-mode'] = 'cors';
    if (index >= 5) headers['sec-fetch-dest'] = 'empty';
    const entry = { sequence: receipt.requests.length + 1, phase: collecting ? 'collection' : 'diagnostic',
      variant, startedAt: new Date().toISOString(), method: 'GET', url, status: 'pending',
      headerNames: Object.keys(headers).sort(), cookieNames: headers.cookie.split(';').map(s => s.trim().split('=')[0]),
      signaturePresent: !!headers['X-CA-Sig'] };
    receipt.requests.push(entry);
    await checkpoint();
    const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(20000) });
    entry.status = res.status;
    entry.setCookieNames = res.headers.getSetCookie().map(s => s.slice(0, s.indexOf('=')));
    if (!res.ok && /json/i.test(res.headers.get('content-type') || '')) {
      const body = await res.clone().json().catch(() => ({}));
      entry.errorResponse = publicData(body);
    }
    await checkpoint();
    console.log(JSON.stringify({ event: 'response', sequence: entry.sequence, phase: entry.phase, variant, status: res.status, path: new URL(url).pathname }));
    return res;
  }});
  let summary;
  if (!receipt.samples.some(s => s.endpoint === 'yesterdaySummary')) for (const next of variants) {
    variant = next;
    try { summary = await client.get('yesterdaySummary', { channelId, date }); break; }
    catch (error) {
      if (error.code !== 'CREATOR_ADVISOR_FORBIDDEN') throw error;
      receipt.hypotheses = [...(receipt.hypotheses || []), { variant, result: error.code, status: error.httpStatus }];
      await checkpoint();
    }
  }
  if (!summary && !receipt.samples.some(s => s.endpoint === 'yesterdaySummary'))
    throw Object.assign(new Error('HYPOTHESES_EXHAUSTED'), { code: 'HYPOTHESES_EXHAUSTED' });
  receipt.successfulVariant = variant;
  // The successful diagnostic GET is the first member of the requested one-time set.
  if (summary) await save('yesterdaySummary', summary, { service: 'naver_blog', channelId, date });
  collecting = true;
  const inputs = [
    ['popularDemoKeyword', { channelId, date }],
    ['popularCategoryKeyword', { channelId, date }],
    ['soaringContents', { channelId, date, interval: 'day' }],
    ['referrerQueryRank', { channelId, date, interval: 'day', metric: 'cv', ct: 'text', limit: 20 }],
    ['trendDemo', { service: 'naver_blog', date, interval: 'day', age: '05', gender: 'f', metric: 'cv' }],
    ['trendCategory', { service: 'naver_blog', date, interval: 'day', contentType: 'text', categories: 'IT·컴퓨터' }],
  ];
  // The category is observed in the browser's preferred-category response, not guessed.
  for (const [name, params] of inputs) {
    if (receipt.samples.some(s => s.endpoint === name)) continue;
    const endpointPath = new URL('./creator-advisor.mjs', import.meta.url);
    const { ENDPOINTS } = await import(endpointPath);
    const path = '/api/v6' + ENDPOINTS[name](params)[0];
    const prior = receipt.requests.find(r => new URL(r.url).pathname === path && r.phase === 'collection');
    if (prior) {
      // A known failed request is saved as failure, never silently re-sent.
      await save(name, { ok: false, httpStatus: prior.status,
        error: prior.errorResponse || { code: 'CREATOR_ADVISOR_HTTP_ERROR' } }, params);
      continue;
    }
    try { await save(name, await client.get(name, params), params); }
    catch (error) {
      const last = receipt.requests.at(-1);
      if (last?.status === 'pending') throw error;
      await save(name, { ok: false, httpStatus: error.httpStatus ?? null,
        error: last?.errorResponse || { code: error.code || 'COLLECTION_FAILED' } }, params);
    }
  }
  receipt.failedEndpoints = receipt.samples.filter(s => receipt.requests.some(r => r.phase === 'collection'
    && r.status !== 200 && new URL(r.url).pathname === '/api/v6' + ({ popularDemoKeyword: '/home/popular-demo-keyword',
      popularCategoryKeyword: '/home/popular-category-keyword', soaringContents: '/home/soaring-contents',
      referrerQueryRank: '/inflow-analysis/referrer-query-rank', trendDemo: '/trend/demo', trendCategory: '/trend/category' }[s.endpoint]))).map(s => s.endpoint);
  receipt.status = receipt.failedEndpoints.length ? 'partial' : 'complete';
  receipt.finishedAt = new Date().toISOString();
  await checkpoint();
  console.log(JSON.stringify({ ok: !receipt.failedEndpoints.length, status: receipt.status, failedEndpoints: receipt.failedEndpoints, successfulVariant: variant, diagnosticRequests,
    collectionRequests: receipt.requests.filter(r => r.phase === 'collection').length, samples: receipt.samples.map(s => s.file) }));
} catch (error) {
  receipt.status = 'incomplete';
  receipt.error = { code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'COLLECTION_FAILED', httpStatus: error.httpStatus ?? null };
  await checkpoint();
  console.log(JSON.stringify({ ok: false, ...receipt.error, diagnosticRequests, samples: receipt.samples.map(s => s.file) }));
  process.exitCode = 1;
}
