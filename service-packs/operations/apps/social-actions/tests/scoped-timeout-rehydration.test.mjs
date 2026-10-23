import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { webApiPlaybookRoot } from '../../affiliate-api-hub/adapters/web-auth-provider.mjs';

const { ScopedSession } = await import(pathToFileURL(path.join(webApiPlaybookRoot(), 'lib/scoped-session.mjs')).href);

test('rehydrating a stored short deadline applies the new limit to a slow response and preserves origin scope', async () => {
  const stored = new ScopedSession({ allowedOrigins: ['https://example.com'], timeoutMs: 5 }).toJSON();
  let requests = 0;
  const fetchImpl = async (_url, { signal }) => {
    requests++;
    await delay(25, undefined, { signal });
    return new Response('complete', { headers: { 'content-type': 'text/plain' } });
  };
  const restored = ScopedSession.fromJSON(stored, { fetchImpl, timeoutMs: 1000 });
  assert.equal((await restored.request('https://example.com/slow')).raw, 'complete');
  await assert.rejects(restored.request('https://other.example/'), { code: 'SCOPED_SESSION_SCOPE' });
  assert.equal(requests, 1);
  assert.equal(stored.timeoutMs, 5);
  assert.equal(restored.toJSON().timeoutMs, 1000);
});

test('a rehydrated deadline remains finite and expiration never resends the request', async () => {
  const stored = new ScopedSession({ allowedOrigins: ['https://example.com'], timeoutMs: 100 }).toJSON();
  let requests = 0;
  const restored = ScopedSession.fromJSON(stored, { timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    requests++; await delay(30, undefined, { signal }); return new Response('late');
  } });
  await assert.rejects(restored.request('https://example.com/slow'), { code: 'SCOPED_SESSION_TIMEOUT' });
  assert.equal(requests, 1);
  assert.throws(() => ScopedSession.fromJSON(stored, { timeoutMs: Infinity }), { code: 'SCOPED_SESSION_LIMITS_INVALID' });
});
