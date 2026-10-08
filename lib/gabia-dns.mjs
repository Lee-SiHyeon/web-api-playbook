import { isIP } from 'node:net';

const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT']);
const DNS_TYPES = { A: 1, AAAA: 28, CNAME: 5 };
const DNS_TYPE_NAMES = new Map([[1, 'A'], [28, 'AAAA'], [5, 'CNAME']]);
const RESOLVERS = [
  { id: 'google', endpoint: 'https://dns.google/resolve' },
  { id: 'cloudflare', endpoint: 'https://cloudflare-dns.com/dns-query' },
];
const MAX_DOH_BYTES = 256 * 1024;
const SAFE_DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export class GabiaDnsError extends Error {
  constructor(code) { super(code); this.name = 'GabiaDnsError'; this.code = code; }
}

function fail(code) { throw new GabiaDnsError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function normalizeDomain(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim()
      || /[\s\u0000-\u001f\u007f/:@?#\\]/.test(value)) fail('GABIA_DOMAIN_INVALID');
  const domain = value.toLowerCase().replace(/\.$/, '');
  if (domain !== value.toLowerCase() && value.endsWith('..')) fail('GABIA_DOMAIN_INVALID');
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !SAFE_DNS_LABEL.test(label))
      || isIP(domain) !== 0 || labels.at(-1).length < 2) fail('GABIA_DOMAIN_INVALID');
  return domain;
}

export const validateDomain = normalizeDomain;

function normalizeDnsName(value) {
  if (typeof value !== 'string' || value.length > 253 || /[\s\u0000-\u001f\u007f/:@?#\\]/.test(value)) {
    fail('GABIA_RECORD_VALUE_INVALID');
  }
  const name = value.toLowerCase().replace(/\.$/, '');
  const labels = name.split('.');
  if (labels.length < 2 || labels.some(label => !SAFE_DNS_LABEL.test(label)) || isIP(name) !== 0) {
    fail('GABIA_RECORD_VALUE_INVALID');
  }
  return name;
}

function normalizeRecord(record, domain) {
  if (!object(record) || Object.keys(record).some(key => !['type', 'host', 'value', 'ttl', 'priority'].includes(key))) {
    fail('GABIA_RECORD_INVALID');
  }
  const type = typeof record.type === 'string' ? record.type.toUpperCase() : '';
  if (!RECORD_TYPES.has(type)) fail('GABIA_RECORD_TYPE_INVALID');
  if (typeof record.host !== 'string' || record.host.length > 63 || record.host !== record.host.trim()) {
    fail('GABIA_RECORD_HOST_INVALID');
  }
  const host = record.host === '@' ? '@' : record.host.toLowerCase();
  if (host !== '@' && !SAFE_DNS_LABEL.test(host)) fail('GABIA_RECORD_HOST_INVALID');
  if (!Number.isSafeInteger(record.ttl) || record.ttl < 60 || record.ttl > 86_400) fail('GABIA_RECORD_TTL_INVALID');
  if (typeof record.value !== 'string' || !record.value || record.value.length > 1024
      || /[\u0000-\u001f\u007f]/.test(record.value)) fail('GABIA_RECORD_VALUE_INVALID');
  if (type === 'A') {
    if (isIP(record.value) !== 4) fail('GABIA_RECORD_VALUE_INVALID');
  } else if (type === 'AAAA') {
    if (record.value.includes('%') || isIP(record.value) !== 6) fail('GABIA_RECORD_VALUE_INVALID');
  } else if (type === 'CNAME' || type === 'MX') {
    if (type === 'MX' && !Number.isSafeInteger(record.priority)) fail('GABIA_RECORD_PRIORITY_INVALID');
    if (type === 'MX' && (record.priority < 0 || record.priority > 65_535)) fail('GABIA_RECORD_PRIORITY_INVALID');
    if (type === 'CNAME' && Object.hasOwn(record, 'priority')) fail('GABIA_RECORD_PRIORITY_INVALID');
    const value = normalizeDnsName(record.value);
    return { type, host, value, ttl: record.ttl, ...(type === 'MX' ? { priority: record.priority } : {}) };
  } else {
    if (Object.hasOwn(record, 'priority')) fail('GABIA_RECORD_PRIORITY_INVALID');
    if (record.value.length > 255 || record.value.trim() !== record.value) fail('GABIA_RECORD_VALUE_INVALID');
  }
  if (type !== 'MX' && Object.hasOwn(record, 'priority')) fail('GABIA_RECORD_PRIORITY_INVALID');
  return { type, host, value: type === 'A' || type === 'AAAA' ? record.value.toLowerCase() : record.value, ttl: record.ttl };
}

function recordIdentity(record) {
  const canonicalValue = record.type === 'TXT' ? record.value : record.value.toLowerCase();
  return `${record.type}\u0000${record.host}\u0000${canonicalValue}\u0000${record.priority ?? ''}`;
}

export function validateRecordSet(input) {
  if (!object(input) || input.schema !== 'gabia-dns-record-set-v1'
      || Object.keys(input).some(key => !['schema', 'domain', 'records'].includes(key))) fail('GABIA_RECORD_SET_INVALID');
  const domain = normalizeDomain(input.domain);
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > 100) fail('GABIA_RECORD_SET_INVALID');
  const records = input.records.map(record => normalizeRecord(record, domain));
  const identities = new Set();
  const duplicateRows = [];
  for (const record of records) {
    const id = recordIdentity(record);
    if (identities.has(id)) duplicateRows.push({ type: record.type, host: record.host, value: record.value });
    identities.add(id);
  }
  const conflicts = [];
  const byHost = new Map();
  for (const record of records) {
    const rows = byHost.get(record.host) ?? [];
    rows.push(record);
    byHost.set(record.host, rows);
  }
  for (const [host, rows] of byHost) {
    if (rows.some(row => row.type === 'CNAME') && rows.some(row => row.type !== 'CNAME')) {
      conflicts.push({ host, reason: 'cname_with_other_type', types: [...new Set(rows.map(row => row.type))].sort() });
    }
    const cnameTargets = new Set(rows.filter(row => row.type === 'CNAME').map(row => row.value));
    if (cnameTargets.size > 1) {
      conflicts.push({ host, reason: 'multiple_cname_targets', types: ['CNAME'] });
    }
  }
  return { schema: input.schema, domain, records, duplicateRows, conflicts };
}

