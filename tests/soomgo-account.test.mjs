import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { createSoomgoAuth, SOOMGO_ACCOUNT_PATH, SOOMGO_ACCOUNT_URL, SOOMGO_ACCOUNT_STORE,
  SOOMGO_CHATS_PATH, SOOMGO_REQUEST_PAGE_SIZE, SOOMGO_REQUESTS_PATH,
  validateSoomgoSessionImport } from '../lib/web-auth/soomgo.mjs';

const EMAIL = 'private-owner@example.test';
const TOKEN = 'opaque.JWT-token_123~abc';
const OWNER_ID = 712345;
const PRIVATE_PHONE = '+82-10-5555-0100';
const PRIVATE_FIRST = '민지';
const PRIVATE_LAST = '김';

function importInput(overrides = {}) {
  return {
    schemaVersion: 1,
    service: 'soomgo',
    expectedOwnerId: OWNER_ID,
    expectedEmail: EMAIL,
    authToken: TOKEN,
    ...overrides,
  };
}

function owner(overrides = {}) {
  return {
    id: OWNER_ID,
    email: EMAIL,
    phone: PRIVATE_PHONE,
    first_name: PRIVATE_FIRST,
    last_name: PRIVATE_LAST,
    is_certify_name: false,
    provider: { name: 'NAVER' },
    social_sign_up: 'NAVER',
    allow_use_marketing: false,
    allow_use_select_info: false,
    allow_news_letters: false,
    privateAddress: 'never returned by the adapter',
    ...overrides,
  };
}

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

function requestEnvelope({ after = null, items = [], legacyExisting = false, totalOpenedCount = 0,
  totalCompletedCount = 0, paginationCount = items.length } = {}) {
  return {
    code: 0,
    reason: '',
    request: SOOMGO_REQUESTS_PATH,
    response: {
      totalOpenedCount,
      totalCompletedCount,
      legacyExisting,
      items,
      pagination: { count: paginationCount, before: null, after, limit: SOOMGO_REQUEST_PAGE_SIZE },
    },
  };
}

function requestRow(id) {
  return {
    id,
    service: { id: 29, name: 'Observed service' },
    status: 'opened',
    progressStatus: { type: 1, name: 'Observed progress' },
    startedAt: '2026-10-01T02:03:04.000Z',
    endedAt: null,
    quoteCount: 0,
    unreadQuoteCnt: 0,
  };
}

async function harness(t, responder = async () => json(owner()), { now = () => Date.parse('2026-10-27T00:00:00.000Z') } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soomgo-account-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProtectedStore({ provider: 'memory', directory });
  const calls = [];
  const auth = createSoomgoAuth({ store, now, fetchImpl: async (url, init) => {
    const target = new URL(String(url));
    const headers = new Headers(init.headers);
    const call = {
      url: target, method: init.method, redirect: init.redirect,
      authorization: headers.get('authorization'), cookie: headers.get('cookie'), headers,
    };
    calls.push(call);
    return responder({ ...call, target, init, calls });
  } });
  return { auth, calls, store, directory };
}

test('import contract accepts only the exact owner ID, email, and opaque Token value', () => {
  const normalized = validateSoomgoSessionImport(importInput({ expectedEmail: 'PRIVATE-OWNER@example.test' }));
  assert.equal(normalized.expectedOwnerId, OWNER_ID);
  assert.equal(normalized.expectedEmail, EMAIL);
  assert.equal(normalized.authToken, TOKEN);

  for (const extra of [
    { naverPassword: 'must-not-be-accepted' },
    { cookies: [{ name: 'NID_AUT', value: 'browser-cookie' }] },
    { authorization: 'Bearer arbitrary-scheme' },
  ]) {
    assert.throws(() => validateSoomgoSessionImport({ ...importInput(), ...extra }),
      { code: 'SOOMGO_AUTH_IMPORT_INVALID' });
  }
  for (const value of ['', 'token with spaces', 'line\nbreak', 'bad;header', 'x'.repeat(8193)]) {
    assert.throws(() => validateSoomgoSessionImport(importInput({ authToken: value })),
      { code: 'SOOMGO_AUTH_IMPORT_INVALID' });
  }
  assert.throws(() => validateSoomgoSessionImport(importInput({ expectedOwnerId: 0 })),
    { code: 'SOOMGO_AUTH_IMPORT_INVALID' });
});

