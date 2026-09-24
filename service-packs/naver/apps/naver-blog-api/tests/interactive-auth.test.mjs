import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractiveAuth, browserRequestMetadata } from '../tools/discovery/interactive-auth.mjs';

const requiredCookies = () => ['NID_AUT', 'NID_SES'].map(name => ({
  name, value: `synthetic-${name}`, domain: '.naver.com', path: '/', secure: true, expires: -1,
}));
const rootHTML = '<a href="/4053103/config/bloginfo">settings</a><a href="/4053103/stat/today">statistics</a>';

function fakeRuntime({ cookies = requiredCookies(), pageClosed = false, simulateWarmupRequests = false } = {}) {
  const calls = [];
  let currentUrl = 'https://nid.naver.com/nidlogin.login';
  let routeHandler = null;
  const fakeRequest = (url, method, resourceType = 'xhr') => ({
    url: () => url, method: () => method, resourceType: () => resourceType,
  });
  const fakeRoute = request => ({
    request: () => request,
    abort: async reason => calls.push(['abort', request.method(), reason]),
    continue: async () => calls.push(['continue', request.method()]),
  });
  const page = {
    setDefaultTimeout: value => calls.push(['defaultTimeout', value]),
    setDefaultNavigationTimeout: value => calls.push(['navigationTimeout', value]),
    goto: async (url, options) => {
      calls.push(['goto', url, options]); currentUrl = url;
      if (simulateWarmupRequests && routeHandler && url.includes('PostWriteForm.naver')) {
        await routeHandler(fakeRoute(fakeRequest('https://blog.naver.com/editor/bootstrap?blogId=4053103', 'GET', 'fetch')));
        await routeHandler(fakeRoute(fakeRequest('https://blog.naver.com/PostWrite.naver?blogId=4053103&token=private', 'POST')));
        await routeHandler(fakeRoute(fakeRequest('https://telemetry.invalid/collect?private=value', 'POST')));
      }
    },
    waitForTimeout: async value => calls.push(['waitForTimeout', value]),
    evaluate: async () => ({ userAgent: 'SyntheticBrowser/1.0', languages: ['ko-KR', 'ko'],
      current: currentUrl, forms: [], scripts: [], frames: [], fieldNames: [] }),
    url: () => currentUrl,
    isClosed: () => pageClosed,
    on: (event, handler) => calls.push(['on', event, handler]),
    off: (event, handler) => calls.push(['off', event, handler]),
  };
  const context = {
    newPage: async () => page,
    cookies: async origins => { calls.push(['cookies', origins]); return cookies; },
    route: async (pattern, handler) => { routeHandler = handler; calls.push(['route', pattern, handler]); },
    unroute: async (pattern, handler) => calls.push(['unroute', pattern, handler]),
  };
  const browser = {
    newContext: async options => { calls.push(['context', options]); return context; },
    close: async () => calls.push(['close']),
  };
  const chromium = {
    executablePath: () => process.execPath,
    launch: async options => { calls.push(['launch', options]); return browser; },
  };
  return { calls, chromium };
}

test('interactive login opens one visible temporary browser without accepting credentials', async () => {
  const fake = fakeRuntime({ cookies: [] });
  const auth = new InteractiveAuth({ loadChromium: async () => fake.chromium });
  const status = await auth.open();
  assert.equal(status.interactive, true);
  assert.equal(status.classification, 'manual_login_pending');
  assert.equal(status.credentialValuesReturned, false);
  assert.equal(fake.calls.find(call => call[0] === 'launch')[1].headless, false);
  assert.equal(fake.calls.filter(call => call[0] === 'launch').length, 1);
  await auth.close();
});

