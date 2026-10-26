import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateKmongAuthOwnerProof,
  validateKmongAuthReuseProof,
  validateKmongBootstrapContext,
} from '../scripts/verify-kmong-auth.mjs';

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
