import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SERVICE_ORIGIN } from '../src/constants.mjs';
import { validateObservedContract } from '../src/contract.mjs';
import { refreshGeminiHttpSession } from '../src/http-session-bootstrap.mjs';
import { operation } from './helpers.mjs';

const OWNER = 'owner@example.com';
const TEMPLATE = Object.freeze({
  at: 'stale-token',
  fSid: 'stale-session',
  buildLabel: 'stale-build',
  locale: 'en',
  requestType: 'c',
  sourcePath: '/app',
  requestId: '1234',
  historyListArgs: [20, null, [0, null, 5]],
});

function observedContract() {
  const history = operation({
    effect: 'read',
    method: 'POST',
    path: '/_/BardChatUi/data/batchexecute',
    queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
    contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    framing: 'batchexecute',
    rpcId: 'MaZiqc',
  });
  return validateObservedContract({
    version: 1,
    service: 'gemini-web',
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['SID'], headerNames: [] },
    assetOrigins: [],
    operations: {
      identity: operation({
        method: 'GET', path: '/app', responseContentType: 'text/html', framing: 'text',
      }),
      history_list: {
        ...history,
        request: { ...history.request, bodyFieldNames: ['f.req', 'at'] },
      },
    },
  });
}

function session() {
  return {
    version: 1,
    service: 'gemini-web',
    origin: SERVICE_ORIGIN,
    capturedAt: '2026-10-06T00:00:00.000Z',
    cookies: [{ name: 'SID', value: 'test-cookie' }],
    headers: {},
    batchContext: TEMPLATE,
  };
}

function pageHtml({ owner = OWNER, wiz = { SNlM0e: 'new-token', cfb2h: 'new-session', FdrFJe: 'new-build' } } = {}) {
  const data = JSON.stringify({ oPEP7c: owner, ...wiz });
  return `<html><body><chat-app-orchestrator></chat-app-orchestrator><script>window.WIZ_global_data = ${data};</script><span>${owner}</span></body></html>`;
}

function fakeClient(authenticatedHtml, anonymousHtml) {
  const calls = [];
  const clientContract = observedContract();
  const client = {
    contract: clientContract,
    transport: {
      session: session(),
      async request(operationName, spec, options = {}) {
        calls.push({ operationName, spec, omitCredentials: options.omitCredentials === true });
        const body = Buffer.from(options.omitCredentials ? anonymousHtml : authenticatedHtml);
        return {
          httpStatus: 200,
          contentType: 'text/html',
          responseBytes: body.length,
          body,
        };
      },
    },
  };
  return { client, calls };
}

test('refreshes only WIZ fields over owner-checked direct app reads and preserves the captured request template', async () => {
  const authenticatedHtml = pageHtml({ wiz: { SNlM0e: 'fresh-at-"-brace}', cfb2h: 'fresh-fsid', FdrFJe: 'fresh-build_1', unused: { value: 1 } } });
  const { client, calls } = fakeClient(authenticatedHtml, pageHtml({ owner: 'anonymous@example.com' }));
  const result = await refreshGeminiHttpSession({ client, expectedOwner: OWNER });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(item => [item.operationName, item.spec.method, item.spec.path, item.omitCredentials]), [
    ['identity', 'GET', '/app', false],
    ['identity', 'GET', '/app', true],
  ]);
  assert.deepEqual(result.batchContext, {
    ...TEMPLATE,
    at: 'fresh-at-"-brace}',
    fSid: 'fresh-fsid',
    buildLabel: 'fresh-build_1',
  });
  assert.equal(result.ownerMatched, true);
  assert.equal(result.anonymousOwnerAbsent, true);
  assert.equal(result.responseBytes, Buffer.byteLength(authenticatedHtml));
  assert.equal(result.responseSha256, createHash('sha256').update(authenticatedHtml).digest('hex'));
  assert.equal(Number.isFinite(Date.parse(result.observedAt)), true);
});

test('returns typed missing context when a current WIZ field is absent', async () => {
  const { client } = fakeClient(pageHtml({ wiz: { SNlM0e: 'fresh-at', cfb2h: 'fresh-fsid' } }), '<html>anonymous</html>');
  await assert.rejects(refreshGeminiHttpSession({ client, expectedOwner: OWNER }), error => {
    assert.equal(error.code, 'HTTP_SESSION_CONTEXT_MISSING');
    assert.equal(error.details.field, 'buildLabel');
    return true;
  });
});

test('returns typed missing context when the captured query template is unavailable', async () => {
  const authenticatedHtml = pageHtml();
  const { client, calls } = fakeClient(authenticatedHtml, '<html>anonymous</html>');
  delete client.transport.session.batchContext;
  await assert.rejects(refreshGeminiHttpSession({ client, expectedOwner: OWNER }), error => {
    assert.equal(error.code, 'HTTP_SESSION_CONTEXT_MISSING');
    assert.equal(error.details.field, 'history_list');
    assert.equal(error.details.reason, 'captured_template_missing');
    assert.deepEqual(error.details.validatedWizFieldNames, ['SNlM0e', 'cfb2h', 'FdrFJe']);
    assert.equal(error.details.ownerMatched, true);
    assert.equal(error.details.anonymousOwnerAbsent, true);
    assert.equal(error.details.responseBytes, Buffer.byteLength(authenticatedHtml));
    assert.equal(error.details.responseSha256, createHash('sha256').update(authenticatedHtml).digest('hex'));
    assert.equal(Number.isFinite(Date.parse(error.details.observedAt)), true);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('rejects an ambiguous WIZ assignment instead of selecting a stale copy', async () => {
  const first = JSON.stringify({ SNlM0e: 'first', cfb2h: 'one', FdrFJe: 'build-one' });
  const second = JSON.stringify({ SNlM0e: 'second', cfb2h: 'two', FdrFJe: 'build-two' });
  const html = `<html><body><chat-app-orchestrator>${OWNER}</chat-app-orchestrator><script>window.WIZ_global_data=${first};</script><script>window.WIZ_global_data=${second};</script></body></html>`;
  const { client } = fakeClient(html, '<html>anonymous</html>');
  await assert.rejects(refreshGeminiHttpSession({ client, expectedOwner: OWNER }), error => {
    assert.equal(error.code, 'HTTP_SESSION_CONTEXT_MISSING');
    assert.equal(error.details.field, 'WIZ_global_data');
    assert.equal(error.details.reason, 'assignment_ambiguous');
    return true;
  });
});

test('refuses to bootstrap for an unverified account', async () => {
  const { client } = fakeClient(pageHtml({ owner: 'different@example.com' }), '<html>anonymous</html>');
  await assert.rejects(refreshGeminiHttpSession({ client, expectedOwner: OWNER }), { code: 'OWNER_VERIFICATION_FAILED' });
});

test('bootstrap requires the active principal even when chooser markup contains the expected email', async () => {
  const html = pageHtml({ owner: OWNER, wiz: {
    oPEP7c: 'different@example.com', SNlM0e: 'new-token', cfb2h: 'new-session', FdrFJe: 'new-build',
  } });
  const { client } = fakeClient(html, `<html>Saved account: ${OWNER}</html>`);
  await assert.rejects(refreshGeminiHttpSession({ client, expectedOwner: OWNER }), { code: 'OWNER_VERIFICATION_FAILED' });
});
