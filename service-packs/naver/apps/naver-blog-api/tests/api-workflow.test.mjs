import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ApiWorkflow } from '../tools/discovery/api-workflow.mjs';
import { HeadlessAuth, ADMIN_ROOT } from '../tools/discovery/headless-auth.mjs';
import { resourceId } from '../tools/discovery/editor-contracts.mjs';

const cookies = () => ['NID_AUT', 'NID_SES'].map(name => ({ name, value: 'synthetic-' + name, domain: '.naver.com', path: '/', secure: true, expires: -1 }));
const root = '<a href="/4053103/config/bloginfo">settings</a><a href="/4053103/stat/today">stats</a><a href="https://blog.naver.com/PostWriteForm.naver?blogId=4053103">editor</a>';
const document = body => new Response(body, { headers: { 'content-type': 'text/html' } });
const input = { operation: 'daily/cv', query: { timeDimension: 'fixture', startDate: 'fixture', exclude: '', _: 'fixture' } };
const json = () => Response.json({ statusCode: 200, result: { statDataList: [] } });

function authenticatedFixture() {
  const auth = new HeadlessAuth();
  auth.cookies = cookies(); let closes = 0;
  auth.browser = { close: async () => { closes++; } };
  return { auth, closes: () => closes };
}

test('workflow import and construction do not launch a browser or issue HTTP', async () => {
  const workflow = new ApiWorkflow({ fetchImpl: async () => assert.fail('No HTTP without authentication') });
  assert.equal(workflow.status().browserOpen, false);
  assert.equal(workflow.status().authenticatedHTTP, false);
  await assert.rejects(workflow.api(input), { code: 'AUTH_MISSING' });
  await assert.rejects(workflow.inspect(), { code: 'AUTH_MISSING' });
  await workflow.close();
});

test('normal-login result hands off in memory, closes browser, then calls API through Node transport', async () => {
  const fixture = authenticatedFixture();
  fixture.auth.cookies = [];
  fixture.auth.login = async credentials => {
    assert.equal(credentials.username, '4053103');
    fixture.auth.cookies = cookies();
    return { classification: 'session_issued_unverified' };
  };
  const calls = [];
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    if (url === ADMIN_ROOT) return document(root);
    assert.equal(fixture.auth.browser, null, 'Browser must already be closed before the API call');
    assert.match(new Headers(init.headers).get('cookie'), /NID_SES=synthetic-NID_SES/);
    return json();
  } });
  const result = await workflow.login({ username: '4053103', password: 'synthetic-password' });
  assert.equal(result.apiOnly, true); assert.equal(result.authenticatedHTTP, true);
  assert.equal(fixture.closes(), 1); assert.deepEqual(fixture.auth.cookies, []);
  const receipt = await workflow.api(input);
  assert.equal(receipt.applicationStatus, 200); assert.equal(receipt.browserUsedForRequest, false);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(workflow.evidence()), /synthetic|password/);
  await workflow.close();
});

test('successful handoff incorporates root Set-Cookie before closing the browser', async () => {
  const fixture = authenticatedFixture();
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async (url, init) => {
    if (url === ADMIN_ROOT) {
      const response = document(root); response.headers.append('set-cookie', 'NID_SES=synthetic-renewed; Domain=.naver.com; Path=/; Secure'); return response;
    }
    assert.match(new Headers(init.headers).get('cookie'), /synthetic-renewed/); return json();
  } });
  await workflow.enableHTTP(); await workflow.api(input); await workflow.close();
});

test('CAPTCHA or extra verification stops before handoff and never retries login automatically', async () => {
  for (const classification of ['captcha_required', 'additional_verification_required', 'credentials_rejected', 'account_protection']) {
    const auth = new HeadlessAuth(); let loginCalls = 0;
    auth.login = async () => { loginCalls++; return { classification }; };
    const workflow = new ApiWorkflow({ auth, fetchImpl: async () => assert.fail('No HTTP on login challenge') });
    assert.equal((await workflow.login({ username: '4053103', password: 'synthetic-only' })).classification, classification);
    assert.equal(workflow.status().authenticatedHTTP, false); assert.equal(loginCalls, 1);
    await workflow.close();
  }
});

test('failed account-root verification closes browser and discards candidate session', async () => {
  const fixture = authenticatedFixture();
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async () => document('<html>public fallback</html>') });
  await assert.rejects(workflow.enableHTTP(), { code: 'AUTH_UNVERIFIED' });
  assert.equal(workflow.status().authenticatedHTTP, false); assert.equal(fixture.closes(), 1);
  assert.deepEqual(fixture.auth.cookies, []);
  await assert.rejects(workflow.api(input), { code: 'AUTH_MISSING' });
});

test('browser close failure cannot be reported as API-only readiness', async () => {
  const fixture = authenticatedFixture();
  fixture.auth.browser.close = async () => { throw Error('synthetic-private-detail'); };
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async () => document(root) });
  await assert.rejects(workflow.enableHTTP(), error => error.code === 'HANDOFF_FAILED' && !error.message.includes('synthetic'));
  assert.equal(workflow.status().authenticatedHTTP, false); assert.deepEqual(fixture.auth.cookies, []);
});

