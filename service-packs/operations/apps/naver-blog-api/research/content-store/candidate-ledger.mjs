import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The ledger is the cross-run memory of the collector: one entry per candidate, with when it was
// first and last seen, every disposition it received and which existing post it may collide with.
// Each collection batch stays a fresh, immutable file; only this ledger accumulates.
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const unique = values => [...new Set(values.filter(Boolean))];
const DORMANT_DAYS = 14;
const TREND_WINDOW_MS = 72 * 60 * 60 * 1000;

export function groupEvidenceKinds(sourceIds = [], sourceKinds = []) {
  const ids = Array.isArray(sourceIds) ? sourceIds.filter(id => typeof id === 'string') : [];
  const kinds = new Set(Array.isArray(sourceKinds) ? sourceKinds : []);
  const grouped = new Set();
  for (const id of ids) {
    if (id.startsWith('official-') || id.startsWith('watch-')) grouped.add('official');
    if (id.startsWith('creator-')) grouped.add('creator');
    if (id.startsWith('news-')) grouped.add('news');
    if (id.startsWith('intent-') || id.startsWith('seed:')) grouped.add('search_signal');
    if (id.startsWith('community-')) grouped.add('community');
    if (id.startsWith('papers-')) grouped.add('papers');
    if (id.startsWith('realtime-')) grouped.add('realtime');
    if (id.startsWith('seller-')) grouped.add('seller');
  }
  // Row kinds only classify rows whose source ids are unrecognized. Adding them on top would count
  // one source twice (realtime-kr-signal rows also carry sourceKind search_signal).
  if (!grouped.size) {
    if (kinds.has('search_signal')) grouped.add('search_signal');
    if (kinds.has('community')) grouped.add('community');
  }
  return [...grouped];
}

export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = ''; url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

// Search signals keep their keyword as identity so enrichment cannot fork the same keyword into a second entry.
export function ledgerIdFor(candidate) {
  const row = candidate || {};
  const sourceKinds = Array.isArray(row.sourceKinds) ? row.sourceKinds : [];
  const isSignal = row.sourceKind === 'search_signal' || sourceKinds.includes('search_signal') || /^autocomplete/.test(row.evidenceLevel || '');
  const url = isSignal ? null : (Array.isArray(row.urls) ? row.urls : []).map(canonicalUrl).find(Boolean);
  return createHash('sha256').update(url ? `url:${url}` : `title:${normalize(row.title)}`).digest('hex').slice(0, 24);
}

export function emptyLedger(now = new Date()) {
  return { schemaVersion: 1, kind: 'candidate_ledger', createdAt: now.toISOString(), updatedAt: now.toISOString(), observations: [], entries: {},
    policy: { advisoryOnly: true, publicationReady: false, semanticDuplicateDetection: false, priorityIsResearchOrderNotApproval: true } };
}

// An enriched file is the same observation as the collection it was derived from, so it carries the
// collection's timestamp and never counts as a second sighting.
const observationRows = (record, kind) => (Array.isArray(record?.candidates) ? record.candidates : [])
  .map(row => ({ row, kind, at: kind === 'enriched' ? record.inputCheckedAt || record.checkedAt : record.checkedAt }));

