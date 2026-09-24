import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOliveyoungClient, runOliveyoungEnvelope, selectSessionCookies, shortenerHeader, productNumber } from '../adapters/oliveyoung-curator.mjs';
import { runOliveyoung, sessionFromCapture } from '../tools/discovery/oliveyoung-session-handoff.mjs';

const session = { authorization: 'synthetic-session-token-for-tests' };
const activity = { goodsNumber: 'A000000123456', affiliateActivityId: 42, affiliatePartnerId: 24 };
const input = { goodsNumber: activity.goodsNumber, categoryNumber: '10000010001' };
const originalUrl = 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A000000123456&utm_source=shutter&utm_medium=affiliate&utm_content=OY_42';
const ready = { code: 200, data: { isAffiliate: true, needsEducation: false } };
const empty = { code: 200, data: [], pagination: { pageNumber: 0, isLastPage: true } };
const existing = { ...empty, data: [{ goods: { goodsNumber: activity.goodsNumber }, generatedActivity: activity }] };
const shortened = { data: [{ shortenedUrl: 'https://oy.run/Test123' }] };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function scripted(steps) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), ...options });
    assert.ok(steps.length, 'unexpected extra request');
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return step instanceof Response ? step : json(step);
  };
  return { fetchImpl, calls, now: () => new Date('2026-09-21T03:34:00Z') };
}

test('creates a provider-issued activity, shortens it and verifies attribution without visiting the affiliate link', async () => {
  const transport = scripted([ready, empty, { code: 200, data: activity }, shortened, { originalUrl }]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { activity, originalUrl, shortenedUrl: 'https://oy.run/Test123', reused: false, verified: true });
  assert.deepEqual(transport.calls.map(call => call.method), ['GET', 'GET', 'POST', 'POST', 'GET']);
  for (const call of transport.calls) {
    assert.equal(call.url.origin, 'https://m.oliveyoung.co.kr');
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers.Authorization, session.authorization);
  }
  assert.deepEqual(JSON.parse(transport.calls[2].body), input);
  assert.deepEqual(JSON.parse(transport.calls[3].body), [{ originalUrl, registerId: 24 }]);
  assert.equal(transport.calls[3].headers['x-api-key'], shortenerHeader(transport.now()));
  assert.equal(transport.calls[4].url.pathname, '/base/shorten/detail/Test123');
});

test('search preserves keyword encoding and 0-based pagination', async () => {
  const transport = scripted([{ ...empty, data: [{ goods: { goodsNumber: activity.goodsNumber } }] }]);
  const result = await runOliveyoungEnvelope({ session, operation: 'search', input: { keyword: '선크림 & 세럼', pageNumber: 2, pageSize: 10 } }, transport);
  assert.equal(result.ok, true);
  assert.equal(transport.calls[0].url.searchParams.get('keyword'), '선크림 & 세럼');
  assert.equal(transport.calls[0].url.searchParams.get('pageNumber'), '2');
});

test('reuses an activity found on another history page instead of POSTing landing', async () => {
  const transport = scripted([ready, { ...empty, pagination: { pageNumber: 0, isLastPage: false } },
    { ...existing, pagination: { pageNumber: 1, isLastPage: true } }, shortened, { originalUrl }]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.result.reused, true);
  assert.equal(transport.calls.filter(call => call.url.pathname.endsWith('/landing')).length, 0);
});

test('never writes when login, curator membership or education is missing', async () => {
  for (const [reply, expected] of [[json({}, 401), 'AUTH_REQUIRED'],
    [{ code: 3000 }, 'AUTH_REQUIRED'],
    [{ code: 200, data: { isAffiliate: false } }, 'CURATOR_ENROLLMENT_REQUIRED'],
    [{ code: 200, data: { isAffiliate: true, needsEducation: true } }, 'CURATOR_EDUCATION_REQUIRED']]) {
    const transport = scripted([reply]);
    const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
    assert.equal(result.error, expected);
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].method, 'GET');
  }
});