test('authenticated HTTP HTML discovers only observed read documents; writes remain candidates', async () => {
  const fixture = authenticatedFixture();
  const editor = 'https://blog.naver.com/PostWriteForm.naver?blogId=4053103';
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async url => {
    if (url === ADMIN_ROOT) return document(root);
    assert.equal(url, editor);
    return document('<input name="documentModel" value="synthetic-private-content"><form method="post" action="/PostWrite.naver"><input name="token" value="synthetic-secret"></form><script>const path="/PostDelete.naver";</script>');
  } });
  await workflow.enableHTTP();
  const result = await workflow.inspect();
  assert.ok(result.links.some(link => link.classification === 'editor_form_document'));
  const form = await workflow.inspect({ id: resourceId(editor) });
  assert.ok(form.formFieldNames.includes('documentModel'));
  assert.ok(form.links.some(link => link.kind === 'form' && link.state === 'unreviewed_candidate'));
  const scan = workflow.scan({ id: resourceId(editor) });
  assert.ok(scan.candidates.every(candidate => candidate.executable === false));
  await assert.rejects(workflow.inspect({ id: resourceId('https://blog.naver.com/PostDelete.naver') }), { code: 'UNOBSERVED' });
  assert.doesNotMatch(JSON.stringify(workflow.evidence()), /synthetic-private|synthetic-secret/);
  assert.equal(workflow.status().writeRequests, 0);
  await workflow.close();
});

test('explicit read observation accepts the write form GET but rejects mutation and foreign URLs', async () => {
  const fixture = authenticatedFixture();
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async url => url === ADMIN_ROOT ? document(root) : document('<html></html>') });
  await workflow.enableHTTP();
  const observed = workflow.observeRead({ url: 'https://blog.naver.com/PostWriteForm.naver?blogId=4053103' });
  assert.equal(observed.classification, 'editor_form_document');
  assert.throws(() => workflow.observeRead({ url: 'https://blog.naver.com/PostWrite.naver?blogId=4053103' }), { code: 'UNREVIEWED' });
  assert.throws(() => workflow.observeRead({ url: 'https://invalid.test/PostWriteForm.naver?blogId=4053103' }), { code: 'UNREVIEWED' });
  await workflow.close();
});

test('observed static scripts use a credential-free fetch rather than forwarding the session', async () => {
  const fixture = authenticatedFixture();
  const script = 'https://ssl.pstatic.net/synthetic/editor.js';
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async (url, init) => {
    if (url === ADMIN_ROOT) return document(root + `<script src="${script}"></script>`);
    assert.equal(url, script); assert.equal(new Headers(init.headers).has('cookie'), false);
    return new Response('const editor="synthetic";', { headers: { 'content-type': 'application/javascript' } });
  } });
  await workflow.enableHTTP(); await workflow.inspect(); await workflow.inspect({ id: resourceId(script) }); await workflow.close();
});

test('API permission failure invalidates readiness and blocks subsequent requests without retry', async () => {
  const fixture = authenticatedFixture(); let calls = 0;
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async url => {
    calls++; return url === ADMIN_ROOT ? document(root) : new Response('', { status: 403 });
  } });
  await workflow.enableHTTP();
  await assert.rejects(workflow.api(input), { code: 'FORBIDDEN' });
  assert.equal(workflow.status().state, 'blocked_auth_or_permission');
  await assert.rejects(workflow.api(input), { code: 'AUTH_MISSING' }); assert.equal(calls, 2);
  await workflow.close();
});

test('login HTML during editor read invalidates the HTTP session without exposing the page', async () => {
  const fixture = authenticatedFixture(); let calls = 0;
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async () => ++calls === 1 ? document(root) : document('<form action="https://nid.naver.com/nidlogin.login"><input type="password"></form>') });
  await workflow.enableHTTP();
  assert.equal((await workflow.inspect()).state, 'blocked_auth');
  assert.equal(workflow.status().authenticatedHTTP, false);
  await assert.rejects(workflow.inspect(), { code: 'AUTH_MISSING' }); assert.equal(calls, 2);
  await workflow.close();
});

test('actor-scoped admin shell remains readable when dormant login markup is embedded', async () => {
  const fixture = authenticatedFixture();
  const body = `${root}<div id="lnbMenu">블로그 관리</div>${'x'.repeat(1500)}<form action="https://nid.naver.com/nidlogin.login"><input type="password"></form>`;
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async () => document(body) });
  await workflow.enableHTTP();
  const result = await workflow.inspect();
  assert.equal(result.state, 'http_document_read');
  assert.equal(result.loginHTML, false);
  assert.equal(workflow.status().authenticatedHTTP, true);
  await workflow.close();
});

test('actor-scoped editor shell remains readable when a dormant login template is embedded', async () => {
  const fixture = authenticatedFixture();
  const editor = 'https://blog.naver.com/PostWriteForm.naver?blogId=4053103';
  const editorHTML = `<html><body><script>const blogId='4053103'; const editorVersion='3';</script>
    <form action="/PostWrite.naver"><input name="documentModel"></form>
    <template><form action="https://nid.naver.com/nidlogin.login"><input type="password"></form></template>
    ${'x'.repeat(1500)}</body></html>`;
  const workflow = new ApiWorkflow({ auth: fixture.auth, fetchImpl: async url => url === ADMIN_ROOT ? document(root) : document(editorHTML) });
  await workflow.enableHTTP();
  const observed = workflow.observeRead({ url: editor });
  const result = await workflow.inspect({ id: observed.id });
  assert.equal(result.state, 'http_document_read');
  assert.ok(result.formFieldNames.includes('documentModel'));
  await workflow.close();
});

test('worker dispatch is wired to the shared workflow rather than a standalone login helper', async () => {
  // Static check only: do not start the previously blocked browser worker.
  const source = await readFile(new URL('../tools/discovery/headless-worker.mjs', import.meta.url), 'utf8');
  for (const command of ['login', 'api', 'inspect', 'scan', 'frontier', 'evidence']) assert.match(source, new RegExp(`workflow\\.${command}\\(`));
  assert.doesNotMatch(source, /new HeadlessAuth\(/);
});
