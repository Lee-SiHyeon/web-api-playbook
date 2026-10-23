import { openSync, writeFileSync, closeSync } from 'node:fs';
import { loginWithNaverPassword, NAVER_LOGIN_ACTOR, requestedLoginChallengeMode, validateLoginIdentity } from './naver-login-http.mjs';
import { loadNaverLoginIdentity, storeNaverLoginIdentity, naverLoginIdentityReady } from './naver-login-identity.mjs';
import { loadLoginControl, recordAccountProtection, acknowledgeAccountRecovery, automaticReloginBlocked, recordLoginSuccess } from './naver-login-state.mjs';
import { reuseStoredNaverSession } from './naver-session-reuse.mjs';
import { acquireNaverSessionLock } from './naver-session-lock.mjs';

const args = process.argv.slice(2);
const known = new Set(['--identity-stdin', '--remember-identity', '--remember-session', '--challenge-stdin',
  '--challenge-codex', '--reuse-session', '--status', '--output', '--account-recovered']);
let output = null;
let outputFd = null;
let result;
let identity;
let releaseSessionLock;

function safeFailureCode(error, fallback) {
  const candidate = error?.code || error?.message;
  return typeof candidate === 'string' && /^[A-Z_]+$/.test(candidate) ? candidate : fallback;
}

async function reuseSession() {
  const { loadNaverCookies } = await import('./session-vault.mjs');
  const { SessionClient } = await import('./session-client.mjs');
  return reuseStoredNaverSession({ loadNaverCookies: () => loadNaverCookies({ env: {} }), SessionClient,
    ownerBlogId: NAVER_LOGIN_ACTOR, rememberSession: args.includes('--remember-session') });
}