export function prepareRecordPlan(input) {
  const validated = validateRecordSet(input);
  return {
    schema: 'gabia-dns-plan-v1',
    domain: validated.domain,
    status: validated.conflicts.length || validated.duplicateRows.length ? 'invalid_plan' : 'prepared_only',
    networkUsed: false,
    writesExecuted: false,
    loginRequired: false,
    records: validated.records.map((record, index) => ({
      action: 'add_or_confirm', ...record, value: input.records[index].value,
    })),
    duplicateRows: validated.duplicateRows,
    conflicts: validated.conflicts,
    note: '가비아에 변경을 보내지 않았습니다. 실제 DNS 화면의 현재 값과 비교한 뒤 직접 적용하세요.',
  };
}

function normalizeDohRecord(answer) {
  if (!object(answer) || typeof answer.name !== 'string' || !Number.isSafeInteger(answer.type)
      || !Number.isSafeInteger(answer.TTL) || answer.TTL < 0 || typeof answer.data !== 'string'
      || answer.data.length < 1 || answer.data.length > 1024) fail('GABIA_DOH_SCHEMA_INVALID');
  const type = DNS_TYPE_NAMES.get(answer.type);
  if (!type) return null;
  let value = answer.data;
  if (type === 'A' && isIP(value) !== 4 || type === 'AAAA' && (value.includes('%') || isIP(value) !== 6)) {
    fail('GABIA_DOH_SCHEMA_INVALID');
  }
  if (type === 'CNAME') value = normalizeDnsName(value);
  const name = normalizeDnsName(answer.name);
  return { name, type, value: type === 'A' || type === 'AAAA' ? value.toLowerCase() : value, ttl: answer.TTL };
}