test('HTTP 200 HTML, 403 and redirects remain failed reads, never authenticated success', async () => {
  for (const [reply, expected] of [[new Response('<html>Login</html>'), 'HTML_RESPONSE'],
    [new Response('<html>challenge</html>', { status: 403 }), 'ACCESS_BLOCKED'],
    [new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 'REDIRECT_BLOCKED']]) {
    const transport = scripted([reply]);
    const result = await runOliveyoungEnvelope({ session, operation: 'status' }, transport);
    assert.equal(result.error, expected);
    assert.equal(transport.calls.length, 1);
  }
});

test('a timed out landing POST has unknown outcome and is never retried', async () => {
  const transport = scripted([ready, empty, new Error('network contains synthetic-session-token-for-tests')]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.error, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(transport.calls.length, 3);
  assert.ok(!JSON.stringify(result).includes(session.authorization));
});

test('unexpected successful write response is unknown outcome, not an invitation to retry', async () => {
  const transport = scripted([ready, empty, { code: 200, data: { ...activity, goodsNumber: 'OTHER' } }]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.error, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(result.details.nextOperation, 'generated');
});

test('shortener failure returns an activity checkpoint; completion verifies ownership from history', async () => {
  const transport = scripted([ready, empty, { data: activity }, new Error('timeout')]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.error, 'LINK_INCOMPLETE');
  assert.equal(result.details.outcome, 'activity_created');
  assert.deepEqual(result.details.activity, activity);
  const resume = scripted([ready, existing, shortened, { originalUrl }]);
  const completed = await runOliveyoungEnvelope({ session, operation: 'completeLink', input: activity }, resume);
  assert.equal(completed.result.verified, true);
  assert.equal(resume.calls.filter(call => call.url.pathname.endsWith('/landing')).length, 0);
  const missing = scripted([ready, empty]);
  const refused = await runOliveyoungEnvelope({ session, operation: 'completeLink', input: activity }, missing);
  assert.equal(refused.error, 'ACTIVITY_NOT_FOUND');
  assert.equal(missing.calls.filter(call => call.method === 'POST').length, 0);
});

test('wrong shortlink attribution never produces a successful link', async () => {
  const transport = scripted([ready, existing, shortened, { originalUrl: originalUrl.replace('OY_42', 'OY_99') }]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.error, 'LINK_INCOMPLETE');
  assert.equal(result.details.causeCode, 'LINK_VERIFICATION_FAILED');
});

test('shortener destination is constrained to the observed official short domain', async () => {
  const transport = scripted([ready, existing, { data: [{ shortenedUrl: 'https://attacker.example/steal' }] }]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.error, 'LINK_INCOMPLETE');
  assert.equal(transport.calls.length, 3);
});

test('missing pagination stops creation without issuing another activity', async () => {
  const transport = scripted([ready, { data: [] }]);
  const result = await runOliveyoungEnvelope({ session, operation: 'createLink', input }, transport);
  assert.equal(result.error, 'RESPONSE_PAGINATION');
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, 0);
});

test('service-scoped session handoff excludes analytics, unrelated hosts, header injection and expired cookies', async () => {
  const cookies = [
    { name: 'OYSESSIONID', value: 'synthetic-cookie', domain: 'm.oliveyoung.co.kr', path: '/', expires: -1 },
    { name: '_ga', value: 'analytics', domain: '.oliveyoung.co.kr', path: '/' },
    { name: 'OYSESSIONID', value: 'other-service', domain: '.example.com', path: '/' },
    { name: 'OYSESSIONID', value: 'broken\r\nX-Foo: bar', domain: '.oliveyoung.co.kr', path: '/' },
    { name: 'linkageString', value: 'expired', domain: '.oliveyoung.co.kr', path: '/', expires: 0 },
    { name: 'OYSESSIONID', value: 'wrong-path', domain: '.oliveyoung.co.kr', path: '/store/' },
  ];
  assert.equal(selectSessionCookies(cookies).length, 3);
  const captured = sessionFromCapture({ cookies, headers: { Authorization: session.authorization, 'X-OY-GW': 'Y', 'User-Agent': 'observed-agent' } });
  const transport = scripted([ready]);
  const result = await runOliveyoungEnvelope({ session: captured, operation: 'status' }, transport);
  assert.equal(result.ok, true);
  assert.equal(transport.calls[0].headers.Cookie, 'OYSESSIONID=synthetic-cookie');
  assert.equal(transport.calls[0].headers['X-OY-GW'], 'Y');
  assert.equal(transport.calls[0].headers['User-Agent'], 'observed-agent');
});

test('observed additionalInfo cookie refresh propagates the token to the independent HTTP client', async () => {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('cjone_g4de7353f1'), null);
  const linkageString = Buffer.concat([cipher.update(session.authorization, 'utf8'), cipher.final()]).toString('hex');
  const transport = scripted([json({ linkageString }, 200, { 'set-cookie': 'OYSESSIONID=renewed-test-cookie; Path=/; Domain=.oliveyoung.co.kr; Secure' }), ready]);
  const result = await runOliveyoungEnvelope({ operation: 'status', session: {
    cookies: [{ name: 'OYSESSIONID', value: 'old-test-cookie', domain: '.oliveyoung.co.kr', path: '/' }],
  } }, transport);
  assert.equal(result.result.ready, true);
  assert.equal(transport.calls[0].url.pathname, '/m/login/additionalInfo.do');
  assert.equal(transport.calls[0].headers.Authorization, undefined);
  assert.equal(transport.calls[1].headers.Authorization, session.authorization);
  assert.equal(transport.calls[1].headers.Cookie, 'OYSESSIONID=renewed-test-cookie');
  assert.ok(!JSON.stringify(result).includes(linkageString));
});

