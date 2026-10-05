import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditCapabilityChecklist } from '../lib/capability-checklist.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const origin = 'https://www.oliveyoung.co.kr';
const bundle = 'https://static.oliveyoung.co.kr/pc-static-root/js/main/best.js';
const bundleHash = '27f10217e8d1b981adbab30b4e54c488d0774dfcccb47680c7f951900e9f32e2';
const bootstrapTime = '2026-10-05T00:00:00.000Z';
const rankingTime = '2026-10-05T00:00:01.000Z';
const checkedAt = '2026-10-05T00:00:02.000Z';
const code = 'export function readRanking() { return []; }\n';

async function fixture(t) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'anonymous-session-checklist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['checklists/services', 'lib', 'verification']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'lib/oliveyoung.mjs'), code);
  const entry = { kind: 'http-anonymous-session-read-v1', method: 'GET', readOnly: true,
    origin, path: '/store/main/getBestList.do', mime: 'text/html', files: ['verification/ranking.json'],
    hashPaths: ['lib/oliveyoung.mjs'] };
  const manifest = { schemaVersion: 1, service: 'oliveyoung-public', capabilities: [{
    id: 'ranking.top_products', title: 'Olive Young ranked products', priority: 'required',
    applicability: 'applicable', requirement: 'live',
    implementation: { files: [{ path: 'lib/oliveyoung.mjs', exports: ['readRanking'] }], tests: [] },
    evidence: [entry], sourceEvidence: [],
  }] };
  const issuedCookieNames = ['__cf_bm', '_cfuvid'];
  const receipt = {
    schema: 'web-api-anonymous-session-read-receipt-v1', service: 'oliveyoung-public',
    capabilityId: 'ranking.top_products', checkedAt, secretsPersistedInEvidence: false,
    anonymous: true, credentialsUsed: false, authenticated: false, browserUsed: false,
    schemaVerified: true, expectedResultVerified: true, sourceFormat: 'html_document', isXhr: false,
    contractProvenance: { kind: 'first_party_bundle_contract', sourceURL: bundle, sourceSha256: bundleHash },
    bootstrapContractProvenance: { kind: 'server_response_observed',
      sourceURL: `${origin}/store/main/main.do`, sourceSha256: sha('bootstrap html') },
    bootstrapRequest: { method: 'GET', origin, path: '/store/main/main.do', httpStatus: 200,
      mime: 'text/html', responseBytes: 1500, responseSha256: sha('bootstrap html'), checkedAt: bootstrapTime,
      browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false,
      inputCookiesAccepted: false, issuedCookieNames },
    request: { method: 'GET', origin, path: '/store/main/getBestList.do', httpStatus: 200,
      mime: 'text/html', responseBytes: 24000, responseSha256: sha('ranking html'), checkedAt: rankingTime,
      browserUsed: false, anonymous: true, cookieSent: true, credentialsUsed: false,
      inputCookiesAccepted: false, sessionKind: 'server_issued_anonymous', sentCookieNames: issuedCookieNames },
    rankingResult: { verified: true, count: 10, products: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1, productId: `goods-${index + 1}`, title: `Product ${index + 1}`,
      price: { amount: `${index + 1000}`, currency: 'KRW' },
    })) },
    implementation: { 'lib/oliveyoung.mjs': sha(code) },
  };
  const saveReceipt = async value => writeFile(path.join(root, 'verification/ranking.json'), JSON.stringify(value));
  const saveManifest = async () => writeFile(path.join(root, 'checklists/services/oliveyoung-public.json'), JSON.stringify(manifest));
  const status = async () => (await auditCapabilityChecklist({ root, service: 'oliveyoung-public' })).capabilities[0].status;
  await saveManifest();
  await saveReceipt(receipt);
  return { root, entry, manifest, receipt, saveReceipt, saveManifest, status };
}

test('server-issued anonymous ranking session requires both live reads and current implementation hash', async t => {
  const f = await fixture(t);
  assert.equal(await f.status(), 'recorded_live');
  await writeFile(path.join(f.root, 'lib/oliveyoung.mjs'), 'export function readRanking() { return null; }\n');
  assert.equal(await f.status(), 'needs_reverification');
});

