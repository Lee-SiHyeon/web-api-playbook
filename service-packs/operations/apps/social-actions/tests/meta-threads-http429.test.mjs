import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMetaContext } from '../lib/meta-bootstrap.mjs';
import { readThreadsSharedCooldown, THREADS_HTTP_429_THROTTLED } from '../lib/threads-graphql-throttle.mjs';

const OWNER = 'lifehack__ailab';

function response429() {
  const response = new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
  Object.defineProperty(response, 'url', { value: `https://www.threads.com/@${OWNER}/` });
  return response;
}

test('protected Threads profile bootstrap records HTTP 429 and gates the next worker before credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meta-threads-http429-'));
  try {
    const bundle = { version: 1, service: 'threads', owner: OWNER, ownerId: '17824859444',
      origin: 'https://www.threads.com', cookies: [
        { name: 'sessionid', value: 'test-session', domain: '.threads.com', path: '/', secure: true },
        { name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true },
        { name: 'ds_user_id', value: '17824859444', domain: '.threads.com', path: '/', secure: true },
      ] };
    let requests = 0, sessionReads = 0, sessionWrites = 0;
    const options = { throttleRoot: root, readBudgetRoot: root,
      loadSession: async service => { sessionReads++; assert.equal(service, 'threads'); return { ...bundle }; },
      storeSession: async () => { sessionWrites++; },
      fetchImpl: async url => { requests++; assert.equal(url, `https://www.threads.com/@${OWNER}/`); return response429(); } };

    await assert.rejects(openMetaContext('threads', OWNER, options), error => {
      assert.equal(error.code, 'META_DOCUMENT_HTTP_429'); assert.equal(error.httpStatus, 429);
      assert.equal(error.dispatchStarted, true); assert.equal(error.writeSent, false);
      assert.equal(error.requestDiagnostic.operation, 'protected_profile_bootstrap');
      assert.equal(error.requestDiagnostic.httpStatus, 429); return true;
    });
    assert.equal(requests, 1); assert.equal(sessionReads, 1); assert.equal(sessionWrites, 0);
    const stored = JSON.parse(await readFile(path.join(root, 'http429-cooldown.json'), 'utf8'));
    assert.equal(stored.httpStatus, 429); assert.equal(stored.providerRetryAfterSeconds, 120);
    const shared = await readThreadsSharedCooldown({ root });
    assert.equal(shared.code, THREADS_HTTP_429_THROTTLED); assert.equal(shared.httpStatus, 429);

    await assert.rejects(openMetaContext('threads', OWNER, options), error => {
      assert.equal(error.code, THREADS_HTTP_429_THROTTLED); assert.equal(error.httpStatus, 429);
      assert.equal(error.dispatchStarted, false); assert.equal(error.writeSent, false);
      assert.equal(error.requestDiagnostic.stage, 'cooldown_gate');
      assert.equal(error.requestDiagnostic.httpStatus, 429); return true;
    });
    assert.equal(requests, 1); assert.equal(sessionReads, 1); assert.equal(sessionWrites, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
