// Keeps every publishing and affiliate session usable before unattended runs.
// Usage: node apps/affiliate-api-hub/scripts/session-keeper.mjs [--services=naver,brandconnect] [--no-renewal] [--no-notify] [--out=<session-keeper.json>]
//
// Order: Naver blog → Brand Connect (reuses the Naver cookies) → Tistory → LinkPrice.
// Each service is checked with a read first; renewal runs only when the check says the session is rejected:
//   Naver       naver-login-cli --reuse-session --remember-session --challenge-codex: stored-session reuse, else
//               HTTP login with the saved identity and the maintained image-only Codex CLI provider.
//               Unresolved challenges, extra verification or account protection stop renewal.
//   Brandconnect renew-session with the Naver blog session's NID cookies (same .naver.com login), verified as the
//               same account, creator and active space before it is stored.
//   Tistory     cli login (saved Kakao account over HTTP).
//   LinkPrice   ensure (token refresh, then saved password login).
//   Threads     official Graph API token: health, then th_refresh_token once it is 7 days old (threads-graph.mjs ensure).
// Cookie values move only through memory and a child's stdin; nothing secret is printed or written.
// Exit 0 when every service is usable, 3 when a person has to act, 1 on a keeper fault.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../adapters/web-auth-provider.mjs';
import { sanitizeAuthHealth } from '../../tistory-api/lib/auth-health.mjs';

const APPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAVER = path.join(APPS, 'naver-blog-api');
const TISTORY = path.join(APPS, 'tistory-api');
const SERVICE_NAMES = ['naver', 'brandconnect', 'tistory', 'linkprice', 'threads'];
const HUMAN = /AUTH_MISSING|NAVER_AUTH_COOKIES_MISSING|CAPTCHA|CHALLENGE|ADDITIONAL_VERIFICATION|ACCOUNT_PROTECTION|IDENTITY_MISSING|LOGIN_MISSING|ACCOUNT_MISMATCH|ENTITLEMENT|SPACE_NOT_ACTIVE|REAUTH_REQUIRED/;
const BRAND_REAUTH = /REAUTH_REQUIRED|AUTH_SESSION_INVALIDATED|SESSION_MISSING|AUTH_MISSING/;
const invalidInput = code => Object.assign(new Error(code), { code });

function brandconnectRenewalInput(session) {
  const sourceCookies = Array.isArray(session) ? session : session?.cookies;
  if (!Array.isArray(sourceCookies)) throw invalidInput('NAVER_COOKIES_UNAVAILABLE');

  let userAgent;
  if (!Array.isArray(session) && session?.userAgent != null) {
    const value = session.userAgent;
    if (typeof value !== 'string' || value.length < 1 || value.length > 512
      || !/^[\x20-\x7e]+$/.test(value) || !value.trim()) throw invalidInput('NAVER_USER_AGENT_INVALID');
    userAgent = value;
  }

  const selected = sourceCookies.filter(cookie => cookie && ['NID_AUT', 'NID_SES'].includes(cookie.name)
    && String(cookie.domain).toLowerCase() === '.naver.com' && cookie.path === '/')
    .map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path, secure: cookie.secure, expires: cookie.expires }));
  const names = selected.map(cookie => cookie.name);
  if (selected.length !== 2 || new Set(names).size !== 2
    || !names.includes('NID_AUT') || !names.includes('NID_SES')
    || selected.some(cookie => typeof cookie.value !== 'string' || !cookie.value)) {
    throw invalidInput('NAVER_COOKIES_UNAVAILABLE');
  }

  return { cookies: selected, ...(userAgent ? { userAgent } : {}) };
}

