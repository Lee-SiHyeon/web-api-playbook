#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectMolitNotices } from './molit-notices.mjs';
import { collectPolicyBriefings } from './policy-briefing.mjs';
import { collectShNotices } from './sh-notices.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_NOTICE_SOURCE_IDS = Object.freeze(['molit-notices', 'policy-briefing', 'sh-notices']);
const SOURCE_IDS = PUBLIC_NOTICE_SOURCE_IDS;
const DEFAULT_SOURCE_IDS = Object.freeze(['policy-briefing', 'sh-notices']);
const DEFAULT_BOUNDS = Object.freeze({ limit: 12, maxPages: 1, detailLimit: 1 });
const USABLE_READ_STATUSES = new Set(['read', 'success', 'ok', 'partial', 'request_budget_exhausted']);

// Normal runs omit the registered MOLIT redirect-blocked source. A deliberate
// one-source diagnostic can be requested with `--molit` or `sources:['molit-notices']`;
// callers may deliberately include it with `includeMolit: true` after new evidence.

function safeCode(error) {
  const code = error?.code || error?.message;
  return typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : 'COLLECTION_FAILED';
}

function normalizedReceipt(value, count) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, status: 'failed', count, error: 'RECEIPT_MISSING' };
  }
  const receipt = { ...value };
  // Readers may use either `ok` or a textual status. Preserve the observed
  // receipt while ensuring an empty list cannot conceal a failed request.
  if (typeof receipt.ok !== 'boolean' && typeof receipt.status !== 'string') {
    return { ...receipt, ok: false, status: 'failed', count, error: 'RECEIPT_STATUS_MISSING' };
  }
  const status = String(receipt.status || '').toLowerCase();
  const hardFailure = ['failed', 'error', 'blocked', 'redirect_blocked', 'challenge_blocked', 'login_required',
    'layout_changed', 'response_invalid', 'fetch_error'].includes(status);
  if (typeof receipt.ok === 'boolean') {
    // A parser may return usable rows while also marking the collection partial.
    // Keep those two facts distinct instead of erasing the partial usable read.
    if (hardFailure) receipt.ok = false;
  } else if (hardFailure) receipt.ok = false;
  else if (['ok', 'success', 'read', 'partial'].includes(status)) receipt.ok = status !== 'partial';
  receipt.status ||= receipt.ok ? 'success' : 'failed';
  receipt.count ??= count;
  return receipt;
}

function isNoticeItem(item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    && ['id', 'title', 'url', 'publishedAt', 'summary', 'rawLabels'].every(key => Object.hasOwn(item, key))
    && typeof item.id === 'string' && item.id.length > 0
    && typeof item.title === 'string' && item.title.length > 0
    && (item.url === null || (typeof item.url === 'string' && item.url.length > 0))
    && (Array.isArray(item.rawLabels) || (item.rawLabels && typeof item.rawLabels === 'object'))
    && typeof item.source === 'string' && item.source.length > 0;
}

/** Expected registered skips do not fail a run; selected reads still need usable items and clean receipts. */
export function noticeCollectionCanExitZero(collection) {
  const requested = collection?.requestedSources;
  if (!Array.isArray(requested) || requested.length === 0) return false;
  const selected = requested.map(source => collection.sources?.[source]);
  if (selected.some(result => !result || !Array.isArray(result.items) || !result.receipt)) return false;
  const readable = result => result.receipt.ok === true
    && USABLE_READ_STATUSES.has(String(result.receipt.status || '').toLowerCase());
  return selected.every(readable) && selected.some(result => readable(result) && result.items.length > 0);
}

