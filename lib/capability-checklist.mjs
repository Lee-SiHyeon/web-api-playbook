import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const INPOCK_API = 'https://link-rest.inpock.co.kr';
const OLIVEYOUNG_KR = 'https://www.oliveyoung.co.kr';
const OLIVEYOUNG_BEST_PAGE = `${OLIVEYOUNG_KR}/store/main/main.do`;
const OLIVEYOUNG_BEST_ENDPOINT = '/store/main/getBestList.do';
const OLIVEYOUNG_BEST_BUNDLE = 'https://static.oliveyoung.co.kr/pc-static-root/js/main/best.js';
const OLIVEYOUNG_BEST_BUNDLE_SHA256 = '27f10217e8d1b981adbab30b4e54c488d0774dfcccb47680c7f951900e9f32e2';
const OLIVEYOUNG_ANONYMOUS_COOKIES = new Set(['__cf_bm', '_cfuvid', 'cf_clearance']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const is2xx = value => Number.isInteger(value) && value >= 200 && value < 300;
const same = (a, b) => a === b;
const checks = (value, expected) => Object.entries(expected).every(([key, item]) => same(value?.[key], item));
const validOrigin = value => {
  try { return typeof value === 'string' && new URL(value).origin === value && value.startsWith('https://'); }
  catch { return false; }
};
const publicReadSpec = entry => object(entry) && validOrigin(entry.origin) &&
  typeof entry.path === 'string' && entry.path.startsWith('/') &&
  ['GET', 'POST'].includes(entry.method ?? 'GET') &&
  (entry.method !== 'POST' || entry.readOnly === true) &&
  (entry.acceptedStatuses === undefined || Array.isArray(entry.acceptedStatuses) && entry.acceptedStatuses.length > 0 &&
    entry.acceptedStatuses.every(is2xx)) &&
  (entry.mime === undefined || ['application/json', 'application/json-amazonui-streaming', 'text/html', 'text/javascript',
    'application/zip', 'application/x-ndjson', 'text/plain', 'text/csv', 'application/octet-stream', 'application/gzip',
    'application/xml', 'text/xml'].includes(entry.mime));

export function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    !path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every(part => part && part !== '.' && part !== '..') &&
    !value.startsWith('-');
}

async function safeRead(root, relative, { json = false } = {}) {
  if (!safeRelativePath(relative)) throw new Error('UNSAFE_PATH');
  const rootReal = await realpath(root);
  const target = path.join(rootReal, relative);
  let targetReal;
  try { targetReal = await realpath(target); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!targetReal.startsWith(rootReal + path.sep)) throw new Error('UNSAFE_PATH');
  const info = await stat(targetReal);
  if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new Error('FILE_INVALID');
  const raw = await readFile(targetReal, 'utf8');
  if (!json) return raw;
  try { return JSON.parse(raw); }
  catch { throw new Error('JSON_INVALID'); }
}

function assertManifest(manifest) {
  if (!object(manifest) || manifest.schemaVersion !== 1 || !ID.test(manifest.service ?? '') ||
      !Array.isArray(manifest.capabilities) || !manifest.capabilities.length) throw new Error('CHECKLIST_SCHEMA_INVALID');
  const ids = new Set();
  for (const cap of manifest.capabilities) {
    if (!object(cap) || !ID.test(cap.id ?? '') || ids.has(cap.id) || typeof cap.title !== 'string' || !cap.title.trim() ||
        !['required', 'conditional', 'optional'].includes(cap.priority) ||
        !['applicable', 'unknown', 'not_applicable'].includes(cap.applicability) ||
        (cap.applicability === 'not_applicable' && (typeof cap.applicabilityReason !== 'string' || !cap.applicabilityReason.trim())) ||
        !['live', 'local', 'inventory'].includes(cap.requirement) || !object(cap.implementation) ||
        !Array.isArray(cap.implementation.files) || !Array.isArray(cap.implementation.tests) ||
        (cap.implementation.cli !== undefined && !Array.isArray(cap.implementation.cli)) ||
        !Array.isArray(cap.evidence) || !Array.isArray(cap.sourceEvidence)) throw new Error('CHECKLIST_SCHEMA_INVALID');
    ids.add(cap.id);
    for (const entry of cap.implementation.files) {
      if (!object(entry) || !safeRelativePath(entry.path) ||
          (entry.exports !== undefined && (!Array.isArray(entry.exports) || entry.exports.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))))) throw new Error('CHECKLIST_SCHEMA_INVALID');
    }
    for (const entry of cap.implementation.cli ?? []) {
      if (!object(entry) || !safeRelativePath(entry.path) || !Array.isArray(entry.tokens) ||
          !entry.tokens.length || entry.tokens.some(token => typeof token !== 'string' || !token || token.length > 120)) throw new Error('CHECKLIST_SCHEMA_INVALID');
    }
    if (cap.implementation.tests.some(test => !safeRelativePath(test))) throw new Error('CHECKLIST_SCHEMA_INVALID');
    for (const entry of [...cap.evidence, ...cap.sourceEvidence]) {
      if (!object(entry) || !Array.isArray(entry.files) || !entry.files.length ||
          entry.files.some(file => !safeRelativePath(file)) ||
          (entry.hashPaths !== undefined && (!Array.isArray(entry.hashPaths) || entry.hashPaths.some(file => !safeRelativePath(file))))) throw new Error('CHECKLIST_SCHEMA_INVALID');
      if (['http-public-read-v1', 'http-credentialed-read-v1', 'commerce-collection-v1', 'amazon-product-session-read-v1'].includes(entry.kind) && (!publicReadSpec(entry) ||
            entry.companionReads !== undefined && (!Array.isArray(entry.companionReads) ||
              entry.companionReads.some(read => !publicReadSpec(read) || !/^[a-z][A-Za-z0-9]{0,59}$/.test(read.key ?? '')))) ||
          entry.kind === 'http-anonymous-session-read-v1' &&
            (manifest.service !== 'oliveyoung-public' || cap.id !== 'ranking.top_products' ||
              entry.origin !== OLIVEYOUNG_KR || entry.path !== OLIVEYOUNG_BEST_ENDPOINT || entry.method !== 'GET' ||
              entry.mime !== 'text/html' || entry.readOnly !== true ||
              entry.acceptedStatuses !== undefined && (!Array.isArray(entry.acceptedStatuses) ||
                entry.acceptedStatuses.length !== 1 || entry.acceptedStatuses[0] !== 200) ||
              !Array.isArray(entry.hashPaths) || entry.hashPaths.length === 0 || entry.companionReads !== undefined) ||
          entry.kind === 'http-read-v1' && (!validOrigin(entry.origin) || typeof entry.path !== 'string' || !entry.path.startsWith('/')) ||
          entry.kind === 'http-write-v1' && (!validOrigin(entry.origin) || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(entry.method) ||
            typeof entry.path !== 'string' || !entry.path.startsWith('/') || typeof entry.readbackPath !== 'string' ||
            !entry.readbackPath.startsWith('/') || entry.httpStatus !== undefined ||
            entry.acceptedStatuses !== undefined && (!Array.isArray(entry.acceptedStatuses) || !entry.acceptedStatuses.length ||
              entry.acceptedStatuses.some(status => !is2xx(status))))) throw new Error('CHECKLIST_SCHEMA_INVALID');
    }
  }
  return manifest;
}