export function parseKeeperArgs(argv = []) {
  let services = [...SERVICE_NAMES], out, serviceArgSeen = false, outSeen = false, allowRenewal = true, notify = true;
  for (const arg of argv) {
    if (arg.startsWith('--services=')) {
      if (serviceArgSeen) return { ok: false, code: 'INVALID_OPTIONS' };
      serviceArgSeen = true;
      services = arg.slice(11).split(',').map(s => s.trim()).filter(Boolean);
      if (!services.length || new Set(services).size !== services.length || services.some(s => !SERVICE_NAMES.includes(s))) {
        return { ok: false, code: 'INVALID_SERVICES' };
      }
    } else if (arg.startsWith('--out=')) {
      if (outSeen || !arg.slice(6).trim()) return { ok: false, code: 'INVALID_OPTIONS' };
      outSeen = true;
      out = arg.slice(6);
    } else if (arg === '--no-renewal') {
      if (!allowRenewal) return { ok: false, code: 'INVALID_OPTIONS' };
      allowRenewal = false;
    } else if (arg === '--no-notify') {
      if (!notify) return { ok: false, code: 'INVALID_OPTIONS' };
      notify = false;
    } else return { ok: false, code: 'INVALID_OPTIONS' };
  }
  return {
    ok: true,
    out,
    services,
    allowRenewal,
    notify
  };
}

export function lastJson(text) {
  const s = String(text ?? '');
  for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) {
    try { const v = JSON.parse(s.slice(i)); if (v && typeof v === 'object') return v; } catch { /* keep looking */ }
  }
  return null;
}

export function run(script, args = [], { cwd, input = null, timeoutMs = 180000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', failure = null, bytes = 0;
    const stop = code => { failure ||= code; child.kill(); };
    const timer = setTimeout(() => stop('PROCESS_TIMEOUT'), timeoutMs);
    const append = (kind, d) => {
      bytes += d.length;
      if (bytes > 1024 * 1024) return stop('PROCESS_OUTPUT_LIMIT');
      if (kind === 'out') out += d; else err += d;
    };
    child.stdout.on('data', d => append('out', d));
    child.stderr.on('data', d => append('err', d));
    child.on('error', () => { clearTimeout(timer); resolve({ exitCode: 1, json: null }); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1,
      json: failure ? {ok:false,code:failure} : lastJson(out) ?? lastJson(err) }); out = ''; err = ''; });
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? '' : JSON.stringify(input));
  });
}

const codeOf = r => {
  const value = r?.json?.code || r?.json?.error || r?.json?.classification;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : (r?.exitCode ? `EXIT_${r.exitCode}` : null);
};
const naverOk = r => r?.json?.protectedOwnerRead === true && r.json.actorMatched === true && !r.json.code;
const tistoryOk = r => r?.json?.authenticated === true && r.json.ownerVerified === true;
const webOk = r => r?.json?.ok === true && tistoryOk(r);
const naverReauth = r => ['AUTH_MISSING','NAVER_AUTH_COOKIES_MISSING','REAUTH_REQUIRED'].includes(codeOf(r))
  || r?.json?.loginHTML === true || r?.json?.loginRedirect === true || r?.json?.httpStatus === 401;

