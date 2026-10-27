import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyKmongAuthEvidence,
  validateKmongAuthOwnerProof,
  validateKmongAuthReuseProof,
  validateKmongBootstrapContext,
} from '../scripts/verify-kmong-auth.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = 'verification/kmong-auth-2026-10-26';

const implementation = Object.fromEntries([
  'lib/web-auth/kmong.mjs',
  'scripts/kmong-account.mjs',
  'lib/protected-store.mjs',
  'lib/scoped-session.mjs',
  'lib/session-lock.mjs',
].map(file => [file, 'a'.repeat(64)]));

function request(checkedAt) {
  return {
    method: 'GET',
    origin: 'https://kmong.com',
    path: '/api/user/v3/me',
    httpStatus: 200,
    mime: 'application/json',
    responseBytes: 125,
    checkedAt,
    browserUsed: false,
    credentialsUsed: true,
    cookiesSent: true,
    ownerMatched: true,
    readOnly: true,
  };
}

function genericProof(capabilityId, checkedAt) {
  return {
    schema: 'web-api-capability-receipt-v1',
    service: 'kmong',
    capabilityId,
    checkedAt,
    secretsPersistedInEvidence: false,
    authenticated: true,
    ownerVerified: true,
    ownerIdPinned: true,
    expectedEmailMatched: true,
    credentialProvider: 'Windows DPAPI CurrentUser',
    persistent: true,
    bootstrapMode: 'manual_browser_cookie_import',
    readMode: 'pure_http',
    browserUsed: false,
    automatedLoginPosts: 0,
    renewal: 'not_implemented',
    request: request(checkedAt),
    implementation,
  };
}

function reuseProof() {
  const firstAt = '2026-10-26T12:00:00.000Z';
  const secondAt = '2026-10-26T12:02:00.000Z';
  const first = {
    processId: 1820,
    command: 'owner',
    freshProcess: true,
    checkedAt: firstAt,
    authenticated: true,
    ownerVerified: true,
    expectedEmailMatched: true,
    ownerIdPinned: true,
    credentialProvider: 'Windows DPAPI CurrentUser',
    persistent: true,
    sessionImportDuringProcess: false,
    loginPostsSent: 0,
    request: request(firstAt),
  };
  const second = {
    processId: 2924,
    command: 'owner',
    freshProcess: true,
    checkedAt: secondAt,
    authenticated: true,
    ownerVerified: true,
    expectedEmailMatched: true,
    ownerIdPinned: true,
    credentialProvider: 'Windows DPAPI CurrentUser',
    persistent: true,
    sessionImportDuringProcess: false,
    loginPostsSent: 0,
    request: request(secondAt),
  };
  return {
    ...genericProof('auth.reuse', secondAt),
    request: second.request,
    reuse: {
      schema: 'web-api-kmong-auth-reuse-v1',
      credentialProvider: 'Windows DPAPI CurrentUser',
      persistent: true,
      ownerIdPinned: true,
      sameOwnerAcrossProcesses: true,
      initialSessionImportCount: 1,
      sessionImportsDuringReuse: 0,
      automatedLoginPosts: 0,
      refreshAttempts: 0,
      browserUsed: false,
      runs: [first, second],
    },
  };
}

function bootstrapContext() {
  return {
    schema: 'web-api-kmong-bootstrap-context-v1',
    service: 'kmong',
    recordedAt: '2026-10-26T12:05:00.000Z',
    host: '10.157.140.228',
    secretsPersistedInEvidence: false,
    phases: [
      { name: 'google_login', mode: 'browser_automation', provider: 'Google', outcome: 'completed' },
      { name: 'google_2fa', mode: 'browser_automation', outcome: 'completed' },
      { name: 'kmong_oauth_return', mode: 'browser_automation', outcome: 'completed' },
      { name: 'browser_owner_probe', mode: 'browser_automation', outcome: 'completed', method: 'GET',
        origin: 'https://kmong.com', path: '/api/user/v3/me', statuses: [204, 200, 200], ownerMatched: true },
      { name: 'buyer_signup', mode: 'browser_automation', outcome: 'completed',
        optionalPrivacyConsent: false, optionalMarketingConsent: false, phoneKycPerformed: false },
    ],
    browserUsedForRecordedCliReads: false,
    automaticOAuthImplemented: false,
    automaticRefreshImplemented: false,
  };
}

async function isolatedVerifierRoot(t) {
  const temporaryRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch/tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, 'kmong-auth-verifier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(SOURCE_ROOT, EVIDENCE_DIR, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = new Set([
    `${EVIDENCE_DIR}/manifest.json`,
    ...Object.keys(manifest.implementation),
    ...Object.keys(manifest.artifacts).map(name => `${EVIDENCE_DIR}/${name}`),
    'tests/kmong-account.test.mjs',
    'tests/verify-kmong-auth.test.mjs',
  ]);
  for (const relative of files) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(SOURCE_ROOT, relative)));
  }
  return root;
}

async function readChecklist(root) {
  const file = path.join(root, 'checklists/services/kmong.json');
  return { file, checklist: JSON.parse(await readFile(file, 'utf8')) };
}