test('one-time import pins the bare owner response and returns no token or private person fields', async t => {
  const h = await harness(t, async call => {
    assert.equal(call.target.href, SOOMGO_ACCOUNT_URL);
    assert.equal(call.target.pathname, SOOMGO_ACCOUNT_PATH);
    assert.equal(call.method, 'GET');
    assert.equal(call.redirect, 'manual');
    assert.equal(call.authorization, `Token ${TOKEN}`);
    assert.equal(call.cookie, null);
    assert.equal(call.init.body, undefined);
    return json(owner());
  });
  const before = h.auth.status();
  assert.equal(before.configured, false);
  assert.equal(before.currentAuthentication, 'not_checked');
  assert.equal(h.calls.length, 0);

  const result = await h.auth.importSession(importInput());
  assert.equal(result.authenticated, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.ownerIdPinned, true);
  assert.equal(result.persistent, false);
  assert.equal(result.readMode, 'pure_http');
  assert.equal(result.bootstrapMode, 'manual_browser_token_import');
  assert.equal(result.requestCount, 1);
  assert.equal(result.receipt.path, SOOMGO_ACCOUNT_PATH);
  assert.equal(result.receipt.cookiesSent, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.auth.status().configured, true);
  assert.equal(h.calls.length, 1, 'status does not issue an owner read');

  const saved = JSON.parse(h.store.read(SOOMGO_ACCOUNT_STORE));
  assert.equal(saved.ownerId, OWNER_ID);
  assert.equal(saved.expectedEmail, EMAIL);
  assert.equal(saved.session.cookieJar.cookies.length, 0);
  assert.equal(saved.session.headersByOrigin['https://api.soomgo.com'].authorization, `Token ${TOKEN}`);
  for (const secret of [TOKEN, EMAIL, PRIVATE_PHONE, PRIVATE_FIRST, PRIVATE_LAST, 'privateAddress']) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('owner, health, and verify each make one exact GET and bind the stored owner', async t => {
  const h = await harness(t, async call => {
    assert.equal(call.target.href, SOOMGO_ACCOUNT_URL);
    assert.equal(call.method, 'GET');
    assert.equal(call.authorization, `Token ${TOKEN}`);
    assert.equal(call.cookie, null);
    return json(owner());
  });
  await h.auth.importSession(importInput());
  assert.equal((await h.auth.owner()).ownerVerified, true);
  assert.equal((await h.auth.health()).ownerVerified, true);
  assert.equal((await h.auth.verify()).ownerVerified, true);
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call.url.pathname === SOOMGO_ACCOUNT_PATH));
});

test('owner mismatch never replaces a prior pinned owner and blocks later stored-token checks', async t => {
  let responseOwner = owner();
  const h = await harness(t, async () => json(responseOwner));
  await h.auth.importSession(importInput());
  const before = h.store.read(SOOMGO_ACCOUNT_STORE);

  await assert.rejects(h.auth.importSession(importInput({ expectedOwnerId: OWNER_ID + 1 })),
    { code: 'SOOMGO_AUTH_OWNER_MISMATCH' });
  assert.equal(h.calls.length, 1, 'a new expected owner is rejected before network use');
  assert.equal(h.store.read(SOOMGO_ACCOUNT_STORE), before);

  responseOwner = owner({ id: OWNER_ID + 1 });
  await assert.rejects(h.auth.health(), { code: 'SOOMGO_AUTH_OWNER_MISMATCH' });
  assert.equal(JSON.parse(h.store.read(SOOMGO_ACCOUNT_STORE)).reauthRequired, true);
  const afterMismatch = h.calls.length;
  await assert.rejects(h.auth.health(), { code: 'SOOMGO_AUTH_REAUTH_REQUIRED' });
  assert.equal(h.calls.length, afterMismatch, 'pinned-owner mismatch stops reuse until explicit import');
});

