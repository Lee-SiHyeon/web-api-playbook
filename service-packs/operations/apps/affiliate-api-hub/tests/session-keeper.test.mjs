import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { keep, lastJson, parseKeeperArgs } from '../scripts/session-keeper.mjs';

// A scripted exec: each service answers from a queue keyed by script name + first arg.
function fakeExec(script) {
  const calls = [];
  const exec = async (file, args = [], opts = {}) => {
    const key = `${path.basename(file)} ${args[0] ?? ''}`.trim();
    calls.push({ key, args: [...args], timeoutMs: opts.timeoutMs,
      input: opts.input == null ? null : structuredClone(opts.input) });
    const queue = script[key];
    const next = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
    return { exitCode: next?.ok === false ? 2 : 0, json: next ?? null };
  };
  return { exec, calls };
}
const naverOk = { protectedOwnerRead: true, actorMatched: true };
const tistoryOk = { authenticated: true, ownerVerified: true };
const bcOk = { ok: true, authenticated: true, ownerVerified: true };
const lpOk = { ok: true, authenticated: true, ownerVerified: true };
const cookies = () => [
  { name: 'NID_AUT', value: 'a', domain: '.naver.com', path: '/', secure: true, expires: -1 },
  { name: 'NID_SES', value: 's', domain: '.naver.com', path: '/', secure: true, expires: -1 },
  { name: 'NNB', value: 'x', domain: '.naver.com', path: '/', secure: true, expires: -1 }];
const base = { loadCookies: async () => cookies(), loginControl: async () => ({ blocked: false }), playbook: '/playbook' };

test('all sessions usable: reads only, no renewals', async () => {
  const f = fakeExec({ 'naver-session-health.mjs': naverOk, 'brandconnect.mjs health': bcOk, 'cli.mjs status': tistoryOk, 'web-auth.mjs linkprice': lpOk,
    'threads-graph.mjs ensure': { ok: true, action: 'reused', daysLeft: 58.4 } });
  const r = await keep({ ...base, exec: f.exec });
  assert.equal(r.allOk, true);
  assert.deepEqual(Object.values(r.services).map(s => s.action), ['reused', 'reused', 'reused', 'reused', 'reused']);
  assert.equal(r.services.threads.daysLeft, 58);
  assert.ok(!f.calls.some(c => /login|renew/.test(c.key)));
});

test('Threads official token: ensure refreshes in renewal mode, health only without it, reauth goes to a person', async () => {
  const refreshed = fakeExec({ 'threads-graph.mjs ensure': { ok: true, action: 'refreshed', daysLeft: 60 } });
  assert.deepEqual((await keep({ ...base, exec: refreshed.exec, services: ['threads'] })).services.threads, { ok: true, action: 'refreshed', daysLeft: 60 });
  const check = fakeExec({ 'threads-graph.mjs health': { ok: true, action: 'reused', daysLeft: 50 } });
  await keep({ ...base, exec: check.exec, services: ['threads'], allowRenewal: false });
  assert.deepEqual(check.calls.map(c => c.key), ['threads-graph.mjs health']);
  const dead = fakeExec({ 'threads-graph.mjs ensure': { ok: false, code: 'THREADS_GRAPH_REAUTH_REQUIRED' } });
  const r = await keep({ ...base, exec: dead.exec, services: ['threads'] });
  assert.deepEqual(r.needsHuman, [{ service: 'threads', code: 'THREADS_GRAPH_REAUTH_REQUIRED' }]);
  assert.equal(r.services.threads.human, true);
});

test('expired Brand Connect is renewed from the Naver session with only NID cookies', async () => {
  const f = fakeExec({ 'naver-session-health.mjs': naverOk, 'brandconnect.mjs health': [{ ok: false, code: 'REAUTH_REQUIRED' }, bcOk],
    'brandconnect.mjs renew-session': { ok: true }, 'cli.mjs status': tistoryOk, 'web-auth.mjs linkprice': lpOk,
    'threads-graph.mjs ensure': { ok: true, action: 'reused' } });
  const r = await keep({ ...base, exec: f.exec });
  assert.equal(r.services.brandconnect.action, 'renewed_from_naver');
  const renew = f.calls.find(c => c.key === 'brandconnect.mjs renew-session');
  assert.deepEqual(renew.input.cookies.map(c => c.name), ['NID_AUT', 'NID_SES']);
  assert.equal(r.allOk, true);
});

