import { assertStatus, fetchText, TrendSourceError } from '../lib/http.mjs';

function randomKey() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

export function parseJsonp(text, callback) {
  const trimmed = String(text || '').trim();
  const prefix = `${callback}(`;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(')')) {
    throw new TrendSourceError('SCHEMA', 'Naver autocomplete response was not the expected JSONP callback');
  }
  try {
    return JSON.parse(trimmed.slice(prefix.length, -1));
  } catch {
    throw new TrendSourceError('SCHEMA', 'Naver autocomplete JSONP payload was invalid');
  }
}

export async function fetchAutocomplete(seed, { fetchImpl = globalThis.fetch } = {}) {
  const query = String(seed || '').trim();
  if (!query || query.length > 100) throw new TrendSourceError('INPUT', 'Autocomplete seed must be 1-100 characters');
  const key = randomKey();
  const callback = `trend_radar_${key}`;
  const url = new URL('https://ac.search.naver.com/nx/ac');
  const params = {
    q: query,
    con: '0',
    frm: 'nx',
    ans: '2',
    r_format: 'json',
    r_enc: 'UTF-8',
    r_unicode: '0',
    t_koreng: '1',
    run: '2',
    rev: '4',
    q_enc: 'UTF-8',
    st: '100',
    ackey: key,
    _callback: callback,
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const { response, text } = await fetchText(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept-language': 'ko-KR,ko;q=0.9',
      referer: 'https://search.naver.com/',
    },
    fetchImpl,
  });
  assertStatus(response);
  const payload = parseJsonp(text, callback);
  const rows = Array.isArray(payload?.items?.[0]) ? payload.items[0] : [];
  return {
    seed: query,
    suggestions: rows.map((row, index) => ({
      rank: index + 1,
      keyword: String(Array.isArray(row) ? row[0] : '').trim(),
    })).filter(row => row.keyword),
    receipt: {
      method: 'GET',
      origin: url.origin,
      path: url.pathname,
      queryFields: Object.keys(params).sort(),
      httpStatus: response.status,
      responseContentType: response.headers.get('content-type') || null,
      responseBytes: Buffer.byteLength(text),
      browserUsed: false,
    },
  };
}

export async function collectAutocomplete(seeds, {
  concurrency = 4,
  fetchImpl = globalThis.fetch,
} = {}) {
  const unique = [...new Set(seeds.map(value => String(value || '').trim()).filter(Boolean))];
  const results = [];
  const failures = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, async () => {
    while (cursor < unique.length) {
      const seed = unique[cursor++];
      try {
        results.push(await fetchAutocomplete(seed, { fetchImpl }));
      } catch (error) {
        failures.push({ seed, code: error?.code || error?.name || 'ERROR' });
      }
    }
  });
  await Promise.all(workers);
  return { requestedSeeds: unique.length, successfulSeeds: results.length, failures, results };
}