export function priorityFor(entry, now) {
  const reasons = [];
  let score = 0;
  if (entry.sourceIds.some(id => /^official-/.test(id))) { score += 3; reasons.push('official_source'); }
  else if (entry.sourceIds.some(id => /^watch-/.test(id))) { score += 2; reasons.push('tracked_topic_source'); }
  else if (entry.sourceIds.some(id => /^creator-/.test(id))) { score += 1; reasons.push('tracked_creator_source'); }
  if (entry.urls.length) { score += 2; reasons.push('has_source_url'); } else { score -= 2; reasons.push('no_source_url'); }
  const published = entry.publishedAt ? Date.parse(entry.publishedAt) : NaN;
  if (Number.isFinite(published) && now.getTime() - published <= 3 * 86400000) { score += 2; reasons.push('published_within_3_days'); }
  if (entry.seenCount >= 2) { score += Math.min(entry.seenCount - 1, 3); reasons.push(`recurring_${entry.seenCount}_observations`); }
  if (entry.sourceIds.length >= 2) { score += 1; reasons.push('multiple_sources'); }
  if (entry.convergence) { score += 2; reasons.push('cross_source_convergence'); }
  if (entry.velocity >= 2) { score += 1; reasons.push('accelerating'); }
  const demandScore = Number(entry.demand?.searchTrend?.score);
  if (entry.demand?.searchTrend && Number.isFinite(demandScore)) {
    score += demandScore >= 75 ? 3 : demandScore >= 40 ? 2 : 1;
    reasons.push('search_demand_signal');
  }
  if (entry.existingPostLogNo || entry.possibleExistingPostLogNo) { score -= 5; reasons.push('existing_post_collision_review_first'); }
  if (entry.lastDisposition === 'exclude') { score -= 10; reasons.push('last_disposition_exclude'); }
  return { score, reasons, advisoryOnly: true };
}

const normalizeDemandKeyword = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\s]+/gu, '');
const trendScore = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

function trendSignals(latest) {
  const signals = [];
  const checkedAt = typeof latest?.checkedAt === 'string' ? latest.checkedAt : null;
  for (const trend of Array.isArray(latest?.shoppingTrends) ? latest.shoppingTrends : []) {
    if (typeof trend?.keyword !== 'string') continue;
    const horizons = (Array.isArray(trend.categories) ? trend.categories : [])
      .flatMap(category => Object.entries(category?.horizons || {}))
      .filter(([, value]) => value?.score !== null && value?.score !== undefined && Number.isFinite(Number(value.score)));
    const horizonOrder = { date: 0, week: 1, month: 2 };
    horizons.sort(([a, av], [b, bv]) => Number(bv.score) - Number(av.score)
      || (horizonOrder[a] ?? 99) - (horizonOrder[b] ?? 99));
    const score = trendScore(trend.score) ?? (horizons.length ? Number(horizons[0][1].score) : null);
    if (score !== null) signals.push({ keyword: trend.keyword, score, source: 'naver_shopping_insight',
      horizon: horizons[0]?.[0] || null, checkedAt });
  }

  for (const expansion of Array.isArray(latest?.seedExpansions) ? latest.seedExpansions : []) {
    const suggestions = Array.isArray(expansion?.suggestions) ? expansion.suggestions : [];
    for (const suggestion of suggestions) {
      if (typeof suggestion?.keyword !== 'string') continue;
      const score = trendScore(suggestion.opportunityScore) ?? trendScore(suggestion.inheritedShoppingScore);
      if (score !== null) signals.push({ keyword: suggestion.keyword, score, source: 'autocomplete', horizon: null, checkedAt });
    }
    if (typeof expansion?.seed === 'string') {
      const seedScore = suggestions.map(row => trendScore(row?.inheritedShoppingScore) ?? trendScore(row?.opportunityScore))
        .filter(value => value !== null).sort((a, b) => b - a)[0];
      if (seedScore !== undefined) signals.push({ keyword: expansion.seed, score: seedScore,
        source: 'autocomplete', horizon: null, checkedAt });
    }
  }

  for (const opportunity of Array.isArray(latest?.longTailOpportunities) ? latest.longTailOpportunities : []) {
    if (typeof opportunity?.keyword !== 'string') continue;
    const score = trendScore(opportunity.opportunityScore) ?? trendScore(opportunity.inheritedShoppingScore);
    if (score !== null) signals.push({ keyword: opportunity.keyword, score, source: 'autocomplete', horizon: null, checkedAt });
  }

  for (const trending of Array.isArray(latest?.googleTrending) ? latest.googleTrending : []) {
    if (typeof trending?.keyword !== 'string') continue;
    const score = trendScore(trending.approxTraffic) ?? trendScore(trending.score);
    if (score !== null) signals.push({ keyword: trending.keyword, score, source: 'google_trending', horizon: null, checkedAt });
  }
  return signals.map(signal => ({ ...signal, normalizedKeyword: normalizeDemandKeyword(signal.keyword) }))
    .filter(signal => signal.normalizedKeyword.length >= 2);
}