test('Kmong owner proof accepts one exact protected owner GET without identity values', () => {
  assert.equal(validateKmongAuthOwnerProof(genericProof('auth.owner', '2026-10-26T12:00:00.000Z')).ownerVerified, true);

  const wrongRoute = genericProof('auth.owner', '2026-10-26T12:00:00.000Z');
  wrongRoute.request.path = '/api/user/v3/other';
  assert.throws(() => validateKmongAuthOwnerProof(wrongRoute));

  const falsifiedCookieUse = genericProof('auth.owner', '2026-10-26T12:00:00.000Z');
  falsifiedCookieUse.request.cookiesSent = false;
  assert.throws(() => validateKmongAuthOwnerProof(falsifiedCookieUse));

  const exposedEmail = genericProof('auth.owner', '2026-10-26T12:00:00.000Z');
  exposedEmail.email = 'owner@example.com';
  assert.throws(() => validateKmongAuthOwnerProof(exposedEmail), /Sensitive field/);
});

test('Kmong reuse proof requires separate persistent owner reads and no login/import replay', () => {
  const proof = reuseProof();
  assert.equal(validateKmongAuthReuseProof(proof).reuse.runs.length, 2);

  const sameProcess = structuredClone(proof);
  sameProcess.reuse.runs[1].processId = sameProcess.reuse.runs[0].processId;
  assert.throws(() => validateKmongAuthReuseProof(sameProcess));

  const loginReplay = structuredClone(proof);
  loginReplay.reuse.runs[1].loginPostsSent = 1;
  assert.throws(() => validateKmongAuthReuseProof(loginReplay));

  const memoryOnly = structuredClone(proof);
  memoryOnly.reuse.persistent = false;
  assert.throws(() => validateKmongAuthReuseProof(memoryOnly));
});

test('Kmong bootstrap context keeps manual Google phases and no phone KYC explicit', () => {
  const context = bootstrapContext();
  assert.equal(validateKmongBootstrapContext(context).phases.length, 5);

  const phoneKyc = structuredClone(context);
  phoneKyc.phases.at(-1).phoneKycPerformed = true;
  assert.throws(() => validateKmongBootstrapContext(phoneKyc));

  const autoOauth = structuredClone(context);
  autoOauth.automaticOAuthImplemented = true;
  assert.throws(() => validateKmongBootstrapContext(autoOauth));

  const leakedCookie = structuredClone(context);
  leakedCookie.cookie = 'secret';
  assert.throws(() => validateKmongBootstrapContext(leakedCookie), /Sensitive field/);
});

test('historical verifier rejects changes to any pinned authentication runtime file', async t => {
  const root = await isolatedVerifierRoot(t);
  const runtime = path.join(root, 'lib/web-auth/kmong.mjs');
  await writeFile(runtime, `${await readFile(runtime, 'utf8')}\n// changed authentication runtime\n`);
  await assert.rejects(verifyKmongAuthEvidence({ root }), { code: 'RECORDED_RUNTIME_IMPLEMENTATION_CHANGED' });
});

test('public checklist additions are reported as metadata drift while auth proofs remain recorded_live', async t => {
  const root = await isolatedVerifierRoot(t);
  const { file, checklist } = await readChecklist(root);
  checklist.capabilities.push({
    id: 'public.sample',
    title: 'Additional public capability inventory',
    priority: 'optional',
    applicability: 'applicable',
    requirement: 'inventory',
    implementation: { files: [], tests: [] },
    evidence: [],
    sourceEvidence: [],
  });
  await writeFile(file, JSON.stringify(checklist, null, 2) + '\n');

  const result = await verifyKmongAuthEvidence({ root });
  assert.equal(result.ok, true);
  assert.equal(result.liveCheckedNow, false);
  assert.equal(result.runtimeImplementationHashesMatched, true);
  assert.equal(result.verification, 'historical_kmong_auth_evidence_revalidated_offline');
  const metadata = new Map(result.verificationMetadataProvenance.map(item => [item.path, item]));
  assert.equal(metadata.get('checklists/services/kmong.json').kind, 'checklist_metadata');
  assert.equal(metadata.get('checklists/services/kmong.json').status, 'historical_tool_changed');
  assert.equal(metadata.get('scripts/verify-kmong-auth.mjs').kind, 'offline_verifier');
  assert.equal(metadata.get('scripts/verify-kmong-auth.mjs').status, 'historical_tool_changed');
  assert.equal(result.capabilities.owner, 'recorded_live');
  assert.equal(result.capabilities.reuse, 'recorded_live');
});

test('historical verifier rejects a changed auth.owner proof binding in the checklist', async t => {
  const root = await isolatedVerifierRoot(t);
  const { file, checklist } = await readChecklist(root);
  const owner = checklist.capabilities.find(capability => capability.id === 'auth.owner');
  owner.evidence[0].files[0] = `${EVIDENCE_DIR}/kmong-auth-reuse-proof.json`;
  await writeFile(file, JSON.stringify(checklist, null, 2) + '\n');
  await assert.rejects(verifyKmongAuthEvidence({ root }), { code: 'KMONG_AUTH_CHECKLIST_BINDING_INVALID' });
});
