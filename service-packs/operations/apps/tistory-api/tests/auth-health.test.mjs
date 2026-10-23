import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthHealth, sanitizeAuthDiagnostic, sanitizeAuthHealth } from '../lib/auth-health.mjs';

const now = Date.parse('2026-10-07T09:00:00.000Z');

function cookie(key, { domain = 'accounts.kakao.com', expires = 'Infinity', ...extra } = {}) {
  return { key, value: 'synthetic-cookie-secret', domain, path: '/', expires, ...extra };
}

test('a working future cookie does not clear the reauth latch', () => {
  const result = buildAuthHealth({
    login: {
      reauthRequired: true,
      lastRenewedAt: '2026-10-06T09:00:00.000Z',
      failedAt: '2026-10-07T08:30:00Z',
      lastFailure: 'TISTORY_KAKAO_REAUTH_REQUIRED',
    },
    session: { jar: { cookies: [cookie('_kawlt', { expires: '2026-11-07T09:00:00.000Z' })] } },
  }, { now });

  assert.equal(result.reauthRequired, true);
  assert.equal(result.failureCode, 'TISTORY_KAKAO_REAUTH_REQUIRED');
  assert.equal(result.failedAt, '2026-10-07T08:30:00.000Z');
  assert.equal(result.kakaoCookieCandidates[0].expired, false);
  assert.ok(result.warnings.includes('TISTORY_KAKAO_REAUTH_REQUIRED'));
});

test('24-hour renewal age warns independently of a distant cookie expiry', () => {
  const result = buildAuthHealth({
    login: { reauthRequired: false, lastRenewedAt: '2026-10-06T08:00:00.000Z' },
    session: { jar: { cookies: [cookie('_kaslt', { expires: '2026-12-07T09:00:00.000Z' })] } },
  }, { now });

  assert.equal(result.renewalAgeHours, 25);
  assert.equal(result.renewalWarningAfterHours, 24);
  assert.ok(result.warnings.includes('TISTORY_KAKAO_RENEWAL_AGE_WARNING'));
  assert.ok(!result.warnings.includes('TISTORY_KAKAO_COOKIE_EXPIRY_WARNING'));
});

test('a candidate expiring within three days warns and contributes to earliest expiry', () => {
  const expiry = '2026-10-10T09:00:00.000Z';
  const result = buildAuthHealth({
    login: { lastRenewedAt: '2026-10-07T08:30:00.000Z' },
    session: { jar: { cookies: [cookie('_kawltea', { domain: '.kakao.com', expires: expiry })] } },
  }, { now });

  assert.equal(result.kakaoCookieCandidates[0].domain, 'kakao.com');
  assert.equal(result.kakaoCookieCandidates[0].expiresAt, expiry);
  assert.equal(result.kakaoCookieCandidates[0].expired, false);
  assert.equal(result.earliestKakaoCookieExpiry, expiry);
  assert.ok(result.warnings.includes('TISTORY_KAKAO_COOKIE_EXPIRY_WARNING'));
});

test('rounded age does not trigger the freshness warning before 24 actual hours', () => {
  const result = buildAuthHealth({ login: { lastRenewedAt: '2026-10-06T09:15:00.000Z' } }, { now });
  assert.equal(result.renewalAgeHours, 24);
  assert.equal(result.warnings.includes('TISTORY_KAKAO_RENEWAL_AGE_WARNING'), false);
});

test('Max-Age uses recent last access after rotation even when creation is old', () => {
  const result = buildAuthHealth({
    login: { lastRenewedAt: '2026-10-07T08:30:00.000Z' },
    session: { jar: { cookies: [cookie('_kahai', {
      expires: 'Infinity', creation: '2026-10-07T08:00:00.000Z',
      lastAccessed: '2026-10-07T08:59:30.000Z', maxAge: 60,
    })] } },
  }, { now });

  assert.equal(result.kakaoCookieCandidates[0].expiresAt, '2026-10-07T09:00:30.000Z');
  assert.equal(result.kakaoCookieCandidates[0].expired, false);
  assert.equal(result.earliestKakaoCookieExpiry, '2026-10-07T09:00:30.000Z');
  assert.ok(result.warnings.includes('TISTORY_KAKAO_COOKIE_EXPIRY_WARNING'));
});

test('nonpositive Max-Age is expired even when Expires is in the future', () => {
  const result = buildAuthHealth({
    login: { lastRenewedAt: '2026-10-07T08:30:00.000Z' },
    session: { jar: { cookies: [cookie('_kahai', {
      expires: '2026-12-07T09:00:00.000Z', lastAccessed: '2026-10-07T08:59:00.000Z', maxAge: 0,
    })] } },
  }, { now });

  assert.equal(result.kakaoCookieCandidates[0].expiresAt, '2026-10-07T09:00:00.000Z');
  assert.equal(result.kakaoCookieCandidates[0].expired, true);
  assert.equal(result.earliestKakaoCookieExpiry, '2026-10-07T09:00:00.000Z');
});

