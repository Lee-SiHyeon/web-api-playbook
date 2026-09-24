import { createHash } from 'node:crypto';

// Exact assets observed on the official guide and its build manifest, 2026-09-21.
// Fetches public static files only. Never evaluates downloaded JavaScript.
const base = 'https://cf-static.oliveyoung.co.kr/prd/1.184.0/_next/static/chunks/';
const sources = [
  { file: 'pages/_app-a6cde09e9e1d35ae.js', checks: ['Authorization', 'additionalInfo.do', 'linkageString', 'X-OY-GW', 'goods/getGoodsDetail.do'] },
  { file: 'pages/affiliate/product/search-69ae4f32d74c2ad5.js', checks: ['/education/status', '/activities/ranking', '/activities/generated', '/activities/search', '/activities/landing', 'affiliateActivityId', 'affiliatePartnerId', 'categoryNumber'] },
  { file: '2243-efefd637544aeda7.js', checks: ['/base/shorten/v2/verified', '/base/shorten/detail/', 'originalUrl', 'registerId', 'shortenedUrl', 'x-api-key', 'Asia/Seoul'] },
];
const results = await Promise.all(sources.map(async source => {
  try {
    const response = await fetch(base + source.file, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { url: base + source.file, ok: false, status: response.status };
    const text = await response.text();
    const checks = Object.fromEntries(source.checks.map(term => [term, text.includes(term)]));
    return { url: base + source.file, status: response.status, sha256: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text), checks, ok: Object.values(checks).every(Boolean) };
  } catch { return { url: base + source.file, ok: false, error: 'PUBLIC_SOURCE_UNAVAILABLE' }; }
}));
const report = { checkedAt: new Date().toISOString(), evidenceClass: 'public_source_only',
  authenticatedReplay: false, sources: results };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (results.some(result => !result.ok)) process.exitCode = 2;
