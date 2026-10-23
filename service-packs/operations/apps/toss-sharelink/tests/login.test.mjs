import test from 'node:test';
import assert from 'node:assert/strict';
import { loginHttp } from '../login-http.mjs';

const ORIGIN = 'https://sharelink.toss.im';
const baseline = (expectedOwner = { publisherId: 1, userNo: 2, bizUserNo: 3 }) => ({
  version: 1,
  service: 'toss-sharelink',
  allowedOrigin: ORIGIN,
  cookies: [{ name: 'TBIZAUTH', value: 'fixture-session', domain: '.toss.im', path: '/', secure: true, httpOnly: true, expires: -1 }],
  expectedOwner,
  readRequests: { member: { method: 'GET', url: `${ORIGIN}/api-public/v3/shopping-growth/sharelink/member` } },
});
const identity = () => ({ email: 'fixture@example.invalid', password: 'fixture-password' });

test('login rejection sends once, redacts redirect inputs and leaves DPAPI unchanged', async () => {
  const calls = []; const input = identity();
  const result = await loginHttp(input, {
    loadBaseline: baseline,
    fetchImpl: async (u, init) => { calls.push({ u: String(u), init }); return calls.length === 1 ? new Response('page') : new Response(null, { status: 302, headers: { location: 'https://business.toss.im/account/sign-in?error=INVALID_ACCOUNT&session_token=fixture-token' } }); },
    persistSession: () => assert.fail('must not overwrite saved session'),
  });
  assert.equal(result.errorCode, 'INVALID_ACCOUNT');
  assert.equal(result.code, 'TOSS_LOGIN_REJECTED');
  assert.equal(result.authenticated, false);
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  assert.equal(input.password, '');
  assert.doesNotMatch(JSON.stringify(result), /fixture-password|fixture-token|fixture@example/);
});

test('cross-origin redirects fail before any credentials are sent there', async () => {
  const calls = [];
  await assert.rejects(loginHttp(identity(), {
    loadBaseline: baseline,
    fetchImpl: async u => { calls.push(String(u)); return calls.length === 1 ? new Response('page') : new Response(null, { status: 302, headers: { location: 'https://untrusted.example/continue' } }); },
  }), /TOSS_LOGIN_ORIGIN_REJECTED/);
  assert.equal(calls.length, 2);
});

test('an authenticated different owner never replaces the stored session', async () => {
  await assert.rejects(loginHttp(identity(), {
    loadBaseline: baseline,
    fetchImpl: async u => new URL(u).hostname === 'sharelink.toss.im' ? Response.json({ resultType: 'SUCCESS', success: { publisherId: 99, userNo: 2, bizUserNo: 3 } }) : new Response('page'),
    persistSession: () => assert.fail('wrong owner must not be saved'),
  }), /TOSS_OWNER_MISMATCH/);
});

test('same owner persists only service cookies and performs independent reads', async () => {
  let saved; const reads = []; let posts = 0;
  const result = await loginHttp(identity(), {
    loadBaseline: baseline,
    fetchImpl: async (u, init) => {
      if (init.method === 'POST') { posts++; return new Response(null, { status: 302, headers: { location: 'https://sharelink.toss.im/signup-start', 'set-cookie': 'TBIZAUTH=fixture-session; Domain=toss.im; Path=/; Secure; HttpOnly' } }); }
      if (new URL(u).pathname.endsWith('/member')) { assert.match(init.headers.Cookie, /TBIZAUTH=/); return Response.json({ resultType: 'SUCCESS', success: baseline().expectedOwner }); }
      return new Response('page');
    },
    persistSession: bundle => { saved = bundle; return { stored: true }; },
    check: async () => { reads.push('member'); return { authenticated: true, ownerMatched: true }; },
    read: async op => { reads.push(op); return { data: { success: { sections: [{}, {}] } } }; },
  });
  assert.equal(posts, 1);
  assert.equal(result.authenticated, true);
  assert.equal(result.sections, 2);
  assert.deepEqual(reads, ['member', 'shopping-curation-sections']);
  assert.deepEqual(saved.expectedOwner, baseline().expectedOwner);
  assert.equal(saved.cookies[0].name, 'TBIZAUTH');
  assert.equal(saved.cookies[0].expires, -1);
  assert.equal('password' in saved, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-session|fixture-password/);
});

test('login owner check accepts extra live fields but rejects saved optional fields that differ or disappear', async () => {
  const runLogin = async (expectedOwner, liveOwner, persistSession) => loginHttp(identity(), {
    loadBaseline: () => baseline(expectedOwner),
    fetchImpl: async (u, init = {}) => {
      if (init.method === 'POST') return new Response(null, { status: 302, headers: {
        location: `${ORIGIN}/signup-start`,
        'set-cookie': 'TBIZAUTH=fresh-session; Domain=toss.im; Path=/; Secure; HttpOnly',
      } });
      if (new URL(u).pathname.endsWith('/member')) return Response.json({ resultType: 'SUCCESS', success: liveOwner });
      return new Response('page');
    },
    persistSession,
    check: async () => ({ authenticated: true, ownerMatched: true }),
    read: async () => ({ data: { success: { sections: [] } } }),
  });

  const publisherOnly = await runLogin({ publisherId: 1 }, { publisherId: 1, userNo: 2, bizUserNo: 3 }, () => ({ stored: true }));
  assert.equal(publisherOnly.authenticated, true);

  for (const liveOwner of [{ publisherId: 1, userNo: 99 }, { publisherId: 1 }]) {
    let writes = 0;
    await assert.rejects(runLogin({ publisherId: 1, userNo: 2 }, liveOwner, () => { writes++; return { stored: true }; }),
      { code: 'TOSS_OWNER_MISMATCH' });
    assert.equal(writes, 0);
  }
});

test('malformed protected member contracts fail before login fetch or session persistence', async () => {
  const cases = [
    ['wrong member path', value => { value.readRequests.member.url = `${ORIGIN}/api-public/v3/shopping/sharelink/not-member`; }, 'TOSS_OWNER_REQUEST_INVALID'],
    ['wrong origin', value => { value.readRequests.member.url = 'https://untrusted.example/api-public/v3/shopping-growth/sharelink/member'; }, 'TOSS_REQUEST_SCOPE_REJECTED'],
    ['non-GET member method', value => { value.readRequests.member.method = 'POST'; }, 'TOSS_OPERATION_REJECTED'],
    ['missing required publisherId', value => { value.expectedOwner = { userNo: 2 }; }, 'TOSS_STATE_INVALID'],
  ];
  for (const [label, corrupt, expectedCode] of cases) {
    const saved = baseline();
    corrupt(saved);
    let fetchCalls = 0;
    let writes = 0;
    await assert.rejects(loginHttp(identity(), {
      loadBaseline: () => saved,
      fetchImpl: async () => { fetchCalls++; throw new Error('must not fetch'); },
      persistSession: () => { writes++; return { stored: true }; },
    }), error => {
      assert.equal(error.code, expectedCode, label);
      return true;
    });
    assert.equal(fetchCalls, 0, label);
    assert.equal(writes, 0, label);
  }
});