function explicitShHousingFact(item) {
  const facts = item?.housingFacts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null;
  // The notice title is a directly observed source field and can name the
  // notice; the housingFacts gate below proves the detail itself is housing.
  const name = typeof facts.name === 'string' ? facts.name.trim() : String(item?.title ?? '').trim();
  const noticeId = facts.noticeId ?? item.id;
  const explicitDate = facts.recruitmentAnnouncementDate ?? facts.applicationStart ?? facts.applicationEnd ?? facts.winnerAnnouncementDate;
  // A title/publication date alone never makes an item housing. Require a
  // detail fact with a date printed under a housing schedule label.
  if (!name || !item.source || !noticeId || !explicitDate) return null;
  const applicationStart = facts.applicationStart ?? facts.receiptStart ?? null;
  const applicationEnd = facts.applicationEnd ?? facts.receiptEnd ?? null;
  return {
    source: item.source,
    noticeId: String(noticeId),
    name,
    region: typeof facts.region === 'string' ? facts.region : null,
    publishedAt: item.publishedAt ?? null,
    announcedAt: facts.recruitmentAnnouncementDate ?? facts.announcedAt ?? null,
    receiptStart: applicationStart,
    receiptEnd: applicationEnd,
    winnerDate: facts.winnerAnnouncementDate ?? null,
    winnerAnnouncementStatus: facts.winnerAnnouncementStatus ?? null,
    totalUnits: facts.supplyUnits?.total != null && Number.isFinite(Number(facts.supplyUnits.total)) ? Number(facts.supplyUnits.total) : null,
    url: item.url,
    housingFacts: { ...facts }
  };
}

/**
 * Read the three anonymous public notice sources with small, explicit limits.
 * Each result and receipt remains source-scoped; policy briefings are kept
 * separate from application notices and SH housing dates are never inferred.
 */
export async function collectPublicNotices({
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  limit = DEFAULT_BOUNDS.limit,
  maxPages = DEFAULT_BOUNDS.maxPages,
  detailLimit = DEFAULT_BOUNDS.detailLimit,
  collectors = {},
  includeMolit = false,
  sources = null
} = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const at = date.toISOString();
  const options = { fetchImpl, now: date, limit, maxPages, detailLimit };
  if (typeof includeMolit !== 'boolean') {
    throw Object.assign(new Error('SOURCE_SELECTION_INVALID'), { code: 'SOURCE_SELECTION_INVALID' });
  }
  if (sources != null && !Array.isArray(sources)) {
    throw Object.assign(new Error('SOURCE_SELECTION_INVALID'), { code: 'SOURCE_SELECTION_INVALID' });
  }
  const requested = sources == null
    ? [...DEFAULT_SOURCE_IDS, ...(includeMolit ? ['molit-notices'] : [])]
    : [...new Set(sources)];
  if (!Array.isArray(requested) || !requested.length || requested.some(source => !SOURCE_IDS.includes(source))) {
    throw Object.assign(new Error('SOURCE_SELECTION_INVALID'), { code: 'SOURCE_SELECTION_INVALID' });
  }
  const configured = {
    'molit-notices': collectors['molit-notices'] ?? collectMolitNotices,
    'policy-briefing': collectors['policy-briefing'] ?? collectPolicyBriefings,
    'sh-notices': collectors['sh-notices'] ?? collectShNotices
  };
  const results = {};
  for (const source of SOURCE_IDS) {
    if (!requested.includes(source)) {
      const blockedMolit = source === 'molit-notices' && sources == null && !includeMolit;
      results[source] = {
        source,
        items: [],
        receipt: blockedMolit
          ? { ok: false, status: 'skipped', count: 0, error: 'MOLIT_PUBLIC_REDIRECT_BLOCKED', registeredBlocked: true,
            autoRetry: false, manualOptIn: '--molit' }
          : { ok: false, status: 'skipped', count: 0, error: 'NOT_REQUESTED_MANUALLY' }
      };
      continue;
    }
    try {
      const result = await configured[source](options);
      if (!result || typeof result !== 'object' || !Array.isArray(result.items)) {
        results[source] = {
          source,
          items: [],
          receipt: { ok: false, status: 'failed', count: 0, error: 'COLLECTOR_RESULT_INVALID' }
        };
        continue;
      }
      const items = result.items.filter(isNoticeItem);
      const receipt = normalizedReceipt(result.receipt, items.length);
      if (items.length !== result.items.length) {
        receipt.ok = false;
        receipt.status = 'partial';
        receipt.invalidItemCount = result.items.length - items.length;
        receipt.itemError = 'ITEM_SCHEMA_INVALID';
      }
      results[source] = { source: result.source || source, items, receipt };
    } catch (error) {
      const carriedReceipt = error?.receipt && typeof error.receipt === 'object' && !Array.isArray(error.receipt)
        ? { ...error.receipt, ok: false, status: error.receipt.status || 'failed', error: safeCode(error) }
        : { ok: false, status: 'failed', count: 0, error: safeCode(error) };
      results[source] = {
        source,
        items: [],
        receipt: carriedReceipt
      };
    }
  }

  const policyArticles = results['policy-briefing'].items;
  const shHousing = results['sh-notices'].items.map(explicitShHousingFact).filter(Boolean);
  const items = SOURCE_IDS.flatMap(source => results[source].items);
  const receipts = Object.fromEntries(SOURCE_IDS.map(source => [source, results[source].receipt]));
  const failed = requested.filter(source => !receipts[source].ok && receipts[source].status !== 'skipped');
  const skipped = SOURCE_IDS.filter(source => receipts[source].status === 'skipped');
  const partial = SOURCE_IDS.filter(source => ['partial', 'request_budget_exhausted'].includes(String(receipts[source].status || '').toLowerCase()));
  const anyUsableItems = requested.some(source => receipts[source].ok === true && results[source].items.length > 0);
  const status = failed.length === requested.length ? 'failed' : (failed.length || skipped.length || partial.length || !anyUsableItems ? 'partial' : 'success');
  return {
    schemaVersion: 1,
    checkedAt: at,
    status,
    snapshotComplete: status === 'success',
    sources: results,
    receipts,
    items,
    policyArticles,
    shHousing,
    failures: failed,
    skipped,
    partialSources: partial,
    requestedSources: requested
  };
}

