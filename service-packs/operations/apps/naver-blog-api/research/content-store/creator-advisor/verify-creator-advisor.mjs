// Protected owner read + real direct-HTTP contract verification; never record credentials or raw bodies.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadClient } from './creator-advisor.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(x => {
  const i = x.indexOf('='); return i < 0 ? [x.slice(2), true] : [x.slice(2, i), x.slice(i + 1)];
}));
const day = args.date || new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('INVALID_DATE');
const channelId = 'aicandoanything';
const receipt = { startedAt: new Date().toISOString(), mode: 'pure_http', channelId, date: day, writes: 0, requests: [], results: [] };
const fetchImpl = async (url, options) => {
  const headers = new Headers(options.headers);
  const entry = { path: new URL(url).pathname, queryKeys: [...new URL(url).searchParams.keys()].sort(),
    signaturePresent: headers.has('x-ca-sig'), status: null };
  receipt.requests.push(entry);
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  entry.status = response.status;
  entry.contentType = response.headers.get('content-type');
  return response;
};
function expect(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function safeError(error) {
  return { code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'CREATOR_ADVISOR_VERIFY_FAILED', httpStatus: error.httpStatus ?? null };
}
try {
  const client = await loadClient({ fetchImpl });
  const channels = await client.get('channels');
  expect(Array.isArray(channels?.data), 'CREATOR_ADVISOR_CHANNEL_SCHEMA');
  receipt.ownerVerified = channels.data.some(row => row?.channelId === channelId && row?.service === 'naver_blog');
  expect(receipt.ownerVerified, 'CREATOR_ADVISOR_OWNER_MISMATCH');
  const inputs = [
    // Pass the legacy ct input too: the maintained client must omit it on the wire.
    ['referrerQueryRank', { channelId, date: day, ct: 'text' }],
    ['yesterdaySummary', { channelId, date: new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) }],
    ['trendDemo', { date: day, age: '05', gender: 'f' }],
  ];
  for (const [name, params] of inputs) {
    try {
      const response = await client.get(name, params);
      expect(response?.data !== undefined, 'CREATOR_ADVISOR_DATA_SCHEMA');
      const request = receipt.requests.at(-1);
      expect(request?.status === 200 && request.signaturePresent, 'CREATOR_ADVISOR_SIGNED_READ_REQUIRED');
      const result = { name, ok: true, status: request.status, topLevelKeys: Object.keys(response),
        dataRows: Array.isArray(response.data) ? response.data.length : null };
      if (name === 'referrerQueryRank') {
        expect(response?.parameters?.channelId === channelId, 'CREATOR_ADVISOR_OWNER_MISMATCH');
        expect(Array.isArray(response.data), 'CREATOR_ADVISOR_RANK_SCHEMA');
        expect(!request.queryKeys.includes('ct'), 'CREATOR_ADVISOR_UNEXPECTED_CT');
        expect(response.data.every(row => row?.date === day && Array.isArray(row?.topN)), 'CREATOR_ADVISOR_RANK_SCHEMA');
        result.keywordRows = response.data.reduce((count, row) => count + row.topN.length, 0);
        result.coverage = result.keywordRows ? 'nonempty' : 'empty';
        result.ownerVerified = true;
        result.returnedDates = response.data.map(row => row.date);
      } else if (name === 'yesterdaySummary') {
        expect(response?.parameters?.channelId === channelId, 'CREATOR_ADVISOR_OWNER_MISMATCH');
        result.returnedDates = Array.isArray(response.data?.date) ? response.data.date.filter(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) : [];
        result.targetDatePresent = result.returnedDates.includes(day);
      }
      receipt.results.push(result);
    } catch (error) {
      receipt.results.push({ name, ok: false, ...safeError(error) });
      if ([401, 429].includes(error.httpStatus)) break;
    }
  }
} catch (error) { receipt.error = safeError(error); }
receipt.passed = receipt.ownerVerified === true && receipt.results.length === 3 && receipt.results.every(r => r.ok) && !receipt.error;
// passed verifies accepted signed contracts and response schemas, not freshness of every dataset.
receipt.summaryTargetDatePresent = receipt.results.find(result => result.name === 'yesterdaySummary')?.targetDatePresent ?? false;
receipt.finishedAt = new Date().toISOString();
if (args.receipt) {
  const destination = resolve(args.receipt);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify(receipt, null, 2));
if (!receipt.passed) process.exitCode = 1;
