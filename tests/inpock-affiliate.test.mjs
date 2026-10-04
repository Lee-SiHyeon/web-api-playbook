import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareInpockAffiliate } from '../lib/inpock-affiliate.mjs';
import { fingerprint } from '../service-packs/naver/packages/contracts/src/index.mjs';
import { renderUnits } from '../service-packs/naver/apps/naver-blog-api/scripts/gates/publication-document.mjs';

// Synthetic artifacts with the actual Naver publisher receipt/gate nesting and
// Brand Connect CLI response fields. These fixtures are not live write evidence.
const CHECKED = '2026-10-04T13:00:00.000Z';
const ARTICLE = 'https://blog.naver.com/PostView.naver?blogId=fixture_owner&logNo=224400001111';
const COUPANG = 'https://link.coupang.com/a/synthetic123';
const NAVER = 'https://naver.me/synthetic123';
const JOB_CHECKS = ['publishSettingsPresent', 'explicitAuthorizationPresent', 'explicitAuthorizationActor',
  'explicitAuthorizationScope', 'authorizationContentMatches', 'preflightPassed', 'independentHttpWriterRequired', 'publicationReviewPassed',
  'publicationArtifactsVerified', 'monetizedAffiliateVerified', 'commercialSnapshotVerified', 'commercialAffiliateMatches'];
const RESULT_CHECKS = ['jobIdMatches', 'resultOk', 'irreversibleStateConsistent', 'titleVerified',
  'publicHttpVerified', 'publicSmartEditorBodyVerified', 'exactPublicDocumentVerified', 'affiliateLinkVerified'];

function bindPublication(input) {
  const { job, publicationReceipt: receipt } = input.source;
  input.source.jobGate = { schemaVersion: 1, gate: 'publisher-job', passed: true,
    checks: Object.fromEntries(JOB_CHECKS.map(key => [key, true])), failedChecks: [], inputFingerprint: fingerprint(job) };
  const keys = ['jobId', 'ok', 'mode', 'operation', 'source', 'accepted', 'readbackVerified', 'data'];
  const payload = Object.fromEntries(keys.map(key => [key, receipt[key]]));
  receipt.resultGate = { schemaVersion: 1, gate: 'publisher-result', passed: true,
    checks: Object.fromEntries(RESULT_CHECKS.map(key => [key, true])), failedChecks: [],
    jobFingerprint: fingerprint(job), inputFingerprint: fingerprint(payload) };
  return input;
}

