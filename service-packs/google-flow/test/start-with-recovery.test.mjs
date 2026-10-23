import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowDocumentDiagnostics, createFlowDocumentError } from '../src/document-diagnostics.mjs';
import { formatSafeFlowRecoveryContext, startFlowWithRecovery } from '../src/start-with-recovery.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';

function missingRequestTokenError(querySecret = 'private-query-secret') {
  const diagnostics = createFlowDocumentDiagnostics({
    httpStatus: 200,
    mime: 'text/html; charset=utf-8',
    sourcePath: `/project/${PROJECT_ID}`,
    responseUrl: `${FLOW_ORIGIN}/project/${PROJECT_ID}?token=${querySecret}`,
    html: '<script>{"FdrFJe":"private-sid","cfb2h":"private-build"}</script>',
  });
  return createFlowDocumentError('missing request token', {
    code: 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING', diagnostics,
  });
}

test('successful startup does not request any account session recovery', async () => {
  let recovered = 0;
  await startFlowWithRecovery({ async start() {} }, { recoverImpl: async () => { recovered++; } });
  assert.equal(recovered, 0);
});

test('missing document context performs one protected recovery before retrying startup', async () => {
  const order=[]; const failure=Object.assign(new Error('missing'),{code:'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING'});
  const client={async start(){order.push('start');if(order.length===1)throw failure;}};
  await startFlowWithRecovery(client,{credentialExistsImpl:()=>true,recoverImpl:async()=>{order.push('recover');return {ownerVerified:true};},onRecovery:receipt=>{assert.equal(receipt.ownerVerified,true);order.push('receipt');}});
  assert.deepEqual(order,['start','recover','receipt','start']);
});

test('without a protected Google broker the original startup error is preserved', async () => {
  const failure=Object.assign(new Error('missing'),{code:'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING'});
  await assert.rejects(startFlowWithRecovery({async start(){throw failure;}},{credentialExistsImpl:()=>false,recoverImpl:async()=>{assert.fail('must not recover');}}),e=>e===failure);
});

for (const [storeCode, expectedCode] of [
  ['CREDENTIAL_STORE_TIMEOUT', 'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_STATUS_TIMEOUT'],
  ['CREDENTIAL_STORE_UNREADABLE', 'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_STATUS_FAILED'],
]) test(`credential status ${storeCode} preserves startup diagnostics and stops before recovery`, async () => {
  const startupError = missingRequestTokenError('startup-private-query');
  const storeFailure = Object.assign(new Error('store-private-owner store-private-cookie'), { code: storeCode });
  let starts = 0;
  let recoveries = 0;

  await assert.rejects(startFlowWithRecovery({
    async start() { starts += 1; throw startupError; },
  }, {
    credentialExistsImpl() { throw storeFailure; },
    async recoverImpl() { recoveries += 1; throw new Error('must not recover'); },
  }), error => {
    assert.equal(error.code, expectedCode);
    const context = formatSafeFlowRecoveryContext(error);
    assert.match(context, /startupErrorCode=FLOW_DOCUMENT_REQUEST_TOKEN_MISSING/);
    assert.match(context, /documentHttpStatus=200/);
    assert.match(context, /documentMarkerPresence=SNlM0e:false/);
    assert.match(context, /recoveryHops=none/);
    for (const secret of ['startup-private-query', 'store-private-owner', 'store-private-cookie']) {
      assert.equal(context.includes(secret), false);
    }
    assert.equal(starts, 1, 'status lookup failure does not retry Flow startup');
    assert.equal(recoveries, 0, 'status lookup failure does not attempt session recovery');
    return true;
  });
});

for(const error of [
  {code:'FLOW_DOCUMENT_HTTP_ERROR',httpStatus:500},
  {code:'FLOW_DOCUMENT_REDIRECT',redirectCategory:'other'},
  {code:'FLOW_GENERATION_REQUEST_INVALID'},
  {code:'FLOW_RPC_FAILED',ambiguous:true},
  {code:'CREDENTIAL_STORE_TIMEOUT'},
]) test(`startup ${error.code}/${error.httpStatus??error.redirectCategory??'other'} is never automatically retried`,async()=>{
  const failure=Object.assign(new Error('failure'),error);let attempts=0;
  await assert.rejects(startFlowWithRecovery({async start(){attempts++;throw failure;}},{credentialExistsImpl:()=>{assert.fail('broker must not be read');},recoverImpl:async()=>{assert.fail('must not recover');}}),e=>e===failure);
  assert.equal(attempts,1);
});

