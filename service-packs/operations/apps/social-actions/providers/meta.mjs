import { openMetaContext, relayDocId, metaRequest, sendMetaQuery, metaFail, metaHash, withMetaSessionLock } from '../lib/meta-bootstrap.mjs';

function normalize(input) {
  const service = input?.service;
  const operation = input?.operation || 'follow';
  let handle = input?.target || input?.handle;
  if (!['threads', 'instagram'].includes(service) || !['follow', 'unfollow'].includes(operation) || typeof handle !== 'string') metaFail('META_ACTION_INPUT');
  if (handle.startsWith('https://')) {
    const url = new URL(handle);
    if (url.origin !== (service === 'threads' ? 'https://www.threads.com' : 'https://www.instagram.com')
      || url.username || url.password || url.search || url.hash) metaFail('META_TARGET_SCOPE');
    handle = url.pathname.replace(/^\/@?|\/$/g, '');
  }
  handle = handle.replace(/^@/, '');
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle)) metaFail('META_TARGET_INVALID');
  return { service, operation, handle: handle.toLowerCase() };
}

function relationship(user, id) {
  const userId = String(user?.pk ?? user?.id ?? '');
  const status = user?.friendship_status;
  if (id && userId !== id || !/^\d{1,30}$/.test(userId)
    || typeof status?.following !== 'boolean' || typeof status?.outgoing_request !== 'boolean') metaFail('META_RELATIONSHIP_UNVERIFIED');
  return { following: status.following, outgoingRequest: status.outgoing_request, blocking: status.blocking === true };
}

export async function readMetaRelationship(context) {
  const { service, handle, document } = context;
  if (service === 'threads') {
    const rows = document.profiles.filter(p => typeof p.friendship_status?.following === 'boolean' && typeof p.friendship_status?.outgoing_request === 'boolean');
    if (!rows.length) metaFail('META_TARGET_NOT_FOUND');
    const id = String(rows[0].pk ?? rows[0].id);
    const state = relationship(rows[0], id);
    if (rows.some(row => String(row.pk ?? row.id) !== id || JSON.stringify(relationship(row, id)) !== JSON.stringify(state))) metaFail('META_PROFILE_STATE_AMBIGUOUS');
    return { id, state, receipt: { ...context.documentReceipt, method: 'GET', source: 'profile_document', live_replay: true } };
  }
  const id = document.route?.rootView?.props?.id;
  if (!/^\d{1,30}$/.test(String(id || ''))) metaFail('META_TARGET_NOT_FOUND');
  const operation = 'PolarisProfilePageContentQuery';
  const docId = relayDocId(context, operation);
  const variables = { id: String(id), enable_integrity_filters: true };
  for (const [flag, key] of Object.entries({ PolarisCannesGuardianExperienceEnabled: '6793', PolarisCASB976ProfileEnabled: '17028',
    PolarisWebSchoolsEnabled: '17363', PolarisRepostsConsumptionEnabled: '9448', PolarisShortDramaEnabled: '12774' })) {
    const source = context.sources.get(flag + '.relayprovider')?.source;
    if (!source?.includes('("' + key + '")') || !document.gkx.has(key)) metaFail('META_PROFILE_FLAGS_CHANGED');
    variables['__relay_internal__pv__' + flag + 'relayprovider'] = flag === 'PolarisShortDramaEnabled' && document.qex.get('1697') === true
      ? document.qex.get('3668') === true : document.gkx.get(key);
  }
  const result = await sendMetaQuery(context, metaRequest(context, operation, docId, variables));
  if (result.payload.data.user?.username?.toLowerCase() !== handle) metaFail('META_TARGET_MISMATCH');
  return { id: String(id), state: relationship(result.payload.data.user, String(id)), receipt: { ...result.receipt, live_replay: true } };
}

function contract(context, operation, targetId) {
  const threads = context.service === 'threads';
  const name = threads ? 'useTHFollowMutation' + (operation === 'follow' ? 'Follow' : 'Unfollow') + 'Mutation'
    : 'usePolaris' + (operation === 'follow' ? 'Follow' : 'Unfollow') + 'Mutation';
  const moduleName = name + (threads ? '.threads.graphql' : '.graphql');
  const source = context.sources.get(moduleName)?.source;
  const root = threads ? (operation === 'follow' ? 'xdt_text_app_follow_user' : 'xdt_text_app_unfollow_user')
    : (operation === 'follow' ? 'xdt_create_friendship' : 'xdt_destroy_friendship');
  if (!source?.includes('name:"' + root + '"') || !source.includes('operationKind:"mutation"')
    || !source.includes('name:"friendship_status"') || !source.includes('name:"target_user_id"')) metaFail('META_MUTATION_CONTRACT_CHANGED');
  const docId = relayDocId(context, name, threads ? moduleName : name + '_instagramRelayOperation');
  const variables = threads ? { target_user_id: targetId, media_id_attribution: null, container_module: 'ig_text_feed_profile',
    ranking_info_token: null, barcelona_source_quote_post_id: null, barcelona_source_reply_id: null }
    : { target_user_id: targetId, container_module: 'profile', nav_chain: '' };
  if (!threads && !context.sources.get(name)?.source.includes('getNavChainForSend()')) metaFail('META_NAV_SOURCE_CHANGED');
  return { name, docId, variables, root, sourceSha256: context.sources.get(moduleName).sha256 };
}

