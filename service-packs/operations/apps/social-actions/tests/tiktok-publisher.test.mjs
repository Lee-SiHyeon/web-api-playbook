import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateTikTokEnvelope, validateTikTokOwnerListEnvelope, applyTikTokReadback, reserveTikTokRequest } from '../tiktok-publisher.mjs';

const now = Date.now();
function envelope() {
  return { version: 1, ownerHandle: 'lifehack__aibal', origin: 'https://www.tiktok.com',
    observedAt: new Date(now).toISOString(), browserWriteBlocked: true, blockedReason: 'inspector',
    responseReceived: false, helperClosed: true,
    request: { method: 'POST', url: 'https://www.tiktok.com/tiktok/web/project/post/v1/?msToken=sentinel&X-Bogus=sentinel&X-Gnarly=sentinel',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.tiktok.com',
        Referer: 'https://www.tiktok.com/tiktokstudio/upload', 'tt-ticket-guard-public-key': 'sentinel',
        'tt-ticket-guard-version': '2', 'tt-ticket-guard-client-data': Buffer.from(JSON.stringify({
          timestamp: Math.floor(now / 1000), req_sign: 'sentinel', ts_sign: 'sentinel' })).toString('base64') },
      body: JSON.stringify({ post_common_info: { creation_id: 'sentinel' },
        feature_common_info_list: [{ privacy_setting_info: { visibility_type: 1 } }],
        single_post_req_list: [{ video_id: 'sentinel-video', single_post_feature_info: { text: 'Private test' } }] }) } };
}
test('accepts a fresh cancelled private request after the helper closes', () => {
  assert.equal(validateTikTokEnvelope(envelope(), { now }).visibilityType, 1);
});
test('rejects public or friends visibility', () => {
  for (const visibility of [0, 2]) {
    const e = envelope(); const body = JSON.parse(e.request.body);
    body.feature_common_info_list[0].privacy_setting_info.visibility_type = visibility;
    e.request.body = JSON.stringify(body);
    assert.throws(() => validateTikTokEnvelope(e, { now }), { code: 'TIKTOK_VISIBILITY_INTENT_MISMATCH' });
  }
});
test('public visibility requires an explicitly scoped, branded-disclosure envelope', () => {
  const e = envelope(); e.visibilityIntent = 'public';
  const body = JSON.parse(e.request.body);
  const feature = body.feature_common_info_list[0];
  feature.privacy_setting_info.visibility_type = 0;
  feature.aigc_info = { aigc_label_type: 1 };
  feature.tcm_params = 'captured-branded-disclosure';
  e.request.body = JSON.stringify(body);
  assert.equal(validateTikTokEnvelope(e, { now }).visibilityIntent, 'public');
  const missingAi = structuredClone(e);
  const brokenBody = JSON.parse(missingAi.request.body); delete brokenBody.feature_common_info_list[0].aigc_info;
  missingAi.request.body = JSON.stringify(brokenBody);
  assert.throws(() => validateTikTokEnvelope(missingAi, { now }), { code: 'TIKTOK_PUBLIC_DISCLOSURES_MISSING' });
  const noIntent = structuredClone(e); delete noIntent.visibilityIntent;
  assert.throws(() => validateTikTokEnvelope(noIntent, { now }), { code: 'TIKTOK_VISIBILITY_INTENT_MISMATCH' });
});
test('rejects a request that might already have reached TikTok', () => {
  const e = envelope(); e.responseReceived = true;
  assert.throws(() => validateTikTokEnvelope(e, { now }), { code: 'TIKTOK_ENVELOPE_PROVENANCE_INVALID' });
});
test('rejects an open helper and a stale captured envelope', () => {
  const open = envelope(); open.helperClosed = false;
  assert.throws(() => validateTikTokEnvelope(open, { now }), { code: 'TIKTOK_HELPER_NOT_CLOSED' });
  assert.throws(() => validateTikTokEnvelope(envelope(), { now: now + 120001 }), { code: 'TIKTOK_ENVELOPE_STALE' });
});
test('preserves SDK-cached signatures but rejects future signing timestamps', () => {
  const e = envelope(); e.observedAt = new Date(now + 130000).toISOString();
  assert.equal(validateTikTokEnvelope(e, { now: now + 130000 }).visibilityType, 1);
  const future = envelope();
  future.request.headers['tt-ticket-guard-client-data'] = Buffer.from(JSON.stringify({
    timestamp: Math.floor(now / 1000) + 60, req_sign: 'sentinel', ts_sign: 'sentinel' })).toString('base64');
  assert.throws(() => validateTikTokEnvelope(future, { now }), { code: 'TIKTOK_SIGNED_INPUT_INVALID' });
});
test('rejects foreign origins and injected cookie headers', () => {
  const foreign = envelope(); foreign.request.url = foreign.request.url.replace('www.tiktok.com', 'example.com');
  assert.throws(() => validateTikTokEnvelope(foreign, { now }), { code: 'TIKTOK_POST_URL_INVALID' });
  const cookie = envelope(); cookie.request.headers.Cookie = 'sentinel';
  assert.throws(() => validateTikTokEnvelope(cookie, { now }), { code: 'TIKTOK_POST_HEADERS_INVALID' });
});