async function boundedBody(response, limit, code) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail(code);
  if (!response.body?.getReader) fail(code);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        fail(code);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function dnsRcodeName(status) {
  return ({ 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' })[status] ?? 'UNKNOWN';
}

async function queryResolver({ resolver, name, type, fetchImpl, timeoutMs }) {
  const url = new URL(resolver.endpoint);
  url.searchParams.set('name', name);
  url.searchParams.set('type', type);
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { name, type, status: 'transport_error', errorCode: mapTransportError(error) };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel?.().catch(() => {});
    return { name, type, status: 'endpoint_redirect_blocked', errorCode: 'GABIA_DOH_REDIRECT_BLOCKED' };
  }
  if (response.status !== 200) {
    await response.body?.cancel?.().catch(() => {});
    return { name, type, status: 'http_error', httpStatus: response.status };
  }
  let payload;
  try {
    const mime = response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase();
    if (mime && !['application/dns-json', 'application/json'].includes(mime)) fail('GABIA_DOH_SCHEMA_INVALID');
    payload = JSON.parse(await boundedBody(response, MAX_DOH_BYTES, 'GABIA_DOH_RESPONSE_TOO_LARGE'));
  } catch (error) {
    return { name, type, status: 'invalid_response', errorCode: error?.code === 'GABIA_DOH_RESPONSE_TOO_LARGE'
      ? error.code : 'GABIA_DOH_SCHEMA_INVALID' };
  }
  if (!object(payload) || !Number.isSafeInteger(payload.Status) || payload.Status < 0 || payload.Status > 5
      || payload.Answer !== undefined && !Array.isArray(payload.Answer)
      || payload.Answer?.length > 1000
      || payload.Question !== undefined && !Array.isArray(payload.Question)) {
    return { name, type, status: 'invalid_response', errorCode: 'GABIA_DOH_SCHEMA_INVALID' };
  }
  const question = payload.Question?.[0];
  try {
    if (question && (typeof question.name !== 'string' || normalizeDnsName(question.name) !== name
        || question.type !== DNS_TYPES[type])) {
      return { name, type, status: 'invalid_response', errorCode: 'GABIA_DOH_SCHEMA_INVALID' };
    }
  } catch { return { name, type, status: 'invalid_response', errorCode: 'GABIA_DOH_SCHEMA_INVALID' }; }
  let answers;
  try { answers = (payload.Answer ?? []).map(normalizeDohRecord).filter(Boolean); }
  catch { return { name, type, status: 'invalid_response', errorCode: 'GABIA_DOH_SCHEMA_INVALID' }; }
  const rcode = payload.Status;
  return {
    name, type,
    status: rcode === 0 ? 'ok' : rcode === 3 ? 'nxdomain' : 'resolver_error',
    rcode, rcodeName: dnsRcodeName(rcode),
    answers,
  };
}

function mapTransportError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ABORT_ERR' || code === 'TimeoutError' || error?.name === 'TimeoutError'
      || error?.cause?.name === 'TimeoutError') return 'GABIA_REQUEST_TIMEOUT';
  if (typeof code === 'string' && CERTIFICATE_CODES.has(code)) return 'GABIA_CERTIFICATE_VALIDATION_FAILED';
  if (typeof code === 'string' && /^ERR_TLS|^ERR_SSL/.test(code)) return 'GABIA_TLS_HANDSHAKE_FAILED';
  return 'GABIA_TRANSPORT_FAILED';
}