function strongestDemandMatch(entry, signals) {
  const candidateTexts = [entry.title, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
    .map(normalizeDemandKeyword).filter(value => value.length >= 2);
  const matches = signals.filter(signal => candidateTexts.some(text => text.includes(signal.normalizedKeyword)));
  matches.sort((a, b) => b.score - a.score || b.normalizedKeyword.length - a.normalizedKeyword.length
    || a.keyword.localeCompare(b.keyword, 'ko'));
  if (!matches.length) return null;
  const { normalizedKeyword, ...match } = matches[0];
  return match;
}

export function updateLedger(previous, inputs, { now = new Date() } = {}) {
  if (previous && (previous.schemaVersion !== 1 || previous.kind !== 'candidate_ledger' || typeof previous.entries !== 'object')) throw new Error('LEDGER_SCHEMA');
  const ledger = previous ? structuredClone(previous) : emptyLedger(now);
  const before = new Set(Object.keys(ledger.entries));
  const observedNow = new Set();
  const rows = [
    ...observationRows(inputs.collection, 'collection'),
    ...observationRows(inputs.enriched, 'enriched'),
    ...(Array.isArray(inputs.report?.results) ? inputs.report.results : []).map(row => ({ row, kind: 'report', at: inputs.report.checkedAt })),
    ...(Array.isArray(inputs.queue?.candidates) ? inputs.queue.candidates : []).map(row => ({ row, kind: 'queue', at: inputs.queue.createdAt })),
  ];
  if (!rows.length) throw new Error('LEDGER_INPUT_REQUIRED');
  const demandSignals = inputs.trends ? trendSignals(inputs.trends) : null;
  for (const { row, kind, at } of rows) {
    if (!row || typeof row.title !== 'string' || !normalize(row.title) || !Number.isFinite(Date.parse(at))) continue;
    const id = ledgerIdFor(row);
    const entry = ledger.entries[id] ??= { ledgerId: id, title: row.title.slice(0, 300), fields: [], urls: [], sourceIds: [], sourceKinds: [], aliases: [],
      publisher: null, publishedAt: null, firstSeenAt: at, lastSeenAt: at, seenCount: 0, observedAt: [], dispositions: [], lastDisposition: null,
      existingPostLogNo: null, possibleExistingPostLogNo: null, linkedRunIds: [] };
    entry.fields = unique([...entry.fields, row.field, ...(row.fields || [])]);
    entry.urls = unique([...entry.urls, ...(row.urls || []).map(canonicalUrl)]).slice(0, 10);
    entry.sourceIds = unique([...entry.sourceIds, ...(row.sourceIds || [])]).slice(0, 40);
    entry.sourceKinds = unique([...entry.sourceKinds, row.sourceKind, ...(row.sourceKinds || [])]);
    entry.aliases = unique([...entry.aliases, row.id, row.candidateId, ...(row.aliases || []), normalize(row.title)]).slice(0, 20);
    entry.publisher ||= row.publisher || null;
    entry.publishedAt ||= row.publishedAt && Number.isFinite(Date.parse(row.publishedAt)) ? row.publishedAt : null;
    if (/^\d{6,}$/.test(String(row.existingPostLogNo || ''))) entry.existingPostLogNo = String(row.existingPostLogNo);
    if (/^\d{6,}$/.test(String(row.possibleExistingPostLogNo || ''))) entry.possibleExistingPostLogNo ||= String(row.possibleExistingPostLogNo);
    if (kind === 'collection' || kind === 'enriched') {
      if (!entry.observedAt.includes(at)) entry.observedAt.push(at);
      entry.seenCount = entry.observedAt.length;
      if (at < entry.firstSeenAt) entry.firstSeenAt = at;
      if (at > entry.lastSeenAt) entry.lastSeenAt = at;
      observedNow.add(id);
    }
    if (kind === 'report' && row.disposition && !entry.dispositions.some(d => d.checkedAt === at)) {
      entry.dispositions.push({ checkedAt: at, disposition: row.disposition, adoptedCategory: row.category || 'unknown',
        suggestedCategory: row.suggestedCategory || null, reasons: unique(row.reasons || []) });
      entry.dispositions.sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
      entry.lastDisposition = entry.dispositions.at(-1).disposition;
    }
    if (inputs.runId && !entry.linkedRunIds.includes(inputs.runId)) entry.linkedRunIds.push(inputs.runId);
  }
  const existing = new Map();
  for (const post of inputs.existingPosts?.posts || []) if (/^\d{6,}$/.test(String(post.logNo || '')) && normalize(post.title)) existing.set(normalize(post.title), String(post.logNo));
  const aliasOwners = new Map();
  for (const entry of Object.values(ledger.entries)) if (entry.existingPostLogNo) for (const alias of entry.aliases) aliasOwners.set(alias, entry.existingPostLogNo);
  const delta = { runAt: now.toISOString(), runId: inputs.runId || null, added: [], recurring: [], dormant: [], collidingWithExisting: [], observed: observedNow.size };
  for (const entry of Object.values(ledger.entries)) {
    if (!entry.existingPostLogNo) {
      const hit = existing.get(normalize(entry.title)) || aliasOwners.get(normalize(entry.title));
      if (hit) entry.possibleExistingPostLogNo = hit;
    }
    const evidenceKinds = groupEvidenceKinds(entry.sourceIds, entry.sourceKinds);
    entry.sourceKindCount = evidenceKinds.length;
    entry.convergence = evidenceKinds.length >= 2;
    const observationTimes = [...new Set((Array.isArray(entry.observedAt) ? entry.observedAt : [])
      .map(at => Date.parse(at)).filter(Number.isFinite))];
    const recentStart = now.getTime() - TREND_WINDOW_MS;
    const recentCount = observationTimes.filter(at => at >= recentStart && at <= now.getTime()).length;
    const earlierCount = observationTimes.filter(at => at >= recentStart - TREND_WINDOW_MS && at < recentStart).length;
    entry.velocity = earlierCount ? recentCount / earlierCount : null;
    const firstSeen = Date.parse(entry.firstSeenAt);
    entry.newInWindow = Number.isFinite(firstSeen) && firstSeen >= recentStart && firstSeen <= now.getTime();
    const demand = entry.demand && typeof entry.demand === 'object' && !Array.isArray(entry.demand) ? entry.demand : {};
    if (demandSignals) {
      const match = strongestDemandMatch(entry, demandSignals);
      entry.demand = { ...demand,
        searchTrend: match,
        source: match ? inputs.trendSource || null : null,
      };
    } else {
      entry.demand = { ...demand, searchTrend: demand.searchTrend ?? null, source: demand.source ?? null };
    }
    const dormant = now.getTime() - Date.parse(entry.lastSeenAt) > DORMANT_DAYS * 86400000;
    entry.status = observedNow.has(entry.ledgerId) && !before.has(entry.ledgerId) ? 'new'
      : dormant ? 'dormant' : entry.seenCount >= 2 ? 'recurring' : 'seen_once';
    entry.priority = priorityFor(entry, now);
    if (entry.status === 'new') delta.added.push(entry.ledgerId);
    if (entry.status === 'recurring' && observedNow.has(entry.ledgerId)) delta.recurring.push(entry.ledgerId);
    if (entry.status === 'dormant') delta.dormant.push(entry.ledgerId);
    if (entry.existingPostLogNo || entry.possibleExistingPostLogNo) delta.collidingWithExisting.push(entry.ledgerId);
  }
  delta.top = Object.values(ledger.entries).filter(entry => entry.status !== 'dormant' && entry.lastDisposition !== 'exclude')
    .sort((a, b) => b.priority.score - a.priority.score || b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 20).map(entry => entry.ledgerId);
  const reportRow = id => {
    const entry = ledger.entries[id];
    return { ledgerId: entry.ledgerId, title: entry.title, status: entry.status, priority: structuredClone(entry.priority),
      seenCount: entry.seenCount, lastDisposition: entry.lastDisposition,
      existingPostLogNo: entry.existingPostLogNo || entry.possibleExistingPostLogNo || null, urlCount: entry.urls.length };
  };
  delta.rows = {
    top: delta.top.map(reportRow), added: delta.added.map(reportRow), recurring: delta.recurring.map(reportRow),
    dormant: delta.dormant.map(reportRow), collidingWithExisting: delta.collidingWithExisting.map(reportRow),
    observed: [...observedNow].map(reportRow),
  };
  ledger.updatedAt = now.toISOString();
  ledger.observations.push({ at: now.toISOString(), runId: inputs.runId || null, inputs: Object.keys(inputs).filter(key => inputs[key] && key !== 'runId'),
    existingPostsChecked: existing.size, added: delta.added.length, observed: observedNow.size });
  ledger.observations = ledger.observations.slice(-200);
  return { ledger, delta };
}

function baseDeltaMarkdown(ledger, delta) {
  const safe = value => String(value ?? '').replace(/[|\r\n]/g, ' ').slice(0, 120);
  const row = id => { const e = ledger.entries[id]; return `| ${safe(e.title)} | ${e.status} | ${e.priority.score} | ${e.seenCount} | ${e.lastDisposition || '-'} | ${e.existingPostLogNo || e.possibleExistingPostLogNo || '-'} | ${e.urls.length} | ${e.ledgerId} |`; };
  return ['# 글감 대장 변화', '', `실행: ${delta.runAt}. 관측 ${delta.observed}건 · 신규 ${delta.added.length} · 재등장 ${delta.recurring.length} · 휴면 ${delta.dormant.length} · 기존 글 충돌 ${delta.collidingWithExisting.length}. 전체 대장 ${Object.keys(ledger.entries).length}건.`, '',
    '우선순위는 출처 직접성·URL 유무·최신성·재등장 횟수·수요 신호를 반영하는 조사 순서이며 발행 승인이나 검색량이 아닙니다. 수요 점수는 검색량 추정치가 아닌 관측된 관심 신호 점수입니다. 의미 중복은 자동 판정하지 않습니다.', '',
    '## 조사 우선순위 상위', '', '| 글감 | 상태 | 점수 | 관측 | 최근 판정 | 기존 글 | URL | ledgerId |', '|---|---|---:|---:|---|---|---:|---|', ...delta.top.map(row), '',
    '## 이번 실행 신규', '', ...(delta.added.length ? ['| 글감 | 상태 | 점수 | 관측 | 최근 판정 | 기존 글 | URL | ledgerId |', '|---|---|---:|---:|---|---|---:|---|', ...delta.added.map(row)] : ['신규 없음']), ''].join('\n');
}

export function deltaMarkdown(ledger, delta) {
  const safe = value => String(value ?? '').replace(/[|\r\n]/g, ' ').slice(0, 120);
  const trends = Object.values(ledger.entries).filter(entry => entry.convergence || entry.velocity >= 2)
    .sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0) || b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 15);
  const rows = trends.map(entry => {
    const signals = [entry.convergence && 'cross_source_convergence', entry.velocity >= 2 && 'accelerating'].filter(Boolean).join(', ');
    const velocity = entry.velocity == null ? '-' : String(Number(entry.velocity.toFixed(2)));
    return '| ' + safe(entry.title) + ' | ' + signals + ' | ' + (entry.sourceKindCount ?? 0) + ' | ' + velocity + ' | ' + entry.ledgerId + ' |';
  });
  const table = [
    '## Trend signals', '',
    '| Candidate | Signals | Evidence kinds | Velocity | ledgerId |',
    '|---|---|---:|---:|---|',
    ...(rows.length ? rows : ['| None | - | - | - | - |']),
  ].join('\n');
  return baseDeltaMarkdown(ledger, delta) + '\n\n' + table;
}