const desired = (operation, state) => operation === 'follow' ? state.following || state.outgoingRequest : !state.following && !state.outgoingRequest;

async function prepare(input, options) {
  const spec = normalize(input);
  const context = await openMetaContext(spec.service, spec.handle, options);
  if (spec.handle === context.bundle.owner.toLowerCase()) metaFail('META_SELF_ACTION');
  const profile = await readMetaRelationship(context);
  if (profile.state.blocking) metaFail('META_TARGET_BLOCKED');
  const mutation = contract(context, spec.operation, profile.id);
  const request = metaRequest(context, mutation.name, mutation.docId, mutation.variables);
  const ready = { service: spec.service, operation: spec.operation, target: spec.handle, normalizedTarget: profile.id,
    ownerFingerprint: metaHash(spec.service + ':' + context.bundle.cookies.find(c => c.name === 'ds_user_id').value).slice(0, 16),
    ready: true, noOp: desired(spec.operation, profile.state),
    currentState: profile.state, request: { method: 'POST', path: '/api/graphql', operation: mutation.name, docId: mutation.docId,
      bodyFields: [...request.body.keys()], variableFields: Object.keys(mutation.variables) },
    captured: spec.operation === 'follow', contractEvidence: spec.operation === 'follow' ? 'browser_request_and_current_first_party_source' : 'current_first_party_source',
    responseSchemaEvidence: 'current_first_party_relay_module', sourceSha256: mutation.sourceSha256,
    requestEnvelopeEvidence: 'first_party_core_form_without_browser_telemetry', writeEnvelopeLiveVerified: false,
    client_exists: true, remnant_free: true, credential_propagated: true, credential_propagated_for_write: false,
    auth: { ownerVerified: true, provider: 'windows_dpapi_current_user', freshContext: true, sessionRenewalVerified: false },
    readReceipt: profile.receipt, live_replay: false, browserUsed: false, mutationCount: 0 };
  return { spec, context, profile, mutation, request, ready };
}

// These exported results never contain cookies, CSRF tokens, raw forms or response bodies.
export async function prepareMetaAction(input, options = {}) {
  return withMetaSessionLock(input?.service, async () => (await prepare(input, options)).ready);
}

export async function executeMetaAction(input, options = {}) {
  if (typeof options.beforeWrite !== 'function') metaFail('SOCIAL_JOURNAL_REQUIRED');
  return withMetaSessionLock(input?.service, () => execute(input, options));
}

async function execute(input, options) {
  const { spec, context, profile, mutation, request, ready } = await prepare(input, options);
  if (ready.noOp) return { ...ready, status: 'no_op', success: true, readbackVerified: true };
  if (await options.beforeWrite(ready) === false) metaFail('SOCIAL_JOURNAL_REJECTED');
  let response, responseVerified = false, failure, failureMeta = {};
  try {
    response = await sendMetaQuery(context, request);
    // Both Threads Relay modules explicitly alias xdt_text_app_*_user to "data".
    const user = spec.service === 'threads' ? response.payload.data.data?.user : response.payload.data[mutation.root];
    const state = relationship(user, profile.id);
    responseVerified = desired(spec.operation, state);
  } catch (error) {
    failure = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'META_WRITE_OUTCOME_UNKNOWN';
    for (const key of ['httpStatus', 'retryAfterSeconds', 'rateLimitReset', 'providerErrorCode']) {
      if (Number.isSafeInteger(error[key]) && error[key] >= 0) failureMeta[key] = error[key];
    }
    if (typeof error.providerErrorSummary === 'string') failureMeta.providerErrorSummary = error.providerErrorSummary.slice(0, 160);
  }
  // Once the write has been sent, always reconcile with a new independent HTTP profile read.
  let readback;
  try {
    const fresh = await openMetaContext(spec.service, spec.handle, options);
    readback = await readMetaRelationship(fresh);
    if (readback.id !== profile.id) metaFail('META_READBACK_TARGET_MISMATCH');
  } catch { readback = null; }
  if (readback && desired(spec.operation, readback.state)) return { ...ready, status: 'succeeded', success: true,
    currentState: readback.state, mutationCount: 1, readbackVerified: true, responseVerified,
    reconciledAfterAmbiguousResponse: !responseVerified, credential_propagated_for_write: responseVerified,
    writeEnvelopeLiveVerified: responseVerified,
    live_replay: true, readReceipt: readback.receipt, ...(failure ? { code: failure } : {}), ...failureMeta };
  // The service answered the mutation with GraphQL errors (no data) and a fresh independent profile read shows the desired
  // state absent: the write was refused and not applied. Report it as not sent so the journal releases the target and a later
  // run may try again (2026-10-19: a refused Threads follow otherwise blocked that follower for good).
  if (failure === 'META_GRAPHQL_REJECTED' && readback && !desired(spec.operation, readback.state)) return { ...ready,
    status: 'rejected', success: false, mutationCount: 0, writeSent: false, rejectedVerified: true, live_replay: false,
    responseVerified: false, readbackVerified: false, needs_reconciliation: false, code: failure, ...failureMeta,
    currentState: readback.state, readReceipt: readback.receipt };
  return { ...ready, status: 'outcome_unknown', success: false, mutationCount: 1, live_replay: false,
    responseVerified, readbackVerified: false, needs_reconciliation: true, code: failure || 'META_WRITE_NOT_CONFIRMED',
    ...failureMeta, ...(readback ? { currentState: readback.state, readReceipt: readback.receipt } : {}) };
}