function exportPresent(raw, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bexport\\s+(?:(?:async|default)\\s+)?(?:function|class|const|let|var)\\s+${escaped}\\b|\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, 'm').test(raw);
}

function syntaxOk(target) {
  const result = spawnSync(process.execPath, ['--check', target], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '' },
  });
  return result.status === 0 && !result.error;
}

async function codeInventory(root, cap) {
  const details = [];
  for (const entry of cap.implementation.files) {
    try {
      const raw = await safeRead(root, entry.path);
      if (raw === null) details.push({ path: entry.path, state: 'missing' });
      else {
        const exportsMissing = (entry.exports ?? []).filter(name => !exportPresent(raw, name));
        const validSyntax = syntaxOk(path.join(root, entry.path));
        details.push({ path: entry.path, state: exportsMissing.length || !validSyntax ? 'partial' : 'present',
          exportsMissing, syntax: validSyntax ? 'valid' : 'invalid' });
      }
    } catch (error) { details.push({ path: entry.path, state: 'invalid', reason: error.message }); }
  }
  for (const entry of cap.implementation.cli ?? []) {
    try {
      const raw = await safeRead(root, entry.path);
      if (raw === null) details.push({ path: entry.path, state: 'missing', kind: 'cli' });
      else {
        const tokensMissing = entry.tokens.filter(token => !raw.includes(token));
        const validSyntax = syntaxOk(path.join(root, entry.path));
        details.push({ path: entry.path, kind: 'cli', state: tokensMissing.length || !validSyntax ? 'partial' : 'present',
          tokensMissing, syntax: validSyntax ? 'valid' : 'invalid' });
      }
    } catch (error) { details.push({ path: entry.path, state: 'invalid', kind: 'cli', reason: error.message }); }
  }
  for (const file of cap.implementation.tests) {
    try {
      const raw = await safeRead(root, file);
      if (raw === null) details.push({ path: file, state: 'missing', kind: 'test' });
      else details.push({ path: file, state: syntaxOk(path.join(root, file)) ? 'present' : 'partial', kind: 'test' });
    } catch (error) { details.push({ path: file, state: 'invalid', kind: 'test', reason: error.message }); }
  }
  const states = details.map(item => item.state);
  return { state: states.length === 0 || states.every(state => state === 'missing') ? 'missing' :
    states.every(state => state === 'present') ? 'present' : 'partial', details,
    note: 'Static file, symbol, token and syntax inventory only. Test execution is reported separately.' };
}

function http(receipt, method, route, status, origin = null, json = false) {
  return object(receipt) && checks(receipt, { method, path: route, browserUsed: false }) &&
    (status === null ? is2xx(receipt.httpStatus) : receipt.httpStatus === status) &&
    (origin === null ? validOrigin(receipt.origin) : receipt.origin === origin) &&
    (json ? receipt.mime === 'application/json' && Number.isInteger(receipt.responseBytes) && receipt.responseBytes > 0 :
      receipt.responseBytes === undefined || Number.isInteger(receipt.responseBytes) && receipt.responseBytes > 0) &&
    validTime(receipt.checkedAt);
}
const inpockHttp = (receipt, method, route, status) => http(receipt, method, route, status, INPOCK_API);

