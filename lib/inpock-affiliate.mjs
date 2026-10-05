// Offline conversion of caller-supplied source artifacts, never authentication or
// publishing. Receipts are evidence assertions, not cryptographically verified here.
import { fingerprint } from '../service-packs/naver/packages/contracts/src/index.mjs';
import { renderUnits, text } from '../service-packs/naver/apps/naver-blog-api/scripts/gates/publication-document.mjs';

const BRAND_API = 'https://gw-brandconnect.naver.com';
const PUBLICATION_KEYS = ['jobId', 'ok', 'mode', 'operation', 'source', 'accepted', 'readbackVerified', 'data'];
const digits = value => typeof value === 'string' && /^\d{1,32}$/.test(value)
  || Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const requireThat = (condition, code) => { if (!condition) fail(code); };

function exactKeys(value, allowed) {
  requireThat(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'INPUT_INVALID');
}

function rejectSecrets(value, depth = 0, visited = new Set()) {
  requireThat(depth <= 32, 'INPUT_INVALID');
  if (value === null || ['boolean', 'string'].includes(typeof value)) return;
  if (typeof value === 'number') { requireThat(Number.isFinite(value), 'INPUT_INVALID'); return; }
  requireThat(Array.isArray(value) || object(value), 'INPUT_INVALID');
  requireThat(!visited.has(value), 'INPUT_INVALID');
  visited.add(value);
  for (const [key, item] of Object.entries(value)) {
    requireThat(!['__proto__', 'prototype', 'constructor'].includes(key), 'INPUT_INVALID');
    const metadataFlag = key === 'credentialsPersisted' && item === false
      || key === 'credentialsNotPersisted' && item === true;
    if (!metadataFlag && /password|passwd|cookie|token|secret|credential|csrf|xsrf|api.?key|private.?key|^(?:headers?|session|raw|requestBody|responseBody)$/i.test(key)) fail('SECRET_INPUT_NOT_ALLOWED');
    // A publisher authorization object records user consent; an HTTP Authorization
    // header or any other authorization value is a credential and is rejected.
    if (key.toLowerCase() === 'authorization') {
      requireThat(object(item) && item.approved === true && item.approvedBy === 'user', 'SECRET_INPUT_NOT_ALLOWED');
      exactKeys(item, ['approved', 'approvedBy', 'approvedAt', 'scope', 'basis', 'contentFingerprint']);
    }
    rejectSecrets(item, depth + 1, visited);
  }
  visited.delete(value);
}

function title(value) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 150
    && !/[\x00-\x1f\x7f]/.test(value), 'TITLE_INVALID');
  return value; // Preserve the original text; do not silently shorten it.
}

function httpsUrl(value, host) {
  requireThat(typeof value === 'string' && value.length <= 4096 && !/[\x00-\x20\x7f\\]/.test(value), 'SOURCE_URL_INVALID');
  let url;
  try { url = new URL(value); } catch { fail('SOURCE_URL_INVALID'); }
  requireThat(url.protocol === 'https:' && url.hostname === host && !url.username && !url.password
    && !url.port && !url.hash, 'SOURCE_URL_INVALID');
  return url;
}

function naverArticleUrl(value, blogId, logNo) {
  const url = httpsUrl(value, 'blog.naver.com');
  const canonical = url.pathname === `/${blogId}/${logNo}` && !url.search;
  const query = url.pathname === '/PostView.naver' && url.searchParams.size === 2
    && url.searchParams.getAll('blogId').length === 1 && url.searchParams.get('blogId') === blogId
    && url.searchParams.getAll('logNo').length === 1 && url.searchParams.get('logNo') === logNo;
  requireThat(canonical || query, 'SOURCE_URL_INVALID');
  return value;
}

function shortUrl(value, provider) {
  const url = httpsUrl(value, provider === 'coupang' ? 'link.coupang.com' : 'naver.me');
  requireThat(!url.search && (provider === 'coupang' ? /^\/a\/[A-Za-z0-9]+$/.test(url.pathname)
    : /^\/[A-Za-z0-9_-]+$/.test(url.pathname)), 'SOURCE_URL_INVALID');
  return value;
}

function passedGate(gate, name, requiredChecks) {
  requireThat(object(gate) && gate.schemaVersion === 1 && gate.gate === name && gate.passed === true && object(gate.checks)
    && Object.keys(gate.checks).length > 0 && Object.values(gate.checks).every(value => value === true)
    && Array.isArray(gate.failedChecks) && gate.failedChecks.length === 0
    && requiredChecks.every(key => gate.checks[key] === true), 'SOURCE_GATE_UNVERIFIED');
}

