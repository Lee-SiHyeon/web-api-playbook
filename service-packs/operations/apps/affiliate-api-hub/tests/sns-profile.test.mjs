import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROFILE, PROFILE_OWNER, buildInstagramPostReadbackRequest, buildInstagramProfileEditRequest,
  buildFreshInstagramProfilePictureMutationRequest, buildInstagramProfilePictureRequests, buildInstagramProfileReadbackRequest,
  buildThreadsPostReadbackRequest, buildThreadsProfileEditRequest, sendInstagramProfile, sendInstagramProfilePicture,
} from '../scripts/sns/writers/profile.mjs';
import { runSnsProfile } from '../scripts/sns-profile.mjs';

const session = service => ({
  service, owner: 'lifehack__ailab',
  cookies: ['sessionid', 'csrftoken', 'ds_user_id', 'rur'].map(name => ({ name, value: `fake-${name}` })),
  ownerRequest: { headers: {
    'x-ig-app-id': 'fake-app-id', 'x-fb-lsd': 'fake-lsd', 'x-asbd-id': 'fake-asbd',
    'x-web-session-id': 'fake-web-session', 'x-ig-www-claim': 'fake-claim',
    'x-web-device-id': 'fake-device', 'x-instagram-ajax': 'fake-ajax',
  } },
});

function png(width = 1000, height = 1000) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function freshMetaContext(igSession) {
  return {
    bundle: { ...igSession, origin: 'https://www.instagram.com', cookies: igSession.cookies.map(cookie => ({
      ...cookie, domain: 'instagram.com', path: '/', secure: true,
    })) },
    createdAt: Date.now(), requestCount: 0,
    document: {
      modules: new Map([
        ['SiteData', { haste_session: 'hs', pr: 1, client_revision: 2, hsi: 'hsi', comet_env: 1,
          __spin_r: 3, __spin_b: 'trunk', __spin_t: 4 }],
        ['RelayAPIConfigDefaults', { actorID: '12345', graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'fresh-app' } }],
        ['DTSGInitialData', { token: 'fresh-dtsg-token' }],
        ['LSD', { token: 'fresh-lsd-token' }],
        ['CurrentUserInitialData', { USER_ID: '12345' }],
        ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
      ]),
      route: { canonicalRouteName: 'InstagramProfileRoute' },
    },
    sources: new Map([['DTSGUtils', { source: 'token.charCodeAt(0); SprinkleConfig' }]]),
  };
}

async function tempDir(t, prefix = 'sns-profile-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Instagram profile edit builds verified form fields and marks bio_links as optional shape', () => {
  assert.equal(DEFAULT_PROFILE.owner, 'lifehack__ailab');
  assert.equal(DEFAULT_PROFILE.name, '생활이득AI연구소');
  assert.equal(DEFAULT_PROFILE.bio, 'AI로 비교한 생활 이득 🧠\n최저가·혜택·여행 특가를 매일 정리해요\n전체 비교표는 👇 블로그에서');
  assert.deepEqual(DEFAULT_PROFILE.bioLinks, [
    { url: 'https://blog.naver.com/aicandoanything', title: '전체 비교표' },
    { url: 'https://cafe.naver.com/lifehackailab', title: '네이버 카페' },
  ]);
  const request = buildInstagramProfileEditRequest({ session: session('instagram') });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://www.instagram.com/api/v1/web/accounts/edit/');
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = request.body;
  assert.equal(body.get('first_name'), DEFAULT_PROFILE.name);
  assert.equal(body.get('biography'), DEFAULT_PROFILE.bio);
  assert.equal(body.get('external_url'), DEFAULT_PROFILE.website);
  assert.equal(body.get('username'), 'lifehack__ailab');
  assert.equal(body.get('chaining_enabled'), '');
  assert.deepEqual(JSON.parse(body.get('bio_links')), DEFAULT_PROFILE.bioLinks);
  assert.equal(body.has('email'), false);
  assert.equal(body.has('phone_number'), false);
});

