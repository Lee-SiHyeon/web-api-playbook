const ORIGIN = 'https://antigravity.google.com';
const ROOT = '/$rpc/devtools_jetski_boq_api_proto.ApiService/';
const methods = Object.freeze({
  'auth.owner': ['ProxyCommand', 'GetUserStatus'],
  'auth.session_persist': ['ProxyCommand', 'GetUserStatus'],
  'auth.cookie_maintenance': ['ProxyCommand', 'GetUserStatus'],
  'remotes.list': ['ListInstances', null],
  'projects.list': ['ProxyCommand', 'ReadProjects'],
  'models.list': ['ProxyCommand', 'GetCascadeModelConfigData'],
  'conversations.list': ['StreamProxyCommand', 'JetboxSubscribeToSummaries'],
  'conversations.read': ['ProxyCommand', 'GetCascadeTrajectory'],
  'conversations.create': ['ProxyCommand', 'StartCascade'],
  'conversations.rename': ['ProxyCommand', 'UpdateConversationAnnotations'],
  'conversations.cancel': ['ProxyCommand', 'CancelCascadeInvocation'],
  'conversations.delete': ['ProxyCommand', 'DeleteCascadeTrajectory'],
  'messages.send': ['ProxyCommand', 'SendUserCascadeMessage'],
  'messages.followup': ['ProxyCommand', 'SendUserCascadeMessage'],
  'messages.wait': ['ProxyCommand', 'GetCascadeTrajectory'],
});
const writes = new Set(['conversations.create','conversations.rename','conversations.cancel','conversations.delete','messages.send','messages.followup']);
const secret = /^(?:cookies?|cookieJar|headers|authorization|password|apiKey|accessToken|refreshToken|rawCapture|rawBody|state)$/i;
function containsSecrets(value) {
  return value !== null && typeof value === 'object' && Object.entries(value).some(([key, child]) => secret.test(key) || containsSecrets(child));
}
const rpc = (value, api, native) => value?.method === 'POST' && value.origin === ORIGIN && value.path === ROOT + api
  && value.httpStatus === 200 && value.mime === 'application/json+protobuf' && value.nativeMethod === native;

/** POST RPC reads must not be misrepresented as GET merely to satisfy a generic receipt. */
export function agyRemoteRpc([proof], entry, cap) {
  const spec = methods[cap.id], capability = proof?.capabilities?.[cap.id];
  if (!spec || proof?.schema !== 'web-api-agy-remote-live-v1' || proof.service !== 'agy-remote'
    || entry.origin !== ORIGIN || entry.path !== ROOT + spec[0] || entry.nativeMethod !== spec[1]
    || !Number.isFinite(Date.parse(proof.checkedAt)) || proof.secretsPersistedInEvidence !== false
    || proof.ownerVerified !== true || proof.engineFreeWorkflow !== false || proof.businessMode !== 'pure_http'
    || containsSecrets(proof) || capability?.verified !== true || !rpc(capability.request, ...spec)
    || !Array.isArray(proof.remotes) || proof.remotes.length !== 2
    || new Set(proof.remotes.map(x => x.alias)).size !== 2
    || !proof.remotes.every(x => /^remote-[12]$/.test(x.alias) && x.ownerMatched === true
      && ['linux','windows'].includes(x.platform) && x.capabilities?.[cap.id] === true)) return false;
  if (writes.has(cap.id) && (capability.writeSent !== true || capability.journalReserved !== true
    || capability.independentReadback !== true || capability.readback?.method !== 'POST'
    || capability.readback.origin !== ORIGIN || capability.readback.httpStatus !== 200
    || capability.readback.expectedMatched !== true
    || !['GetCascadeTrajectory','GetAllCascadeTrajectories','JetboxSubscribeToSummaries'].includes(capability.readback.nativeMethod)
    || capability.readback.path !== ROOT + 'ProxyCommand' && capability.readback.path !== ROOT + 'StreamProxyCommand')) return false;
  if (cap.id === 'conversations.list' && (capability.nativeSnapshotComplete !== false || capability.multipleBatchesVerified !== true)) return false;
  if (cap.id === 'messages.followup' && (capability.sameConversation !== true || capability.previousResponseRetained !== true)) return false;
  if (cap.id === 'conversations.cancel' && capability.runningBeforeCancellation !== true) return false;
  if (cap.id === 'auth.cookie_maintenance' && (capability.browserRequired !== true || capability.navigated !== false
    || capability.agePolicyClockAdvancedForTest !== true || capability.automaticGoogleLogin !== false)) return false;
  return true;
}
