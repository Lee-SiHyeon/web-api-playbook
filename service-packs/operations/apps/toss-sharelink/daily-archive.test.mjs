import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveTossWebSnapshot, collectionDateKst, renameNoReplaceWindows } from './daily-archive.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const snapshot = (observedAt, products, overrides = {}) => ({
  schemaVersion: 1,
  source: { kind: 'toss_consumer_web', operation: 'today_deals' },
  observedAt,
  promotionDate: '2026-10-06',
  coverage: { pages: 1, pageLimit: 3, itemCount: products.length, hasNext: false, complete: true },
  products,
  ...overrides,
});

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'toss-daily-archive-'));
  const localRoot = path.join(base, 'local');
  const driveRoot = path.join(base, 'drive');
  await mkdir(driveRoot);
  t.after(() => rm(base, { recursive: true, force: true }));
  const archive = (input, now) => archiveTossWebSnapshot(input, { localRoot, driveRoot, now: () => new Date(now) });
  return { base, localRoot, driveRoot, archive };
}

async function jsonFiles(directory) {
  const names = await readdir(directory);
  return Promise.all(names.filter(name => name.endsWith('.json')).map(async name => ({
    name,
    value: JSON.parse(await readFile(path.join(directory, name), 'utf8')),
  })));
}

test('collection date uses observed timestamp in KST and leaves promotion date independent', async t => {
  assert.equal(collectionDateKst('2026-10-06T14:59:59.000Z'), '2026-10-06');
  assert.equal(collectionDateKst('2026-10-06T15:00:00.000Z'), '2026-10-07');
  assert.throws(() => collectionDateKst('2026-02-30T10:00:00.000Z'), { code: 'TOSS_ARCHIVE_OBSERVED_AT_INVALID' });
  const f = await fixture(t);
  const result = await f.archive(snapshot('2026-10-06T15:00:00.000Z', []), '2026-10-07T00:01:00+09:00');
  assert.equal(result.ok, true);
  assert.equal(result.collectionDateKst, '2026-10-07');
  assert.equal(result.promotionDate, '2026-10-06');
});

test('Windows no-replace promotion handles MAX_PATH temp names and preserves collisions', { skip: process.platform !== 'win32' }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'toss-archive-maxpath-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const destinationName = hash('long-path-snapshot') + '.json';
  const temporarySuffix = `.${process.pid}.${randomUUID()}.tmp`;
  const paddedLength = 261 - base.length - 2 - destinationName.length - temporarySuffix.length;
  assert.ok(paddedLength > 0 && paddedLength < 255);
  const directory = path.join(base, 'p'.repeat(paddedLength));
  await mkdir(directory);
  const destination = path.join(directory, destinationName);
  const temporary = destination + temporarySuffix;
  assert.ok(destination.length < 260);
  assert.ok(temporary.length >= 260);

  await writeFile(temporary, 'first immutable bytes');
  await renameNoReplaceWindows(temporary, destination);
  assert.equal(await readFile(destination, 'utf8'), 'first immutable bytes');

  const collisionSource = path.join(directory, 'collision.tmp');
  await writeFile(collisionSource, 'replacement bytes');
  await assert.rejects(renameNoReplaceWindows(collisionSource, destination));
  assert.equal(await readFile(destination, 'utf8'), 'first immutable bytes');
  assert.equal(await readFile(collisionSource, 'utf8'), 'replacement bytes');
});

test('repeating an identical observation is idempotent in local archive and Drive mount', async t => {
  const f = await fixture(t);
  const input = snapshot('2026-10-06T14:30:00.000Z', [{
    productId: 'item-1', tacaItemId: '135279807', tacaId: '155697855',
    title: '햇반 윤기가득쌀밥 210g 36개', productUrl: 'https://toss.shopping/t/155697855',
    priceKrw: 30900, priceKind: 'displayed', priceLabel: '오늘특가', shippingKnown: true, stockStatus: 'in_stock',
    todayDeal: { startAt: '2026-10-06T00:00:00+09:00', endAt: '2026-10-07T00:00:00+09:00' },
  }], { source: { kind: 'toss_consumer_web', origin: 'https://sharelink.toss.im', operation: 'today_deals' } });
  const first = await f.archive(input, '2026-10-06T23:31:00+09:00');
  const second = await f.archive(input, '2026-10-07T00:00:00+09:00');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(first.mergeId, second.mergeId);
  assert.equal(second.cloudSyncVerified, false);
  assert.equal(second.driveReadbackVerified, true);
  const runDirectory = path.join(f.driveRoot, 'snapshots', '2026-10-06');
  const mergeDirectory = path.join(f.driveRoot, 'days', '2026-10-06');
  assert.equal((await readdir(runDirectory)).length, 1);
  assert.equal((await readdir(mergeDirectory)).length, 1);
  const [merge] = await jsonFiles(mergeDirectory);
  assert.equal(merge.value.products[0].observations.length, 1);
  assert.equal(merge.value.products[0].tacaItemId, '135279807');
  assert.equal(merge.value.products[0].tacaId, '155697855');
  assert.equal(merge.value.products[0].observations[0].todayDeal.startAt, '2026-10-05T15:00:00.000Z');
  assert.equal(merge.value.products[0].observations[0].todayDeal.endAt, '2026-10-06T15:00:00.000Z');
  assert.equal(merge.value.runs[0].source.origin, 'https://sharelink.toss.im');
});

