import { ScopedSession } from './scoped-session.mjs';

export const GABIA_READ_ORIGINS = Object.freeze({
  user: 'https://gabia-user-api.gabia.com',
  dns: 'https://dns.gabia.com',
});

const OWNER_PATH = '/v1/users/me';
const DOMAIN_PATH = '/dns/ajax/domain';
const RECORD_PATH = '/dns/ajax/dns';
const OWNER_FIELDS = Object.freeze(['user_id', 'user_name', 'user_type', 'registration_site', 'registration_date']);
const DOMAIN_ROW_FIELDS = Object.freeze([
  'num', 'domain', 'type', 'status', 'tbl', 'owner_approval', 'domain_seqno', 'domain_addition',
  'expire_date', 'disabled', 'ssl_target',
]);
const DNS_ROOT_FIELDS = Object.freeze([
  'update_date', 'record', 'nameserver', 'addition', 'hasDomainConn', 'hasService', 'option', 'forwardingInfo',
]);
const DNS_RECORD_FIELDS = Object.freeze([
  'ttl', 'services_idx', 'seqno', 'domain', 'host', 'type', 'data', 'service', 'protocol', 'priority', 'weight',
  'port', 'target', 'is_layer', 'services_name', 'addition_service_name', 'action',
]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DNS_ROWS = 1000;
const MAX_COOKIES = 128;
const MAX_DOMAIN_LENGTH = 253;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export class GabiaReadError extends Error {
  constructor(code, receipt = undefined) {
    super(code);
    this.name = 'GabiaReadError';
    this.code = code;
    if (receipt) this.receipt = receipt;
  }
}

function fail(code, receipt) { throw new GabiaReadError(code, receipt); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed) { return Object.keys(value).every(key => allowed.includes(key)); }

export function normalizeGabiaDomain(value) {
  if (typeof value !== 'string' || value.length > MAX_DOMAIN_LENGTH || value !== value.trim()
      || /[\s\u0000-\u001f\u007f/:@?#\\]/.test(value)) fail('GABIA_DOMAIN_INVALID');
  const domain = value.toLowerCase().replace(/\.$/, '');
  const labels = domain.split('.');
  if (labels.length < 2 || labels.at(-1).length < 2 || labels.some(label => !LABEL.test(label))) {
    fail('GABIA_DOMAIN_INVALID');
  }
  return domain;
}

function validateReadInput(input) {
  if (!isObject(input) || input.schema !== 'gabia-read-input-v1'
      || !exactKeys(input, ['schema', 'domain', 'expectedUserId', 'cookies'])) fail('GABIA_INPUT_INVALID');
  const domain = normalizeGabiaDomain(input.domain);
  if (typeof input.expectedUserId !== 'string' || input.expectedUserId.length < 1
      || input.expectedUserId.length > 256 || /[\r\n\0]/.test(input.expectedUserId)) fail('GABIA_OWNER_PIN_INVALID');
  if (!Array.isArray(input.cookies) || input.cookies.length < 1 || input.cookies.length > MAX_COOKIES) {
    fail('GABIA_COOKIES_INVALID');
  }
  return { domain, expectedUserId: input.expectedUserId, cookies: input.cookies };
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'SCOPED_SESSION_REDIRECT_LIMIT' || code.startsWith('SCOPED_SESSION_REDIRECT')) return 'GABIA_REDIRECT_BLOCKED';
  if (code === 'SCOPED_SESSION_TIMEOUT') return 'GABIA_REQUEST_TIMEOUT';
  if (code === 'SCOPED_SESSION_RESPONSE_TOO_LARGE') return 'GABIA_RESPONSE_TOO_LARGE';
  if (code.startsWith('SCOPED_SESSION_COOKIE') || code === 'SCOPED_SESSION_COOKIES_INVALID'
      || code === 'SCOPED_SESSION_ORIGIN_INVALID' || code === 'SCOPED_SESSION_COOKIE_SCOPE_INVALID') {
    return 'GABIA_SESSION_INPUT_INVALID';
  }
  if (code.startsWith('SCOPED_SESSION_')) return 'GABIA_TRANSPORT_FAILED';
  return 'GABIA_TRANSPORT_FAILED';
}

function makeSession({ cookies, fetchImpl }) {
  try {
    return new ScopedSession({
      allowedOrigins: [GABIA_READ_ORIGINS.user, GABIA_READ_ORIGINS.dns],
      cookieOrigins: [GABIA_READ_ORIGINS.user, GABIA_READ_ORIGINS.dns],
      cookies,
      defaultHeaders: { accept: 'application/json' },
      headersByOrigin: { [GABIA_READ_ORIGINS.dns]: { 'x-requested-with': 'XMLHttpRequest' } },
      timeoutMs: 12_000,
      maxResponseBytes: MAX_JSON_BYTES,
      maxRequestBytes: 16_384,
      maxRedirects: 0,
      fetchImpl,
    });
  } catch {
    fail('GABIA_SESSION_INPUT_INVALID');
  }
}

async function getJson(session, { origin, path, queryNames = [], query = undefined, headers = undefined, now }) {
  if (![GABIA_READ_ORIGINS.user, GABIA_READ_ORIGINS.dns].includes(origin)) fail('GABIA_ORIGIN_BLOCKED');
  if (![
    `${GABIA_READ_ORIGINS.user}${OWNER_PATH}`,
    `${GABIA_READ_ORIGINS.dns}${DOMAIN_PATH}`,
    `${GABIA_READ_ORIGINS.dns}${RECORD_PATH}`,
  ].includes(`${origin}${path}`)) fail('GABIA_PATH_BLOCKED');
  const url = new URL(path, origin);
  if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const safePath = path;
  let response;
  try {
    response = await session.request(url.href, { method: 'GET', ...(headers ? { headers } : {}) });
  } catch (error) {
    fail(errorCode(error), {
      method: 'GET', origin, path: safePath, queryNames: [...queryNames].sort(),
      checkedAt: new Date(now()).toISOString(), browserUsed: false,
    });
  }
  const mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null;
  const receipt = {
    method: 'GET', origin, path: safePath, queryNames: [...queryNames].sort(), httpStatus: response.status,
    mime, responseBytes: Buffer.byteLength(response.raw), checkedAt: new Date(now()).toISOString(), browserUsed: false,
  };
  if (response.status === 401) fail('GABIA_REAUTH_REQUIRED', receipt);
  if (response.status === 403) fail('GABIA_ACCESS_FORBIDDEN', receipt);
  if (response.status === 429) fail('GABIA_RATE_LIMITED', receipt);
  if (response.status >= 300 && response.status < 400) fail('GABIA_REDIRECT_BLOCKED', receipt);
  if (response.status >= 500) fail('GABIA_SERVER_ERROR', receipt);
  if (response.status !== 200 || mime !== 'application/json' || receipt.responseBytes > MAX_JSON_BYTES) {
    fail('GABIA_RESPONSE_INVALID', receipt);
  }
  let data;
  try { data = JSON.parse(response.raw); } catch { fail('GABIA_RESPONSE_INVALID', receipt); }
  return { data, receipt };
}

function decodeOwner(value, expectedUserId, receipt) {
  if (!isObject(value) || !isObject(value.data)
      || OWNER_FIELDS.some(key => typeof value.data[key] !== 'string' || value.data[key].length > 512)) {
    fail('GABIA_OWNER_SCHEMA_INVALID', receipt);
  }
  const actualUserId = value.data.user_id;
  if (actualUserId !== expectedUserId) fail('GABIA_OWNER_MISMATCH', {
    ...receipt, identityMatch: false, responseKeys: ['data'], ownerFields: [...OWNER_FIELDS],
  });
  return {
    authenticated: true,
    ownerVerified: true,
    identityMatch: true,
    identityField: 'user_id',
    emailReturned: false,
    responseKeys: ['data'],
    ownerFields: [...OWNER_FIELDS],
    receipt: { ...receipt, identityMatch: true, responseKeys: ['data'], ownerFields: [...OWNER_FIELDS] },
  };
}

function makeDomainQuery(domain, now) {
  return {
    _: String(Math.trunc(now())),
    domain,
    kind: 'internal',
    sorting_method: 'asc',
    sorting_val: 'domain',
    view_cnt: '10',
    view_page: '1',
  };
}

function decodeDomainList(value, targetDomain, receipt) {
  const validRow = row => isObject(row)
    && Number.isSafeInteger(row.num)
    && ['domain', 'type', 'status', 'tbl', 'domain_seqno', 'domain_addition', 'expire_date', 'disabled', 'ssl_target']
      .every(key => typeof row[key] === 'string' && row[key].length <= 2048)
    && (row.owner_approval === null || typeof row.owner_approval === 'string');
  if (!isObject(value) || !Array.isArray(value.list) || value.list.length > 100
      || typeof value.last_flag !== 'boolean' || typeof value.domain_cnt !== 'string'
      || typeof value.request_view_cnt !== 'string' || typeof value.request_view_page !== 'string'
      || value.list.some(row => !validRow(row) || DOMAIN_ROW_FIELDS.some(key => !Object.hasOwn(row, key)))) {
    fail('GABIA_DOMAIN_LIST_SCHEMA_INVALID', receipt);
  }
  const targetDomainPresent = value.list.some(row => typeof row.domain === 'string'
    && row.domain.toLowerCase().replace(/\.$/, '') === targetDomain);
  return {
    targetDomainPresent,
    responseKeys: ['list', 'last_flag', 'domain_cnt', 'request_view_cnt', 'request_view_page'],
    rowFields: [...DOMAIN_ROW_FIELDS],
    receipt: { ...receipt, targetDomainPresent, responseKeys: ['list', 'last_flag', 'domain_cnt', 'request_view_cnt', 'request_view_page'],
      rowFields: [...DOMAIN_ROW_FIELDS] },
  };
}

function decodeRecords(value, targetDomain, receipt) {
  if (!isObject(value) || DNS_ROOT_FIELDS.some(key => !Object.hasOwn(value, key))
      || typeof value.update_date !== 'string' || typeof value.nameserver !== 'string'
      || !isObject(value.addition) || !Array.isArray(value.hasDomainConn) || !Array.isArray(value.hasService)
      || !isObject(value.option) || !Array.isArray(value.forwardingInfo)
      || !Array.isArray(value.record) || value.record.length > MAX_DNS_ROWS
      || value.record.some(row => !isObject(row) || DNS_RECORD_FIELDS.some(key => !Object.hasOwn(row, key)))) {
    fail('GABIA_DNS_SCHEMA_INVALID', receipt);
  }
  const records = [];
  for (const row of value.record) {
    if (typeof row.domain !== 'string' || row.domain.toLowerCase().replace(/\.$/, '') !== targetDomain) continue;
    if (typeof row.type !== 'string' || typeof row.host !== 'string' || typeof row.data !== 'string'
        || !Number.isSafeInteger(row.ttl) || row.ttl < 0 || row.ttl > 2_147_483_647) fail('GABIA_DNS_SCHEMA_INVALID', receipt);
    const type = row.type.toUpperCase();
    if (!['A', 'AAAA', 'CNAME'].includes(type)) continue;
    if (row.host.length > 255 || /[\u0000-\u001f\u007f]/.test(row.host)
        || row.data.length > 4096 || /[\u0000-\u001f\u007f]/.test(row.data)) fail('GABIA_DNS_SCHEMA_INVALID', receipt);
    records.push({ type, host: row.host, value: row.data, ttl: row.ttl });
  }
  records.sort((a, b) => a.host.localeCompare(b.host) || a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
  return {
    targetDomainPresent: true,
    responseKeys: [...DNS_ROOT_FIELDS],
    recordFields: [...DNS_RECORD_FIELDS],
    records,
    receipt: { ...receipt, targetDomainPresent: true, responseKeys: [...DNS_ROOT_FIELDS],
      recordFields: [...DNS_RECORD_FIELDS], records },
  };
}

export function createGabiaReadClient({ input, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('GABIA_CLIENT_INVALID');
  const safeInput = validateReadInput(input);
  const session = makeSession({ cookies: safeInput.cookies, fetchImpl });
  const { domain, expectedUserId } = safeInput;

  return Object.freeze({
    async readDomain() {
      const ownerRaw = await getJson(session, {
        origin: GABIA_READ_ORIGINS.user, path: OWNER_PATH, now,
      });
      const owner = decodeOwner(ownerRaw.data, expectedUserId, ownerRaw.receipt);

      const queryNames = ['_', 'domain', 'kind', 'sorting_method', 'sorting_val', 'view_cnt', 'view_page'];
      const domainListRaw = await getJson(session, {
        origin: GABIA_READ_ORIGINS.dns, path: DOMAIN_PATH, query: makeDomainQuery(domain, now), queryNames, now,
      });
      const domainList = decodeDomainList(domainListRaw.data, domain, domainListRaw.receipt);
      if (!domainList.targetDomainPresent) fail('GABIA_DOMAIN_NOT_IN_OWNER_LIST', domainList.receipt);

      const recordQuery = { _: String(Math.trunc(now())), domain };
      const dnsRaw = await getJson(session, {
        origin: GABIA_READ_ORIGINS.dns, path: RECORD_PATH, query: recordQuery, queryNames: ['_', 'domain'], now,
      });
      const dns = decodeRecords(dnsRaw.data, domain, dnsRaw.receipt);

      return {
        schema: 'gabia-authenticated-read-v1',
        service: 'gabia',
        targetDomain: domain,
        status: 'verified',
        authentication: {
          loginAcquisition: 'browser_automation_google_login',
          credentialHandoff: 'process_memory_stdin',
          businessRequests: 'pure_http_node_fetch',
          readback: 'pure_http_node_fetch',
          browserUsedForBusiness: false,
          sessionPersisted: false,
          renewal: 'not_tested',
        },
        owner: { authenticated: owner.authenticated, ownerVerified: owner.ownerVerified,
          identityMatch: owner.identityMatch, identityField: owner.identityField, emailReturned: owner.emailReturned,
          fields: owner.ownerFields, receipt: owner.receipt },
        domainList: { targetDomainPresent: domainList.targetDomainPresent, responseKeys: domainList.responseKeys,
          rowFields: domainList.rowFields, receipt: domainList.receipt,
          pagination: 'target-filtered-first-page; full-inventory-exhaustiveness-not-verified' },
        dns: { targetDomainPresent: dns.targetDomainPresent, responseKeys: dns.responseKeys,
          recordFields: dns.recordFields, records: dns.records, receipt: dns.receipt },
        write: { dispatched: false, candidateStatus: 'source_observed_unverified', readbackAfterWrite: 'not_tested' },
      };
    },
  });
}