test('anonymous cookies must be issued by the homepage bootstrap and stay within the CF allowlist', async t => {
  const f = await fixture(t);
  const cases = [
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, inputCookiesAccepted: true } },
    { request: { ...f.receipt.request, inputCookiesAccepted: true } },
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, issuedCookieNames: undefined } },
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, issuedCookieNames: ['sessionid'] } },
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, cookieNames: ['customer_session'] } },
    { request: { ...f.receipt.request, sentCookieNames: ['__cf_bm', 'sessionid'] } },
    { request: { ...f.receipt.request, cookieNames: ['sessionid'] } },
    { request: { ...f.receipt.request, sentCookieNames: [] } },
    { request: { ...f.receipt.request, sessionKind: 'user_session' } },
    { request: { ...f.receipt.request, cookieSent: false } },
  ];
  for (const changes of cases) {
    await f.saveReceipt({ ...f.receipt, ...changes });
    assert.equal(await f.status(), 'evidence_invalid', JSON.stringify(changes));
  }
});

test('empty cookieNames metadata is allowed only on the cookie-free bootstrap request', async t => {
  const f = await fixture(t);
  await f.saveReceipt({ ...f.receipt, bootstrapRequest: { ...f.receipt.bootstrapRequest, cookieNames: [] } });
  assert.equal(await f.status(), 'recorded_live');
  await f.saveReceipt({ ...f.receipt, request: { ...f.receipt.request, cookieNames: [] } });
  assert.equal(await f.status(), 'evidence_invalid');
});

test('bootstrap and ranking calls are restricted to exact same-origin public GET routes', async t => {
  const f = await fixture(t);
  const cases = [
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, origin: 'https://other.test' } },
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, path: '/login' } },
    { request: { ...f.receipt.request, origin: 'https://other.test' } },
    { request: { ...f.receipt.request, path: '/store/main/privateFeed.do' } },
    { request: { ...f.receipt.request, method: 'POST' } },
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, httpStatus: 429 } },
    { request: { ...f.receipt.request, httpStatus: 429 } },
  ];
  for (const changes of cases) {
    await f.saveReceipt({ ...f.receipt, ...changes });
    assert.equal(await f.status(), 'evidence_invalid', JSON.stringify(changes));
  }
});

test('provenance, source format, and semantic top ten are mandatory', async t => {
  const f = await fixture(t);
  const cases = [
    { contractProvenance: { ...f.receipt.contractProvenance, sourceURL: 'https://www.oliveyoung.co.kr/' } },
    { contractProvenance: { ...f.receipt.contractProvenance, sourceSha256: sha('wrong bundle') } },
    { bootstrapContractProvenance: { ...f.receipt.bootstrapContractProvenance, sourceURL: 'https://other.test/main.do' } },
    { bootstrapContractProvenance: { ...f.receipt.bootstrapContractProvenance, sourceSha256: sha('wrong response') } },
    { bootstrapContractProvenance: { ...f.receipt.bootstrapContractProvenance, kind: 'first_party_bundle_contract' } },
    { sourceFormat: 'xhr_json' },
    { isXhr: true },
    { rankingResult: { ...f.receipt.rankingResult, verified: false } },
    { rankingResult: undefined },
    { rankingResult: { ...f.receipt.rankingResult,
      products: f.receipt.rankingResult.products.slice(0, 9) } },
    { request: { ...f.receipt.request, cookieHeader: 'must-not-be-persisted' } },
    { request: { ...f.receipt.request, authorization: 'must-not-be-persisted' } },
    { request: { ...f.receipt.request, sessionId: 'must-not-be-persisted' } },
    { authenticated: true },
    { browserUsed: true },
    { request: { ...f.receipt.request, browserUsed: true } },
  ];
  for (const changes of cases) {
    await f.saveReceipt({ ...f.receipt, ...changes });
    assert.equal(await f.status(), 'evidence_invalid', JSON.stringify(changes));
  }
});

test('anonymous-session evidence cannot declare a different service or a broad/generic endpoint', async t => {
  const f = await fixture(t);
  f.entry.path = '/store/main/other.do';
  await f.saveManifest();
  await assert.rejects(f.status(), /CHECKLIST_SCHEMA_INVALID/);
  f.entry.path = '/store/main/getBestList.do';
  f.entry.origin = 'https://other.test';
  await f.saveManifest();
  await assert.rejects(f.status(), /CHECKLIST_SCHEMA_INVALID/);
});
