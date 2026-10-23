import { assertStatus, fetchText, TrendSourceError } from '../lib/http.mjs';

// Exploding Topics public topic list (https://explodingtopics.com/topic): a global (mostly US Google search) early
// signal — topics with a 2-year search volume and growth, before they peak. robots.txt allows everything
// (checked 2026-09-26). Anonymous visitors see about 27 free tiles; Pro tiles link to /pricing and are skipped.
// Owner request 2026-09-26 (X post on trend tools): Glimpse and Feedly were checked and left out — Glimpse's data
// is behind its paid app and Feedly needs a login; RSS feeds are already covered by content-store/feeds.mjs.

const decode = s => String(s ?? '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export function parseVolume(label) {
  const m = String(label ?? '').replace(/,/g, '').match(/^([\d.]+)\s*([KMB]?)$/i);
  return m ? Math.round(Number(m[1]) * { '': 1, K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()]) : null;
}

export function parseExplodingTopics(html) {
  if (!/tileKeyword/.test(html)) throw new TrendSourceError('SCHEMA', 'Exploding Topics page has no topic tiles');
  const topics = [];
  for (const m of html.matchAll(/<a class="tileLink" href="(\/topic\/[^"]+)">([\s\S]*?)(?=<div class="tileStyle|<\/main>|$)/g)) {
    const tile = m[2];
    const keyword = decode(/<div class="tileKeyword">([\s\S]*?)<\/div>/.exec(tile)?.[1]);
    const volumeLabel = decode(/scoreTag--volume"><div class="scoreTagTop">([^<]*)</.exec(tile)?.[1]);
    const growthLabel = decode(/scoreTagTop growth[^"]*">([^<]*)</.exec(tile)?.[1]);
    const description = decode(/<div class="tileDescription">([\s\S]*?)<\/div>/.exec(tile)?.[1]);
    if (!keyword) continue;
    const growthPct = growthLabel ? Number(growthLabel.replace(/[+,%]/g, '')) : null;
    topics.push({ keyword, volumeLabel: volumeLabel || null, volume: parseVolume(volumeLabel), growthLabel: growthLabel || null,
      growthPct: Number.isFinite(growthPct) ? growthPct : null, description: description.slice(0, 400), url: `https://explodingtopics.com${m[1]}` });
  }
  const seen = new Set();
  return topics.filter(t => !seen.has(t.url) && seen.add(t.url));
}

export async function fetchExplodingTopics({ fetchImpl = globalThis.fetch } = {}) {
  const url = new URL('https://explodingtopics.com/topic');
  const { response, text } = await fetchText(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' },
    fetchImpl,
  });
  assertStatus(response);
  const topics = parseExplodingTopics(text);
  return {
    topics,
    receipt: { method: 'GET', origin: url.origin, path: url.pathname, queryFields: [], httpStatus: response.status,
      responseContentType: response.headers.get('content-type') || null, responseBytes: Buffer.byteLength(text), browserUsed: false },
  };
}
