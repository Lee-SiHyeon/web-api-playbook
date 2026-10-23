import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { validateObservedContract } from '../src/contract.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';
import { consumeMutationDispatch, digestBody } from '../src/journal.mjs';
import { readSettingsUpdateEnvelopeFromStdin } from '../src/session.mjs';
import { parseSettingsUpdateOptions } from '../src/cli.mjs';
import { session as testSession } from './helpers.mjs';
import {
  buildPreferenceUpdateRequest,
  inspectPreferenceValue,
  readGeminiPreference,
  testAndRestoreGeminiPreference,
  updateGeminiPreferenceOnce,
} from '../src/settings-update.mjs';

const OWNER = 'expected.user@example.com';
const QUERY_KEYS = ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'];
const BODY_FIELDS = ['f.req', 'at'];
const HEADERS = ['content-type', 'origin', 'referer', 'x-same-domain'];

function frame(rpcId, data) {
  const value = [[['wrb.fr', rpcId, JSON.stringify(data), null, 'generic']]];
  const json = JSON.stringify(value);
  return Buffer.from(`)]}'\n${json.length + 2}\n${json}`, 'utf8');
}

function testContract() {
  const batchRequest = (rpcId, argsTemplate) => ({
    rpcId,
    rpcArgsTemplate: argsTemplate,
    method: 'POST',
    origin: SERVICE_ORIGIN,
    path: '/_/BardChatUi/data/batchexecute',
    queryKeys: QUERY_KEYS,
    headerNames: HEADERS,
    contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    bodyFieldNames: BODY_FIELDS,
  });
  const batchResponse = (rpcId) => ({
    contentType: 'application/json',
    framing: 'batchexecute',
    selectorMode: 'rpc_id',
    rpcId,
    frameLengthUnit: 'utf16_code_units',
    frameLengthOverheadUnits: 2,
  });
  return validateObservedContract({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    assetOrigins: [],
    operations: {
      identity: {
        observation: { requestResponse: true },
        effect: 'read',
        request: { method: 'GET', origin: SERVICE_ORIGIN, path: '/app', queryKeys: [], headerNames: [] },
        response: { contentType: 'text/html', framing: 'text' },
      },
      history_list: {
        observation: { requestResponse: true },
        effect: 'read',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
          queryKeys: QUERY_KEYS, headerNames: HEADERS,
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: BODY_FIELDS,
        },
        response: batchResponse('MaZiqc'),
      },
      settings_read: {
        observation: { requestResponse: true },
        effect: 'read',
        request: {
          ...batchRequest('ESY5D', [null, '{{preferenceFieldIds}}']),
          preferenceFieldIds: [41],
          allowlistedPreferenceKeys: ['side_nav_open_by_default'],
        },
        response: batchResponse('ESY5D'),
      },
      settings_update: {
        observation: { request: true, requestResponse: true },
        effect: 'mutation',
        retryPolicy: 'never',
        request: {
          ...batchRequest('L5adhe', ['{{preferenceValueVector}}', null, ['{{preferenceFieldId}}']]),
          sourceBundleSha256: '3137eb01bfe212ddc5b7df423acd9c9633537f528a0cd13a07c25e075495e7aa',
          preferenceUpdateBranch: 'field3',
          preferenceFieldIds: [41],
          writablePreferenceKeys: ['side_nav_open_by_default'],
          preferenceValueType: 'boolean',
        },
        response: batchResponse('L5adhe'),
      },
    },
  });
}