function comparableUnits(expected, observed) {
  return observed.map((unit, index) => {
    if (unit?.type !== 'image' || expected[index]?.type !== 'image') return unit;
    try {
      const a = new URL(expected[index].value), b = new URL(unit.value);
      if (a.protocol === 'https:' && b.protocol === 'https:' && !a.port && !b.port
        && !a.username && !b.username && !a.password && !b.password
        && [a.hostname, b.hostname].every(host => ['blogfiles.pstatic.net', 'postfiles.pstatic.net'].includes(host))
        && a.pathname === b.pathname) return { ...unit, value: expected[index].value };
    } catch { /* An unsupported image alias remains different. */ }
    return unit;
  });
}

function publication(source, destination) {
  exactKeys(source, ['kind', 'job', 'jobGate', 'publicationReceipt']);
  const { job, jobGate, publicationReceipt: receipt } = source;
  requireThat(object(job) && object(receipt) && job.publish === true && job.dryRun === false
    && job.publishSettings?.visibility === 'public' && job.publishSettings?.timing === 'current'
    && job.executionMode === 'independent_http' && ['create', 'update'].includes(job.target?.type)
    && job.authorization?.scope === 'publish_once' && job.preflight?.passed === true
    && (job.target.type === 'update' ? job.preflight.kind === 'independent_http_update_preflight'
      : job.inputProvider === 'headless_sdk' && ['headless_input_http_create_preflight', 'http_native_create_preflight'].includes(job.preflight.kind))
    && /^[A-Za-z0-9_-]{3,64}$/.test(job.blogId || '') && typeof job.jobId === 'string'
    && job.jobId.length >= 6, 'PUBLICATION_UNVERIFIED');
  const originalTitle = title(job.title);
  passedGate(jobGate, 'publisher-job', ['publishSettingsPresent', 'explicitAuthorizationPresent',
    'explicitAuthorizationActor', 'explicitAuthorizationScope', 'authorizationContentMatches', 'preflightPassed',
    'independentHttpWriterRequired', 'publicationReviewPassed', 'publicationArtifactsVerified']);
  requireThat(jobGate.inputFingerprint === fingerprint(job), 'SOURCE_REVISION_MISMATCH');
  const resultGate = receipt.resultGate;
  passedGate(resultGate, 'publisher-result', ['jobIdMatches', 'resultOk', 'irreversibleStateConsistent',
    'titleVerified', 'publicHttpVerified', 'publicSmartEditorBodyVerified', 'exactPublicDocumentVerified']);
  // createPost appends root metadata after #publicationReceipt generates its gate.
  // Its actual gate binds these common payload keys, not the later create fields.
  const basePayload = Object.fromEntries(PUBLICATION_KEYS.filter(key => Object.hasOwn(receipt, key)).map(key => [key, receipt[key]]));
  requireThat(resultGate.jobFingerprint === fingerprint(job)
    && resultGate.inputFingerprint === fingerprint(basePayload), 'SOURCE_REVISION_MISMATCH');
  requireThat(receipt.jobId === job.jobId && receipt.mode === job.mode && receipt.ok === true
    && receipt.accepted === true && receipt.readbackVerified === true && receipt.source === 'independent_http'
    && receipt.operation === (job.target.type === 'create' ? 'createPost' : 'updatePost')
    && receipt.data?.published === true, 'PUBLICATION_UNVERIFIED');
  const publicReceipt = receipt.data.receipt, observed = receipt.data.independentReadback;
  const logNo = String(publicReceipt?.logNo || '');
  requireThat(/^\d{6,32}$/.test(logNo) && (job.target.type === 'create' || String(job.target.logNo) === logNo), 'SOURCE_IDENTITY_MISMATCH');
  requireThat(object(publicReceipt) && object(observed) && publicReceipt.publicStatus === 200
    && publicReceipt.publicReadback?.smartEditorBodyPresent === true
    && observed.source === 'independent_http' && observed.httpStatus === 200
    && observed.smartEditorBodyPresent === true && observed.targetIdentityVerified === true
    && observed.blogId === job.blogId && String(observed.logNo) === logNo
    && text(observed.title) === text(originalTitle) && text(job.publicationBundle?.document?.title) === text(originalTitle)
    && job.publicationBundle?.document?.blogId === job.blogId
    && (job.target.type === 'create' || String(job.publicationBundle.document.logNo) === logNo)
    && typeof publicReceipt.pageTitle === 'string' && publicReceipt.pageTitle.includes(text(originalTitle))
    && date(observed.checkedAt) && date(job.authorization?.approvedAt)
    && Date.parse(observed.checkedAt) >= Date.parse(job.authorization.approvedAt), 'PUBLICATION_UNVERIFIED');
  const articleUrl = naverArticleUrl(publicReceipt.url, job.blogId, logNo);
  naverArticleUrl(observed.url, job.blogId, logNo);
  let expected;
  try { expected = renderUnits(job.publicationBundle.document); } catch { fail('PUBLICATION_UNVERIFIED'); }
  requireThat(Array.isArray(observed.units) && expected.length > 0
    && fingerprint(expected) === fingerprint(comparableUnits(expected, observed.units)), 'SOURCE_REVISION_MISMATCH');
  const identity = { channel: 'naver-blog', blogId: job.blogId, logNo };
  if (destination === 'article') return { title: originalTitle, url: articleUrl, identity,
    checkedAt: observed.checkedAt, contract: 'NaverEditorClient.#publicationReceipt', provenance: 'publisher-job and publisher-result gates bound to the supplied job and exact public readback' };
  const affiliate = job.affiliate, offer = job.commercialSnapshot, proof = affiliate?.verification;
  requireThat(affiliate?.provider === 'coupang' && /^AF\d+$/.test(affiliate.accountId || '')
    && object(offer) && [offer.productId, offer.itemId, offer.vendorItemId].every(digits)
    && offer.affiliateUrl === affiliate.url && proof?.source === 'independent_http_redirect'
    && proof.status === 302 && proof.url === affiliate.url && proof.accountId === affiliate.accountId
    && ['productId', 'itemId', 'vendorItemId'].every(key => proof[key] === offer[key]) && date(proof.checkedAt)
    && jobGate.checks.monetizedAffiliateVerified === true && jobGate.checks.commercialSnapshotVerified === true
    && jobGate.checks.commercialAffiliateMatches === true && resultGate.checks.affiliateLinkVerified === true
    && publicReceipt.publicReadback.affiliateLinkPresent === true && observed.links?.includes(affiliate.url), 'AFFILIATE_UNVERIFIED');
  return { title: originalTitle, url: shortUrl(affiliate.url, 'coupang'),
    identity: { ...identity, provider: 'coupang', accountId: affiliate.accountId,
      productId: String(offer.productId), itemId: String(offer.itemId), vendorItemId: String(offer.vendorItemId) },
    checkedAt: proof.checkedAt, contract: 'Naver publisher Coupang affiliate gate',
    provenance: 'historical verified publication and exact Coupang offer/account redirect evidence; no current redirect replay' };
}

