import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchXPublic } from '../research/content-store/x-public.mjs';
import { collect, validateConfig } from '../research/content-store/collect.mjs';
import { parseThreadsPublic, fetchThreadsPublic } from '../research/content-store/threads-public.mjs';
const rejectedConfigKeys = JSON.parse(readFileSync(new URL('../research/evaluations/collector-classifier-regression-v1.json', import.meta.url), 'utf8')).cases.sourceConfigAllowlist.rejectedKeys;
test('X profile collection refuses HTML-only access when the protected session is absent', async () => {
  let calls = 0;
  await assert.rejects(fetchXPublic('arrakis_ai', 8, { fetchImpl: async () => { calls++; throw new Error('UNEXPECTED_HTTP'); },
    sessionLoader: async () => null }), error => error.code === 'X_SESSION_REQUIRED');
  assert.equal(calls, 0);
});
test('Naver feed retains only the selected author and canonical post URLs', async () => {
  const config = { schemaVersion: 1, perSourceLimit: 8, sources: [{ id: 'travel', field: 'travel', kind: 'naver_blog_rss', blogId: 'writer' }] };
  const result = await collect(config, { fetchImpl: async () => new Response('<rss><channel><item><title>A</title><link>https://blog.naver.com/writer/123?trackingCode=rss</link></item><item><title>B</title><link>https://evil.test/a</link></item></channel></rss>') });
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].urls[0], 'https://blog.naver.com/writer/123');
  assert.equal(result.candidates[0].evidenceLevel, 'feed_headline');
  assert.throws(() => validateConfig({ ...config, sources: [{ ...config.sources[0], blogId: '../other' }] }));
});

test('X collection uses a protected session and rejects secret config fields', async () => {
  const config = { schemaVersion: 1, perSourceLimit: 8, sources: [{ id: 'x-public', field: 'ai', kind: 'x_public_profile', handle: 'arrakis_ai' }] };
  let calls = 0;
  const result = await collect(config, { xSessionLoader: async () => null, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(Object.keys(options.headers || {}).some(key => /cookie|authorization|csrf/i.test(key)), false);
  } });
  assert.equal(calls, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.sources[0].status, 'failed');
  assert.equal(result.sources[0].code, 'X_SESSION_REQUIRED');
  assert.equal(result.policy.publicOnly, true);
  assert.throws(() => validateConfig({ ...config, sources: [{ ...config.sources[0], [rejectedConfigKeys[0]]: 'must-not-persist' }] }), /SOURCE_CONFIG/);
  assert.throws(() => validateConfig({ ...config, [rejectedConfigKeys[1]]: 'must-not-persist' }), /SOURCE_CONFIG/);
});
test('Threads projects public fields, excludes quoted posts, and never invents missing views', async () => {
  const post = { code: 'Abc12345', taken_at: 1790022619, caption: { text: 'AI tool example' }, user: { username: 'choi.openai', private_field: 'ignored' }, like_count: 4,
    logging_info_token: 'secret', text_post_app_info: { direct_reply_count: 2, repost_count: 0 } };
  const html = `<script type="application/json">${JSON.stringify({ data: { post: { ...post, quoted_post: { ...post, code: 'Older123' } } } })}</script>`;
  const rows = parseThreadsPublic(html, 'choi.openai');
  assert.equal(rows.length, 1); assert.equal(rows[0].engagement.views, null); assert.equal(rows[0].engagement.reposts, 0);
  assert.equal(JSON.stringify(rows).includes('secret'), false);
  assert.throws(() => parseThreadsPublic(html, 'other'), /UNAVAILABLE/);
  const result = await fetchThreadsPublic('choi.openai', 8, { fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
  assert.equal(result.receipt.browserUsed, false);
  await assert.rejects(fetchThreadsPublic('choi.openai', 8, { fetchImpl: async () => new Response('login', { status: 403 }) }), /UNAVAILABLE/);
});
