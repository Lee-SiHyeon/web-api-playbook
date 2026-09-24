import test from 'node:test';
import assert from 'node:assert/strict';
import { headlessCookies, verifyHeadlessCreate } from '../tools/discovery/headless-create-probe.mjs';

const blogId = 'aicandoanything';
const cookies = () => ['NID_AUT', 'NID_SES'].map(name => ({ name, value: `synthetic-${name}`,
  domain: '.naver.com', path: '/', expires: -1, httpOnly: true, secure: true }));
const capture = (token, closed = true) => ({
  envelope: { body: new URLSearchParams({ tokenId: token }).toString() },
  cookieHeader: 'NID_AUT=synthetic-aut; NID_SES=synthetic-ses',
  metadata: { browserClosed: closed },
});

test('headless handoff excludes unrelated cookies and rejects wrong scope or duplicate credentials', () => {
  const input = [...cookies(), { name: 'unrelated', value: 'synthetic-extra', domain: '.naver.com' },
    { name: 'NID_AUT', value: 'synthetic-foreign', domain: '.example.com', path: '/', expires: -1 }];
  assert.deepEqual(headlessCookies(input, blogId).map(c => c.name), ['NID_AUT', 'NID_SES']);
  assert.throws(() => headlessCookies(input, 'foreignblog'), /HEADLESS_PROBE_SCOPE/);
  assert.throws(() => headlessCookies([...cookies(), cookies()[0]], blogId), /AUTH_MISSING/);
});

test('two closed headless lifecycles precede one HTTP write and secrets are cleared', async () => {
  const order = [], captures = [capture('synthetic-first'), capture('synthetic-second')];
  let seedReference;
  const evidence = await verifyHeadlessCreate({ cookies: cookies(), blogId, journal: 'synthetic-journal', output: 'synthetic-output' }, {
    verifyOwner: async () => { order.push('owner'); },
    collect: async ({ cookies: seeds }) => { seedReference = seeds; order.push('browser_closed'); return captures[order.length - 2]; },
    publish: async ({ envelope }) => {
      order.push('http'); assert.equal(new URLSearchParams(envelope.body).get('tokenId'), 'synthetic-second');
      return { accepted: true, readbackVerified: true };
    },
  });
  assert.deepEqual(order, ['owner', 'browser_closed', 'browser_closed', 'http']);
  assert.equal(evidence.headlessRestartReissuanceVerified, true);
  assert.equal(evidence.loginSessionRenewalVerified, false);
  assert.equal(evidence.browserEngineFree, false);
  assert.ok(captures.every(c => c.envelope.body === '' && c.cookieHeader === ''));
  assert.ok(seedReference.every(c => c.value === ''));
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-first|synthetic-second|NID_AUT=/);
});

for (const scenario of ['open_browser', 'same_token', 'owner_failure']) {
  test(`headless verification stops before HTTP writes for ${scenario}`, async () => {
    let collects = 0, writes = 0;
    await assert.rejects(verifyHeadlessCreate({ cookies: cookies(), blogId }, {
      verifyOwner: async () => { if (scenario === 'owner_failure') throw Error('AUTH_FAILED'); },
      collect: async () => { collects++; return capture('synthetic-same', scenario !== 'open_browser'); },
      publish: async () => { writes++; },
    }));
    assert.equal(writes, 0);
    assert.equal(collects, scenario === 'owner_failure' ? 0 : scenario === 'open_browser' ? 1 : 2);
  });
}

test('an uncertain HTTP outcome is surfaced once without collecting a replacement token or retrying', async () => {
  let collects = 0, writes = 0;
  const captures = [];
  await assert.rejects(verifyHeadlessCreate({ cookies: cookies(), blogId }, {
    verifyOwner: async () => {},
    collect: async () => { const value = capture(`synthetic-${++collects}`); captures.push(value); return value; },
    publish: async () => { writes++; throw Error('HEADLESS_HTTP_WRITE_NOT_VERIFIED'); },
  }), /HEADLESS_HTTP_WRITE_NOT_VERIFIED/);
  assert.equal(collects, 2); assert.equal(writes, 1);
  assert.ok(captures.every(c => c.envelope.body === '' && c.cookieHeader === ''));
});