test('204 and 401 require explicit reimport; 403 remains forbidden with no retry', async t => {
  for (const status of [204, 401]) {
    const h = await harness(t, async () => new Response(null, { status }));
    await assert.rejects(h.auth.importSession(importInput()), { code: 'SOOMGO_AUTH_REAUTH_REQUIRED' });
    assert.equal(h.calls.length, 1);
    assert.equal(h.store.status(SOOMGO_ACCOUNT_STORE).available, false);
  }

  let deny = false;
  const h = await harness(t, async () => deny
    ? new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })
    : json(owner()));
  await h.auth.importSession(importInput());
  deny = true;
  const before = h.calls.length;
  await assert.rejects(h.auth.health(), error => {
    assert.equal(error.code, 'SOOMGO_AUTH_FORBIDDEN');
    assert.equal(JSON.stringify(error.receipt).includes(TOKEN), false);
    return true;
  });
  assert.equal(h.calls.length - before, 1);
});

test('HTML challenges, malformed schemas, and transport details remain sanitized', async t => {
  const html = await harness(t, async () => new Response('<html>challenge</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }));
  await assert.rejects(html.auth.importSession(importInput()), { code: 'SOOMGO_AUTH_CHALLENGE_HTML' });

  const schema = await harness(t, async () => json({ ...owner(), id: 'not-a-number' }));
  await assert.rejects(schema.auth.importSession(importInput()), { code: 'SOOMGO_AUTH_OWNER_SCHEMA_INVALID' });
  assert.equal(schema.store.status(SOOMGO_ACCOUNT_STORE).available, false);

  const privateErrorCode = 'PRIVATE_TOKEN_VALUE_MUST_NOT_ESCAPE';
  const transport = await harness(t, async () => {
    throw Object.assign(new Error('private transport detail'), { code: privateErrorCode });
  });
  await assert.rejects(transport.auth.importSession(importInput()), error => {
    assert.equal(error.code, 'SOOMGO_AUTH_TRANSPORT_FAILED');
    assert.equal(error.receipt.causeCode, 'SCOPED_SESSION_TRANSPORT_FAILED');
    assert.equal(JSON.stringify(error.receipt).includes(privateErrorCode), false);
    assert.equal(JSON.stringify(error.receipt).includes('private transport detail'), false);
    return true;
  });
});

test('requests uses owner preflight then Bearer, fixed limit 15, and bounded after pagination', async t => {
  let requestPage = 0;
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) {
      assert.equal(call.authorization, `Token ${TOKEN}`);
      return json(owner());
    }
    assert.equal(call.url.pathname, SOOMGO_REQUESTS_PATH);
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.cookie, null);
    assert.equal(call.url.searchParams.get('status'), 'opened');
    assert.equal(call.url.searchParams.get('limit'), '15');
    requestPage++;
    if (requestPage === 1) {
      assert.equal(call.url.searchParams.has('after'), false);
      return json(requestEnvelope({ after: 'opaque-next-cursor' }));
    }
    assert.equal(call.url.searchParams.get('after'), 'opaque-next-cursor');
    return json(requestEnvelope());
  });
  await h.auth.importSession(importInput());
  const result = await h.auth.requests({ status: 'opened', maxPages: 2 });
  assert.equal(result.status, 'complete');
  assert.equal(result.requestCount, 3, 'one owner preflight plus two list pages');
  assert.equal(result.ownerVerified, true);
  assert.equal(result.authorizationScheme, undefined, 'scheme is recorded in each route receipt');
  assert.equal(result.pageSize, 15);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.items, []);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.completeForSelectedStatus, true);
  assert.equal(result.coverage.entireSoomgoCatalogComplete, false);
  assert.deepEqual(result.receipt.pages.map(page => page.authorizationScheme), ['Bearer', 'Bearer']);
  assert.deepEqual(result.receipt.pages.map(page => page.query.afterPresent), [false, true]);
  assert.ok(result.receipt.pages.every(page => page.authenticated === true && page.ownerVerified === true));
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('request status closed_expired maps only to source closed,expired and legacyExisting stays a coverage gap', async t => {
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    assert.equal(call.url.pathname, SOOMGO_REQUESTS_PATH);
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.url.searchParams.get('status'), 'closed,expired');
    assert.equal(call.url.searchParams.get('limit'), '15');
    return json(requestEnvelope({ legacyExisting: true }));
  });
  await h.auth.importSession(importInput());
  const result = await h.auth.requests({ status: 'closed_expired' });
  assert.equal(result.statusFilter, 'closed_expired');
  assert.equal(result.sourceStatus, 'closed,expired');
  assert.equal(result.legacyExisting, true);
  assert.deepEqual(result.coverage.gaps, ['legacyExisting']);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.completeForSelectedStatus, false);
});

