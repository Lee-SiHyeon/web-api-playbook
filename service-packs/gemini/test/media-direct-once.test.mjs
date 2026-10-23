import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { SERVICE_ORIGIN } from '../src/constants.mjs';
import { submitCapturedMediaOnce } from '../src/media-direct-once.mjs';
import { contract, operation } from './helpers.mjs';

const MEDIA_URL = `${SERVICE_ORIGIN}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=build&f.sid=session&hl=en&_reqid=123&rt=c`;
const ACTOR = 'owner@example.com';

function fixtureContract() {
  return contract({
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['SID'], headerNames: [] },
    operations: {
      image: operation({
        effect: 'mutation',
        method: 'POST',
        path: new globalThis.URL(MEDIA_URL).pathname,
        contentType: 'application/x-www-form-urlencoded',
      }),
      video: operation({
        effect: 'mutation',
        method: 'POST',
        path: new globalThis.URL(MEDIA_URL).pathname,
        contentType: 'application/x-www-form-urlencoded',
      }),
    },
  });
}

function makeCapture(expectedIntent) {
  const body = Buffer.from(new URLSearchParams({
    at: 'current-token',
    'f.req': JSON.stringify([null, JSON.stringify([expectedIntent])]),
  }).toString());
  const url = new globalThis.URL(MEDIA_URL);
  return {
    origin: SERVICE_ORIGIN,
    url: url.href,
    path: url.pathname,
    method: 'POST',
    resourceType: 'xhr',
    contentType: 'application/x-www-form-urlencoded',
    browserAbortVerified: true,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: `${SERVICE_ORIGIN}/app`,
    },
    body,
  };
}

function makeSession() {
  return {
    version: 1,
    service: 'gemini-web',
    origin: SERVICE_ORIGIN,
    capturedAt: '2026-10-06T00:00:00.000Z',
    cookies: [{ name: 'SID', value: 'test-session' }],
    headers: {},
  };
}

async function submit({ capability = 'image', intent, expectedIntent, journalRoot, fetchImpl }) {
  return submitCapturedMediaOnce({
    baseContract: fixtureContract(),
    sessionBundle: makeSession(),
    capture: makeCapture(expectedIntent),
    capability,
    actor: ACTOR,
    callerIntent: intent,
    expectedIntent,
    journalRoot,
    fetchImpl,
  });
}

function response(body = Buffer.from('{"accepted":true}')) {
  return {
    status: 200,
    headers: new Headers({
      'content-type': 'application/json',
      'content-length': String(body.length),
    }),
    body: Readable.from([body]),
  };
}

test('media sends once per caller intent and allows a distinct later intent', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'gemini-media-intent-'));
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(url.href, MEDIA_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('cookie'), 'SID=test-session');
    assert.equal(Buffer.isBuffer(init.body), true);
    return response();
  };

  try {
    const first = await submit({
      intent: 'geometry-image-1', expectedIntent: 'blue square beside a yellow circle', journalRoot, fetchImpl,
    });
    assert.equal(first.httpStatus, 200);
    assert.equal(first.dispatchCount, 1);
    assert.equal(calls, 1);

    await assert.rejects(submit({
      intent: 'geometry-image-1', expectedIntent: 'a changed prompt under the same caller intent', journalRoot, fetchImpl,
    }), { code: 'MUTATION_PENDING' });
    assert.equal(calls, 1);

    const second = await submit({
      intent: 'geometry-image-2', expectedIntent: 'a separate neutral geometry scene', journalRoot, fetchImpl,
    });
    assert.equal(second.httpStatus, 200);
    assert.equal(second.dispatchCount, 1);
    assert.equal(calls, 2);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('a transport error holds the same intent without another send', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'gemini-media-unknown-'));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('transport outcome unavailable');
  };

  try {
    await assert.rejects(submit({
      intent: 'video-job-1', expectedIntent: 'a calm moving gradient', capability: 'video', journalRoot, fetchImpl,
    }), { code: 'MEDIA_TRANSPORT_FAILED' });
    assert.equal(calls, 1);

    const files = (await readdir(journalRoot)).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(path.join(journalRoot, files[0]), 'utf8'));
    assert.equal(saved.state, 'outcome_unknown');
    assert.equal(saved.dispatchCount, 1);

    await assert.rejects(submit({
      intent: 'video-job-1', expectedIntent: 'a calm moving gradient', capability: 'video', journalRoot, fetchImpl,
    }), { code: 'MUTATION_PENDING' });
    assert.equal(calls, 1);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
});