function inpockAuth([proof, runner]) {
  const allStates = ['captured', 'client_exists', 'credential_propagated', 'remnant_free', 'live_replay'];
  return proof?.schema === 'inpock-login-verification-v1' && validTime(proof.checkedAt) &&
    proof.secretsPersistedInEvidence === false && allStates.every(key => proof.states?.[key] === true) &&
    checks(proof.independentHttp, { browserCookiesCopied: false, passwordLoginStatus: 201, ownerStatus: 200,
      loginUsernameMatched: true, ownerUsernameMatched: true }) &&
    checks(proof.actualRunner, { exitStatus: 0, credentialReachedConsumer: true, browserUsed: false,
      loginStatus: 201, reuse: 'stored_session' }) &&
    runner?.command === 'verify' && runner.ok === true && runner.persistent === false &&
    runner.credentialProvider === 'process-memory' && runner.browser_launched_by_runner === false &&
    inpockHttp(runner.login?.loginReceipt, 'POST', '/login', 201) &&
    [runner.login, runner.health, runner.reuse].every(value => value?.authenticated === true && value?.ownerVerified === true &&
      inpockHttp(value?.receipt, 'GET', '/v2/users', 200)) && runner.reuse?.renewal === 'stored_session';
}

function inpockInventory([runner]) {
  return runner?.command === 'inventory' && runner.ok === true && runner.browser_launched_by_runner === false &&
    runner.credentialProvider === 'process-memory' && runner.persistent === false &&
    runner.blocks?.authenticated === true && runner.blocks?.ownerVerified === true && runner.blocks?.complete === true &&
    Array.isArray(runner.blocks.receipts) && runner.blocks.receipts.length > 0 &&
    runner.blocks.receipts.every(item => inpockHttp(item, 'GET', '/v2/blocks', 200)) &&
    runner.public?.authenticated === true && runner.public?.ownerVerified === true &&
    inpockHttp(runner.public?.receipt, 'GET', '/v2/users/:username/public', 200) &&
    runner.public.receipt.ownerMatched === true &&
    runner.stats?.authenticated === true && runner.stats?.ownerVerified === true &&
    inpockHttp(runner.stats?.receipt, 'GET', '/stats/mini', 200);
}

function inpockProfileRead([proof]) {
  const states = ['captured', 'client_exists', 'credential_propagated', 'remnant_free', 'live_replay'];
  return proof?.schema === 'inpock-profile-verification-v1' && proof.secretsPersistedInEvidence === false &&
    proof.profileRead?.authenticated === true && proof.profileRead?.ownerVerified === true &&
    SHA256.test(proof.profileRead?.snapshotHash ?? '') &&
    Array.isArray(proof.profileRead?.profileFieldNames) && proof.profileRead.profileFieldNames.length > 0 &&
    typeof proof.profileRead.actualRunner === 'string' && proof.profileRead.actualRunner.includes('profile-get') &&
    inpockHttp(proof.profileRead?.receipt, 'GET', '/v2/users/design', 200) &&
    states.every(key => proof.states?.profileRead?.[key] === true) &&
    proof.liveSavePerformed === false && proof.liveSaveVerified === false && proof.postAttempts === 0 &&
    proof.unchangedEdit?.writeSent === false && proof.unchangedEdit?.postAttempts === 0 &&
    proof.states?.profileEdit?.live_replay === false;
}

