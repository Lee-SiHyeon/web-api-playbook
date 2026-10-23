import { loadWebAuth } from './web-auth-provider.mjs';

export async function coupangSearchStatus() {
  try {
    const auth = await loadWebAuth('coupang');
    const status = auth.status();
    return { source: 'coupang_partners_web_search', sessionStored: status.sessionStored === true,
      adapterReady: typeof auth.search === 'function',
      usableForAttempt: status.sessionStored === true && typeof auth.search === 'function' };
  } catch { return { source: 'coupang_partners_web_search', sessionStored: false, adapterReady: false, usableForAttempt: false }; }
}

export async function readCoupangProducts({ query, limit = 36 } = {}) {
  const auth = await loadWebAuth('coupang');
  if (typeof auth.search !== 'function') throw Object.assign(new Error('COUPANG_SEARCH_ADAPTER_MISSING'), { code: 'COUPANG_SEARCH_ADAPTER_MISSING' });
  return auth.search({ query, limit });
}
