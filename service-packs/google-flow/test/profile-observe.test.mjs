import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNetworkRecord, changedCookieNames, bodyShape, safeEndpoint } from '../src/profile-observe.mjs';

test('capture JSON retains RPC shape and signature-header presence while removing all credential values', () => {
  const secrets = ['fixture-cookie-secret','fixture-csrf-secret','fixture-token-secret','fixture-signed-url-secret'];
  const record = { observedAt: '2026-10-10', request: { method: 'POST',
    url: 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?at=' + secrets[1],
    headers: { cookie: secrets[0], authorization: secrets[2], 'content-type': 'application/x-www-form-urlencoded', 'sec-session-response': secrets[2] },
    postData: new URLSearchParams({ at: secrets[1], 'f.req': JSON.stringify([[['YhhmEf', JSON.stringify([[secrets[2]],1,null]), null,'generic']]]) }).toString() },
    response: { status: 200, headers: { 'set-cookie': secrets[0], location: 'https://host.invalid/?sig=' + secrets[3] } } };
  const safe = safeNetworkRecord(record);
  assert.equal(safe.requestBodyShape.rpc, 'YhhmEf'); assert.equal(safe.deviceSignatureHeaderPresent, true);
  assert.deepEqual(safe.requestBodyShape.payloadShape, [['[string]'],1,null]);
  for (const secret of secrets) assert.equal(JSON.stringify(safe).includes(secret), false);
});

test('binary and non-Flow requests are not interpreted as form-field names', () => {
  assert.equal(safeNetworkRecord({ request: { url: 'https://unrelated.invalid/private?token=fixture' } }), null);
  assert.equal(safeNetworkRecord({ request: { url: 'https://accounts.google.com/RotateCookies',
    postData: 'fixture-binary-token=another', headers: { 'content-type': 'application/x-protobuffer' } } }).requestBodyShape, null);
  assert.deepEqual(bodyShape({ token: 'fixture', arbitrarySecretKey: 'fixture' }),
    [{field:'token',shape:'[string]'},{field:'[field]',shape:'[string]'}]);
  assert.deepEqual(safeEndpoint('https://flow.google.com/project/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?signature=fixture'),
    {host:'flow.google.com',endpoint:'/project/{id}'});
});

test('cookie comparison reports names for changes, expiry changes and deletion without hashes or values', () => {
  const before = [{domain:'.google.com',path:'/',name:'SID',value:'fixture-a',expires:1},
    {domain:'.google.com',path:'/',name:'SIDCC',value:'fixture-b',expires:1}];
  const after = [{...before[0],value:'fixture-c',expires:2}];
  assert.deepEqual(changedCookieNames(before,after),['SID','SIDCC']);
});
