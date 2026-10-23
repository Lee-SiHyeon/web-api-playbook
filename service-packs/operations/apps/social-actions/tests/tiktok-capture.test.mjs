import test from 'node:test';
import assert from 'node:assert/strict';
import { TikTokCapture } from '../tiktok-capture.mjs';

function recorder() {
  const r = new TikTokCapture({});
  r.proven = true;
  r.userAgent = 'Observed test agent';
  r.requests.set('post', { requestId: 'post', wallTime: Date.now() / 1000,
    request: { method: 'POST', url: 'https://www.tiktok.com/tiktok/web/project/post/v1/?msToken=sentinel',
      headers: { Cookie: 'do-not-export', 'Content-Type': 'application/json', Referer: 'https://www.tiktok.com/tiktokstudio/upload' },
      postData: '{"sentinel":true}' } });
  r.failures.set('post', { blockedReason: 'inspector' });
  return r;
}

test('capture preserves the observed request body but excludes Cookie from handoff headers', () => {
  const r = recorder();
  const e = r.envelope();
  assert.equal(e.helperClosed, false);
  assert.equal(e.request.body, '{"sentinel":true}');
  assert.equal(e.request.headers.cookie, undefined);
  assert.equal(e.request.headers['user-agent'], 'Observed test agent');
});

test('capture rejects response receipt, an earlier possibly sent post and missing UA', () => {
  const responded = recorder(); responded.responses.set('post', { status: 200 });
  assert.throws(() => responded.envelope(), { code: 'TIKTOK_BROWSER_WRITE_NOT_BLOCKED' });
  const ambiguous = recorder(); ambiguous.requests.set('second', { ...ambiguous.requests.get('post'), requestId: 'second' });
  ambiguous.failures.set('second', { blockedReason: 'inspector' });
  ambiguous.failures.delete('post');
  assert.throws(() => ambiguous.envelope(), { code: 'TIKTOK_BROWSER_WRITE_NOT_BLOCKED' });
  const noUa = recorder(); noUa.userAgent = undefined;
  assert.throws(() => noUa.envelope(), { code: 'TIKTOK_OBSERVED_USER_AGENT_MISSING' });
});

test('closeAndSeal verifies helper absence and clears runtime capture data', async () => {
  const r = recorder(); r.poll = async () => {};
  let tabClosed = false;
  const envelope = await r.closeAndSeal({ id: 'test', close: async () => { tabClosed = true; } },
    { tabs: { list: async () => [] } });
  assert.equal(tabClosed, true);
  assert.equal(envelope.helperClosed, true);
  assert.equal(r.requests.size, 0);
  assert.equal(r.userAgent, undefined);
});

test('capture stops if its network event buffer lost events', async () => {
  const r = new TikTokCapture({ readEvents: async () => ({ cursor: 1, events: [], truncated: true, hasMore: false }) });
  await assert.rejects(r.poll(), { code: 'TIKTOK_CAPTURE_TRUNCATED' });
});
