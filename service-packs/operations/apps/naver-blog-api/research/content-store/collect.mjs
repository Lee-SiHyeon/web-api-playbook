import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fetchAutocomplete } from '../trend-radar/sources/naver-autocomplete.mjs';
import { fetchText, assertStatus } from '../trend-radar/lib/http.mjs';
import { fetchXXhr } from './x-xhr.mjs';
import { fetchThreadsXhr } from './threads-xhr.mjs';
import { fetchPublicPost, inspectPostUrl } from './public-posts.mjs';
import { fetchFeed } from './feeds.mjs';
import { fetchHfDailyPapers, fetchSignalRealtime } from './json-sources.mjs';
import { fetchNaverTodayDeals } from './naver-today-deals.mjs';
import { fetchEleventhStreetDeals } from './eleventh-street-deals.mjs';
import { fetchAirlinePromos } from './airline-promos.mjs';
import { fetchAgencyDeals } from './travel-deals-agencies.mjs';
import { fetchOnlineAgencyDeals } from './travel-deals-online.mjs';
import { fetchPlatformDeals } from './travel-deals-platforms.mjs';
import { fetchCoupangGoldbox } from './coupang-goldbox.mjs';
import { fetchPhotoroomDocs } from './photoroom-docs.mjs';
import { fetchDaangnSideHustle } from './daangn-side-hustle.mjs';
import { fetchAnthropicSitemap, fetchDeepseekDocsNews, fetchHfQwenModels, fetchHfDeepseekModels } from './vendor-releases.mjs';

const SOCIAL_KINDS = ['x_public_profile', 'x_xhr_profile', 'threads_xhr_profile'];
// Config-free adapters: `async (limit, { fetchImpl }) -> { items, receipt }`.
const ADAPTERS = {
  hf_daily_papers: fetchHfDailyPapers,
  signal_realtime: fetchSignalRealtime,
  naver_today_deals: fetchNaverTodayDeals,
  eleventh_street_deals: fetchEleventhStreetDeals,
  airline_promos: fetchAirlinePromos,
  travel_agency_deals: fetchAgencyDeals,
  travel_online_deals: fetchOnlineAgencyDeals,
  travel_platform_deals: fetchPlatformDeals,
  coupang_goldbox: fetchCoupangGoldbox,
  photoroom_docs: fetchPhotoroomDocs,
  daangn_side_hustle: fetchDaangnSideHustle,
  anthropic_sitemap: fetchAnthropicSitemap,
  deepseek_docs_news: fetchDeepseekDocsNews,
  hf_qwen_models: fetchHfQwenModels,
  hf_deepseek_models: fetchHfDeepseekModels,
};
// The vendors' own release pages: they count as first-party feeds (event-detectors officialSources) when the source id starts with official-.
const VENDOR_RELEASE_KINDS = new Set(['anthropic_sitemap', 'deepseek_docs_news', 'hf_qwen_models', 'hf_deepseek_models']);
const DEAL_KINDS = new Set(['naver_today_deals', 'eleventh_street_deals', 'airline_promos', 'coupang_goldbox',
  'travel_agency_deals', 'travel_online_deals', 'travel_platform_deals']);
// How each source kind is classified on the candidate row (ledger groups trend signals by these).
function rowKind(kind) {
  if (SOCIAL_KINDS.includes(kind)) return { sourceKind: 'public_social_post', evidenceLevel: 'graphql_json' };
  if (kind === 'naver_autocomplete') return { sourceKind: 'search_signal', evidenceLevel: 'autocomplete_query' };
  if (kind === 'signal_realtime') return { sourceKind: 'search_signal', evidenceLevel: 'realtime_rank' };
  if (kind === 'hf_daily_papers') return { sourceKind: 'paper', evidenceLevel: 'json_api' };
  if (kind === 'photoroom_docs') return { sourceKind: 'official_document', evidenceLevel: 'direct_markdown_document' };
  if (kind === 'daangn_side_hustle') return { sourceKind: 'community_research', evidenceLevel: 'direct_html_next_f' };
  if (kind === 'rss_feed' || VENDOR_RELEASE_KINDS.has(kind)) return { sourceKind: 'headline_only', evidenceLevel: 'direct_feed' };
  if (DEAL_KINDS.has(kind)) return { sourceKind: 'deal_listing', evidenceLevel: 'seller_listing' };
  return { sourceKind: 'headline_only', evidenceLevel: 'feed_headline' };
}