test('Brand Connect renewal forwards only the exact NID scope and observed Naver user agent', async () => {
  const f = fakeExec({ 'naver-session-health.mjs': naverOk,
    'brandconnect.mjs health': [{ ok: false, code: 'REAUTH_REQUIRED' }, bcOk],
    'brandconnect.mjs renew-session': { ok: true } });
  const userAgent = `Node.js/${process.versions.node} jsdom/26.1.0 NaverLoginHttpClient/1.0`;
  const r = await keep({ ...base, exec: f.exec, services: ['naver', 'brandconnect'],
    loadCookies: async () => assert.fail('use the protected session bundle provider'),
    loadNaverSession: async () => ({ cookies: [
      { name: 'NID_AUT', value: 'current-aut', domain: '.naver.com', path: '/', secure: true, expires: -1 },
      { name: 'NID_SES', value: 'current-ses', domain: '.naver.com', path: '/', secure: true, expires: -1 },
      { name: 'NNB', value: 'unrelated', domain: '.naver.com', path: '/', secure: true, expires: -1 },
      { name: 'NID_AUT', value: 'host-only', domain: 'naver.com', path: '/', secure: true, expires: -1 },
      { name: 'NID_SES', value: 'wrong-path', domain: '.naver.com', path: '/nidlogin.login', secure: true, expires: -1 },
    ], userAgent }) });
  const renew = f.calls.find(c => c.key === 'brandconnect.mjs renew-session');
  assert.deepEqual(renew.input, { cookies: [
    { name: 'NID_AUT', value: 'current-aut', domain: '.naver.com', path: '/', secure: true, expires: -1 },
    { name: 'NID_SES', value: 'current-ses', domain: '.naver.com', path: '/', secure: true, expires: -1 },
  ], userAgent });
  assert.equal(r.services.brandconnect.action, 'renewed_from_naver');
});

test('invalid observed Naver user agent prevents Brand Connect renew-session dispatch', async () => {
  const f = fakeExec({ 'naver-session-health.mjs': naverOk,
    'brandconnect.mjs health': { ok: false, code: 'REAUTH_REQUIRED' } });
  const r = await keep({ ...base, exec: f.exec, services: ['naver', 'brandconnect'],
    loadNaverSession: async () => ({ cookies: cookies(), userAgent: 'invalid\r\nInjected: header' }) });
  assert.equal(r.services.brandconnect.code, 'NAVER_USER_AGENT_INVALID');
  assert.ok(!f.calls.some(c => c.key === 'brandconnect.mjs renew-session'));
  assert.deepEqual(f.calls.map(c => c.key), ['naver-session-health.mjs', 'brandconnect.mjs health']);
});

test('missing Naver cookies triggers the maintained login before Brand Connect gets the rotated cookies', async () => {
  const f = fakeExec({
    'naver-session-health.mjs': [{ code: 'NAVER_AUTH_COOKIES_MISSING' }, naverOk],
    'naver-login-cli.mjs --reuse-session': { ok: true },
    'brandconnect.mjs health': [{ ok: false, code: 'REAUTH_REQUIRED' }, bcOk],
    'brandconnect.mjs renew-session': { ok: true },
    'cli.mjs status': tistoryOk,
    'web-auth.mjs linkprice': lpOk
  });
  let loginFinished = false;
  const exec = async (file, args, opts) => {
    const result = await f.exec(file, args, opts);
    if (path.basename(file) === 'naver-login-cli.mjs') loginFinished = true;
    return result;
  };
  const r = await keep({
    ...base,
    exec,
    loadCookies: async () => {
      assert.equal(loginFinished, true, 'Brand Connect must load cookies after Naver login completes');
      return [
        { name: 'NID_AUT', value: 'rotated-aut', domain: '.naver.com', path: '/', secure: true, expires: -1 },
        { name: 'NID_SES', value: 'rotated-ses', domain: '.naver.com', path: '/', secure: true, expires: -1 },
        { name: 'NNB', value: 'excluded', domain: '.naver.com', path: '/', secure: true, expires: -1 }
      ];
    }
  });
  assert.equal(r.services.naver.action, 'renewed');
  assert.equal(r.services.brandconnect.action, 'renewed_from_naver');
  assert.deepEqual(f.calls.find(c => c.key === 'naver-login-cli.mjs --reuse-session').args,
    ['--reuse-session', '--remember-session', '--challenge-codex']);
  assert.equal(f.calls.find(c => c.key === 'naver-login-cli.mjs --reuse-session').timeoutMs, 600000);
  const renew = f.calls.find(c => c.key === 'brandconnect.mjs renew-session');
  assert.deepEqual(renew.input.cookies.map(c => [c.name, c.value]), [['NID_AUT', 'rotated-aut'], ['NID_SES', 'rotated-ses']]);
  assert.deepEqual(f.calls.map(c => c.key).slice(0, 6), [
    'naver-session-health.mjs', 'naver-login-cli.mjs --reuse-session', 'naver-session-health.mjs',
    'brandconnect.mjs health', 'brandconnect.mjs renew-session', 'brandconnect.mjs health'
  ]);
});