async function main() {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const out = arg('out');
  if (!out) throw Object.assign(new Error('OUT_REQUIRED'), { code: 'OUT_REQUIRED' });
  const limit = Number(arg('limit') ?? DEFAULT_BOUNDS.limit);
  const maxPages = Number(arg('max-pages') ?? DEFAULT_BOUNDS.maxPages);
  const detailLimit = Number(arg('detail-limit') ?? DEFAULT_BOUNDS.detailLimit);
  if (![limit, maxPages, detailLimit].every(Number.isSafeInteger) || limit < 1 || maxPages < 1 || detailLimit < 0) {
    throw Object.assign(new Error('BOUNDS_INVALID'), { code: 'BOUNDS_INVALID' });
  }
  const manualSources = process.argv.filter(value => value.startsWith('--source=')).map(value => value.slice('--source='.length));
  const molitOnly = process.argv.includes('--molit');
  if (molitOnly && manualSources.length) throw Object.assign(new Error('SOURCE_SELECTION_CONFLICT'), { code: 'SOURCE_SELECTION_CONFLICT' });
  const result = await collectPublicNotices({ limit, maxPages, detailLimit,
    ...(molitOnly ? { sources: ['molit-notices'] } : manualSources.length ? { sources: manualSources } : {}) });
  const target = path.resolve(out);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
  const ok = noticeCollectionCanExitZero(result);
  console.log(JSON.stringify({ ok, status: result.status, snapshotComplete: result.snapshotComplete, requestedSources: result.requestedSources,
    out: target, receipts: result.receipts, items: result.items.length }));
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.log(JSON.stringify({ ok: false, code: safeCode(error) }));
    process.exitCode = 1;
  });
}