function httpReceipt(receipt, operation, method, path) {
  requireThat(object(receipt) && receipt.operation === operation && receipt.method === method
    && receipt.origin === BRAND_API && receipt.path === path && receipt.httpStatus === 200
    && receipt.browserUsed === false && receipt.executionMode === 'pure_http' && date(receipt.checkedAt), 'AFFILIATE_UNVERIFIED');
}

function brandconnect(source, destination) {
  requireThat(destination === 'affiliate', 'ARTICLE_RECEIPT_REQUIRED');
  exactKeys(source, ['kind', 'title', 'input', 'linkResult', 'managementResult']);
  exactKeys(source.input, ['affiliateProductId']);
  requireThat(digits(source.input.affiliateProductId), 'SOURCE_IDENTITY_MISMATCH');
  const productIdentity = String(source.input.affiliateProductId);
  const created = source.linkResult, listed = source.managementResult;
  requireThat(object(created) && object(listed) && created.ok !== false
    && (!created.service || created.service === 'naver-brandconnect')
    && (!created.command || created.command === 'shopping-create-link')
    && ['created_verified', 'created_verified_after_unclear_response', 'already_created', 'existing'].includes(created.outcome), 'AFFILIATE_UNVERIFIED');
  if (created.outcome.startsWith('created_verified')) requireThat(created.readbackVerified === true, 'AFFILIATE_UNVERIFIED');
  if (created.outcome === 'existing') requireThat(created.productEligible === true, 'AFFILIATE_UNVERIFIED');
  else requireThat(created.writeSuppressed === true && digits(created.resourceId), 'AFFILIATE_UNVERIFIED');
  if (created.outcome === 'created_verified') httpReceipt(created.receipt,
    'create-shopping-link', 'POST', '/affiliate/command/affiliate-urls');
  if (created.outcome === 'existing') httpReceipt(created.receipt,
    'shopping-detail', 'GET', `/affiliate/query/affiliate-products/${productIdentity}`);
  requireThat(listed.ok !== false && (!listed.service || listed.service === 'naver-brandconnect')
    && listed.authenticated === true && listed.ownerVerified === true && listed.browserUsed === false
    && listed.operation === 'shoppingLinks'
    && listed.verification?.identityMatched === true && listed.verification?.creator === true
    && digits(listed.verification.spaceId) && Array.isArray(listed.data?.data)
    && Number.isInteger(listed.data?.paging?.total) && listed.data.paging.total >= 0, 'AFFILIATE_UNVERIFIED');
  httpReceipt(listed.receipt, 'shopping-links', 'POST', '/affiliate/query/affiliate-urls/search');
  const url = shortUrl(created.url, 'naver-brandconnect');
  const matching = listed.data.data.filter(row => row?.shortenUrl === url
    && (created.resourceId ? String(row.affiliateUrlId) === String(created.resourceId) : String(row.id) === productIdentity));
  requireThat(matching.length === 1 && digits(String(matching[0].affiliateUrlId))
    && String(matching[0].id) === productIdentity, 'SOURCE_IDENTITY_MISMATCH');
  return { title: title(source.title), url,
    identity: { provider: 'naver-brandconnect', spaceId: String(listed.verification.spaceId),
      productType: 'shopping', resourceId: String(matching[0].affiliateUrlId), affiliateProductId: productIdentity },
    checkedAt: listed.receipt.checkedAt, contract: 'createShoppingLink + shoppingLinks',
    provenance: 'exact link ID/URL and owner-scoped independent HTTP management-list receipt; title explicitly supplied because product media/title fields are unverified' };
}