test('Instagram profile picture builds rupload then Relay set-picture requests', () => {
  const requests = buildInstagramProfilePictureRequests({ bytes: png(), width: 1000, height: 1000,
    uploadId: 'picture-1', session: session('instagram') });
  assert.equal(requests.length, 2);
  const [upload, setPicture] = requests;
  assert.equal(upload.url, 'https://i.instagram.com/rupload_igphoto/fb_uploader_picture-1');
  assert.equal(upload.method, 'POST');
  assert.equal(upload.headers.Offset, '0');
  assert.equal(upload.headers['X-Entity-Length'], '24');
  assert.equal(upload.headers['X-Entity-Name'], 'fb_uploader_picture-1');
  assert.equal(upload.headers['X-Entity-Type'], 'image/png');
  assert.equal(upload.headers['X-Web-Device-Id'], undefined);
  assert.deepEqual(JSON.parse(upload.headers['X-Instagram-Rupload-Params']), {
    media_type: 1, upload_id: 'picture-1', upload_media_height: 1000, upload_media_width: 1000,
  });
  assert.equal(setPicture.url, 'https://www.instagram.com/api/graphql');
  assert.equal(setPicture.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = setPicture.body;
  assert.equal(body.get('doc_id'), '28293585443628449');
  assert.equal(body.get('fb_api_caller_class'), 'RelayModern');
  assert.equal(body.get('fb_api_req_friendly_name'), 'PolarisUserActionSetProfilePicMutation');
  assert.deepEqual(JSON.parse(body.get('variables')), { upload_id: 'picture-1' });
});

test('profile picture mutation uses fresh first-party document parameters', () => {
  const igSession = session('instagram');
  const request = buildFreshInstagramProfilePictureMutationRequest({ uploadId: 'fresh-1', session: igSession,
    context: freshMetaContext(igSession) });
  const form = request.body;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://www.instagram.com/api/graphql');
  assert.equal(form.get('fb_dtsg'), 'fresh-dtsg-token');
  assert.equal(form.get('lsd'), 'fresh-lsd-token');
  assert.equal(form.get('jazoest'), '21605');
  assert.equal(request.headers['x-fb-lsd'], 'fresh-lsd-token');
  assert.equal(request.headers['x-ig-app-id'], 'fresh-app');
  assert.equal(request.headers.referer, 'https://www.instagram.com/accounts/edit/');
  assert.deepEqual(JSON.parse(form.get('variables')), { upload_id: 'fresh-1' });
});

test('Instagram profile and post readbacks build owner-scoped GET and Relay query requests', () => {
  const igSession = session('instagram');
  const profileRead = buildInstagramProfileReadbackRequest({ session: igSession });
  assert.equal(profileRead.method, 'GET');
  assert.equal(profileRead.url, 'https://www.instagram.com/api/v1/accounts/edit/web_form_data/');
  const postRead = buildInstagramPostReadbackRequest({ shortcode: 'Abc123_X', session: igSession });
  assert.equal(postRead.method, 'POST');
  assert.equal(postRead.url, 'https://www.instagram.com/api/graphql');
  assert.equal(postRead.body.get('doc_id'), '27830990013244856');
  assert.equal(postRead.body.get('fb_api_caller_class'), 'RelayModern');
  assert.deepEqual(JSON.parse(postRead.body.get('variables')), { shortcode: 'Abc123_X' });
});

test('Threads profile edit fails closed while the candidate permalink readback stays owner scoped', () => {
  assert.throws(() => buildThreadsProfileEditRequest({ session: session('threads') }),
    error => error.code === 'THREADS_PROFILE_CONTRACT_MISSING');
  const request = buildThreadsPostReadbackRequest({ permalink: 'https://www.threads.com/@lifehack__ailab/post/Abc123/',
    session: session('threads') });
  assert.equal(request.method, 'GET');
  assert.equal(request.contractStatus, 'assumed');
  assert.throws(() => buildThreadsPostReadbackRequest({ permalink: 'https://threads.com/@someone/post/Abc123',
    session: session('threads') }), error => error.code === 'THREADS_PERMALINK_INVALID');
});

test('all profile write builders reject a different owner', () => {
  const wrongInstagramOwner = { ...session('instagram'), owner: 'other_account' };
  const wrongThreadsOwner = { ...session('threads'), owner: 'other_account' };
  assert.throws(() => buildInstagramProfileEditRequest({ session: wrongInstagramOwner }),
    error => error.code === 'META_OWNER_MISMATCH');
  assert.throws(() => buildInstagramProfilePictureRequests({ bytes: png(), width: 1000, height: 1000,
    uploadId: 'id', session: wrongInstagramOwner }), error => error.code === 'META_OWNER_MISMATCH');
  assert.throws(() => buildThreadsProfileEditRequest({ session: wrongThreadsOwner }),
    error => error.code === 'META_OWNER_MISMATCH');
});

test('journaled Instagram profile sender uses fake transport and checks web_form_data readback', async t => {
  const journalDir = await tempDir(t);
  const requests = [];
  const responses = [
    { status: 200, body: { form_data: { username: 'lifehack__ailab', chaining_enabled: true, gender: 3 } } },
    { status: 200, body: { status: 'ok' } },
    { status: 200, body: { status: 'ok' } },
    { status: 200, body: { data: { xig_web_set_profile_picture: { user: { profile_pic_url: 'https://cdn.example/p.png' } } } } },
    { status: 200, body: { form_data: { username: 'lifehack__ailab', first_name: DEFAULT_PROFILE.name,
      biography: DEFAULT_PROFILE.bio, external_url: DEFAULT_PROFILE.website } } },
  ];
  const result = await sendInstagramProfile({ approvalId: 'fake-approval', profile: { ...DEFAULT_PROFILE, bioLinks: undefined },
    picture: { bytes: png(), width: 1000, height: 1000 }, session: session('instagram'), rotateCookies: async () => {},
    journalDir, runKey: 'profile-run', uploadIdFactory: () => 'photo-1', transport: async request => {
      requests.push(request);
      const next = responses.shift();
      return { status: next.status, ok: true, json: async () => next.body };
    } });
  assert.equal(requests.length, 5);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'POST', 'POST', 'POST', 'GET']);
  // The current suggestion and gender settings are read first and sent back unchanged.
  assert.match(String(requests[1].body), /chaining_enabled=on/);
  assert.match(String(requests[1].body), /gender=3/);
  assert.equal(requests[1].headers['Sec-Fetch-Mode'], 'cors');
  assert.equal(result.owner, 'lifehack__ailab');
  assert.equal(result.profilePictureReceiptSeen, true);
  assert.equal(result.readbackVerified, true);
  assert.deepEqual(result.verifiedFields, ['username', 'first_name', 'biography', 'external_url']);
  assert.equal((await readdir(journalDir)).length, 5);
  assert.equal(result.assumptionsVerified, false);
});

