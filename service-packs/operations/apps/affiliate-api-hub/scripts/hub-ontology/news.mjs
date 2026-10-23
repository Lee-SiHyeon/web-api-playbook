#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchFeed } from '../../../naver-blog-api/research/content-store/feeds.mjs';
import { fetchAnthropicSitemap, fetchDeepseekDocsNews, fetchHfQwenModels, fetchHfDeepseekModels } from '../../../naver-blog-api/research/content-store/vendor-releases.mjs';
import { collectLeaderBrief } from '../../../naver-blog-api/research/content-store/leader-statements.mjs';
import { REPO, CONTENT_STORE, LOCAL_ROOT, CODEX_ROOT, DRIVE_ROOT, hubItem, text, publicUrl,
  recent, finalize, newest, readData, dataFiles, readOnlyFetch, errorCode, cliReport } from './trend-news-common.mjs';

// News has no fabricated expiry. Omit publications older than 30 days; leader statements use 7 days.
export const MAX_AGE_DAYS = 30;
export const LEADER_AGE_DAYS = 7;
const VENDORS = {
  'official-ai-openai-rss': { source: 'openai', store: 'OpenAI', hosts: ['openai.com', 'www.openai.com'] },
  'official-ai-google-rss': { source: 'googleai', store: 'Google AI', hosts: ['blog.google'] },
  'official-ai-deepmind-rss': { source: 'deepmind', store: 'Google DeepMind', hosts: ['deepmind.google', 'blog.google'] },
  'official-ai-gemini-models-rss': { source: 'googleai', store: 'Google Gemini', hosts: ['blog.google'] },
  'official-ai-anthropic-sitemap': { source: 'anthropic', store: 'Anthropic', hosts: ['www.anthropic.com', 'anthropic.com'] },
  'official-ai-deepseek-docs': { source: 'deepseek', store: 'DeepSeek', hosts: ['api-docs.deepseek.com'] },
  'official-ai-qwen-hf': { source: 'qwen', store: 'Qwen', hosts: ['huggingface.co'], path: /^\/Qwen\// },
  'official-ai-deepseek-hf': { source: 'deepseek', store: 'DeepSeek', hosts: ['huggingface.co'], path: /^\/deepseek-ai\// },
};
const ADAPTERS = { anthropic_sitemap: fetchAnthropicSitemap, deepseek_docs_news: fetchDeepseekDocsNews,
  hf_qwen_models: fetchHfQwenModels, hf_deepseek_models: fetchHfDeepseekModels };

function officialUrl(value, vendor) {
  if (!publicUrl(value)) return false;
  const url = new URL(value);
  return vendor.hosts.includes(url.hostname) && (!vendor.path || vendor.path.test(url.pathname));
}

export function mapVendorNews(rows, sourceId, { now = new Date() } = {}) {
  const vendor = VENDORS[sourceId];
  if (!vendor) return [];
  return rows.flatMap(row => {
    const sourceUrl = row.url ?? row.sourceUrl ?? (row.urls ?? []).find(url => officialUrl(url, vendor));
    // collectedAt alone is insufficient: an undated old release must never become today's news.
    if (!officialUrl(sourceUrl, vendor) || row.ended === true || !recent(row.publishedAt ?? row.postedAt, now, MAX_AGE_DAYS)) return [];
    const item = hubItem({ source: vendor.source, kind: 'news', title: row.titleKo || row.title_ko || row.title,
      store: row.publisher || vendor.store, sourceUrl, postedAt: row.publishedAt ?? row.postedAt,
      summary: row.summaryKo || row.summary_ko || row.summary || row.titleKo || row.title,
      imageUrl: row.imageUrl ?? null, category: 'digital', tags: ['AI'], expiresAt: row.expiresAt ?? null, ended: row.ended === true });
    return item && (!item.expiresAt || Date.parse(item.expiresAt) > now.getTime()) ? [item] : [];
  });
}

export function mapNewsCollection(collection, { now = new Date() } = {}) {
  const rows = Array.isArray(collection) ? collection : collection?.candidates ?? Object.values(collection?.entries ?? {});
  return rows.flatMap(row => (row.sourceIds ?? []).flatMap(id => mapVendorNews([row], id, { now })));
}

export function mapLeaderBrief(brief, { now = new Date() } = {}) {
  const items = [];
  const statements = [...(brief?.statements ?? []), ...(brief?.linked ?? []).map(link => link.statement)].filter(Boolean);
  for (const row of statements) {
    const url = publicUrl(row.originalUrl);
    if (!url || !/^https:\/\/truthsocial\.com\/@realDonaldTrump\//.test(url) || !recent(row.publishedAt, now, LEADER_AGE_DAYS)) continue;
    items.push(hubItem({ source: 'trump', kind: 'news', title: row.titleKo || row.title || row.text,
      store: 'Donald Trump', sourceUrl: url, postedAt: row.publishedAt, summary: row.summaryKo || row.text,
      tags: (row.issueKinds ?? []).map(kind => typeof kind === 'string' ? kind : kind.id).filter(Boolean), expiresAt: row.expiresAt ?? null, ended: row.ended === true }));
  }
  for (const row of brief?.executiveOrders ?? []) {
    if (!publicUrl(row.url) || new URL(row.url).hostname !== 'www.federalregister.gov' || !recent(row.publishedAt, now, LEADER_AGE_DAYS)) continue;
    items.push(hubItem({ source: 'federalregister', kind: 'news', title: row.titleKo || row.title, store: 'Federal Register',
      sourceUrl: row.url, postedAt: row.publishedAt, summary: row.summary || row.title, tags: ['executive_order'], expiresAt: row.expiresAt ?? null, ended: row.ended === true }));
  }
  const reactions = [...(brief?.koreaMentionedByJpCn ?? []), ...(brief?.unlinkedReactions ?? []),
    ...(brief?.linked ?? []).flatMap(link => [...(link.jp ?? []), ...(link.cn ?? [])])];
  for (const row of reactions) {
    const url = publicUrl(row.sourceUrl), country = row.country;
    const host = country === 'cn' ? 'www.mfa.gov.cn' : country === 'jp' ? 'www.mofa.go.jp' : null;
    if (!url || !host || new URL(url).hostname !== host || !text(row.answer) || !recent(row.date, now, LEADER_AGE_DAYS)) continue;
    // A reporter's question is not the government's statement: use only the paired official answer.
    items.push(hubItem({ source: country === 'cn' ? 'china_mfa' : 'japan_mofa', stableId: `${url}:${row.answer}`, kind: 'news',
      title: row.titleKo || row.sourceTitle, store: country === 'cn' ? '중국 외교부' : '일본 외무성',
      sourceUrl: url, postedAt: row.date, summary: row.answer, tags: (row.issueKinds ?? []).map(kind => typeof kind === 'string' ? kind : kind.id).filter(Boolean) }));
  }
  return finalize(items, { now, days: MAX_AGE_DAYS });
}

export async function loadWithReport({ now = new Date(), fetchImpl = globalThis.fetch, live = true,
  configFile = path.join(CONTENT_STORE, 'sources.json'),
  fallbackRoots = [path.join(REPO, 'apps/naver-blog-api/workflow-runs'), path.join(LOCAL_ROOT, 'research'), CODEX_ROOT, path.join(DRIVE_ROOT, 'captures')],
  ledgerFile = path.join(CONTENT_STORE, 'ledger/candidates.json'), catalogFile = path.join(REPO, 'apps/content-catalog/data/catalog.db') } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  const sources = [], warnings = [], candidates = [], succeeded = new Set();
  const config = await readData(configFile);
  const selected = (config?.sources ?? []).filter(source => VENDORS[source.id] && (source.kind === 'rss_feed' || ADAPTERS[source.kind]));
  sources.push({ type: 'config', path: configFile, sources: selected.map(source => source.id) });
  if (!selected.length) warnings.push('Official AI source config missing or empty.');
  const fetchPublic = readOnlyFetch(fetchImpl);
  if (live) {
    // Four bounded, independent public source reads at a time. No authenticated collector is imported.
    for (let offset = 0; offset < selected.length; offset += 4) {
      const batch = selected.slice(offset, offset + 4);
      const results = await Promise.allSettled(batch.map(async source => {
        const endpoints = new Set();
        const fetchTracked = (url, options) => { endpoints.add(String(url)); return fetchPublic(url, options); };
        try {
          const result = source.kind === 'rss_feed'
            ? await fetchFeed(source.url, { limit: 20, fetchImpl: fetchTracked })
            : await ADAPTERS[source.kind](8, { fetchImpl: fetchTracked });
          const items = mapVendorNews(result.items, source.id, { now });
          return { sourceId: source.id, items, report: { type: 'live', source: source.id, endpoint: result.receipt.sourceUrl,
            endpoints: [...endpoints], checkedAt: now.toISOString(), newestTimestamp: newest(result.items.map(row => row.publishedAt)),
            rows: result.items.length, mapped: items.length, failures: result.receipt.failures ?? [], adapter: source.kind } };
        } catch (error) {
          return { sourceId: source.id, items: [], failed: true, report: { type: 'live', source: source.id, endpoints: [...endpoints], mapped: 0, error: errorCode(error) } };
        }
      }));
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'rejected') { warnings.push(`${batch[i].id}: PUBLIC_READ_FAILED`); continue; }
        sources.push(result.value.report); candidates.push(...result.value.items);
        if (result.value.items.length) succeeded.add(result.value.sourceId);
        if (result.value.failed) warnings.push(`${result.value.sourceId}: ${result.value.report.error}`);
      }
    }
    const endpoints = new Set();
    try {
      const brief = await collectLeaderBrief({ now: now.getTime(), hours: LEADER_AGE_DAYS * 24, maxPages: 2,
        fetchImpl: (url, options) => { endpoints.add(String(url)); return fetchPublic(url, options); } });
      const items = mapLeaderBrief(brief, { now }); candidates.push(...items);
      sources.push({ type: 'live', source: 'world_leaders', endpoints: [...endpoints], checkedAt: now.toISOString(),
        newestTimestamp: newest(items.map(item => item.postedAt)), mapped: items.length, errors: brief.errors,
        pendingTranscripts: (brief.pendingTranscripts ?? []).map(row => ({ country: row.country, url: row.url, date: row.date })), adapter: 'leader-statements.collectLeaderBrief' });
      if (!items.length) warnings.push('World leaders: no recent statements with official original URLs and usable text.');
    } catch (error) {
      sources.push({ type: 'live', source: 'world_leaders', endpoints: [...endpoints], mapped: 0, error: errorCode(error) });
      warnings.push(`World leaders: ${errorCode(error)}`);
    }
  }
  // For failed/empty live sources, choose the newest run per vendor before consulting the old ledger/catalog.
  if (!live || selected.some(source => !succeeded.has(source.id)) || !candidates.some(item => ['trump', 'federalregister', 'china_mfa', 'japan_mofa'].includes(item.source))) {
    const entries = [];
    for (const root of fallbackRoots) entries.push(...await dataFiles(root, file => /(?:collection(?:[-.][^\\/]*)?|leader-brief[^\\/]*|world-leaders[^\\/]*|frontier-coverage[^\\/]*)\.json$/.test(file), { limit: 30 }));
    const files = entries.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 60);
    const loaded = await Promise.all(files.map(async entry => ({ ...entry, data: await readData(entry.file) })));
    loaded.sort((a, b) => (b.data?.checkedAt ?? b.data?.generatedAt ?? b.mtime).localeCompare(a.data?.checkedAt ?? a.data?.generatedAt ?? a.mtime));
    const fallbackSeen = new Set(succeeded);
    for (const entry of loaded) {
      if (!entry.data) continue;
      const isLeader = Array.isArray(entry.data.linked) || Array.isArray(entry.data.executiveOrders);
      let items = [];
      if (isLeader && !fallbackSeen.has('world_leaders')) {
        items = mapLeaderBrief(entry.data, { now });
        if (items.length) fallbackSeen.add('world_leaders');
      } else if (entry.data.candidates) {
        for (const source of selected.filter(source => !fallbackSeen.has(source.id))) {
          const rows = entry.data.candidates.filter(row => row.sourceIds?.includes(source.id));
          const mapped = mapVendorNews(rows, source.id, { now });
          if (mapped.length) { items.push(...mapped); fallbackSeen.add(source.id); }
        }
      }
      if (items.length) {
        candidates.push(...items);
        sources.push({ type: 'file_fallback', path: entry.file, newestTimestamp: entry.data.checkedAt ?? entry.data.generatedAt ?? newest(items.map(item => item.postedAt)), mapped: items.length });
      }
    }
    const ledger = await readData(ledgerFile);
    if (ledger) {
      const rows = Object.values(ledger.entries ?? {});
      const items = selected.filter(source => !fallbackSeen.has(source.id)).flatMap(source => mapVendorNews(rows.filter(row => row.sourceIds?.includes(source.id)), source.id, { now }));
      candidates.push(...items);
      sources.push({ type: 'ledger_fallback', path: ledgerFile, newestTimestamp: ledger.updatedAt ?? null, mapped: items.length });
    }
  }
  if (!finalize(candidates, { now, days: MAX_AGE_DAYS }).length) {
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(catalogFile, { readOnly: true });
      const runs = db.prepare('SELECT checked_at, path FROM collection_runs ORDER BY checked_at DESC LIMIT 20').all();
      for (const run of runs) {
        const data = await readData(run.path);
        if (data) {
          const items = mapNewsCollection(data, { now }); candidates.push(...items);
          if (items.length) sources.push({ type: 'catalog_run_file', path: run.path, newestTimestamp: run.checked_at, mapped: items.length });
        }
      }
      sources.push({ type: 'catalog_fallback', path: catalogFile, table: 'collection_runs', newestTimestamp: newest(runs.map(run => run.checked_at)),
        builtAt: db.prepare("SELECT value FROM meta WHERE key = 'builtAt'").get()?.value ?? null,
        mapped: finalize(candidates, { now, days: MAX_AGE_DAYS }).length });
    } catch { warnings.push('Read-only catalog fallback unavailable.'); }
    finally { db?.close(); }
  }
  return { items: finalize(candidates, { now, days: MAX_AGE_DAYS }), sources, warnings };
}

export async function load({ now = new Date(), ...options } = {}) {
  return (await loadWithReport({ now, ...options })).items;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv.includes('--dry-run')) { console.error('Usage: node news.mjs --dry-run'); process.exitCode = 1; }
  else loadWithReport().then(result => console.log(JSON.stringify(cliReport(result), null, 2))).catch(error => { console.error(errorCode(error)); process.exitCode = 1; });
}