function inpockPublication([proof, first, repeat], entry) {
  const blockId = proof?.blockId;
  const profile = proof?.anonymousWebRendering;
  const publicWeb = [profile?.desktop, profile?.mobile].every(view => view?.status === 'VERIFIED' &&
    view.anonymous_fresh_context === true && view.cookies_seeded === false &&
    view.initial_document_status === 200 && view.reload_document_status === 200 &&
    view.initial?.cardCount === 1 && view.reloaded?.cardCount === 1 &&
    view.initial?.visibleTitlePresent === true && view.reloaded?.visibleTitlePresent === true &&
    Array.isArray(view.initial?.cards) && view.initial.cards.some(card =>
      card.href === proof?.payload?.url && card.titleMatches === true && card.visible === true));
  const reads = result => result?.authenticated === true && result.ownerVerified === true &&
    result.readbackVerified === true && result.publicVerified === true && result.blockId === blockId &&
    Array.isArray(result.readReceipts?.owner) && result.readReceipts.owner.length > 0 &&
    result.readReceipts.owner.every(item => inpockHttp(item, 'GET', '/v2/blocks', 200)) &&
    inpockHttp(result.readReceipts?.public, 'GET', '/v2/users/:username/public', 200) &&
    result.readReceipts.public.ownerMatched === true;
  return proof?.schema === 'inpock-publication-proof-v1' && validTime(proof.checkedAt) &&
    typeof proof.payload?.title === 'string' && proof.payload.title.length > 0 &&
    typeof proof.payload?.url === 'string' && proof.payload.url.startsWith('https://') &&
    validTime(first?.checkedAt) && validTime(repeat?.checkedAt) &&
    Date.parse(first.checkedAt) <= Date.parse(repeat.checkedAt) &&
    proof.secretsPersistedInEvidence === false && Number.isSafeInteger(blockId) && blockId > 0 &&
    proof.states?.live_replay === true && proof.phaseBoundary?.publicationAndApiReadbackBrowserUsed === false &&
    proof.firstPost?.httpStatus === 201 && proof.firstPost.postAttempts === 1 &&
    proof.firstPost.ownerReadbackVerified === true && proof.firstPost.anonymousPublicVerified === true &&
    proof.firstPost.fullPayloadMatched === true && proof.sameIntentFreshProcess?.postAttempts === 0 &&
    proof.firstPost.receipt === path.basename(entry.files[1] ?? '') &&
    proof.sameIntentFreshProcess.receipt === path.basename(entry.files[2] ?? '') &&
    proof.sameIntentFreshProcess.writeSuppressed === true && proof.sameIntentFreshProcess.blockId === blockId &&
    proof.sameIntentFreshProcess.ownerCount === 1 && proof.sameIntentFreshProcess.anonymousPublicCount === 1 &&
    first?.status === 'desired_state_verified_after_unclear_write' && first.writeSent === true &&
    first.postAttempts === 1 && inpockHttp(first.writeReceipt, 'POST', '/blocks', 201) && reads(first) &&
    repeat?.status === 'already_verified' && repeat.writeSent === false && repeat.writeSuppressed === true &&
    repeat.postAttempts === 0 && reads(repeat) && publicWeb &&
    profile?.status === 'VERIFIED' && profile?.expected?.block_id === blockId &&
    profile.expected.target_url === proof.payload?.url && profile.expected.title === proof.payload?.title;
}

function genericHttpRead([receipt], entry, cap) {
  return receipt?.schema === 'web-api-capability-receipt-v1' && receipt.service === entry.service &&
    receipt.capabilityId === cap.id && validTime(receipt.checkedAt) &&
    receipt.secretsPersistedInEvidence === false && receipt.authenticated === true &&
    receipt.ownerVerified === true && http(receipt.request, 'GET', entry.path, 200, entry.origin, true) &&
    receipt.request.ownerMatched === true;
}

function publicHttpRead([receipt, execution], entry, cap) {
  const provenance = receipt?.contractProvenance;
  let source;
  try { source = new URL(provenance?.sourceURL); } catch { return false; }
  const observedHttp = provenance?.kind !== 'browser_http_observed' || (
    ['Document', 'Fetch', 'XHR', 'Script', 'Stylesheet', 'Image', 'Media', 'Font', 'Manifest',
      'TextTrack', 'EventSource', 'Other', 'Ping', 'Preflight'].includes(provenance.resourceType) &&
    provenance.requestResponsePaired === true && provenance.truncated === false &&
    validTime(provenance.capturedAt) && SHA256.test(provenance.sourceSha256 ?? '') &&
    source.origin === entry.origin && source.pathname === entry.path
  );
  const anonymousRequest = (request, spec) => request?.anonymous === true && request?.cookieSent !== true &&
    request?.credentialsUsed !== true && http(request, spec.method ?? 'GET', spec.path, spec.acceptedStatuses === undefined ? 200 : null, spec.origin) &&
    (spec.acceptedStatuses === undefined || spec.acceptedStatuses.includes(request.httpStatus)) &&
    request.mime === (spec.mime ?? 'application/json') &&
    Number.isInteger(request.responseBytes) && request.responseBytes > 0;
  // Direct HTTP is independently observable. Bind its semantic projection and
  // actual CLI result; this does not assert a browser/CDP capture.
  const directHttp = provenance?.kind !== 'direct_http_observed' || (
    source.origin === entry.origin && source.pathname === entry.path && !source.search && !source.hash &&
    ['html_document', 'xml_sitemap'].includes(provenance.responseFormat) &&
    (provenance.responseFormat === 'html_document' ? receipt?.request?.mime === 'text/html'
      : ['application/xml', 'text/xml', 'application/gzip', 'application/x-gzip'].includes(receipt?.request?.mime)) &&
    execution?.schema === 'web-api-overseas-retail-result-v1' && execution.service === entry.service &&
    execution.ok === true && execution.executionMode === 'pure_http' && execution.browserUsed === false &&
    execution.credentialsUsed === false && execution.anonymous === true && execution.writesSubmitted === 0 &&
    execution.fiveStates?.captured === false && execution.fiveStates?.live_replay === true &&
    object(execution.data) && SHA256.test(provenance.projectionSha256 ?? '') &&
    createHash('sha256').update(JSON.stringify(execution.data)).digest('hex') === provenance.projectionSha256 &&
    Array.isArray(execution.requests) && execution.requests.some(request =>
      anonymousRequest(request, entry) && JSON.stringify(request) === JSON.stringify(receipt.request)) &&
    Number.isInteger(receipt.resultCount) && receipt.resultCount > 0 &&
    receipt.resultCount === (execution.data.products ?? execution.data.items)?.length
  );
  return receipt?.schema === 'web-api-public-read-receipt-v1' && receipt.service === entry.service &&
    receipt.capabilityId === cap.id && validTime(receipt.checkedAt) &&
    receipt.secretsPersistedInEvidence === false && receipt.anonymous === true &&
    receipt.credentialsUsed === false && receipt.authenticated !== true &&
    receipt.schemaVerified === true && receipt.expectedResultVerified === true &&
    anonymousRequest(receipt.request, entry) &&
    (entry.companionReads ?? []).every(spec => Object.hasOwn(receipt, spec.key) && anonymousRequest(receipt[spec.key], spec)) &&
    ['browser_xhr_observed', 'browser_http_observed', 'direct_http_observed', 'first_party_documented_api', 'first_party_documented_feed', 'first_party_bundle_contract'].includes(provenance?.kind) &&
    observedHttp && directHttp &&
    (provenance.kind !== 'first_party_bundle_contract' || SHA256.test(provenance.sourceSha256 ?? '')) &&
    source.protocol === 'https:' && !source.username && !source.password;
}