function uniqueRecords(queries, owner) {
  const map = new Map();
  for (const query of queries) for (const record of query.answers ?? []) {
    if (record.name !== owner) continue;
    const key = `${record.type}\u0000${record.value.toLowerCase()}`;
    const previous = map.get(key);
    if (!previous || record.ttl < previous.ttl) map.set(key, record);
  }
  return [...map.values()].sort((a, b) => a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
}

function targetExpectedRecordSets(validated) {
  const unsupported = validated.records.filter(record => !(['A', 'CNAME'].includes(record.type)
      && ['@', 'www'].includes(record.host)));
  const apexCname = validated.records.some(record => record.host === '@' && record.type === 'CNAME');
  const wwwAddress = validated.records.some(record => record.host === 'www' && ['A', 'AAAA'].includes(record.type));
  const apexA = validated.records.filter(record => record.host === '@' && record.type === 'A');
  const wwwCname = validated.records.filter(record => record.host === 'www' && record.type === 'CNAME');
  if (unsupported.length || apexCname || wwwAddress || !apexA.length || !wwwCname.length) fail('GABIA_PUBLIC_VERIFY_PLAN_UNSUPPORTED');
  return { apexA: apexA.map(row => row.value).sort(), wwwCname: wwwCname.map(row => row.value).sort() };
}

function compareDnsObservations(observations, domain, expected) {
  const hosts = [domain, `www.${domain}`];
  const queryFailed = observations.some(resolver => resolver.queries.some(query =>
    !['ok', 'nxdomain'].includes(query.status)));
  const resolverSets = observations.map(resolver => Object.fromEntries(hosts.map(host => [host,
    uniqueRecords(resolver.queries, host).map(record => `${record.type}:${record.value.toLowerCase()}`)])));
  const resolverDisagreement = resolverSets.length > 1 && hosts.some(host =>
    JSON.stringify(resolverSets[0][host]) !== JSON.stringify(resolverSets[1][host]));
  const hostResults = hosts.map((host, index) => {
    const perResolver = observations.map(resolver => uniqueRecords(resolver.queries, host));
    const reference = perResolver[0] ?? [];
    const actualA = [...new Set(reference.filter(record => record.type === 'A').map(record => record.value))].sort();
    const actualCname = [...new Set(reference.filter(record => record.type === 'CNAME').map(record => record.value))].sort();
    const actualAaaa = [...new Set(reference.filter(record => record.type === 'AAAA').map(record => record.value))].sort();
    const clash = reference.some(record => record.type === 'CNAME')
      && reference.some(record => record.type === 'A' || record.type === 'AAAA');
    const wanted = index === 0 ? expected.apexA : expected.wwwCname;
    const actual = index === 0 ? actualA : actualCname;
    const same = JSON.stringify(actual) === JSON.stringify(wanted);
    return {
      host,
      expected: index === 0 ? wanted.map(value => ({ type: 'A', value }))
        : wanted.map(value => ({ type: 'CNAME', value })),
      observed: reference.map(({ type, value, ttl }) => ({ type, value, ttl })),
      matching: same,
      cnameAddressConflict: clash,
      additionalIpv6: actualAaaa,
    };
  });
  const conflicts = hostResults.some(result => result.cnameAddressConflict);
  const mismatches = hostResults.some(result => !result.matching);
  const status = queryFailed ? 'inconclusive' : resolverDisagreement ? 'resolver_disagreement'
    : conflicts ? 'record_conflict' : mismatches ? 'records_mismatch' : 'verified';
  return { status, queryFailed, resolverDisagreement, hosts: hostResults };
}

export async function verifyPublicDns({ recordSet, fetchImpl = globalThis.fetch, timeoutMs = 7_000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    fail('GABIA_OPTIONS_INVALID');
  }
  const validated = validateRecordSet(recordSet);
  if (validated.conflicts.length || validated.duplicateRows.length) fail('GABIA_RECORD_SET_INVALID');
  const expected = targetExpectedRecordSets(validated);
  const domain = validated.domain;
  const hosts = [domain, `www.${domain}`];
  const observations = await Promise.all(RESOLVERS.map(async resolver => {
    const queries = await Promise.all(hosts.flatMap(name => ['A', 'AAAA', 'CNAME'].map(type =>
      queryResolver({ resolver, name, type, fetchImpl, timeoutMs }))));
    return { resolver: resolver.id, status: queries.some(query => !['ok', 'nxdomain'].includes(query.status)) ? 'partial' : 'ok', queries };
  }));
  const comparison = compareDnsObservations(observations, domain, expected);
  return {
    schema: 'gabia-public-dns-check-v1',
    checkedAt: new Date().toISOString(),
    domain,
    status: comparison.status,
    networkUsed: true,
    writesExecuted: false,
    authoritativeDns: {
      status: 'not_queried',
      note: '이 결과는 고정된 공용 재귀 resolver의 응답입니다. 권한 DNS 서버나 Gabia 계정 화면을 직접 조회하지 않았습니다.',
    },
    resolvers: observations,
    comparison: {
      ...comparison,
      ttlParticipatesInComparison: false,
      note: 'TTL은 조회 시점에 따라 줄어들므로 레코드 일치 판정에서 제외했습니다.',
    },
  };
}

function explicitAuthority(raw) {
  const match = /^(?:https:)?\/\/([^/?#]*)/i.exec(raw);
  return match?.[1] ?? null;
}

export function validateHttpsUrl(raw, domain) {
  const apex = normalizeDomain(domain);
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 2048 || raw !== raw.trim()
      || /[\u0000-\u0020\u007f\\]/.test(raw)) fail('GABIA_HTTPS_URL_INVALID');
  let url;
  try { url = new URL(raw); } catch { fail('GABIA_HTTPS_URL_INVALID'); }
  const allowedHosts = new Set([apex, `www.${apex}`]);
  const authority = explicitAuthority(raw);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()) || url.username || url.password
      || url.port || url.pathname !== '/' || url.search || url.hash
      || authority.toLowerCase() !== url.hostname.toLowerCase()) fail('GABIA_HTTPS_URL_INVALID');
  return url;
}

