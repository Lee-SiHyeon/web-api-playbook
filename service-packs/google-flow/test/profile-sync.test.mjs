import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedProfileCookies, assertProfileOwner, syncFromProfile, verifyProfileBundle } from '../src/profile-sync.mjs';
import { hiddenProfileArgs, resolveProfileEndpoint } from '../src/profile-cdp.mjs';
import { startFlowWithRecovery } from '../src/start-with-recovery.mjs';

const PROJECT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNER = 'fixture-owner@example.invalid';
const cookie = (domain, name = 'SID') => ({ name, value: 'synthetic-test-value', domain,
  path: '/', secure: true, httpOnly: true, session: true, expires: -1 });

function harness() {
  const flow = JSON.stringify({ version: 1, origin: 'https://flow.google.com', projectId: PROJECT, cookies: [cookie('.google.com')] });
  const google = JSON.stringify({ version: 1, origin: 'https://accounts.google.com', serviceOrigin: 'https://flow.google.com',
    owner: OWNER, projectId: PROJECT, capturedAt: new Date().toISOString(), cookies: [{ ...cookie('.google.com'), hostOnly: false }] });
  const store = new Map([['google-flow-session-v1', flow], ['google-flow-google-auth-v1', google]]);
  const calls = [];
  const writes = [];
  let closed = false;
  const cdp = { close() { closed = true; }, async send(method, params) {
    calls.push({ method, params });
    if (method === 'Target.createTarget') return { targetId: 'own-target' };
    if (method === 'Target.attachToTarget') return { sessionId: 'own-session' };
    if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ host: 'flow.google.com', ready: 'complete', challenge: false }) } };
    if (method === 'Network.getCookies') return { cookies: [cookie('.google.com'), cookie('unrelated.example.invalid'), cookie('flow.google.com','OSID')] };
    return {};
  } };
  const options = { connectImpl: async () => cdp, readCredentialImpl: n => store.get(n),
    writeCredentialImpl(n, v) { writes.push(n); store.set(n, v); },
    verifyImpl: async bundle => ({ bundle, projectMediaCount: 12 }) };
  return { store, calls, writes, options, get closed() { return closed; } };
}

test('profile cookies exclude unrelated, host-only Google, expired, path-mismatched and partitioned entries', () => {
  const result = scopedProfileCookies([cookie('.google.com'), cookie('google.com'), cookie('flow.google.com','OSID'),
    cookie('accounts.google.com'), cookie('.unrelated.invalid'), { ...cookie('.google.com','expired'), session: false, expires: 1 },
    { ...cookie('.google.com','partitioned'), partitionKey: {} }, { ...cookie('.google.com','wrongpath'), path: '/other' }],
  `https://flow.google.com/project/${PROJECT}`);
  assert.deepEqual(result.map(c => c.name), ['SID','OSID']);
  assert.equal(result[0].hostOnly, false);
});

test('owner verification requires exactly one expected owner and never exposes either value', () => {
  assertProfileOwner(`{"oPEP7c":"${OWNER}"}`, OWNER);
  for (const html of ['', '{"oPEP7c":"wrong@example.invalid"}', `{"oPEP7c":"${OWNER}","oPEP7c":"${OWNER}"}`]) {
    assert.throws(() => assertProfileOwner(html, OWNER), e => e.code === 'FLOW_PROFILE_OWNER_MISMATCH' && !e.message.includes(OWNER));
  }
});

test('sync validates a protected read before writing both DPAPI records and closes only its own target', async () => {
  const h = harness();
  let verified = false;
  h.options.verifyImpl = async bundle => { verified = true; assert.equal(h.writes.length, 0); return { bundle, projectMediaCount: 12 }; };
  const receipt = await syncFromProfile(h.options);
  assert.equal(verified, true); assert.equal(receipt.projectMediaCount, 12);
  assert.deepEqual(h.writes, ['google-flow-session-v1','google-flow-google-auth-v1']);
  assert.equal(h.closed, true);
  assert.equal(h.calls.some(c => /getAllCookies|getTargets|setCookies/.test(c.method)), false);
  assert.equal(h.calls.at(-1).method, 'Target.closeTarget');
  assert.equal(h.calls.at(-1).params.targetId, 'own-target');
  assert.equal(JSON.stringify(receipt).includes('synthetic-test-value'), false);
});

test('failed read or wrong owner leaves existing DPAPI untouched and cleans up the connection', async () => {
  const h = harness(); const before = new Map(h.store);
  h.options.verifyImpl = async () => { throw Object.assign(new Error('fixture-private-value'), { code: 'FLOW_PROFILE_OWNER_MISMATCH' }); };
  await assert.rejects(syncFromProfile(h.options), { code: 'FLOW_PROFILE_OWNER_MISMATCH' });
  assert.deepEqual(h.store, before); assert.equal(h.writes.length, 0); assert.equal(h.closed, true);
});

test('concurrent protected-store replacement rejects a stale browser snapshot', async () => {
  const h = harness();
  h.options.verifyImpl = async bundle => { h.store.set('google-flow-session-v1', 'concurrent-replacement'); return { bundle, projectMediaCount: 12 }; };
  await assert.rejects(syncFromProfile(h.options), { code: 'FLOW_PROFILE_STORE_CHANGED' });
  assert.equal(h.writes.length, 0);
});

