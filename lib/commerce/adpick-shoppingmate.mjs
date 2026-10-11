// Server-side, documented GET reads only. No login, key scraping, link issuance or conversion reader.
import { createHash } from 'node:crypto';

const ORIGIN = 'https://biz.adpick.co.kr';
const LIMITS = Object.freeze({ malls: 60, search: 10, best: 10 });
const WINDOWS = new Map(); // Shared per-key process budget; not a distributed scheduler.
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const CODE_NAMES = new Set(['ADPICK_INPUT_INVALID', 'ADPICK_CREDENTIAL_UNAVAILABLE', 'ADPICK_LOCAL_QUOTA',
  'ADPICK_TIMEOUT', 'ADPICK_TRANSPORT', 'ADPICK_REDIRECT_REJECTED', 'ADPICK_BODY_LIMIT',
  'ADPICK_SCHEMA_INVALID', 'ADPICK_KEY_REJECTED', 'ADPICK_API_QUOTA', 'ADPICK_ACCESS_UNKNOWN',
  'ADPICK_API_INPUT_REJECTED', 'ADPICK_API_UNAVAILABLE', 'ADPICK_API_ERROR', 'ADPICK_SECRET_REFLECTION']);

export class AdpickReadError extends Error {
  constructor(code, receipt) {
    const safeCode = CODE_NAMES.has(code) ? code : 'ADPICK_TRANSPORT';
    super(safeCode);
    this.name = 'AdpickReadError';
    this.code = safeCode;
    if (object(receipt) && receipt.method === 'GET' && receipt.origin === ORIGIN
      && /^\/api\/\{redacted\}\/(?:malls|search|best)$/.test(receipt.path)) {
      const fields = ['rewardmalls', 'order', 'p_data', 'q', 'limit', 'area'];
      const clean = { method: 'GET', origin: ORIGIN, path: receipt.path,
        queryFields: Array.isArray(receipt.queryFields) ? receipt.queryFields.filter(value => fields.includes(value)).slice(0, 6) : [],
        httpStatus: Number.isInteger(receipt.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599 ? receipt.httpStatus : null };
      if (Number.isSafeInteger(receipt.responseBytes) && receipt.responseBytes >= 0 && receipt.responseBytes <= 2 * 1024 * 1024) clean.responseBytes = receipt.responseBytes;
      if (typeof receipt.responseSha256 === 'string' && /^[0-9a-f]{64}$/.test(receipt.responseSha256)) clean.responseSha256 = receipt.responseSha256;
      this.receipt = Object.freeze(clean);
    }
  }
}
const fail = (code, receipt) => { throw new AdpickReadError(code, receipt); };
export const safeAdpickError = error => error instanceof AdpickReadError && CODE_NAMES.has(error.code) ? error.code : 'ADPICK_TRANSPORT';

function args(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('ADPICK_INPUT_INVALID');
  if (value.pData !== undefined && (typeof value.pData !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(value.pData))) fail('ADPICK_INPUT_INVALID');
}
function number(value, fallback, maximum) {
  const actual = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) fail('ADPICK_INPUT_INVALID');
  return actual;
}
function reserveBudget(key, operation, now) {
  const identity = hash(key);
  if (!Number.isFinite(now)) fail('ADPICK_INPUT_INVALID');
  const existing = WINDOWS.get(identity) ?? [];
  const recent = existing.filter(entry => entry.at > now - 60_000);
  // The guide also says aggregate10/min in its FAQ. Honor that stricter unresolved claim.
  if (recent.length >= 10 || recent.filter(entry => entry.operation === operation).length >= LIMITS[operation]) fail('ADPICK_LOCAL_QUOTA');
  recent.push({ operation, at: now });
  WINDOWS.set(identity, recent);
  if (WINDOWS.size > 1024) for (const [id, entries] of WINDOWS) {
    if (entries.every(entry => entry.at <= now - 60_000)) WINDOWS.delete(id);
  }
}