export const hash = value => createHash('sha256').update(value).digest('hex');
// 'general' holds cross-topic signals such as the Korean real-time search ranking.
const fields = new Set(['ai', 'travel', 'deals', 'finance', 'general']);
const clean = text => String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => clean(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]);

export function parseNews(xml) {
  if (!/<rss[\s>]/i.test(xml) || /<!ENTITY/i.test(xml)) throw new Error('RSS_SCHEMA');
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m => ({
    title: tag(m[1], 'title'), url: tag(m[1], 'link'),
    publishedAt: tag(m[1], 'pubDate'), publisher: tag(m[1], 'source'),
  })).filter(x => x.title && /^https:\/\//.test(x.url));
}

export function validateConfig(config) {
  const rootKeys = new Set(['schemaVersion', 'fields', 'perSourceLimit', 'sources', 'postUrls']);
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !rootKeys.has(key))
    || config.schemaVersion !== 1 || !Array.isArray(config.sources) || config.sources.length > 80) throw new Error('SOURCE_CONFIG');
  if (config.postUrls !== undefined && (!Array.isArray(config.postUrls) || config.postUrls.length > 40)) throw new Error('SOURCE_CONFIG');
  if (config.fields !== undefined && (!Array.isArray(config.fields) || config.fields.some(field => !fields.has(field)))) throw new Error('SOURCE_CONFIG');
  if (!Number.isInteger(config.perSourceLimit) || config.perSourceLimit < 1 || config.perSourceLimit > 30) throw new Error('SOURCE_LIMIT');
  const ids = new Set();
  for (const s of config.sources) {
    const sourceKeys = new Set(['id', 'field', 'kind', 'query', 'blogId', 'handle', 'label', 'url', 'upgradeHttp']);
    const httpsUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(key => !sourceKeys.has(key))
      || !/^[a-z0-9-]{1,60}$/.test(s.id) || ids.has(s.id) || !fields.has(s.field)
      || !['google_news_rss', 'naver_autocomplete', 'naver_blog_rss', ...SOCIAL_KINDS, 'rss_feed', ...Object.keys(ADAPTERS)].includes(s.kind)
      || (s.label !== undefined && (typeof s.label !== 'string' || s.label.length > 120))
      || (s.upgradeHttp !== undefined && (s.kind !== 'rss_feed' || typeof s.upgradeHttp !== 'boolean'))
      || (s.url !== undefined && s.kind !== 'rss_feed')
      || (s.kind === 'rss_feed' ? !httpsUrl(s.url)
        : Object.hasOwn(ADAPTERS, s.kind) ? false
          : s.kind === 'naver_blog_rss' ? !/^[a-zA-Z0-9_-]{2,40}$/.test(s.blogId || '')
            : ['x_public_profile', 'x_xhr_profile'].includes(s.kind) ? !/^[A-Za-z0-9_]{1,15}$/.test(s.handle || '')
              : s.kind === 'threads_xhr_profile' ? !/^[A-Za-z0-9_.]{1,30}$/.test(s.handle || '')
                : typeof s.query !== 'string' || !s.query.trim() || s.query.length > 100)) throw new Error('SOURCE_CONFIG');
    ids.add(s.id);
  }
  for (const post of config.postUrls || []) {
    if (!post || typeof post !== 'object' || Array.isArray(post)
      || Object.keys(post).some(key => !['id', 'field', 'url', 'label'].includes(key))
      || !/^[a-z0-9-]{1,60}$/.test(post.id) || ids.has(post.id) || !fields.has(post.field)
      || typeof post.url !== 'string' || post.url.length > 2048 || !post.url.startsWith('https://')
      || (post.label !== undefined && (typeof post.label !== 'string' || post.label.length > 120))) throw new Error('SOURCE_CONFIG');
    try { const url = new URL(post.url); if (url.username || url.password) throw new Error('SOURCE_CONFIG'); }
    catch { throw new Error('SOURCE_CONFIG'); }
    ids.add(post.id);
  }
}

