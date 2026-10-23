// TrafficScent backdata (owner 2026-10-10 "이 백데이터 그 자체를 얻을수있어야함"): the public pages carry their whole list as
// SvelteKit SSR data (`kit.start(app, element, { data: [...] })`). This reads only what robots.txt asks crawlers to read —
// the plain pages, ?category= pages and ?lang= versions; never /api/ or site=/sort=/page=/country= views — parses that
// object literal without evaluating it, and keeps a dated snapshot plus append-only ledgers (posts by source_url, search
// trends per observation) so the history accumulates run by run. Upstream sources: trafficscent-upstream-sources.v1.json.
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ORIGIN = 'https://trafficscent.com';
export const PAGES = ['/', '/youtube', '/news', '/blog', '/deals', '/apps', '/games', '/benchmark'];
// robots.txt 2026-10-10: Disallow /api/ and any URL with refresh= q= site= sort= page= country= type= store= chart= tag=.
const DISALLOWED = /^\/api\/|[?&](refresh|q|site|sort|page|country|type|store|chart|tag)=/;
export const DRIVE_ROOT = 'G:\\내 드라이브\\생활이득AI연구소-data\\captures\\trafficscent-captures';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function allowedPath(p) {
  if (DISALLOWED.test(p)) return false;
  const q = p.split('?')[1];
  return !q || q.split('&').every(kv => /^(category|lang)=[\w-]+$/.test(kv));
}

// Parses the JS object literal SvelteKit inlines (objects, arrays, strings, numbers, true/false/null, `void 0`, bare keys).
// Anything else (a function, `new Date`, an identifier value) is refused rather than evaluated.
export function parseLiteral(src, start = 0) {
  let i = start;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const fail = m => { throw Object.assign(new Error(`TRAFFICSCENT_LITERAL: ${m} at ${i}`), { code: 'TRAFFICSCENT_LITERAL' }); };
  const str = () => {
    const q = src[i]; let j = i + 1, out = '';
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') {
        const c = src[j + 1];
        if (c === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
        if (c === 'x') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; continue; }
        out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[c] ?? c; j += 2; continue;
      }
      out += src[j++];
    }
    if (j >= src.length) fail('unterminated string');
    i = j + 1; return out;
  };
  const REF = Symbol('ref');
  let scope = [];
  // devalue dedupes repeated values as `(function(a,b){return BODY}(ARG_A,ARG_B))`; params bind only to literal args.
  const iife = () => {
    i += '(function('.length;
    const close = src.indexOf(')', i); const params = src.slice(i, close).split(',').map(s => s.trim()).filter(Boolean);
    if (!params.every(p => /^[A-Za-z_$][\w$]*$/.test(p))) fail('iife params');
    i = close + 1; ws(); if (!src.startsWith('{return ', i)) fail('iife body'); i += '{return '.length;
    const outer = scope; scope = [...outer, ...params];
    const body = value(); scope = outer;
    ws(); if (src[i] === ';') i++; ws(); if (src[i++] !== '}') fail('iife end'); ws(); if (src[i++] !== '(') fail('iife args');
    const args = [];
    for (;;) { ws(); if (src[i] === ')') { i++; break; } args.push(value()); ws(); if (src[i] === ',') i++; else if (src[i] !== ')') fail('iife arg separator'); }
    ws(); if (src[i++] !== ')') fail('iife close');
    const env = Object.fromEntries(params.map((p, n) => [p, args[n] ?? null]));
    const bind = v => v && typeof v === 'object' ? (v[REF] ? (v[REF] in env ? env[v[REF]] : v) : Array.isArray(v) ? v.map(bind) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bind(x)]))) : v;
    return bind(body);
  };
  const value = () => {
    ws(); const c = src[i];
    if (src.startsWith('(function(', i)) return iife();
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 60))?.[0];
    if (id && scope.includes(id) && !['true', 'false', 'null', 'void'].includes(id)) { i += id.length; return { [REF]: id }; }
    if (c === '{') {
      i++; const o = {};
      for (;;) {
        ws(); if (src[i] === '}') { i++; return o; }
        let k; if (src[i] === '"' || src[i] === "'") k = str();
        else { const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(src.slice(i, i + 200)); if (!m) fail('key'); k = m[0]; i += k.length; }
        ws(); if (src[i++] !== ':') fail('colon');
        o[k] = value(); ws();
        if (src[i] === ',') i++; else if (src[i] !== '}') fail('object separator');
      }
    }
    if (c === '[') {
      i++; const a = [];
      for (;;) {
        ws(); if (src[i] === ']') { i++; return a; }
        a.push(value()); ws();
        if (src[i] === ',') i++; else if (src[i] !== ']') fail('array separator');
      }
    }
    if (c === '"' || c === "'") return str();
    const num = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i, i + 40));
    if (num) { i += num[0].length; return Number(num[0]); }
    for (const [w, v] of [['true', true], ['false', false], ['null', null], ['void 0', null]]) if (src.startsWith(w, i)) { i += w.length; return v; }
    fail('unsupported value');
  };
  const v = value();
  return { value: v, end: i };
}

