import { openSync, writeFileSync, closeSync } from 'node:fs';
import { loginWithNaverPassword, NAVER_LOGIN_ACTOR, validateLoginIdentity } from './naver-login-http.mjs';
import { loadNaverLoginIdentity, storeNaverLoginIdentity, naverLoginIdentityReady } from './naver-login-identity.mjs';
import { loadLoginControl, recordAccountProtection, acknowledgeAccountRecovery } from './naver-login-state.mjs';

const args = process.argv.slice(2);
const known = new Set(['--identity-stdin', '--remember-identity', '--remember-session', '--challenge-stdin',
  '--challenge-codex', '--reuse-session', '--status', '--output', '--account-recovered']);
let output = null;
let outputFd = null;
let result;
let identity;

async function reuseSession() {
  const { loadNaverCookies } = await import('./session-vault.mjs');
  let saved;
  try { saved = await loadNaverCookies({ env: {} }); }
  catch (error) {
    if (error?.message === 'NAVER_AUTH_COOKIES_MISSING') return null;
    throw error;
  }
  if (!saved.cookies.length) return null;
  const { SessionClient } = await import('./session-client.mjs');
  const client = new SessionClient({ cookies: saved.cookies, ownerBlogId: NAVER_LOGIN_ACTOR,
    defaultHeaders: saved.userAgent ? { 'user-agent': saved.userAgent } : {} });
  try {
    const verified = await client.verifyRoot();
    if (verified.loginHTML) return null;
    if (!verified.verified || !verified.actorMatched || !verified.adminShell) throw new Error('LOGIN_SESSION_OWNER_MISMATCH');
    return { actor: NAVER_LOGIN_ACTOR, checkedAt: verified.checkedAt, executionMode: 'stored_session_http',
      browserEngineUsed: false, sessionReused: true, sessionStored: saved.persisted,
      protectedOwnerRead: true, protectedReadStatus: verified.httpStatus, loginPostCount: 0,
      imageModelInvoked: false, credentialProvider: saved.provider, userAgentRestored: !!saved.userAgent,
      states: { captured: true, client_exists: true, credential_propagated: true, remnant_free: true, live_replay: true } };
  } catch (error) {
    if (error?.code === 'AUTH_MISSING' || (error?.code === 'AUTH_UNVERIFIED'
      && error.details?.finalPath === 'https://nid.naver.com/nidlogin.login')) return null;
    // A network error, forbidden page or wrong owner is not evidence of expiry.
    throw error;
  } finally { client.clear(); saved.cookies.length = 0; }
}

try {
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error('LOGIN_ARGUMENT_INVALID');
    if (args[i] === '--output') {
      if (!args[++i] || output) throw new Error('LOGIN_OUTPUT_INVALID');
      output = args[i];
    }
  }
  if (output) {
    try { outputFd = openSync(output, 'wx'); } catch { throw new Error('LOGIN_OUTPUT_RESERVATION_FAILED'); }
  }
  if (args.includes('--account-recovered')) acknowledgeAccountRecovery();
  if (args.includes('--challenge-stdin') && args.includes('--challenge-codex')) throw new Error('LOGIN_CHALLENGE_MODE_CONFLICT');
  if (args.includes('--reuse-session') && args.includes('--identity-stdin')) throw new Error('LOGIN_IDENTITY_REUSE_CONFLICT');
  const control = loadLoginControl();
  if (args.includes('--status')) {
    result = { actor: NAVER_LOGIN_ACTOR, identityProvider: 'windows_dpapi_current_user', identityAvailable: naverLoginIdentityReady(),
      loginBlocked: control.blocked, blockCode: control.code || null };
  } else {
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
      } else identity = loadNaverLoginIdentity();
      let handleChallenge;
      if (args.includes('--challenge-stdin')) {
        if (!process.stdin.isTTY) throw new Error('LOGIN_CHALLENGE_TTY_REQUIRED');
        ({ inspectAndContinueChallenge: handleChallenge } = await import('../tools/discovery/naver-login-challenge-inspector.mjs'));
      } else ({ answerLoginChallengeWithCodex: handleChallenge } = await import('./naver-login-vision.mjs'));
      const { receipt, session } = await loginWithNaverPassword(identity, { handleChallenge });
      result = receipt;
      if (receipt.code === 'ACCOUNT_PROTECTION_REQUIRED') recordAccountProtection();
      try {
        if (receipt.protectedOwnerRead && args.includes('--remember-session')) {
          result.sessionStored = (await session.persistVerifiedSession()).stored;
          result.cookiesPersisted = result.sessionStored;
        }
        if (receipt.protectedOwnerRead && args.includes('--remember-identity')) {
          result.identityStored = storeNaverLoginIdentity(identity).stored;
        }
      } finally { session?.clear(); }
      if (!receipt.protectedOwnerRead) process.exitCode = 2;
    }
  }
} catch (error) {
  result = { ...result, actor: NAVER_LOGIN_ACTOR, browserEngineUsed: false, protectedOwnerRead: result?.protectedOwnerRead === true,
    code: /^[A-Z_]+$/.test(error?.code || error?.message || '') ? error.code || error.message : 'LOGIN_CLI_FAILED' };
  process.exitCode = 2;
} finally {
  if (identity) { identity.username = ''; identity.password = ''; }
}
if (outputFd != null) {
  try { writeFileSync(outputFd, JSON.stringify(result, null, 2) + '\n'); }
  catch { result.receiptWriteFailed = true; process.exitCode = 2; }
  finally { closeSync(outputFd); }
}
console.log(JSON.stringify(result));
