#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditCapabilityChecklist, safeRelativePath } from '../lib/capability-checklist.mjs';
import { verifyManifestImplementation } from '../lib/recorded-evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = 'verification/kmong-auth-2026-10-26/';
const REQUIRED_ARTIFACTS = [
  'kmong-auth-owner-proof.json',
  'kmong-auth-reuse-proof.json',
  'kmong-auth-bootstrap-context.json',
];
const AUTH_RUNTIME_PATHS = [
  'lib/web-auth/kmong.mjs',
  'scripts/kmong-account.mjs',
  'lib/protected-store.mjs',
  'lib/scoped-session.mjs',
  'lib/session-lock.mjs',
  'lib/cli.mjs',
  'scripts/dpapi-store.ps1',
  'package.json',
  'package-lock.json',
];
const VERIFICATION_METADATA_PATHS = Object.freeze({
  'scripts/verify-kmong-auth.mjs': 'offline_verifier',
  'lib/capability-checklist.mjs': 'evidence_validator',
  'checklists/services/kmong.json': 'checklist_metadata',
});
const REQUIRED_IMPLEMENTATION = [
  ...AUTH_RUNTIME_PATHS,
  ...Object.keys(VERIFICATION_METADATA_PATHS),
];
const AUTH_HASH_PATHS = [
  'lib/web-auth/kmong.mjs',
  'scripts/kmong-account.mjs',
  'lib/protected-store.mjs',
  'lib/scoped-session.mjs',
  'lib/session-lock.mjs',
];
const CHECKLIST_BINDINGS = Object.freeze({
  'auth.owner': 'kmong-auth-owner-proof.json',
  'auth.reuse': 'kmong-auth-reuse-proof.json',
});
const OWNER_READ_ORIGIN = 'https://kmong.com';
const OWNER_READ_PATH = '/api/user/v3/me';
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };

function exactObject(value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function assertTime(value, label) {
  assert.ok(ISO(value), `${label} must be an ISO timestamp`);
}

function assertNoSecrets(value, label = 'value') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(?:cookie|cookies|cookieValue|authorization|accessToken|refreshToken|apiKey|password|expectedEmail|email|USERID|userId|ownerId|rawBody|rawHtml|storageState|secret)$/i.test(key),
      `Sensitive field ${label}.${key}`);
    if (typeof child === 'string') {
      assert.ok(!/[?&](?:access_token|__cf_chl_rt_tk|api_key)=/i.test(child), `Sensitive URL at ${label}.${key}`);
      assert.ok(!/(?:Bearer\s+|x-kmong-authorization\s*[:=])/i.test(child), `Credential-like value at ${label}.${key}`);
    }
    assertNoSecrets(child, `${label}.${key}`);
  }
}

function validateOwnerRequest(request, label = 'request') {
  exactObject(request, label);
  assert.equal(request.method, 'GET');
  assert.equal(request.origin, 'https://kmong.com');
  assert.equal(request.path, '/api/user/v3/me');
  assert.equal(request.httpStatus, 200);
  assert.equal(request.mime, 'application/json');
  assert.ok(Number.isSafeInteger(request.responseBytes) && request.responseBytes > 0);
  assertTime(request.checkedAt, `${label}.checkedAt`);
  assert.equal(request.browserUsed, false);
  assert.equal(request.ownerMatched, true);
  assert.equal(request.readOnly, true);
  assert.equal(request.credentialsUsed, true);
  assert.equal(request.cookiesSent, true);
  if (request.responseSha256 !== undefined) assert.match(request.responseSha256, SHA256);
  return request;
}

