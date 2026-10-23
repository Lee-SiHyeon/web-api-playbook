// 오늘의 특징주 collector (owner 2026-09-30: "오늘의 특징주 ? 이런것도 괜찮고"). Public, anonymous reads only:
//   Naver mobile stock JSON (observed 2026-09-30, needs referer https://m.stock.naver.com/):
//     /api/stocks/up/{KOSPI|KOSDAQ}?page=1&pageSize=N   rising list; compareToPreviousPrice.name === 'UPPER_LIMIT' marks 상한가
//     /api/index/{KOSPI|KOSDAQ}/basic                    index close and change
//     /api/news/stock/{code}?pageSize=5&page=1           the stock's own news (officeName, datetime, title)
//   Yonhap economy RSS https://www.yna.co.kr/rss/economy.xml   "[특징주] …" headlines (market-wide reasons)
// A reason is attached only when a headline names the stock (or its name is in a [특징주] title). Otherwise the row says
// "이유 미확인". This lists what moved and what the press said; it never recommends buying.
// Usage: node featured-stocks.mjs [--top=8] [--min-ratio=10] [--json]
import { fileURLToPath } from 'node:url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const HEAD = { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', referer: 'https://m.stock.naver.com/', accept: 'application/json' };
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export function parseUpList(json, market) {
  return (json?.stocks ?? []).filter(s => s.stockEndType === 'stock').map(s => ({
    code: s.itemCode, name: s.stockName, market, close: num(s.closePrice), changePct: num(s.fluctuationsRatio),
    upperLimit: s.compareToPreviousPrice?.name === 'UPPER_LIMIT', tradingValueEok: num(s.accumulatedTradingValue) === null ? null : Math.round(num(s.accumulatedTradingValue) / 100),
    tradingValueText: s.accumulatedTradingValueKrwHangeul ?? null, marketValueText: s.marketValueHangeul ?? null, url: s.endUrl ?? `https://m.stock.naver.com/domestic/stock/${s.itemCode}`,
    tradedAt: s.localTradedAt ?? null,
  }));
}

export function parseIndex(json) {
  if (!json?.itemCode) return null;
  return { code: json.itemCode, name: json.stockName, close: num(json.closePrice), change: num(json.compareToPreviousClosePrice), changePct: num(json.fluctuationsRatio), status: json.marketStatus ?? null, tradedAt: json.localTradedAt ?? null };
}

export function parseStockNews(json) {
  const groups = Array.isArray(json) ? json : [];
  const items = groups.flatMap(g => Array.isArray(g?.items) ? g.items : g?.title ? [g] : []);
  return items.map(i => ({ title: strip(i.title), body: strip(i.body), office: i.officeName ?? null, at: i.datetime ?? null, url: i.mobileNewsUrl ?? null })).filter(i => i.title);
}