function anonymousSessionHttpRead([receipt], entry, cap) {
  const bootstrap = receipt?.bootstrapRequest;
  const request = receipt?.request;
  const provenance = receipt?.contractProvenance;
  const bootstrapProvenance = receipt?.bootstrapContractProvenance;
  const safeCookieNames = names => Array.isArray(names) && names.length > 0 &&
    names.every(name => typeof name === 'string' && OLIVEYOUNG_ANONYMOUS_COOKIES.has(name)) &&
    new Set(names).size === names.length;
  const liveHtmlRead = (value, route) => http(value, 'GET', route, 200, OLIVEYOUNG_KR) &&
    value.mime === 'text/html' && Number.isInteger(value.responseBytes) && value.responseBytes > 0 &&
    SHA256.test(value.responseSha256 ?? '') && value.anonymous === true &&
    value.credentialsUsed === false && value.browserUsed === false && value.inputCookiesAccepted === false;
  const issuedNames = bootstrap?.issuedCookieNames;
  const sentNames = request?.sentCookieNames;
  const products = receipt?.rankingResult?.products;
  const hasSemanticTopTen = Array.isArray(products) && products.length >= 10 &&
    products.slice(0, 10).every((product, index) => product?.rank === index + 1 &&
      typeof product.productId === 'string' && product.productId.length > 0 &&
      typeof product.title === 'string' && product.title.trim().length > 0 &&
      typeof product.price?.amount === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(product.price.amount) &&
      product.price.currency === 'KRW') &&
    new Set(products.slice(0, 10).map(product => product.productId)).size === 10;
  const containsSensitiveMaterial = value => {
    if (Array.isArray(value)) return value.some(containsSensitiveMaterial);
    if (!object(value)) return false;
    const safeMetadata = new Set(['cookiesent', 'cookienames', 'issuedcookienames', 'sentcookienames', 'inputcookiesaccepted']);
    return Object.entries(value).some(([key, item]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const carriesSensitiveTransportData = !safeMetadata.has(normalizedKey) &&
        /cookie|authorization|token|sessionid|csrf|headers|rawrequest|rawresponse/.test(normalizedKey);
      return carriesSensitiveTransportData || containsSensitiveMaterial(item);
    });
  };
  const hasInvalidCookieNameLists = (value, parentKey = '') => {
    if (Array.isArray(value) || !object(value)) return false;
    return Object.entries(value).some(([key, names]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (['cookienames', 'issuedcookienames', 'sentcookienames'].includes(normalizedKey)) {
        const allowEmptyBootstrapMetadata = normalizedKey === 'cookienames' && parentKey === 'bootstraprequest' &&
          value.cookieSent === false;
        if (!Array.isArray(names) || (!names.length && !allowEmptyBootstrapMetadata) ||
            names.some(name => typeof name !== 'string' || !OLIVEYOUNG_ANONYMOUS_COOKIES.has(name)) ||
            new Set(names).size !== names.length) return true;
      }
      return hasInvalidCookieNameLists(names, normalizedKey);
    });
  };

  return receipt?.schema === 'web-api-anonymous-session-read-receipt-v1' &&
    receipt.service === 'oliveyoung-public' && entry.service === 'oliveyoung-public' &&
    receipt.capabilityId === cap.id && cap.id === 'ranking.top_products' &&
    validTime(receipt.checkedAt) && receipt.secretsPersistedInEvidence === false &&
    receipt.anonymous === true && receipt.credentialsUsed === false && receipt.authenticated === false &&
    receipt.browserUsed === false && receipt.schemaVerified === true && receipt.expectedResultVerified === true &&
    receipt.sourceFormat === 'html_document' && receipt.isXhr === false &&
    !containsSensitiveMaterial(receipt) && !hasInvalidCookieNameLists(receipt) &&
    provenance?.kind === 'first_party_bundle_contract' &&
    provenance.sourceURL === OLIVEYOUNG_BEST_BUNDLE && provenance.sourceSha256 === OLIVEYOUNG_BEST_BUNDLE_SHA256 &&
    bootstrapProvenance?.kind === 'server_response_observed' &&
    bootstrapProvenance.sourceURL === OLIVEYOUNG_BEST_PAGE &&
    bootstrapProvenance.sourceSha256 === bootstrap?.responseSha256 &&
    liveHtmlRead(bootstrap, '/store/main/main.do') && bootstrap.cookieSent === false &&
    safeCookieNames(issuedNames) && liveHtmlRead(request, OLIVEYOUNG_BEST_ENDPOINT) &&
    request.cookieSent === true && request.sessionKind === 'server_issued_anonymous' &&
    safeCookieNames(sentNames) && sentNames.every(name => issuedNames.includes(name)) &&
    Date.parse(bootstrap.checkedAt) < Date.parse(request.checkedAt) &&
    bootstrap.origin === OLIVEYOUNG_KR && request.origin === bootstrap.origin &&
    receipt.rankingResult?.verified === true && Number.isInteger(receipt.rankingResult.count) &&
    receipt.rankingResult.count >= 10 && hasSemanticTopTen;
}

