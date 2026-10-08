import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  prepareRecordPlan, validateDomain, validateHttpsUrl,
  validateRecordSet, verifyPublicDns, verifyPublicHttps,
} from '../lib/gabia-dns.mjs';

const fixture = JSON.parse(await readFile(new URL('../examples/gabia/lifehackailab-records.json', import.meta.url), 'utf8'));
const apex = fixture.domain;
const www = `www.${apex}`;
const target = 'f2b6c708ceb0ac50.vercel-dns-016.com';

function dnsPayload(name, type, answers = [], status = 0) {
  const typeCode = { A: 1, AAAA: 28, CNAME: 5 }[type];
  return Response.json({ Status: status, Question: [{ name, type: typeCode }], Answer: answers });
}

function answer(name, type, data, ttl = 600) {
  return { name: `${name}.`, type: { A: 1, AAAA: 28, CNAME: 5 }[type], TTL: ttl, data };
}

function header(init, name) {
  if (init.headers instanceof Headers) return init.headers.get(name);
  return Object.entries(init.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

function passingFetch({ wrong = false, servfail = false, redirectDoh = false, conflict = false } = {}) {
  const requests = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    requests.push({ url, init });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(header(init, 'cookie'), null);
    assert.equal(header(init, 'authorization'), null);
    if (url.hostname === 'lifehackailab.com' || url.hostname === 'www.lifehackailab.com') {
      assert.equal(url.protocol, 'https:');
      assert.equal(url.port, '');
      assert.equal(init.redirect, 'manual');
      return new Response('landing page', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    assert.ok(['dns.google', 'cloudflare-dns.com'].includes(url.hostname));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.pathname, url.hostname === 'dns.google' ? '/resolve' : '/dns-query');
    assert.equal(header(init, 'accept'), 'application/dns-json');
    if (redirectDoh) return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } });
    const name = url.searchParams.get('name');
    const type = url.searchParams.get('type');
    if (servfail && url.hostname === 'dns.google' && name === www && type === 'AAAA') {
      return dnsPayload(name, type, [], 2);
    }
    const wrongHere = wrong === true || wrong === url.hostname;
    if (name === apex && type === 'A') {
      return dnsPayload(name, type, wrongHere ? [answer(apex, 'A', '192.0.2.50', 580)] : [
        answer(apex, 'A', '216.150.1.1', url.hostname === 'dns.google' ? 597 : 571),
        answer(apex, 'A', '216.150.16.1', url.hostname === 'dns.google' ? 597 : 571),
      ]);
    }
    if (name === www && type === 'A') {
      return dnsPayload(name, type, [answer(www, 'CNAME', `${target}.`, 590), answer(target, 'A', '216.150.1.1', 580)]);
    }
    if (name === www && type === 'CNAME') return dnsPayload(name, type, [answer(www, 'CNAME', `${target}.`, 590)]);
    if (name === apex && type === 'CNAME' && conflict) return dnsPayload(name, type, [answer(apex, 'CNAME', 'other.example.net.', 600)]);
    return dnsPayload(name, type);
  };
  return { fetchImpl, requests };
}

test('prepare plans the exact Gabia DNS rows locally and is explicit that no changes were sent', () => {
  const plan = prepareRecordPlan(fixture);
  assert.equal(plan.status, 'prepared_only');
  assert.equal(plan.networkUsed, false);
  assert.equal(plan.writesExecuted, false);
  assert.equal(plan.loginRequired, false);
  assert.deepEqual(plan.records.map(({ type, host, value, ttl }) => ({ type, host, value, ttl })), [
    { type: 'A', host: '@', value: '216.150.1.1', ttl: 600 },
    { type: 'A', host: '@', value: '216.150.16.1', ttl: 600 },
    { type: 'CNAME', host: 'www', value: `${target}.`, ttl: 600 },
  ]);
});

test('domain and HTTPS URL validation rejects URL-shaped hosts, credentials, ports, paths and off-domain targets', () => {
  for (const value of ['https://lifehackailab.com', 'lifehackailab.com:443', 'user@lifehackailab.com',
    'localhost', 'lifehackailab.com/path', 'lifehackailab.com..']) {
    assert.throws(() => validateDomain(value), { code: 'GABIA_DOMAIN_INVALID' });
  }
  for (const value of ['http://lifehackailab.com/', 'https://lifehackailab.com:443/',
    'https://user@lifehackailab.com/', 'https://lifehackailab.com.evil.test/',
    'https://evil.test/lifehackailab.com/', 'https://lifehackailab.com/path',
    'https://lifehackailab.com/?next=https://evil.test']) {
    assert.throws(() => validateHttpsUrl(value, apex), { code: 'GABIA_HTTPS_URL_INVALID' });
  }
  assert.equal(validateHttpsUrl('https://WWW.lifehackailab.com/', apex).hostname, www);
});

