import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireRunLock } from '../../../affiliate-api-hub/lib/process-run-lock.mjs';

export const TOSS_CURSOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_CURSOR_LENGTH = 4096;
const SOURCE_KEYS = new Set(['today_deal', 'category_best_food', 'best_selling']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /^[A-Z0-9_]{2,80}$/.test(String(error?.code ?? '')) ? String(error.code) : 'TOSS_COLLECTION_FAILED';
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeReason = value => /^[A-Z0-9_]{2,80}$/.test(String(value ?? '')) ? String(value) : null;

function statePaths(foodOnly) {
  const localData = process.env.LOCALAPPDATA || homedir();
  const directory = path.join(localData, 'affiliate-content-operations', 'quick-fact');
  const mode = foodOnly ? 'food' : 'nonfood';
  return {
    directory,
    mode,
    file: path.join(directory, `toss-${mode}-cursors.json`),
    lockDirectory: path.join(directory, `toss-${mode}-cursor-lock`),
  };
}

function expectedSources(foodOnly) {
  return foodOnly ? new Set(['today_deal', 'category_best_food']) : new Set(['today_deal', 'best_selling']);
}

function validateCursorMap(value, foodOnly, code = 'TOSS_CHECKPOINT_INVALID') {
  if (!isPlainObject(value)) fail(code);
  const allowed = expectedSources(foodOnly);
  const cursors = {};
  for (const [source, cursor] of Object.entries(value)) {
    if (!SOURCE_KEYS.has(source) || !allowed.has(source)) fail(code);
    if (cursor === null || cursor === undefined) continue;
    if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) fail(code);
    cursors[source] = cursor;
  }
  return cursors;
}

async function readCheckpoint(file, mode, foodOnly, nowMs) {
  let raw;
  try { raw = await readFile(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { cursors: {}, status: 'initialized', resetReason: null, previousUpdatedAt: null };
    fail('TOSS_CHECKPOINT_READ_FAILED');
  }
  if (raw.byteLength > MAX_STATE_BYTES) fail('TOSS_CHECKPOINT_INVALID');
  let state;
  try { state = JSON.parse(raw.toString('utf8')); }
  catch { fail('TOSS_CHECKPOINT_INVALID'); }
  if (!isPlainObject(state) || state.schemaVersion !== 1 || state.mode !== mode
    || typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) fail('TOSS_CHECKPOINT_INVALID');
  const updatedAt = new Date(state.updatedAt);
  if (updatedAt.toISOString() !== state.updatedAt) fail('TOSS_CHECKPOINT_INVALID');
  const cursors = validateCursorMap(state.cursors, foodOnly);
  const age = nowMs - updatedAt.getTime();
  if (age < -5 * 60 * 1000) fail('TOSS_CHECKPOINT_INVALID');
  if (age > TOSS_CURSOR_MAX_AGE_MS) return { cursors: {}, status: 'reset', resetReason: 'expired', previousUpdatedAt: state.updatedAt };
  return { cursors, status: Object.keys(cursors).length ? 'resumed' : 'initialized', resetReason: null, previousUpdatedAt: state.updatedAt };
}

async function writeCheckpoint(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, file);
  } catch {
    try { await unlink(temporary); } catch { /* temp may not have been created or was already renamed */ }
    fail('TOSS_CHECKPOINT_WRITE_FAILED');
  }
}

function sanitizeOffer(row) {
  if (!isPlainObject(row)) return null;
  const allowed = ['tacaItemId', 'tacaId', 'title', 'price', 'originalPrice', 'discountRate', 'soldOut', 'rating',
    'reviewCount', 'categoryIds', 'productUrl', 'rank', 'priceIncludesShipping', 'image', 'source', 'listedSource'];
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
}

function sanitizeExcluded(row) {
  if (!isPlainObject(row)) return null;
  const allowed = ['source', 'tacaItemId', 'tacaId', 'title', 'price', 'originalPrice', 'soldOut', 'productUrl',
    'image', 'priceIncludesShipping', 'listedSource', 'reason'];
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
}