test('empty refresh response requires login, never a guessed or empty authorization token', async () => {
  const transport = scripted([{ linkageString: '' }]);
  const result = await runOliveyoungEnvelope({ operation: 'status', session: {
    cookies: [{ name: 'OYSESSIONID', value: 'anonymous-test-cookie', domain: '.oliveyoung.co.kr', path: '/' }],
  } }, transport);
  assert.equal(result.error, 'AUTH_REQUIRED');
  assert.equal(transport.calls.length, 1);
});

test('provider data cannot echo captured credentials through CLI results', async () => {
  const result = await runOliveyoungEnvelope({ session, operation: 'search', input: { keyword: 'test' } },
    scripted([{ data: [{ goodsName: session.authorization }] }]));
  assert.equal(result.error, 'OUTPUT_REDACTED');
  assert.ok(!JSON.stringify(result).includes(session.authorization));
});

test('product URLs are parsed without following arbitrary user supplied destinations', () => {
  assert.equal(productNumber('https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A000000123456'), activity.goodsNumber);
  for (const value of ['https://attacker.example/?goodsNo=A1', 'https://www.oliveyoung.co.kr@attacker.example/?goodsNo=A1',
    'http://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1',
    'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A1&goodsNo=A2']) assert.throws(() => productNumber(value), { code: 'INPUT_GOODS' });
});

test('private runner gives child only stdin credentials and minimal environment', async () => {
  let observed;
  const result = await runOliveyoung({ operation: 'unknown', session }, {
    environment: { SystemRoot: 'C:\\Windows', unrelated_secret: 'must-not-inherit' },
    spawnImpl(executable, args, options) { observed = { executable, args, options }; return spawn(executable, args, options); },
  });
  assert.equal(result.error, 'INPUT_OPERATION');
  assert.deepEqual(observed.options.env, { SystemRoot: 'C:\\Windows' });
  assert.equal(observed.args.length, 1);
  assert.ok(!JSON.stringify(observed).includes(session.authorization));
  assert.equal(observed.options.windowsHide, true);
});

test('CLI rejects credentials in command-line arguments', async () => {
  const cli = fileURLToPath(new URL('../scripts/oliveyoung.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, '--token=synthetic-not-a-credential'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.end();
  let output = '';
  for await (const chunk of child.stdout) output += chunk;
  assert.equal(JSON.parse(output).error, 'STDIN_REQUIRED');
  assert.ok(!output.includes('synthetic-not-a-credential'));
});
