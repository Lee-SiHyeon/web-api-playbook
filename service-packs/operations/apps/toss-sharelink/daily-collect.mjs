import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  checkSession as protectedOwnerCheck,
  request as tossRequest,
  todayDealItemsPage as maintainedTodayDealItemsPage,
} from './client.mjs';
import { archiveTossWebSnapshot } from './daily-archive.mjs';

export const CURATION_OPERATION = 'shopping-curation-sections';
export const TODAY_DEAL_ITEMS_OPERATION = 'shopping-today-deal-items';
export const TODAY_DEAL_PAGE_LIMIT = 50;
export const TODAY_DEAL_PAGE_DELAY_MS = 400;
export const DEFAULT_STATUS_FILE = path.join(
  process.env.LOCALAPPDATA || '.',
  'affiliate-content-operations',
  'toss-consumer-daily-archive',
  'collection-status.json',
);

const ERROR_CODES = new Set([
  'TOSS_REAUTH_REQUIRED',
  'TOSS_OWNER_MISMATCH',
  'TOSS_STATE_INVALID',
  'TOSS_OPERATION_NOT_CAPTURED',
  'TOSS_HTTP_FAILED',
  'TOSS_RESPONSE_INVALID',
  'TOSS_SERVICE_REJECTED',
  'TOSS_ARCHIVE_FAILED',
  'TOSS_PAGE_READER_REQUIRED',
  'TOSS_PAGE_LIMIT_INVALID',
]);

