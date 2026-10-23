import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { GeminiWebClient } from '../src/client.mjs';
import { makeCookieHeader, readSessionRenewalEnvelopeFromStdin, validateSessionBundle } from '../src/session.mjs';
import { contract, operation, session } from './helpers.mjs';

const OWNER = 'owner@example.invalid';
const observed = contract({
  auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
  operations: { identity: operation({ path: '/app', headerNames: [], responseContentType: 'text/html', framing: 'text' }) },
});
const bundle = (value, expires) => ({ ...session({ cookieNames: ['AUTH_COOKIE'], cookieValue: value }),
  cookies: [{ name: 'AUTH_COOKIE', value, ...(expires === undefined ? {} : { expires }) }],
});

function fixture() {
  const calls = [];
  const client = new GeminiWebClient({ contract: observed, session: bundle('old-secret', 0),
    fetchImpl: async (_url, options) => {
      calls.push(options);
      const cookie = options.headers.get('cookie');
      const email = cookie === 'AUTH_COOKIE=wrong-owner-secret' ? 'different@example.invalid' : OWNER;
      return new Response(cookie ? `<chat-app-orchestrator>${email}</chat-app-orchestrator><script>WIZ_global_data=${JSON.stringify({ oPEP7c: email })};</script>` : '<p>Sign in</p>',
        { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  client.verifiedOwner = OWNER;
  client.nextHistoryRequestId = 77;
  return { client, calls };
}

test('expired required cookies fail before network; session-cookie sentinel remains usable', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.verifyOwner(OWNER), { code: 'SESSION_EXPIRED' });
  assert.equal(calls.length, 0);
  const temporary = validateSessionBundle(bundle('temporary-secret', -1), observed);
  assert.equal(temporary.cookies[0].expires, -1);
  assert.equal(makeCookieHeader(temporary, 'https://gemini.google.com/app'), 'AUTH_COOKIE=temporary-secret');
  assert.throws(() => validateSessionBundle(bundle('x', Number.NaN), observed), { code: 'SESSION_INVALID' });
});

test('same-owner handoff recovers local expiry only after authenticated and anonymous HTTPS checks', async () => {
  const { client, calls } = fixture();
  const result = await client.renewSession({ expectedOwner: OWNER,
    acquireSession: async () => bundle('new-secret', Date.now() / 1000 + 3600),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get('cookie'), 'AUTH_COOKIE=new-secret');
  assert.equal(calls[1].headers.get('cookie'), null);
  assert.equal(client.transport.session.cookies[0].value, 'new-secret');
  assert.equal(result.localExpiryRecoveryVerified, true);
  assert.equal(result.credentialChanged, true);
  assert.equal(result.providerCookieRotationVerified, false);
  assert.equal(result.providerExpiredSessionRecoveryVerified, false);
  assert.equal(result.mutationReplayed, false);
  for (const value of ['new-secret', 'old-secret', OWNER]) assert.equal(JSON.stringify(result).includes(value), false);
});

test('wrong-owner and acquisition failures preserve active session, owner, counter, and selection', async () => {
  const { client } = fixture();
  const before = client.transport.session;
  const selection = client.modelSelection;
  await assert.rejects(client.renewSession({ expectedOwner: OWNER,
    acquireSession: async () => bundle('wrong-owner-secret', -1),
  }), { code: 'SESSION_RENEWAL_OWNER_VERIFICATION_FAILED' });
  assert.equal(client.transport.session, before);
  assert.equal(client.verifiedOwner, OWNER);
  assert.equal(client.nextHistoryRequestId, 77);
  assert.equal(client.modelSelection, selection);
  await assert.rejects(client.renewSession({ expectedOwner: OWNER,
    acquireSession: async () => { throw Object.assign(new Error('unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); },
  }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(client.transport.session, before);
});

test('concurrent handoffs cannot acquire twice or overwrite a session replaced during verification', async () => {
  const { client } = fixture();
  let release;
  let acquisitions = 0;
  const pending = client.renewSession({ expectedOwner: OWNER, acquireSession: async () => {
    acquisitions += 1;
    await new Promise((resolve) => { release = resolve; });
    return bundle('new-secret', -1);
  } });
  await assert.rejects(client.renewSession({ expectedOwner: OWNER,
    acquireSession: async () => { acquisitions += 1; return bundle('other-secret', -1); },
  }), { code: 'SESSION_RENEWAL_IN_PROGRESS' });
  const concurrentlyInstalled = validateSessionBundle(bundle('other-secret', -1), observed);
  client.transport.session = concurrentlyInstalled;
  release();
  await assert.rejects(pending, { code: 'SESSION_CHANGED_DURING_RENEWAL' });
  assert.equal(client.transport.session, concurrentlyInstalled);
  assert.equal(acquisitions, 1);
});

test('stdin accepts only two scoped session bundles and clears packet bytes', async () => {
  const raw = Buffer.from(JSON.stringify({ session: bundle('old-secret', 0), replacementSession: bundle('new-secret', -1) }));
  const result = await readSessionRenewalEnvelopeFromStdin(observed, { input: Readable.from([raw]) });
  assert.equal(result.session.cookies[0].expires, 0);
  assert.equal(result.replacementSession.cookies[0].value, 'new-secret');
  assert.equal(raw.every((byte) => byte === 0), true);
  await assert.rejects(readSessionRenewalEnvelopeFromStdin(observed, {
    input: Readable.from([JSON.stringify({ session: bundle('x', 0), replacementSession: bundle('x', -1), password: 'not-accepted' })]),
  }), { code: 'SESSION_RENEWAL_PACKET_INVALID' });
});