function credentialedHttpRead([receipt], entry, cap) {
  let source;
  try { source = new URL(receipt?.contractProvenance?.sourceURL); } catch { return false; }
  const credentialedRequest = (request, spec) => request?.credentialsUsed === true &&
    http(request, spec.method ?? 'GET', spec.path, 200, spec.origin) &&
    request.mime === (spec.mime ?? 'application/json') && Number.isInteger(request.responseBytes) && request.responseBytes > 0;
  return receipt?.schema === 'web-api-credentialed-read-receipt-v1' && receipt.service === entry.service &&
    receipt.capabilityId === cap.id && validTime(receipt.checkedAt) && receipt.secretsPersistedInEvidence === false &&
    receipt.authenticated === true && receipt.credentialsUsed === true && receipt.anonymous !== true &&
    receipt.credentialBindingVerified === true && receipt.schemaVerified === true && receipt.expectedResultVerified === true &&
    checks(receipt.credentialBinding, { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false }) &&
    credentialedRequest(receipt.request, entry) &&
    (entry.companionReads ?? []).every(spec => Object.hasOwn(receipt, spec.key) && credentialedRequest(receipt[spec.key], spec)) &&
    ['first_party_documented_api', 'first_party_documented_feed', 'browser_xhr_observed'].includes(receipt.contractProvenance?.kind) &&
    source.protocol === 'https:' && !source.username && !source.password;
}

// A public browsing session is not an authenticated account or owner proof.
// Keep this narrow to the observed Amazon product document and native wire receipt.
function amazonProductSessionRead([receipt, execution], entry, cap) {
  const product = execution?.data, request = product?.receipt;
  const semantics = {
    'catalog.product': Boolean(product?.title),
    'catalog.description': Boolean(product?.description) && Array.isArray(product?.features) && product.features.length > 0,
    'catalog.options': Array.isArray(product?.dimensions) && product.dimensions.length > 0
      && product.dimensions.every(d => Array.isArray(d.choices) && d.choices.length > 0
        && d.choices.every(c => /^[A-Z0-9]{10}$/.test(c.asin ?? '') && typeof c.label === 'string' && c.label
          && c.priceVerified === false && c.stockVerified === false)),
    'catalog.observed_images': Array.isArray(product?.images) && product.images.length > 0 && product.coverage?.completeGallery === false,
    'catalog.displayed_offer': product?.displayedPrice?.currencyVerified === true && Boolean(product?.availability?.displayText),
  };
  return receipt?.schema === 'web-api-amazon-session-read-receipt-v1' && entry.service === 'amazon'
    && receipt.service === 'amazon' && receipt.capabilityId === cap.id && semantics[cap.id] === true
    && validTime(receipt.checkedAt) && receipt.secretsPersistedInEvidence === false
    && receipt.authenticated === false && receipt.credentialProvider === 'protected_store'
    && receipt.initialBootstrap === 'browser_observed_public_session' && receipt.sessionRenewalVerified === false
    && entry.origin === 'https://www.amazon.com' && entry.method === 'GET' && entry.mime === 'text/html'
    && /^[A-Z0-9]{10}$/.test(product?.asin ?? '') && entry.path === `/-/ko/dp/${product.asin}/`
    && product.productUrl === entry.origin + entry.path && product.coverage?.identityVerified === true
    && execution.schema === 'web-api-retail-result-v1' && execution.service === 'amazon' && execution.operation === 'product'
    && execution.ok === true && execution.executionMode === 'pure_http' && execution.browserUsed === false
    && execution.credentialsUsed === true && execution.anonymous === false
    && http(request, 'GET', entry.path, 200, entry.origin) && request.mime === 'text/html'
    && request.readOnly === true && request.cookieSent === true && request.credentialsUsed === true
    && request.cookieHeaderMatchedOnWire === true && request.credentialPropagated === true
    && request.schemaVerified === true && request.expectedResultVerified === true && request.sessionPersisted === true
    && request.authenticationVerified === false && request.sessionRenewalVerified === false
    && Number.isInteger(request.responseBytes) && request.responseBytes > 0 && SHA256.test(request.responseSha256 ?? '')
    && receipt.requestSha256 === createHash('sha256').update(JSON.stringify(request)).digest('hex')
    && receipt.projectionSha256 === createHash('sha256').update(JSON.stringify(product)).digest('hex');
}

