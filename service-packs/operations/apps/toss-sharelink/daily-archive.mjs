import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { link, open, lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { acquireRunLock } from '../affiliate-api-hub/lib/process-run-lock.mjs';

export const DEFAULT_DRIVE_ROOT = process.env.TOSS_DAILY_ARCHIVE_DRIVE_ROOT
  || 'G:\\내 드라이브\\affiliate-content-automation\\토스 당일특가·품절 일별 기록';
export const DEFAULT_LOCAL_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'),
  'affiliate-content-operations',
  'toss-consumer-daily-archive',
);

const MAX_INPUT_PRODUCTS = 10_000;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 1_024;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_DRIVE_FILES = 50_000;
const MAX_PENDING_DRIVE_BYTES = 512 * 1024 * 1024;
const PRODUCT_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const SCOPE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const OPERATION_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PRODUCT_URL_ORIGINS = new Set([
  'https://toss.shopping',
  'https://shopping.toss.im',
]);
const SECRET_VALUE_RE = /(?:bearer\s+[A-Za-z0-9._~-]{16,}|(?:authorization|cookie|password|access[_-]?token|refresh[_-]?token)\s*[:=]|(?:TGSID|TBIZAUTH|auth_token|ct0)\s*=)/i;
const SECRET_IDENTIFIER_RE = /(?:authorization|bearer|cookie|password|access[_-]?token|refresh[_-]?token|credential|secret|session)/i;
const execFileAsync = promisify(execFile);
const WINDOWS_RENAME_NO_REPLACE = 'import os,sys; os.rename(sys.argv[1],sys.argv[2])';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const safeCode = error => /^[A-Z0-9_]{2,80}$/.test(String(error?.code || '')) ? String(error.code) : 'TOSS_ARCHIVE_FAILED';

