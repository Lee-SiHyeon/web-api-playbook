// Journal-first writes over the official API. No auto-retry. Timeout/transport loss => needs-reconciliation.
import { createHash } from 'node:crypto';
import { WriteJournal } from '../../../lib/write-journal.mjs';

const sha = s => createHash('sha256').update(String(s ?? '')).digest('hex');

export async function executeWrite({ api, journalRoot, operation, blogId, postId, content = {} }) {
  if (!['create-draft', 'publish', 'update'].includes(operation)) throw Object.assign(new Error('BLOGGER_OPERATION_NOT_ALLOWED'), { code: 'BLOGGER_OPERATION_NOT_ALLOWED' });
  const journal = new WriteJournal({ root: journalRoot, service: 'blogger' });
  const fingerprint = { title: sha(content.title), content: sha(content.content), labels: sha(JSON.stringify(content.labels || [])) };
  const key = journal.key(operation, { blogId, postId: postId || null }, fingerprint);
  await journal.reserve(key, { operation, blogId, postId: postId || null, titleHash: fingerprint.title, contentHash: fingerprint.content, phase: 'business request' });
  let res;
  try {
    if (operation === 'create-draft') res = await api.insertDraft(blogId, { title: content.title, content: content.content, labels: content.labels });
    else if (operation === 'publish') res = await api.publish(blogId, postId);
    else res = await api.patch(blogId, postId, Object.fromEntries(Object.entries({ title: content.title, content: content.content, labels: content.labels }).filter(([, v]) => v != null)));
  } catch (e) {
    const definite = e?.status && e.status >= 400 && e.status < 500;
    const rec = await journal.finish(key, definite ? 'rejected' : 'outcome-unknown', { errorCode: e?.code || 'UNKNOWN', httpStatus: e?.status ?? null });
    return { key, status: rec.status, state: rec.state, errorCode: e?.code };
  }
  const rec = await journal.finish(key, 'acknowledged_requires_readback', { postId: res?.id ?? null, serverStatus: res?.status ?? null });
  return { key, status: rec.status, state: rec.state, postId: res?.id ?? null, serverStatus: res?.status ?? null, next: 'readback via get-post then journal.reconcile' };
}