test('manual login hands only the in-memory session to independent HTTP and closes the browser', async () => {
  const fake = fakeRuntime();
  const auth = new InteractiveAuth({ loadChromium: async () => fake.chromium });
  await auth.open();
  const result = await auth.handoffHTTP({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://admin.blog.naver.com/4053103');
    assert.equal(init.method, 'GET');
    assert.match(new Headers(init.headers).get('cookie'), /NID_AUT=synthetic-NID_AUT/);
    assert.equal(new Headers(init.headers).get('user-agent'), 'SyntheticBrowser/1.0');
    return new Response(rootHTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  } });
  assert.equal(result.verification.verified, true);
  assert.equal(auth.browser, null);
  assert.equal(fake.calls.filter(call => call[0] === 'close').length, 1);
  assert.ok(fake.calls.filter(call => call[0] === 'goto' && call[1] === 'https://admin.blog.naver.com/4053103').length >= 2);
  assert.equal(JSON.stringify(result.session), '{}');
  assert.doesNotMatch(JSON.stringify(result.verification), /synthetic-NID/);
  result.session.clear();
});

test('closing the temporary browser before login fails closed without HTTP', async () => {
  const fake = fakeRuntime({ cookies: [], pageClosed: true });
  const auth = new InteractiveAuth({ loadChromium: async () => fake.chromium });
  await auth.open();
  await assert.rejects(auth.handoffHTTP({ fetchImpl: async () => assert.fail('No HTTP after cancellation') }), {
    code: 'MANUAL_LOGIN_CANCELLED',
  });
  assert.equal(auth.browser, null);
});

test('read-only browser warmup targets only PostWriteForm and returns sanitized metadata', async () => {
  const fake = fakeRuntime({ simulateWarmupRequests: true });
  const auth = new InteractiveAuth({ loadChromium: async () => fake.chromium,
    readOnlyWarmupUrl: 'https://blog.naver.com/PostWriteForm.naver?blogId=4053103' });
  await auth.open();
  const result = await auth.handoffHTTP({ fetchImpl: async () => new Response(rootHTML, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }) });
  assert.equal(result.warmupEvidence.mode, 'browser_read_only_warmup');
  assert.equal(result.warmupEvidence.target.url, 'https://blog.naver.com/PostWriteForm.naver');
  assert.equal(result.warmupEvidence.mutationRequestsSent, 0);
  assert.equal(result.warmupEvidence.credentialValuesReturned, false);
  assert.equal(result.warmupEvidence.blockedNonReadRequests.length, 1);
  assert.equal(result.warmupEvidence.blockedNonReadTotal, 2);
  assert.equal(result.warmupEvidence.blockedUnrecordedTotal, 1);
  assert.equal(result.warmupEvidence.blockedNonReadRequests[0].method, 'POST');
  assert.deepEqual(result.warmupEvidence.blockedNonReadRequests[0].queryFields, ['blogId', 'token']);
  assert.ok(fake.calls.some(call => call[0] === 'abort' && call[1] === 'POST'));
  assert.equal(fake.calls.filter(call => call[0] === 'abort' && call[1] === 'POST').length, 2);
  assert.ok(fake.calls.some(call => call[0] === 'continue' && call[1] === 'GET'));
  assert.ok(fake.calls.some(call => call[0] === 'route'));
  assert.ok(fake.calls.some(call => call[0] === 'unroute'));
  result.session.clear();
});

test('browser request metadata strips values and ignores foreign origins', () => {
  const request = { url: () => 'https://blog.naver.com/PostWrite.naver?blogId=4053103&token=private',
    method: () => 'POST', resourceType: () => 'xhr' };
  assert.deepEqual(browserRequestMetadata(request), {
    url: 'https://blog.naver.com/PostWrite.naver', queryFields: ['blogId', 'token'],
    method: 'POST', resourceType: 'xhr', blocked: true,
  });
  assert.equal(browserRequestMetadata({ url: () => 'https://invalid.test/private', method: () => 'GET', resourceType: () => 'document' }), null);
});

test('read-only warmup refuses arbitrary destinations', () => {
  assert.throws(() => new InteractiveAuth({ readOnlyWarmupUrl: 'https://blog.naver.com/PostDelete.naver?blogId=4053103' }), { code: 'SCOPE' });
  assert.throws(() => new InteractiveAuth({ readOnlyWarmupUrl: 'https://invalid.test/PostWriteForm.naver?blogId=4053103' }), { code: 'SCOPE' });
});
