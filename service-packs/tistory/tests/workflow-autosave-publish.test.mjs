// Offline contract tests for workflows ported from affiliate-content-automation (2026-10-14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { updateExistingAutosave } from '../lib/workflows/autosave-draft.mjs';
import { publishReviewed } from '../lib/workflows/publish-reviewed.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const entry = (over = {}) => ({ autosavedEntry: { title: 'old', content: '<p>old</p>', tags: '', categoryId: 1, draftSequence: 7, totalWritingTimeMs: 10, ...over } });

test('autosave update writes once, reads back, and never publishes', async () => {
  const calls = []; let state = entry();
  const request = async body => { calls.push(body ? 'POST' : 'GET'); if (body) { state = entry({ title: body.title, content: body.content }); return { success: true }; } return state; };
  const r = await updateExistingAutosave({ draftSequence: 7, title: 'new', content: '<p>new</p>' }, { request });
  assert.deepEqual(calls, ['GET', 'POST', 'GET']);
  assert.equal(r.readbackVerified, true); assert.equal(r.publiclyPublished, false); assert.equal(r.reused, false);
});

test('autosave refuses a different draft sequence and an unconfirmed write without retry', async () => {
  await assert.rejects(updateExistingAutosave({ draftSequence: 8, title: 't', content: 'c' }, { request: async () => entry() }), /no write performed/);
  let posts = 0;
  const request = async body => { if (body) { posts++; return { success: false }; } return entry(); };
  await assert.rejects(updateExistingAutosave({ draftSequence: 7, title: 't', content: 'c' }, { request }), /read back before any retry/);
  assert.equal(posts, 1);
});

test('publish requires the consumer marker policy and journals before the single POST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tistory-publish-'));
  await mkdir(join(root, 'data/pilots'), { recursive: true });
  await writeFile(join(root, 'data/pilots/review.json'), '{}');
  const content = '<p>hello</p>';
  const payload = { id: '0', title: 'T', content, visibility: 20, category: 5, tag: '', published: 1, uselessMarginForEntry: 1,
    cclCommercial: 0, cclDerive: 0, type: 'post', attachments: [], recaptchaValue: '', draftSequence: null, totalWritingTimeMs: 0 };
  const input = { contentId: 'c1', payload, reviewedContentHash: sha(content), reviewEvidenceRef: 'data/pilots/review.json',
    expected: { title: 'T', disclosure: 'd', links: [] } };
  await assert.rejects(publishReviewed(root, input, { request: async () => { throw Error('no'); } }), /inspectPublication dependency required/);
  const inspectPublication = () => ({ status: 'content-markers-present', missing: [] });
  let posts = 0;
  const request = async (path, { method = 'GET' } = {}) => {
    if (path.startsWith('/manage/newpost/')) return { httpStatus: 200, mime: 'text/html', raw: 'blog: {"categories":[{"id":5,"name":"n","visibility":20}],"visibility":20}\nneedCaptcha: false\n' };
    if (path === '/manage/post.json' && method === 'POST') { posts++; const ledger = JSON.parse(await readFile(join(root, 'data/publications/c1.json'), 'utf8')); assert.equal(ledger.status, 'create-intended'); throw Error('timeout'); }
    throw Error('unexpected ' + path);
  };
  await assert.rejects(publishReviewed(root, input, { request, inspectPublication }), /reconcile/);
  assert.equal(posts, 1);
  const ledger = JSON.parse(await readFile(join(root, 'data/publications/c1.json'), 'utf8'));
  assert.equal(ledger.status, 'needs-reconciliation');
  await assert.rejects(publishReviewed(root, input, { request, inspectPublication }), /do not resend POST/);
  assert.equal(posts, 1, 'indeterminate create is never retried');
});

test('workflow origin stays equal to the scoped transport origin', async () => {
  const { BLOG_ORIGIN: workflowOrigin } = await import('../lib/workflows/origin.mjs');
  const { BLOG_ORIGIN } = await import('../lib/transport.mjs');
  assert.equal(workflowOrigin, BLOG_ORIGIN);
});