function validateGenericOwnerProof(proof, capabilityId) {
  exactObject(proof, `${capabilityId} proof`);
  assert.equal(proof.schema, 'web-api-capability-receipt-v1');
  assert.equal(proof.service, 'kmong');
  assert.equal(proof.capabilityId, capabilityId);
  assertTime(proof.checkedAt, `${capabilityId}.checkedAt`);
  assert.equal(proof.secretsPersistedInEvidence, false);
  assert.equal(proof.authenticated, true);
  assert.equal(proof.ownerVerified, true);
  assert.equal(proof.ownerIdPinned, true);
  assert.equal(proof.expectedEmailMatched, true);
  assert.equal(proof.credentialProvider, 'Windows DPAPI CurrentUser');
  assert.equal(proof.persistent, true);
  assert.equal(proof.bootstrapMode, 'manual_browser_cookie_import');
  assert.equal(proof.readMode, 'pure_http');
  assert.equal(proof.browserUsed, false);
  assert.equal(proof.automatedLoginPosts, 0);
  assert.equal(proof.renewal, 'not_implemented');
  validateOwnerRequest(proof.request, `${capabilityId}.request`);
  assert.ok(Date.parse(proof.checkedAt) >= Date.parse(proof.request.checkedAt));
  exactObject(proof.implementation, `${capabilityId}.implementation`);
  assert.deepEqual(Object.keys(proof.implementation).sort(), [...AUTH_HASH_PATHS].sort(),
    `${capabilityId} implementation paths must exactly match the recorded owner proof`);
  for (const relative of AUTH_HASH_PATHS) assert.match(proof.implementation[relative] ?? '', SHA256,
    `${capabilityId} missing implementation hash: ${relative}`);
  assertNoSecrets(proof, capabilityId);
  return proof;
}

export function validateKmongAuthOwnerProof(proof) {
  return validateGenericOwnerProof(proof, 'auth.owner');
}

export function validateKmongAuthReuseProof(proof) {
  validateGenericOwnerProof(proof, 'auth.reuse');
  exactObject(proof.reuse, 'auth.reuse.reuse');
  const reuse = proof.reuse;
  assert.equal(reuse.schema, 'web-api-kmong-auth-reuse-v1');
  assert.equal(reuse.credentialProvider, 'Windows DPAPI CurrentUser');
  assert.equal(reuse.persistent, true);
  assert.equal(reuse.ownerIdPinned, true);
  assert.equal(reuse.sameOwnerAcrossProcesses, true);
  assert.equal(reuse.initialSessionImportCount, 1);
  assert.equal(reuse.sessionImportsDuringReuse, 0);
  assert.equal(reuse.automatedLoginPosts, 0);
  assert.equal(reuse.refreshAttempts, 0);
  assert.equal(reuse.browserUsed, false);
  assert.ok(Array.isArray(reuse.runs) && reuse.runs.length >= 2);
  const processIds = new Set();
  let priorTime = -Infinity;
  for (let index = 0; index < reuse.runs.length; index++) {
    const run = reuse.runs[index];
    exactObject(run, `reuse.runs[${index}]`);
    assert.ok(Number.isSafeInteger(run.processId) && run.processId > 0);
    processIds.add(run.processId);
    assert.ok(['owner', 'verify'].includes(run.command));
    assert.equal(run.freshProcess, true);
    assertTime(run.checkedAt, `reuse.runs[${index}].checkedAt`);
    assert.ok(Date.parse(run.checkedAt) > priorTime, 'Owner reuse reads must be ordered');
    priorTime = Date.parse(run.checkedAt);
    assert.equal(run.authenticated, true);
    assert.equal(run.ownerVerified, true);
    assert.equal(run.expectedEmailMatched, true);
    assert.equal(run.ownerIdPinned, true);
    assert.equal(run.credentialProvider, 'Windows DPAPI CurrentUser');
    assert.equal(run.persistent, true);
    assert.equal(run.sessionImportDuringProcess, false);
    assert.equal(run.loginPostsSent, 0);
    validateOwnerRequest(run.request, `reuse.runs[${index}].request`);
  }
  assert.equal(processIds.size, reuse.runs.length, 'Reuse reads must come from distinct processes');
  assert.deepEqual(proof.request, reuse.runs.at(-1).request, 'Generic proof must bind the final fresh-process read');
  assert.equal(proof.checkedAt, reuse.runs.at(-1).checkedAt);
  assertNoSecrets(reuse, 'auth.reuse.reuse');
  return proof;
}