test('requests default to one bounded page, expose a resume cursor, and reject page counts over 15 before network', async t => {
  let requestPage = 0;
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    requestPage++;
    if (requestPage === 1) return json(requestEnvelope({ after: 'resume-here' }));
    assert.equal(call.url.searchParams.get('after'), 'resume-here');
    return json(requestEnvelope());
  });
  await h.auth.importSession(importInput());
  await assert.rejects(h.auth.requests({ maxPages: 16 }), { code: 'SOOMGO_AUTH_REQUEST_OPTIONS_INVALID' });
  assert.equal(h.calls.length, 1, 'invalid options are rejected before owner preflight');
  const first = await h.auth.requests();
  assert.equal(first.status, 'partial');
  assert.equal(first.pageCount, 1);
  assert.equal(first.nextAfter, 'resume-here');
  assert.equal(first.paginationComplete, false);
  const second = await h.auth.requests({ after: first.nextAfter });
  assert.equal(second.status, 'complete_with_coverage_gap');
  assert.equal(second.paginationComplete, true);
  assert.equal(second.completeForSelectedStatus, false);
  assert.deepEqual(second.coverage.gaps, ['resumed_window_only']);
});

test('request collector stops at the fixed fifteen-page invocation ceiling', async t => {
  let requestPage = 0;
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    requestPage++;
    return json(requestEnvelope({ after: requestPage === 15 ? null : `cursor-${requestPage + 1}` }));
  });
  await h.auth.importSession(importInput());
  const result = await h.auth.requests({ maxPages: 15 });
  assert.equal(result.pageCount, 15);
  assert.equal(requestPage, 15);
  assert.equal(result.requestCount, 16, 'one owner preflight plus at most fifteen pages');
  assert.equal(result.status, 'complete');
});

test('source pagination count may exceed the per-request limit and is preserved without constraining items', async t => {
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    return json(requestEnvelope({ paginationCount: 47 }));
  });
  await h.auth.importSession(importInput());
  const result = await h.auth.requests();
  assert.equal(result.items.length, 0);
  assert.equal(result.receipt.pages[0].pagination.count, 47);
  assert.equal(result.receipt.pages[0].pagination.limit, 15);
  assert.equal(result.status, 'complete_with_coverage_gap');
  assert.deepEqual(result.coverage.gaps, ['source_total_mismatch']);
  assert.equal(result.completeForSelectedStatus, false);
});

test('terminal cursor resume remains a window-only coverage gap, and full-walk count contradictions are explicit', async t => {
  const resumed = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    assert.equal(call.url.searchParams.get('after'), 'middle-of-list');
    return json(requestEnvelope());
  });
  await resumed.auth.importSession(importInput());
  const tail = await resumed.auth.requests({ after: 'middle-of-list' });
  assert.equal(tail.paginationComplete, true);
  assert.equal(tail.startedWithAfter, true);
  assert.equal(tail.resumedWindowOnly, true);
  assert.equal(tail.status, 'complete_with_coverage_gap');
  assert.equal(tail.completeForSelectedStatus, false);
  assert.deepEqual(tail.coverage.gaps, ['resumed_window_only']);

  const mismatch = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    return json(requestEnvelope({ items: [requestRow(612)], totalOpenedCount: 0 }));
  });
  await mismatch.auth.importSession(importInput());
  const inconsistent = await mismatch.auth.requests();
  assert.equal(inconsistent.paginationComplete, true);
  assert.equal(inconsistent.status, 'complete_with_coverage_gap');
  assert.equal(inconsistent.completeForSelectedStatus, false);
  assert.deepEqual(inconsistent.coverage.gaps, ['source_total_mismatch']);
  assert.equal(inconsistent.sourceCountReconciliation.consistent, false);
});