export async function keep({ exec = run, loadCookies, loadNaverSession, loginControl, playbook = webApiPlaybookRoot(), allowRenewal = true, services: requestedServices = SERVICE_NAMES } = {}) {
  const services = {};
  if (!Array.isArray(requestedServices) || !requestedServices.length || new Set(requestedServices).size !== requestedServices.length
    || requestedServices.some(s => !SERVICE_NAMES.includes(s))) throw new TypeError('INVALID_SERVICES');
  const selected = new Set(requestedServices);
  const naverHealth = () => exec(path.join(NAVER, 'scripts', 'naver-session-health.mjs'), [], { cwd: NAVER });

  // Naver blog
  if (selected.has('naver')) {
    let control = { blocked: false };
    if (allowRenewal) {
      try { control = await loginControl(); } catch { control = { blocked: true, code: 'LOGIN_CONTROL_INVALID' }; }
    }
    if (control.blocked) services.naver = { ok: false, action: 'none', code: control.code || 'ACCOUNT_PROTECTION_REQUIRED', human: true };
    else {
      let h = await naverHealth();
      if (naverOk(h)) services.naver = { ok: true, action: 'reused' };
      else if (allowRenewal && naverReauth(h)) {
        const login = await exec(path.join(NAVER, 'scripts', 'naver-login-cli.mjs'),
          // The image CLI has its own 110s deadline, in addition to up to five
          // bounded SDK workers (including the native form submit) and HTTP checks.
          ['--reuse-session', '--remember-session', '--challenge-codex'], { cwd: NAVER, timeoutMs: 600000 });
        h = await naverHealth();
        services.naver = naverOk(h) ? { ok: true, action: login.json?.sessionReused ? 'reused' : 'renewed' }
          : { ok: false, action: 'login_attempted', code: codeOf(login) || codeOf(h) || 'NAVER_SESSION_UNUSABLE', human: true };
      } else services.naver = { ok: false, action: 'none', code: codeOf(h) || 'NAVER_OWNER_UNVERIFIED', human: HUMAN.test(String(codeOf(h))) };
    }
  }

  // Brand Connect: same Naver login, so renew from the Naver session when it is usable.
  if (selected.has('brandconnect')) {
    const bc = path.join(playbook, 'scripts', 'brandconnect.mjs');
    let b = await exec(bc, ['health'], { cwd: playbook });
    if (webOk(b)) services.brandconnect = { ok: true, action: 'reused' };
    else if (allowRenewal && BRAND_REAUTH.test(String(codeOf(b))) && services.naver?.ok) {
      let cookies = null;
      let renewalInput = null;
      try {
        const naverSession = loadNaverSession
          ? await loadNaverSession()
          : await loadCookies?.();
        renewalInput = brandconnectRenewalInput(naverSession);
        cookies = renewalInput.cookies;
        const renew = await exec(bc, ['renew-session'], { cwd: playbook, input: renewalInput });
        b = await exec(bc, ['health'], { cwd: playbook });
        services.brandconnect = webOk(b) ? { ok: true, action: 'renewed_from_naver' }
          : { ok: false, action: 'renew_attempted', code: codeOf(renew) || codeOf(b), human: true };
      } catch (error) {
        const code = error?.code === 'NAVER_USER_AGENT_INVALID' ? error.code : 'NAVER_COOKIES_UNAVAILABLE';
        services.brandconnect = { ok: false, action: 'renew_attempted', code, human: true };
      } finally {
        if (cookies) for (const c of cookies) c.value = '';
        if (renewalInput?.userAgent) renewalInput.userAgent = '';
      }
    } else services.brandconnect = { ok: false, action: 'none', code: codeOf(b) || 'BRANDCONNECT_UNUSABLE', human: HUMAN.test(String(codeOf(b))) };
  }

  // Tistory
  if (selected.has('tistory')) {
    const tcli = path.join(TISTORY, 'scripts', 'cli.mjs');
    let t = await exec(tcli, ['status'], { cwd: TISTORY });
    let health = sanitizeAuthHealth(t?.json?.authHealth);
    if (tistoryOk(t)) services.tistory = { ok: true, action: 'reused' };
    else if (allowRenewal && codeOf(t) === 'TISTORY_REAUTH_REQUIRED' && health?.reauthRequired !== true) {
      const login = await exec(tcli, ['login'], { cwd: TISTORY });
      t = await exec(tcli, ['status'], { cwd: TISTORY });
      health = tistoryOk(t)
        ? sanitizeAuthHealth(t?.json?.authHealth) ?? sanitizeAuthHealth(login?.json?.authHealth) ?? health
        : sanitizeAuthHealth(login?.json?.authHealth) ?? sanitizeAuthHealth(t?.json?.authHealth) ?? health;
      services.tistory = tistoryOk(t) ? { ok: true, action: 'renewed' } : { ok: false, action: 'login_attempted', code: codeOf(login) || codeOf(t), human: true };
    } else services.tistory = { ok: false, action: 'none', code: codeOf(t) || 'TISTORY_OWNER_UNVERIFIED', human: HUMAN.test(String(codeOf(t))) };
    if (health) {
      services.tistory.authHealth = health;
      if (health.reauthRequired && !services.tistory.ok) services.tistory.code = 'TISTORY_KAKAO_REAUTH_REQUIRED';
    }
  }

  // LinkPrice
  if (selected.has('linkprice')) {
    const l = await exec(path.join(APPS, 'affiliate-api-hub', 'scripts', 'web-auth.mjs'), ['linkprice', allowRenewal ? 'ensure' : 'health'], { cwd: path.join(APPS, '..') });
    services.linkprice = webOk(l) ? { ok: true, action: ['token_refresh','password_login'].includes(l.json.renewal) ? 'renewed' : 'reused' }
      : { ok: false, action: 'ensure_attempted', code: codeOf(l), human: HUMAN.test(String(codeOf(l))) };
  }

  // Threads official API token (60 days): refreshed through Meta's own refresh endpoint once it is a week old.
  if (selected.has('threads')) {
    const t = await exec(path.join(APPS, 'affiliate-api-hub', 'scripts', 'sns', 'writers', 'threads-graph.mjs'), [allowRenewal ? 'ensure' : 'health'],
      { cwd: path.join(APPS, 'affiliate-api-hub') });
    services.threads = t?.json?.ok === true
      ? { ok: true, action: t.json.action, daysLeft: Number.isFinite(t.json.daysLeft) ? Math.round(t.json.daysLeft) : null }
      : { ok: false, action: 'ensure_attempted', code: codeOf(t) || 'THREADS_GRAPH_UNUSABLE', human: HUMAN.test(String(codeOf(t))) };
  }

  const needsHuman = Object.entries(services).filter(([, s]) => !s.ok).map(([k, s]) => ({ service: k, code: s.code ?? null }));
  const warnings = Object.entries(services).flatMap(([service, value]) =>
    (value.authHealth?.warnings ?? []).map(code => ({ service, code })));
  return { schemaVersion: 1, kind: 'session-keeper', checkedAt: new Date().toISOString(), allOk: needsHuman.length === 0, services, needsHuman,
    ...(warnings.length ? { warnings } : {}) };
}