test('a second rejected startup is propagated without another recovery', async()=>{
  const failure=Object.assign(new Error('missing'),{code:'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING'});let recovered=0;let started=0;
  await assert.rejects(startFlowWithRecovery({async start(){started++;throw failure;}},{credentialExistsImpl:()=>true,recoverImpl:async()=>{recovered++;return {};}}),e=>e===failure);
  assert.equal(started,2);assert.equal(recovered,1);
});

test('recovery failure never starts the Flow client again',async()=>{
  let started=0;const failure=Object.assign(new Error('owner mismatch'),{code:'FLOW_SSO_OWNER_MISMATCH'});
  await assert.rejects(startFlowWithRecovery({async start(){started++;throw Object.assign(new Error('missing'),{code:'FLOW_DOCUMENT_AUTH_COOKIE_DELETED'});}},{credentialExistsImpl:()=>true,recoverImpl:async()=>{throw failure;}}),e=>e===failure);
  assert.equal(started,1);
});

test('failed recovery preserves safe original document diagnostics and observed hops exactly once', async () => {
  const startupError = missingRequestTokenError();
  const secrets = {
    owner: 'private-owner@example.invalid',
    cookie: 'synthetic-cookie-value-secret',
    query: 'private-query-secret',
    hash: 'B'.repeat(64),
    html: '<html>synthetic-private-html</html>',
  };
  const recoveryError = Object.assign(new Error(Object.values(secrets).join(' ')), {
    code: 'FLOW_SSO_RECOVERY_LOGIN_REQUIRED',
    recoveryDiagnostics: {
      hops: [
        {
          host: 'flow.google.com', path: 'project', status: 302,
          requestCookieCount: 2, requestCookieNames: ['SID', 'SIDCC'],
          responseCookieCount: 0, responseCookieNames: [],
        },
        {
          host: 'accounts.google.com', path: 'servicelogin', status: 302,
          requestCookieCount: 2, requestCookieNames: ['SID', 'SIDCC'],
          responseCookieCount: 1, responseCookieNames: ['GAPS'],
        },
      ],
    },
  });
  let starts = 0;
  let recoveries = 0;

  await assert.rejects(startFlowWithRecovery({
    async start() { starts += 1; throw startupError; },
  }, {
    credentialExistsImpl: () => true,
    async recoverImpl() { recoveries += 1; throw recoveryError; },
  }), error => {
    assert.equal(error, recoveryError);
    assert.equal(error.code, 'FLOW_SSO_RECOVERY_LOGIN_REQUIRED');
    assert.equal(error.startupFailure.code, 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING');
    const context = formatSafeFlowRecoveryContext(error);
    assert.match(context, /startupErrorCode=FLOW_DOCUMENT_REQUEST_TOKEN_MISSING/);
    assert.match(context, /documentHttpStatus=200/);
    assert.match(context, /documentMarkerPresence=SNlM0e:false/);
    assert.match(context, /flow\.google\.com\/project:status=302/);
    assert.match(context, /accounts\.google\.com\/servicelogin:status=302/);
    assert.match(context, /responseCookieNames=GAPS/);
    for (const secret of Object.values(secrets)) assert.equal(context.includes(secret), false);
    assert.doesNotMatch(context, /https?:\/\/|first-private-query|private-query|123e4567|private-sid|private-build/);
    assert.equal(starts, 1, 'a failed recovery does not retry Flow startup');
    assert.equal(recoveries, 1, 'automatic recovery runs only once');
    return true;
  });
});

test('a failed post-recovery startup retains the first document error and recovery receipt summary', async () => {
  const startupError = missingRequestTokenError('first-private-query');
  const retryError = missingRequestTokenError('retry-private-query');
  let starts = 0;
  let recoveries = 0;
  await assert.rejects(startFlowWithRecovery({
    async start() { starts += 1; throw starts === 1 ? startupError : retryError; },
  }, {
    credentialExistsImpl: () => true,
    async recoverImpl() {
      recoveries += 1;
      return { hops: [{ host: 'flow.google.com', path: 'project', status: 200,
        requestCookieCount: 2, requestCookieNames: ['OSID', '__Secure-OSID'],
        responseCookieCount: 0, responseCookieNames: [] }] };
    },
  }), error => {
    assert.equal(error, retryError);
    const context = formatSafeFlowRecoveryContext(error);
    assert.match(context, /startupErrorCode=FLOW_DOCUMENT_REQUEST_TOKEN_MISSING/);
    assert.match(context, /flow\.google\.com\/project:status=200/);
    assert.doesNotMatch(context, /first-private-query|retry-private-query|123e4567/);
    assert.equal(starts, 2);
    assert.equal(recoveries, 1);
    return true;
  });
});