function testClient({ initialValue = true, updateStatus = 200 } = {}) {
  const contract = testContract();
  const state = { preferenceValue: initialValue, writes: 0, readFieldIds: [] };
  const client = {
    contract,
    nextHistoryRequestId: 50,
    verifiedOwner: OWNER,
    transport: {
      session: {
        cookies: [{ name: 'AUTH_COOKIE', value: 'in-memory-only' }],
        headers: {},
        requestHeaders: {
          settings_read: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
          settings_update: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
        },
        batchContext: {
          at: 'at-token-only-in-memory',
          fSid: 'f-sid-only-in-memory',
          buildLabel: 'test-build',
          locale: 'ko',
          requestType: '1',
          sourcePath: '/app',
          requestId: '50',
        },
      },
      async request(capability, requestSpec, { dispatchTicket, wireBodyDigest } = {}) {
        assert.equal(capability, 'settings_update');
        consumeMutationDispatch(dispatchTicket, capability, wireBodyDigest);
        const form = new URLSearchParams(requestSpec.body);
        const outer = JSON.parse(form.get('f.req'));
        const call = outer[0][0];
        assert.equal(call[0], 'L5adhe');
        const args = JSON.parse(call[1]);
        assert.equal(args[1], null);
        assert.deepEqual(args[2], [args[0].length]);
        assert.equal(args[0].length, 41);
        assert.ok(args[0].slice(0, 40).every((item) => item === null));
        assert.ok(args[0][40] === 0 || args[0][40] === 1);
        state.preferenceValue = args[0][40] === 1;
        state.writes += 1;
        const body = frame('L5adhe', [null, 0]);
        return {
          capability,
          httpStatus: updateStatus,
          contentType: 'application/json',
          body,
          responseBytes: body.length,
          responseSha256: digestBody(body),
          responseContractCaptured: true,
          credentialPropagated: true,
          dispatchStartedAt: new Date().toISOString(),
          responseReceivedAt: new Date().toISOString(),
        };
      },
    },
    async verifyOwner(expectedOwner) {
      assert.equal(expectedOwner, OWNER);
      return {
        ownerMatched: true,
        anonymousOwnerAbsent: true,
        httpStatus: 200,
        responseBytes: 123,
        responseSha256: 'a'.repeat(64),
        anonymousHttpStatus: 200,
        credentialPropagated: true,
        request: {
          method: 'GET', origin: SERVICE_ORIGIN, path: '/app', queryKeys: [],
          headerNames: ['user-agent'], valuesPersisted: false,
        },
      };
    },
    async read(capability, requestSpec) {
      assert.equal(capability, 'settings_read');
      const form = new URLSearchParams(requestSpec.body);
      const outer = JSON.parse(form.get('f.req'));
      const args = JSON.parse(outer[0][0][1]);
      assert.deepEqual(args, [null, [41]]);
      state.readFieldIds.push(args[1][0]);
      const body = frame('ESY5D', [[{ 41: state.preferenceValue }]]);
      return {
        capability,
        httpStatus: 200,
        contentType: 'application/json',
        body,
        responseBytes: body.length,
        credentialPropagated: true,
      };
    },
  };
  return { client, state };
}

async function journalRoot() {
  const base = path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  return await mkdtemp(path.join(base, 'gemini-settings-test-'));
}

test('settings update builder emits only the source-observed field-3 L5adhe boolean', () => {
  const client = testClient().client;
  const request = buildPreferenceUpdateRequest(client, {
    preferenceKey: 'side_nav_open_by_default',
    value: false,
  });
  const query = new URLSearchParams(request.query);
  assert.equal(query.get('rpcids'), 'L5adhe');
  const form = new URLSearchParams(request.body);
  assert.deepEqual([...form.keys()], ['f.req', 'at']);
  assert.equal(form.get('at'), client.transport.session.batchContext.at);
  const outer = JSON.parse(form.get('f.req'));
  const call = outer[0][0];
  assert.deepEqual(call.slice(0, 1), ['L5adhe']);
  const args = JSON.parse(call[1]);
  assert.equal(args.length, 3);
  assert.equal(args[0].length, 41);
  assert.ok(args[0].slice(0, 40).every((item) => item === null));
  assert.equal(args[0][40], 0);
  assert.equal(args[1], null);
  assert.deepEqual(args[2], [41]);
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
});

test('preference reader decodes the current sparse-object and legacy dense-vector shapes', () => {
  assert.deepEqual(inspectPreferenceValue([[{ 41: true }]], 41), { found: true, type: 'boolean', value: true });
  const vector = Array(42).fill(null);
  vector[41] = 0;
  assert.deepEqual(inspectPreferenceValue([vector], 41), { found: true, type: 'boolean', value: false });
  assert.deepEqual(inspectPreferenceValue([[{ 41: 'false' }]], 41), { found: true, type: 'boolean', value: false });
  assert.deepEqual(inspectPreferenceValue([[{ 39: false }]], 41), { found: false, type: 'unreported' });
  assert.deepEqual(inspectPreferenceValue([[{ 41: true }], [{ 41: false }]], 41), { found: false, type: 'ambiguous' });
});