test('an unresolved Codex image challenge stops renewal; Brand Connect does not receive a dead session', async () => {
  const f = fakeExec({ 'naver-session-health.mjs': { protectedOwnerRead: false, loginHTML: true }, 'naver-login-cli.mjs --reuse-session': { ok: false, code: 'LOGIN_IMAGE_UNREADABLE' },
    'brandconnect.mjs health': { ok: false, code: 'REAUTH_REQUIRED' }, 'cli.mjs status': [{ ok: false, code: 'TISTORY_REAUTH_REQUIRED' }, tistoryOk],
    'cli.mjs login': { ok: true }, 'web-auth.mjs linkprice': lpOk, 'threads-graph.mjs ensure': { ok: true, action: 'reused' } });
  const r = await keep({ ...base, exec: f.exec });
  assert.equal(r.allOk, false);
  assert.deepEqual(r.needsHuman.map(n => n.service), ['naver', 'brandconnect']);
  assert.equal(r.services.naver.code, 'LOGIN_IMAGE_UNREADABLE');
  assert.ok(!f.calls.some(c => c.key === 'brandconnect.mjs renew-session'));
  const logins = f.calls.filter(c => c.key.startsWith('naver-login-cli.mjs'));
  assert.equal(logins.length, 1);
  assert.deepEqual(logins[0].args, ['--reuse-session', '--remember-session', '--challenge-codex']);
  assert.equal(r.services.tistory.action, 'renewed');
});

test('returned login form after Codex analysis is not retried or passed to Brand Connect', async () => {
  const f = fakeExec({
    'naver-session-health.mjs': { code: 'NAVER_AUTH_COOKIES_MISSING' },
    'naver-login-cli.mjs --reuse-session': { ok: false, code: 'LOGIN_FORM_RETURNED', imageModelInvoked: true },
    'brandconnect.mjs health': { ok: false, code: 'REAUTH_REQUIRED' }
  });
  const result = await keep({ ...base, exec: f.exec, services: ['naver', 'brandconnect'],
    loadCookies: async () => assert.fail('No cookies may be propagated without fresh owner proof') });
  assert.equal(result.services.naver.ok, false);
  assert.equal(result.services.naver.code, 'LOGIN_FORM_RETURNED');
  assert.equal(result.services.naver.action, 'login_attempted');
  assert.equal(result.services.brandconnect.action, 'none');
  assert.equal(f.calls.filter(c => c.key === 'naver-login-cli.mjs --reuse-session').length, 1);
  assert.equal(f.calls.filter(c => c.key === 'naver-session-health.mjs').length, 2);
  assert.ok(!f.calls.some(c => c.key === 'brandconnect.mjs renew-session'));
});

test('account protection skips the Naver login entirely', async () => {
  const f = fakeExec({ 'brandconnect.mjs health': bcOk, 'cli.mjs status': tistoryOk, 'web-auth.mjs linkprice': lpOk });
  const r = await keep({ ...base, exec: f.exec, loginControl: async () => ({ blocked: true, code: 'ACCOUNT_PROTECTION_REQUIRED' }) });
  assert.equal(r.services.naver.code, 'ACCOUNT_PROTECTION_REQUIRED');
  assert.ok(!f.calls.some(c => c.key.startsWith('naver-')));
});

test('lastJson finds the final JSON object in mixed output', () => {
  assert.deepEqual(lastJson('npm noise\n{"a":1}\n{"b":{"c":2}}\n'), { b: { c: 2 } });
  assert.equal(lastJson('no json'), null);
});