function commerceCollection([proof, sample], entry, cap) {
  const offers = sample?.offers;
  const request = proof?.sourceRequest;
  return proof?.schema === 'web-api-commerce-collection-proof-v1' && proof.service === entry.service && proof.capabilityId === cap.id &&
    validTime(proof.checkedAt) && proof.secretsPersistedInEvidence === false &&
    proof.executionMode === 'pure_http' && proof.browserUsed === false && proof.credentialsUsed === false &&
    http(request, 'GET', entry.path, 200, entry.origin) && request.anonymous === true &&
    request.credentialsUsed !== true && request.mime === entry.mime && Number.isInteger(request.responseBytes) && request.responseBytes > 0 &&
    sample?.schema === 'web-api-product-price-snapshot-v1' && sample.executionMode === 'pure_http' &&
    Array.isArray(offers) && offers.length > 0 && proof.sampleOfferCount === offers.length &&
    offers.every(offer => offer?.schema === 'web-api-product-offer-v1' &&
      typeof offer.title === 'string' && offer.title.length > 0 && (offer.productId || offer.variantId) &&
      typeof offer.price?.amount === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(offer.price.amount) &&
      /^[A-Z]{3}$/.test(offer.price.currency ?? '') && validTime(offer.observedAt)) &&
    proof.jsonReadbackMatched === true && proof.csvReadbackMatched === true &&
    Number.isInteger(proof.fullOfferCount) && proof.fullOfferCount >= offers.length && proof.fullOfferCount === proof.csvDataRows &&
    SHA256.test(proof.fullJsonSha256 ?? '') && SHA256.test(proof.fullCsvSha256 ?? '') &&
    proof.actualRunner?.entrypoint === 'scripts/commerce.mjs' && proof.actualRunner.exitStatus === 0;
}

function genericHttpWrite([receipt], entry, cap) {
  const write = receipt?.writeReceipt;
  const read = receipt?.readback;
  return receipt?.schema === 'web-api-capability-receipt-v1' && receipt.service === entry.service &&
    receipt.capabilityId === cap.id && validTime(receipt.checkedAt) &&
    receipt.secretsPersistedInEvidence === false && receipt.authenticated === true &&
    receipt.ownerVerified === true && receipt.writeSent === true && receipt.postAttempts === 1 &&
    SHA256.test(receipt.beforeHash ?? '') && SHA256.test(receipt.afterHash ?? '') &&
    receipt.beforeHash !== receipt.afterHash &&
    http(write, entry.method, entry.path, null, entry.origin, true) &&
    (entry.acceptedStatuses === undefined || entry.acceptedStatuses.includes(write.httpStatus)) &&
    http(read, 'GET', entry.readbackPath, 200, entry.origin, true) && read.ownerMatched === true &&
    read.fieldsMatched === true && read.stateChanged === true &&
    Array.isArray(read.matchedFields) && read.matchedFields.length > 0 &&
    Date.parse(read.checkedAt) >= Date.parse(write.checkedAt);
}

const validators = { 'inpock-auth-v1': inpockAuth, 'inpock-inventory-v1': inpockInventory,
  'inpock-profile-read-v1': inpockProfileRead,
  'inpock-publication-v1': inpockPublication, 'http-read-v1': genericHttpRead,
  'http-public-read-v1': publicHttpRead,
  'http-anonymous-session-read-v1': anonymousSessionHttpRead,
  'http-credentialed-read-v1': credentialedHttpRead,
  'amazon-product-session-read-v1': amazonProductSessionRead,
  'commerce-collection-v1': commerceCollection,
  'http-write-v1': genericHttpWrite };

async function hashFreshness(root, receipts, hashPaths) {
  if (!hashPaths?.length) return { state: 'untracked', mismatches: [] };
  const mismatches = [];
  for (const file of hashPaths) {
    const expected = receipts.map(item => item?.implementation?.[file]).find(value => SHA256.test(value ?? ''));
    if (!expected) { mismatches.push({ path: file, reason: 'hash_missing' }); continue; }
    const raw = await safeRead(root, file);
    if (raw === null) { mismatches.push({ path: file, reason: 'file_missing' }); continue; }
    const actual = createHash('sha256').update(raw).digest('hex');
    if (actual !== expected) mismatches.push({ path: file, reason: 'code_changed' });
  }
  return { state: mismatches.length ? 'stale' : 'current_code', mismatches };
}