export function withReferenceInbox(config, inbox) {
  validateConfig(config); validateConfig(inbox);
  if (inbox.sources.length) throw new Error('REFERENCE_INBOX_POST_URLS_ONLY');
  const merged = { ...config, postUrls: [...(config.postUrls || []), ...(inbox.postUrls || [])] };
  validateConfig(merged);
  return merged;
}

export async function collect(config, options = {}) {
  if (options && Object.hasOwn(options, 'coupangWowObservation'))
    throw Object.assign(new Error('COUPANG_WOW_OBSERVATION_HTTP_ONLY'), { code: 'COUPANG_WOW_OBSERVATION_HTTP_ONLY' });
  const { fetchImpl = globalThis.fetch, now = new Date(), xSessionLoader } = options;
  validateConfig(config);
  const checkedAt = now.toISOString();
  const candidates = []; const sources = []; const seen = new Map();
  for (const source of config.sources) {
    const sourceMeta = { id: source.id, field: source.field, kind: source.kind };
    try {
      let items, receipt;
      if (SOCIAL_KINDS.includes(source.kind)) {
        const result = await (source.kind === 'threads_xhr_profile' ? fetchThreadsXhr : fetchXXhr)(source.handle,
          config.perSourceLimit, { fetchImpl, ...(source.kind === 'threads_xhr_profile' ? {} : { sessionLoader: xSessionLoader }) });
        items = result.items; receipt = result.receipt;
      } else if (source.kind === 'rss_feed') {
        const result = await fetchFeed(source.url, { fetchImpl, limit: config.perSourceLimit, upgradeSameHostHttp: source.upgradeHttp === true });
        items = result.items.map(item => ({ ...item, publisher: item.publisher || source.label || null }));
        receipt = result.receipt;
      } else if (Object.hasOwn(ADAPTERS, source.kind)) {
        const adapterOptions = { fetchImpl };
        const result = await ADAPTERS[source.kind](config.perSourceLimit, adapterOptions);
        items = result.items; receipt = result.receipt;
      } else if (source.kind !== 'naver_autocomplete') {
        const url = new URL(source.kind === 'naver_blog_rss' ? `https://rss.blog.naver.com/${source.blogId}.xml` : 'https://news.google.com/rss/search');
        if (source.kind === 'google_news_rss') for (const [key, value] of Object.entries({ q: source.query, hl: 'ko', gl: 'KR', ceid: 'KR:ko' })) url.searchParams.set(key, value);
        const result = await fetchText(url, { fetchImpl, attempts: 1, timeoutMs: 12000, headers: { accept: 'application/rss+xml' } });
        assertStatus(result.response);
        if (Buffer.byteLength(result.text) > 2000000) throw new Error('SOURCE_TOO_LARGE');
        items = parseNews(result.text);
        if (source.kind === 'naver_blog_rss') items = items.filter(item => {
          const u = new URL(item.url);
          return u.origin === 'https://blog.naver.com' && u.pathname.startsWith(`/${source.blogId}/`);
        }).map(item => { const u = new URL(item.url); u.search = ''; return { ...item, url: u.href, publisher: source.label || source.blogId }; });
        receipt = { httpStatus: result.response.status, sourceUrl: url.href, responseSha256: hash(result.text), observedItems: items.length };
      } else {
        const result = await fetchAutocomplete(source.query, { fetchImpl });
        items = result.suggestions.map(x => ({ title: x.keyword, url: null }));
        receipt = { ...result.receipt, sourceUrl: 'https://ac.search.naver.com/nx/ac', observedItems: items.length };
      }
      let added = 0;
      for (let item of items.slice(0, config.perSourceLimit)) {
        const normalized = item.url ? inspectPostUrl(item.url) : null;
        if (normalized?.url) item = { ...item, url: normalized.url };
        const key = hash(item.url || `${source.field}:${item.title.normalize('NFKC').trim()}`);
        if (seen.has(key)) {
          const previous = seen.get(key);
          previous.sourceIds = [...new Set([...previous.sourceIds, source.id])];
          previous.fields = [...new Set([...previous.fields, source.field])].sort();
          previous.urls = [...new Set([...previous.urls, ...(item.url ? [item.url] : [])])].slice(0, 5);
          if ((item.summary || '').length > previous.summary.length) previous.summary = item.summary.slice(0, 1500);
          if (!previous.publisher && item.publisher) previous.publisher = item.publisher;
          continue;
        }
        const row = { id: key.slice(0, 24), field: source.field, fields: [source.field], title: item.title.slice(0, 300),
          summary: item.summary || '', urls: source.kind === 'daangn_side_hustle' ? item.urls : item.url ? [item.url] : [], sourceIds: [source.id],
          ...rowKind(source.kind),
          ...(item.sourceRecordIds ? { sourceRecordIds: item.sourceRecordIds } : {}),
          ...(item.ontologyRefs ? { ontologyRefs: item.ontologyRefs } : {}),
          ...(item.contentCoverage ? { contentCoverage: item.contentCoverage } : {}),
          ...(item.bodySha256 ? { bodyEvidence: { sha256: item.bodySha256, length: item.bodyLength, truncated: item.bodyTruncated === true } } : {}),
          ...(item.engagement ? { engagement: item.engagement, engagementCheckedAt: checkedAt, paidPartnership: item.paidPartnership } : {}),
          ...(item.signal ? { signal: item.signal } : {}),
          ...(item.deal ? { deal: item.deal } : {}),
          publisher: item.publisher || null, publishedAt: item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).toISOString() : null,
          collectedAt: checkedAt, originalArticleFetched: item.contentCoverage === 'full_document' && Boolean(item.bodySha256) && receipt?.liveReplay === true,
          claimsVerified: false };
        seen.set(key, row); candidates.push(row); added++;
      }
      sources.push({ ...sourceMeta, status: receipt.failures?.length || receipt.requestedLimitMet === false ?
        (items.length ? 'partial' : 'failed') : items.length ? 'collected' : 'empty', checkedAt, saved: added, ...receipt });
    } catch (error) { sources.push({ ...sourceMeta, status: 'failed', checkedAt, code: error.code || (/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'COLLECTION_FAILED') }); }
  }
  for (const post of config.postUrls || []) {
    const normalizedInput = inspectPostUrl(post.url);
    const canonicalInput = new URL(normalizedInput.url || post.url);
    if (!normalizedInput.url) canonicalInput.search = '';
    canonicalInput.hash = '';
    const sourceMeta = { id: post.id, field: post.field, kind: 'public_post_url', url: canonicalInput.href };
    try {
      const result = await fetchPublicPost(post.url, { fetchImpl });
      if (!['collected','partial'].includes(result.status)) {
        sources.push({ ...sourceMeta, status: 'unavailable', checkedAt, saved: 0, ...result.receipt });
        continue;
      }
      let added = 0;
      for (const item of result.items.slice(0, 1)) {
        const key = hash(item.url || `${post.field}:${item.title.normalize('NFKC').trim()}`);
        if (seen.has(key)) {
          const previous = seen.get(key);
          previous.sourceIds = [...new Set([...previous.sourceIds, post.id])];
          previous.fields = [...new Set([...previous.fields, post.field])].sort();
          previous.urls = [...new Set([...previous.urls, ...(item.url ? [item.url] : [])])].slice(0, 5);
          if ((item.summary || '').length > previous.summary.length) previous.summary = item.summary.slice(0, 1500);
          const coverageRank = { metadata_only: 0, preview: 1, post_text: 2, full_text: 2 };
          if ((coverageRank[item.contentCoverage] ?? -1) >= (coverageRank[previous.contentCoverage] ?? -1)) {
            previous.title = item.title.slice(0,300);
            previous.summary = item.summary || '';
            previous.contentCoverage = item.contentCoverage || 'unknown';
            previous.evidenceLevel = item.evidenceLevel;
            if (item.bodySha256) previous.bodyEvidence = { sha256: item.bodySha256, length: item.bodyLength, truncated: item.bodyTruncated };
            previous.originalArticleFetched = result.receipt.postContentValidated === true && !['preview','metadata_only'].includes(item.contentCoverage);
            if (item.publishedAt) {
              previous.publishedAt = item.publishedAt;
              previous.publishedAtText = item.publishedAtText || null;
              previous.publishedAtPrecision = item.publishedAtPrecision || 'unknown';
            }
          }
          if (item.publisher) previous.publisher = item.publisher;
          if (item.engagement) { previous.engagement = item.engagement; previous.engagementCheckedAt = checkedAt; }
          if (item.format) previous.format = item.format;
          continue;
        }
        const row = { id: key.slice(0, 24), field: post.field, fields: [post.field], title: item.title.slice(0, 300),
          summary: item.summary || '', urls: item.url ? [item.url] : [], sourceIds: [post.id], sourceKind: item.sourceKind || 'public_social_post',
          publisher: item.publisher || null, contentCoverage: item.contentCoverage || 'unknown',
          ...(item.engagement ? { engagement: item.engagement, engagementCheckedAt: checkedAt } : {}),
          ...(item.format ? { format: item.format } : {}),
          evidenceLevel: item.evidenceLevel, bodyEvidence: item.bodySha256 ? { sha256: item.bodySha256, length: item.bodyLength, truncated: item.bodyTruncated } : null,
          publishedAt: item.publishedAtPrecision === 'day' ? item.publishedAt : item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).toISOString() : null,
          publishedAtText: item.publishedAtText || null, publishedAtPrecision: item.publishedAtPrecision || (item.publishedAt ? 'instant' : 'unknown'),
          collectedAt: checkedAt, originalArticleFetched: result.receipt.postContentValidated === true && !['preview','metadata_only'].includes(item.contentCoverage), claimsVerified: false };
        seen.set(key, row); candidates.push(row); added++;
      }
      sources.push({ ...sourceMeta, status: result.items.length ? result.status : 'empty', checkedAt, saved: added, ...result.receipt });
    } catch (error) {
      sources.push({ ...sourceMeta, status: 'unavailable', checkedAt, saved: 0,
        code: error.code || (/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'POST_READ_UNAVAILABLE'),
        collectionMethod: 'public_permalink_http', browserUsed: false, credentialsUsed: false, readerReturnedContent: false });
    }
  }
  return { schemaVersion: 1, kind: 'content_collection', checkedAt, runId: checkedAt.replace(/[^0-9]/g, ''),
    configSha256: hash(JSON.stringify(config)), sources, candidates,
    coverage: Object.fromEntries([...fields].map(field => [field, candidates.filter(x => x.fields.includes(field)).length])),
    policy: { publicOnly: true, credentialMaterialInCollection: false,
      credentialPersistence: 'windows_dpapi_current_user', fullArticleCrawl: false } };
}