test('record input enforces TTL bounds, valid record types, MX-only priority, duplicates and CNAME exclusivity', () => {
  const mutate = transform => ({ ...fixture, records: transform(fixture.records.map(row => ({ ...row }))) });
  assert.throws(() => validateRecordSet(mutate(rows => [{ ...rows[0], ttl: 59 }, ...rows.slice(1)])), { code: 'GABIA_RECORD_TTL_INVALID' });
  assert.throws(() => validateRecordSet(mutate(rows => [{ ...rows[0], ttl: 86_401 }, ...rows.slice(1)])), { code: 'GABIA_RECORD_TTL_INVALID' });
  assert.throws(() => validateRecordSet(mutate(rows => [{ ...rows[0], priority: 5 }, ...rows.slice(1)])), { code: 'GABIA_RECORD_PRIORITY_INVALID' });
  const duplicate = prepareRecordPlan(mutate(rows => [...rows, rows[0]]));
  assert.equal(duplicate.status, 'invalid_plan');
  assert.equal(duplicate.duplicateRows.length, 1);
  const clash = prepareRecordPlan(mutate(rows => [...rows, { type: 'A', host: 'www', value: '192.0.2.10', ttl: 600 }]));
  assert.equal(clash.status, 'invalid_plan');
  assert.deepEqual(clash.conflicts[0].types, ['A', 'CNAME']);
  const multipleAliases = prepareRecordPlan(mutate(rows => [...rows,
    { type: 'CNAME', host: 'www', value: 'alternate.example.net.', ttl: 600 }]));
  assert.equal(multipleAliases.status, 'invalid_plan');
  assert.equal(multipleAliases.conflicts[0].reason, 'multiple_cname_targets');
  const cnameCaseDot = prepareRecordPlan(mutate(rows => [...rows,
    { type: 'CNAME', host: 'www', value: `${target.toUpperCase()}.`, ttl: 900 }]));
  assert.equal(cnameCaseDot.duplicateRows.length, 1);
  assert.equal(cnameCaseDot.conflicts.length, 0);
  assert.throws(() => validateRecordSet(mutate(rows => [...rows, { type: 'MX', host: '@', value: 'mail.example.net.', ttl: 600 }])),
    { code: 'GABIA_RECORD_PRIORITY_INVALID' });
});

test('TXT identity remains case-sensitive while identical TXT values are duplicate even when TTL differs', () => {
  const makeSet = values => ({ ...fixture, records: [...fixture.records, ...values.map((value, index) => ({
    type: 'TXT', host: '@', value, ttl: index ? 900 : 600,
  }))] });
  assert.equal(prepareRecordPlan(makeSet(['Verify=Lifehack', 'verify=lifehack'])).duplicateRows.length, 0);
  assert.equal(prepareRecordPlan(makeSet(['Verify=Lifehack', 'Verify=Lifehack'])).duplicateRows.length, 1);
});

test('public DNS checks both fixed DoH resolvers, ignores TTL decay and never sends auth data or writes', async () => {
  const { fetchImpl, requests } = passingFetch();
  const result = await verifyPublicDns({ recordSet: fixture, fetchImpl });
  assert.equal(result.status, 'verified');
  assert.equal(result.writesExecuted, false);
  assert.equal(result.authoritativeDns.status, 'not_queried');
  assert.equal(result.resolvers.length, 2);
  assert.equal(result.comparison.ttlParticipatesInComparison, false);
  assert.equal(result.comparison.hosts[1].observed.find(row => row.type === 'CNAME').value, target);
  assert.equal(requests.length, 12);
  assert.equal(requests.every(({ url }) => ['dns.google', 'cloudflare-dns.com'].includes(url.hostname)), true);
});