function publication(type = 'update') {
  const blocks = [
    { type: 'notice', text: '이 포스팅은 쿠팡 파트너스 활동의 일환으로 수수료를 제공받습니다.' },
    { type: 'link', label: '선택 상품 상세', url: COUPANG },
    { type: 'heading', text: '비교한 조건' },
    { type: 'paragraph', text: '합성 예시입니다. 실제 사용 후기를 주장하지 않습니다.' },
    { type: 'image', publishedUrl: 'https://blogfiles.pstatic.net/example/comparison.png' },
  ];
  const title = '여행용 상품 비교와 선택 조건';
  const job = { jobId: 'synthetic-publish-job', blogId: 'fixture_owner', mode: 'publish',
    publish: true, dryRun: false, target: { type, ...(type === 'update' ? { logNo: '224400001111' } : {}) },
    title, executionMode: 'independent_http', publishSettings: { visibility: 'public', timing: 'current' },
    authorization: { approved: true, approvedBy: 'user', approvedAt: '2026-10-04T12:59:00.000Z', scope: 'publish_once' },
    preflight: { passed: true, kind: type === 'update' ? 'independent_http_update_preflight' : 'headless_input_http_create_preflight' },
    ...(type === 'create' ? { inputProvider: 'headless_sdk' } : {}),
    affiliate: { provider: 'coupang', accountId: 'AF1234567', url: COUPANG,
      verification: { source: 'independent_http_redirect', status: 302, checkedAt: CHECKED,
        url: COUPANG, accountId: 'AF1234567', productId: '1000', itemId: '2000', vendorItemId: '3000' } },
    commercialSnapshot: { provider: 'coupang', affiliateUrl: COUPANG, productId: '1000', itemId: '2000', vendorItemId: '3000', credentialsPersisted: false },
    bodyBlocks: structuredClone(blocks), publicationBundle: { document: { blogId: 'fixture_owner', title,
      ...(type === 'update' ? { logNo: '224400001111' } : {}), blocks } } };
  const observation = { source: 'independent_http', url: ARTICLE, httpStatus: 200,
    checkedAt: CHECKED, blogId: job.blogId, logNo: '224400001111', title, targetIdentityVerified: true,
    smartEditorBodyPresent: true, units: renderUnits(job.publicationBundle.document), links: [COUPANG] };
  const receipt = { jobId: job.jobId, ok: true, mode: job.mode, operation: type === 'create' ? 'createPost' : 'updatePost',
    source: 'independent_http', accepted: true, readbackVerified: true,
    data: { published: true, independentReadback: observation,
      receipt: { url: ARTICLE, logNo: '224400001111', pageTitle: title, publicStatus: 200,
        publicReadback: { smartEditorBodyPresent: true, affiliateLinkPresent: true } } } };
  if (type === 'create') Object.assign(receipt, { schemaVersion: 1, inputProvider: 'headless_sdk',
    blogId: job.blogId, logNo: '224400001111', checkedAt: CHECKED, protectedOwnerVerified: true,
    visibilityVerified: 'public', configurationVerified: true, browserEngineFree: false });
  return bindPublication({ destination: 'article', is_open: false,
    source: { kind: 'naver-publication', job, publicationReceipt: receipt } });
}

function httpReceipt(operation, method, path) {
  return { operation, method, origin: 'https://gw-brandconnect.naver.com', path,
    httpStatus: 200, responseBytes: 200, checkedAt: CHECKED, browserUsed: false, executionMode: 'pure_http' };
}

function brand(shopping = true, outcome = 'created_verified') {
  const id = '807701517671809', resourceId = '999434063846048';
  const row = shopping ? { id, affiliateUrlId: resourceId, shortenUrl: NAVER }
    : { connectUrlId: resourceId, shortenUrl: NAVER, originUrl: 'https://pkgtour.naver.com/products/sample/base' };
  const linkResult = { ok: true, service: 'naver-brandconnect', command: shopping ? 'shopping-create-link' : 'travel-create-link',
    outcome, resourceId, url: NAVER, readbackVerified: true, writeSuppressed: true,
    receipt: httpReceipt(shopping ? 'create-shopping-link' : 'create-travel-link', 'POST',
      shopping ? '/affiliate/command/affiliate-urls' : '/affiliate/command/connect-urls') };
  if (outcome === 'already_created' || outcome === 'created_verified_after_unclear_response') delete linkResult.receipt;
  if (outcome === 'already_created') delete linkResult.readbackVerified;
  return { destination: 'affiliate', is_open: true, source: { kind: shopping ? 'brandconnect-shopping-link' : 'brandconnect-travel-link',
    title: '여행 준비 선택 상품', input: shopping ? { affiliateProductId: id }
      : { productUrl: 'https://pkgtour.naver.com/products/sample/departure-20261012?reqChannel=brandconnect' }, linkResult,
    managementResult: { ok: true, service: 'naver-brandconnect', authenticated: true, ownerVerified: true,
      browserUsed: false, operation: shopping ? 'shoppingLinks' : 'travelLinks',
      verification: { identityMatched: true, creator: true, spaceId: '123456' },
      receipt: httpReceipt(shopping ? 'shopping-links' : 'travel-links', shopping ? 'POST' : 'GET',
        shopping ? '/affiliate/query/affiliate-urls/search' : '/affiliate/query/connect-urls/search'),
      data: { data: [row], paging: { total: 1 } } } } };
}

