import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createGabiaReadClient, GABIA_READ_ORIGINS, normalizeGabiaDomain,
} from '../lib/gabia-read.mjs';

const domain = 'lifehackailab.com';
const expectedUserId = 'fixture-owner-id';
const cookieValue = 'fixture-browser-cookie-value';
const nowValue = Date.parse('2026-10-08T12:00:00.000Z');
const input = overrides => ({
  schema: 'gabia-read-input-v1', domain, expectedUserId,
  cookies: [{ name: 'gabia-session', value: cookieValue, domain: '.gabia.com', path: '/',
    hostOnly: false, secure: true, httpOnly: true, expires: 1_893_456_000 }],
  ...overrides,
});

const ownerResponse = userId => ({ data: {
  user_id: userId, user_name: 'private-owner-name', user_type: 'member',
  registration_site: 'web', registration_date: '2026-10-06',
} });
const domainRow = name => ({ num: 1, domain: name, type: 'internal', status: 'active', tbl: 'private-table',
  owner_approval: null, domain_seqno: 'private-sequence', domain_addition: '', expire_date: '2027-10-06',
  disabled: 'N', ssl_target: '' });
const record = (type, host, data, seqno) => ({
  ttl: 600, services_idx: 1, seqno, domain, host, type, data,
  service: '', protocol: '', priority: '', weight: '', port: '', target: '', is_layer: 'N',
  services_name: '', addition_service_name: '', action: '',
});
const domainListResponse = rows => ({ list: rows, last_flag: true, domain_cnt: String(rows.length),
  request_view_cnt: '10', request_view_page: '1' });
const dnsResponse = rows => ({ update_date: 'private-update-date', record: rows, nameserver: 'private-ns',
  addition: { domain_connect: [], forwarding: [], web_parking: [], mobile_parking: [] },
  hasDomainConn: [], hasService: [], option: { type: [], service: {} }, forwardingInfo: [] });

function harness({ owner = ownerResponse(expectedUserId), domains = domainListResponse([domainRow(domain)]),
  dns = dnsResponse([record('A', '@', '216.150.1.1', 1), record('A', '@', '216.150.16.1', 2),
    record('CNAME', 'www', 'f2b6c708ceb0ac50.vercel-dns-016.com', 3)]),
  statusFor, mimeFor, bodyFor, redirectAt } = {}) {
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.equal(url.hostname === 'gabia-user-api.gabia.com' || url.hostname === 'dns.gabia.com', true);
    if (redirectAt === url.pathname) {
      return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/collect' } });
    }
    const status = statusFor?.(url) ?? 200;
    const mime = mimeFor?.(url) ?? 'application/json; charset=utf-8';
    const value = bodyFor?.(url) ?? (url.hostname === 'gabia-user-api.gabia.com'
      ? owner : url.pathname === '/dns/ajax/domain' ? domains : dns);
    if (value instanceof Response) return value;
    if (typeof value === 'string') return new Response(value, { status, headers: { 'content-type': mime } });
    return Response.json(value, { status, headers: { 'content-type': mime } });
  };
  const reader = createGabiaReadClient({ input: input(), fetchImpl, now: () => nowValue });
  return { reader, calls };
}

test('normalizes the requested DNS name and rejects URL or control syntax', () => {
  assert.equal(normalizeGabiaDomain('LifehackAILab.com.'), domain);
  for (const value of ['', 'lifehackailab.com/path', 'lifehackailab.com?next=x', 'a..com', 'a b.com', 'http://lifehackailab.com']) {
    assert.throws(() => normalizeGabiaDomain(value), { code: 'GABIA_DOMAIN_INVALID' });
  }
});

