import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTossDailySnapshot,
  collectTossTodayItemsSnapshot,
  runTossDailyCollection,
  CURATION_OPERATION,
  TODAY_DEAL_ITEMS_OPERATION,
  TODAY_DEAL_PAGE_LIMIT,
} from './daily-collect.mjs';

const now = () => new Date('2026-10-07T02:00:00.000Z');
const goodCheck = async () => ({ ownerMatched: true });
const completeResponse = (items = []) => ({
  operation: CURATION_OPERATION,
  data: {
    resultType: 'SUCCESS',
    success: {
      sections: [{ items, paging: { nextCursor: null, totalCount: items.length } }],
      paging: { nextCursor: null },
      limited: false,
    },
  },
});
const todayItemsResponse = (items = [], { nextCursor = null, totalCount = 0, limited = false } = {}) => ({
  operation: TODAY_DEAL_ITEMS_OPERATION,
  data: {
    resultType: 'SUCCESS',
    success: {
      sectionCode: 'TODAY_DEAL',
      items,
      paging: { prevCursor: null, nextCursor, totalCount },
      limited,
    },
  },
});
const deal = ({ id = 100, soldOut = false, todayDeal = {
  startAt: '2026-10-07T00:00:00+09:00',
  endAt: '2026-10-07T23:59:59+09:00',
} } = {}) => ({
  productId: id,
  taca: { productView: {
    tacaId: 900 + id,
    tacaItemId: 800 + id,
    productId: id,
    displayName: `상품 ${id}`,
    displayPrice: 12900,
    priceCompositionType: 'NORMAL',
    ...(soldOut === undefined ? {} : { isSoldOut: soldOut }),
  } },
  todayDeal,
  accessToken: 'must-not-be-copied',
});

test('owner read precedes captured curation GET and projects only today deal fields', async () => {
  const calls = [];
  const result = await collectTossDailySnapshot({
    now,
    checkSession: async () => { calls.push('owner'); return { ownerMatched: true }; },
    request: async operation => { calls.push(operation); return completeResponse([deal()]); },
  });
  assert.deepEqual(calls, ['owner', CURATION_OPERATION]);
  assert.equal(result.ownerMatched, true);
  assert.equal(result.snapshot.source.kind, 'toss_consumer_web');
  assert.equal(result.snapshot.source.origin, 'https://sharelink.toss.im');
  assert.equal(result.snapshot.source.operation, CURATION_OPERATION);
  assert.equal(result.snapshot.observedAt, '2026-10-07T02:00:00.000Z');
  assert.equal(result.snapshot.coverage.complete, true);
  assert.equal(result.snapshot.coverage.itemCount, 1);
  assert.equal(result.snapshot.products.length, 1);
  assert.equal(result.snapshot.products[0].productId, '900');
  assert.equal(result.snapshot.products[0].tacaItemId, '900');
  assert.equal(result.snapshot.products[0].stockStatus, 'in_stock');
  assert.equal(result.snapshot.products[0].priceKrw, 12900);
  assert.equal(result.snapshot.products[0].priceLabel, 'Toss displayed price; account eligibility unverified');
  assert.equal(result.snapshot.products[0].shippingKnown, null);
  assert.equal(result.snapshot.products[0].productUrl, null);
  assert.deepEqual(result.snapshot.products[0].todayDeal, {
    startAt: '2026-10-07T00:00:00+09:00',
    endAt: '2026-10-07T23:59:59+09:00',
  });
  assert.equal(JSON.stringify(result.snapshot).includes('must-not-be-copied'), false);
});

test('explicit sold-out rows are retained in the daily-deal product list', async () => {
  const result = await collectTossDailySnapshot({
    now,
    checkSession: goodCheck,
    request: async () => completeResponse([deal({ id: 2, soldOut: true })]),
  });
  assert.equal(result.snapshot.products.length, 1);
  assert.equal(result.snapshot.products[0].stockStatus, 'sold_out');
  assert.equal(result.snapshot.coverage.complete, true);
});

test('variant rows sharing one catalog product remain separate by tacaItemId', async () => {
  const first = deal({ id: 77 });
  first.taca.productView.tacaItemId = 801;
  first.taca.productView.tacaId = 901;
  const second = deal({ id: 77 });
  second.taca.productView.tacaItemId = 802;
  second.taca.productView.tacaId = 902;
  const result = await collectTossDailySnapshot({
    now,
    checkSession: goodCheck,
    request: async () => completeResponse([first, second]),
  });
  assert.equal(result.snapshot.products.length, 2);
  assert.deepEqual(result.snapshot.products.map(product => product.productId), ['801', '802']);
  assert.deepEqual(result.snapshot.products.map(product => product.tacaItemId), ['801', '802']);
  assert.deepEqual(result.snapshot.products.map(product => product.tacaId), ['901', '902']);
});

