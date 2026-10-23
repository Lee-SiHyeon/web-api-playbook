import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThreadsAccountStatus, readThreadsAccountStatus, safeThreadsAccountStatus,
  hasThreadsAccountWriteRestrictionSignal } from '../threads-account-status.mjs';

const ownerId = '17824859444', owner = 'lifehack__ailab';
const payload = () => ({ data: { viewer: { user: { id: ownerId, username: owner, profile_pic_url: 'PRIVATE_IMAGE_URL' } },
  xth_viewer: { account_status_web: { feature_limit_status: 'OK', feed_demotions_status: 'OK',
    strike_violation_list: [], strike_messaging_violation_list: [] } } } });
const context = () => ({ service: 'threads', createdAt: Date.now(), requestCount: 0, url: 'https://www.threads.com/@' + owner + '/',
  bundle: { service: 'threads', origin: 'https://www.threads.com', owner, ownerId,
    cookies: [{ name: 'csrftoken', value: 'FIXTURE_CSRF_DO_NOT_RECORD', domain: '.threads.com' }] },
  document: { modules: new Map([
    ['DTSGInitialData', { token: 'FIXTURE_DTSG_DO_NOT_RECORD' }], ['LSD', { token: 'FIXTURE_LSD_DO_NOT_RECORD' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
    ['SiteData', { haste_session: 'fixture', pr: 1, client_revision: '1', hsi: '1', comet_env: '0', __spin_r: '1', __spin_b: 'trunk', __spin_t: '1' }],
    ['RelayAPIConfigDefaults', { actorID: ownerId, customHeaders: { 'x-ig-app-id': 'fixture-app' } }],
  ]) }, sources: new Map([['DTSGUtils', { source: 'SprinkleConfig .charCodeAt(' }]]),
  documentReceipt: { httpStatus: 200, ownerVerified: true, browserUsed: false } });
const local = { sessionLock: async (_service, fn) => fn(), readCooldown: async () => null };

test('only observed owner status is returned; OK never proves configure permission or a refusal cause', () => {
  const source = payload();
  source.data.xth_viewer.account_status_web.strike_violation_list = [{ caption: 'PRIVATE_CONTENT', appeal_token: 'PRIVATE_TOKEN' }];
  const result = parseThreadsAccountStatus(source, ownerId);
  assert.equal(result.featureLimitStatus, 'OK'); assert.equal(result.removedContentCount, 1);
  assert.equal(result.displayedFeatureRestrictions, false); assert.equal(result.configurePermissionEstablished, false);
  assert.equal(result.integrityCauseEstablished, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('a foreign viewer and a missing violation list cannot masquerade as a clean account', () => {
  const foreign = payload(); foreign.data.viewer.user.id = '12345';
  assert.throws(() => parseThreadsAccountStatus(foreign, ownerId), { code: 'THREADS_ACCOUNT_STATUS_OWNER_MISMATCH' });
  const incomplete = payload(); delete incomplete.data.xth_viewer.account_status_web.strike_violation_list;
  assert.throws(() => parseThreadsAccountStatus(incomplete, ownerId), { code: 'THREADS_ACCOUNT_STATUS_SCHEMA' });
  const unknown = payload(); unknown.data.xth_viewer.account_status_web.feature_limit_status = 'UNOBSERVED_ENUM';
  assert.equal(parseThreadsAccountStatus(unknown, ownerId).displayedFeatureRestrictions, null);
});

test('status sanitization strips arbitrary fields and does not trust permission claims from callers', () => {
  const value = { service: 'threads', owner, httpStatus: 200, checkedAt: '2026-10-01T21:49:39Z',
    ...parseThreadsAccountStatus(payload(), ownerId), configurePermissionEstablished: true,
    cookie: 'DO_NOT_RECORD', profile_pic_url: 'DO_NOT_RECORD', integrityCauseEstablished: true };
  const safe = safeThreadsAccountStatus(value);
  assert.equal(safe.configurePermissionEstablished, false); assert.equal(safe.integrityCauseEstablished, false);
  assert.equal(JSON.stringify(safe).includes('DO_NOT_RECORD'), false);
  assert.equal(safeThreadsAccountStatus({ ...value, owner: 'other_owner' }), null);
  assert.equal(safeThreadsAccountStatus({ ...value, httpStatus: 400 }), null);
  assert.equal(safeThreadsAccountStatus({ ...value, removedContentCount: null }), null);
});

test('only explicit account status restriction signals create an account-wide write hold', () => {
  const clean=safeThreadsAccountStatus({service:'threads',owner,ownerVerified:true,httpStatus:200,checkedAt:'2026-10-01T21:49:39Z',
    ...parseThreadsAccountStatus(payload(),ownerId)});
  assert.equal(hasThreadsAccountWriteRestrictionSignal(clean),false);
  assert.equal(hasThreadsAccountWriteRestrictionSignal({...clean,featureLimitStatus:'UNRECOGNIZED'}),true);
  assert.equal(hasThreadsAccountWriteRestrictionSignal({...clean,feedDemotionsStatus:'UNRECOGNIZED'}),true);
  assert.equal(hasThreadsAccountWriteRestrictionSignal({...clean,displayedFeatureRestrictions:true}),true);
  assert.equal(hasThreadsAccountWriteRestrictionSignal({featureLimitStatus:'UNRECOGNIZED'}),false);
});

test('the observed empty-variable query reads status once and fake transport never claims live replay', async () => {
  let reads = 0;
  const result = await readThreadsAccountStatus({ ...local, contextLoader: async () => context(),
    querySender: async (_ctx, request) => {
      reads++;
      assert.equal(request.url, 'https://www.threads.com/api/graphql');
      assert.equal(request.body.get('fb_api_req_friendly_name'), 'BarcelonaSettingsAccountStatusTabQuery');
      assert.deepEqual(JSON.parse(request.body.get('variables')), {});
      assert.equal(request.body.get('__crn'), 'comet.threads.BarcelonaSettingsHomeRoute');
      assert.equal(request.headers.referer, 'https://www.threads.com/settings');
      return { payload: payload(), receipt: { httpStatus: 200 } };
    } });
  assert.equal(reads, 1); assert.equal(result.socialWrites, 0); assert.equal(result.live_replay, false);
  assert.equal(result.credential_propagated, false); assert.equal(JSON.stringify(result).includes('DO_NOT_RECORD'), false);
});

test('a shared throttle prevents bootstrap and query; account OK cannot be read around the gate', async () => {
  let calls = 0;
  await assert.rejects(readThreadsAccountStatus({ ...local,
    readCooldown: async () => ({ retryAt: Date.now() + 60_000, httpStatus: 200 }),
    contextLoader: async () => { calls++; return context(); }, querySender: async () => { calls++; return { payload: payload() }; } }),
  { code: 'META_GRAPHQL_THROTTLED', dispatchStarted: false, writeSent: false });
  assert.equal(calls, 0);
});