function validateRedirect(rawLocation, current, domain) {
  if (typeof rawLocation !== 'string' || !rawLocation || rawLocation.length > 2048
      || /[\u0000-\u0020\u007f\\]/.test(rawLocation)) fail('GABIA_HTTPS_REDIRECT_BLOCKED');
  let url;
  try { url = new URL(rawLocation, current); } catch { fail('GABIA_HTTPS_REDIRECT_BLOCKED'); }
  const authority = explicitAuthority(rawLocation);
  const allowedHosts = new Set([domain, `www.${domain}`]);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()) || url.username || url.password
      || url.port || authority !== null && authority.toLowerCase() !== url.hostname.toLowerCase()) fail('GABIA_HTTPS_REDIRECT_BLOCKED');
  return url;
}

export async function verifyPublicHttps({ domain, url: requestedUrl, fetchImpl = globalThis.fetch,
  timeoutMs = 8_000, maxRedirects = 3 } = {}) {
  const normalizedDomain = normalizeDomain(domain);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000
      || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) fail('GABIA_OPTIONS_INVALID');
  let current = validateHttpsUrl(requestedUrl ?? `https://${normalizedDomain}/`, normalizedDomain);
  const initialHost = current.hostname;
  const redirects = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let response;
    try {
      response = await fetchImpl(current.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        schema: 'gabia-public-https-check-v1', checkedAt: new Date().toISOString(), domain: normalizedDomain,
        requestedHost: initialHost, finalHost: current.hostname, status: 'transport_or_tls_error',
        errorCode: mapTransportError(error), redirects, networkUsed: true, writesExecuted: false,
        certificateFailureConfirmed: CERTIFICATE_CODES.has(error?.cause?.code ?? error?.code),
      };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location');
      await response.body?.cancel?.().catch(() => {});
      if (hop === maxRedirects || !location) {
        return { schema: 'gabia-public-https-check-v1', checkedAt: new Date().toISOString(), domain: normalizedDomain,
          requestedHost: initialHost, finalHost: current.hostname, status: 'redirect_limit',
          redirects, networkUsed: true, writesExecuted: false };
      }
      let next;
      try { next = validateRedirect(location, current, normalizedDomain); }
      catch {
        return { schema: 'gabia-public-https-check-v1', checkedAt: new Date().toISOString(), domain: normalizedDomain,
          requestedHost: initialHost, finalHost: current.hostname, status: 'redirect_blocked',
          errorCode: 'GABIA_HTTPS_REDIRECT_BLOCKED', redirects, networkUsed: true, writesExecuted: false };
      }
      redirects.push({ status: response.status, fromHost: current.hostname, toHost: next.hostname });
      current = next;
      continue;
    }
    await response.body?.cancel?.().catch(() => {});
    return {
      schema: 'gabia-public-https-check-v1', checkedAt: new Date().toISOString(), domain: normalizedDomain,
      requestedHost: initialHost, finalHost: current.hostname,
      status: response.status >= 200 && response.status < 300 ? 'reachable' : 'http_error',
      httpStatus: response.status,
      contentType: response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase() ?? null,
      bodyReadBytes: 0, redirects, networkUsed: true, writesExecuted: false,
      tlsValidation: 'strict_platform_default',
    };
  }
  fail('GABIA_HTTPS_REDIRECT_LIMIT');
}

export async function verifyPublicDomain({ recordSet, url, fetchImpl = globalThis.fetch,
  dnsTimeoutMs, httpsTimeoutMs } = {}) {
  const validated = validateRecordSet(recordSet);
  const [dns, https] = await Promise.all([
    verifyPublicDns({ recordSet, fetchImpl, ...(dnsTimeoutMs === undefined ? {} : { timeoutMs: dnsTimeoutMs }) }),
    verifyPublicHttps({ domain: validated.domain, url, fetchImpl, ...(httpsTimeoutMs === undefined ? {} : { timeoutMs: httpsTimeoutMs }) }),
  ]);
  return {
    schema: 'gabia-public-domain-check-v1',
    domain: validated.domain,
    status: dns.status === 'verified' && https.status === 'reachable' ? 'verified'
      : dns.status === 'inconclusive' ? 'inconclusive' : 'needs_attention',
    networkUsed: true,
    writesExecuted: false,
    dns,
    https,
  };
}
