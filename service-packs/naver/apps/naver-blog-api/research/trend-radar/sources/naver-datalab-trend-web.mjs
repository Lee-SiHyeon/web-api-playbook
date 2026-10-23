// Naver DataLab 검색어트렌드 without the OpenAPI key: replays the web page's own two-step flow.
// Observed 2026-09-24 (static bundle trendsearch.202504080910.js + anonymous live replay):
//   POST https://datalab.naver.com/qcHash.naver  (form: qcType, queryGroups, startDate, endDate, timeUnit, gender, age, device)
//     -> {"success":true,"hashKey":"N_..."}   dates must be YYYYMMDD; dotted dates give INVALID_PARAMS
//   GET  https://datalab.naver.com/keyword/trendResult.naver?hashKey=...
//     -> HTML with <div id="graph_data" data-timedimension="...">[{"title","data":[{"period","value"}]}]</div>
// Values are relative (0–100 within one query), not search counts. Anonymous NNB/BUC cookies come from
// the same lcs bootstrap the Shopping Insight client uses.
import { createHash } from 'node:crypto';
import { TrendSourceError, assertStatus, fetchText } from '../lib/http.mjs';

const ORIGIN = 'https://datalab.naver.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const GROUP_SEP = '__OUML__';
const NAME_SEP = '__SZLIG__';
const sha = text => createHash('sha256').update(text).digest('hex');

function cookieJar() {
  const jar = new Map();
  return {
    keep(response) {
      const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const line of raw) {
        const pair = line.split(';')[0];
        const at = pair.indexOf('=');
        if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    names: () => [...jar.keys()],
  };
}

export function serializeGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 5) throw new TrendSourceError('INPUT', 'DataLab accepts 1-5 topic groups');
  return groups.map(group => {
    const name = String(group?.name ?? '').trim();
    const keywords = [...new Set((group?.keywords ?? [name]).map(k => String(k).trim()).filter(Boolean))];
    if (!name || !keywords.length || keywords.length > 20 || [name, ...keywords].some(v => v.includes('__') || v.includes(','))) {
      throw new TrendSourceError('INPUT', 'Each group needs a name and 1-20 keywords without "__" or ","');
    }
    return `${name}${NAME_SEP}${keywords.join(',')}`;
  }).join(GROUP_SEP);
}

const ymd = value => {
  const s = String(value ?? '').replace(/-/g, '');
  if (!/^\d{8}$/.test(s)) throw new TrendSourceError('INPUT', 'Dates must be YYYY-MM-DD or YYYYMMDD');
  return s;
};

export function parseTrendResult(html) {
  const match = /<div id="graph_data"[^>]*data-timedimension="([a-z]+)"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (!match) throw new TrendSourceError('SCHEMA', 'graph_data element not found');
  let series;
  try { series = JSON.parse(match[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()); }
  catch { throw new TrendSourceError('SCHEMA', 'graph_data is not JSON'); }
  if (!Array.isArray(series) || series.some(g => typeof g?.title !== 'string' || !Array.isArray(g.data)
    || g.data.some(p => !/^\d{8}$/.test(String(p?.period)) || typeof p.value !== 'number'))) {
    throw new TrendSourceError('SCHEMA', 'Unexpected graph_data shape');
  }
  return {
    timeUnit: match[1],
    series: series.map(g => ({ title: g.title, data: g.data.map(p => ({ period: `${p.period.slice(0, 4)}-${p.period.slice(4, 6)}-${p.period.slice(6)}`, value: p.value })) })),
  };
}

// Recent-vs-previous window mean per group, for the ledger's demand signal.
export function summarizeSeries(series, window = 7) {
  return series.map(({ title, data }) => {
    const values = data.map(p => p.value);
    const recent = values.slice(-window);
    const previous = values.slice(-2 * window, -window);
    const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const r = mean(recent); const p = mean(previous);
    return { title, recentMean: r, previousMean: p, change: r !== null && p ? (r - p) / p : null, peak: Math.max(...values), points: values.length };
  });
}

export async function fetchSearchTrend({ groups, startDate, endDate, timeUnit = 'date', gender = '', age = '', device = '' },
  { fetchImpl = globalThis.fetch } = {}) {
  if (!['date', 'week', 'month'].includes(timeUnit)) throw new TrendSourceError('INPUT', 'timeUnit must be date, week or month');
  const queryGroups = serializeGroups(groups);
  const jar = cookieJar();
  const base = { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' };

  const boot = await fetchText('https://lcs.naver.com/m?u=https%3A%2F%2Fdatalab.naver.com%2F', { fetchImpl, attempts: 1, headers: { ...base, referer: `${ORIGIN}/` } });
  jar.keep(boot.response);
  const page = await fetchText(`${ORIGIN}/keyword/trendSearch.naver`, { fetchImpl, attempts: 1, headers: { ...base, cookie: jar.header() } });
  assertStatus(page.response);
  jar.keep(page.response);

  const body = new URLSearchParams({ qcType: 'N', queryGroups, startDate: ymd(startDate), endDate: ymd(endDate), timeUnit, gender, age, device });
  const hash = await fetchText(`${ORIGIN}/qcHash.naver`, { fetchImpl, attempts: 1, method: 'POST', body: body.toString(), headers: {
    ...base, cookie: jar.header(), origin: ORIGIN, referer: `${ORIGIN}/keyword/trendSearch.naver`,
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' } });
  assertStatus(hash.response);
  jar.keep(hash.response);
  let ack;
  try { ack = JSON.parse(hash.text); } catch { throw new TrendSourceError('SCHEMA', 'qcHash did not return JSON'); }
  if (ack?.success !== true || !/^[A-Z]_[0-9a-f]{16,64}$/.test(ack.hashKey ?? '')) {
    throw new TrendSourceError('APPLICATION', 'qcHash rejected the query', { code: String(ack?.code ?? '').slice(0, 40) });
  }

  const result = await fetchText(`${ORIGIN}/keyword/trendResult.naver?hashKey=${encodeURIComponent(ack.hashKey)}`, { fetchImpl, attempts: 1,
    headers: { ...base, cookie: jar.header(), referer: `${ORIGIN}/keyword/trendSearch.naver` } });
  assertStatus(result.response);
  if (Buffer.byteLength(result.text) > 2_000_000) throw new TrendSourceError('SIZE', 'Result page too large');
  const parsed = parseTrendResult(result.text);
  return {
    ...parsed,
    summary: summarizeSeries(parsed.series),
    receipt: { method: 'POST+GET', origin: ORIGIN, paths: ['/qcHash.naver', '/keyword/trendResult.naver'], httpStatus: result.response.status,
      bootstrapCookieNames: jar.names(), resultSha256: sha(result.text), groups: parsed.series.length,
      points: parsed.series[0]?.data.length ?? 0, valueScale: 'relative_0_100_within_query', browserUsed: false, credentialsUsed: false },
  };
}