test('known sold-out lifecycle status excludes a false inventory flag and preserves both signals', async () => {
  for (const status of ['SOLD_OUT', 'TEMPORARILY_SOLD_OUT']) {
    const item = deal({ id: 175 });
    item.taca.productView.status = status;
    item.taca.productView.remainingQuantity = 849;
    const result = await collectTossDailySnapshot({ now, checkSession: goodCheck,
      request: async () => completeResponse([item]) });
    assert.equal(result.snapshot.products[0].stockStatus, 'sold_out');
    assert.deepEqual(result.snapshot.products[0].stockSignals,
      { isSoldOut: false, status, conflict: true });
    assert.equal(result.snapshot.coverage.complete, false);
    assert.ok(result.snapshot.coverage.reasons.includes('deal_stock_signals_conflict'));
    assert.equal('remainingQuantity' in result.snapshot.products[0], false);
  }
});

test('an explicit sold-out inventory flag cannot be overridden by an ongoing lifecycle status', async () => {
  const item = deal({ soldOut: true });
  item.taca.productView.status = 'ON_GOING';
  const result = await collectTossDailySnapshot({ now, checkSession: goodCheck,
    request: async () => completeResponse([item]) });
  assert.equal(result.snapshot.products[0].stockStatus, 'sold_out');
  assert.equal(result.snapshot.products[0].stockSignals.conflict, true);
  assert.ok(result.snapshot.coverage.reasons.includes('deal_stock_signals_conflict'));
});

test('unfamiliar lifecycle status holds a false inventory flag without copying the untrusted status', async () => {
  const item = deal();
  item.taca.productView.status = 'private-session-value';
  const result = await collectTossDailySnapshot({ now, checkSession: goodCheck,
    request: async () => completeResponse([item]) });
  assert.equal(result.snapshot.products[0].stockStatus, 'unknown');
  assert.equal(result.snapshot.products[0].stockSignals.status, null);
  assert.ok(result.snapshot.coverage.reasons.includes('deal_status_unknown'));
  assert.equal(JSON.stringify(result.snapshot).includes('private-session-value'), false);
});

test('ongoing plus an explicit false inventory flag establishes an in-stock observation', async () => {
  const item = deal();
  item.taca.productView.status = 'ON_GOING';
  const result = await collectTossDailySnapshot({ now, checkSession: goodCheck,
    request: async () => completeResponse([item]) });
  assert.equal(result.snapshot.products[0].stockStatus, 'in_stock');
  assert.deepEqual(result.snapshot.products[0].stockSignals,
    { isSoldOut: false, status: 'ON_GOING', conflict: false });
  assert.equal(result.snapshot.coverage.complete, true);
});

test('missing stock and malformed schedule remain unknown and make the observation partial', async () => {
  const item = deal({ id: 3, todayDeal: { startAt: 1791331200000, endAt: null } });
  delete item.taca.productView.isSoldOut;
  const result = await collectTossDailySnapshot({
    now,
    checkSession: goodCheck,
    request: async () => completeResponse([item]),
  });
  assert.equal(result.snapshot.products[0].stockStatus, 'unknown');
  assert.deepEqual(result.snapshot.products[0].todayDeal, { startAt: null, endAt: null });
  assert.equal(result.snapshot.coverage.complete, false);
  assert.deepEqual(result.snapshot.coverage.reasons, ['deal_schedule_unknown', 'deal_stock_unknown']);
});

test('first-page continuation and count mismatch prevent a complete-feed claim', async () => {
  const response = completeResponse([deal()]);
  response.data.success.sections[0].paging = { nextCursor: 'opaque-cursor', totalCount: 7 };
  const result = await collectTossDailySnapshot({
    now,
    checkSession: goodCheck,
    request: async operation => {
      assert.equal(operation, CURATION_OPERATION);
      return response;
    },
  });
  assert.equal(result.snapshot.coverage.complete, false);
  assert.equal(result.snapshot.coverage.hasNext, true);
  assert.ok(result.snapshot.coverage.reasons.includes('section_has_next'));
  assert.equal(JSON.stringify(result.snapshot).includes('opaque-cursor'), false);
});