function safeErrorCode(error) {
  return ERROR_CODES.has(error?.code) ? error.code : 'TOSS_COLLECTION_FAILED';
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInstant(value) {
  if (typeof value !== 'string' || value.length > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function safeTossId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return /^\d{1,24}$/.test(id) ? id : null;
}

function cursorState(paging) {
  if (!isRecord(paging) || !Object.hasOwn(paging, 'nextCursor')) return null;
  if (paging.nextCursor === null) return false;
  if (typeof paging.nextCursor === 'string' && paging.nextCursor.length > 0) return true;
  return null;
}

// Live 2026-10-07: a product had SOLD_OUT / TEMPORARILY_SOLD_OUT while
// isSoldOut remained false. Either explicit unavailable signal excludes it;
// an unfamiliar lifecycle status cannot establish current availability.
function stockObservation(productView, incompleteReasons) {
  const isSoldOut = typeof productView.isSoldOut === 'boolean' ? productView.isSoldOut : null;
  const knownStatus = new Set(['ON_GOING', 'SOLD_OUT', 'TEMPORARILY_SOLD_OUT']);
  const status = knownStatus.has(productView.status) ? productView.status : null;
  const explicitSoldOut = status === 'SOLD_OUT' || status === 'TEMPORARILY_SOLD_OUT';
  const conflict = (explicitSoldOut && isSoldOut === false)
    || (status === 'ON_GOING' && isSoldOut === true);
  if (conflict) incompleteReasons.push('deal_stock_signals_conflict');
  let stockStatus;
  if (explicitSoldOut || isSoldOut === true) stockStatus = 'sold_out';
  else if (productView.status !== undefined && productView.status !== null && status === null) {
    stockStatus = 'unknown';
    incompleteReasons.push('deal_status_unknown');
  } else if (isSoldOut === false) stockStatus = 'in_stock';
  else {
    stockStatus = 'unknown';
    incompleteReasons.push('deal_stock_unknown');
  }
  return { stockStatus, stockSignals: { isSoldOut, status, conflict } };
}

function assessCoverage(success, sections, productCount, incompleteReasons) {
  const states = [cursorState(success.paging)];
  if (!Array.isArray(sections)) {
    incompleteReasons.push('sections_missing');
  } else if (sections.length === 0) {
    incompleteReasons.push('sections_empty');
  }

  for (const section of Array.isArray(sections) ? sections : []) {
    if (!isRecord(section) || !Array.isArray(section.items)) {
      states.push(null);
      incompleteReasons.push('section_items_unknown');
      continue;
    }
    const paging = section.paging;
    const next = cursorState(paging);
    states.push(next);
    if (next === null) incompleteReasons.push('section_paging_unknown');
    if (!isRecord(paging) || !Number.isSafeInteger(paging.totalCount) || paging.totalCount < 0) {
      incompleteReasons.push('section_count_unknown');
    } else if (paging.totalCount !== section.items.length) {
      incompleteReasons.push('section_count_not_exhausted');
    }
    if (next === true) incompleteReasons.push('section_has_next');
  }

  if (states[0] === null) incompleteReasons.push('feed_paging_unknown');
  if (states[0] === true) incompleteReasons.push('feed_has_next');
  if (success.limited !== false) incompleteReasons.push('feed_limited_or_unknown');

  const hasNext = states.includes(true) ? true : states.includes(null) ? null : false;
  const complete = incompleteReasons.length === 0 && hasNext === false;
  return {
    status: complete ? 'complete' : 'partial',
    pages: 1,
    pageLimit: 1,
    itemCount: productCount,
    hasNext,
    complete,
    reasons: [...new Set(incompleteReasons)].sort(),
  };
}

function projectDealItem(item, incompleteReasons) {
  if (!isRecord(item) || !isRecord(item.todayDeal)) return null;
  const productView = isRecord(item.taca) && isRecord(item.taca.productView) ? item.taca.productView : null;
  if (!productView) {
    incompleteReasons.push('deal_product_view_missing');
    return null;
  }

  const rawTacaItemId = productView.tacaItemId;
  const tacaItemId = safeTossId(rawTacaItemId);
  const tacaId = safeTossId(productView.tacaId);
  const rawProductId = productView.productId ?? item.productId;
  const productId = tacaItemId ?? rawProductId;
  const title = productView.displayName;
  if ((typeof productId !== 'string' && typeof productId !== 'number')
      || (typeof title !== 'string' || !title.trim())) {
    incompleteReasons.push('deal_identity_missing');
    return null;
  }
  if (rawTacaItemId !== undefined && rawTacaItemId !== null && tacaItemId === null) {
    incompleteReasons.push('deal_identity_invalid');
    return null;
  }
  if (productView.tacaId !== undefined && productView.tacaId !== null && tacaId === null) {
    incompleteReasons.push('deal_identity_invalid');
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(String(productId)) || /token|secret|cookie|password|session/i.test(String(productId))) {
    incompleteReasons.push('deal_identity_invalid');
    return null;
  }

  const startAt = safeInstant(item.todayDeal.startAt);
  const endAt = safeInstant(item.todayDeal.endAt);
  if (startAt === null || endAt === null) incompleteReasons.push('deal_schedule_unknown');
  const stock = stockObservation(productView, incompleteReasons);

  const product = {
    productId: String(productId),
    tacaItemId,
    tacaId,
    title: title.trim(),
    // This captured curation contract has no public product URL. Never derive one from an ID.
    productUrl: null,
    priceKrw: productView.displayPrice ?? null,
    priceKind: productView.priceCompositionType ?? null,
    priceLabel: 'Toss displayed price; account eligibility unverified',
    shippingKnown: null,
    todayDeal: { startAt, endAt },
    ...stock,
  };

  return product;
}

function blockedSnapshot(observedAt, errorCode, operation = CURATION_OPERATION, pageLimit = 1) {
  return {
    schemaVersion: 1,
    source: { kind: 'toss_consumer_web', origin: 'https://sharelink.toss.im', operation },
    observedAt,
    promotionDate: null,
    coverage: {
      status: 'blocked',
      errorCode,
      pages: 0,
      pageLimit,
      itemCount: 0,
      rawItemCount: 0,
      uniqueTacaItemCount: 0,
      exactDuplicateCount: 0,
      conflictDuplicateCount: 0,
      reportedTotalCount: null,
      hasNext: null,
      complete: false,
    },
    products: [],
  };
}

/**
 * Read the protected owner identity first, then replay only the captured curation GET.
 * Pagination is deliberately not synthesized from the opaque first-page cursor.
 */
export async function collectTossDailySnapshot({
  request = tossRequest,
  checkSession = protectedOwnerCheck,
  now = () => new Date(),
} = {}) {
  const observedAt = now().toISOString();
  let ownerMatched = false;
  try {
    const owner = await checkSession();
    if (owner?.ownerMatched !== true) fail('TOSS_OWNER_MISMATCH');
    ownerMatched = true;
    const result = await request(CURATION_OPERATION);
    const success = result?.data?.success;
    if (result?.data?.resultType !== 'SUCCESS' || !isRecord(success) || !Array.isArray(success.sections)) {
      fail('TOSS_RESPONSE_INVALID');
    }

    const incompleteReasons = [];
    const products = [];
    for (const section of success.sections) {
      if (!isRecord(section) || !Array.isArray(section.items)) {
        incompleteReasons.push('section_items_unknown');
        continue;
      }
      for (const item of section.items) {
        const product = projectDealItem(item, incompleteReasons);
        if (product) products.push(product);
      }
    }

    const coverage = assessCoverage(success, success.sections, products.length, incompleteReasons);
    const snapshot = {
      schemaVersion: 1,
      source: { kind: 'toss_consumer_web', origin: 'https://sharelink.toss.im', operation: CURATION_OPERATION },
      observedAt,
      // Promotion days are per deal and can cross KST midnight. The archive stores exact deal instants per product.
      promotionDate: null,
      coverage,
      products,
    };
    return { snapshot, ownerMatched, errorCode: null };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    return { snapshot: blockedSnapshot(observedAt, errorCode), ownerMatched, errorCode };
  }
}

function boundedPageLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('TOSS_PAGE_LIMIT_INVALID');
  return Math.min(value, TODAY_DEAL_PAGE_LIMIT);
}

function boundedPageDelay(value) {
  if (!Number.isSafeInteger(value)) return TODAY_DEAL_PAGE_DELAY_MS;
  return Math.max(TODAY_DEAL_PAGE_DELAY_MS, Math.min(value, 30_000));
}

function defaultPageSleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function todayItemsSuccess(result) {
  const success = result?.data?.success;
  if (result?.data?.resultType !== 'SUCCESS' || !isRecord(success)
      || success.sectionCode !== 'TODAY_DEAL' || !Array.isArray(success.items)) return null;
  return success;
}

function safeReportedTotalCount(paging) {
  return isRecord(paging) && Number.isSafeInteger(paging.totalCount) && paging.totalCount >= 0
    ? paging.totalCount : null;
}

/**
 * Collect the source-observed TODAY_DEAL items route. Cursor values stay in memory;
 * only that endpoint's response-level paging.nextCursor is followed.
 */
export async function collectTossTodayItemsSnapshot({
  request = tossRequest,
  pageReader,
  checkSession = protectedOwnerCheck,
  now = () => new Date(),
  pageLimit = TODAY_DEAL_PAGE_LIMIT,
  delayMs = TODAY_DEAL_PAGE_DELAY_MS,
  sleep = defaultPageSleep,
} = {}) {
  const observedAt = now().toISOString();
  let ownerMatched = false;
  let limit;
  try {
    limit = boundedPageLimit(pageLimit);
  } catch (error) {
    const errorCode = safeErrorCode(error);
    return { snapshot: blockedSnapshot(observedAt, errorCode, TODAY_DEAL_ITEMS_OPERATION), ownerMatched, errorCode };
  }
  const interPageDelayMs = boundedPageDelay(delayMs);
  let readPage = pageReader;
  if (typeof readPage !== 'function' && request === tossRequest && checkSession === protectedOwnerCheck) {
    readPage = maintainedTodayDealItemsPage;
  }

  try {
    const owner = await checkSession();
    if (owner?.ownerMatched !== true) fail('TOSS_OWNER_MISMATCH');
    ownerMatched = true;
    if (typeof readPage !== 'function') fail('TOSS_PAGE_READER_REQUIRED');
  } catch (error) {
    const errorCode = safeErrorCode(error);
    return {
      snapshot: blockedSnapshot(observedAt, errorCode, TODAY_DEAL_ITEMS_OPERATION, limit),
      ownerMatched,
      errorCode,
    };
  }

  const incompleteReasons = [];
  const products = [];
  const signaturesById = new Map();
  const requestedCursors = new Set();
  let rawItemCount = 0;
  let exactDuplicateCount = 0;
  let conflictDuplicateCount = 0;
  let pages = 0;
  let hasNext = null;
  let reportedTotalCount = null;
  let errorCode = null;
  let cursor = null;

  while (pages < limit) {
    if (cursor !== null) {
      if (requestedCursors.has(cursor)) {
        incompleteReasons.push('deal_cursor_cycle');
        hasNext = true;
        break;
      }
      requestedCursors.add(cursor);
    }

    let result;
    try {
      result = await readPage(cursor);
    } catch (error) {
      errorCode = safeErrorCode(error);
      incompleteReasons.push(pages === 0 ? 'deal_first_page_read_failed' : 'deal_later_page_read_failed');
      if (pages === 0) {
        return {
          snapshot: blockedSnapshot(observedAt, errorCode, TODAY_DEAL_ITEMS_OPERATION, limit),
          ownerMatched,
          errorCode,
        };
      }
      break;
    }

    const success = todayItemsSuccess(result);
    if (!success) {
      errorCode = 'TOSS_RESPONSE_INVALID';
      incompleteReasons.push(pages === 0 ? 'deal_first_page_response_invalid' : 'deal_later_page_response_invalid');
      if (pages === 0) {
        return {
          snapshot: blockedSnapshot(observedAt, errorCode, TODAY_DEAL_ITEMS_OPERATION, limit),
          ownerMatched,
          errorCode,
        };
      }
      break;
    }

    pages += 1;
    const items = success.items;
    rawItemCount += items.length;
    if (success.limited !== false) incompleteReasons.push('deal_limited_or_unknown');

    const pageTotalCount = safeReportedTotalCount(success.paging);
    if (pageTotalCount === null) incompleteReasons.push('deal_total_count_unknown');
    else if (reportedTotalCount === null) reportedTotalCount = pageTotalCount;
    else if (reportedTotalCount !== pageTotalCount) incompleteReasons.push('deal_total_count_changed');

    for (const item of items) {
      if (!isRecord(item) || !isRecord(item.todayDeal)) {
        incompleteReasons.push('deal_schedule_unknown');
        continue;
      }
      const product = projectDealItem(item, incompleteReasons);
      if (!product) continue;
      if (!product.tacaItemId) {
        incompleteReasons.push('deal_identity_missing');
        continue;
      }
      const signature = JSON.stringify(product);
      const signatures = signaturesById.get(product.tacaItemId);
      if (signatures?.has(signature)) {
        exactDuplicateCount += 1;
        continue;
      }
      if (signatures) {
        conflictDuplicateCount += 1;
        incompleteReasons.push('deal_duplicate_identity_conflict');
        signatures.add(signature);
      } else {
        signaturesById.set(product.tacaItemId, new Set([signature]));
      }
      products.push(product);
    }

    const pagingState = cursorState(success.paging);
    if (pagingState === null) {
      incompleteReasons.push('deal_paging_unknown');
      hasNext = null;
      break;
    }
    hasNext = pagingState;
    if (pagingState === false) break;

    const nextCursor = success.paging.nextCursor;
    if (requestedCursors.has(nextCursor)) {
      incompleteReasons.push('deal_cursor_cycle');
      hasNext = true;
      break;
    }
    if (pages >= limit) {
      incompleteReasons.push('deal_page_limit_reached');
      hasNext = true;
      break;
    }
    try {
      await sleep(interPageDelayMs);
    } catch (error) {
      errorCode = safeErrorCode(error);
      incompleteReasons.push('deal_page_delay_failed');
      hasNext = true;
      break;
    }
    cursor = nextCursor;
  }

  const reasons = [...new Set(incompleteReasons)].sort();
  const complete = reasons.length === 0 && hasNext === false;
  const snapshot = {
    schemaVersion: 1,
    source: { kind: 'toss_consumer_web', origin: 'https://sharelink.toss.im', operation: TODAY_DEAL_ITEMS_OPERATION },
    observedAt,
    promotionDate: null,
    coverage: {
      status: complete ? 'complete' : 'partial',
      pages,
      pageLimit: limit,
      itemCount: products.length,
      rawItemCount,
      uniqueTacaItemCount: signaturesById.size,
      exactDuplicateCount,
      conflictDuplicateCount,
      reportedTotalCount,
      hasNext,
      complete,
      reasons,
    },
    products,
  };
  return { snapshot, ownerMatched, errorCode };
}

function archiveSummary(receipt) {
  if (!isRecord(receipt)) return null;
  return {
    ok: receipt.ok === true,
    snapshotId: typeof receipt.snapshotId === 'string' ? receipt.snapshotId : null,
    collectionDateKst: typeof receipt.collectionDateKst === 'string' ? receipt.collectionDateKst : null,
    productCount: Number.isSafeInteger(receipt.productCount) && receipt.productCount >= 0 ? receipt.productCount : null,
    localCommitted: receipt.localCommitted === true,
    localReadbackVerified: receipt.localReadbackVerified === true,
    driveCommitted: receipt.driveCommitted === true,
    driveReadbackVerified: receipt.driveReadbackVerified === true,
    driveFileCount: Number.isSafeInteger(receipt.driveFileCount) ? receipt.driveFileCount : null,
    errorCode: typeof receipt.errorCode === 'string' && /^[A-Z0-9_]{2,80}$/.test(receipt.errorCode)
      ? receipt.errorCode : null,
  };
}

function statusReceipt({ collected, archived, observedAt }) {
  return {
    schemaVersion: 1,
    kind: 'toss_consumer_daily_collection_status',
    observedAt,
    ownerMatched: collected.ownerMatched === true,
    result: collected.snapshot.coverage.status,
    errorCode: collected.errorCode ?? archived?.errorCode ?? null,
    coverage: {
      status: collected.snapshot.coverage.status,
      complete: collected.snapshot.coverage.complete === true,
      pages: collected.snapshot.coverage.pages,
      pageLimit: collected.snapshot.coverage.pageLimit,
      itemCount: collected.snapshot.coverage.itemCount,
      rawItemCount: Number.isSafeInteger(collected.snapshot.coverage.rawItemCount)
        ? collected.snapshot.coverage.rawItemCount : null,
      uniqueTacaItemCount: Number.isSafeInteger(collected.snapshot.coverage.uniqueTacaItemCount)
        ? collected.snapshot.coverage.uniqueTacaItemCount : null,
      exactDuplicateCount: Number.isSafeInteger(collected.snapshot.coverage.exactDuplicateCount)
        ? collected.snapshot.coverage.exactDuplicateCount : null,
      conflictDuplicateCount: Number.isSafeInteger(collected.snapshot.coverage.conflictDuplicateCount)
        ? collected.snapshot.coverage.conflictDuplicateCount : null,
      reportedTotalCount: Number.isSafeInteger(collected.snapshot.coverage.reportedTotalCount)
        ? collected.snapshot.coverage.reportedTotalCount : null,
      hasNext: collected.snapshot.coverage.hasNext,
      reasons: Array.isArray(collected.snapshot.coverage.reasons) ? collected.snapshot.coverage.reasons : [],
    },
    archive: archiveSummary(archived),
  };
}

export async function writeCollectionStatus(receipt, file = DEFAULT_STATUS_FILE) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  const readback = await readFile(target);
  if (!readback.equals(bytes)) fail('TOSS_STATUS_READBACK_MISMATCH');
  return { path: target, bytes: bytes.length, readbackVerified: true };
}