test('preference reader sends only field 41 after direct owner and anonymous checks', async () => {
  const { client, state } = testClient({ initialValue: true });
  const result = await readGeminiPreference(client, {
    expectedOwner: OWNER,
    preferenceKey: 'side_nav_open_by_default',
  });
  assert.equal(result.ownerMatched, true);
  assert.equal(result.anonymousOwnerAbsent, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.found, true);
  assert.equal(result.valueType, 'boolean');
  assert.equal(result.value, true);
  assert.deepEqual(result.request.preferenceFieldIds, [41]);
  assert.equal(result.identityRead.request.method, 'GET');
  assert.equal(result.identityRead.request.headerNames[0], 'user-agent');
  assert.deepEqual(state.readFieldIds, [41]);
});

test('unsupported privacy or memory preferences are rejected before any write', () => {
  const client = testClient().client;
  for (const preferenceKey of ['enable_memory', 'enable_personal_context', 'web_and_app_activity_enabled']) {
    assert.throws(() => buildPreferenceUpdateRequest(client, { preferenceKey, value: false }), {
      code: 'SETTINGS_UPDATE_KEY_UNSUPPORTED',
    });
  }
});

test('a same baseline mismatch blocks the one-shot request before dispatch', async () => {
  const { client, state } = testClient({ initialValue: false });
  const root = await journalRoot();
  try {
    await assert.rejects(updateGeminiPreferenceOnce(client, {
      expectedOwner: OWNER,
      preferenceKey: 'side_nav_open_by_default',
      value: false,
      baselineValue: true,
      confirmed: true,
      callerIntent: 'gemini-settings-baseline-mismatch-test',
      journalRoot: root,
    }), { code: 'SETTINGS_BASELINE_CHANGED' });
    assert.equal(state.writes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one confirmed value flip is read back and the original baseline is restored once', async () => {
  const { client, state } = testClient({ initialValue: true });
  const root = await journalRoot();
  try {
    const result = await testAndRestoreGeminiPreference(client, {
      expectedOwner: OWNER,
      preferenceKey: 'side_nav_open_by_default',
      expectedBaselineValue: true,
      callerIntent: 'gemini-settings-neutral-flip-test',
      confirmed: true,
      journalRoot: root,
    });
    assert.equal(result.outcome, 'verified_and_restored');
    assert.equal(result.expectedBaselineMatched, true);
    assert.equal(result.callerIntentCorrelationId, 'gemini-settings-neutral-flip-test');
    assert.equal(result.baselineValue, true);
    assert.equal(result.testValue, false);
    assert.equal(result.baselineRead.operation, 'settings_read');
    assert.equal(result.baselineRead.value, true);
    assert.deepEqual(result.baselineRead.request.preferenceFieldIds, [41]);
    assert.equal(result.writesSent, 2);
    assert.equal(result.restoredToBaseline, true);
    assert.equal(result.applied.readback.value, false);
    assert.equal(result.applied.readback.httpStatus, 200);
    assert.ok(result.applied.readback.responseBytes > 0);
    assert.match(result.applied.readback.responseSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.applied.readback.rpcId, 'ESY5D');
    assert.deepEqual(result.applied.readback.request.preferenceFieldIds, [41]);
    assert.equal(result.restored.readback.value, true);
    assert.ok(result.restored.readback.responseBytes > 0);
    assert.match(result.restored.readback.responseSha256, /^[a-f0-9]{64}$/);
    assert.equal(state.preferenceValue, true);
    assert.equal(state.writes, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reversible settings test enforces the caller expected baseline before any write', async () => {
  const { client, state } = testClient({ initialValue: false });
  const result = await testAndRestoreGeminiPreference(client, {
    expectedOwner: OWNER,
    preferenceKey: 'side_nav_open_by_default',
    expectedBaselineValue: true,
    callerIntent: 'gemini-settings-expected-baseline',
    confirmed: true,
  });
  assert.equal(result.outcome, 'baseline_mismatch');
  assert.equal(result.baselineValue, false);
  assert.equal(result.expectedBaselineMatched, false);
  assert.equal(result.writesSent, 0);
  assert.equal(state.writes, 0);
});

test('settings update envelope and CLI require explicit owner, stable intent, and confirmation', async () => {
  const contract = testContract();
  const packet = {
    session: {
      ...testSession({ cookieNames: ['AUTH_COOKIE'] }),
      batchContext: {
        at: 'at-token', fSid: 'f-sid', buildLabel: 'build_1', locale: 'ko',
        requestType: 'c', sourcePath: '/app', requestId: '55', historyListArgs: [28, null, [0, null, 1]],
      },
    },
    preferenceKey: 'side_nav_open_by_default',
    value: false,
    baselineValue: true,
  };
  const parsed = await readSettingsUpdateEnvelopeFromStdin(contract, {
    action: 'settings-update',
    input: Readable.from([JSON.stringify(packet)]),
  });
  assert.equal(parsed.preferenceKey, 'side_nav_open_by_default');
  assert.equal(parsed.value, false);
  assert.equal(parsed.baselineValue, true);
  assert.equal(parsed.session.cookies.length, 1);

  const readOnly = await readSettingsUpdateEnvelopeFromStdin(contract, {
    action: 'settings-read-one',
    input: Readable.from([JSON.stringify({
      session: packet.session,
      preferenceKey: 'side_nav_open_by_default',
    })]),
  });
  assert.equal(readOnly.preferenceKey, 'side_nav_open_by_default');
  assert.equal(Object.hasOwn(readOnly, 'value'), false);
  assert.equal(parseSettingsUpdateOptions([
    '--envelope-stdin', '--expect-owner', OWNER,
  ], { action: 'settings-read-one' }).confirmed, false);

  assert.deepEqual(parseSettingsUpdateOptions([
    '--envelope-stdin', '--expect-owner', OWNER, '--caller-intent', 'settings-test-v1', '--confirm',
  ]), {
    action: 'settings-update', envelopeStdin: true, confirmed: true,
    contractPath: (await import('../src/contract.mjs')).DEFAULT_CONTRACT_PATH,
    expectedOwner: OWNER, callerIntent: 'settings-test-v1',
  });
  assert.equal(parseSettingsUpdateOptions([
    '--envelope-stdin', '--expect-owner', OWNER, '--caller-intent', 'settings-test-v1', '--confirm',
  ], { action: 'settings-update-test' }).action, 'settings-update-test');
  const expectedBaseline = await readSettingsUpdateEnvelopeFromStdin(contract, {
    action: 'settings-update-test',
    input: Readable.from([JSON.stringify({
      session: packet.session,
      preferenceKey: 'side_nav_open_by_default',
      baselineValue: true,
    })]),
  });
  assert.equal(expectedBaseline.baselineValue, true);
  await assert.rejects(readSettingsUpdateEnvelopeFromStdin(contract, {
    action: 'settings-update-test',
    input: Readable.from([JSON.stringify({
      session: packet.session,
      preferenceKey: 'side_nav_open_by_default',
      baselineValue: 'true',
    })]),
  }), { code: 'SETTINGS_UPDATE_ENVELOPE_INVALID' });
  assert.throws(() => parseSettingsUpdateOptions([
    '--envelope-stdin', '--expect-owner', OWNER, '--caller-intent', 'settings-test-v1',
  ]), { code: 'SETTINGS_UPDATE_CONFIRMATION_REQUIRED' });
  await assert.rejects(readSettingsUpdateEnvelopeFromStdin(contract, {
    action: 'settings-update',
    input: Readable.from([JSON.stringify({ ...packet, preferenceKey: 'enable_memory' })]),
  }), { code: 'SETTINGS_UPDATE_ENVELOPE_INVALID' });
  await assert.rejects(readSettingsUpdateEnvelopeFromStdin(contract, {
    action: 'settings-update',
    input: Readable.from([JSON.stringify({ ...packet, baselineValue: false })]),
  }), { code: 'SETTINGS_UPDATE_ENVELOPE_INVALID' });
});