test('unknown feed paging, limited flags, and malformed deal rows fail closed as partial', async () => {
  const response = completeResponse([deal({ id: 4 }), { todayDeal: {} }]);
  delete response.data.success.paging.nextCursor;
  delete response.data.success.limited;
  response.data.success.sections[0].paging.totalCount = 3;
  const result = await collectTossDailySnapshot({
    now,
    checkSession: goodCheck,
    request: async () => response,
  });
  assert.equal(result.snapshot.products.length, 1);
  assert.equal(result.snapshot.coverage.complete, false);
  assert.equal(result.snapshot.coverage.hasNext, null);
  assert.ok(result.snapshot.coverage.reasons.includes('feed_paging_unknown'));
  assert.ok(result.snapshot.coverage.reasons.includes('feed_limited_or_unknown'));
  assert.ok(result.snapshot.coverage.reasons.includes('section_count_not_exhausted'));
  assert.ok(result.snapshot.coverage.reasons.includes('deal_product_view_missing'));
});

test('reauth failure creates an empty blocked receipt and never calls the curation operation', async () => {
  let curationCalls = 0;
  const result = await collectTossDailySnapshot({
    now,
    checkSession: async () => { throw Object.assign(new Error('private'), { code: 'TOSS_REAUTH_REQUIRED' }); },
    request: async () => { curationCalls++; throw new Error('must not run'); },
  });
  assert.equal(curationCalls, 0);
  assert.equal(result.ownerMatched, false);
  assert.equal(result.errorCode, 'TOSS_REAUTH_REQUIRED');
  assert.equal(result.snapshot.coverage.status, 'blocked');
  assert.equal(result.snapshot.coverage.errorCode, 'TOSS_REAUTH_REQUIRED');
  assert.deepEqual(result.snapshot.products, []);
});

test('runner requests only the captured consumer curation operation and writes a safe status receipt', async () => {
  const archivedSnapshots = [];
  const statusReceipts = [];
  const result = await runTossDailyCollection({
    now,
    checkSession: goodCheck,
    request: async operation => {
      assert.equal(operation, CURATION_OPERATION);
      return completeResponse([deal({ id: 8 })]);
    },
    archive: async snapshot => {
      archivedSnapshots.push(snapshot);
      return {
        ok: true,
        snapshotId: 'abc123',
        collectionDateKst: '2026-10-07',
        productCount: snapshot.products.length,
        localCommitted: true,
        localReadbackVerified: true,
        driveCommitted: true,
        driveReadbackVerified: true,
        driveFileCount: 4,
        privateCookieValue: 'must-not-be-copied',
      };
    },
    writeStatus: async receipt => { statusReceipts.push(receipt); },
  });
  assert.equal(result.ok, true);
  assert.equal(archivedSnapshots.length, 1);
  assert.equal(statusReceipts.length, 1);
  assert.equal(statusReceipts[0].ownerMatched, true);
  assert.equal(statusReceipts[0].archive.snapshotId, 'abc123');
  assert.equal(JSON.stringify(statusReceipts[0]).includes('privateCookieValue'), false);
  assert.equal(JSON.stringify(statusReceipts[0]).includes('must-not-be-copied'), false);
});

test('today-deal items follows only response paging.nextCursor and treats totalCount zero as a report field', async () => {
  const cursors = [];
  const delays = [];
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    request: async () => { throw new Error('legacy curation reader must not run'); },
    pageReader: async cursor => {
      cursors.push(cursor);
      return cursor === null
        ? todayItemsResponse([deal({ id: 31 }), deal({ id: 31 })], { nextCursor: 'opaque-page-2', totalCount: 0 })
        : todayItemsResponse([deal({ id: 32 })], { nextCursor: null, totalCount: 0 });
    },
    sleep: async ms => { delays.push(ms); },
  });
  assert.deepEqual(cursors, [null, 'opaque-page-2']);
  assert.deepEqual(delays, [400]);
  assert.equal(result.snapshot.source.operation, TODAY_DEAL_ITEMS_OPERATION);
  assert.equal(result.snapshot.coverage.status, 'complete');
  assert.equal(result.snapshot.coverage.pages, 2);
  assert.equal(result.snapshot.coverage.pageLimit, TODAY_DEAL_PAGE_LIMIT);
  assert.equal(result.snapshot.coverage.rawItemCount, 3);
  assert.equal(result.snapshot.coverage.itemCount, 2);
  assert.equal(result.snapshot.coverage.uniqueTacaItemCount, 2);
  assert.equal(result.snapshot.coverage.exactDuplicateCount, 1);
  assert.equal(result.snapshot.coverage.reportedTotalCount, 0);
  assert.equal(result.snapshot.coverage.hasNext, false);
  assert.equal(JSON.stringify(result.snapshot).includes('opaque-page-2'), false);
});