test('photo-only sender updates the avatar through two direct requests and preserves profile fields', async t => {
  const journalDir = await tempDir(t);
  const igSession = session('instagram');
  igSession.cookies.find(cookie => cookie.name === 'ds_user_id').value = '12345';
  const requests = [];
  let readCount = 0;
  const readProfile = async ({ handle }) => {
    assert.equal(handle, PROFILE_OWNER);
    readCount += 1;
    const url = readCount === 1
      ? 'https://scontent.cdninstagram.com/p/old-avatar.jpg?token=omitted'
      : 'https://scontent.cdninstagram.com/p/new-avatar.jpg?token=omitted';
    return { service: 'instagram', profile: { id: '12345', username: PROFILE_OWNER, profilePictureUrl: url },
      receipt: { httpStatus: 200 } };
  };
  const responses = [
    { status: 200, body: { status: 'ok' } },
    { status: 200, body: { data: { xig_web_set_profile_picture: { user: { profile_pic_url: 'https://scontent.cdninstagram.com/p/new-avatar.jpg' } } } } },
  ];
  const send = async request => {
    requests.push(request);
    const value = responses.shift();
    return { status: value.status, ok: true, json: async () => value.body };
  };
  const args = { approvalId: 'photo-only-approval', runKey: 'photo-only-run',
    picture: { bytes: png(), width: 1000, height: 1000 }, session: igSession,
    rotateCookies: async () => {}, transport: send, journalDir, uploadIdFactory: () => 'photo-1', readProfile };
  args.openContext = async (service, handle) => {
    assert.equal(service, 'instagram');
    assert.equal(handle, PROFILE_OWNER);
    return freshMetaContext(igSession);
  };
  const result = await sendInstagramProfilePicture(args);
  assert.equal(result.state, 'profile_picture_verified');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.requestsSent, 2);
  assert.equal(requests[0].url, 'https://i.instagram.com/rupload_igphoto/fb_uploader_photo-1');
  assert.equal(requests[1].url, 'https://www.instagram.com/api/graphql');
  assert.deepEqual(JSON.parse(requests[1].body.get('variables')), { upload_id: 'photo-1' });
  assert.equal(requests[1].body.get('fb_dtsg'), 'fresh-dtsg-token');
  assert.ok(!requests.some(request => request.url.endsWith('/api/v1/web/accounts/edit/')));
  await assert.rejects(sendInstagramProfilePicture({ runKey: 'missing-approval', session: igSession,
    picture: { bytes: png(), width: 1000, height: 1000 }, transport: send, journalDir, readProfile }),
    error => error.code === 'APPROVAL_REQUIRED');
  await assert.rejects(sendInstagramProfilePicture(args), error => error.code === 'INSTAGRAM_PROFILE_PICTURE_ALREADY_ATTEMPTED');
  assert.equal(requests.length, 2);
});