async function main() {
  const options = parseKeeperArgs(process.argv.slice(2));
  if (!options.ok) { console.log(JSON.stringify({ ok: false, code: options.code })); process.exitCode = 1; return; }
  const { loadNaverCookies } = await import(pathToFileURL(path.join(NAVER, 'scripts', 'session-vault.mjs')).href);
  const { loadLoginControl } = await import(pathToFileURL(path.join(NAVER, 'scripts', 'naver-login-state.mjs')).href);
  const result = await keep({
    loadNaverSession: async () => {
      const session = await loadNaverCookies({ env: {} });
      return { cookies: session.cookies, userAgent: session.userAgent };
    },
    loginControl: async () => loadLoginControl(),
    ...options,
  });
  if (!result.allOk && options.notify) {
    // Best effort: an unconfigured or failing notifier must not hide the keeper result.
    try {
      const { defaultNotifier } = await import(pathToFileURL(path.join(APPS, 'affiliate-api-hub', 'scripts', 'notify.mjs')).href);
      const lines = result.needsHuman.map(n => `- ${n.service}: ${n.code ?? '확인 필요'}`);
      result.notified = await (await defaultNotifier()).send(`[세션 확인 필요]\n${lines.join('\n')}\n자동 발행이 멈춰 있습니다. 해당 서비스에 직접 로그인해 주세요.`);
    } catch (e) { result.notified = { sent: false, reason: e.code || 'NOTIFY_FAILED' }; }
  }
  if (options.out) writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  process.exitCode = result.allOk ? 0 : 3;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.log(JSON.stringify({ ok: false, code: 'SESSION_KEEPER_FAILED' })); process.exitCode = 1; });
