import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { openMetaContext, metaRequest, sendMetaQuery, withMetaSessionLock } from './lib/meta-bootstrap.mjs';
import { readThreadsSharedCooldown, THREADS_GRAPHQL_THROTTLED } from './lib/threads-graphql-throttle.mjs';

const OWNER = 'lifehack__ailab';
const ORIGIN = 'https://www.threads.com';
// Observed by opening Settings > Account status on 2026-10-01. This is a read,
// including its POST transport. No restriction, appeal or setting is changed.
export const THREADS_ACCOUNT_STATUS_CONTRACT = Object.freeze({
  operation: 'BarcelonaSettingsAccountStatusTabQuery', docId: '27410180565319434',
  path: '/api/graphql', canonicalRouteName: 'comet.threads.BarcelonaSettingsHomeRoute',
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
const statusValue = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;

export function parseThreadsAccountStatus(payload, ownerId) {
  const viewer = payload?.data?.viewer?.user;
  if (String(viewer?.id || '') !== String(ownerId || '') || !ownerId
    || viewer?.username?.toLowerCase() !== OWNER) fail('THREADS_ACCOUNT_STATUS_OWNER_MISMATCH');
  const status = payload?.data?.xth_viewer?.account_status_web;
  const featureLimitStatus = statusValue(status?.feature_limit_status);
  const feedDemotionsStatus = statusValue(status?.feed_demotions_status);
  if (!featureLimitStatus || !feedDemotionsStatus || !Array.isArray(status?.strike_violation_list)
    || !Array.isArray(status?.strike_messaging_violation_list)) fail('THREADS_ACCOUNT_STATUS_SCHEMA');
  return {
    ownerVerified: true, featureLimitStatus, feedDemotionsStatus,
    removedContentCount: status.strike_violation_list.length,
    messagingViolationCount: status.strike_messaging_violation_list.length,
    displayedFeatureRestrictions: featureLimitStatus === 'OK' ? false : null,
    // Account-status OK does not establish that configure will accept a post.
    configurePermissionEstablished: false, integrityCauseEstablished: false,
  };
}

export function safeThreadsAccountStatus(value) {
  if (value?.service !== 'threads' || value.owner !== OWNER || value.ownerVerified !== true
    || value.httpStatus !== 200 || !statusValue(value.featureLimitStatus) || !statusValue(value.feedDemotionsStatus)
    || !Number.isSafeInteger(value.removedContentCount) || value.removedContentCount < 0
    || !Number.isSafeInteger(value.messagingViolationCount) || value.messagingViolationCount < 0
    || !Number.isFinite(Date.parse(value.checkedAt || ''))) return null;
  return {
    checkedAt: new Date(value.checkedAt).toISOString(), httpStatus: 200, ownerVerified: true,
    featureLimitStatus: value.featureLimitStatus === 'OK' ? 'OK' : 'UNRECOGNIZED',
    feedDemotionsStatus: value.feedDemotionsStatus === 'OK' ? 'OK' : 'UNRECOGNIZED',
    removedContentCount: value.removedContentCount, messagingViolationCount: value.messagingViolationCount,
    displayedFeatureRestrictions: value.displayedFeatureRestrictions === true ? true
      : value.featureLimitStatus === 'OK' ? false : null,
    configurePermissionEstablished: false, integrityCauseEstablished: false,
  };
}

export function hasThreadsAccountWriteRestrictionSignal(value) {
  return value?.ownerVerified === true && (
    value.featureLimitStatus != null && value.featureLimitStatus !== 'OK'
    || value.feedDemotionsStatus != null && value.feedDemotionsStatus !== 'OK'
    || value.displayedFeatureRestrictions === true
  );
}

export async function readThreadsAccountStatus({
  contextLoader = openMetaContext, querySender = sendMetaQuery, sessionLock = withMetaSessionLock,
  readCooldown = readThreadsSharedCooldown,
} = {}) {
  return sessionLock('threads', async () => {
    const cooldown = await readCooldown();
    if (cooldown) throw Object.assign(new Error(cooldown.code || THREADS_GRAPHQL_THROTTLED), {
      ...cooldown, code: cooldown.code || THREADS_GRAPHQL_THROTTLED, dispatchStarted: false, writeSent: false,
    });
    const context = await contextLoader('threads', OWNER);
    if (context?.service !== 'threads' || context.bundle?.service !== 'threads'
      || context.bundle?.owner !== OWNER || !context.bundle.ownerId || context.documentReceipt?.ownerVerified !== true) {
      fail('THREADS_ACCOUNT_STATUS_CONTEXT_OWNER_MISMATCH');
    }
    const contract = THREADS_ACCOUNT_STATUS_CONTRACT;
    const request = metaRequest(context, contract.operation, contract.docId, {}, {
      graphPath: contract.path, canonicalRouteName: contract.canonicalRouteName,
    });
    request.headers.referer = ORIGIN + '/settings';
    const response = await querySender(context, request);
    const result = parseThreadsAccountStatus(response?.payload ?? response, context.bundle.ownerId);
    const realTransport = contextLoader === openMetaContext && querySender === sendMetaQuery;
    return {
      service: 'threads', operation: 'account_status', owner: OWNER,
      ...result, httpStatus: response?.receipt?.httpStatus ?? response?.httpStatus ?? 200, checkedAt: new Date().toISOString(),
      executionMode: 'pure_http', browserUsed: false, socialWrites: 0,
      credentialProvider: 'windows_dpapi_current_user', credentialValuesRecorded: false,
      captured: true, client_exists: true, remnant_free: true,
      credential_propagated: realTransport, live_replay: realTransport,
    };
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) {
    console.log(JSON.stringify({ service: 'threads', code: 'THREADS_ACCOUNT_STATUS_ARGUMENT_INVALID', socialWrites: 0 }));
    process.exitCode = 2;
  } else readThreadsAccountStatus().then(result => console.log(JSON.stringify(result))).catch(error => {
    const code = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'THREADS_ACCOUNT_STATUS_FAILED';
    console.log(JSON.stringify({ service: 'threads', operation: 'account_status', code,
      httpStatus: error.httpStatus ?? null, retryAt: error.retryAt ?? null, socialWrites: 0,
      credentialValuesRecorded: false, configurePermissionEstablished: false }));
    process.exitCode = 2;
  });
}