test('second protected write failure reports the partial commit and retains verified Flow cookies', async () => {
  const h = harness(); const original = h.store.get('google-flow-google-auth-v1');
  const write = h.options.writeCredentialImpl;
  h.options.writeCredentialImpl = (n, v) => { if (n === 'google-flow-google-auth-v1') throw new Error('fixture'); write(n,v); };
  await assert.rejects(syncFromProfile(h.options), e => e.code === 'FLOW_PROFILE_PARTIAL_COMMIT' && e.flowStored && !e.googleAuthStored);
  assert.equal(h.store.get('google-flow-google-auth-v1'), original);
  assert.deepEqual(h.writes, ['google-flow-session-v1']);
});

test('candidate owner mismatch is checked before the protected RPC or any persistent write', async () => {
  let requests = 0;
  const bundle = { version: 1, origin: 'https://flow.google.com', projectId: PROJECT, cookies: [cookie('.google.com')] };
  await assert.rejects(verifyProfileBundle(bundle, OWNER, { fetchImpl: async () => {
    requests += 1; return new Response('{"oPEP7c":"wrong@example.invalid"}', { headers: { 'content-type': 'text/html' } });
  } }), { code: 'FLOW_PROFILE_OWNER_MISMATCH' });
  assert.equal(requests, 1);
});

test('an occupied non-debuggable profile is never killed, restarted, copied, or relaunched', async () => {
  let launched = false, fetched = false;
  await assert.rejects(resolveProfileEndpoint({ profileDir: 'C:\\fixture-profile', launch: true,
    inspectImpl: () => ({ pid: 5, debug: false, port: -1 }), launchImpl: async () => { launched = true; },
    fetchImpl: async () => { fetched = true; } }), { code: 'FLOW_PROFILE_NOT_DEBUGGABLE' });
  assert.equal(launched, false); assert.equal(fetched, false);
  assert.equal(hiddenProfileArgs('C:\\fixture-profile').some(a => /AutomationControlled|remote-allow-origins|disable-web-security|no-sandbox|enable-automation/.test(a)), false);
});

test('CDP endpoint rejects a remote debugger URL before connection', async () => {
  await assert.rejects(resolveProfileEndpoint({ inspectImpl: () => ({ pid: 5, debug: true, port: 9999 }),
    fetchImpl: async () => ({ status: 200, json: async () => ({ webSocketDebuggerUrl: 'ws://remote.invalid:9999/devtools/browser/id' }) }) }),
  { code: 'FLOW_PROFILE_CDP_UNAVAILABLE' });
});

test('startup falls back from rejected HTTP SSO to one profile sync before another start', async () => {
  let starts = 0, syncs = 0, recoveries = 0;
  const client = { async start() { if (++starts === 1) throw Object.assign(new Error(), { code: 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING' }); } };
  await startFlowWithRecovery(client, { credentialExistsImpl: () => true,
    recoverImpl: async () => { recoveries++; throw Object.assign(new Error(), { code: 'FLOW_SSO_RECOVERY_LOGIN_REQUIRED' }); },
    syncImpl: async () => { syncs++; return { mode: 'browser_assisted_session_sync' }; } });
  assert.equal(starts, 2); assert.equal(syncs, 1); assert.equal(recoveries, 1);
});

test('startup does not invoke a browser sync for healthy sessions or unrelated recovery failures', async () => {
  let syncs = 0;
  await startFlowWithRecovery({ start: async () => {} }, { syncImpl: async () => { syncs++; } });
  await assert.rejects(startFlowWithRecovery({ start: async () => { throw Object.assign(new Error(), { code: 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING' }); } },
    { credentialExistsImpl: () => true, recoverImpl: async () => { throw Object.assign(new Error(), { code: 'FLOW_SSO_RECOVERY_OWNER_MISMATCH' }); },
      syncImpl: async () => { syncs++; } }), { code: 'FLOW_SSO_RECOVERY_OWNER_MISMATCH' });
  assert.equal(syncs, 0);
});

test('a document still rejected after HTTP recovery receives one bounded profile sync', async () => {
  let starts=0, syncs=0;
  await startFlowWithRecovery({async start(){if(++starts<3)throw Object.assign(new Error(),{code:'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING'});}},
    {credentialExistsImpl:()=>true,recoverImpl:async()=>({hops:[]}),syncImpl:async()=>{syncs++;return {};}});
  assert.equal(starts,3);assert.equal(syncs,1);
});

test('continued rejection after profile sync cannot loop or attempt another recovery', async () => {
  let starts=0,syncs=0,recoveries=0;
  await assert.rejects(startFlowWithRecovery({async start(){starts++;throw Object.assign(new Error(),{code:'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING'});}},
    {credentialExistsImpl:()=>true,recoverImpl:async()=>{recoveries++;return {hops:[]};},syncImpl:async()=>{syncs++;return {};}}),
  {code:'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING'});
  assert.equal(starts,3);assert.equal(syncs,1);assert.equal(recoveries,1);
});