test('stock history preserves sold-out and later in-stock transitions across KST days', async t => {
  const f = await fixture(t);
  const product = status => ({
    productId: 'rice-36', tacaItemId: '135279807', tacaId: '155697855',
    title: '쌀밥 36개', productUrl: 'https://toss.shopping/t/155697855', priceKrw: 30900, stockStatus: status,
  });
  const observations = [
    snapshot('2026-10-06T14:58:00.000Z', [product('in_stock')]),
    snapshot('2026-10-06T15:02:00.000Z', [product('sold_out')]),
    snapshot('2026-10-06T16:00:00.000Z', [product('in_stock')]),
  ];
  const results = [];
  for (const input of observations) results.push(await f.archive(input, input.observedAt));
  assert.ok(results.every(result => result.ok));
  const productHash = hash('rice-36');
  const eventDirectory = path.join(f.driveRoot, 'stock-history', productHash);
  const dateFolders = await readdir(eventDirectory);
  const events = [];
  for (const date of dateFolders) events.push(...await jsonFiles(path.join(eventDirectory, date)));
  events.sort((a, b) => a.value.observedAt.localeCompare(b.value.observedAt));
  assert.deepEqual(events.map(item => item.value.stockStatus), ['in_stock', 'sold_out', 'in_stock']);
  assert.deepEqual(events.map(item => item.value.stockTransition?.to ?? null), ['in_stock', 'sold_out', 'in_stock']);
  assert.equal(events[1].value.stockTransition.from, 'in_stock');
  assert.equal(events[2].value.stockTransition.from, 'sold_out');
});

test('stock history preserves allowlisted conflicting Toss stock signals without extra fields', async t => {
  const f = await fixture(t);
  const stockSignals = {
    isSoldOut: false,
    status: 'SOLD_OUT',
    conflict: true,
    accessToken: 'sentinel-token-must-not-be-archived',
  };
  const input = snapshot('2026-10-06T10:00:00.000Z', [{
    productId: 'mixing-bowl',
    title: '믹싱볼',
    stockStatus: 'sold_out',
    stockSignals,
  }]);
  const result = await f.archive(input, input.observedAt);
  assert.equal(result.ok, true);
  const expected = { isSoldOut: false, status: 'SOLD_OUT', conflict: true };

  const runDirectory = path.join(f.driveRoot, 'snapshots', '2026-10-06');
  const [run] = await jsonFiles(runDirectory);
  assert.deepEqual(run.value.products[0].stockSignals, expected);

  const historyDirectory = path.join(f.driveRoot, 'stock-history', hash('mixing-bowl'), '2026-10-06');
  const [history] = await jsonFiles(historyDirectory);
  assert.deepEqual(history.value.stockSignals, expected);

  const mergeDirectory = path.join(f.driveRoot, 'days', '2026-10-06');
  const [merge] = await jsonFiles(mergeDirectory);
  assert.deepEqual(merge.value.products[0].observations[0].stockSignals, expected);
  assert.equal(JSON.stringify({ run, history, merge }).includes('sentinel-token-must-not-be-archived'), false);
});

