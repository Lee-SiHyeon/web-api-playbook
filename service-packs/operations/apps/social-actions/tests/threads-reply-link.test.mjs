import test from 'node:test';
import assert from 'node:assert/strict';
import { readThreadsQuotedReplyParent } from '../threads-reply-link.mjs';
const created = { id: '3997665852552127130', url: 'https://www.threads.com/@lifehack__ailab/post/Dd6j-mQFCKa' };
const parentId = '3997530329766474170';
const media = (parents = [parentId], ids = parents) => ({ pk: created.id, text_post_app_info: { containing_thread: {
  posts: { edges: parents.map(pk => ({ node: { pk } })) }, post_ids: { edges: ids.map(pk => ({ node: { pk } })) },
} } });
const context = value => ({ bundle: { service: 'threads', origin: 'https://www.threads.com', owner: 'lifehack__ailab', cookies: [] }, documentReceipt: { ownerVerified: true },
  fetchImpl: async (url, options) => {
    assert.equal(url, created.url); assert.equal(options.redirect, 'manual');
    const response = new Response(`<script type="application/json">${JSON.stringify(value)}</script>`, { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  },
});
test('quoted parent document requires exactly one same ancestor in both edge lists', async () => {
  assert.equal(await readThreadsQuotedReplyParent({ created, parentId, context: context(media()) }), true);
  for (const value of [media([parentId, '3997530329766474171']), media([parentId], ['3997530329766474171']), media([]), [media(), media()]]) {
    assert.equal(await readThreadsQuotedReplyParent({ created, parentId, context: context(value) }), false);
  }
});
test('quoted parent proof refuses wrong owner and foreign origin before HTTP', async () => {
  const ctx = context(media()); let called = false; ctx.fetchImpl = async () => { called = true; };
  await assert.rejects(readThreadsQuotedReplyParent({ created: { ...created, url: 'https://example.com/@lifehack__ailab/post/Dd6j-mQFCKa' }, parentId, context: ctx }), { code: 'THREADS_REPLY_PARENT_DOCUMENT_SCOPE' });
  ctx.bundle.owner = 'different';
  await assert.rejects(readThreadsQuotedReplyParent({ created, parentId, context: ctx }), { code: 'THREADS_REPLY_PARENT_DOCUMENT_SCOPE' });
  assert.equal(called, false);
});
