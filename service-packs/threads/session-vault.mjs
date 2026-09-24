import { createHash } from 'node:crypto';
import { ProtectedStore } from '../../lib/protected-store.mjs';
import { withSessionLock } from '../../lib/session-lock.mjs';
import path from 'node:path';

const store = new ProtectedStore({ provider: process.platform === 'win32' ? 'dpapi' : 'memory' });
const printable = /^[\x21-\x7e]+$/;
const cacheName = (handle, code) => 'threads.' + createHash('sha256').update(handle + '\0' + (code || '')).digest('hex').slice(0, 40);
function valid(session, handle, code, now) {
 if (!session || session.version !== 1 || session.handle !== handle || (session.code || null) !== (code || null)
  || !/^[A-Za-z0-9_.]{1,30}$/.test(handle) || code != null && !/^[A-Za-z0-9_-]{5,30}$/.test(code)
  || typeof session.lsd !== 'string' || !printable.test(session.lsd) || session.lsd.length > 4096
  || typeof session.csrf !== 'string' || !printable.test(session.csrf) || session.csrf.length > 4096
  || session.cookie !== 'csrftoken=' + session.csrf || !session.site || typeof session.site !== 'object' || Array.isArray(session.site)
  || !Number.isFinite(session.expiresAt) || session.expiresAt <= now || session.expiresAt > now + 86400000) return false;
 let url; try { url = new URL(session.referer); } catch { return false; }
 if (url.origin !== 'https://www.threads.com' || url.pathname !== '/@' + handle + (code ? '/post/' + code : '') || url.search || url.hash || url.username || url.password) return false;
 const contract = session.profileContract;
 return contract == null || (contract.name === 'BarcelonaProfileThreadsTabDirectQuery' && typeof contract.docId === 'string' && /^\d+$/.test(contract.docId) && contract.variables && typeof contract.variables === 'object' && !Array.isArray(contract.variables));
}
export async function storeThreadsSession(session, { now = Date.now(), ttlMs = 300000 } = {}) {
 if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) throw new Error('THREADS_SESSION_INVALID');
 const value = { version: 1, handle: session.handle, code: session.code || null, referer: session.referer,
  lsd: session.lsd, csrf: session.csrf, cookie: session.cookie, site: session.site,
  profileContract: session.profileContract || null, expiresAt: Math.min(session.expiresAt || now + ttlMs, now + ttlMs) };
 if (!valid(value, value.handle, value.code, now)) throw new Error('THREADS_SESSION_INVALID');
 const name = cacheName(value.handle, value.code);
 return withSessionLock(() => store.write(name, JSON.stringify(value)), { root: path.join(store.directory, 'locks'), key: name });
}
export async function loadThreadsSession(handle, code = null, { now = Date.now() } = {}) {
 if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle || '') || code != null && !/^[A-Za-z0-9_-]{5,30}$/.test(code)) throw new Error('THREADS_SESSION_INVALID');
 const name = cacheName(handle, code);
 const raw = await withSessionLock(() => store.read(name), { root: path.join(store.directory, 'locks'), key: name });
 if (!raw) return null;
 let value; try { value = JSON.parse(raw); } catch { throw new Error('THREADS_SESSION_INVALID'); }
 return valid(value, handle, code, now) ? { ...value, reusedSession: true } : null;
}