// Naver news timestamps are 12 digits (yyyyMMddHHmm, KST); RSS ones are RFC 822.
export function newsTime(at) {
  const s = String(at ?? '');
  return /^\d{12}$/.test(s) ? Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`) : Date.parse(s);
}

export function parseYonhapFeatured(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const title = strip((m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) ?? [])[1]);
    const link = strip((m[1].match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) ?? [])[1]);
    const at = strip((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) ?? [])[1]);
    return { title, url: link, at };
  }).filter(i => /특징주/.test(i.title));
}

// A headline is a reason candidate for a stock when it names the stock, or is a "[특징주]" piece whose lead names it,
// and it was published within `hours` of `now`. A stale or unrelated headline is not a reason.
export function reasonFor(stock, news, now = Date.now(), hours = 30) {
  const cut = now - hours * 3600e3;
  const fresh = n => { const t = newsTime(n.at); return Number.isNaN(t) || t >= cut; };
  const hit = news.find(n => fresh(n) && (n.title.includes(stock.name) || (/특징주/.test(n.title) && (n.body ?? '').includes(stock.name))));
  return hit ? { title: hit.title, office: hit.office ?? null, url: hit.url ?? null, at: hit.at ?? null } : null;
}

export function pickFeatured({ up, minRatio = 10, top = 8 }) {
  return up.filter(s => s.changePct !== null && (s.upperLimit || s.changePct >= minRatio)).sort((a, b) => (b.upperLimit - a.upperLimit) || (b.changePct - a.changePct)).slice(0, top);
}

const getJson = async (fetchImpl, url) => { const r = await fetchImpl(url, { headers: HEAD, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Object.assign(new Error(`HTTP_${r.status}`), { code: `HTTP_${r.status}`, url }); return r.json(); };
const getText = async (fetchImpl, url) => { const r = await fetchImpl(url, { headers: { ...HEAD, accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Object.assign(new Error(`HTTP_${r.status}`), { code: `HTTP_${r.status}`, url }); return r.text(); };

export async function collectFeaturedStocks({ fetchImpl = fetch, now = Date.now(), top = 8, minRatio = 10, pageSize = 40 } = {}) {
  const errors = [];
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { errors.push(`${label}:${e.code ?? e.message}`); return null; } };
  const [kospi, kosdaq, upKospi, upKosdaq, yna] = await Promise.all([
    safe('index_kospi', () => getJson(fetchImpl, 'https://m.stock.naver.com/api/index/KOSPI/basic')),
    safe('index_kosdaq', () => getJson(fetchImpl, 'https://m.stock.naver.com/api/index/KOSDAQ/basic')),
    safe('up_kospi', () => getJson(fetchImpl, `https://m.stock.naver.com/api/stocks/up/KOSPI?page=1&pageSize=${pageSize}`)),
    safe('up_kosdaq', () => getJson(fetchImpl, `https://m.stock.naver.com/api/stocks/up/KOSDAQ?page=1&pageSize=${pageSize}`)),
    safe('yna_rss', () => getText(fetchImpl, 'https://www.yna.co.kr/rss/economy.xml')),
  ]);
  const featuredNews = yna ? parseYonhapFeatured(yna) : [];
  const chosen = pickFeatured({ up: [...parseUpList(upKospi, 'KOSPI'), ...parseUpList(upKosdaq, 'KOSDAQ')], minRatio, top });
  const stocks = [];
  for (const s of chosen) {
    const news = await safe(`news_${s.code}`, async () => parseStockNews(await getJson(fetchImpl, `https://m.stock.naver.com/api/news/stock/${s.code}?pageSize=5&page=1`))) ?? [];
    const own = reasonFor(s, news, now);
    const market = own ? null : featuredNews.find(n => n.title.includes(s.name)) ?? null;
    stocks.push({ ...s, reason: own ?? (market ? { title: market.title, office: '연합뉴스', url: market.url, at: market.at } : null), reasonStatus: own || market ? 'headline' : 'unconfirmed' });
  }
  return {
    generatedAt: new Date(now).toISOString(), indices: [parseIndex(kospi), parseIndex(kosdaq)].filter(Boolean), stocks,
    marketWide: featuredNews.slice(0, 6), errors,
    policy: '시장 데이터와 기사 제목만 전한다. 매수·매도 권유와 상승 예측을 쓰지 않는다. 이유는 기사 제목이 종목명을 직접 언급할 때만 붙이고, 없으면 "이유 미확인".',
  };
}

export function renderFeatured(r) {
  const idx = r.indices.map(i => `${i.name} ${i.close?.toLocaleString('en-US')}(${i.changePct > 0 ? '+' : ''}${i.changePct}%)`).join(' · ');
  const rows = r.stocks.map(s => `- ${s.name}(${s.market}) ${s.upperLimit ? '상한가 ' : ''}${s.changePct > 0 ? '+' : ''}${s.changePct}% 거래대금 ${s.tradingValueText ?? '?'} — ${s.reason ? `${s.reason.title} (${s.reason.office ?? '출처 미상'})` : '이유 미확인'}`);
  return [idx, ...rows].filter(Boolean).join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) ?? '').split('=')[1];
  const r = await collectFeaturedStocks({ top: Number(arg('top') ?? 8), minRatio: Number(arg('min-ratio') ?? 10) });
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : renderFeatured(r));
  if (r.errors.length) console.error('errors:', r.errors.join(', '));
}