test('today-deal cursor cycle stops after the repeated cursor and retains the observed page', async () => {
  const cursors = [];
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    pageReader: async cursor => {
      cursors.push(cursor);
      return cursor === null
        ? todayItemsResponse([deal({ id: 41 })], { nextCursor: 'cycle-cursor' })
        : todayItemsResponse([deal({ id: 42 })], { nextCursor: 'cycle-cursor' });
    },
    sleep: async () => {},
  });
  assert.deepEqual(cursors, [null, 'cycle-cursor']);
  assert.equal(result.snapshot.coverage.pages, 2);
  assert.equal(result.snapshot.coverage.itemCount, 2);
  assert.equal(result.snapshot.coverage.hasNext, true);
  assert.equal(result.snapshot.coverage.complete, false);
  assert.ok(result.snapshot.coverage.reasons.includes('deal_cursor_cycle'));
  assert.equal(JSON.stringify(result.snapshot).includes('cycle-cursor'), false);
});

test('a later today-deal page failure keeps prior products and reports partial coverage', async () => {
  const cursors = [];
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    pageReader: async cursor => {
      cursors.push(cursor);
      if (cursor === null) return todayItemsResponse([deal({ id: 51, soldOut: true })], { nextCursor: 'page-2' });
      throw Object.assign(new Error('private response'), { code: 'TOSS_REAUTH_REQUIRED' });
    },
    sleep: async () => {},
  });
  assert.deepEqual(cursors, [null, 'page-2']);
  assert.equal(result.ownerMatched, true);
  assert.equal(result.errorCode, 'TOSS_REAUTH_REQUIRED');
  assert.equal(result.snapshot.coverage.status, 'partial');
  assert.equal(result.snapshot.coverage.pages, 1);
  assert.equal(result.snapshot.coverage.itemCount, 1);
  assert.equal(result.snapshot.coverage.hasNext, true);
  assert.equal(result.snapshot.products[0].stockStatus, 'sold_out');
  assert.deepEqual(result.snapshot.products[0].stockSignals,
    { isSoldOut: true, status: null, conflict: false });
  assert.equal(JSON.stringify(result.snapshot).includes('page-2'), false);
});

test('unknown today-deal paging preserves rows but cannot claim completion', async () => {
  const response = todayItemsResponse([deal({ id: 61 })]);
  delete response.data.success.paging.nextCursor;
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    pageReader: async cursor => { assert.equal(cursor, null); return response; },
    sleep: async () => {},
  });
  assert.equal(result.snapshot.coverage.pages, 1);
  assert.equal(result.snapshot.coverage.hasNext, null);
  assert.equal(result.snapshot.coverage.complete, false);
  assert.ok(result.snapshot.coverage.reasons.includes('deal_paging_unknown'));
  assert.equal(result.snapshot.products.length, 1);
});

test('conflicting duplicate tacaItemIds are preserved as conflicting rows and mark coverage partial', async () => {
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    pageReader: async () => todayItemsResponse([
      deal({ id: 71, soldOut: true }),
      deal({ id: 71, soldOut: false }),
    ]),
    sleep: async () => {},
  });
  assert.equal(result.snapshot.coverage.itemCount, 2);
  assert.equal(result.snapshot.coverage.uniqueTacaItemCount, 1);
  assert.equal(result.snapshot.coverage.conflictDuplicateCount, 1);
  assert.equal(result.snapshot.coverage.complete, false);
  assert.ok(result.snapshot.coverage.reasons.includes('deal_duplicate_identity_conflict'));
  assert.deepEqual(result.snapshot.products.map(product => product.stockStatus), ['sold_out', 'in_stock']);
  assert.deepEqual(result.snapshot.products.map(product => product.stockSignals.isSoldOut), [true, false]);
});