// The page data nodes from the SSR bootstrap; each node is {type:'data', data, uses} or null (layout without data).
export function extractPageData(html) {
  const k = html.indexOf('kit.start(');
  if (k < 0) throw Object.assign(new Error('TRAFFICSCENT_NO_SSR_DATA'), { code: 'TRAFFICSCENT_NO_SSR_DATA' });
  const d = html.indexOf('data:', html.indexOf('{', k));
  if (d < 0) throw Object.assign(new Error('TRAFFICSCENT_NO_SSR_DATA'), { code: 'TRAFFICSCENT_NO_SSR_DATA' });
  const nodes = parseLiteral(html, d + 5).value;
  const merged = {};
  for (const n of nodes) if (n && n.type === 'data' && n.data) Object.assign(merged, n.data);
  return merged;
}

// One page's lists in a stable shape: posts (community/youtube/news/blog/deals rows), trends, charts, the rest as-is.
export function summarize(data) {
  const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object');
  return Object.fromEntries(arrays.map(([k, v]) => [k, v.length]));
}

async function get(p) {
  if (!allowedPath(p)) throw Object.assign(new Error(`TRAFFICSCENT_ROBOTS_DISALLOWED ${p}`), { code: 'TRAFFICSCENT_ROBOTS_DISALLOWED' });
  const res = await fetch(ORIGIN + p, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw Object.assign(new Error(`TRAFFICSCENT_HTTP_${res.status} ${p}`), { code: 'TRAFFICSCENT_HTTP', status: res.status });
  return res.text();
}

const rowsOf = data => Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object');

export async function collect({ pages = PAGES, categories = false, out = DRIVE_ROOT, delayMs = 1500, fetchPage = get, now = new Date() } = {}) {
  const at = now.toISOString();
  const day = at.slice(0, 10), stamp = at.slice(11, 16).replace(':', '');
  const dir = path.join(out, day); mkdirSync(dir, { recursive: true });
  const ledger = path.join(out, 'posts.jsonl'), trends = path.join(out, 'trends.jsonl');
  const seen = new Set(existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).key; } catch { return null; } }) : []);
  const queue = [...pages], report = [];
  let newPosts = 0, trendRows = 0;
  for (let n = 0; n < queue.length; n++) {
    const p = queue[n];
    if (n) await new Promise(r => setTimeout(r, delayMs));
    let data;
    try { data = extractPageData(await fetchPage(p)); }
    catch (e) { report.push({ page: p, error: e.code ?? e.message }); continue; }
    if (categories && p === '/' && Array.isArray(data.categories))
      for (const c of data.categories) if (/^[\w-]+$/.test(c.id ?? '') && c.id !== 'popular') queue.push(`/?category=${c.id}`);
    const name = p === '/' ? 'home' : p.replace(/^\/\??/, '').replace(/[^\w-]+/g, '_');
    writeFileSync(path.join(dir, `${stamp}-${name}.json`), JSON.stringify({ page: ORIGIN + p, observedAt: at, data }) + '\n');
    if (data.metrics && typeof data.metrics === 'object' && !Array.isArray(data.metrics) && p === pages[0])
      appendFileSync(path.join(out, 'metrics.jsonl'), JSON.stringify({ observedAt: at, ...data.metrics }) + '\n');
    for (const [list, rows] of rowsOf(data)) {
      if (list === 'trendingKeywords') {
        if (trendRows) continue; // every page repeats the same search-trend box; one observation per run
        for (const t of rows) appendFileSync(trends, JSON.stringify({ observedAt: at, page: p, rank: t.rank, keyword: t.keyword, traffic: t.traffic ?? null, diff: t.diff ?? null, newsTitle: t.newsTitle ?? null, newsUrl: t.newsUrl ?? null }) + '\n');
        trendRows += rows.length; continue;
      }
      if (rows[0].rank != null && rows[0].storeUrl) { // store charts are snapshots: every run keeps the whole ranking
        for (const r of rows) appendFileSync(path.join(out, 'ranks.jsonl'), JSON.stringify({ observedAt: at, page: p, chartAsOf: data.lastUpdated ?? null,
          platform: r.platform, chartType: r.chartType, country: r.country, rank: r.rank, id: r.id, name: r.name, developer: r.developer, category: r.category, price: r.price, storeUrl: r.storeUrl }) + '\n');
        continue;
      }
      for (const r of rows) {
        // deals carry the community post (fmkoreaUrl), the shop page (originalUrl) and TrafficScent's own outbound `url`
        const url = r.source_url ?? r.fmkoreaUrl ?? r.originalUrl ?? r.url ?? r.link ?? null;
        if (!url || typeof url !== 'string') continue;
        const key = `${list}|${url}`;
        if (seen.has(key)) continue;
        seen.add(key); newPosts++;
        appendFileSync(ledger, JSON.stringify({ key, list, page: p, firstSeenAt: at, row: r }) + '\n');
      }
    }
    report.push({ page: p, lists: summarize(data) });
  }
  return { observedAt: at, dir, pages: report, newPosts, trendRows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  // Scheduled every 15 min (task Codex-TrafficScent-Collect): plain pages each run, ?category= pages once an hour.
  const categories = process.argv.includes('--categories') || (process.argv.includes('--categories-hourly') && new Date().getMinutes() < 15);
  const out = arg('out') ?? DRIVE_ROOT;
  let r;
  try { r = await collect({ categories, out, pages: arg('pages')?.split(',') ?? PAGES }); }
  catch (e) { r = { observedAt: new Date().toISOString(), error: e.code ?? e.message }; process.exitCode = 1; }
  try { appendFileSync(path.join(out, 'runs.jsonl'), JSON.stringify({ ...r, pages: r.pages?.map(p => p.error ? p : { page: p.page }), categories }) + '\n'); } catch { /* Drive offline */ }
  console.log(JSON.stringify(r));
}
