const AUTOSUG_ORIGIN = 'https://autosug.ebay.com';
const AUTOSUG_PATH = '/autosug';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SUGGESTIONS = 20;

export class EbayPublicError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'EbayPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new EbayPublicError(code, receipt); };
const validText = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 300 && !/[\x00-\x1f\x7f]/.test(value);

async function boundedBody(response, receipt) {
  if (!response.body?.getReader) fail('EBAY_RESPONSE_INVALID', receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail('EBAY_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: total });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total).toString('utf8');
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// eBay's public suggestion service. It is not the item-search/Browse API.
export function createEbayPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('EBAY_CLIENT_INVALID');
  async function getSuggestions(query, fields) {
      if (!validText(query) || !validText(query.trim()) || query.trim().length > 100) fail('EBAY_QUERY_INVALID');
      const submitted = query.trim();
      const url = new URL(AUTOSUG_PATH, AUTOSUG_ORIGIN);
      url.search = new URLSearchParams(fields(submitted)).toString();
      const receipt = { method: 'GET', origin: AUTOSUG_ORIGIN, path: AUTOSUG_PATH,
        queryFields: [...url.searchParams.keys()], browserUsed: false, anonymous: true,
        checkedAt: new Date(now()).toISOString() };
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
          headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        fail('EBAY_TRANSPORT_FAILED', { ...receipt, causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
      }
      const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
      const observed = { ...receipt, httpStatus: response.status, mime };
      if (response.status === 401) fail('EBAY_AUTH_REQUIRED', observed);
      if (response.status === 403) fail('EBAY_ACCESS_BLOCKED', observed);
      if (response.status === 429) fail('EBAY_THROTTLED', observed);
      if (response.status !== 200 || mime !== 'application/json' || response.redirected) fail('EBAY_RESPONSE_INVALID', observed);
      let raw;
      try { raw = await boundedBody(response, observed); }
      catch (error) {
        if (error instanceof EbayPublicError) throw error;
        fail('EBAY_TRANSPORT_FAILED', observed);
      }
      const responseBytes = Buffer.byteLength(raw);
      let payload;
      try { payload = JSON.parse(raw); }
      catch { fail('EBAY_RESPONSE_INVALID', { ...observed, responseBytes }); }
      return { payload, submitted, receipt: { ...observed, responseBytes } };
  }
  return {
    async suggestKeywords({ query } = {}) {
      const { payload, submitted, receipt } = await getSuggestions(query, submitted =>
        ({ sId: '0', fmt: 'osr', kwd: submitted }));
      if (!Array.isArray(payload) || payload.length !== 2 || payload[0] !== submitted ||
          !Array.isArray(payload[1]) || payload[1].length > MAX_SUGGESTIONS ||
          payload[1].some(item => !validText(item))) {
        fail('EBAY_SCHEMA_INVALID', receipt);
      }
      return {
        query: payload[0], suggestions: payload[1],
        receipt: { ...receipt, suggestionCount: payload[1].length },
      };
    },
    async suggestCatalogHints({ query } = {}) {
      const { payload, submitted, receipt } = await getSuggestions(query, submitted =>
        ({ kwd: submitted, sId: '0', _richres: '1', callback: '0' }));
      const entries = payload?.richRes?.sug;
      if (!object(payload) || payload.prefix !== submitted || typeof payload.dict !== 'string' ||
          !object(payload.res) || !object(payload.richRes) || !Array.isArray(entries) ||
          entries.length > MAX_SUGGESTIONS || entries.some(entry => !object(entry) || !validText(entry.kwd) ||
            entry.categories !== undefined && (!Array.isArray(entry.categories) || entry.categories.length > 20 ||
              entry.categories.some(category => !object(category) || !/^\d{1,12}$/.test(category.catId) ||
                !validText(category.catName))))) fail('EBAY_SCHEMA_INVALID', receipt);
      const suggestions = entries.map(entry => entry.kwd);
      const categoryHints = entries.flatMap(entry => (entry.categories ?? []).map(category => ({
        keyword: entry.kwd, id: category.catId, name: category.catName,
      })));
      return { query: payload.prefix, suggestions, categoryHints,
        receipt: { ...receipt, suggestionCount: suggestions.length, categoryHintCount: categoryHints.length } };
    },
  };
}