test('repeated request cursors and source-count drift return unstable partials', async t => {
  let requestPage = 0;
  const repeated = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    requestPage++;
    return json(requestEnvelope({ after: 'same-cursor' }));
  });
  await repeated.auth.importSession(importInput());
  await assert.rejects(repeated.auth.requests({ maxPages: 3 }), error => {
    assert.equal(error.code, 'SOOMGO_AUTH_REQUESTS_UNSTABLE');
    assert.equal(error.partialResult.status, 'unstable');
    assert.equal(error.partialResult.completeForSelectedStatus, false);
    assert.equal(error.partialResult.pageCount, 2);
    return true;
  });

  let driftPage = 0;
  const drift = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    driftPage++;
    return json(requestEnvelope({ after: driftPage === 1 ? 'next-page' : null,
      totalOpenedCount: driftPage === 1 ? 0 : 1 }));
  });
  await drift.auth.importSession(importInput());
  await assert.rejects(drift.auth.requests({ maxPages: 3 }), error => {
    assert.equal(error.code, 'SOOMGO_AUTH_REQUESTS_UNSTABLE');
    assert.equal(error.partialResult.status, 'unstable');
    assert.equal(error.partialResult.paginationComplete, false);
    assert.equal(error.partialResult.pageCount, 2);
    return true;
  });
});

test('offline duplicate request IDs cannot be reported as a complete stable list', async t => {
  let requestPage = 0;
  const duplicate = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    requestPage++;
    return json(requestEnvelope({
      after: requestPage === 1 ? 'second-page' : null,
      items: [requestRow(519)],
      totalOpenedCount: 1,
    }));
  });
  await duplicate.auth.importSession(importInput());
  await assert.rejects(duplicate.auth.requests({ maxPages: 2 }), error => {
    assert.equal(error.code, 'SOOMGO_AUTH_REQUESTS_UNSTABLE');
    assert.equal(error.partialResult.status, 'unstable');
    assert.equal(error.partialResult.duplicateItemCount, 1);
    assert.equal(error.partialResult.items.length, 1);
    assert.equal(error.partialResult.completeForSelectedStatus, false);
    return true;
  });
});

test('failed request page returns prior pages and the failed cursor without claiming completion', async t => {
  let requestPage = 0;
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    requestPage++;
    if (requestPage === 1) return json(requestEnvelope({ after: 'failed-page-cursor' }));
    return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } });
  });
  await h.auth.importSession(importInput());
  await assert.rejects(h.auth.requests({ maxPages: 2 }), error => {
    assert.equal(error.code, 'SOOMGO_AUTH_THROTTLED');
    assert.equal(error.partialResult.status, 'partial');
    assert.equal(error.partialResult.pageCount, 1);
    assert.equal(error.partialResult.resumeAfter, 'failed-page-cursor');
    assert.equal(error.partialResult.paginationComplete, false);
    assert.equal(error.receipt.ownerPreflight.ownerVerified, true);
    return true;
  });
});

test('chats performs owner preflight then one Token first-page read and never follows cursors', async t => {
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) {
      assert.equal(call.authorization, `Token ${TOKEN}`);
      return json(owner());
    }
    assert.equal(call.url.pathname, SOOMGO_CHATS_PATH);
    assert.equal(call.url.search, '?role=customer');
    assert.equal(call.authorization, `Token ${TOKEN}`);
    assert.equal(call.cookie, null);
    return json({ next: null, cursor: null, results: [], escrow_events_meta: [] });
  });
  await h.auth.importSession(importInput());
  const result = await h.auth.chats();
  assert.equal(result.status, 'first_page_only');
  assert.equal(result.pageCount, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.results, []);
  assert.equal(result.escrowEventsMetaCount, 0);
  assert.equal(result.pagination.followupQueryVerified, false);
  assert.equal(h.calls.length, 3, 'import plus one preflight and one chat request');
  assert.equal(result.receipt.response.authorizationScheme, 'Token');
  assert.equal(result.receipt.response.authenticated, true);
  assert.equal(result.receipt.response.ownerVerified, true);
});