test('transport failure, forbidden response and missing owner proof do not trigger password login', async () => {
  for (const failed of [{code:'TIMEOUT'}, {code:'AUTH_UNVERIFIED',httpStatus:403}, {protectedOwnerRead:true}]) {
    const f = fakeExec({ 'naver-session-health.mjs': failed, 'brandconnect.mjs health': bcOk,
      'cli.mjs status': {ok:false,code:'TISTORY_ACCESS_DENIED'}, 'web-auth.mjs linkprice': {ok:true} });
    const result=await keep({...base,exec:f.exec});
    assert.equal(result.services.naver.ok,false);
    assert.equal(result.services.tistory.ok,false);
    assert.equal(result.services.linkprice.ok,false);
    assert.ok(!f.calls.some(c=>c.key.startsWith('naver-login-cli')||c.key==='cli.mjs login'));
  }
});

test('check-only mode does not renew an explicitly expired session', async () => {
  const f=fakeExec({'naver-session-health.mjs':{code:'AUTH_MISSING'},'brandconnect.mjs health':{ok:false,code:'REAUTH_REQUIRED'},
    'cli.mjs status':{ok:false,code:'TISTORY_REAUTH_REQUIRED'},'web-auth.mjs linkprice':lpOk});
  const result=await keep({...base,exec:f.exec,allowRenewal:false});
  assert.equal(result.allOk,false);
  assert.ok(!f.calls.some(c=>/login|renew/.test(c.key)));
});

test('verified owner read with failed persistence does not pass stale cookies to Brand Connect', async () => {
  const f = fakeExec({
    'naver-session-health.mjs': { ...naverOk, code: 'CREDENTIAL_STORE_WRITE_FAILED' },
    'brandconnect.mjs health': { ok: false, code: 'REAUTH_REQUIRED' }
  });
  const result = await keep({ ...base, exec: f.exec, services: ['naver', 'brandconnect'],
    loadCookies: async () => assert.fail('Do not load stale cookies after a persistence failure') });
  assert.equal(result.services.naver.ok, false);
  assert.equal(result.services.naver.code, 'CREDENTIAL_STORE_WRITE_FAILED');
  assert.equal(result.services.brandconnect.ok, false);
  assert.ok(!f.calls.some(c => /login|renew/.test(c.key)));
});

test('scoped no-renewal checks skip credentials, other services and notification configuration', async () => {
  let loginControlCalls = 0;
  let cookieLoads = 0;
  const f = fakeExec({
    'naver-session-health.mjs': { code: 'NAVER_AUTH_COOKIES_MISSING' },
    'brandconnect.mjs health': { ok: false, code: 'REAUTH_REQUIRED' }
  });
  const result = await keep({
    ...base,
    exec: f.exec,
    services: ['naver', 'brandconnect'],
    allowRenewal: false,
    loginControl: async () => { loginControlCalls += 1; return { blocked: false }; },
    loadCookies: async () => { cookieLoads += 1; return cookies(); }
  });
  assert.deepEqual(Object.keys(result.services), ['naver', 'brandconnect']);
  assert.equal(result.services.naver.human, true);
  assert.equal(loginControlCalls, 0);
  assert.equal(cookieLoads, 0);
  assert.deepEqual(f.calls.map(c => c.key), ['naver-session-health.mjs', 'brandconnect.mjs health']);
  await assert.rejects(keep({ ...base, exec: f.exec, services: ['naver', 'invalid'] }), /INVALID_SERVICES/);
});

test('keeper CLI validates scope and rejects unknown or duplicated options before work', () => {
  assert.deepEqual(parseKeeperArgs(['--services=naver,brandconnect', '--no-renewal', '--no-notify']), {
    ok: true, out: undefined, services: ['naver', 'brandconnect'], allowRenewal: false, notify: false
  });
  assert.deepEqual(parseKeeperArgs(['--services=naver,unknown']), { ok: false, code: 'INVALID_SERVICES' });
  assert.deepEqual(parseKeeperArgs(['--services=naver,naver']), { ok: false, code: 'INVALID_SERVICES' });
  assert.deepEqual(parseKeeperArgs(['--services=naver', '--services=brandconnect']), { ok: false, code: 'INVALID_OPTIONS' });
  assert.deepEqual(parseKeeperArgs(['--out=report.json', '--out=other.json']), { ok: false, code: 'INVALID_OPTIONS' });
  assert.deepEqual(parseKeeperArgs(['--no-notfy']), { ok: false, code: 'INVALID_OPTIONS' });
  assert.deepEqual(parseKeeperArgs([]), {
    ok: true, out: undefined, services: ['naver', 'brandconnect', 'tistory', 'linkprice', 'threads'], allowRenewal: true, notify: true
  });
});