async function evidenceInventory(root, cap, service) {
  const reports = [];
  for (const entry of cap.evidence) {
    if (!validators[entry.kind]) { reports.push({ kind: entry.kind, state: 'invalid', reason: 'unknown_validator' }); continue; }
    try {
      const receipts = [];
      for (const file of entry.files) receipts.push(await safeRead(root, file, { json: true }));
      if (receipts.some(value => value === null)) { reports.push({ kind: entry.kind, state: 'missing', files: entry.files }); continue; }
      const valid = validators[entry.kind](receipts, { ...entry, service }, cap);
      if (!valid) { reports.push({ kind: entry.kind, state: 'invalid', files: entry.files, reason: 'receipt_contract_failed' }); continue; }
      const freshness = await hashFreshness(root, receipts, entry.hashPaths);
      reports.push({ kind: entry.kind, state: freshness.state === 'current_code' ? 'recorded_live' : 'historical',
        files: entry.files, checkedAt: receipts[0].checkedAt ?? receipts[0].profileRead?.receipt?.checkedAt ?? null, freshness });
    } catch (error) { reports.push({ kind: entry.kind, state: 'invalid', files: entry.files, reason: error.message }); }
  }
  const source = [];
  for (const entry of cap.sourceEvidence) {
    try {
      const receipts = [];
      for (const file of entry.files) receipts.push(await safeRead(root, file, { json: true }));
      const present = receipts.every(value => value !== null);
      const candidate = present && receipts.every(value =>
        value?.schema === 'inpock-feature-discovery-v1' &&
        Array.isArray(value.sourceCandidateContracts) && value.sourceCandidateContracts.some(item =>
          item.evidence_level === 'public_source_candidate_not_replayed') ||
        value?.schema === 'web-api-source-candidate-v1' && value.classification === 'source_candidate' &&
        Array.isArray(value.contracts) && value.contracts.length > 0 &&
        value.contracts.every(item => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(item?.method) &&
          typeof item.path === 'string' && item.path.startsWith('/')));
      source.push({ files: entry.files, state: !present ? 'missing' : candidate ? 'source_candidate' : 'invalid' });
    } catch (error) { source.push({ files: entry.files, state: 'invalid', reason: error.message }); }
  }
  return { reports, source };
}

export async function auditCapabilityChecklist({ root, service, testResults = null } = {}) {
  if (typeof root !== 'string' || !ID.test(service ?? '')) throw new Error('CHECKLIST_INPUT_INVALID');
  const manifest = assertManifest(await safeRead(root, `checklists/services/${service}.json`, { json: true }));
  if (manifest.service !== service) throw new Error('CHECKLIST_SERVICE_MISMATCH');
  const capabilities = [];
  for (const cap of manifest.capabilities) {
    const code = await codeInventory(root, cap);
    const evidence = await evidenceInventory(root, cap, service);
    const live = evidence.reports.find(item => item.state === 'recorded_live');
    const historical = evidence.reports.find(item => item.state === 'historical');
    const invalid = evidence.reports.find(item => item.state === 'invalid');
    const source = evidence.source.some(item => item.state === 'source_candidate');
    const test = testResults?.[cap.id] ?? 'not_run';
    let status;
    if (cap.applicability === 'not_applicable') status = 'not_applicable';
    else if (cap.applicability === 'unknown') status = 'scope_unknown';
    else if (code.state === 'missing') status = source ? 'source_candidate' : 'unimplemented';
    else if (code.state !== 'present') status = 'partial_implementation';
    else if (test === 'failed') status = 'test_failed';
    else if (cap.requirement === 'inventory') status = 'code_inventory';
    else if (cap.requirement === 'local') status = test === 'passed' ? 'verified_local' : 'pending_local_test';
    else if (live) status = 'recorded_live';
    else if (historical) status = 'needs_reverification';
    else if (invalid) status = 'evidence_invalid';
    else status = cap.blocker ? 'blocked' : 'pending_live';
    const gatePassed = cap.priority !== 'required' || cap.applicability === 'not_applicable' ||
      (cap.requirement === 'live' ? status === 'recorded_live' : cap.requirement === 'local' ? status === 'verified_local' : status === 'code_inventory');
    capabilities.push({ id: cap.id, title: cap.title, priority: cap.priority, applicability: cap.applicability,
      requirement: cap.requirement, status, gatePassed, code, test, evidence,
      ...(cap.applicabilityReason ? { applicabilityReason: cap.applicabilityReason } : {}),
      ...(cap.blocker ? { blocker: cap.blocker } : {}), ...(cap.note ? { note: cap.note } : {}) });
  }
  const requiredGaps = capabilities.filter(cap => cap.priority === 'required' && !cap.gatePassed).map(cap => cap.id);
  return { schema: 'web-api-capability-audit-v1', service, checkedAt: new Date().toISOString(),
    networkUsed: testResults === null ? false : 'not_measured',
    credentialsUsed: testResults === null ? false : 'not_measured',
    mutationsSent: testResults === null ? false : 'not_measured',
    testsExecuted: testResults !== null, capabilities,
    summary: { total: capabilities.length, recordedLive: capabilities.filter(cap => cap.status === 'recorded_live').length,
      needsReverification: capabilities.filter(cap => cap.status === 'needs_reverification').length,
      requiredGaps, strictPassed: requiredGaps.length === 0 } };
}

export function renderCapabilityMarkdown(audits) {
  const lines = ['# Web API capability checklist', '', '오프라인 코드·영수증 감사입니다. recorded_live는 기록 시점의 실증이며 현재 원격 상태 재조회가 아닙니다.', ''];
  for (const audit of audits) {
    lines.push(`## ${audit.service}`, '', '| 기능 | 우선순위 | 코드 | 실증/상태 |', '|---|---|---|---|');
    for (const cap of audit.capabilities) lines.push(`| ${cap.id} — ${cap.title.replaceAll('|', '\\|')} | ${cap.priority} | ${cap.code.state} | ${cap.status} |`);
    lines.push('', `필수 미충족: ${audit.summary.requiredGaps.length ? audit.summary.requiredGaps.join(', ') : '없음'}`, '');
  }
  return lines.join('\n');
}