export function buildIdMap(inputs = {}, now = new Date()) {
  const queueCandidateIds = {};
  const collectionItemIds = {};
  const mappings = [];
  for (const row of Array.isArray(inputs.queue?.candidates) ? inputs.queue.candidates : []) {
    if (typeof row?.candidateId !== 'string' || !row.candidateId || typeof row.title !== 'string' || !normalize(row.title)) continue;
    const ledgerId = ledgerIdFor(row);
    queueCandidateIds[row.candidateId] = ledgerId;
    mappings.push({ kind: 'queue_candidate', id: row.candidateId, ledgerId });
  }
  const collectionRows = [
    ...(Array.isArray(inputs.collection?.candidates) ? inputs.collection.candidates : []),
    ...(Array.isArray(inputs.collection?.items) ? inputs.collection.items : []),
  ];
  for (const row of collectionRows) {
    if (typeof row?.id !== 'string' || !row.id || typeof row.title !== 'string' || !normalize(row.title)) continue;
    const ledgerId = ledgerIdFor(row);
    collectionItemIds[row.id] = ledgerId;
    mappings.push({ kind: 'collection_item', id: row.id, ledgerId });
  }
  return { schemaVersion: 1, createdAt: now.toISOString(), queueCandidateIds, collectionItemIds, mappings };
}

