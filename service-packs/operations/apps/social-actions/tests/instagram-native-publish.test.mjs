import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileNativeInstagram, sendNativeInstagram, stageNativeInstagram, validateNativeInstagram } from '../instagram-native-publish.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const OWNER = 'lifehack__ailab';
const ORIGIN = 'https://www.instagram.com';
const caption = '생활이득AI연구소 릴스 캡션';
const uploadId = '17802411234567890';

function nativeEnvelope(overrides = {}) {
  const form = new URLSearchParams({
    archive_only: 'false',
    caption,
    clips_share_preview_to_feed: '1',
    disable_comments: '0',
    disable_oa_reuse: 'false',
    gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW',
    igtv_share_preview_to_feed: '1',
    is_gen_ai_self_disclosure: 'true',
    is_unified_video: '1',
    like_and_view_counts_disabled: '0',
    media_share_flow: 'creation_flow',
    share_to_facebook: '',
    share_to_fb_destination_type: 'USER',
    source_type: 'library',
    upload_id: uploadId,
    video_subtitles_enabled: '0',
    jazoest: '23456',
    fb_dtsg: 'fresh-first-party-token',
  });
  const envelope = {
    version: 1,
    observedAt: new Date().toISOString(),
    owner: OWNER,
    helperClosed: true,
    browserWriteBlocked: true,
    blockedReason: 'inspector',
    responseReceived: false,
    assetSha256: 'a'.repeat(64),
    expectedCaption: caption,
    request: {
      url: ORIGIN + '/api/v1/media/configure_to_clips/',
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        origin: ORIGIN,
        referer: ORIGIN + '/accounts/edit/',
        'x-asbd-id': '123',
        'x-csrftoken': 'csrf-live',
        'x-ig-app-id': 'app-test',
        'x-instagram-ajax': 'rollout-test',
      },
      body: form.toString(),
    },
  };
  if (overrides.request?.body) envelope.request.body = overrides.request.body;
  if (overrides.request?.url) envelope.request.url = overrides.request.url;
  if (overrides.request?.headers) Object.assign(envelope.request.headers, overrides.request.headers);
  if (overrides.expectedCaption != null) envelope.expectedCaption = overrides.expectedCaption;
  if (overrides.assetSha256 != null) envelope.assetSha256 = overrides.assetSha256;
  if (overrides.observedAt != null) envelope.observedAt = overrides.observedAt;
  if (overrides.owner != null) envelope.owner = overrides.owner;
  return envelope;
}

const bundle = {
  service: 'instagram',
  owner: OWNER,
  origin: ORIGIN,
  cookies: [
    { name: 'csrftoken', value: 'csrf-live', domain: 'instagram.com' },
    { name: 'sessionid', value: 'session-live', domain: 'instagram.com' },
    { name: 'foreign', value: 'must-not-send', domain: 'example.com' },
  ],
};

function fakeStore(initial) {
  let current = initial == null ? null : JSON.stringify(initial);
  const writes = [];
  return {
    writes,
    read(name) { assert.equal(name, 'instagram-native-publish-v1'); return current; },
    write(name, value) {
      assert.equal(name, 'instagram-native-publish-v1');
      current = value;
      writes.push(value);
      return { stored: true, provider: 'Windows DPAPI CurrentUser', persistent: true };
    },
  };
}

