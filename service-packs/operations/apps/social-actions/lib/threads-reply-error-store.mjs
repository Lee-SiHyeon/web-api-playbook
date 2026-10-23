import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../../affiliate-api-hub/adapters/web-auth-provider.mjs';

// Response bodies may contain reflected session values. They never leave memory
// except through the maintained CurrentUser DPAPI store's stdin-only handoff.
export async function protectThreadsReplyError({ body, truncated, httpStatus, postId, journalPath }, { store } = {}) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 8196
    || typeof truncated !== 'boolean' || !Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599
    || !/^\d{10,25}$/.test(postId || '') || typeof journalPath !== 'string' || !journalPath) {
    throw new Error('THREADS_REPLY_ERROR_INPUT_INVALID');
  }
  if (!store) {
    const { ProtectedStore } = await import(pathToFileURL(path.join(webApiPlaybookRoot(), 'lib', 'protected-store.mjs')).href);
    store = new ProtectedStore();
  }
  const key = `threads-reply-error-${createHash('sha256').update(journalPath).digest('hex').slice(0, 40)}`;
  const value = JSON.stringify({ version: 1, origin: 'https://www.threads.com',
    pathname: '/api/v1/media/configure_text_only_post/', httpStatus, postId,
    capturedAt: new Date().toISOString(), truncated, body });
  const receipt = store.write(key, value);
  if (receipt?.provider !== 'Windows DPAPI CurrentUser' || receipt.persistent !== true || receipt.stored !== true) {
    throw new Error('THREADS_REPLY_ERROR_DPAPI_REQUIRED');
  }
  if (store.read(key) !== value) throw new Error('THREADS_REPLY_ERROR_READBACK_FAILED');
  return { providerErrorProtected: true, providerErrorStoreKey: key };
}