test('verified owner, filtered domain list and DNS records use fixed pure-HTTP GET contracts', async () => {
  const h = harness();
  const result = await h.reader.readDomain();
  assert.equal(result.status, 'verified');
  assert.equal(result.owner.identityMatch, true);
  assert.equal(result.owner.emailReturned, false);
  assert.equal(result.domainList.targetDomainPresent, true);
  assert.equal(result.dns.records.length, 3);
  assert.deepEqual(result.dns.records, [
    { type: 'A', host: '@', value: '216.150.1.1', ttl: 600 },
    { type: 'A', host: '@', value: '216.150.16.1', ttl: 600 },
    { type: 'CNAME', host: 'www', value: 'f2b6c708ceb0ac50.vercel-dns-016.com', ttl: 600 },
  ]);
  assert.equal(result.authentication.businessRequests, 'pure_http_node_fetch');
  assert.equal(result.authentication.browserUsedForBusiness, false);
  assert.equal(result.authentication.sessionPersisted, false);
  assert.equal(result.write.dispatched, false);

  assert.deepEqual(h.calls.map(({ url }) => [url.origin, url.pathname]), [
    [GABIA_READ_ORIGINS.user, '/v1/users/me'],
    [GABIA_READ_ORIGINS.dns, '/dns/ajax/domain'],
    [GABIA_READ_ORIGINS.dns, '/dns/ajax/dns'],
  ]);
  const [ownerCall, listCall, dnsCall] = h.calls;
  assert.deepEqual([...listCall.url.searchParams.keys()].sort(),
    ['_', 'domain', 'kind', 'sorting_method', 'sorting_val', 'view_cnt', 'view_page'].sort());
  assert.equal(listCall.url.searchParams.get('domain'), domain);
  assert.equal(listCall.url.searchParams.get('kind'), 'internal');
  assert.equal(listCall.url.searchParams.get('sorting_method'), 'asc');
  assert.equal(listCall.url.searchParams.get('sorting_val'), 'domain');
  assert.equal(listCall.url.searchParams.get('view_cnt'), '10');
  assert.equal(listCall.url.searchParams.get('view_page'), '1');
  assert.deepEqual([...dnsCall.url.searchParams.keys()].sort(), ['_', 'domain']);
  assert.equal(dnsCall.url.searchParams.get('domain'), domain);
  for (const call of h.calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.get('authorization'), null);
    assert.match(call.init.headers.get('cookie'), /gabia-session=/);
    assert.equal(JSON.stringify(result).includes(cookieValue), false);
    assert.equal(JSON.stringify(result).includes(expectedUserId), false);
    assert.equal(JSON.stringify(result).includes('private-owner-name'), false);
    assert.equal(JSON.stringify(result).includes('private-sequence'), false);
    assert.equal(JSON.stringify(result).includes('private-table'), false);
  }
  assert.equal(ownerCall.init.headers.get('x-requested-with'), null);
  assert.equal(listCall.init.headers.get('x-requested-with'), 'XMLHttpRequest');
});

test('browser host-only cookies remain scoped and parent cookies go only to the two allowed Gabia origins', async () => {
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ url, cookie: init.headers.get('cookie') });
    if (url.pathname === '/v1/users/me') return Response.json(ownerResponse(expectedUserId));
    if (url.pathname === '/dns/ajax/domain') return Response.json(domainListResponse([domainRow(domain)]));
    return Response.json(dnsResponse([record('A', '@', '216.150.1.1', 1)]));
  };
  const reader = createGabiaReadClient({ input: input({ cookies: [
    { name: 'shared', value: 'parent-cookie', domain: '.gabia.com', hostOnly: false, path: '/', secure: true },
    { name: 'dns-only', value: 'dns-cookie', domain: 'dns.gabia.com', hostOnly: true, path: '/', secure: true },
  ] }), fetchImpl, now: () => nowValue });
  await reader.readDomain();
  assert.match(calls[0].cookie, /shared=parent-cookie/);
  assert.doesNotMatch(calls[0].cookie, /dns-only=dns-cookie/);
  assert.match(calls[1].cookie, /shared=parent-cookie/);
  assert.match(calls[1].cookie, /dns-only=dns-cookie/);
  assert.equal(calls.every(({ url }) => [GABIA_READ_ORIGINS.user, GABIA_READ_ORIGINS.dns].includes(url.origin)), true);
});

test('the owner pin must match before domain-list or DNS requests', async () => {
  const h = harness({ owner: ownerResponse('different-owner-id') });
  await assert.rejects(h.reader.readDomain(), error => {
    assert.equal(error.code, 'GABIA_OWNER_MISMATCH');
    assert.equal(error.receipt.identityMatch, false);
    assert.equal(JSON.stringify(error.receipt).includes('different-owner-id'), false);
    return true;
  });
  assert.equal(h.calls.length, 1);
});

test('the requested domain must appear in the protected owner listing before the DNS detail call', async () => {
  const h = harness({ domains: domainListResponse([domainRow('another.example')]) });
  await assert.rejects(h.reader.readDomain(), { code: 'GABIA_DOMAIN_NOT_IN_OWNER_LIST' });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.some(call => call.url.pathname === '/dns/ajax/dns'), false);
});

test('domain-list rows are schema-checked before target ownership is accepted', async () => {
  const malformed = { ...domainRow(domain), domain_seqno: 17 };
  const h = harness({ domains: domainListResponse([malformed]) });
  await assert.rejects(h.reader.readDomain(), { code: 'GABIA_DOMAIN_LIST_SCHEMA_INVALID' });
  assert.equal(h.calls.length, 2);
});

test('unrelated and sensitive record types are never returned from the DNS response', async () => {
  const sensitive = { ...record('TXT', '@', 'private-verification-value', 4) };
  const unrelated = { ...record('A', '@', '192.0.2.9', 5), domain: 'another.example' };
  const h = harness({ dns: dnsResponse([record('A', '@', '216.150.1.1', 1), sensitive, unrelated]) });
  const result = await h.reader.readDomain();
  assert.deepEqual(result.dns.records, [{ type: 'A', host: '@', value: '216.150.1.1', ttl: 600 }]);
  assert.equal(JSON.stringify(result).includes('private-verification-value'), false);
  assert.equal(JSON.stringify(result).includes('another.example'), false);
});

