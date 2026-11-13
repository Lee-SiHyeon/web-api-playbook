import test from 'node:test';
import assert from 'node:assert/strict';
import { agyRemoteRpc } from '../lib/checklist/agy-remote-rpc.mjs';
import { verifyAgyRecordedEvidence } from '../lib/agy-remote-evidence.mjs';

const origin = 'https://antigravity.google.com';
const root = '/$rpc/devtools_jetski_boq_api_proto.ApiService/';
function fixture(id = 'auth.owner', method = 'GetUserStatus', api = 'ProxyCommand') {
  const request = { method: 'POST', origin, path: root + api, nativeMethod: method, httpStatus: 200, mime: 'application/json+protobuf' };
  const proof = { schema: 'web-api-agy-remote-live-v1', service: 'agy-remote', checkedAt: '2026-11-13T00:00:00Z',
    secretsPersistedInEvidence: false, ownerVerified: true, engineFreeWorkflow: false, businessMode: 'pure_http',
    capabilities: { [id]: { verified: true, request } },
    remotes: [1,2].map(n => ({ alias: `remote-${n}`, platform: n === 1 ? 'linux' : 'windows', ownerMatched: true, capabilities: { [id]: true } })) };
  return { proof, entry: { origin, path: root + api, nativeMethod: method }, cap: { id } };
}
const valid = x => agyRemoteRpc([x.proof], x.entry, x.cap);
test('POST RPC read evidence must preserve the real method, origin and native operation', () => {
  const f = fixture(); assert.equal(valid(f), true);
  for (const mutate of [x => { x.proof.capabilities['auth.owner'].request.method = 'GET'; },
    x => { x.entry.origin = 'https://example.invalid'; }, x => { x.entry.nativeMethod = 'StartCascade'; },
    x => { x.proof.remotes[1].ownerMatched = false; }, x => { x.proof.engineFreeWorkflow = true; },
    x => { x.proof.extra = { authorization: 'synthetic' }; }]) {
    const bad = structuredClone(f); mutate(bad); assert.equal(valid(bad), false);
  }
});
test('an acknowledged write needs a distinct native readback with matched expected state', () => {
  const f = fixture('messages.send', 'SendUserCascadeMessage'); const c = f.proof.capabilities['messages.send'];
  Object.assign(c, { writeSent: true, journalReserved: true, independentReadback: true,
    readback: { method: 'POST', origin, path: root + 'ProxyCommand', nativeMethod: 'GetCascadeTrajectory', httpStatus: 200, expectedMatched: true } });
  assert.equal(valid(f), true); c.readback.nativeMethod = 'SendUserCascadeMessage'; assert.equal(valid(f), false);
  c.readback.nativeMethod = 'GetCascadeTrajectory'; c.readback.expectedMatched = false; assert.equal(valid(f), false);
});
test('history receipts cannot claim a native completeness barrier that the subscription does not provide', () => {
  const f = fixture('conversations.list','JetboxSubscribeToSummaries','StreamProxyCommand');
  Object.assign(f.proof.capabilities['conversations.list'], { nativeSnapshotComplete: false, multipleBatchesVerified: true });
  assert.equal(valid(f), true); f.proof.capabilities['conversations.list'].nativeSnapshotComplete = true; assert.equal(valid(f), false);
});
test('the checked-in remote RPC receipt remains code-bound without probing current authentication', async () => {
  const result = await verifyAgyRecordedEvidence();
  assert.equal(result.implementationMatched, true); assert.equal(result.recordedLiveCapabilities, 15);
  assert.equal(result.networkUsed, false); assert.equal(result.currentAuthentication, 'not_probed');
});