export async function run(args = process.argv.slice(2)) {
  const options = {};
  for (const arg of args) {
    const match = /^--(ledger|out|collection|enriched|report|queue|existing-posts|run-id|trends)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('LEDGER_OPTION');
    options[match[1]] = match[2];
  }
  if (!options.ledger || !options.out) throw new Error('LEDGER_PATHS_REQUIRED');
  const read = async key => options[key] ? JSON.parse(await readFile(path.resolve(options[key]), 'utf8')) : null;
  const inputs = { collection: await read('collection'), enriched: await read('enriched'), report: await read('report'), queue: await read('queue'),
    existingPosts: await read('existing-posts'), trends: await read('trends'), trendSource: options.trends || null, runId: options['run-id'] || null };
  if (inputs.runId && !/^[A-Za-z0-9._-]{1,80}$/.test(inputs.runId)) throw new Error('LEDGER_RUN_ID');
  const ledgerPath = path.resolve(options.ledger);
  let previous = null;
  try { previous = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const now = new Date();
  const { ledger, delta } = updateLedger(previous, inputs, { now });
  const idMap = buildIdMap(inputs, now);
  const out = path.resolve(options.out);
  await mkdir(out);
  if (previous) await writeFile(path.join(out, 'ledger-before.json'), JSON.stringify(previous, null, 2) + '\n', { flag: 'wx' });
  const serialized = JSON.stringify(ledger, null, 2) + '\n';
  await writeFile(path.join(out, 'ledger-after.json'), serialized, { flag: 'wx' });
  await writeFile(path.join(out, 'delta.json'), JSON.stringify(delta, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(out, 'delta.md'), deltaMarkdown(ledger, delta), { flag: 'wx' });
  await writeFile(path.join(out, 'id-map.json'), JSON.stringify(idMap, null, 2) + '\n', { flag: 'wx' });
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const temp = `${ledgerPath}.tmp-${process.pid}`;
  await writeFile(temp, serialized, { flag: 'wx' });
  await rename(temp, ledgerPath);
  console.log(JSON.stringify({ ledger: ledgerPath, out, entries: Object.keys(ledger.entries).length, observed: delta.observed, added: delta.added.length,
    recurring: delta.recurring.length, dormant: delta.dormant.length, collidingWithExisting: delta.collidingWithExisting.length, publicationReady: 0 }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  run().catch(error => { console.error(/^[A-Z_]+$/.test(error?.message || '') ? error.message : 'LEDGER_FAILED'); process.exitCode = 2; });