const rejects = (input, code) => assert.throws(() => prepareInpockAffiliate(input), code ? { code } : undefined);

test('article and affiliate destinations preserve distinct URLs and the explicit visibility choice', () => {
  const input = publication(), before = structuredClone(input);
  const article = prepareInpockAffiliate(input);
  assert.deepEqual(article.payload, { block_type: 'link', url: ARTICLE, title: input.source.job.title,
    style: 'simple', image: '', button_text: '', is_open: false });
  input.destination = 'affiliate'; input.is_open = true;
  const affiliate = prepareInpockAffiliate(input);
  assert.equal(affiliate.payload.url, COUPANG);
  assert.equal(affiliate.payload.is_open, true);
  assert.notEqual(article.idempotencyKey, affiliate.idempotencyKey);
  assert.equal(article.status, 'prepared_only');
  assert.equal(article.publicationPerformed, false);
  assert.equal(article.networkUsed, false);
  assert.equal(article.liveVerificationPerformed, false);
  assert.equal(article.provenance.trustBoundary, 'caller_supplied_artifacts_not_authenticated_here');
  assert.deepEqual(before, publication()); // Conversion has not mutated the source artifacts.
});

test('new-post receipt metadata is accepted with the actual pre-extension payload fingerprint', () => {
  const input = publication('create');
  const result = prepareInpockAffiliate(input);
  assert.equal(result.sourceIdentity.logNo, '224400001111');
  assert.equal(result.payload.url, ARTICLE);
  assert.notEqual(input.source.publicationReceipt.resultGate.inputFingerprint,
    fingerprint({ ...input.source.publicationReceipt, resultGate: undefined }));
});

test('destination and is_open have no implicit defaults or truthy coercion', () => {
  for (const mutation of [i => delete i.destination, i => { i.destination = 'automatic'; },
    i => delete i.is_open, i => { i.is_open = 'true'; }, i => { i.is_open = 1; }]) {
    const input = publication(); mutation(input); rejects(input);
  }
});

test('private, draft, failed, receipt-summary and unbound source artifacts are rejected', () => {
  for (const mutation of [
    i => { i.source.job.publishSettings.visibility = 'private'; bindPublication(i); },
    i => { i.source.job.publish = false; bindPublication(i); },
    i => { i.source.job.authorization.scope = 'unscoped'; bindPublication(i); },
    i => { i.source.job.preflight.passed = false; bindPublication(i); },
    i => { i.source.publicationReceipt.readbackVerified = false; bindPublication(i); },
    i => { i.source.jobGate.passed = false; },
    i => { i.source.jobGate.schemaVersion = 99; },
    i => { i.source.jobGate.checks.publicationReviewPassed = false; },
    i => { i.source.publicationReceipt.resultGate.checks.exactPublicDocumentVerified = false; },
    i => { i.source.jobGate.checks = {}; },
    i => { i.source.job.title = '새로 바뀐 제목'; },
    i => { i.source.publicationReceipt.data.receipt.url = 'https://blog.naver.com/fixture_owner/224400009999'; bindPublication(i); },
    i => { i.source.publicationReceipt.data.independentReadback.targetIdentityVerified = false; bindPublication(i); },
    i => { i.source.publicationReceipt.data.independentReadback.checkedAt = '2026-10-04T12:58:00.000Z'; bindPublication(i); },
    i => { i.source.publicationReceipt = { readbackVerified: true, logNo: '224400001111' }; },
  ]) { const input = publication(); mutation(input); rejects(input); }
});

test('complete ordered public readback is checked independently of submitted gate flags', () => {
  const input = publication();
  input.source.publicationReceipt.data.independentReadback.units.splice(2, 1);
  bindPublication(input);
  rejects(input, 'SOURCE_REVISION_MISMATCH');
});