test('DNS root and record rows are schema-checked before tuples are returned', async () => {
  const malformed = { ...record('A', '@', '216.150.1.1', 1) };
  delete malformed.data;
  for (const dns of [
    { record: [record('A', '@', '216.150.1.1', 1)] },
    dnsResponse([malformed]),
  ]) {
    const h = harness({ dns });
    await assert.rejects(h.reader.readDomain(), { code: 'GABIA_DNS_SCHEMA_INVALID' });
    assert.equal(h.calls.length, 3);
  }
});

test('unrelated cookies, malformed provider objects and invalid owner pins fail before network', () => {
  for (const override of [
    { cookies: [{ name: 'session', value: 'not-sent', domain: '.attacker.invalid', path: '/', secure: true }] },
    { unexpected: 'field' },
    { expectedUserId: '' },
  ]) {
    assert.throws(() => createGabiaReadClient({ input: input(override), fetchImpl: async () => assert.fail('no request expected') }),
      /GABIA_(?:SESSION_INPUT_INVALID|INPUT_INVALID|OWNER_PIN_INVALID)/);
  }
});

test('401, 403, 429, HTML and malformed JSON are distinct safe failures without retries', async () => {
  for (const [status, code] of [[401, 'GABIA_REAUTH_REQUIRED'], [403, 'GABIA_ACCESS_FORBIDDEN'], [429, 'GABIA_RATE_LIMITED']]) {
    const h = harness({ statusFor: () => status });
    await assert.rejects(h.reader.readDomain(), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.httpStatus, status);
      assert.equal(JSON.stringify(error.receipt).includes(cookieValue), false);
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
  for (const [mime, text] of [['text/html', '<html>login private-account</html>'], ['application/json', '{broken']]) {
    const h = harness({ mimeFor: () => mime, bodyFor: () => text });
    await assert.rejects(h.reader.readDomain(), error => {
      assert.equal(error.code, 'GABIA_RESPONSE_INVALID');
      assert.equal(JSON.stringify(error).includes('login private-account'), false);
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
});

test('redirects fail closed before any cross-origin request', async () => {
  const h = harness({ redirectAt: '/dns/ajax/domain' });
  await assert.rejects(h.reader.readDomain(), error => {
    assert.equal(error.code, 'GABIA_REDIRECT_BLOCKED');
    assert.equal(JSON.stringify(error).includes('attacker.invalid'), false);
    return true;
  });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.every(({ url }) => url.origin !== 'https://attacker.invalid'), true);
});

test('oversized authenticated responses fail with a bounded safe receipt', async () => {
  const h = harness({ bodyFor: url => url.pathname === '/dns/ajax/dns'
    ? new Response('x'.repeat(1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } })
    : url.hostname === 'gabia-user-api.gabia.com'
      ? ownerResponse(expectedUserId) : domainListResponse([domainRow(domain)]) });
  await assert.rejects(h.reader.readDomain(), { code: 'GABIA_RESPONSE_TOO_LARGE' });
  assert.equal(h.calls.length, 3);
});

test('the runner exposes only read and status commands and never echoes stdin', () => {
  const status = spawnSync(process.execPath, ['scripts/gabia-read.mjs', 'status'], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(status.status, 0);
  const receipt = JSON.parse(status.stdout);
  assert.equal(receipt.writesExecuted, false);
  assert.equal(receipt.operations.writes.status, 'not_implemented');
  assert.equal(status.stderr, '');

  const invalid = spawnSync(process.execPath, ['scripts/gabia-read.mjs', 'read', '--credentials-stdin'], {
    input: 'private-cookie-marker', encoding: 'utf8', timeout: 15000,
  });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr, '');
  assert.equal(invalid.stdout.includes('private-cookie-marker'), false);
  assert.equal(JSON.parse(invalid.stdout).code, 'INPUT_JSON_INVALID');

  for (const [args, code] of [
    [['write', '--credentials-stdin'], 'GABIA_COMMAND_NOT_ALLOWED'],
    [['read', '--domain=attacker.invalid'], 'ARGUMENT_INVALID'],
    [['read'], 'GABIA_COMMAND_NOT_ALLOWED'],
  ]) {
    const blocked = spawnSync(process.execPath, ['scripts/gabia-read.mjs', ...args], {
      input: 'private-cookie-marker', encoding: 'utf8', timeout: 15000,
    });
    assert.equal(blocked.status, 2);
    assert.equal(blocked.stderr, '');
    assert.equal(blocked.stdout.includes('private-cookie-marker'), false);
    assert.equal(JSON.parse(blocked.stdout).code, code);
  }
});
