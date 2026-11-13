import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgyRemoteClient, importAgyState, validateAgyState, decodeAgyInstances, decodeAgyProxy, AGY_ORIGIN, AGY_API } from '../lib/agy-remote.mjs';
import { AgyArrayFrames, agyConnectEnvelope, readAgySummarySnapshot } from '../lib/agy-remote-stream.mjs';
import { validateAgyCdpEndpoint, selectAgyTarget, agyBrowserOwnerExpression, waitAgyBrowserOwner } from '../lib/agy-remote-bootstrap.mjs';
import { createServiceRegistry } from '../lib/service-operations/index.mjs';
import { createHash } from 'node:crypto';
import { createAgyRemoteRuntime } from '../lib/agy-remote-runtime.mjs';

const A = '11111111-1111-4111-a111-111111111111';
const B = '22222222-2222-4222-a222-222222222222';
const EMAIL = 'owner@example.invalid';
const ORIGIN = AGY_ORIGIN;
const mime = { 'content-type': 'application/json+protobuf; charset=UTF-8' };
const response = value => new Response(JSON.stringify(value), { headers: mime });
const proxy = value => response([Buffer.from(JSON.stringify(value)).toString('base64'), [['content-type','application/json']]]);
const done = 'CASCADE_RUN_STATUS_IDLE';
function state() {
  return importAgyState({ expectedEmail: EMAIL, headers: { authorization: 'synthetic-auth', 'x-goog-api-key': 'synthetic-key' },
    cookies: [{ name: 'SID', value: 'synthetic-cookie', domain: '.google.com', path: '/', secure: true }] });
}
function summary(title = 'Synthetic') {
  return { summary: title, annotations: { title }, status: done, stepCount: 2,
    trajectoryMetadata: { projectId: 'project-a' }, lastModifiedTime: '2026-01-01T00:00:00Z' };
}
function streamResponse(updates, { pieces = 17, close = true, onCancel = () => {} } = {}) {
  const frame = [agyConnectEnvelope({ updates }).toString('base64'), [['content-type','application/connect+json']]];
  const raw = Buffer.from('[[' + JSON.stringify(frame) + (close ? '],[]]' : ','));
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < raw.length; offset += pieces) controller.enqueue(raw.subarray(offset, offset + pieces));
    if (close) controller.close();
  }, cancel: onCancel }), { headers: mime });
}
function fixture(options = {}) {
  const rows = { 'remote-a': { [A]: summary('A only') }, 'remote-b': { [B]: summary('B only') } };
  const steps = { [A]: [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: 'hello' }], clientMessageId: 'old-id' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'world', thinkingSignature: 'synthetic-internal' } },
  ], [B]: [] };
  const calls = [];
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl); assert.equal(url.origin, ORIGIN);
    const op = url.pathname.slice(AGY_API.length); const body = JSON.parse(init.body); calls.push({ op, body });
    if (op === 'ListInstances') return response([[
      ['remote-a', ['A', 'cli-synthetic-v2'], 1], ['remote-b', [options.duplicateName ? 'A' : 'B', 'cli-synthetic-v2'], 1],
      ['remote-offline', ['Offline', 'cli-synthetic-v2'], 2],
    ], 10]);
    assert.ok(rows[body[0]]);
    if (op === 'StreamProxyCommand') return streamResponse(rows[body[0]]);
    assert.equal(op, 'ProxyCommand');
    const method = body[1].split('/').at(-1); const input = JSON.parse(Buffer.from(body[2], 'base64').toString());
    const remote = body[0];
    if (method === 'GetUserStatus') return proxy({ userStatus: { email: options.wrongOwner ? 'other@example.invalid' : EMAIL } });
    if (method === 'GetAllCascadeTrajectories') return proxy({ trajectorySummaries: rows[remote] });
    if (method === 'GetCascadeModelConfigData') return proxy({ clientModelConfigs: [{ label: 'Synthetic model', modelOrAlias: { model: 'MODEL_TEST' }, modelId: 'synthetic' }] });
    if (method === 'ListProjects') return proxy({ projectIds: ['project-a'] });
    if (method === 'ReadProjects') return proxy({ projects: [{ id: 'project-a', name: 'Synthetic project' }] });
    if (method === 'StartCascade') {
      rows[remote][input.cascadeId] = summary('Created'); steps[input.cascadeId] = [];
      if (options.loseCreateResponse) throw new Error('synthetic-secret-that-must-not-escape');
      return proxy({ cascadeId: input.cascadeId });
    }
    if (method === 'GetCascadeTrajectory') {
      assert.ok(Object.hasOwn(rows[remote], input.cascadeId), 'cross-remote access must fail before this RPC');
      const all = steps[input.cascadeId] ?? [];
      return proxy({ trajectory: { cascadeId: input.cascadeId, steps: options.paginated ? all.slice(0, 1) : all,
        generatorMetadata: [{ syntheticSecret: 'synthetic-internal' }] }, status: rows[remote][input.cascadeId].status,
      ...(all.length ? { numTotalSteps: all.length } : {}) });
    }
    if (method === 'GetCascadeTrajectorySteps') return proxy({ steps: options.emptyStepPage ? [] : steps[input.cascadeId].slice(input.stepOffset) });
    if (method === 'SendUserCascadeMessage') {
      steps[input.cascadeId].push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE',
        userInput: { items: input.items, clientMessageId: input.clientMessageId } });
      steps[input.cascadeId].push({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: 'reply' } });
      if (options.loseSendResponse) throw new Error('synthetic-private-error');
      return proxy({});
    }
    if (method === 'UpdateConversationAnnotations') { rows[remote][input.cascadeIds[0]].annotations = input.annotations; return proxy({}); }
    if (method === 'CancelCascadeInvocation') { rows[remote][input.cascadeId].status = done; return proxy({}); }
    if (method === 'DeleteCascadeTrajectory') { delete rows[remote][input.cascadeId]; return proxy({}); }
    assert.fail('Unexpected method ' + method);
  };
  return { rows, steps, calls, fetchImpl };
}
async function temporary(fn) {
  const base = process.env.TMPDIR || path.join(os.homedir(), '.cache', 'playbook-tests');
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'agy-remote-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('CDP bootstrap rejects non-loopback URLs, redirects in URLs, foreign tabs and foreign sockets', () => {
  for (const value of ['https://localhost:9341','http://example.invalid:9341','http://127.0.0.1:9341/?x=1','http://u:p@127.0.0.1:9341'])
    assert.throws(() => validateAgyCdpEndpoint(value), { code: 'AGY_CDP_ENDPOINT_INVALID' });
  const base = validateAgyCdpEndpoint('http://127.0.0.1:9341');
  const target = { id: 'synthetic-tab', type: 'page', url: ORIGIN + '/remote', webSocketDebuggerUrl: 'ws://127.0.0.1:9341/devtools/page/synthetic-tab' };
  assert.equal(selectAgyTarget([target], base).id, target.id);
  assert.throws(() => selectAgyTarget([target, { ...target, id: 'second' }], base), { code: 'AGY_CDP_OWNED_TAB_REQUIRED' });
  assert.throws(() => selectAgyTarget([{ ...target, url: 'https://example.invalid/' }], base), { code: 'AGY_CDP_OWNED_TAB_REQUIRED' });
  assert.throws(() => selectAgyTarget([{ ...target, webSocketDebuggerUrl: 'ws://example.invalid:9341/devtools/page/synthetic-tab' }], base), { code: 'AGY_CDP_TARGET_INVALID' });
});
test('the browser owner check matches an exact email instead of an email-shaped substring', () => {
  const evaluate = label => Function('document', `return ${agyBrowserOwnerExpression(EMAIL)}`)({ querySelectorAll: () => [{ getAttribute: () => label }] });
  assert.equal(evaluate(`Google Account: Synthetic (${EMAIL})`), true);
  assert.equal(evaluate(`Google Account: Synthetic (${EMAIL}.attacker.invalid)`), false);
  assert.equal(evaluate(`Other text: ${EMAIL}`), false);
});
test('a loading app is owner-unverified while an identified different account is an immediate mismatch', async () => {
  let calls = 0, time = 0;
  const loading = { send: async () => ({ result: { value: ++calls > 1 ? { matched: true, identified: true } : { matched: false, identified: false } } }) };
  await waitAgyBrowserOwner(loading, EMAIL, { now: () => time, sleep: async ms => { time += ms; } }); assert.equal(calls, 2);
  await assert.rejects(waitAgyBrowserOwner({ send: async () => ({ result: { value: { matched: false, identified: true } } }) }, EMAIL), { code: 'AGY_BROWSER_OWNER_MISMATCH' });
  time = 0;
  await assert.rejects(waitAgyBrowserOwner({ send: async () => ({ result: { value: { matched: false, identified: false } } }) }, EMAIL,
    { timeoutMs: 1, now: () => time, sleep: async ms => { time += ms; } }), { code: 'AGY_BROWSER_OWNER_UNVERIFIED' });
});
test('session state keeps cookies and authorization scoped to the one approved origin', () => {
  const s = state(); assert.deepEqual(s.session.allowedOrigins, [ORIGIN]);
  assert.throws(() => validateAgyState({ ...s, session: { ...s.session, allowedOrigins: [ORIGIN, 'https://example.invalid'] } }), { code: 'AGY_STATE_INVALID' });
  assert.throws(() => validateAgyState({ ...s, session: { ...s.session, maxRedirects: 1 } }), { code: 'AGY_STATE_INVALID' });
  assert.throws(() => validateAgyState({ ...s, session: { ...s.session, headersByOrigin: { ...s.session.headersByOrigin, 'https://example.invalid': {} } } }), { code: 'AGY_STATE_INVALID' });
});
test('browser login HTML, auth rejection, and wrong-account reads are distinct failures', async () => {
  for (const [reply, code] of [[new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), 'AGY_AUTH_OR_RESPONSE_INVALID'],
    [new Response('', { status: 401 }), 'AGY_REAUTH_REQUIRED'], [new Response('', { status: 403 }), 'AGY_FORBIDDEN']]) {
    await assert.rejects(createAgyRemoteClient({ state: state(), fetchImpl: async () => reply }).instances(), { code });
  }
  const f = fixture({ wrongOwner: true });
  await assert.rejects(createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl }).sessions('A'), { code: 'AGY_OWNER_MISMATCH' });
  assert.equal(f.calls.some(x => x.op === 'StreamProxyCommand'), false);
});
test('unknown, ambiguous, and offline remotes fail before any remote RPC', async () => {
  for (const [f, selector, code] of [[fixture(), 'missing', 'AGY_REMOTE_NOT_FOUND'], [fixture(), 'Offline', 'AGY_REMOTE_OFFLINE'],
    [fixture({ duplicateName: true }), 'A', 'AGY_REMOTE_AMBIGUOUS']]) {
    await assert.rejects(createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl }).owner(selector), { code });
    assert.equal(f.calls.length, 1);
  }
});
test('instance and proxy decoders reject malformed identities and application errors hidden in HTTP 200', () => {
  assert.throws(() => decodeAgyInstances([[['x',['A'],1],['x',['B'],1]]]), { code: 'AGY_INSTANCES_SCHEMA' });
  assert.throws(() => decodeAgyProxy([Buffer.from('{}').toString('base64'), [['grpc-status','7']]]), { code: 'AGY_REMOTE_REJECTED' });
  assert.throws(() => decodeAgyProxy([Buffer.from('{"error":{"message":"synthetic"}}').toString('base64'), []]), { code: 'AGY_REMOTE_REJECTED' });
});
test('native persisted summaries merge with loaded trajectories and are paginated without claiming a full stream barrier', async () => {
  const f = fixture(); f.rows['remote-a'][B] = summary('Another local conversation');
  const client = createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl });
  const first = await client.sessions('A', { limit: 1 });
  assert.equal(first.observedCount, 2); assert.equal(first.sessions.length, 1); assert.ok(first.nextCursor); assert.equal(first.complete, false);
  const last = await client.sessions('A', { limit: 1, cursor: first.nextCursor });
  assert.equal(last.sessions.length, 1); assert.equal(last.nextCursor, null); assert.notEqual(first.sessions[0].id, last.sessions[0].id);
  await assert.rejects(client.sessions('B', { cursor: first.nextCursor }), { code: 'AGY_CURSOR_STALE_OR_WRONG_REMOTE' });
});
test('a conversation from a different remote never reaches its trajectory endpoint', async () => {
  const f = fixture(); const client = createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl });
  await client.read('A', A);
  await assert.rejects(client.read('B', A), { code: 'AGY_CONVERSATION_NOT_IN_REMOTE' });
  assert.equal(f.calls.filter(x => x.op === 'ProxyCommand' && x.body[0] === 'remote-b' && x.body[1].endsWith('/GetCascadeTrajectory')).length, 0);
});
test('trajectory pagination follows offsets and omits generator internals and thinking signatures', async () => {
  const f = fixture({ paginated: true }); const result = await createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl }).read('A', A);
  assert.deepEqual(result.conversation.messages.map(x => x.text), ['hello', 'world']);
  assert.equal(result.conversation.complete, true); assert.equal(JSON.stringify(result).includes('synthetic-internal'), false);
  const next = f.calls.find(x => x.op === 'ProxyCommand' && x.body[1].endsWith('/GetCascadeTrajectorySteps'));
  assert.equal(JSON.parse(Buffer.from(next.body[2], 'base64')).stepOffset, 1);
  const bad = fixture({ paginated: true, emptyStepPage: true });
  await assert.rejects(createAgyRemoteClient({ state: state(), fetchImpl: bad.fetchImpl }).read('A', A), { code: 'AGY_TRAJECTORY_INCOMPLETE' });
});
test('all writes require explicit confirmation, a journal and a stable caller intent before network use', async () => {
  const f = fixture(); const client = createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl });
  await assert.rejects(client.send({ remote: 'A', id: A, prompt: 'hello', intent: 'one' }), { code: 'AGY_CONFIRM_REQUIRED' });
  await assert.rejects(client.send({ remote: 'A', id: A, prompt: 'hello', intent: 'one', confirm: 'CONFIRM' }), { code: 'AGY_JOURNAL_REQUIRED' });
  assert.equal(f.calls.length, 0);
});
test('create, message continuation, rename, cancellation and deletion reconcile through independent reads', () => temporary(async root => {
  const f = fixture(); const client = createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl, journalRoot: root });
  const created = await client.create({ remote: 'A', projectId: 'project-a', model: 'MODEL_TEST', title: 'Fresh title', intent: 'create-one', confirm: 'CONFIRM' });
  assert.match(created.id, /^[0-9a-f-]{36}$/); assert.equal(created.verified, true);
  const sent = await client.send({ remote: 'A', id: created.id, prompt: 'first message', intent: 'send-one', confirm: 'CONFIRM' });
  const second = await client.send({ remote: 'A', id: created.id, prompt: 'follow-up', intent: 'send-two', confirm: 'CONFIRM' });
  assert.notEqual(sent.clientMessageId, second.clientMessageId);
  const read = await client.read('A', created.id);
  assert.equal(read.conversation.messages.filter(x => x.role === 'user').length, 2);
  assert.equal((await client.wait({ remote: 'A', id: created.id })).succeeded, true);
  assert.equal((await client.cancel({ remote: 'A', id: created.id, intent: 'cancel', confirm: 'CONFIRM' })).verified, true);
  assert.equal((await client.remove({ remote: 'A', id: created.id, intent: 'delete', confirm: 'CONFIRM' })).verified, true);
  assert.ok(f.calls.some(x => x.op === 'StreamProxyCommand'));
}));
test('the same send intent cannot be resent by a second client process, and journals contain hashes instead of prompt or credentials', () => temporary(async root => {
  const f = fixture(); const make = () => createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl, journalRoot: root });
  const input = { remote: 'A', id: A, prompt: 'private test message', intent: 'same-send', confirm: 'CONFIRM' };
  await make().send(input);
  await assert.rejects(make().send(input), { code: 'WRITE_JOURNAL_EXISTS' });
  assert.equal(f.calls.filter(x => x.op === 'ProxyCommand' && x.body[1].endsWith('/SendUserCascadeMessage')).length, 1);
  for (const file of await readdir(path.join(root, 'agy-remote'))) {
    const raw = await readFile(path.join(root, 'agy-remote', file), 'utf8');
    assert.equal(raw.includes(input.prompt), false); assert.equal(raw.includes('synthetic-auth'), false); assert.equal(raw.includes('synthetic-cookie'), false);
  }
}));
test('a lost create response is outcome-unknown and resumes by read-only reconciliation without another create', () => temporary(async root => {
  const f = fixture({ loseCreateResponse: true }); const c = createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl, journalRoot: root });
  let key;
  try { await c.create({ remote: 'A', projectId: 'project-a', model: 'MODEL_TEST', intent: 'lost-response', confirm: 'CONFIRM' }); assert.fail(); }
  catch (error) { assert.equal(error.code, 'AGY_WRITE_OUTCOME_UNKNOWN'); key = error.journalKey; assert.equal(error.message.includes('synthetic-secret'), false); }
  const before = f.calls.filter(x => x.op === 'ProxyCommand' && x.body[1].endsWith('/StartCascade')).length;
  const result = await c.reconcile({ remote: 'A', journalKey: key }); assert.equal(result.found, true); assert.equal(result.writesExecuted, false);
  assert.equal(f.calls.filter(x => x.op === 'ProxyCommand' && x.body[1].endsWith('/StartCascade')).length, before);
  await assert.rejects(c.reconcile({ remote: 'B', journalKey: key }), { code: 'AGY_JOURNAL_REMOTE_MISMATCH' });
}));
test('expired bootstrap is not silently refreshed and a wait timeout preserves the conversation ID without resubmission', async () => {
  const f = fixture(); const s = state();
  await assert.rejects(createAgyRemoteClient({ state: s, fetchImpl: f.fetchImpl, now: () => Date.parse(s.importedAt) + 3600001 }).instances(), { code: 'AGY_BOOTSTRAP_REQUIRED' });
  assert.equal(f.calls.length, 0);
  const waitingState = state(); let time = Date.parse(waitingState.importedAt); f.rows['remote-a'][A].status = 'CASCADE_RUN_STATUS_RUNNING';
  const result = await createAgyRemoteClient({ state: waitingState, fetchImpl: f.fetchImpl, now: () => time, sleep: async ms => { time += ms; } }).wait({ remote: 'A', id: A, timeoutMs: 1000 });
  assert.equal(result.timeout, true); assert.equal(result.conversation.id, A);
  assert.equal(f.calls.some(x => x.op === 'ProxyCommand' && /StartCascade|SendUserCascadeMessage/.test(x.body[1])), false);
});
test('an idle failed trajectory is not reported as successful work', async () => {
  const f = fixture(); f.steps[A].push({ type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_ERROR' });
  const result = await createAgyRemoteClient({ state: state(), fetchImpl: f.fetchImpl }).wait({ remote: 'A', id: A });
  assert.equal(result.completed, true); assert.equal(result.succeeded, false); assert.equal(result.conversation.errors.length, 1);
});
test('Google streaming JSON is parsed across every character boundary, including escapes', () => {
  const frames = [['payload\\"text', [['content-type','application/json']]], ['next']];
  const parser = new AgyArrayFrames(); const out = [];
  for (const c of '[[' + frames.map(x => JSON.stringify(x)).join(',') + '],[]]') out.push(...parser.push(c));
  assert.deepEqual(out, frames); assert.equal(parser.pending, false);
  assert.throws(() => new AgyArrayFrames(5).push('[[["too large"]'), { code: 'AGY_STREAM_SIZE' });
});
test('stream snapshots merge batches and deletes, cancel a live subscription, and retain the incomplete-coverage label', async () => {
  const frames = [{ updates: { [A]: summary() } }, { updates: { [B]: summary() }, deletes: [A] }];
  const raw = '[[' + frames.map(x => JSON.stringify([agyConnectEnvelope(x).toString('base64')])).join(',') + ',';
  let cancelled = false;
  const r = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(raw)); }, cancel() { cancelled = true; } }));
  const result = await readAgySummarySnapshot(r, { idleMs: 1 });
  assert.deepEqual(Object.keys(result.updates), [B]); assert.deepEqual(result.deletes, [A]);
  assert.equal(result.observation.receivedBatches, 2); assert.equal(result.observation.complete, false); assert.equal(cancelled, true);
});
test('truncated stream messages and framed native errors cannot produce successful snapshots', async () => {
  await assert.rejects(readAgySummarySnapshot(new Response('[[["incomplete')), { code: 'AGY_STREAM_SNAPSHOT_INCOMPLETE' });
  const data = agyConnectEnvelope({ error: { code: 'permission_denied' } }); data[0] = 2;
  await assert.rejects(readAgySummarySnapshot(new Response('[[[' + JSON.stringify(data.toString('base64')) + ']],[]]')), { code: 'AGY_STREAM_REMOTE_REJECTED' });
});
test('several Connect messages coalesced in one proxy frame are all decoded', async () => {
  const bytes = Buffer.concat([agyConnectEnvelope({ updates: { [A]: summary() } }), agyConnectEnvelope({ updates: { [B]: summary() } })]);
  const r = new Response('[[[' + JSON.stringify(bytes.toString('base64')) + ']],[]]');
  const result = await readAgySummarySnapshot(r); assert.equal(Object.keys(result.updates).length, 2);
  assert.equal(result.observation.receivedBatches, 2);
});
test('the common playbook registry exposes typed reads and cannot dispatch a writer', async () => {
  const f = fixture(); const registry = await createServiceRegistry('agy-remote', { credentialProvider: async () => state(), fetchImpl: f.fetchImpl });
  try {
    assert.deepEqual(registry.list().map(x => x.name ?? x.id).sort(), ['conversation','models','owner','projects','remotes','sessions']);
    const result = await registry.execute('owner', { query: { remote: 'A' } });
    assert.equal(result.data.ownerVerified, true); assert.equal(result.receipt.networkUsed, true);
    await assert.rejects(registry.execute('owner', { query: { remote: 'A', prompt: 'not allowed' } }));
    await assert.rejects(registry.execute('send', { query: { remote: 'A' } }));
    assert.equal(f.calls.some(x => x.op === 'ProxyCommand' && /StartCascade|SendUserCascadeMessage/.test(x.body[1])), false);
  } finally { await registry.close(); }
  assert.throws(() => registry.execute('owner', { query: { remote: 'A' } }), { code: 'SERVICE_REGISTRY_CLOSED' });
});
test('only a verified first-party signature is refreshed from valid scoped cookies, without a browser or an HTTP retry', async () => {
  const initial = Date.now(), timestamp = Math.floor(initial / 1000), cookie = 'synthetic-signing-cookie';
  const hash = createHash('sha1').update(`${timestamp} ${cookie} ${AGY_ORIGIN}`).digest('hex');
  const s = importAgyState({ expectedEmail: EMAIL, headers: { authorization: `SAPISIDHASH ${timestamp}_${hash}`, 'x-goog-api-key': 'synthetic-key' },
    cookies: [{ name: 'SAPISID', value: cookie, domain: '.google.com', path: '/', secure: true }] }, { now: () => initial });
  assert.equal(s.authMode, 'google_first_party_signature');
  let calls = 0; const later = initial + 2 * 60 * 60 * 1000;
  const client = createAgyRemoteClient({ state: s, now: () => later, fetchImpl: async (url, init) => {
    calls++; const auth = new Headers(init.headers).get('authorization');
    const expected = createHash('sha1').update(`${Math.floor(later / 1000)} ${cookie} ${AGY_ORIGIN}`).digest('hex');
    assert.equal(auth, `SAPISIDHASH ${Math.floor(later / 1000)}_${expected}`);
    return response([[],10]);
  } });
  await client.instances(); assert.equal(calls, 1);
  const bad = importAgyState({ expectedEmail: EMAIL, headers: { authorization: `SAPISIDHASH ${timestamp}_${'0'.repeat(40)}`, 'x-goog-api-key': 'synthetic-key' },
    cookies: [{ name: 'SAPISID', value: cookie, domain: '.google.com', path: '/', secure: true }] });
  assert.equal(bad.authMode, undefined);
});
function maintainedState() {
  return { ...state(), maintenance: { endpoint: 'http://127.0.0.1:9341/', tabId: 'synthetic-tab', ownerRemote: 'A', maxAgeMs: 300000 } };
}
test('trusted cookie maintenance retries a rejected safe read once and verifies the same owner', async () => {
  const f = fixture(); let requests = 0, syncs = 0;
  const runtime = createAgyRemoteRuntime({ state: maintainedState(), remote: 'A', allowMaintenance: true,
    fetchImpl: async (...args) => ++requests === 1 ? new Response('', { status: 401 }) : f.fetchImpl(...args),
    syncImpl: async ({ state: current }) => { syncs++; return { state: current, receipt: { usedBrowser: true } }; } });
  assert.equal((await runtime.run(c => c.owner('A'))).ownerVerified, true); assert.equal(syncs, 1);
  assert.equal(runtime.maintenance.usedBrowser, true);
});
test('untrusted credential providers never activate operator-browser maintenance', async () => {
  let syncs = 0;
  const runtime = createAgyRemoteRuntime({ state: maintainedState(), remote: 'A', allowMaintenance: false,
    fetchImpl: async () => new Response('', { status: 401 }), syncImpl: async () => { syncs++; } });
  await assert.rejects(runtime.run(c => c.owner('A')), { code: 'AGY_REAUTH_REQUIRED' }); assert.equal(syncs, 0);
});
test('a writer timeout is not retried by the runtime and a second failed auth read cannot loop', () => temporary(async root => {
  const f = fixture({ loseSendResponse: true }); let syncs = 0;
  const runtime = createAgyRemoteRuntime({ state: maintainedState(), remote: 'A', allowMaintenance: true, journalRoot: root,
    fetchImpl: f.fetchImpl, syncImpl: async () => { syncs++; } });
  await assert.rejects(runtime.run(c => c.send({ remote: 'A', id: A, prompt: 'one', intent: 'only-once', confirm: 'CONFIRM' }), { write: true }), { code: 'AGY_WRITE_OUTCOME_UNKNOWN' });
  assert.equal(syncs, 0); assert.equal(f.calls.filter(x => x.op === 'ProxyCommand' && x.body[1].endsWith('/SendUserCascadeMessage')).length, 1);
  const stale = createAgyRemoteRuntime({ state: maintainedState(), remote: 'A', allowMaintenance: true,
    fetchImpl: async () => new Response('', { status: 401 }),
    syncImpl: async ({ state: current }) => { syncs++; return { state: current, receipt: { usedBrowser: true } }; } });
  await assert.rejects(stale.run(c => c.owner('A')), { code: 'AGY_REAUTH_REQUIRED' }); assert.equal(syncs, 1);
}));
test('cookie maintenance cannot silently switch the configured owner', async () => {
  const runtime = createAgyRemoteRuntime({ state: maintainedState(), remote: 'A', allowMaintenance: true,
    fetchImpl: async () => new Response('', { status: 401 }),
    syncImpl: async ({ state: current }) => ({ state: { ...current, expectedEmail: 'other@example.invalid' }, receipt: { usedBrowser: true } }) });
  await assert.rejects(runtime.run(c => c.owner('A')), { code: 'AGY_OWNER_MISMATCH' });
});
test('a long-lived runtime can refresh on later operations while retaining one refresh per operation', async () => {
  const f = fixture(); let syncs = 0; const s = maintainedState();
  const runtime = createAgyRemoteRuntime({ state: s, remote: 'A', allowMaintenance: true, now: () => Date.now() + 600000,
    fetchImpl: f.fetchImpl, syncImpl: async ({ state: current }) => { syncs++; return { state: current, receipt: { usedBrowser: true } }; } });
  await runtime.run(c => c.owner('A')); await runtime.run(c => c.owner('A')); assert.equal(syncs, 2);
});