try {
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error('LOGIN_ARGUMENT_INVALID');
    if (args[i] === '--output') {
      if (!args[++i] || output) throw new Error('LOGIN_OUTPUT_INVALID');
      output = args[i];
    }
  }
  const challengeMode = requestedLoginChallengeMode(args);
  if (output) {
    try { outputFd = openSync(output, 'wx'); } catch { throw new Error('LOGIN_OUTPUT_RESERVATION_FAILED'); }
  }
  if (args.includes('--reuse-session') && args.includes('--identity-stdin')) throw new Error('LOGIN_IDENTITY_REUSE_CONFLICT');
  // A pure status read does not rotate state. A recovery acknowledgement does.
  if (!args.includes('--status') || args.includes('--account-recovered')) {
    releaseSessionLock = await acquireNaverSessionLock();
  }
  if (args.includes('--status')) {
    if (args.includes('--account-recovered')) acknowledgeAccountRecovery();
    const control = loadLoginControl();
    result = { actor: NAVER_LOGIN_ACTOR, identityProvider: 'windows_dpapi_current_user', identityAvailable: naverLoginIdentityReady(),
      loginBlocked: control.blocked, blockCode: control.code || null };
  } else {
    if (args.includes('--account-recovered')) acknowledgeAccountRecovery();
    const control = loadLoginControl();
    if (control.blocked) {
      result = { actor: NAVER_LOGIN_ACTOR, loginPostCount: 0, browserEngineUsed: false,
        protectedOwnerRead: false, nextAction: 'complete_naver_account_recovery_before_another_login' };
      throw new Error(control.code);
    }
    if (args.includes('--identity-stdin') && args.includes('--challenge-stdin')) throw new Error('LOGIN_STDIN_MODE_CONFLICT');
    if (args.includes('--reuse-session')) result = await reuseSession();
    if (!result) {
      if (args.includes('--identity-stdin')) {
        if (process.stdin.isTTY) throw new Error('LOGIN_IDENTITY_PIPE_REQUIRED');
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) {
          size += chunk.length;
          if (size > 8192) throw new Error('LOGIN_IDENTITY_INPUT_SIZE');
          chunks.push(chunk);
        }
        const input = Buffer.concat(chunks);
        try { identity = validateLoginIdentity(JSON.parse(input.toString('utf8'))); }
        finally { input.fill(0); for (const chunk of chunks) chunk.fill(0); }
      } else {
        // Automatic (stored-identity) logins stop after a recent verified login whose session was rejected again.
        if (automaticReloginBlocked(control)) {
          result = { actor: NAVER_LOGIN_ACTOR, loginPostCount: 0, browserEngineUsed: false, protectedOwnerRead: false,
            lastLoginAt: control.lastLoginAt, nextAction: 'investigate_session_reuse_before_another_password_login' };
          throw new Error('NAVER_RECENT_LOGIN_SESSION_REJECTED');
        }
        identity = loadNaverLoginIdentity();
      }
      let handleChallenge;
      if (challengeMode === 'stdin') {
        if (!process.stdin.isTTY) throw new Error('LOGIN_CHALLENGE_TTY_REQUIRED');
        ({ inspectAndContinueChallenge: handleChallenge } = await import('../tools/discovery/naver-login-challenge-inspector.mjs'));
      } else if (challengeMode === 'codex') {
        ({ answerLoginChallengeWithCodex: handleChallenge } = await import('./naver-login-vision.mjs'));
      }
      const { receipt, session } = await loginWithNaverPassword(identity, { handleChallenge });
      result = receipt;
      if (receipt.code === 'ACCOUNT_PROTECTION_REQUIRED') recordAccountProtection();
      const ownerVerified = receipt.protectedOwnerRead === true;
      const persistenceFailures = [];
      try {
        // The login flow has already made the protected owner GET. Reuse only
        // SessionClient's private fresh proof so DPAPI work does not trigger a
        // redundant second owner read after a successful login.
        if (ownerVerified && args.includes('--remember-session')) {
          try {
            result.sessionStored = (await session.persistVerifiedSession({ reuseFreshOwnerVerification: true })).stored;
            result.cookiesPersisted = result.sessionStored;
            if (!result.sessionStored) persistenceFailures.push('CREDENTIAL_STORE_WRITE_FAILED');
          } catch (error) {
            result.sessionStored = false;
            result.cookiesPersisted = false;
            const code = safeFailureCode(error, 'CREDENTIAL_STORE_WRITE_FAILED');
            result.sessionPersistenceCode = code;
            persistenceFailures.push(code);
          }
        }
        // A successful explicit password login authorizes storing that exact
        // identity independently of whether cookie persistence succeeded.
        if (ownerVerified && args.includes('--remember-identity')) {
          try {
            result.identityStored = storeNaverLoginIdentity(identity).stored;
            if (!result.identityStored) persistenceFailures.push('CREDENTIAL_STORE_WRITE_FAILED');
          } catch (error) {
            result.identityStored = false;
            const code = safeFailureCode(error, 'CREDENTIAL_STORE_WRITE_FAILED');
            result.identityPersistenceCode = code;
            persistenceFailures.push(code);
          }
        }
      } finally {
        // Record the verified login even when a later DPAPI write failed, so an
        // automatic worker cannot immediately retry the password flow.
        if (ownerVerified) {
          try {
            result.loginControlStored = recordLoginSuccess().stored;
            if (!result.loginControlStored) persistenceFailures.push('LOGIN_CONTROL_WRITE_FAILED');
          } catch (error) {
            result.loginControlStored = false;
            const code = safeFailureCode(error, 'LOGIN_CONTROL_WRITE_FAILED');
            result.loginControlPersistenceCode = code;
            persistenceFailures.push(code);
          }
        }
        session?.clear();
      }
      if (persistenceFailures.length) {
        result.persistenceFailures = [...persistenceFailures];
        throw Object.assign(new Error(persistenceFailures[0]), { code: persistenceFailures[0] });
      }
      if (!receipt.protectedOwnerRead) process.exitCode = 2;
    }
  }
} catch (error) {
  result = { ...result, actor: NAVER_LOGIN_ACTOR, browserEngineUsed: false, protectedOwnerRead: result?.protectedOwnerRead === true,
    code: /^[A-Z_]+$/.test(error?.code || error?.message || '') ? error.code || error.message : 'LOGIN_CLI_FAILED' };
  process.exitCode = 2;
} finally {
  if (identity) { identity.username = ''; identity.password = ''; }
  releaseSessionLock?.();
}
if (outputFd != null) {
  try { writeFileSync(outputFd, JSON.stringify(result, null, 2) + '\n'); }
  catch { result.receiptWriteFailed = true; process.exitCode = 2; }
  finally { closeSync(outputFd); }
}
console.log(JSON.stringify(result));