export async function main(args) {
  const [configPath, output, ...rest] = args;
  if (!configPath || !output) throw new Error('Use collect.mjs CONFIG_JSON NEW_OUTPUT_JSON');
  if (rest.some(option => option === '--coupang-wow-observation'
    || option.startsWith('--coupang-wow-observation=')))
    throw Object.assign(new Error('COUPANG_WOW_OBSERVATION_HTTP_ONLY'), { code: 'COUPANG_WOW_OBSERVATION_HTTP_ONLY' });
  let config = JSON.parse(await readFile(configPath, 'utf8'));
  let inboxFile = null;
  for (const option of rest) {
    if (option.startsWith('--inbox=') && inboxFile === null) inboxFile = option.slice('--inbox='.length);
    else throw new Error('COLLECTION_OPTION');
  }
  if (inboxFile !== null) {
    config = withReferenceInbox(config, JSON.parse(await readFile(inboxFile, 'utf8')));
  }
  validateConfig(config);
  const target = path.resolve(output);
  try { await lstat(target); throw new Error('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = await lstat(path.dirname(target));
  if (!parent.isDirectory()) throw new Error('OUTPUT_PARENT_INVALID');
  const record = await collect(config);
  await writeFile(target, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: target, coverage: record.coverage, sources: record.sources.map(s => ({ id: s.id, status: s.status, saved: s.saved })) }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(() => { console.error('COLLECTION_FAILED'); process.exitCode = 1; });