function strings(row, fields, key) {
  if (!object(row)) fail('ADPICK_SCHEMA_INVALID');
  const result = {};
  for (const name of fields) {
    const value = row[name];
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) fail('ADPICK_SCHEMA_INVALID');
    let decoded = value;
    for (let depth = 0; depth < 8; depth++) {
      if (decoded.includes(key)) fail('ADPICK_SECRET_REFLECTION');
      const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (next === decoded) break;
      decoded = next;
    }
    if (decoded.includes(key) || /%[0-9a-f]{2}/i.test(decoded)) fail('ADPICK_SECRET_REFLECTION');
    // Never expose key-bearing API links, including reflected directlink URLs.
    if (/https?:\/\/biz\.adpick\.co\.kr(?::\d+)?\/api\//i.test(decoded)) fail('ADPICK_SECRET_REFLECTION');
    if (['commissionlink', 'photo', 'icon', 'cp_icon'].includes(name) && value !== '') {
      let url;
      try { url = new URL(value); } catch { fail('ADPICK_SCHEMA_INVALID'); }
      if (url.protocol !== 'https:' || url.username || url.password) fail('ADPICK_SCHEMA_INVALID');
    }
    result[name] = value;
  }
  return result;
}
function decode(data, operation, input, key) {
  if (operation === 'malls') {
    if (!Array.isArray(data) || data.length > 500) fail('ADPICK_SCHEMA_INVALID');
    return data.map(row => strings(row, ['cp_code', 'name', 'icon', 'title', 'commissionlink', 'commission_per'], key));
  }
  const productFields = ['title', 'photo', 'cp_code', 'cp_name', 'cp_icon', 'commissionlink'];
  if (operation === 'search') {
    if (!Array.isArray(data) || data.length > input.limit) fail('ADPICK_SCHEMA_INVALID');
    return data.map(row => strings(row, [...productFields, 'price'], key));
  }
  if (!object(data) || data.area !== input.area || typeof data.area_name !== 'string'
    || !Number.isSafeInteger(data.count) || data.count < 0 || !Array.isArray(data.list)
    || data.count !== data.list.length || data.count > input.limit) fail('ADPICK_SCHEMA_INVALID');
  const header = strings(data, ['area', 'area_name'], key);
  return { ...header, count: data.count, list: data.list.map(row => {
    const fields = strings(row, productFields, key);
    if (typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price < 0
      || typeof row.commission_per !== 'number' || !Number.isFinite(row.commission_per) || row.commission_per < 0) fail('ADPICK_SCHEMA_INVALID');
    return { ...fields, price: row.price, commission_per: row.commission_per };
  }) };
}

