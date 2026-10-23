import test from 'node:test';
import assert from 'node:assert/strict';
import { issueLinkWithDependencies, findIssued, shortUrlOf, ISSUE_PATH } from '../client-core.mjs';

const bundle = () => ({ cookies: [{ name: 'TGSID', value: 'x', expires: -1 }, { name: 'TBIZAUTH', value: 'y', expires: -1 }] });
const memJournal = () => { const m = new Map(); return { m, read: id => m.get(id) ?? null, write: (id, e) => m.set(id, e) }; };
const reply = (status, body) => async () => ({ status, json: async () => body });

test('one POST with {tacaItemId}; the issued short URL is journaled and reused without a second send', async () => {
  const journal = memJournal(); const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url: String(url), init }); return { status: 200, json: async () => ({ resultType: 'SUCCESS', success: { shortUrl: 'https://toss.im/_s/abc' } }) }; };
  const r = await issueLinkWithDependencies(2660583027, { loadSession: bundle, fetchImpl, journal });
  assert.deepEqual(r, { tacaItemId: 2660583027, shortUrl: 'https://toss.im/_s/abc', reused: false, sent: true });
  assert.equal(sent[0].url, 'https://sharelink.toss.im' + ISSUE_PATH);
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.body, '{"tacaItemId":2660583027}');
  const again = await issueLinkWithDependencies(2660583027, { loadSession: bundle, fetchImpl, journal });
  assert.equal(again.reused, true);
  assert.equal(sent.length, 1);
});

test('an unclear send needs reconciliation; rejections and bad input never report a link', async () => {
  const journal = memJournal();
  await assert.rejects(issueLinkWithDependencies(1, { loadSession: bundle, fetchImpl: async () => { throw new Error('reset'); }, journal }), /TOSS_ISSUE_OUTCOME_UNKNOWN/);
  await assert.rejects(issueLinkWithDependencies(1, { loadSession: bundle, fetchImpl: reply(200, { resultType: 'SUCCESS', success: { shortUrl: 'https://t/1' } }), journal }), /TOSS_ISSUE_RECONCILE_REQUIRED/);
  await assert.rejects(issueLinkWithDependencies(2, { loadSession: bundle, fetchImpl: reply(200, { resultType: 'FAIL', error: { errorCode: 'NOT_ISSUABLE' } }), journal: memJournal() }), /TOSS_ISSUE_REJECTED/);
  await assert.rejects(issueLinkWithDependencies(3, { loadSession: bundle, fetchImpl: reply(401, { resultType: 'FAIL', error: { errorCode: 'AUTH_EXPIRED' } }), journal: memJournal() }), /TOSS_REAUTH_REQUIRED/);
  await assert.rejects(issueLinkWithDependencies('abc', { loadSession: bundle, fetchImpl: reply(200, {}), journal: memJournal() }), /TOSS_ISSUE_INPUT_INVALID/);
  assert.equal(shortUrlOf({ success: { shortUrl: 'http://insecure' } }), null);
});

test('reconcile reads the issued-links list', () => {
  const list = { success: { data: [{ tacaItemId: 2625255849, shortUrl: 'https://toss.im/_s/z', commissionRate: 10, issuedAt: '2026-09-27' }] } };
  assert.deepEqual(findIssued(list, '2625255849'), { tacaItemId: 2625255849, shortUrl: 'https://toss.im/_s/z', commissionRate: 10, issuedAt: '2026-09-27' });
  assert.equal(findIssued(list, 1), null);
});
