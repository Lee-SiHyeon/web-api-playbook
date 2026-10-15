import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditCapabilityChecklist } from '../lib/capability-checklist.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePath = 'service-packs/naver/apps/naver-blog-api/research/trend-radar/sources/naver-shopping-insight.mjs';
const clientTestPath = 'service-packs/naver/apps/naver-blog-api/tests/trend-radar.test.mjs';
const contractPath = 'references/creator-public-data-contracts.json';
const checkedAt = '2026-10-15T16:10:00.000Z';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'naver-shopping-insight-checklist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = 'export async function bootstrapAnonymousNaverSession() {}\nexport async function fetchShoppingRanks() {}\nexport function parseShoppingRankResponse() {}\n';
  const clientTest = 'import test from "node:test"; test("fixture", () => {});\n';
  const contract = '{"service":"creator-access-gaps","capabilityId":"naver.shopping"}\n';
  for (const file of [sourcePath, clientTestPath, 'verification/remaining-naver-insight-2026-10-16/ranking-replay.json',
    'checklists/services/creator-access-gaps.json', contractPath]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  }
  await writeFile(path.join(root, sourcePath), source);
  await writeFile(path.join(root, clientTestPath), clientTest);
  await writeFile(path.join(root, contractPath), contract);

  const entry = {
    kind: 'naver-shopping-insight-anonymous-read-v1',
    origin: 'https://datalab.naver.com',
    path: '/shoppingInsight/getKeywordRank.naver',
    method: 'POST',
    readOnly: true,
    mime: 'application/json',
    acceptedStatuses: [200],
    files: ['verification/remaining-naver-insight-2026-10-16/ranking-replay.json'],
    hashPaths: [sourcePath, clientTestPath, contractPath],
  };
  const manifest = {
    schemaVersion: 1,
    service: 'creator-access-gaps',
    capabilities: [{
      id: 'naver.shopping',
      title: 'Naver Shopping Insight anonymous ranking JSON',
      priority: 'required',
      applicability: 'applicable',
      requirement: 'live',
      implementation: {
        files: [
          { path: sourcePath, exports: ['bootstrapAnonymousNaverSession', 'fetchShoppingRanks', 'parseShoppingRankResponse'] },
        ],
        tests: [clientTestPath],
      },
      evidence: [entry],
      sourceEvidence: [],
    }],
  };
  const counts = Array(12).fill(10);
  const responseSummary = {
    httpStatus: 200,
    mime: 'application/json;charset=UTF-8',
    responseBytes: 9091,
    periodCount: 12,
    rankCounts: counts,
  };
  const comparisonSummary = {
    ...responseSummary,
    sentCookieNames: ['BUC', 'NNB'],
    requestCookieNames: ['NNB', 'BUC', '_datalab_cid'],
  };
  const receipt = {
    schema: 'web-api-naver-shopping-insight-anonymous-read-receipt-v1',
    service: 'creator-access-gaps',
    capabilityId: 'naver.shopping',
    checkedAt,
    secretsPersistedInEvidence: false,
    cookieValuesPersisted: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    browserUsed: false,
    executionMode: 'pure_http',
    freshProcess: true,
    schemaVerified: true,
    expectedResultVerified: true,
    bootstrapRequest: {
      method: 'GET', origin: 'https://lcs.naver.com', path: '/m', httpStatus: 200,
      browserUsed: false, checkedAt, anonymous: true, credentialsUsed: false, cookieSent: false,
      queryFields: ['u'], targetOrigin: 'https://datalab.naver.com',
      issuedCookieNames: ['BUC', 'NNB'], requiredCookieNames: ['NNB'],
    },
    request: {
      method: 'POST', origin: 'https://datalab.naver.com', path: '/shoppingInsight/getKeywordRank.naver',
      httpStatus: 200, mime: 'application/json', responseContentType: 'application/json;charset=UTF-8',
      responseBytes: 9091, browserUsed: false, checkedAt, readOnly: true, anonymous: true,
      credentialsUsed: false, cookieSent: true, sentCookieNames: ['NNB'],
      requestCookieNames: ['NNB', '_datalab_cid'],
      categoryId: '50000003', timeUnit: 'date', queryFields: ['cid', 'timeUnit'], requestBodyFields: [],
    },
    rankingResult: {
      verified: true, categoryId: '50000003', timeUnit: 'date', periodCount: 12,
      rankCounts: counts, rankFields: ['rank', 'keyword'], nonEmptyKeywords: true,
    },
    bucComparison: {
      tested: true, changedCookieName: 'BUC', sameNnbCookieValue: true, cookieValuesPersisted: false,
      withNnbAndBuc: comparisonSummary,
      withNnbOnly: { ...responseSummary, sentCookieNames: ['NNB'], requestCookieNames: ['NNB', '_datalab_cid'] },
    },
    contractProvenance: {
      kind: 'repository_contract_plus_live_replay',
      contractFile: contractPath,
      currentBrowserCapture: false,
      contractFileSha256: sha(contract),
    },
    implementation: {
      [sourcePath]: sha(source),
      [clientTestPath]: sha(clientTest),
      [contractPath]: sha(contract),
    },
  };
  const save = async (nextReceipt = receipt, nextManifest = manifest) => {
    await writeFile(path.join(root, entry.files[0]), JSON.stringify(nextReceipt));
    await writeFile(path.join(root, 'checklists/services/creator-access-gaps.json'), JSON.stringify(nextManifest));
  };
  const audit = async () => auditCapabilityChecklist({ root, service: 'creator-access-gaps' });
  const status = async () => (await audit()).capabilities[0].status;
  await save();
  return { root, entry, manifest, receipt, source, save, status, audit };
}