async function temporaryRoot(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-native-test-'));
  try { return await operation(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function readbackPost({ mediaType = 2, productType = 'clips', carouselCount = 0 } = {}) {
  return { id: '990001', shortcode: 'ReelCode1', username: OWNER, caption, mediaType, productType,
    carouselCount, url: 'https://www.instagram.com/reel/ReelCode1/' };
}

async function sendFixture(root, { envelope = nativeEnvelope(), fetchImpl, store = fakeStore(nativeEnvelope()) } = {}) {
  const sent = [];
  const responseFetch = fetchImpl || (async (url, init) => {
    sent.push({ url, init });
    return { status: 200, url, headers: { getSetCookie: () => [] },
      text: async () => JSON.stringify({ status: 'ok', media: { pk: '990001', code: 'ReelCode1' } }) };
  });
  const result = await sendNativeInstagram({ idempotencyKey: 'reel-test-20260928',
    assetSha256: envelope.assetSha256, expectedCaption: envelope.expectedCaption }, {
    journalRoot: root,
    storeProvider: () => store,
    readProfile: async () => ({ profile: { username: OWNER } }),
    loadSession: () => bundle,
    fetchImpl: responseFetch,
    rotateCookies: () => {},
  });
  return { result, sent, store };
}

test('native envelope validation requires the captured one-shot Reel form and protected provenance', () => {
  const envelope = nativeEnvelope();
  const valid = validateNativeInstagram(envelope);
  assert.equal(valid.form.get('source_type'), 'library');
  assert.equal(valid.form.get('media_share_flow'), 'creation_flow');
  assert.equal(valid.form.get('gen_ai_detection_method'), 'SELF_DISCLOSURE_FLOW');

  const wrongRoute = nativeEnvelope({ request: { url: ORIGIN + '/api/v1/media/configure/' } });
  assert.throws(() => validateNativeInstagram(wrongRoute), { code: 'INSTAGRAM_NATIVE_REQUEST_INVALID' });
  const wrongSource = nativeEnvelope();
  const sourceForm = new URLSearchParams(wrongSource.request.body);
  sourceForm.set('source_type', 'feed');
  wrongSource.request.body = sourceForm.toString();
  assert.throws(() => validateNativeInstagram(wrongSource), { code: 'INSTAGRAM_NATIVE_CONTENT_INVALID' });
  const missingToken = nativeEnvelope();
  const tokenForm = new URLSearchParams(missingToken.request.body);
  tokenForm.delete('fb_dtsg');
  missingToken.request.body = tokenForm.toString();
  assert.throws(() => validateNativeInstagram(missingToken), { code: 'INSTAGRAM_NATIVE_CONTENT_INVALID' });
  assert.throws(() => validateNativeInstagram(nativeEnvelope({ request: { headers: { origin: 'https://example.com' } } })),
    { code: 'INSTAGRAM_NATIVE_HEADERS_INVALID' });
  assert.throws(() => validateNativeInstagram(nativeEnvelope({ observedAt: '2000-01-01T00:00:00.000Z' })),
    { code: 'INSTAGRAM_NATIVE_PROVENANCE_INVALID' });
});

test('staging protects one recent envelope and refuses to overwrite an unconsumed envelope', async () => {
  const envelope = nativeEnvelope();
  const emptyStore = fakeStore(null);
  assert.deepEqual(await stageNativeInstagram(envelope, { storeProvider: () => emptyStore }),
    { staged: true, helperClosed: true });
  const pendingStore = fakeStore(envelope);
  await assert.rejects(() => stageNativeInstagram(envelope, { storeProvider: () => pendingStore }),
    { code: 'INSTAGRAM_NATIVE_ENVELOPE_ALREADY_STAGED' });
});

test('native send scopes cookies, writes once, consumes envelope, and never repeats an existing journal', async () => {
  await temporaryRoot(async root => {
    const envelope = nativeEnvelope();
    const store = fakeStore(envelope);
    const { result, sent } = await sendFixture(root, { envelope, store });
    assert.equal(result.state, 'needs_readback');
    assert.equal(result.writeCount, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, envelope.request.url);
    assert.equal(sent[0].init.headers.cookie.includes('sessionid=session-live'), true);
    assert.equal(sent[0].init.headers.cookie.includes('must-not-send'), false);
    assert.equal(store.writes.length, 1);
    assert.deepEqual(JSON.parse(store.writes[0]), { consumed: true, idempotencyKey: 'reel-test-20260928' });

    const again = await sendNativeInstagram({ idempotencyKey: 'reel-test-20260928',
      assetSha256: envelope.assetSha256, expectedCaption: envelope.expectedCaption }, {
      journalRoot: root,
      fetchImpl: async () => { assert.fail('an existing native journal must not be resent'); },
    });
    assert.equal(again.alreadyAttempted, true);
    assert.equal(again.retrySent, false);
    assert.equal(again.writeCount, 1);

    const journalText = await fs.readFile(result.journalPath, 'utf8');
    assert.equal(journalText.includes('fresh-first-party-token'), false);
    assert.equal(journalText.includes(caption), false);
    assert.equal(journalText.includes(envelope.request.body), false);
  });
});

test('native readback paginates, verifies exact Reel shape and preserves a prior receipt after a read error', async () => {
  await temporaryRoot(async root => {
    const envelope = nativeEnvelope();
    const { result } = await sendFixture(root, { envelope });
    const cursors = [];
    const verified = await reconcileNativeInstagram({ idempotencyKey: 'reel-test-20260928' }, {
      journalRoot: root,
      loadSession: () => bundle,
      readPosts: async input => {
        cursors.push(input.after);
        if (!input.after) return { posts: [], pagination: { hasNextPage: true, nextCursor: 'cursor-1' } };
        return { posts: [readbackPost()], pagination: { hasNextPage: false, nextCursor: null } };
      },
    });
    assert.deepEqual(cursors, [null, 'cursor-1']);
    assert.equal(verified.state, 'published_owner_verified');
    assert.equal(verified.readbackVerified, true);
    assert.equal(verified.readback.captionMatched, true);
    assert.equal(verified.readback.mediaMatched, true);
    const savedReceipt = { ...verified.readback };

    const afterReadError = await reconcileNativeInstagram({ idempotencyKey: 'reel-test-20260928' }, {
      journalRoot: root,
      loadSession: () => bundle,
      readPosts: async () => { throw Object.assign(new Error(), { code: 'META_REAUTH_REQUIRED' }); },
    });
    assert.equal(afterReadError.state, 'published_owner_verified');
    assert.equal(afterReadError.readbackVerified, true);
    assert.deepEqual(afterReadError.readback, savedReceipt);
    assert.equal(afterReadError.lastReadbackCheck.status, 'read_error');
    assert.equal(afterReadError.lastReadbackCheck.failureCode, 'META_REAUTH_REQUIRED');
    assert.equal(afterReadError.lastReadbackCheck.previousReceiptPreserved, true);
    assert.equal(result.writeCount, 1);
  });
});

test('native readback rejects caption and media mismatches without erasing separate facts', async () => {
  await temporaryRoot(async root => {
    await sendFixture(root);
    const mismatch = await reconcileNativeInstagram({ idempotencyKey: 'reel-test-20260928' }, {
      journalRoot: root,
      loadSession: () => bundle,
      readPosts: async () => ({ posts: [readbackPost({ productType: 'feed' })],
        pagination: { hasNextPage: false, nextCursor: null } }),
    });
    assert.equal(mismatch.state, 'needs_reconciliation');
    assert.equal(mismatch.readbackVerified, false);
    assert.equal(mismatch.lastReadbackCheck.captionMatched, true);
    assert.equal(mismatch.lastReadbackCheck.mediaMatched, false);
  });
});