test('observed Naver blogfiles/postfiles image aliases are accepted without creating a thumbnail contract', () => {
  const input = publication();
  const image = input.source.publicationReceipt.data.independentReadback.units.find(unit => unit.type === 'image');
  image.value = image.value.replace('blogfiles.pstatic.net', 'postfiles.pstatic.net'); bindPublication(input);
  assert.equal(prepareInpockAffiliate(input).payload.image, '');
  image.value = image.value.replace('postfiles.pstatic.net', 'other.example.invalid'); bindPublication(input);
  rejects(input, 'SOURCE_REVISION_MISMATCH');
});

test('Coupang link proof must retain the exact account, product and options and clickable readback', () => {
  for (const mutation of [
    i => { i.source.job.affiliate.provider = 'unknown'; },
    i => { i.source.job.affiliate.verification.accountId = 'AF99999'; },
    i => { i.source.job.affiliate.verification.itemId = '9999'; },
    i => { i.source.job.affiliate.verification.status = 200; },
    i => { i.source.publicationReceipt.data.independentReadback.links = []; },
    i => { i.source.jobGate.checks.monetizedAffiliateVerified = false; },
  ]) {
    const input = publication(); input.destination = 'affiliate'; mutation(input);
    if (input.source.jobGate.checks.monetizedAffiliateVerified) bindPublication(input);
    rejects(input);
  }
});

test('Brand Connect shopping uses actual result/management contracts, including reconciliation', () => {
  for (const outcome of ['created_verified', 'already_created', 'created_verified_after_unclear_response']) {
    const input = brand(true, outcome), result = prepareInpockAffiliate(input);
    assert.equal(result.payload.url, NAVER);
    assert.equal(result.payload.title, input.source.title);
    assert.equal(result.sourceIdentity.resourceId, input.source.linkResult.resourceId);
    assert.equal(result.sourceIdentity.spaceId, '123456');
    assert.equal(result.payload.image, '');
  }
});

test('travel receipts cannot establish a product-to-link binding and are explicitly unsupported', () => {
  const input = brand(false);
  input.source.input.productUrl = 'https://pkgtour.naver.com/products/other/unrelated';
  rejects(input, 'SOURCE_UNSUPPORTED');
});

test('an existing shopping link requires eligible detail plus independent exact management readback', () => {
  const input = brand(true, 'existing'), created = input.source.linkResult;
  delete created.resourceId; delete created.readbackVerified; delete created.writeSuppressed;
  created.productEligible = true;
  created.receipt = httpReceipt('shopping-detail', 'GET', `/affiliate/query/affiliate-products/${input.source.input.affiliateProductId}`);
  assert.equal(prepareInpockAffiliate(input).sourceIdentity.resourceId, '999434063846048');
  created.productEligible = false; rejects(input, 'AFFILIATE_UNVERIFIED');
});

test('ambiguous, unverified and unrelated Brand Connect responses cannot prepare a public link', () => {
  for (const mutation of [
    i => { i.source.linkResult.outcome = 'created_unverified'; },
    i => { i.source.linkResult.outcome = 'previous_attempt_unresolved'; },
    i => { i.source.linkResult.readbackVerified = false; },
    i => { i.source.managementResult.ownerVerified = false; },
    i => { i.source.managementResult.verification.identityMatched = false; },
    i => { i.source.managementResult.browserUsed = true; },
    i => { i.source.managementResult.receipt.httpStatus = 403; },
    i => { i.source.managementResult.receipt.path = '/brand-connect/query/me'; },
    i => { i.source.managementResult.operation = 'travelLinks'; },
    i => { i.source.managementResult.data.data = []; },
    i => { i.source.managementResult.data.data.push(structuredClone(i.source.managementResult.data.data[0])); },
    i => { i.source.managementResult.data.data[0].id = '999999'; },
    i => { i.source.managementResult.data.data[0].shortenUrl = 'https://naver.me/other'; },
    i => { i.destination = 'article'; },
  ]) { const input = brand(); mutation(input); rejects(input); }
});