export function validateKmongBootstrapContext(context) {
  exactObject(context, 'bootstrap context');
  assert.equal(context.schema, 'web-api-kmong-bootstrap-context-v1');
  assert.equal(context.service, 'kmong');
  assertTime(context.recordedAt, 'bootstrapContext.recordedAt');
  assert.equal(context.host, '10.157.140.228');
  assert.equal(context.secretsPersistedInEvidence, false);
  assert.equal(context.browserUsedForRecordedCliReads, false);
  assert.equal(context.automaticOAuthImplemented, false);
  assert.equal(context.automaticRefreshImplemented, false);
  assert.ok(Array.isArray(context.phases));
  const phases = new Map(context.phases.map(phase => [phase.name, phase]));
  for (const name of ['google_login', 'google_2fa', 'kmong_oauth_return', 'buyer_signup']) {
    const phase = phases.get(name);
    exactObject(phase, `bootstrap phase ${name}`);
    assert.equal(phase.mode, 'browser_automation');
    assert.equal(phase.outcome, 'completed');
  }
  assert.equal(phases.get('google_login').provider, 'Google');
  assert.equal(phases.get('buyer_signup').optionalPrivacyConsent, false);
  assert.equal(phases.get('buyer_signup').optionalMarketingConsent, false);
  assert.equal(phases.get('buyer_signup').phoneKycPerformed, false);
  const ownerProbe = phases.get('browser_owner_probe');
  if (ownerProbe !== undefined) {
    exactObject(ownerProbe, 'bootstrap phase browser_owner_probe');
    assert.equal(ownerProbe.mode, 'browser_automation');
    assert.equal(ownerProbe.outcome, 'completed');
    assert.equal(ownerProbe.method, 'GET');
    assert.equal(ownerProbe.origin, 'https://kmong.com');
    assert.equal(ownerProbe.path, '/api/user/v3/me');
    assert.ok(Array.isArray(ownerProbe.statuses) && ownerProbe.statuses.includes(200));
    assert.equal(ownerProbe.ownerMatched, true);
  }
  assertNoSecrets(context, 'bootstrapContext');
  return context;
}

async function readSafe(root, relative, maxBytes = 4 * 1024 * 1024) {
  assert.ok(safeRelativePath(relative), `Unsafe path: ${relative}`);
  const rootReal = await realpath(root);
  const target = path.join(rootReal, relative);
  const targetReal = await realpath(target);
  assert.ok(targetReal.startsWith(rootReal + path.sep), `Path escaped root: ${relative}`);
  const info = await stat(targetReal);
  assert.ok(info.isFile() && info.size <= maxBytes, `File invalid: ${relative}`);
  return readFile(targetReal);
}

async function readJson(root, relative) {
  const bytes = await readSafe(root, relative);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail('KMONG_AUTH_EVIDENCE_JSON_INVALID', `Invalid JSON: ${relative}`); }
  return { value, bytes };
}

function relativeToEvidence(name) {
  assert.ok(typeof name === 'string' && name === path.posix.basename(name) && safeRelativePath(name),
    'Artifact names must be simple basenames');
  return EVIDENCE_DIR + name;
}

function assertAuthChecklistBindings(manifest) {
  exactObject(manifest, 'checklist manifest');
  assert.equal(manifest.service, 'kmong');
  assert.ok(Array.isArray(manifest.capabilities));
  for (const [capabilityId, artifact] of Object.entries(CHECKLIST_BINDINGS)) {
    const matching = manifest.capabilities.filter(capability => capability?.id === capabilityId);
    if (matching.length !== 1) fail('KMONG_AUTH_CHECKLIST_BINDING_INVALID', `${capabilityId} must appear once`);
    const capability = matching[0];
    const expected = [{
      kind: 'http-read-v1',
      origin: OWNER_READ_ORIGIN,
      path: OWNER_READ_PATH,
      files: [EVIDENCE_DIR + artifact],
      hashPaths: AUTH_HASH_PATHS,
    }];
    try {
      assert.equal(capability.requirement, 'live');
      assert.equal(capability.applicability, 'applicable');
      assert.deepEqual(capability.evidence, expected);
      assert.deepEqual(capability.sourceEvidence, []);
    } catch {
      fail('KMONG_AUTH_CHECKLIST_BINDING_INVALID', `${capabilityId} must retain its exact recorded proof and hash paths`);
    }
  }
  return manifest;
}

