import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../../scripts/client.mjs';
import { loadNaverCookies, storeNaverCookies } from '../../scripts/session-vault.mjs';

export const SESSION_ORIGINS = Object.freeze([
  'https://admin.blog.naver.com', 'https://blog.naver.com',
  'https://blog.stat.naver.com',
]);

// Credentials never leave this process. No cookie database access, profile
// copying, browser launch, navigation, persisted storage state, or raw errors.
export async function authorizedSession({ fromChrome = false, timeoutMs = 15000 } = {}, {
  env = process.env, readText = readFile, now = Date.now,
  connect = async (endpoint, options) => (await import('playwright')).chromium.connectOverCDP(endpoint, options),
} = {}) {
  if (typeof fromChrome !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new ApiError('INPUT', 'Invalid session options or connection timeout');
  }
  if (env.NAVER_COOKIE && /[\r\n]/.test(env.NAVER_COOKIE)) throw new ApiError('INPUT', 'Invalid runtime cookie header');
  let cookies = [];
  let provider = 'runtime_environment';
  let stored;
  try { stored = await loadNaverCookies({ env, now }); }
  catch {
    if (!fromChrome || env.NAVER_COOKIE) throw new ApiError('AUTH_MISSING', 'Stored Naver session is invalid or unavailable');
    stored = { cookies: [], provider: null };
  }
  if (stored.provider && stored.cookies.length) {
    cookies = stored.cookies;
    provider = stored.provider;
    if (!['NID_AUT', 'NID_SES'].every(name => cookies.some(c => c.name === name && c.value))) {
      cookies = [];
      provider = 'runtime_environment';
    }
  }
  if (!cookies.length) {
    if (!fromChrome) throw new ApiError('AUTH_MISSING', 'Provide NAVER_COOKIE or explicitly select --from-chrome');
    provider = 'authorized_chrome_one_time_handoff';
    let browser;
    try {
      if (!env.LOCALAPPDATA) throw new ApiError('CDP_SCOPE', 'Windows profile location is unavailable');
      const portFile = path.join(env.LOCALAPPDATA, 'Google/Chrome/User Data/DevToolsActivePort');
      const [port, socketPath] = (await readText(portFile, 'utf8')).trim().split(/\r?\n/);
      if (port !== '9222' || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(socketPath)) {
        throw new ApiError('CDP_SCOPE', 'Endpoint differs from the user-confirmed Chrome debugging server');
      }
      browser = await connect(`ws://127.0.0.1:9222${socketPath}`, { timeout: timeoutMs, noDefaults: true });
      const contexts = browser.contexts().filter(context => context.pages().some(page => {
        try { return SESSION_ORIGINS.includes(new URL(page.url()).origin); } catch { return false; }
      }));
      if (contexts.length !== 1) throw new ApiError('CDP_CONTEXT', 'A unique existing Naver browser context is required');
      cookies = (await contexts[0].cookies(SESSION_ORIGINS)).filter(c =>
        (c.domain === 'naver.com' || c.domain === '.naver.com' || c.domain.endsWith('.naver.com')) &&
        (c.expires === -1 || c.expires > now() / 1000));
      if (!['NID_AUT', 'NID_SES'].every(name => cookies.some(c => c.name === name && c.value))) {
        throw new ApiError('AUTH_MISSING', 'Current Naver login cookies are absent');
      }
      try { await storeNaverCookies(cookies); }
      catch { cookies = []; throw new ApiError('CREDENTIAL_STORE_FAILED', 'Captured session could not be stored in the Windows DPAPI vault'); }
    } catch (error) {
      cookies = [];
      if (error instanceof ApiError) throw error;
      const text = String(error?.message || '');
      throw new ApiError('CDP_UNAVAILABLE', 'Existing Chrome connection or approval failed; no alternate profile was opened', {
        failureKind: error?.name === 'TimeoutError' || /[Tt]imeout/.test(text) ? 'connection_timeout' : /ENOENT/.test(text) ? 'endpoint_file_missing' : /ECONNREFUSED/.test(text) ? 'connection_refused' : /403|denied|not allowed/i.test(text) ? 'connection_denied' : 'protocol_or_transport',
        protocolMethod: /Protocol error \(([A-Za-z.]+)\)/.exec(text)?.[1] || null,
        httpStatus: /Unexpected server response: (\d{3})/.exec(text)?.[1] || null,
      });
    } finally {
      // This connection did not create contexts or pages; close disconnects.
      if (browser) {
        try { await browser.close(); }
        catch { cookies = []; throw new ApiError('CDP_DISCONNECT', 'Browser disconnect was not confirmed; session was discarded'); }
      }
    }
  }
  let active = true;
  return Object.freeze({
    provider,
    userAgent: stored?.provider === provider ? stored.userAgent || null : null,
    cookieFor(raw) {
      if (!active) throw new ApiError('AUTH_MISSING', 'Session was cleared');
      let url;
      try { url = new URL(raw); } catch { throw new ApiError('SCOPE', 'Invalid credential destination'); }
      if (!SESSION_ORIGINS.includes(url.origin) || url.username || url.password) {
        throw new ApiError('SCOPE', 'Credentials may only reach the approved Naver Blog origins');
      }
      return cookies.filter(c => {
        const domain = c.domain.replace(/^\./, '');
        const domainMatch = url.hostname === domain || (c.domain.startsWith('.') && url.hostname.endsWith('.' + domain));
        const p = c.path || '/';
        const pathMatch = url.pathname === p || (url.pathname.startsWith(p) && (p.endsWith('/') || url.pathname[p.length] === '/'));
        return domainMatch && pathMatch && (c.expires === -1 || c.expires > now() / 1000);
      }).sort((a, b) => (b.path || '/').length - (a.path || '/').length).map(c => `${c.name}=${c.value}`).join('; ');
    },
    clear() { cookies = []; active = false; },
  });
}