export function createAdpickReadClient({ apiKeyProvider, fetchImpl = globalThis.fetch,
  timeoutMs = 15_000, maxBodyBytes = 1024 * 1024, now = Date.now } = {}) {
  if (typeof window !== 'undefined' || typeof apiKeyProvider !== 'function' || typeof fetchImpl !== 'function'
    || typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 5 || timeoutMs > 30_000
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 100 || maxBodyBytes > 2 * 1024 * 1024) fail('ADPICK_INPUT_INVALID');
  let credential;
  async function key() {
    if (!credential) credential = Promise.resolve().then(apiKeyProvider).then(value => {
      // Transport policy, not a claim about Adpick's undocumented key alphabet.
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) fail('ADPICK_CREDENTIAL_UNAVAILABLE');
      return value;
    }).catch(() => fail('ADPICK_CREDENTIAL_UNAVAILABLE'));
    return credential;
  }
  async function request(operation, input) {
    let receipt = { method: 'GET', origin: ORIGIN, path: `/api/{redacted}/${operation}`,
      queryFields: Object.keys(input).map(name => name === 'pData' ? 'p_data' : name), httpStatus: null };
    const controller = new AbortController();
    let reader;
    let responseBody;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AdpickReadError('ADPICK_TIMEOUT', receipt));
      }, timeoutMs);
    });
    const work = async () => {
      const secret = await key();
      if (controller.signal.aborted) fail('ADPICK_TIMEOUT', receipt);
      reserveBudget(secret, operation, now());
      const url = new URL(`/api/${encodeURIComponent(secret)}/${operation}`, ORIGIN);
      for (const [name, value] of Object.entries(input)) if (name !== 'pData') url.searchParams.set(name, String(value));
      if (input.pData !== undefined) url.searchParams.set('p_data', input.pData);
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'application/json' }, signal: controller.signal });
      responseBody = response.body;
      receipt = { ...receipt, httpStatus: response.status };
      if (response.redirected || (response.url && response.url !== url.href)
        || (response.status >= 300 && response.status < 400)) fail('ADPICK_REDIRECT_REJECTED', receipt);
      const mime = response.headers.get('content-type') ?? '';
      // PHP can serve JSON as text/html. The published contract is the bounded JSON envelope,
      // not an observed Biz MIME header; actual HTML/login bodies still fail JSON validation.
      if (mime && !/^(?:application\/json|[^;\s]+\+json|text\/(?:plain|html))(?:\s*;|$)/i.test(mime)) {
        fail(response.status === 403 ? 'ADPICK_ACCESS_UNKNOWN' : 'ADPICK_SCHEMA_INVALID', receipt);
      }
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > maxBodyBytes) fail('ADPICK_BODY_LIMIT', receipt);
      if (!response.body?.getReader) fail('ADPICK_SCHEMA_INVALID', receipt);
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBodyBytes) fail('ADPICK_BODY_LIMIT', receipt);
        chunks.push(Buffer.from(chunk.value));
      }
      const body = Buffer.concat(chunks, size);
      receipt = { ...receipt, responseBytes: size, responseSha256: hash(body) };
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { fail(response.status === 403 ? 'ADPICK_ACCESS_UNKNOWN' : 'ADPICK_SCHEMA_INVALID', receipt); }
      if (!object(payload)) fail(response.status === 403 ? 'ADPICK_ACCESS_UNKNOWN' : 'ADPICK_SCHEMA_INVALID', receipt);
      if (!response.ok || payload.success !== true) {
        const documented = payload.status === 'error' && typeof payload.error === 'string'
          && [400, 401, 403, 404, 501].includes(payload.code);
        const code = documented ? payload.code : response.status;
        fail(code === 401 ? 'ADPICK_KEY_REJECTED' : code === 403 ? (documented ? 'ADPICK_API_QUOTA' : 'ADPICK_ACCESS_UNKNOWN')
          : code === 400 ? 'ADPICK_API_INPUT_REJECTED' : code >= 500 ? 'ADPICK_API_UNAVAILABLE' : 'ADPICK_API_ERROR', receipt);
      }
      if (!own(payload, 'data') || typeof payload.message !== 'string') fail('ADPICK_SCHEMA_INVALID', receipt);
      let data;
      try { data = decode(payload.data, operation, input, secret); }
      catch (error) { fail(safeAdpickError(error), receipt); }
      return { operation, observedAt: new Date(now()).toISOString(), data, receipt,
        semantics: { priceBasis: 'reference_only', selection: operation === 'best' ? 'random_bounded_sample' : 'bounded_response',
          explicitRanks: false, originalProductOptionSellerIdentity: 'not_documented',
          returnedCommissionLinks: 'provider_returned_not_independently_owner_or_destination_verified',
          productImageReuseRights: 'not_established', authenticatedOwnerVerified: false } };
    };
    try { return await Promise.race([work(), timeout]); }
    catch (error) {
      if (error instanceof AdpickReadError) throw error;
      fail(controller.signal.aborted ? 'ADPICK_TIMEOUT' : 'ADPICK_TRANSPORT', receipt);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
      else if (responseBody) responseBody.cancel().catch(() => {});
    }
  }
  return Object.freeze({
    readMalls(input = {}) {
      args(input, ['rewardmalls', 'order', 'pData']);
      const rewardmalls = input.rewardmalls ?? false;
      const order = input.order ?? 'new';
      if (typeof rewardmalls !== 'boolean' || !['new', 'popular', 'commission'].includes(order)) fail('ADPICK_INPUT_INVALID');
      return request('malls', { rewardmalls, order, ...(input.pData === undefined ? {} : { pData: input.pData }) });
    },
    searchProducts(input) {
      args(input, ['q', 'limit', 'pData']);
      if (typeof input.q !== 'string' || input.q.trim().length === 0 || input.q.length > 200
        || /[\u0000-\u001f\u007f]/.test(input.q)) fail('ADPICK_INPUT_INVALID');
      return request('search', { q: input.q, limit: number(input.limit, 10, 20), ...(input.pData === undefined ? {} : { pData: input.pData }) });
    },
    bestProducts(input) {
      args(input, ['area', 'limit', 'pData']);
      if (!['today', 'commission', 'pick', 'popular'].includes(input.area)) fail('ADPICK_INPUT_INVALID');
      return request('best', { area: input.area, limit: number(input.limit, 5, 10), ...(input.pData === undefined ? {} : { pData: input.pData }) });
    },
  });
}