function windowsExtendedPath(file) {
  const absolute = path.resolve(file);
  if (absolute.startsWith('\\\\?\\')) return absolute;
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`;
  return `\\\\?\\${absolute}`;
}

export async function renameNoReplaceWindows(source, destination) {
  const env = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
  };
  await execFileAsync('python.exe', [
    '-X', 'utf8', '-c', WINDOWS_RENAME_NO_REPLACE,
    windowsExtendedPath(source), windowsExtendedPath(destination),
  ], { env, windowsHide: true, timeout: 15_000, maxBuffer: 4_096 });
}

function normalizeDateTime(value, code) {
  const match = typeof value === 'string'
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match) fail(code);
  try { normalizePromotionDate(match[1]); } catch { fail(code); }
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59))) fail(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(code);
  return date.toISOString();
}

export function collectionDateKst(observedAt) {
  const milliseconds = Date.parse(normalizeDateTime(observedAt, 'TOSS_ARCHIVE_OBSERVED_AT_INVALID'));
  if (!Number.isFinite(milliseconds)) fail('TOSS_ARCHIVE_OBSERVED_AT_INVALID');
  return new Date(milliseconds + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function normalizePromotionDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('TOSS_ARCHIVE_PROMOTION_DATE_INVALID');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('TOSS_ARCHIVE_PROMOTION_DATE_INVALID');
  return value;
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > maxLength || SECRET_VALUE_RE.test(cleaned)) return null;
  return cleaned;
}

function normalizePublicProductUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !PRODUCT_URL_ORIGINS.has(url.origin) || url.username || url.password
      || url.search || url.hash || !url.pathname.startsWith('/') || /[\u0000-\u0020]/.test(url.pathname)
      || SECRET_IDENTIFIER_RE.test(url.pathname) || SECRET_VALUE_RE.test(url.pathname)) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

function normalizeOptionalId(value, code) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value);
  if (!PRODUCT_ID_RE.test(id) || id.length > 64 || SECRET_IDENTIFIER_RE.test(id)) fail(code);
  return id;
}

function normalizeOptionalTossId(value, code) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value);
  if (!/^\d{1,24}$/.test(id)) fail(code);
  return id;
}

function normalizePrice(product) {
  const raw = Object.hasOwn(product, 'priceKrw') ? product.priceKrw : product.price;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string' || raw.length > 24 || !/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:원)?$/.test(raw.trim())) return null;
  const price = Number(raw.trim().replace(/[,원]/g, ''));
  return Number.isSafeInteger(price) && price > 0 ? price : null;
}

function normalizeStockStatus(product) {
  if (['in_stock', 'sold_out', 'unknown'].includes(product.stockStatus)) return product.stockStatus;
  const flags = [];
  if (typeof product.soldOut === 'boolean') flags.push(product.soldOut ? 'sold_out' : 'in_stock');
  if (typeof product.isSoldOut === 'boolean') flags.push(product.isSoldOut ? 'sold_out' : 'in_stock');
  if (typeof product.inStock === 'boolean') flags.push(product.inStock ? 'in_stock' : 'sold_out');
  return flags.length && flags.every(flag => flag === flags[0]) ? flags[0] : 'unknown';
}

function normalizeStockSignals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const isSoldOut = typeof value.isSoldOut === 'boolean' ? value.isSoldOut : null;
  const status = ['ON_GOING', 'SOLD_OUT', 'TEMPORARILY_SOLD_OUT'].includes(value.status) ? value.status : null;
  const conflict = typeof value.conflict === 'boolean' ? value.conflict : false;
  if (isSoldOut === null && status === null && !conflict) return null;
  return { isSoldOut, status, conflict };
}

function normalizeScheduleInstant(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || SECRET_VALUE_RE.test(value)) return null;
  try { return normalizeDateTime(value, 'TOSS_ARCHIVE_TODAY_DEAL_TIME_INVALID'); } catch { return null; }
}

function normalizeTodayDeal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const startAt = normalizeScheduleInstant(value.startAt);
  const endAt = normalizeScheduleInstant(value.endAt);
  return startAt === null && endAt === null ? null : { startAt, endAt };
}

function normalizeSafeKind(value, fallback) {
  const raw = value ?? fallback;
  if (Number.isSafeInteger(raw) && raw >= 0 && raw <= 10_000) return raw;
  return safeText(raw, 80);
}

function normalizeCoverage(raw, inputCount, invalidProductCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('TOSS_ARCHIVE_COVERAGE_INVALID');
  const boundedCount = (value, max, code) => {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(code);
    return value;
  };
  const pages = boundedCount(raw.pages, 1_000, 'TOSS_ARCHIVE_COVERAGE_INVALID');
  const pageLimit = boundedCount(raw.pageLimit, 1_000, 'TOSS_ARCHIVE_COVERAGE_INVALID');
  const itemCount = boundedCount(raw.itemCount, MAX_INPUT_PRODUCTS, 'TOSS_ARCHIVE_COVERAGE_INVALID');
  const hasNext = typeof raw.hasNext === 'boolean' ? raw.hasNext : null;
  const status = ['complete', 'partial', 'blocked'].includes(raw.status)
    ? raw.status : raw.complete === true ? 'complete' : 'partial';
  const errorCode = /^[A-Z0-9_]{2,80}$/.test(String(raw.errorCode ?? '')) ? String(raw.errorCode) : null;
  const complete = status === 'complete' && raw.complete === true && hasNext === false
    && pages !== null && pages >= 1 && pageLimit !== null && pageLimit >= pages
    && invalidProductCount === 0
    && itemCount !== null && itemCount === inputCount;
  return {
    status: complete ? 'complete' : status === 'blocked' ? 'blocked' : 'partial',
    errorCode,
    pages,
    pageLimit,
    itemCount,
    hasNext,
    declaredComplete: raw.complete === true,
    complete,
    invalidProductCount,
    returnedProducts: inputCount - invalidProductCount,
  };
}

function normalizeProducts(rawProducts) {
  if (!Array.isArray(rawProducts) || rawProducts.length > MAX_INPUT_PRODUCTS) fail('TOSS_ARCHIVE_PRODUCTS_INVALID');
  const products = new Map();
  const conflictedIds = new Set();
  let invalidProductCount = 0;
  for (const raw of rawProducts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalidProductCount++;
      continue;
    }
    const rawId = raw.productId ?? raw.id ?? raw.tacaItemId;
    const productId = rawId === undefined || rawId === null ? null : String(rawId);
    const title = safeText(raw.title, MAX_TITLE_LENGTH);
    if (!productId || !PRODUCT_ID_RE.test(productId) || productId.length > 64 || SECRET_IDENTIFIER_RE.test(productId) || !title) {
      invalidProductCount++;
      continue;
    }
    const product = {
      productId,
      tacaItemId: normalizeOptionalTossId(raw.tacaItemId, 'TOSS_ARCHIVE_PRODUCT_ID_INVALID'),
      tacaId: normalizeOptionalTossId(raw.tacaId, 'TOSS_ARCHIVE_PRODUCT_ID_INVALID'),
      title,
      productUrl: normalizePublicProductUrl(raw.productUrl ?? raw.url),
      priceKrw: normalizePrice(raw),
      priceKind: normalizeSafeKind(raw.priceKind, raw.priceCompositionType),
      priceLabel: safeText(raw.priceLabel, 100),
      shippingKnown: typeof raw.shippingKnown === 'boolean' ? raw.shippingKnown : null,
      todayDeal: normalizeTodayDeal(raw.todayDeal),
      stockStatus: normalizeStockStatus(raw),
    };
    const stockSignals = normalizeStockSignals(raw.stockSignals);
    if (stockSignals) product.stockSignals = stockSignals;
    const previous = products.get(productId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(product)) {
      conflictedIds.add(productId);
    } else if (!previous) {
      products.set(productId, product);
    }
  }
  for (const id of conflictedIds) {
    products.delete(id);
    invalidProductCount++;
  }
  return { products: [...products.values()].sort((a, b) => a.productId.localeCompare(b.productId)), invalidProductCount };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('TOSS_ARCHIVE_INPUT_INVALID');
  if (snapshot.source?.kind !== 'toss_consumer_web') fail('TOSS_ARCHIVE_SOURCE_REJECTED');
  const operation = snapshot.source.operation;
  if (typeof operation !== 'string' || !OPERATION_RE.test(operation) || SECRET_IDENTIFIER_RE.test(operation)) fail('TOSS_ARCHIVE_SOURCE_INVALID');
  const categoryId = normalizeOptionalId(snapshot.source.categoryId, 'TOSS_ARCHIVE_SOURCE_INVALID');
  if (categoryId !== null && (!SCOPE_ID_RE.test(categoryId) || SECRET_IDENTIFIER_RE.test(categoryId))) fail('TOSS_ARCHIVE_SOURCE_INVALID');
  const observedAt = normalizeDateTime(snapshot.observedAt, 'TOSS_ARCHIVE_OBSERVED_AT_INVALID');
  const promotionDate = normalizePromotionDate(snapshot.promotionDate);
  const normalized = normalizeProducts(snapshot.products);
  const coverage = normalizeCoverage(snapshot.coverage, snapshot.products.length, normalized.invalidProductCount);
  const origin = snapshot.source.origin === 'https://sharelink.toss.im' ? 'https://sharelink.toss.im' : null;
  const source = { kind: 'toss_consumer_web', origin, operation, categoryId };
  const stream = { origin, operation, categoryId };
  return {
    schemaVersion: 1,
    kind: 'toss_consumer_web_snapshot',
    observedAt,
    collectionDateKst: collectionDateKst(observedAt),
    promotionDate,
    source,
    stream,
    coverage,
    products: normalized.products,
  };
}

function canonicalJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function uniqueSorted(values, key) {
  const map = new Map();
  for (const value of values) map.set(key(value), value);
  return [...map.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

async function ensureDirectory(root, relativeDirectory) {
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail('TOSS_ARCHIVE_ROOT_UNAVAILABLE');
  let current = root;
  if (!relativeDirectory || relativeDirectory === '.') return;
  for (const segment of relativeDirectory.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, segment);
    await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(current).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('TOSS_ARCHIVE_PATH_UNSAFE');
  }
}

async function readJson(file, defaultValue) {
  const stat = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return defaultValue;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) fail('TOSS_ARCHIVE_STATE_INVALID');
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch { fail('TOSS_ARCHIVE_STATE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('TOSS_ARCHIVE_STATE_INVALID');
  return value;
}

async function writeMutableJson(file, value) {
  const bytes = jsonBytes(value);
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  const readback = await readFile(file);
  if (sha256(readback) !== sha256(bytes)) fail('TOSS_ARCHIVE_READBACK_MISMATCH');
  return sha256(bytes);
}

async function writeImmutableBytes(root, relativePath, bytes) {
  const destination = path.join(root, relativePath);
  await ensureDirectory(root, path.dirname(relativePath));
  let existing = await lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!existing) {
    const temporary = destination + '.' + process.pid + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await handle.close();
    try {
      // Hard-link promotion is atomic and fails if the immutable destination already exists.
      await link(temporary, destination);
    } catch (error) {
      existing = await lstat(destination).catch(inner => inner.code === 'ENOENT' ? null : Promise.reject(inner));
      if (!existing && ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL', 'EISDIR'].includes(error.code)) {
        if (process.platform === 'win32') {
          try {
            await renameNoReplaceWindows(temporary, destination);
            existing = await lstat(destination).catch(inner => inner.code === 'ENOENT' ? null : Promise.reject(inner));
            if (!existing) fail('TOSS_ARCHIVE_ATOMIC_PROMOTION_FAILED');
          } catch {
            existing = await lstat(destination).catch(inner => inner.code === 'ENOENT' ? null : Promise.reject(inner));
            if (!existing) fail('TOSS_ARCHIVE_ATOMIC_PROMOTION_UNSUPPORTED');
          }
        } else {
          fail('TOSS_ARCHIVE_ATOMIC_PROMOTION_UNSUPPORTED');
        }
      }
      if (!existing && error.code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  existing = await lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!existing?.isFile() || existing.isSymbolicLink()) fail('TOSS_ARCHIVE_PATH_UNSAFE');
  if (existing) {
    const existingBytes = await readFile(destination);
    if (sha256(existingBytes) !== sha256(bytes)) fail('TOSS_ARCHIVE_IMMUTABLE_COLLISION');
  }
  const readback = await readFile(destination);
  if (sha256(readback) !== sha256(bytes)) fail('TOSS_ARCHIVE_READBACK_MISMATCH');
  return { relativePath, bytes: bytes.length, sha256: sha256(bytes), readbackVerified: true };
}

function newDayState(date) {
  return { schemaVersion: 1, kind: 'toss_consumer_daily_state', collectionDateKst: date, runs: [], products: [], notSeen: [] };
}

function newStreamState(streamHash, stream) {
  return { schemaVersion: 1, kind: 'toss_consumer_stream_state', streamHash, stream, lastCompleteObservedAt: null, lastCompleteSnapshotId: null, products: [] };
}

function assertDayState(state, date) {
  if (state.schemaVersion !== 1 || state.kind !== 'toss_consumer_daily_state' || state.collectionDateKst !== date
    || !Array.isArray(state.runs) || !Array.isArray(state.products) || !Array.isArray(state.notSeen)) fail('TOSS_ARCHIVE_STATE_INVALID');
  if (state.runs.length > 2_000 || state.products.length > MAX_INPUT_PRODUCTS || state.notSeen.length > MAX_INPUT_PRODUCTS * 2) fail('TOSS_ARCHIVE_STATE_LIMIT');
}

function assertStreamState(state, streamHash) {
  if (state.schemaVersion !== 1 || state.kind !== 'toss_consumer_stream_state' || state.streamHash !== streamHash
    || !Array.isArray(state.products) || state.products.length > MAX_INPUT_PRODUCTS) fail('TOSS_ARCHIVE_STATE_INVALID');
}

function mergeProduct(dayProducts, product, run) {
  const previous = dayProducts.get(product.productId) || {
    productId: product.productId,
    tacaItemId: product.tacaItemId,
    tacaId: product.tacaId,
    title: product.title,
    productUrl: product.productUrl,
    firstSeenAt: run.observedAt,
    lastSeenAt: run.observedAt,
    latestObservedAt: null,
    latestPriceKrw: null,
    latestStockStatus: 'unknown',
    observations: [],
    stockHistory: [],
  };
  const alreadyAdded = previous.observations.some(item => item.snapshotId === run.snapshotId);
  if (!alreadyAdded) {
    previous.observations.push({
      snapshotId: run.snapshotId,
      observedAt: run.observedAt,
      promotionDate: run.promotionDate,
      sourceOperation: run.source.operation,
      categoryId: run.source.categoryId,
      priceKrw: product.priceKrw,
      priceKind: product.priceKind,
      priceLabel: product.priceLabel,
      shippingKnown: product.shippingKnown,
      todayDeal: product.todayDeal,
      stockStatus: product.stockStatus,
      ...(product.stockSignals ? { stockSignals: product.stockSignals } : {}),
      stockTransition: product.stockTransition ?? null,
      stockHistoryRecord: product.historyRecordPath ?? null,
    });
  }
  previous.observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.snapshotId.localeCompare(b.snapshotId));
  previous.firstSeenAt = previous.observations[0].observedAt;
  previous.lastSeenAt = previous.observations[previous.observations.length - 1].observedAt;
  const latest = previous.observations[previous.observations.length - 1];
  previous.latestObservedAt = latest.observedAt;
  previous.latestPriceKrw = latest.priceKrw;
  previous.latestStockStatus = latest.stockStatus;
  previous.title = product.title;
  previous.productUrl = product.productUrl;
  previous.tacaItemId = product.tacaItemId ?? previous.tacaItemId;
  previous.tacaId = product.tacaId ?? previous.tacaId;
  let priorStatus = null;
  previous.stockHistory = [];
  for (const observation of previous.observations) {
    if (observation.stockStatus !== priorStatus) {
      previous.stockHistory.push({
        observedAt: observation.observedAt,
        snapshotId: observation.snapshotId,
        from: priorStatus,
        to: observation.stockStatus,
        sourceOperation: observation.sourceOperation,
      });
      priorStatus = observation.stockStatus;
    }
  }
  dayProducts.set(product.productId, previous);
}

function productPaths(productId, collectionDateKst, snapshotId) {
  const productHash = sha256(productId);
  const observationPath = normalizedRelative('stock-history', productHash, collectionDateKst, snapshotId + '.json');
  const statePath = normalizedRelative('state', 'products', productHash + '.json');
  return { observationPath, statePath };
}

function validatePendingDrive(value) {
  if (value.schemaVersion !== 1 || value.kind !== 'toss_consumer_pending_drive' || !Array.isArray(value.files)
    || value.files.length > MAX_PENDING_DRIVE_FILES) fail('TOSS_ARCHIVE_PENDING_STATE_INVALID');
  let totalBytes = 0;
  const files = [];
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || typeof file.relativePath !== 'string'
      || !/^(?:snapshots|stock-history|days)\/[A-Za-z0-9._/-]+\.json$/.test(file.relativePath)
      || file.relativePath.split('/').some(segment => segment === '.' || segment === '..')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_STATE_BYTES
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('TOSS_ARCHIVE_PENDING_STATE_INVALID');
    totalBytes += file.bytes;
    files.push({ relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 });
  }
  if (totalBytes > MAX_PENDING_DRIVE_BYTES) fail('TOSS_ARCHIVE_PENDING_LIMIT');
  return { schemaVersion: 1, kind: 'toss_consumer_pending_drive', files: uniqueSorted(files, item => item.relativePath) };
}

async function appendPendingDrive(localRoot, newFiles) {
  const relativePath = normalizedRelative('state', 'pending-drive.json');
  const file = path.join(localRoot, relativePath);
  const prior = await readJson(file, { schemaVersion: 1, kind: 'toss_consumer_pending_drive', files: [] });
  const validated = validatePendingDrive(prior);
  const byPath = new Map(validated.files.map(entry => [entry.relativePath, entry]));
  for (const entry of newFiles) {
    const record = { relativePath: entry.relativePath, bytes: entry.bytes, sha256: entry.sha256 };
    const old = byPath.get(record.relativePath);
    if (old && (old.bytes !== record.bytes || old.sha256 !== record.sha256)) fail('TOSS_ARCHIVE_IMMUTABLE_COLLISION');
    byPath.set(record.relativePath, record);
  }
  const next = validatePendingDrive({ schemaVersion: 1, kind: 'toss_consumer_pending_drive', files: [...byPath.values()] });
  await writeMutableJson(file, next);
  return next;
}

async function syncPendingDrive(localRoot, driveRoot, currentPaths) {
  const pendingFile = path.join(localRoot, 'state', 'pending-drive.json');
  const pending = validatePendingDrive(await readJson(pendingFile, { schemaVersion: 1, kind: 'toss_consumer_pending_drive', files: [] }));
  const synced = [];
  for (const entry of pending.files) {
    const source = path.join(localRoot, entry.relativePath);
    const sourceStat = await lstat(source).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== entry.bytes) fail('TOSS_ARCHIVE_PENDING_SOURCE_MISSING');
    const bytes = await readFile(source);
    if (sha256(bytes) !== entry.sha256) fail('TOSS_ARCHIVE_PENDING_SOURCE_MISMATCH');
    synced.push(await writeImmutableBytes(driveRoot, entry.relativePath, bytes));
  }
  await writeMutableJson(pendingFile, { schemaVersion: 1, kind: 'toss_consumer_pending_drive', files: [] });
  const currentSet = new Set(currentPaths);
  return {
    files: synced,
    backfilledCount: pending.files.filter(entry => !currentSet.has(entry.relativePath)).length,
    pendingCount: 0,
  };
}

async function observeProduct(localRoot, product, run, streamHash) {
  const paths = productPaths(product.productId, run.collectionDateKst, run.snapshotId);
  await ensureDirectory(localRoot, path.dirname(paths.observationPath));
  await ensureDirectory(localRoot, path.dirname(paths.statePath));
  let state = await readJson(path.join(localRoot, paths.statePath), {
    schemaVersion: 1,
    kind: 'toss_consumer_product_state',
    productId: product.productId,
    latestObservedAt: null,
    latestStockStatus: null,
  });
  if (state.schemaVersion !== 1 || state.kind !== 'toss_consumer_product_state' || state.productId !== product.productId) {
    fail('TOSS_ARCHIVE_STATE_INVALID');
  }
  const observationFile = path.join(localRoot, paths.observationPath);
  let event = await readJson(observationFile, null);
  if (event && (event.schemaVersion !== 1 || event.kind !== 'toss_consumer_stock_observation'
    || event.snapshotId !== run.snapshotId || event.productId !== product.productId)) fail('TOSS_ARCHIVE_STATE_INVALID');

  const newer = !state.latestObservedAt || run.observedAt > state.latestObservedAt;
  if (!event) {
    let stockTransition = null;
    if (newer && state.latestStockStatus !== product.stockStatus) {
      stockTransition = { from: state.latestStockStatus, to: product.stockStatus };
    }
    event = {
      schemaVersion: 1,
      kind: 'toss_consumer_stock_observation',
      productId: product.productId,
      tacaItemId: product.tacaItemId,
      tacaId: product.tacaId,
      title: product.title,
      productUrl: product.productUrl,
      observedAt: run.observedAt,
      collectionDateKst: run.collectionDateKst,
      promotionDate: run.promotionDate,
      priceKrw: product.priceKrw,
      priceKind: product.priceKind,
      priceLabel: product.priceLabel,
      shippingKnown: product.shippingKnown,
      todayDeal: product.todayDeal,
      stockStatus: product.stockStatus,
      ...(product.stockSignals ? { stockSignals: product.stockSignals } : {}),
      stockTransition,
      source: run.source,
      coverage: run.coverage,
      snapshotId: run.snapshotId,
      streamHash,
    };
    await writeImmutableBytes(localRoot, paths.observationPath, jsonBytes(event));
  }
  if (newer) {
    state = {
      schemaVersion: 1,
      kind: 'toss_consumer_product_state',
      productId: product.productId,
      latestObservedAt: run.observedAt,
      latestStockStatus: product.stockStatus,
      latestSnapshotId: run.snapshotId,
    };
    await writeMutableJson(path.join(localRoot, paths.statePath), state);
  }
  return {
    ...product,
    stockTransition: event.stockTransition,
    historyRecordPath: paths.observationPath,
    historyRecordReadbackVerified: true,
  };
}

function normalizedRelative(...parts) {
  return parts.join('/').replace(/\\/g, '/');
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('TOSS_ARCHIVE_CLOCK_INVALID');
  return date.toISOString();
}

/**
 * Save one sanitized consumer-web observation locally and mirror immutable records to the
 * configured Google Drive desktop mount. A local readback never proves cloud synchronization.
 */
export async function archiveTossWebSnapshot(snapshot, {
  localRoot = DEFAULT_LOCAL_ROOT,
  driveRoot = DEFAULT_DRIVE_ROOT,
  now = () => new Date(),
} = {}) {
  let localCommitted = false;
  const normalizedLocalRoot = path.resolve(localRoot);
  const normalizedDriveRoot = driveRoot === false || driveRoot === null ? null : path.resolve(driveRoot);
  let release;
  try {
    const normalized = normalizeSnapshot(snapshot);
    const observedAt = normalized.observedAt;
    const streamHash = sha256(canonicalJson(normalized.stream));
    const base = { ...normalized };
    const snapshotId = sha256(canonicalJson(base));
    const run = { ...base, snapshotId };
    const runBytes = jsonBytes(run);
    const dayDate = normalized.collectionDateKst;
    const runRelativePath = normalizedRelative('snapshots', dayDate, snapshotId + '.json');
    const dayStateRelativePath = normalizedRelative('state', 'days', dayDate + '.json');
    const streamStateRelativePath = normalizedRelative('state', 'streams', streamHash + '.json');
    const dayStatePath = path.join(normalizedLocalRoot, dayStateRelativePath);
    const streamStatePath = path.join(normalizedLocalRoot, streamStateRelativePath);

    await mkdir(normalizedLocalRoot, { recursive: true });
    const rootStat = await lstat(normalizedLocalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('TOSS_ARCHIVE_ROOT_UNAVAILABLE');
    release = await acquireRunLock(path.join(normalizedLocalRoot, '.locks'));
    await ensureDirectory(normalizedLocalRoot, path.dirname(runRelativePath));
    await ensureDirectory(normalizedLocalRoot, path.dirname(dayStateRelativePath));
    await ensureDirectory(normalizedLocalRoot, path.dirname(streamStateRelativePath));

    let dayState = await readJson(dayStatePath, newDayState(dayDate));
    assertDayState(dayState, dayDate);
    const existingRun = dayState.runs.some(item => item.snapshotId === snapshotId);
    const streamState = await readJson(streamStatePath, newStreamState(streamHash, normalized.stream));
    assertStreamState(streamState, streamHash);

    const observedProducts = [];
    for (const product of normalized.products) {
      observedProducts.push(await observeProduct(normalizedLocalRoot, product, run, streamHash));
    }

    if (!existingRun) {
      const productMap = new Map(dayState.products.map(item => [item.productId, item]));
      for (const product of observedProducts) mergeProduct(productMap, product, run);
      dayState.products = [...productMap.values()].sort((a, b) => a.productId.localeCompare(b.productId));
      dayState.runs.push({
        snapshotId,
        observedAt,
        promotionDate: normalized.promotionDate,
        source: normalized.source,
        coverage: normalized.coverage,
        productCount: normalized.products.length,
        snapshotPath: runRelativePath,
      });
      dayState.runs.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.snapshotId.localeCompare(b.snapshotId));

      if (normalized.coverage.complete
        && (!streamState.lastCompleteObservedAt || observedAt > streamState.lastCompleteObservedAt)) {
        const current = new Map(observedProducts.map(item => [item.productId, item]));
        const seenAt = streamState.lastCompleteObservedAt;
        for (const prior of streamState.products) {
          if (current.has(prior.productId)) continue;
          dayState.notSeen.push({
            productId: prior.productId,
            tacaItemId: prior.tacaItemId ?? null,
            tacaId: prior.tacaId ?? null,
            title: prior.title,
            productUrl: prior.productUrl ?? null,
            lastSeenAt: prior.lastSeenAt,
            notSeenAt: observedAt,
            source: normalized.source,
            streamHash,
            snapshotId,
            status: 'not_seen',
            lastCompleteFeedAt: seenAt,
          });
        }
        dayState.notSeen = uniqueSorted(dayState.notSeen, item => item.snapshotId + ':' + item.productId);
        streamState.products = observedProducts.map(item => ({
          productId: item.productId,
          tacaItemId: item.tacaItemId,
          tacaId: item.tacaId,
          title: item.title,
          productUrl: item.productUrl,
          stockStatus: item.stockStatus,
          lastSeenAt: observedAt,
        }));
        streamState.lastCompleteObservedAt = observedAt;
        streamState.lastCompleteSnapshotId = snapshotId;
      }
      dayState.updatedAt = nowIso(now);
      await writeImmutableBytes(normalizedLocalRoot, runRelativePath, runBytes);
      await writeMutableJson(dayStatePath, dayState);
      await writeMutableJson(streamStatePath, streamState);
      localCommitted = true;
    } else if (normalized.coverage.complete
      && (!streamState.lastCompleteObservedAt || observedAt > streamState.lastCompleteObservedAt)) {
      // Repair state if a prior run wrote the immutable snapshot/day merge but stopped before checkpointing.
      const current = new Map(observedProducts.map(item => [item.productId, item]));
      for (const prior of streamState.products) {
        if (current.has(prior.productId)) continue;
        dayState.notSeen.push({
          productId: prior.productId,
          tacaItemId: prior.tacaItemId ?? null,
          tacaId: prior.tacaId ?? null,
          title: prior.title,
          productUrl: prior.productUrl ?? null,
          lastSeenAt: prior.lastSeenAt,
          notSeenAt: observedAt,
          source: normalized.source,
          streamHash,
          snapshotId,
          status: 'not_seen',
          lastCompleteFeedAt: streamState.lastCompleteObservedAt,
        });
      }
      dayState.notSeen = uniqueSorted(dayState.notSeen, item => item.snapshotId + ':' + item.productId);
      streamState.products = observedProducts.map(item => ({
        productId: item.productId,
        tacaItemId: item.tacaItemId,
        tacaId: item.tacaId,
        title: item.title,
        productUrl: item.productUrl,
        stockStatus: item.stockStatus,
        lastSeenAt: observedAt,
      }));
      streamState.lastCompleteObservedAt = observedAt;
      streamState.lastCompleteSnapshotId = snapshotId;
      dayState.updatedAt = nowIso(now);
      await writeMutableJson(dayStatePath, dayState);
      await writeMutableJson(streamStatePath, streamState);
      localCommitted = true;
    }

    // The cumulative daily merge is immutable too; each distinct state gets its own hash path.
    const dailyMergeBase = {
      schemaVersion: 1,
      kind: 'toss_consumer_daily_merge',
      collectionDateKst: dayDate,
      promotionDates: [...new Set(dayState.runs.map(item => item.promotionDate).filter(Boolean))].sort(),
      runs: dayState.runs,
      products: dayState.products,
      notSeen: dayState.notSeen,
    };
    const mergeId = sha256(canonicalJson(dailyMergeBase));
    const dailyMerge = { ...dailyMergeBase, mergeId };
    const mergeRelativePath = normalizedRelative('days', dayDate, mergeId + '.json');
    const mergeBytes = jsonBytes(dailyMerge);
    const historyFiles = [];
    for (const product of observedProducts) {
      const location = product.historyRecordPath;
      const bytes = await readFile(path.join(normalizedLocalRoot, location));
      historyFiles.push({ relativePath: location, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const localRun = await writeImmutableBytes(normalizedLocalRoot, runRelativePath, runBytes);
    const localMerge = await writeImmutableBytes(normalizedLocalRoot, mergeRelativePath, mergeBytes);
    localCommitted = true;
    const mirrorEntries = [
      localRun,
      ...historyFiles,
      localMerge,
    ];
    const pending = await appendPendingDrive(normalizedLocalRoot, mirrorEntries);

    let driveCommitted = false;
    let driveFiles = [];
    let driveBackfilledFileCount = 0;
    let pendingDriveFileCount = pending.files.length;
    if (normalizedDriveRoot) {
      try {
        const driveStat = await lstat(normalizedDriveRoot).catch(() => null);
        if (!driveStat?.isDirectory() || driveStat.isSymbolicLink()) fail('TOSS_ARCHIVE_DRIVE_ROOT_UNAVAILABLE');
        const sync = await syncPendingDrive(normalizedLocalRoot, normalizedDriveRoot,
          [runRelativePath, ...historyFiles.map(file => file.relativePath), mergeRelativePath]);
        driveFiles = sync.files;
        driveBackfilledFileCount = sync.backfilledCount;
        pendingDriveFileCount = sync.pendingCount;
        driveCommitted = driveFiles.every(file => file.readbackVerified);
      } catch (error) {
        const stillPending = await readJson(path.join(normalizedLocalRoot, 'state', 'pending-drive.json'), {
          schemaVersion: 1, kind: 'toss_consumer_pending_drive', files: [],
        }).catch(() => ({ files: [] }));
        return {
          ok: false,
          kind: 'toss_consumer_archive_receipt',
          errorCode: safeCode(error),
          collectionDateKst: dayDate,
          observedAt,
          promotionDate: normalized.promotionDate,
          snapshotId,
          mergeId,
          localCommitted,
          localReadbackVerified: true,
          driveCommitted: false,
          driveReadbackVerified: false,
          pendingDriveFileCount: Array.isArray(stillPending.files) ? stillPending.files.length : pendingDriveFileCount,
          cloudSyncVerified: false,
          collectorStatusUnaffected: true,
        };
      }
    }
    return {
      ok: normalizedDriveRoot ? driveCommitted : true,
      kind: 'toss_consumer_archive_receipt',
      collectionDateKst: dayDate,
      observedAt,
      promotionDate: normalized.promotionDate,
      sourceOperation: normalized.source.operation,
      coverage: normalized.coverage,
      productCount: normalized.products.length,
      invalidProductCount: normalized.coverage.invalidProductCount,
      stockHistoryRecordCount: historyFiles.length,
      notSeenCount: dayState.notSeen.filter(item => item.snapshotId === snapshotId).length,
      snapshotId,
      mergeId,
      localCommitted,
      localReadbackVerified: Boolean(localRun.readbackVerified && localMerge.readbackVerified),
      driveCommitted,
      driveFileCount: driveFiles.length,
      driveBackfilledFileCount,
      pendingDriveFileCount,
      driveReadbackVerified: driveFiles.length ? driveFiles.every(file => file.readbackVerified) : null,
      cloudSyncVerified: false,
      collectorStatusUnaffected: true,
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'toss_consumer_archive_receipt',
      errorCode: safeCode(error),
      localCommitted,
      driveCommitted: false,
      cloudSyncVerified: false,
      collectorStatusUnaffected: true,
    };
  } finally {
    if (release) await release().catch(() => {});
  }
}

export async function main(args) {
  const [inputFile, ...rest] = args;
  if (!inputFile) fail('TOSS_ARCHIVE_USAGE');
  const options = {};
  for (const arg of rest) {
    const match = /^--(local-root|drive-root)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) fail('TOSS_ARCHIVE_OPTION_INVALID');
    options[match[1] === 'local-root' ? 'localRoot' : 'driveRoot'] = match[2];
  }
  let snapshot;
  try {
    const stat = await lstat(inputFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) fail('TOSS_ARCHIVE_INPUT_INVALID');
    snapshot = JSON.parse(await readFile(inputFile, 'utf8'));
  } catch (error) {
    const code = safeCode(error);
    console.log(JSON.stringify({ ok: false, kind: 'toss_consumer_archive_receipt', errorCode: code, collectorStatusUnaffected: true }));
    process.exitCode = 1;
    return;
  }
  const receipt = await archiveTossWebSnapshot(snapshot, options);
  console.log(JSON.stringify(receipt));
  if (!receipt.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(safeCode(error));
    process.exitCode = 1;
  });
}