test('cursor exhaustion is distinct from a stock-quality partial result', async () => {
  const conflictingStock = deal({ id: 76, soldOut: false });
  conflictingStock.taca.productView.status = 'SOLD_OUT';
  let reads = 0;
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    pageReader: async cursor => {
      reads += 1;
      if (cursor === null) return todayItemsResponse([deal({ id: 75 })], { nextCursor: 'last-page' });
      assert.equal(cursor, 'last-page');
      return todayItemsResponse([conflictingStock], { nextCursor: null });
    },
    sleep: async () => {},
  });
  assert.equal(reads, 2);
  assert.equal(result.snapshot.coverage.pages, 2);
  assert.equal(result.snapshot.coverage.hasNext, false);
  assert.equal(result.snapshot.coverage.status, 'partial');
  assert.equal(result.snapshot.coverage.complete, false);
  assert.deepEqual(result.snapshot.coverage.reasons, ['deal_stock_signals_conflict']);
});

test('page limit is capped at 50 and a remaining cursor reports partial coverage', async () => {
  let reads = 0;
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    pageLimit: 500,
    pageReader: async () => {
      reads += 1;
      return todayItemsResponse([deal({ id: 80 + reads })], { nextCursor: `next-${reads}` });
    },
    sleep: async ms => { assert.ok(ms >= 400); },
  });
  assert.equal(reads, TODAY_DEAL_PAGE_LIMIT);
  assert.equal(result.snapshot.coverage.pages, TODAY_DEAL_PAGE_LIMIT);
  assert.equal(result.snapshot.coverage.pageLimit, TODAY_DEAL_PAGE_LIMIT);
  assert.equal(result.snapshot.coverage.hasNext, true);
  assert.equal(result.snapshot.coverage.complete, false);
  assert.ok(result.snapshot.coverage.reasons.includes('deal_page_limit_reached'));
  assert.equal(JSON.stringify(result.snapshot).includes('next-'), false);
});

test('today-deal authentication failure stops before any page read', async () => {
  let pageReads = 0;
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: async () => { throw Object.assign(new Error('private'), { code: 'TOSS_REAUTH_REQUIRED' }); },
    pageReader: async () => { pageReads += 1; return todayItemsResponse([deal()]); },
    sleep: async () => {},
  });
  assert.equal(pageReads, 0);
  assert.equal(result.ownerMatched, false);
  assert.equal(result.errorCode, 'TOSS_REAUTH_REQUIRED');
  assert.equal(result.snapshot.coverage.status, 'blocked');
  assert.equal(result.snapshot.source.operation, TODAY_DEAL_ITEMS_OPERATION);
  assert.equal(result.snapshot.coverage.pages, 0);
  assert.deepEqual(result.snapshot.products, []);
});

test('injected check with no today-deal reader cannot fall through to a real default request', async () => {
  let legacyRequestCalls = 0;
  const result = await collectTossTodayItemsSnapshot({
    now,
    checkSession: goodCheck,
    request: async () => { legacyRequestCalls += 1; return completeResponse([deal()]); },
  });
  assert.equal(legacyRequestCalls, 0);
  assert.equal(result.errorCode, 'TOSS_PAGE_READER_REQUIRED');
  assert.equal(result.snapshot.coverage.status, 'blocked');
});

test('runner can use the default today-deal source through an explicitly injected page reader', async () => {
  const cursors = [];
  const archived = [];
  const receipts = [];
  const result = await runTossDailyCollection({
    now,
    checkSession: goodCheck,
    pageReader: async cursor => {
      cursors.push(cursor);
      return cursor === null
        ? todayItemsResponse([deal({ id: 91 })], { nextCursor: 'runner-page-2' })
        : todayItemsResponse([deal({ id: 92 })], { nextCursor: null });
    },
    sleep: async ms => { assert.ok(ms >= 400); },
    archive: async snapshot => {
      archived.push(snapshot);
      return { ok: true, productCount: snapshot.products.length, localCommitted: true, driveCommitted: true };
    },
    writeStatus: async receipt => { receipts.push(receipt); },
  });
  assert.deepEqual(cursors, [null, 'runner-page-2']);
  assert.equal(result.ok, true);
  assert.equal(archived[0].source.operation, TODAY_DEAL_ITEMS_OPERATION);
  assert.equal(archived[0].coverage.pages, 2);
  assert.equal(archived[0].coverage.reportedTotalCount, 0);
  assert.equal(receipts[0].coverage.rawItemCount, 2);
  assert.equal(receipts[0].coverage.itemCount, 2);
  assert.equal(receipts[0].coverage.hasNext, false);
  assert.equal(JSON.stringify(receipts[0]).includes('runner-page-2'), false);
});