test('diagnostic sanitizer keeps fixed enums and bounded values only', () => {
  const result = sanitizeAuthDiagnostic({
    reason: 'saved_account_rejected',
    pageType: '/login/simple_login',
    savedAccountCount: 101,
    pinnedSelectorMatched: true,
    stage: 'kakao_saved_account_post',
    selector: 'secret-selector',
    url: 'https://example.test/?token=synthetic-token',
    csrf: 'synthetic-csrf',
    loginId: 'synthetic-id',
  });

  assert.deepEqual(result, {
    reason: 'saved_account_rejected',
    pageType: '/login/simple_login',
    savedAccountCount: null,
    pinnedSelectorMatched: true,
    stage: 'kakao_saved_account_post',
  });
});

test('health output ignores arbitrary fields and never serializes cookie or identity secrets', () => {
  const result = buildAuthHealth({
    identity: { userId: 'synthetic-user-id' },
    session: {
      userAgent: 'synthetic-user-agent',
      jar: { cookies: [
        cookie('_kawlt', { value: 'synthetic-cookie-value' }),
        cookie('other', { value: 'synthetic-other-cookie', domain: 'accounts.kakao.com' }),
        cookie('_kaslt', { value: 'synthetic-wrong-domain', domain: 'attacker.example' }),
      ] },
    },
    login: {
      reauthRequired: true,
      lastRenewedAt: 'not-a-date',
      failedAt: 'not-a-date',
      lastFailure: 'synthetic-error-token',
      failureDiagnostic: {
        reason: 'synthetic-secret-reason',
        pageType: 'https://accounts.kakao.com/login/login?csrf=synthetic-csrf',
        savedAccountCount: 'synthetic-account-id',
        pinnedSelectorMatched: 'synthetic-selector',
        stage: 'synthetic-stage',
        password: 'synthetic-password',
      },
      password: 'synthetic-password',
    },
    csrf: 'synthetic-csrf',
    url: 'https://example.test/?token=synthetic-token',
  }, { now });
  const serialized = JSON.stringify(result);

  assert.equal(result.lastRenewedAt, null);
  assert.equal(result.renewalAgeHours, null);
  assert.equal(result.failedAt, null);
  assert.equal(result.failureCode, null);
  assert.equal(result.kakaoCookieCandidates.length, 1);
  assert.equal(result.kakaoCookieCandidates[0].name, '_kawlt');
  assert.deepEqual(result.failureDiagnostic, {
    reason: null,
    pageType: null,
    savedAccountCount: null,
    pinnedSelectorMatched: null,
    stage: null,
  });
  for (const secret of [
    'synthetic-cookie-value', 'synthetic-other-cookie', 'synthetic-wrong-domain',
    'synthetic-user-id', 'synthetic-user-agent', 'synthetic-error-token',
    'synthetic-secret-reason', 'synthetic-selector', 'synthetic-password',
    'synthetic-csrf', 'synthetic-token',
  ]) assert.ok(!serialized.includes(secret), `health output leaked ${secret}`);
  assert.ok(result.warnings.includes('TISTORY_KAKAO_RENEWAL_TIME_UNKNOWN'));
});

test('child health sanitizer copies the schema and drops unknown or invalid values', () => {
  const built = buildAuthHealth({
    login: { reauthRequired: false, lastRenewedAt: '2026-10-07T08:30:00.000Z' },
    session: { jar: { cookies: [cookie('_kawlt', { expires: '2026-12-07T09:00:00.000Z' })] } },
  }, { now });
  const result = sanitizeAuthHealth({
    ...built,
    id: 'synthetic-id',
    cookie: 'synthetic-cookie',
    userAgent: 'synthetic-agent',
    warnings: [...built.warnings, 'synthetic-warning'],
    failureDiagnostic: {
      reason: 'password_login_required', pageType: 'other', savedAccountCount: 2,
      pinnedSelectorMatched: false, stage: 'kakao_page', selector: 'synthetic-selector',
    },
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.warnings.includes('synthetic-warning'), false);
  assert.deepEqual(result.failureDiagnostic, {
    reason: 'password_login_required',
    pageType: 'other',
    savedAccountCount: 2,
    pinnedSelectorMatched: false,
    stage: 'kakao_page',
  });
  for (const secret of ['synthetic-id', 'synthetic-cookie', 'synthetic-agent', 'synthetic-selector']) {
    assert.ok(!serialized.includes(secret));
  }
  assert.equal(sanitizeAuthHealth({ warnings: [] }), null);
});