test('unknown stock stays unknown and a product missing from a partial feed is not marked sold out', async t => {
  const f = await fixture(t);
  const present = snapshot('2026-10-06T10:00:00.000Z', [{
    productId: 'x-1', title: '상품 X', productUrl: 'https://toss.shopping/t/x-1', stockStatus: 'in_stock',
  }]);
  assert.equal((await f.archive(present, present.observedAt)).ok, true);
  const partial = snapshot('2026-10-06T11:00:00.000Z', [], {
    coverage: { pages: 1, pageLimit: 3, itemCount: 0, hasNext: true, complete: false },
  });
  const partialReceipt = await f.archive(partial, partial.observedAt);
  assert.equal(partialReceipt.ok, true);
  assert.equal(partialReceipt.notSeenCount, 0);
  const noPages = snapshot('2026-10-06T11:30:00.000Z', [], {
    coverage: { pages: 0, pageLimit: 3, itemCount: 0, hasNext: false, complete: true },
  });
  const noPagesReceipt = await f.archive(noPages, noPages.observedAt);
  assert.equal(noPagesReceipt.coverage.complete, false);
  assert.equal(noPagesReceipt.coverage.status, 'partial');
  assert.equal(noPagesReceipt.notSeenCount, 0);
  const missingPageCount = snapshot('2026-10-06T11:45:00.000Z', [], {
    coverage: { pageLimit: 3, itemCount: 0, hasNext: false, complete: true },
  });
  assert.equal((await f.archive(missingPageCount, missingPageCount.observedAt)).coverage.complete, false);
  const incoherentLimit = snapshot('2026-10-06T11:50:00.000Z', [], {
    coverage: { pages: 2, pageLimit: 1, itemCount: 0, hasNext: false, complete: true },
  });
  assert.equal((await f.archive(incoherentLimit, incoherentLimit.observedAt)).coverage.complete, false);
  const unknown = snapshot('2026-10-06T12:00:00.000Z', [{
    productId: 'x-1', title: '상품 X', productUrl: 'https://toss.shopping/t/x-1',
  }], {
    coverage: { pages: 1, pageLimit: 3, itemCount: 1, hasNext: false, complete: true },
  });
  assert.equal((await f.archive(unknown, unknown.observedAt)).ok, true);
  const productHash = hash('x-1');
  const historyFiles = (await jsonFiles(path.join(f.driveRoot, 'stock-history', productHash, '2026-10-06')))
    .sort((a, b) => a.value.observedAt.localeCompare(b.value.observedAt));
  assert.equal(historyFiles.at(-1).value.stockStatus, 'unknown');
  assert.notEqual(historyFiles.at(-1).value.stockStatus, 'sold_out');
});

test('a complete exhausted feed records disappearance as not_seen and leaves prior stock state intact', async t => {
  const f = await fixture(t);
  const present = snapshot('2026-10-06T10:00:00.000Z', [{
    productId: 'x-2', title: '상품 Y', productUrl: 'https://toss.shopping/t/x-2', stockStatus: 'in_stock',
  }]);
  await f.archive(present, present.observedAt);
  const absent = snapshot('2026-10-06T12:00:00.000Z', []);
  const receipt = await f.archive(absent, absent.observedAt);
  assert.equal(receipt.notSeenCount, 1);
  const mergeFiles = await jsonFiles(path.join(f.driveRoot, 'days', '2026-10-06'));
  const latest = mergeFiles.map(file => file.value).sort((a, b) => a.runs.length - b.runs.length).at(-1);
  assert.equal(latest.notSeen[0].status, 'not_seen');
  assert.equal(latest.notSeen[0].productId, 'x-2');
  assert.equal(latest.products[0].latestStockStatus, 'in_stock');
  const stateFile = path.join(f.localRoot, 'state', 'products', hash('x-2') + '.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.latestStockStatus, 'in_stock');
});

test('unsafe origins and unallowlisted fields are omitted; official-source input is rejected', async t => {
  const f = await fixture(t);
  const input = snapshot('2026-10-06T10:00:00.000Z', [{
    productId: 'safe-1', title: '상품 Z', productUrl: 'https://example.invalid/p?token=sentinel-query',
    accessToken: 'sentinel-product-token', stockStatus: 'unknown',
  }], {
    source: { kind: 'toss_consumer_web', origin: 'https://evil.invalid', operation: 'today_deals', authorization: 'sentinel-source-token' },
    cookies: 'sentinel-cookie',
    rawBody: 'sentinel-raw-body',
  });
  const result = await f.archive(input, input.observedAt);
  assert.equal(result.ok, true);
  const files = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(await readFile(full, 'utf8'));
    }
  }
  await walk(f.driveRoot);
  const stored = files.join('\n');
  for (const sentinel of ['sentinel-query', 'sentinel-product-token', 'sentinel-source-token', 'sentinel-cookie', 'sentinel-raw-body']) {
    assert.equal(stored.includes(sentinel), false);
  }
  const mergeDirectory = path.join(f.driveRoot, 'days', '2026-10-06');
  const [merge] = await jsonFiles(mergeDirectory);
  assert.equal(merge.value.products[0].productUrl, null);
  assert.equal(merge.value.runs[0].source.origin, null);

  const blocked = await f.archive(snapshot('2026-10-06T13:00:00.000Z', [], {
    source: { kind: 'toss_openapi', operation: 'today_deals' },
  }), '2026-10-06T13:00:00.000Z');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'TOSS_ARCHIVE_SOURCE_REJECTED');
});