export async function runTossDailyCollection({
  request = tossRequest,
  pageReader,
  checkSession = protectedOwnerCheck,
  archive = archiveTossWebSnapshot,
  writeStatus = receipt => writeCollectionStatus(receipt),
  now = () => new Date(),
  pageLimit = TODAY_DEAL_PAGE_LIMIT,
  delayMs = TODAY_DEAL_PAGE_DELAY_MS,
  sleep = defaultPageSleep,
} = {}) {
  const collected = typeof pageReader === 'function' || request === tossRequest
    ? await collectTossTodayItemsSnapshot({ request, pageReader, checkSession, now, pageLimit, delayMs, sleep })
    : await collectTossDailySnapshot({ request, checkSession, now });
  let archived = null;
  try {
    archived = await archive(collected.snapshot);
  } catch (error) {
    archived = { ok: false, errorCode: safeErrorCode(error) };
  }
  const receipt = statusReceipt({ collected, archived, observedAt: collected.snapshot.observedAt });
  await writeStatus(receipt);
  return {
    ok: archived?.ok === true && collected.snapshot.coverage.status !== 'blocked',
    receipt,
  };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  if (args.length) fail('TOSS_COLLECT_USAGE');
  try {
    const result = await runTossDailyCollection(dependencies);
    console.log(JSON.stringify(result.receipt));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      kind: 'toss_consumer_daily_collection_status',
      result: 'blocked',
      ownerMatched: false,
      errorCode: safeErrorCode(error),
      archive: null,
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.exitCode = 1; });
}