function ownerEnvelope() {
  return { version: 1, ownerHandle: 'lifehack__aibal', origin: 'https://www.tiktok.com',
    observedAt: new Date(now).toISOString(), responseStatus: 200, helperClosed: true,
    request: { method: 'POST', url: 'https://www.tiktok.com/tiktok/creator/manage/item_list/v1/?msToken=sentinel&X-Bogus=sentinel&X-Gnarly=sentinel',
      headers: { Origin: 'https://www.tiktok.com', Referer: 'https://www.tiktok.com/tiktokstudio/content',
        'Content-Type': 'application/json', 'tt-csrf-token': 'sentinel' },
      body: JSON.stringify({ cursor: 0, size: 50, query: { conditions: [], sort_orders: [{ field_name: 'post_time', order: 2 }] } }) } };
}

test('accepts only a fresh owner list envelope with a closed helper', () => {
  assert.ok(validateTikTokOwnerListEnvelope(ownerEnvelope(), { now }).headers['tt-csrf-token']);
  const open = ownerEnvelope(); open.helperClosed = false;
  assert.throws(() => validateTikTokOwnerListEnvelope(open, { now }), { code: 'TIKTOK_OWNER_READ_PROVENANCE_INVALID' });
  assert.throws(() => validateTikTokOwnerListEnvelope(ownerEnvelope(), { now: now + 120001 }), { code: 'TIKTOK_OWNER_READ_STALE' });
});

test('owner list envelope rejects foreign origins, malformed body and secret header injection', () => {
  const cases = [
    e => { e.request.url = e.request.url.replace('www.tiktok.com', 'example.com'); },
    e => { e.request.body = 'x'.repeat(8193); },
    e => { e.request.headers.Cookie = 'sentinel'; },
    e => { e.request.headers.Referer = 'https://example.com/tiktokstudio/content'; },
    e => { e.request.url += '&msToken=duplicate'; },
  ];
  for (const change of cases) { const e = ownerEnvelope(); change(e); assert.throws(() => validateTikTokOwnerListEnvelope(e, { now })); }
});

test('a failed recheck preserves the verified receipt and marks it cached', () => {
  const before = { state: 'published_private_verified', checkedAt: 'previous',
    itemId: '7690371066291571969', writeCount: 1, readback: { readbackVerified: true, privateVerified: true } };
  const after = applyTikTokReadback(before, { readbackVerified: false, code: 'TIKTOK_OWNER_READ_STALE' }, 'later');
  assert.equal(after.state, 'published_private_verified');
  assert.equal(after.checkedAt, 'previous');
  assert.equal(after.freshReadback, false);
  assert.equal(after.lastRecheck.checkedAt, 'later');
  assert.equal(after.writeCount, 1);
  assert.deepEqual(after.readback, before.readback);
});

test('successful reconciliation verifies a submitted record without a second write', () => {
  const after = applyTikTokReadback({ state: 'submitted', writeCount: 1 }, { readbackVerified: true }, 'now');
  assert.equal(after.state, 'published_private_verified');
  assert.equal(after.verifiedAt, 'now');
  assert.equal(after.writeCount, 1);
});

test('atomic request reservation allows only one of two different job keys', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tiktok-reservation-test-'));
  try {
    const results = await Promise.allSettled([
      reserveTikTokRequest(directory, 'a'.repeat(64), 'job-one'),
      reserveTikTokRequest(directory, 'a'.repeat(64), 'job-two'),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'TIKTOK_ENVELOPE_ALREADY_RESERVED');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