export async function verifyKmongAuthEvidence({ root = ROOT } = {}) {
  const { value: manifest } = await readJson(root, EVIDENCE_DIR + 'manifest.json');
  exactObject(manifest, 'auth manifest');
  assert.equal(manifest.schema, 'web-api-kmong-auth-verification-v1');
  assertTime(manifest.recordedAt, 'manifest.recordedAt');
  assert.match(manifest.baseCommit ?? '', /^[a-f0-9]{40}$/);
  exactObject(manifest.implementation, 'manifest.implementation');
  exactObject(manifest.artifacts, 'manifest.artifacts');
  assert.deepEqual(Object.keys(manifest.implementation).sort(), [...REQUIRED_IMPLEMENTATION].sort(),
    'Historical manifest implementation paths must retain the exact runtime and metadata inventory');
  for (const relative of REQUIRED_IMPLEMENTATION) assert.match(manifest.implementation[relative] ?? '', SHA256,
    `Manifest missing implementation hash: ${relative}`);
  for (const name of REQUIRED_ARTIFACTS) assert.match(manifest.artifacts[name] ?? '', SHA256,
    `Manifest missing artifact hash: ${name}`);
  const implementation = await verifyManifestImplementation({
    implementation: manifest.implementation,
    readFile: relative => readSafe(root, relative, 64 * 1024 * 1024),
    sha256: sha,
    verificationToolKinds: VERIFICATION_METADATA_PATHS,
  });

  const artifacts = {};
  const digests = {};
  for (const name of REQUIRED_ARTIFACTS) {
    const relative = relativeToEvidence(name);
    const { value, bytes } = await readJson(root, relative);
    assert.equal(sha(bytes), manifest.artifacts[name], `Artifact changed: ${name}`);
    assertNoSecrets(value, name);
    artifacts[name] = value;
    digests[name] = manifest.artifacts[name];
  }
  const owner = validateKmongAuthOwnerProof(artifacts['kmong-auth-owner-proof.json']);
  const reuse = validateKmongAuthReuseProof(artifacts['kmong-auth-reuse-proof.json']);
  const bootstrap = validateKmongBootstrapContext(artifacts['kmong-auth-bootstrap-context.json']);
  const checklistFile = await readJson(root, 'checklists/services/kmong.json');
  const checklistManifest = assertAuthChecklistBindings(checklistFile.value);
  for (const proof of [owner, reuse]) {
    for (const [relative, hash] of Object.entries(proof.implementation ?? {})) {
      assert.equal(manifest.implementation[relative], hash, `Proof/runtime hash mismatch: ${relative}`);
    }
  }
  const checklist = await auditCapabilityChecklist({ root, service: 'kmong' });
  const statusOf = id => checklist.capabilities.find(capability => capability.id === id)?.status;
  assert.equal(statusOf('auth.owner'), 'recorded_live');
  assert.equal(statusOf('auth.reuse'), 'recorded_live');
  assert.equal(statusOf('auth.browser_bootstrap'), 'code_inventory');
  assertAuthChecklistBindings(checklistManifest);
  return {
    ok: true,
    verification: 'historical_kmong_auth_evidence_revalidated_offline',
    recordedAt: manifest.recordedAt,
    checkedAt: new Date().toISOString(),
    networkUsed: false,
    liveCheckedNow: false,
    host: bootstrap.host,
    sourceCommit: manifest.baseCommit,
    capabilities: {
      owner: statusOf('auth.owner'),
      reuse: statusOf('auth.reuse'),
      browserBootstrap: statusOf('auth.browser_bootstrap'),
    },
    reuse: {
      processCount: reuse.reuse.runs.length,
      distinctProcessCount: new Set(reuse.reuse.runs.map(run => run.processId)).size,
      provider: reuse.reuse.credentialProvider,
      persistent: reuse.reuse.persistent,
      loginPosts: reuse.reuse.automatedLoginPosts,
    },
    runtimeImplementationHashesMatched: implementation.runtimeImplementationHashesMatched,
    verificationMetadataProvenance: implementation.verificationToolProvenance,
    bootstrap: {
      provider: 'Google',
      phases: bootstrap.phases.map(phase => phase.name),
      browserUsedForRecordedCliReads: bootstrap.browserUsedForRecordedCliReads,
      automaticOAuthImplemented: bootstrap.automaticOAuthImplemented,
      automaticRefreshImplemented: bootstrap.automaticRefreshImplemented,
    },
    artifacts: digests,
    boundaries: {
      credentialsPersistedInEvidence: false,
      browserUsedForRecordedCliReads: false,
      refreshImplemented: false,
      businessWritesImplemented: false,
    },
  };
}

async function main(args = process.argv.slice(2)) {
  assert.equal(args.length, 0, 'This verifier accepts no path, network, or credential arguments');
  const result = await verifyKmongAuthEvidence();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, verification: 'kmong_auth_evidence_invalid',
      networkUsed: false, code: error.code ?? 'KMONG_AUTH_EVIDENCE_INVALID', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}
