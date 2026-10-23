#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sanitizeCapture } from './capture-safety.mjs';
import { canonicalRow } from './brand-trend-rows.mjs';
import { reserveCollectionRun } from './brand-trends-client.mjs';

export const ENDPOINT = 'https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList';
export const SUPPORTED_COUNTRIES = new Set(['KR', 'US', 'JP']);
export const SUPPORTED_PERIODS = new Set([7, 30, 90]);

export function normalizeHashtagResponse(payload, context = {}) {
  payload = sanitizeCapture(payload);
  const status = payload?.BaseResp?.StatusCode;
  if (status !== 0 || !Array.isArray(payload?.items)) {
    throw Object.assign(new Error('TIKTOK_RESPONSE_INVALID'), { code: 'TIKTOK_RESPONSE_INVALID' });
  }
  const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const result = {
    schema_version: '1.0.0',
    source_id: 'tiktok_creative_center_hashtag',
    market: context.country ?? 'unknown',
    period_days: context.period ?? null,
    observed_at: context.observedAt ?? new Date().toISOString(),
    verdict: 'working_public',
    platform: 'TikTok',
    account_scope: null,
    access: 'public',
    endpoint: ENDPOINT,
    http_status: context.httpStatus ?? null,
    capture_ref: context.captureRef ?? null,
    trends: payload.items.map((item) => ({
      trend_id: item.hashtagID == null ? null : String(item.hashtagID),
      label: item.hashtagName ?? null,
      rank: Number(item.rankIndex ?? 0) || null,
      rank_change: item.rankDiff == null ? null : Number(item.rankDiff),
      post_count: numberOrNull(item.publishCnt),
      views: numberOrNull(item.vv),
      industry_ids: Array.isArray(item.industryIDs) ? item.industryIDs.map(String) : [],
      curve: Array.isArray(item.popularityCurve)
        ? item.popularityCurve.map(({ timestamp, value }) => ({ timestamp: Number(timestamp) * 1000, value: Number(value) }))
        : [],
      creators: Array.isArray(item.topCreators)
        ? item.topCreators.map((creator) => ({ id: creator.ttUID == null ? null : String(creator.ttUID), handle: creator.handleName ?? null, followers: numberOrNull(creator.followedCnt) }))
        : [],
    })),
    pagination: payload.pagination ? {
      hasMore: typeof payload.pagination.hasMore === 'boolean' ? payload.pagination.hasMore : null,
      page: numberOrNull(payload.pagination.page), limit: numberOrNull(payload.pagination.limit),
      totalCount: numberOrNull(payload.pagination.totalCount),
    } : null,
  };
  result.rows = result.trends.filter(item => typeof item.label === 'string' && item.label.trim()).map(item => canonicalRow({
    ...item, source_id: result.source_id, platform: result.platform, market: result.market,
    observed_at: result.observed_at, period_days: result.period_days, account_scope: null,
    access: 'public', endpoint: ENDPOINT, verdict: result.verdict, http_status: result.http_status,
    capture_ref: result.capture_ref, creator_ids: item.creators.map(creator => creator.id).filter(Boolean),
    surface: 'Creative Center hashtags', personalized: false, location: result.market,
    traffic: 'medium', limitations: ['Public preview; separate from brand-session creator trends.'],
  }));
  return result;
}

export async function collectHashtags({ country = 'KR', period = 7, industryId, fetchImpl = fetch, observedAt,
  reserveRun = reserveCollectionRun, cadenceOptions } = {}) {
  country = country.toUpperCase();
  period = Number(period);
  if (!SUPPORTED_COUNTRIES.has(country)) throw new Error('Unsupported research country');
  if (!SUPPORTED_PERIODS.has(period)) throw new Error('Unsupported current period; current bundle supports 7, 30, 90');
  const reservation = await reserveRun('tiktok_public', cadenceOptions);
  if (!reservation.allowed) throw Object.assign(new Error('TIKTOK_COLLECTION_CADENCE_WAIT'), { code: 'TIKTOK_COLLECTION_CADENCE_WAIT' });
  const body = { timeRange: period, countryCode: country, page: 1, limit: 20 };
  if (industryId) body.industryID = String(industryId);
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (/captcha|challenge|verify you are human/i.test(text)) throw new Error('challenge_blocked');
  if (!response.ok) throw new Error(`TikTok HTTP ${response.status}`);
  if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('TIKTOK_RESPONSE_MIME');
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('TIKTOK_RESPONSE_INVALID'); }
  return normalizeHashtagResponse(payload, { country, period, observedAt, httpStatus: response.status });
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) result[key.slice(2)] = argv[i + 1], i += 1;
  }
  return result;
}

async function main() {
  const options = args(process.argv.slice(2));
  const country = (options.country ?? 'KR').toUpperCase();
  const period = Number(options.period ?? 7);
  const output = options.out ? resolve(options.out) : null;
  if (output) {
    const allowedRoot = dirname(fileURLToPath(import.meta.url)).toLowerCase() + sep;
    if (!output.toLowerCase().startsWith(allowedRoot)) throw new Error('OUTPUT_SCOPE_INVALID');
  }
  let result;
  if (options.offline) {
    const payload = JSON.parse(await readFile(resolve(options.offline), 'utf8'));
    result = normalizeHashtagResponse(payload, { country, period, observedAt: options['observed-at'] });
  } else {
    result = await collectHashtags({ country, period, industryId: options.industry });
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized);
  } else process.stdout.write(serialized);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