test('Naver anonymous ranking proof records live only with scoped bootstrap, NNB-only request, schema, and current hashes', async t => {
  const f = await fixture(t);
  assert.equal(await f.status(), 'recorded_live', JSON.stringify(await f.audit(), null, 2));
});

test('Naver proof rejects missing NNB, BUC propagation, invalid schema, or persisted cookie material', async t => {
  const f = await fixture(t);
  const cases = [
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, requiredCookieNames: ['BUC'] } },
    { bootstrapRequest: { ...f.receipt.bootstrapRequest, issuedCookieNames: ['BUC'] } },
    { request: { ...f.receipt.request, sentCookieNames: ['NNB', 'BUC'] } },
    { request: { ...f.receipt.request, requestCookieNames: ['NNB', 'unexpected'] } },
    { bucComparison: { ...f.receipt.bucComparison,
      withNnbOnly: { ...f.receipt.bucComparison.withNnbOnly, requestCookieNames: ['NNB', 'unexpected'] } } },
    { rankingResult: { ...f.receipt.rankingResult, rankCounts: [9, ...Array(11).fill(10)] } },
    { bucComparison: { ...f.receipt.bucComparison, sameNnbCookieValue: false } },
    { cookieValuesPersisted: true },
    { request: { ...f.receipt.request, cookieHeader: 'NNB=fixture-secret' } },
  ];
  for (const change of cases) {
    await f.save({ ...f.receipt, ...change });
    assert.equal(await f.status(), 'evidence_invalid', JSON.stringify(change));
  }
});

test('Naver proof is bound to the maintained client and its focused client test', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, sourcePath), f.source + '// changed\n');
  assert.equal(await f.status(), 'needs_reverification');
});

test('Naver proof kind cannot be registered for another service or endpoint', async t => {
  const f = await fixture(t);
  const wrongService = { ...f.manifest, service: 'other-service' };
  await f.save(f.receipt, wrongService);
  await assert.rejects(f.status(), /CHECKLIST_SCHEMA_INVALID/);
  const wrongEndpoint = { ...f.manifest, capabilities: [{ ...f.manifest.capabilities[0],
    evidence: [{ ...f.entry, path: '/shoppingInsight/other.naver' }] }] };
  await f.save(f.receipt, wrongEndpoint);
  await assert.rejects(f.status(), /CHECKLIST_SCHEMA_INVALID/);
});
