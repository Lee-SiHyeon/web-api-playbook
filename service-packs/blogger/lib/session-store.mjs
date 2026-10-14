// Session material lives OUTSIDE git (default ~/.config/web-api-playbook/blogger), mode 0600.
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const COOKIE_DOMAINS = Object.freeze(['.google.com', 'google.com', 'www.google.com', 'accounts.google.com', '.blogger.com', 'www.blogger.com', 'blogger.com']);

export function stateDir(env = process.env) {
  return env.BLOGGER_STATE_DIR || path.join(homedir(), '.config', 'web-api-playbook', 'blogger');
}
export function sessionPath(env = process.env) { return path.join(stateDir(env), 'session.json'); }

function err(code) { const e = new Error(code); e.code = code; return e; }

export function filterCookies(cookies) {
  if (!Array.isArray(cookies)) throw err('BLOGGER_SESSION_INVALID');
  return cookies
    .filter(c => c && typeof c.name === 'string' && typeof c.value === 'string' && COOKIE_DOMAINS.includes(c.domain))
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', expires: typeof c.expires === 'number' ? c.expires : -1, secure: !!c.secure, httpOnly: !!c.httpOnly }));
}

export function saveSession(cookies, { env = process.env, source = 'cdp' } = {}) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = sessionPath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  const filtered = filterCookies(cookies);
  writeFileSync(tmp, JSON.stringify({ version: 1, source, savedAt: new Date().toISOString(), cookies: filtered }), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return { file, cookieCount: filtered.length, cookieNames: [...new Set(filtered.map(c => c.name))].sort() };
}

export function loadSession({ env = process.env } = {}) {
  const file = sessionPath(env);
  let st;
  try { st = statSync(file); } catch { return null; }
  if ((st.mode & 0o077) !== 0) throw err('BLOGGER_SESSION_PERMISSIONS_TOO_OPEN');
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw err('BLOGGER_SESSION_INVALID'); }
  if (parsed?.version !== 1) throw err('BLOGGER_SESSION_INVALID');
  return { ...parsed, cookies: filterCookies(parsed.cookies) };
}

// Import cookies from an already-running, already-logged-in Chrome via CDP Network.getCookies.
// Only the explicit DevTools endpoint given by the operator is used; no profile files are read.
export async function importFromCdp({ cdp = process.env.BLOGGER_CDP || 'http://127.0.0.1:9225', env = process.env, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const u = new URL(cdp);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw err('BLOGGER_CDP_NOT_LOOPBACK');
  const version = await (await fetchImpl(new URL('/json/version', u))).json();
  const ws = new WebSocketImpl(version.webSocketDebuggerUrl);
  const cookies = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.close(); reject(err('BLOGGER_CDP_TIMEOUT')); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} }));
    ws.onerror = () => { clearTimeout(t); reject(err('BLOGGER_CDP_FAILED')); };
    ws.onmessage = ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.id !== 1) return;
      clearTimeout(t); ws.close();
      m.error ? reject(err('BLOGGER_CDP_FAILED')) : resolve(m.result.cookies);
    };
  });
  return saveSession(cookies, { env, source: 'cdp' });
}