test('source identities deduplicate across receipt timestamps and record content changes separately', () => {
  const input = brand(), first = prepareInpockAffiliate(input);
  input.source.managementResult.receipt.checkedAt = '2026-10-04T13:01:00.000Z';
  input.source.title = '다르게 편집한 제목';
  const second = prepareInpockAffiliate(input);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.notEqual(first.payloadFingerprint, second.payloadFingerprint);
  assert.equal(second.sameIdentityChangedPayloadPolicy, 'review_update_conflict_before_submission');
  input.source.managementResult.verification.spaceId = '654321';
  assert.notEqual(first.idempotencyKey, prepareInpockAffiliate(input).idempotencyKey);
});

test('unsupported hosts, userinfo, duplicate query identity and secret URL queries are rejected', () => {
  const invalidArticles = [ARTICLE.replace('blog.naver.com', 'blog.naver.com.evil.example'),
    ARTICLE.replace('https://', 'https://user:pass@'), ARTICLE + '&blogId=somebody_else', ARTICLE + '&token=sentinel'];
  for (const url of invalidArticles) {
    const input = publication(); input.source.publicationReceipt.data.receipt.url = url; bindPublication(input); rejects(input);
  }
  for (const url of ['https://naver.me.evil.example/link', 'http://naver.me/link', 'https://naver.me/link?token=sentinel', 'https://user:pass@naver.me/link']) {
    const input = brand(); input.source.linkResult.url = url; input.source.managementResult.data.data[0].shortenUrl = url; rejects(input);
  }
});

test('credentials and hidden request/session keys are rejected at every nesting level without echoing values', () => {
  for (const key of ['password', 'cookies', 'accessToken', 'authorization', 'headers', 'session', 'csrfToken']) {
    const input = brand(); input.source.managementResult.data.data[0][key] = 'sentinel-must-not-appear';
    rejects(input);
  }
  const input = publication(); input.source.job.credentialsPersisted = true; rejects(input, 'SECRET_INPUT_NOT_ALLOWED');
});

test('titles are preserved exactly and over-limit or control-character titles are rejected', () => {
  const input = brand(); input.source.title = '  원문 제목을 보존합니다  ';
  assert.equal(prepareInpockAffiliate(input).payload.title, input.source.title);
  for (const value of ['가'.repeat(151), '', '   ', '제목\n다음 줄']) { input.source.title = value; rejects(input, 'TITLE_INVALID'); }
});

test('pure preparation does not call fetch or mutate source evidence', () => {
  const originalFetch = globalThis.fetch, input = brand(), before = structuredClone(input);
  globalThis.fetch = () => { throw Error('NETWORK_MUST_NOT_RUN'); };
  try { assert.equal(prepareInpockAffiliate(input).networkUsed, false); assert.deepEqual(input, before); }
  finally { globalThis.fetch = originalFetch; }
});

test('real CLI uses stdin source artifacts only and reports prepared_only with no publication', () => {
  const script = fileURLToPath(new URL('../scripts/inpock-prepare.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify(brand()), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true); assert.equal(output.prepared_only, true);
  assert.equal(output.publicationPerformed, false); assert.equal(output.networkUsed, false);
  const secret = brand(); secret.source.password = 'sentinel-must-not-appear';
  const rejected = spawnSync(process.execPath, [script], { input: JSON.stringify(secret), encoding: 'utf8', timeout: 10000 });
  assert.equal(rejected.status, 2);
  assert.equal(JSON.parse(rejected.stdout).code, 'SECRET_INPUT_NOT_ALLOWED');
  assert.equal(rejected.stdout.includes('sentinel-must-not-appear'), false);
  const args = spawnSync(process.execPath, [script, '--credentials-stdin'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(args.status, 2); assert.equal(JSON.parse(args.stdout).code, 'ARGUMENT_INVALID');
});