test('archive failure is returned separately and does not re-label collector success', async t => {
  const f = await fixture(t);
  const result = await archiveTossWebSnapshot(snapshot('bad-time', []), {
    localRoot: f.localRoot,
    driveRoot: f.driveRoot,
  });
  assert.equal(result.ok, false);
  assert.equal(result.collectorStatusUnaffected, true);
  assert.equal(result.cloudSyncVerified, false);
  assert.equal(result.errorCode, 'TOSS_ARCHIVE_OBSERVED_AT_INVALID');
});

test('blocked consumer collection is archived as a zero-product receipt with explicit bounded status', async t => {
  const f = await fixture(t);
  const blocked = snapshot('2026-10-06T15:05:00.000Z', [], {
    coverage: {
      status: 'blocked', errorCode: 'TOSS_REAUTH_REQUIRED',
      pages: 0, pageLimit: 3, itemCount: 0, hasNext: null, complete: false,
    },
  });
  const result = await f.archive(blocked, blocked.observedAt);
  assert.equal(result.ok, true);
  assert.equal(result.coverage.status, 'blocked');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.productCount, 0);
  assert.equal(result.invalidProductCount, 0);
  const [merge] = await jsonFiles(path.join(f.driveRoot, 'days', '2026-10-07'));
  assert.equal(merge.value.products.length, 0);
  assert.equal(merge.value.runs[0].coverage.errorCode, 'TOSS_REAUTH_REQUIRED');
});

test('a later run backfills immutable files left pending by an unavailable Drive mount', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'toss-drive-backfill-'));
  const localRoot = path.join(base, 'local');
  const driveRoot = path.join(base, 'drive-later');
  t.after(() => rm(base, { recursive: true, force: true }));
  const makeSnapshot = (observedAt, stockStatus) => snapshot(observedAt, [{
    productId: 'pending-1', title: '복구 대상 상품', productUrl: 'https://toss.shopping/t/pending-1', stockStatus,
  }]);
  const firstInput = makeSnapshot('2026-10-06T10:00:00.000Z', 'in_stock');
  const first = await archiveTossWebSnapshot(firstInput, { localRoot, driveRoot, now: () => new Date(firstInput.observedAt) });
  assert.equal(first.ok, false);
  assert.equal(first.localCommitted, true);
  assert.equal(first.driveCommitted, false);
  assert.equal(first.pendingDriveFileCount, 3);
  assert.equal(first.collectorStatusUnaffected, true);

  await mkdir(driveRoot);
  const secondInput = makeSnapshot('2026-10-06T12:00:00.000Z', 'sold_out');
  const second = await archiveTossWebSnapshot(secondInput, { localRoot, driveRoot, now: () => new Date(secondInput.observedAt) });
  assert.equal(second.ok, true);
  assert.equal(second.driveCommitted, true);
  assert.equal(second.driveBackfilledFileCount, 3);
  assert.equal(second.driveFileCount, 6);
  assert.equal(second.pendingDriveFileCount, 0);
  assert.equal(second.driveReadbackVerified, true);

  const pending = JSON.parse(await readFile(path.join(localRoot, 'state', 'pending-drive.json'), 'utf8'));
  assert.deepEqual(pending.files, []);
  assert.equal((await readdir(path.join(driveRoot, 'snapshots', '2026-10-06'))).length, 2);
  const [merge] = (await jsonFiles(path.join(driveRoot, 'days', '2026-10-06')))
    .map(file => file.value).sort((a, b) => a.runs.length - b.runs.length).reverse();
  assert.equal(merge.runs.length, 2);
  assert.equal(merge.products[0].observations.length, 2);
  assert.equal(merge.products[0].stockHistory.at(-1).to, 'sold_out');
});

test('immutable mirror collision is reported without overwriting the existing destination', async t => {
  const f = await fixture(t);
  const input = snapshot('2026-10-06T10:00:00.000Z', []);
  const first = await f.archive(input, input.observedAt);
  assert.equal(first.ok, true);
  const snapshotDirectory = path.join(f.driveRoot, 'snapshots', '2026-10-06');
  const [snapshotName] = await readdir(snapshotDirectory);
  const destination = path.join(snapshotDirectory, snapshotName);
  await writeFile(destination, 'pre-existing destination bytes');
  const retry = await f.archive(input, '2026-10-06T11:00:00.000Z');
  assert.equal(retry.ok, false);
  assert.equal(retry.errorCode, 'TOSS_ARCHIVE_IMMUTABLE_COLLISION');
  assert.equal(await readFile(destination, 'utf8'), 'pre-existing destination bytes');
});