function sanitizeCoverage(raw) {
  if (!isPlainObject(raw)) fail('TOSS_COLLECTION_RESULT_INVALID');
  const rawSources = isPlainObject(raw.sources) ? raw.sources : {};
  const sources = {};
  for (const [name, value] of Object.entries(rawSources)) {
    if (!SOURCE_KEYS.has(name) && name !== 'watched_detail') continue;
    if (!isPlainObject(value)) continue;
    sources[name] = {
      available: value.available === true,
      pages: safeCount(value.pages),
      items: safeCount(value.items ?? value.returnedCount ?? value.detailReturnedCount),
      returnedCount: safeCount(value.returnedCount),
      uniqueCount: safeCount(value.uniqueCount),
      rows: safeCount(value.rows),
      unrankableCount: safeCount(value.unrankableCount),
      knownExcludedCount: safeCount(value.knownExcludedCount),
      continuationUsed: value.continuationUsed === true,
      exhausted: value.exhausted === true,
      hasNext: typeof value.hasNext === 'boolean' ? value.hasNext : null,
      continuationUsed: value.continuationUsed === true,
      remainingUnknown: typeof value.remainingUnknown === 'boolean' ? value.remainingUnknown : safeCount(value.remainingUnknown),
      requestedCount: safeCount(value.requestedCount),
      foundCount: safeCount(value.foundCount),
      notFoundCount: safeCount(value.notFoundCount),
      unknownCount: safeCount(value.unknownCount),
      detailBatches: safeCount(value.detailBatches),
      stopReason: safeReason(value.stopReason),
      error: safeReason(value.errorCode ?? value.error),
      errorCode: safeReason(value.errorCode ?? value.error),
    };
  }
  return {
    checkedAt: typeof raw.checkedAt === 'string' && Number.isFinite(Date.parse(raw.checkedAt)) ? raw.checkedAt : null,
    available: raw.available === true,
    exhausted: raw.exhausted === true,
    complete: raw.complete === true,
    collectionComplete: raw.collectionComplete === true,
    collectionPartial: raw.collectionPartial === true,
    remainingUnknown: safeCount(raw.remainingUnknown),
    hasRemainingUnknown: raw.hasRemainingUnknown === true,
    pages: safeCount(raw.pages),
    pageLimit: safeCount(raw.pageLimit),
    pageSize: safeCount(raw.pageSize),
    continuationUsed: raw.continuationUsed === true,
    counts: isPlainObject(raw.counts) ? Object.fromEntries(Object.entries(raw.counts)
      .filter(([key, value]) => /^[A-Za-z0-9_]{1,50}$/.test(key) && safeCount(value) !== null)
      .slice(0, 30).map(([key, value]) => [key, safeCount(value)])) : {},
    sources,
    error: safeReason(raw.errorCode ?? raw.error),
    errorCode: safeReason(raw.errorCode ?? raw.error),
  };
}

/**
 * Perform one bounded Toss collection while atomically advancing an opaque, mode-specific cursor checkpoint.
 * The checkpoint is runtime-only; this function's result deliberately contains metadata but never cursor values.
 */
export async function collectTossItemsWithCheckpoint(options = {}) {
  const foodOnly = options.foodOnly ?? true;
  if (typeof foodOnly !== 'boolean') fail('TOSS_CHECKPOINT_OPTIONS_INVALID');
  const { directory, file, lockDirectory, mode } = statePaths(foodOnly);
  let release;
  try { release = await acquireRunLock(lockDirectory); }
  catch (error) {
    if (String(error?.message ?? '').includes('ONBOARDING_RUN_LOCKED')) fail('TOSS_CHECKPOINT_LOCKED');
    fail('TOSS_CHECKPOINT_LOCK_FAILED');
  }

  try {
    await mkdir(directory, { recursive: true });
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const currentTime = now();
    const nowMs = currentTime instanceof Date ? currentTime.getTime() : Date.parse(currentTime);
    if (!Number.isFinite(nowMs)) fail('TOSS_CHECKPOINT_CLOCK_INVALID');
    const loaded = await readCheckpoint(file, mode, foodOnly, nowMs);
    const { collectTossItems } = await import('./toss-deal-check.mjs');
    if (typeof collectTossItems !== 'function') fail('TOSS_COLLECTOR_UNAVAILABLE');

    let result;
    try {
      result = await collectTossItems({
        api: options.api,
        foodOnly,
        pages: options.pages ?? 3,
        best: options.best ?? 30,
        watchedTacaItemIds: options.watchedTacaItemIds,
        now,
        feedCursors: loaded.cursors,
      });
    } catch (error) {
      const code = safeCode(error);
      throw Object.assign(new Error(code), { code });
    }
    if (!isPlainObject(result) || !Array.isArray(result.offers) || !Array.isArray(result.excluded)) fail('TOSS_COLLECTION_RESULT_INVALID');
    const nextCursors = validateCursorMap(result.nextFeedCursors, foodOnly, 'TOSS_CHECKPOINT_CURSOR_INVALID');
    const completedAt = now();
    const updatedAt = completedAt instanceof Date ? completedAt.toISOString() : new Date(completedAt).toISOString();
    await writeCheckpoint(file, { schemaVersion: 1, mode, updatedAt, cursors: nextCursors });

    const offers = result.offers.map(sanitizeOffer).filter(Boolean);
    const excluded = result.excluded.map(sanitizeExcluded).filter(Boolean);
    const coverage = sanitizeCoverage(result.coverage);
    const continuationUsed = loaded.status === 'resumed' || coverage.continuationUsed;
    coverage.continuationUsed = continuationUsed;
    return {
      offers,
      items: offers,
      excluded,
      coverage,
      checkpoint: {
        status: loaded.status === 'reset' ? 'advanced_after_expiry' : Object.keys(loaded.cursors).length ? 'advanced' : 'initialized',
        resetReason: loaded.resetReason,
        previousUpdatedAt: loaded.previousUpdatedAt,
        updatedAt,
        streamCount: Object.keys(nextCursors).length,
        continuationUsed,
      },
    };
  } finally {
    await release();
  }
}