test('offline request and chat projection uses observed fields, nulls unknown optionals, and omits message text', async t => {
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    if (call.url.pathname === SOOMGO_REQUESTS_PATH) return json(requestEnvelope({ items: [{
      id: 481,
      service: { id: 29, name: 'Observed service', privateField: 'omit' },
      status: 'expired',
      progressStatus: { type: 2, name: 'Observed progress', privateField: 'omit' },
      startedAt: '2026-10-01T02:03:04.000Z',
      endedAt: null,
      quoteCount: 3,
      unreadQuoteCnt: 'unknown type',
      quoteProviders: [{ quoteId: 42, providerId: 71, privateName: 'omit' }],
      privateNote: 'omit',
    }] }));
    return json({ next: 'unfollowed-page-handle', cursor: 'unverified-cursor', results: [{
      id: 'chat-15',
      updated_at: '2026-10-27T01:02:03.000Z',
      new_message_count: 2,
      last_message_type: 'text',
      last_message: 'private conversation text must not be returned',
      participant_name: 'private person omitted',
    }], escrow_events_meta: [{ privatePayment: 'omitted' }] });
  });
  await h.auth.importSession(importInput());
  const requests = await h.auth.requests();
  assert.deepEqual(requests.items[0], {
    id: 481,
    service: { id: 29, name: 'Observed service' },
    status: 'expired',
    progressStatus: { type: 2, name: 'Observed progress' },
    startedAt: '2026-10-01T02:03:04.000Z',
    endedAt: null,
    quoteCount: 3,
    unreadQuoteCnt: null,
  });
  assert.equal(JSON.stringify(requests.items[0]).includes('private'), false);

  const chats = await h.auth.chats();
  assert.deepEqual(chats.results, [{
    id: 'chat-15', updated_at: '2026-10-27T01:02:03.000Z',
    new_message_count: 2, last_message_type: 'text',
  }]);
  assert.equal(chats.escrowEventsMetaCount, 1);
  assert.equal(chats.pagination.nextPresent, true);
  assert.equal(chats.pagination.cursorPresent, true);
  for (const privateValue of ['private conversation text must not be returned', 'private person omitted', 'privatePayment']) {
    assert.equal(JSON.stringify(chats).includes(privateValue), false);
  }
});

test('list calls stop before their route when owner preflight fails, and list 401 blocks future stored-token use', async t => {
  let mismatch = false;
  const h = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(mismatch ? owner({ id: OWNER_ID + 1 }) : owner());
    assert.equal(call.url.pathname, SOOMGO_REQUESTS_PATH);
    return json(requestEnvelope());
  });
  await h.auth.importSession(importInput());
  mismatch = true;
  const beforeMismatch = h.calls.length;
  await assert.rejects(h.auth.requests(), { code: 'SOOMGO_AUTH_OWNER_MISMATCH' });
  assert.equal(h.calls.length - beforeMismatch, 1, 'only the owner preflight was sent');
  assert.equal(JSON.parse(h.store.read(SOOMGO_ACCOUNT_STORE)).reauthRequired, true);

  let listUnauthorized = false;
  const reauth = await harness(t, async call => {
    if (call.url.pathname === SOOMGO_ACCOUNT_PATH) return json(owner());
    return listUnauthorized ? new Response(null, { status: 401 }) : json(requestEnvelope());
  });
  await reauth.auth.importSession(importInput());
  listUnauthorized = true;
  const before401 = reauth.calls.length;
  await assert.rejects(reauth.auth.requests(), { code: 'SOOMGO_AUTH_REAUTH_REQUIRED' });
  assert.equal(reauth.calls.length - before401, 2, 'one preflight and one list request, with no retry');
  assert.equal(JSON.parse(reauth.store.read(SOOMGO_ACCOUNT_STORE)).reauthRequired, true);
  const after401 = reauth.calls.length;
  await assert.rejects(reauth.auth.chats(), { code: 'SOOMGO_AUTH_REAUTH_REQUIRED' });
  assert.equal(reauth.calls.length, after401, 'stored-token reads stop until explicit import');
});