test('send requires approval even with an injected run key and never loads sessions in dry-run', async t => {
  const journalDir = await tempDir(t);
  await assert.rejects(sendInstagramProfile({ session: session('instagram'), runKey: 'bypass-attempt',
    picture: { bytes: png(), width: 1000, height: 1000 }, transport: async () => assert.fail('must not send'), journalDir }),
  error => error.code === 'APPROVAL_REQUIRED');

  const fakeLogo = path.join(journalDir, 'logo.png');
  await writeFile(fakeLogo, png());
  const result = await runSnsProfile({ channel: 'instagram', dryRun: true, picturePath: fakeLogo, journalDir });
  assert.equal(result.requests.length, 3);
  assert.equal(result.requests[0].headers.cookie, '<redacted>');
  assert.equal(JSON.stringify(result.requests).includes('fake-csrftoken'), false);
  assert.equal(result.requests[1].body.binary, true);
  const pictureOnly = await runSnsProfile({ channel: 'instagram', dryRun: true, pictureOnly: true, picturePath: fakeLogo, journalDir });
  assert.equal(pictureOnly.requests.length, 2);
  assert.equal(pictureOnly.requests[0].url, 'https://i.instagram.com/rupload_igphoto/fb_uploader_DRY-RUN-PROFILE-PICTURE');
  assert.equal(JSON.stringify(pictureOnly.requests).includes('DRY-RUN-FRESH-DTSG'), false);
  assert.equal(pictureOnly.requests[1].body.includes('fb_dtsg=%3Credacted%3E'), true);
  assert.deepEqual((await readdir(journalDir)).sort(), ['logo.png']);
});

test('Threads profile dry-run reports the unimplemented contract without a request', async () => {
  const result = await runSnsProfile({ channel: 'threads', dryRun: true });
  assert.deepEqual(result.requests, []);
  assert.equal(result.blockedReason, 'THREADS_PROFILE_CONTRACT_MISSING');
});
