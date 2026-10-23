import { assertStatus, fetchText, TrendSourceError } from '../lib/http.mjs';

function decodeXml(value = '') {
  return String(value)
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

export function parseApproxTraffic(raw) {
  const match = String(raw || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB]?)\+?/i);
  if (!match) return null;
  const multipliers = { '': 1, K: 1e3, M: 1e6, B: 1e9 };
  return Math.round(Number(match[1]) * multipliers[match[2].toUpperCase()]);
}

export function parseGoogleTrendsRss(xml) {
  if (!/<rss[\s>]/i.test(xml)) throw new TrendSourceError('SCHEMA', 'Google Trends response was not RSS');
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => match[1]);
  return items.map(block => {
    const news = [...block.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/gi)].map(match => ({
      title: tag(match[1], 'ht:news_item_title'),
      url: tag(match[1], 'ht:news_item_url'),
      source: tag(match[1], 'ht:news_item_source'),
    }));
    const trafficLabel = tag(block, 'ht:approx_traffic');
    return {
      keyword: tag(block, 'title'),
      approxTrafficLabel: trafficLabel,
      approxTraffic: parseApproxTraffic(trafficLabel),
      publishedAt: tag(block, 'pubDate'),
      pictureSource: tag(block, 'ht:picture_source'),
      news,
    };
  }).filter(item => item.keyword);
}

export async function fetchGoogleTrending({ geo = 'KR', fetchImpl = globalThis.fetch } = {}) {
  if (!/^[A-Z]{2}$/.test(geo)) throw new TrendSourceError('INPUT', 'Google Trends geo must be a two-letter code');
  const url = new URL('https://trends.google.com/trending/rss');
  url.searchParams.set('geo', geo);
  const { response, text } = await fetchText(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept-language': 'ko-KR,ko;q=0.9',
      accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    fetchImpl,
  });
  assertStatus(response);
  const trends = parseGoogleTrendsRss(text);
  return {
    geo,
    trends,
    receipt: {
      method: 'GET',
      origin: url.origin,
      path: url.pathname,
      queryFields: ['geo'],
      httpStatus: response.status,
      responseContentType: response.headers.get('content-type') || null,
      responseBytes: Buffer.byteLength(text),
      browserUsed: false,
    },
  };
}