test('CLI hides stdin import, labels memory as nonpersistent, and supports protected fresh-process reuse', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soomgo-account-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = path.join(directory, 'mock-fetch.mjs');
  await writeFile(hook, `globalThis.fetch = async (url, init) => {
    const u = new URL(url), h = new Headers(init.headers);
    if (init.method !== 'GET' || h.has('cookie')) throw Error('scope');
    if (u.href === '${SOOMGO_ACCOUNT_URL}') {
      if (h.get('authorization') !== 'Token ${TOKEN}') throw Error('owner credential scope');
      return Response.json(${JSON.stringify(owner())});
    }
    if (u.pathname === '${SOOMGO_REQUESTS_PATH}') {
      if (h.get('authorization') !== 'Bearer ${TOKEN}' || u.searchParams.get('limit') !== '15') throw Error('request credential scope');
      return Response.json(${JSON.stringify(requestEnvelope({ legacyExisting: true }))});
    }
    if (u.pathname === '${SOOMGO_CHATS_PATH}') {
      if (h.get('authorization') !== 'Token ${TOKEN}' || u.search !== '?role=customer') throw Error('chat credential scope');
      return Response.json({next:null,cursor:null,results:[],escrow_events_meta:[]});
    }
    throw Error('unobserved route');
  };\n`);
  const script = path.resolve('scripts/soomgo-account.mjs');
  const status = spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(status.status, 0, status.stdout);
  assert.equal(JSON.parse(status.stdout).credentialProvider, 'process-memory');
  assert.equal(JSON.parse(status.stdout).persistent, false);

  const memoryImport = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, script, 'session-import', '--memory'],
    { input: JSON.stringify(importInput()), encoding: 'utf8', timeout: 15_000 });
  assert.equal(memoryImport.status, 0, memoryImport.stdout);
  assert.equal(memoryImport.stderr, '');
  assert.equal(JSON.parse(memoryImport.stdout).persistent, false);
  for (const secret of [TOKEN, EMAIL, PRIVATE_PHONE, PRIVATE_FIRST, PRIVATE_LAST, 'privateField']) {
    assert.equal(memoryImport.stdout.includes(secret), false);
  }

  const env = { ...process.env, PROTECTED_STORE_PROVIDER: 'file', PROTECTED_STORE_KEY: Buffer.alloc(32, 9).toString('base64') };
  const imported = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, script, 'session-import', '--persist', `--store-dir=${directory}`],
    { input: JSON.stringify(importInput()), encoding: 'utf8', timeout: 15_000, env });
  assert.equal(imported.status, 0, imported.stdout);
  assert.equal(JSON.parse(imported.stdout).persistent, true);

  const health = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, script, 'health', `--store-dir=${directory}`],
    { encoding: 'utf8', timeout: 15_000, env });
  assert.equal(health.status, 0, health.stdout);
  assert.equal(JSON.parse(health.stdout).ownerVerified, true);
  for (const secret of [TOKEN, EMAIL, PRIVATE_PHONE, PRIVATE_FIRST, PRIVATE_LAST]) {
    assert.equal(health.stdout.includes(secret), false);
  }

  const requests = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, script, 'requests', '--status=closed_expired', '--max-pages=1', `--store-dir=${directory}`],
    { encoding: 'utf8', timeout: 15_000, env });
  assert.equal(requests.status, 0, requests.stdout);
  const requestOutput = JSON.parse(requests.stdout);
  assert.equal(requestOutput.ok, true);
  assert.equal(requestOutput.statusFilter, 'closed_expired');
  assert.equal(requestOutput.sourceStatus, 'closed,expired');
  assert.equal(requestOutput.legacyExisting, true);
  assert.equal(requestOutput.requestCount, 2);

  const chats = spawnSync(process.execPath,
    ['--import', pathToFileURL(hook).href, script, 'chats', `--store-dir=${directory}`],
    { encoding: 'utf8', timeout: 15_000, env });
  assert.equal(chats.status, 0, chats.stdout);
  assert.equal(JSON.parse(chats.stdout).status, 'first_page_only');
  assert.equal(JSON.parse(chats.stdout).requestCount, 2);

  const sealed = await readFile(path.join(directory, `${SOOMGO_ACCOUNT_STORE}.sealed`), 'utf8');
  for (const secret of [TOKEN, EMAIL]) assert.equal(sealed.includes(secret), false);
});