test('DNS mismatch is separate from a SERVFAIL and resolver disagreement', async () => {
  const mismatch = await verifyPublicDns({ recordSet: fixture, fetchImpl: passingFetch({ wrong: true }).fetchImpl });
  assert.equal(mismatch.status, 'records_mismatch');
  const partial = await verifyPublicDns({ recordSet: fixture, fetchImpl: passingFetch({ servfail: true }).fetchImpl });
  assert.equal(partial.status, 'inconclusive');
  assert.equal(partial.resolvers[0].queries.find(row => row.type === 'AAAA' && row.name === www).rcodeName, 'SERVFAIL');
  const disagreement = await verifyPublicDns({ recordSet: fixture, fetchImpl: passingFetch({ wrong: 'dns.google' }).fetchImpl });
  assert.equal(disagreement.status, 'resolver_disagreement');
  assert.equal(disagreement.comparison.resolverDisagreement, true);
  const conflict = await verifyPublicDns({ recordSet: fixture, fetchImpl: passingFetch({ conflict: true }).fetchImpl });
  assert.equal(conflict.status, 'record_conflict');
});

test('DoH redirects fail closed and are not retried', async () => {
  const { fetchImpl, requests } = passingFetch({ redirectDoh: true });
  const result = await verifyPublicDns({ recordSet: fixture, fetchImpl });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.resolvers[0].queries[0].status, 'endpoint_redirect_blocked');
  assert.equal(requests.length, 12);
  assert.equal(requests.every(({ url }) => ['dns.google', 'cloudflare-dns.com'].includes(url.hostname)), true);
});

test('DoH schema mismatches and over-limit bodies become inconclusive instead of being trusted', async () => {
  const normal = passingFetch().fetchImpl;
  const malformed = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.hostname === 'dns.google' && url.searchParams.get('name') === apex && url.searchParams.get('type') === 'A') {
      return Response.json({ Status: 0, Question: [{ name: 'attacker.example', type: 1 }], Answer: [] });
    }
    return normal(rawUrl, init);
  };
  const invalid = await verifyPublicDns({ recordSet: fixture, fetchImpl: malformed });
  assert.equal(invalid.status, 'inconclusive');
  assert.equal(invalid.resolvers[0].queries[0].errorCode, 'GABIA_DOH_SCHEMA_INVALID');

  const oversized = async (rawUrl, init) => {
    if (new URL(rawUrl).hostname === 'dns.google') {
      return new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/dns-json' } });
    }
    return normal(rawUrl, init);
  };
  const limited = await verifyPublicDns({ recordSet: fixture, fetchImpl: oversized });
  assert.equal(limited.status, 'inconclusive');
  assert.equal(limited.resolvers[0].queries[0].errorCode, 'GABIA_DOH_RESPONSE_TOO_LARGE');
});

test('HTTPS follows only same-domain apex/www redirects and sends no cookies or authorization', async () => {
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(header(init, 'cookie'), null);
    assert.equal(header(init, 'authorization'), null);
    if (calls.length === 1) return new Response(null, { status: 308, headers: { location: 'https://www.lifehackailab.com/' } });
    return new Response('ok', { status: 200 });
  };
  const result = await verifyPublicHttps({ domain: apex, fetchImpl });
  assert.equal(result.status, 'reachable');
  assert.deepEqual(result.redirects, [{ status: 308, fromHost: apex, toHost: www }]);
  assert.equal(result.bodyReadBytes, 0);
  assert.equal(result.tlsValidation, 'strict_platform_default');
  assert.equal(calls.length, 2);
});

test('HTTPS blocks off-domain and port redirects without making a second request', async () => {
  for (const location of ['https://outside.example/', 'https://www.lifehackailab.com:443/', 'http://www.lifehackailab.com/']) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    };
    const result = await verifyPublicHttps({ domain: apex, fetchImpl });
    assert.equal(result.status, 'redirect_blocked');
    assert.equal(result.errorCode, 'GABIA_HTTPS_REDIRECT_BLOCKED');
    assert.equal(calls, 1);
  }
});

test('HTTPS transport errors do not invent certificate causes; explicit certificate errors remain distinguishable', async () => {
  const network = await verifyPublicHttps({ domain: apex, fetchImpl: async () => { throw Object.assign(new Error('hidden'), { code: 'ECONNRESET' }); } });
  assert.equal(network.status, 'transport_or_tls_error');
  assert.equal(network.errorCode, 'GABIA_TRANSPORT_FAILED');
  assert.equal(network.certificateFailureConfirmed, false);
  const certificate = await verifyPublicHttps({ domain: apex, fetchImpl: async () => {
    const error = new Error('hidden');
    error.cause = { code: 'CERT_HAS_EXPIRED' };
    throw error;
  } });
  assert.equal(certificate.errorCode, 'GABIA_CERTIFICATE_VALIDATION_FAILED');
  assert.equal(certificate.certificateFailureConfirmed, true);
});