/**
 * Input: {destination:'article'|'affiliate',is_open:boolean,source:...}.
 * Naver source: {kind:'naver-publication',job,jobGate,publicationReceipt} using
 * full publisher artifact files, not CLI summaries or publish-package.json.
 * Brand Connect source: {kind:'brandconnect-shopping-link',
 * title,input,linkResult,managementResult} with actual create/read CLI results.
 * Travel is unsupported: current create receipts omit their product URL binding.
 * This checks supplied evidence consistency, not authenticity or current state.
 */
export function prepareInpockAffiliate(input) {
  exactKeys(input, ['destination', 'is_open', 'source']);
  rejectSecrets(input);
  requireThat(['article', 'affiliate'].includes(input.destination), 'DESTINATION_REQUIRED');
  requireThat(typeof input.is_open === 'boolean', 'VISIBILITY_REQUIRED');
  requireThat(object(input.source), 'SOURCE_REQUIRED');
  const selected = input.source.kind === 'naver-publication' ? publication(input.source, input.destination)
    : input.source.kind === 'brandconnect-shopping-link'
      ? brandconnect(input.source, input.destination) : fail('SOURCE_UNSUPPORTED');
  const sourceIdentity = { destination: input.destination, ...selected.identity };
  const payload = { block_type: 'link', url: selected.url, title: selected.title,
    style: 'simple', image: '', button_text: '', is_open: input.is_open };
  return { schemaVersion: 1, status: 'prepared_only', prepared_only: true,
    publicationPerformed: false, networkUsed: false, networkScope: 'this_preparation_only', liveVerificationPerformed: false,
    destination: input.destination, payload, sourceIdentity,
    idempotencyKey: fingerprint({ target: 'inpock-link', sourceIdentity }),
    payloadFingerprint: fingerprint(payload),
    mediaHandling: 'image_omitted_no_verified_inpock_media_contract',
    sameIdentityChangedPayloadPolicy: 'review_update_conflict_before_submission',
    provenance: { sourceKind: input.source.kind, sourceContract: selected.contract,
      checkedAt: selected.checkedAt, evidence: selected.provenance,
      trustBoundary: 'caller_supplied_artifacts_not_authenticated_here',
      liveVerificationRequiredBeforePublish: true } };
}
