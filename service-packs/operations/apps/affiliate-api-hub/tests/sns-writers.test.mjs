import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildThreadsConfigureRequest, buildThreadsPhotoUploadRequest, buildThreadsVideoUploadRequest, buildTextPostAppInfo,
  publishChain, THREADS_CREATE_STATUS_CONTRACT, uploadThreadsImageOnly, uploadThreadsVideoOnly,
  waitForThreadsPostPublished,
} from '../scripts/sns/writers/threads.mjs';
import {
  buildInstagramCarouselConfigureRequest, buildInstagramPhotoUploadRequest,
  buildInstagramReelConfigureRequest, buildInstagramReelCoverUploadRequest, buildInstagramVideoUploadRequest,
  publishCarousel, publishReel, uploadInstagramVideoOnly,
} from '../scripts/sns/writers/instagram.mjs';
import { buildCreateTweetRequest, buildCreateNoteTweetRequest, publishThread } from '../scripts/sns/writers/x.mjs';
import { runSnsPublish } from '../scripts/sns-publish.mjs';
import { reconcileIntent } from '../scripts/sns/writers/journal.mjs';

const session = service => ({
  service, owner: 'lifehack__ailab',
  cookies: ['sessionid', 'csrftoken', 'ds_user_id', 'rur'].map(name => ({ name, value: `fake-${name}` })),
  ownerRequest: { headers: {
    'x-ig-app-id': 'fake-app-id', 'x-fb-lsd': 'fake-lsd', 'x-asbd-id': 'fake-asbd', 'x-web-session-id': 'fake-web-session',
  } },
});

const contracts = { operations: { CreateTweet: { queryId: 'fakeCreateId', features: { enabled: true }, fieldToggles: {} } } };

function png(width = 4, height = 3) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function mp4(size = 32) {
  const bytes = Buffer.alloc(size);
  Buffer.from('ftyp').copy(bytes, 4);
  return bytes;
}

function fakeInstagramUploadContext() {
  const source = 'https://i.instagram.com/rupload_igvideo/ is_sidecar:y?"1":"0" for_album:v=== is_clips_video';
  return {
    service: 'instagram', handle: 'lifehack__ailab', url: 'https://www.instagram.com/lifehack__ailab/',
    bundle: { service: 'instagram', owner: 'lifehack__ailab', origin: 'https://www.instagram.com',
      cookies: [{ name: 'csrftoken', value: 'fake-csrf', domain: '.instagram.com' }],
      ownerRequest: { headers: { 'x-ig-app-id': '123456', 'x-asbd-id': '123456', 'x-instagram-ajax': 'fake-rollout', 'user-agent': 'test-agent' } } },
    document: { modules: new Map([['RelayAPIConfigDefaults', { customHeaders: { 'x-ig-app-id': '123456' } }]]) },
    sources: new Map([
      ['PolarisAPIFbUploaderPhoto', { source: 'entityName:"fb_uploader_"' }],
      ['PolarisAPIRuploadPhoto', { source: 'https://i.instagram.com/rupload_igphoto/' }],
      ['PolarisAPIRuploadVideo', { source }],
    ]),
  };
}

function fakeThreadsReadback(ids, _options, captions = []) {
  return {
    owner: 'lifehack__ailab', ownerVerified: true,
    posts: ids.map((id, index) => ({ id, code: `fake${index}`, owner: 'lifehack__ailab',
      captionSha256: createHash('sha256').update(captions[index] ?? `post ${index}`).digest('hex'),
      threadId: 'fake-thread', position: index + 1, threadLength: ids.length, isReply: index > 0 })),
    relations: ids.slice(0, -1).map((id, index) => ({ parentId: id, childIds: [ids[index + 1]] })),
  };
}

function fakeThreadsMetaContext() {
  const owner = 'lifehack__ailab';
  const ownerId = '17824859444';
  const modules = new Map([
    ['DTSGInitialData', { token: 'fresh-test-dtsg' }],
    ['LSD', { token: 'fresh-test-lsd' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
      __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
    ['RelayAPIConfigDefaults', { actorID: ownerId, graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'fake-app' } }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
  ]);
  return { service: 'threads', handle: owner, createdAt: Date.now(), requestCount: 0,
    bundle: { service: 'threads', owner, ownerId, origin: 'https://www.threads.com',
      cookies: [{ name: 'csrftoken', value: 'fake-csrf', domain: 'threads.com', path: '/', secure: true }] },
    document: { modules, route: { canonicalRouteName: 'profile' } },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig value.charCodeAt(i)' }]]) };
}

async function tempDir(t, prefix = 'sns-writers-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Threads builds text-post form fields and f-helper text_post_app_info', () => {
  const sessionBundle = session('threads');
  const request = buildThreadsConfigureRequest({ caption: 'First post', uploadId: 'upload-1', chainId: 'chain-1',
    chainIndex: 0, chainLength: 2, linkPreviewURL: 'https://blog.example/post', replyControl: 'everyone', replyId: 'reply-9',
    webSessionId: 'web-session-1', selfThreadContextId: 'ctx-1', session: sessionBundle });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://www.threads.com/api/v1/media/configure_text_only_post/');
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  assert.equal(request.headers['X-CSRFToken'], 'fake-csrftoken');
  assert.equal(request.headers['X-IG-App-ID'], 'fake-app-id');
  assert.equal(request.headers['X-FB-LSD'], 'fake-lsd');
  const fields = Object.fromEntries(request.body.entries());
  assert.equal(fields.publish_mode, 'text_post');
  assert.equal(fields.upload_id, 'upload-1');
  assert.equal(fields.barcelona_source_reply_id, 'reply-9');
  assert.equal(fields.chain_id, 'chain-1');
  assert.equal(fields.chain_index, '0');
  assert.equal(fields.chain_length, '2');
  assert.equal(fields.should_include_permalink, 'true');
  assert.equal(fields.web_session_id, 'web-session-1');
  const appInfo = JSON.parse(fields.text_post_app_info);
  assert.equal(appInfo.link_attachment_url, 'https://blog.example/post');
  assert.equal(appInfo.reply_control, 'everyone');
  assert.equal(appInfo.entry_point, 'main_tab_bar');
  assert.equal(appInfo.self_thread_context_id, 'ctx-1');
  assert.equal(appInfo.reply_id, 'reply-9');
  assert.deepEqual(appInfo.text_with_entities, { entities: [], text: 'First post' });
  const defaultInfo = JSON.parse(buildTextPostAppInfo({ caption: 'plain', selfThreadContextId: 'ctx-defaults' }));
  assert.equal(defaultInfo.link_attachment_url, null);
  assert.equal(defaultInfo.fediverse_composer_enabled, true);
});

test('Threads feed and sidecar builders preserve media order and upload params', () => {
  const sessionBundle = session('threads');
  const requestContext = { jazoest: '12345', lsd: 'fresh-lsd' };
  const one = buildThreadsConfigureRequest({ caption: 'photo', uploadIds: ['u1'], chainId: 'c', chainIndex: 0,
    chainLength: 1, requestContext, session: sessionBundle });
  assert.match(one.url, /configure_text_post_app_feed\/$/);
  assert.equal(one.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  const feedFields = Object.fromEntries(one.body.entries());
  assert.equal(feedFields.upload_id, 'u1');
  assert.equal(feedFields.jazoest, '12345');
  assert.equal(feedFields.audience, 'default');
  assert.equal(feedFields.is_upload_type_override_allowed, '1');
  assert.equal(Object.hasOwn(feedFields, 'async_publish'), false);
  assert.equal(Object.hasOwn(feedFields, 'custom_accessibility_caption'), false);
  assert.equal(Object.hasOwn(feedFields, 'usertags'), false);
  const asyncPhoto = buildThreadsConfigureRequest({ caption: 'async photo', uploadIds: ['u2'], asyncPublish: true,
    requestContext, session: sessionBundle });
  assert.equal(asyncPhoto.body.get('async_publish'), '1');
  const describedPhoto = buildThreadsConfigureRequest({ caption: 'alt text', uploadIds: [{ uploadId: 'u3',
    customAccessibilityCaption: 'A blue house', usertags: [{ user_id: '123', position: [0.2, 0.4] }] }],
    requestContext, session: sessionBundle });
  assert.equal(describedPhoto.body.get('custom_accessibility_caption'), 'A blue house');
  assert.deepEqual(JSON.parse(describedPhoto.body.get('usertags')), [{ user_id: '123', position: [0.2, 0.4] }]);
  const sidecar = buildThreadsConfigureRequest({ caption: 'gallery', uploadIds: ['u1', 'u2'], chainId: 'c', chainIndex: 0,
    chainLength: 1, clientSidecarId: 'sidecar-1', session: sessionBundle });
  assert.match(sidecar.url, /configure_text_post_app_sidecar\/$/);
  assert.equal(sidecar.headers['Content-Type'], 'text/plain;charset=UTF-8');
  const sidecarBody = JSON.parse(sidecar.body);
  assert.deepEqual(sidecarBody.children_metadata, [{ upload_id: 'u1' }, { upload_id: 'u2' }]);
  assert.equal(sidecarBody.audience, 'default');
  assert.equal(sidecarBody.is_upload_type_override_allowed, '1');
  assert.equal(JSON.parse(sidecarBody.text_post_app_info).entry_point, 'main_tab_bar');
  const upload = buildThreadsPhotoUploadRequest({ bytes: Buffer.from('png'), width: 20, height: 10, uploadId: 'u1', session: sessionBundle });
  assert.match(upload.url, /rupload_igphoto\/fb_uploader_u1$/);
  assert.equal(upload.headers['Content-Type'], 'image/png');
  assert.equal(upload.headers.Offset, '0');
  assert.equal(upload.headers['X-Entity-Length'], '3');
  assert.deepEqual(JSON.parse(upload.headers['X-Instagram-Rupload-Params']), {
    is_sidecar: '0', is_threads: '1', media_type: 1, upload_id: 'u1', upload_media_height: 10, upload_media_width: 20,
  });
});

test('Threads first post can upload the cover image and use the captured single-photo form contract', async t => {
  const journalDir = await tempDir(t);
  const requests = [];
  let createIndex = 0;
  const result = await publishChain(['cover first', 'reply second'], {
    session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'run-image-chain',
    images: [[{ bytes: png(1080, 1350), width: 1080, height: 1350, mimeType: 'image/png' }]],
    requestContext: { fbDtsg: 'fresh-test-only', jazoest: '12345', lsd: 'fresh-test-only' },
    readbackClient: async (ids, options, captions) => fakeThreadsReadback(ids, options, captions),
    transport: async request => {
      requests.push(request);
      return request.url.includes('/rupload_igphoto/')
        ? new Response(JSON.stringify({ upload_id: 'uploaded-cover' }), { status: 200 })
        : new Response(JSON.stringify({ status: 'ok', media: { pk: `1000000200${++createIndex}` } }), { status: 200 });
    },
  });
  assert.equal(result.readbackVerified, true);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers['Content-Type'], 'image/png');
  const uploadParams = JSON.parse(requests[0].headers['X-Instagram-Rupload-Params']);
  assert.deepEqual([uploadParams.is_sidecar, uploadParams.is_threads, uploadParams.media_type], ['0', '1', 1]);
  assert.equal(requests[1].url.endsWith('/configure_text_post_app_feed/'), true);
  assert.equal(requests[1].headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  assert.equal(requests[1].body.get('upload_id'), 'uploaded-cover');
  assert.equal(requests[1].body.get('jazoest'), '12345');
  assert.equal(requests[2].body.get('barcelona_source_reply_id'), result.ids[0]);
});

test('Threads image upload-only helper sends one media request and never configures a post', async t => {
  const journalDir = await tempDir(t, 'sns-threads-photo-only-');
  const requests = [];
  const result = await uploadThreadsImageOnly(png(1080, 1350), { session: session('threads'),
    requestContext: { jazoest: '12345', lsd: 'fresh-test-only' }, runKey: 'threads-photo-only', journalDir,
    rotateCookies: async () => {}, transport: async request => {
      requests.push(request);
      return new Response(JSON.stringify({ upload_id: 'returned-upload-id' }), { status: 200 });
    } });
  assert.deepEqual(result, { uploaded: true, bytes: 24, width: 1080, height: 1350, mimeType: 'image/png',
    uploadIdValidated: true, uploadIdValueRetained: false });
  assert.equal(Object.hasOwn(result, 'uploadId'), false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /rupload_igphoto\//);
  assert.equal((await readdir(journalDir)).length, 1);
});

test('Threads video upload request matches logged-in rupload contract', () => {
  const bytes = Buffer.alloc(32);
  bytes.write('ftyp', 4, 'ascii');
  const request = buildThreadsVideoUploadRequest({ bytes, width: 1080, height: 1920, uploadId: '1780000000000',
    session: session('threads'), requestContext: { lsd: 'fresh-test-only', jazoest: '12345' } });
  assert.match(request.url, /rupload_igvideo\/fb_uploader_1780000000000$/);
  assert.equal(request.headers['Content-Type'], 'video/mp4');
  assert.equal(request.headers.Offset, '0');
  assert.equal(request.headers['X-Entity-Type'], 'video/mp4');
  assert.deepEqual(JSON.parse(request.headers['X-Instagram-Rupload-Params']), {
    extract_cover_frame: '1', is_sidecar: '0', is_threads: '1', media_type: 2, upload_id: '1780000000000',
    upload_media_height: 1920, upload_media_width: 1080,
  });
  assert.throws(() => buildThreadsVideoUploadRequest({ bytes, width: 1080, height: 1920, uploadId: 'uuid-is-invalid',
    session: session('threads') }), error => error.code === 'THREADS_VIDEO_INVALID');
});

test('Threads video upload-only helper sends bytes once, validates upload response, and never configures a post', async t => {
  const journalDir = await tempDir(t, 'sns-threads-video-only-');
  const requests = [];
  const bytes = Buffer.alloc(32);
  bytes.write('ftyp', 4, 'ascii');
  const result = await uploadThreadsVideoOnly({ bytes, videoMetadata: { width: 1080, height: 1920, durationMs: 58_537 } }, {
    session: session('threads'), requestContext: { jazoest: '12345', lsd: 'fresh-test-only' },
    runKey: 'threads-video-only', journalDir, uploadIdFactory: () => '1780000000001', rotateCookies: async () => {},
    transport: async request => {
      requests.push(request);
      return new Response(JSON.stringify({ status: 'ok', media_id: '123456789' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(result, { uploaded: true, bytes: 32, width: 1080, height: 1920, durationMs: 58_537,
    mimeType: 'video/mp4', uploadIdValueRetained: false, mediaIdValidated: true, mediaIdValueRetained: false });
  assert.equal(Object.hasOwn(result, 'uploadId'), false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /rupload_igvideo\//);
  assert.equal((await readdir(journalDir)).length, 1);
  const journalFile = path.join(journalDir, (await readdir(journalDir))[0]);
  const journalIntent = JSON.parse((await readFile(journalFile, 'utf8')).split('\n')[0]);
  assert.equal(journalIntent.request.url, 'https://www.threads.com/rupload_igvideo/[entity]');
  assert.equal(journalIntent.request.url.includes('1780000000001'), false);
});

test('Threads chain uploads a numeric video ID, configures the feed post, and waits when creation is pending', async t => {
  const journalDir = await tempDir(t, 'sns-threads-video-chain-');
  const requests = [];
  const videoBytes = mp4();
  let statusWaitCalls = 0;
  let configureAttempts = 0;
  const result = await publishChain(['video post'], {
    session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'threads-video-chain',
    videos: [{ postIndex: 0, file: { bytes: videoBytes, width: 1080, height: 1920, durationMs: 3_500 } }],
    videoUploadIdFactory: () => '1780000000002',
    requestContext: { jazoest: '12345', lsd: 'fresh-test-only' },
    configureRetryStartMs: 0,
    configureRetrySleep: async () => {},
    statusWaiter: async (clientId, options) => {
      statusWaitCalls += 1;
      assert.equal(clientId, 'pending-video-create');
      assert.equal(options.session.owner, 'lifehack__ailab');
      return '10000002004';
    },
    readbackClient: async (ids, options, captions) => fakeThreadsReadback(ids, options, captions),
    transport: async request => {
      requests.push(request);
      if (request.url.includes('/rupload_igvideo/')) {
        return new Response(JSON.stringify({ status: 'ok', media_id: 123456789 }), { status: 200 });
      }
      configureAttempts += 1;
      return new Response(JSON.stringify({ status: 'ok', posts: [{ status: 'PENDING', post_client_id: 'pending-video-create' }] }),
        { status: 200 });
    },
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /rupload_igvideo\/fb_uploader_1780000000002$/);
  const uploadParams = JSON.parse(requests[0].headers['X-Instagram-Rupload-Params']);
  assert.equal(uploadParams.media_type, 2);
  assert.equal(uploadParams.extract_cover_frame, '1');
  assert.match(requests[1].url, /configure_text_post_app_feed\/$/);
  assert.equal(requests[1].body.get('upload_id'), '1780000000002');
  assert.equal(requests[1].body.get('jazoest'), '12345');
  assert.equal(configureAttempts, 1);
  assert.equal(statusWaitCalls, 1);
  assert.deepEqual(result.ids, ['10000002004']);
  assert.equal(result.readbackVerified, true);
});

test('an undecoded HTTP 202 configure response keeps its intent and never resends create', async t => {
  const journalDir = await tempDir(t, 'sns-threads-accepted-');
  let sends = 0;
  const options = {
    session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'accepted-once',
    configureRetryStartMs: 0, configureRetrySleep: async () => {},
    transport: async () => { sends++; return new Response('', { status: 202 }); },
  };
  await assert.rejects(publishChain(['one explicit post'], options));
  assert.equal(sends, 1);
  await assert.rejects(publishChain(['one explicit post'], options),
    error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(sends, 1);
});

test('a restart after the created checkpoint never restarts the same chain from post zero', async t => {
  const journalDir = await tempDir(t, 'sns-threads-checkpoint-');
  let sends = 0;
  const options = {
    session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'checkpoint-once',
    transport: async () => { sends++; return Response.json({ status: 'ok', posts: [{ status: 'PENDING', post_client_id: 'checkpoint-client' }] }); },
    statusWaiter: async () => '10000002004',
    readbackClient: async () => { throw Object.assign(new Error('READBACK_INTERRUPTED'), { code: 'READBACK_INTERRUPTED' }); },
  };
  const first = await publishChain(['one explicit post'], options);
  assert.equal(first.readbackVerified, false);
  assert.deepEqual(first.ids, ['10000002004']);
  assert.equal(sends, 1);
  await assert.rejects(publishChain(['one explicit post'], options),
    error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(sends, 1);
});

test('an invalid explicit chain context is rejected before media upload or journal reservation', async t => {
  const journalDir = await tempDir(t, 'sns-threads-invalid-context-');
  let sends = 0;
  await assert.rejects(publishChain(['one explicit post'], {
    session: session('threads'), journalDir, runKey: 'invalid-context', selfThreadContextId: '',
    images: [{ postIndex: 0, file: { bytes: png(), width: 4, height: 3 } }],
    transport: async () => { sends++; return Response.json({}); },
  }), error => error.code === 'THREADS_CONTEXT_ID_INVALID');
  assert.equal(sends, 0);
  assert.deepEqual(await readdir(journalDir), []);
});

test('Threads links follow-up posts to the previous returned ID using the injected transport', async t => {
  const journalDir = await tempDir(t);
  const requests = [];
  let id = 0;
  const result = await publishChain(['one', 'two'], { session: session('threads'), rotateCookies: async () => {},
    journalDir, runKey: 'run-a', randomUUIDImpl: (() => { let n = 0; return () => n++ === 0 ? 'fixed-chain' : `fixed-context-${n}`; })(),
    readbackClient: async (ids, options, captions) => fakeThreadsReadback(ids, options, captions), transport: async request => {
      requests.push(request);
      id += 1;
      return new Response(JSON.stringify({ status: 'ok', media: { pk: `1000000000${id}`, permalink: `https://www.threads.com/@a/post/${id}` } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  assert.deepEqual(result.ids, ['10000000001', '10000000002']);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.readbackReason, undefined);
  assert.equal(requests.length, 2);
  const forms = requests.map(request => Object.fromEntries(request.body.entries()));
  assert.deepEqual(forms.map(form => [form.chain_id, form.chain_index, form.chain_length]), [
    ['fixed-chain', '0', '2'], ['fixed-chain', '1', '2'],
  ]);
  const appInfo = forms.map(form => JSON.parse(form.text_post_app_info));
  assert.equal(Object.hasOwn(appInfo[0], 'reply_id'), false);
  assert.equal(forms[0].barcelona_source_reply_id, undefined);
  assert.equal(appInfo[1].reply_id, result.ids[0]);
  assert.equal(appInfo[0].self_thread_context_id, appInfo[1].self_thread_context_id);
  assert.equal(forms[1].barcelona_source_reply_id, '10000000001');
  const files = (await readdir(journalDir)).filter(file => file.endsWith('.jsonl')).sort();
  assert.equal(files.length, 2);
  const events = await Promise.all(files.map(async file => (await readFile(path.join(journalDir, file), 'utf8'))
    .trim().split('\n').map(row => JSON.parse(row))));
  const checkpoints = events.flat().filter(event => event.type === 'checkpoint');
  assert.deepEqual(checkpoints.map(event => event.checkpoint.postId), result.ids);
  assert.equal(checkpoints.every(event => event.checkpoint.kind === 'threads_post_created'), true);
});

test('Threads create response parser reports HTTP 200 service errors and prevents a blind second create', async t => {
  const journalDir = await tempDir(t);
  let calls = 0;
  const options = { session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'threads-service-error',
    transport: async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: 'fail', error_type: 'CreateDenied', message: 'post was not accepted' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    } };
  await assert.rejects(publishChain(['one'], options), error => error.code === 'THREADS_CREATE_REJECTED'
    && error.detail.includes('CreateDenied') && error.detail.includes('post was not accepted'));
  await assert.rejects(publishChain(['one'], options), error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
});

test('Threads posts[] ERROR is rejected with sanitized error_info and blocks retry', async t => {
  const journalDir = await tempDir(t);
  let calls = 0;
  const options = { session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'threads-post-array-error',
    transport: async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: 'ok', posts: [{ id: '10000000888', post_client_id: 'pc-error',
        status: 'ERROR', media_ids: [], error_info: { error_type: 'NO_RETRY', message: 'Missing info. access_token=do-not-show' } }],
      medias: [], end_card_check: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    } };
  await assert.rejects(publishChain(['one'], options), error => error.code === 'THREADS_CREATE_REJECTED'
    && error.detail.includes('NO_RETRY') && error.detail.includes('Missing info.') && !error.detail.includes('do-not-show'));
  await assert.rejects(publishChain(['one'], options), error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
});

test('Threads PENDING waits on the first-party status query before replying with the published id', async t => {
  const journalDir = await tempDir(t);
  const requests = [];
  const sequence = [];
  let createIndex = 0;
  const context = fakeThreadsMetaContext();
  const result = await publishChain(['one', 'two'], { session: session('threads'), rotateCookies: async () => {},
    journalDir, runKey: 'threads-pending-status', metaContextLoader: async () => context,
    readbackClient: async (ids, options, captions) => fakeThreadsReadback(ids, options, captions),
    statusQuerySender: async (_context, request) => {
      sequence.push('status');
      assert.equal(request.method, 'POST');
      assert.equal(new URL(request.url).pathname, '/api/graphql');
      assert.equal(request.body.get('fb_api_req_friendly_name'), THREADS_CREATE_STATUS_CONTRACT.operation);
      assert.equal(request.body.get('doc_id'), THREADS_CREATE_STATUS_CONTRACT.docId);
      assert.deepEqual(JSON.parse(request.body.get('variables')), { request_data: { post_client_id: 'client-one' } });
      return { payload: { data: { xdt_get_upload_status: { posts: [{ id: '10000000301', status: 'COMPLETED' }], medias: [] } } } };
    },
    transport: async request => {
      requests.push(request);
      sequence.push('create');
      createIndex += 1;
      if (createIndex === 1) return new Response(JSON.stringify({ status: 'ok', posts: [{ id: '10000000300',
        post_client_id: 'client-one', status: 'PENDING', media_ids: [] }], medias: [] }), { status: 200 });
      return new Response(JSON.stringify({ status: 'ok', media: { pk: '10000000302' } }), { status: 200 });
    } });
  assert.deepEqual(sequence, ['create', 'status', 'create']);
  assert.equal(requests[1].body.get('barcelona_source_reply_id'), '10000000301');
  assert.equal(requests[1].body.get('async_publish'), null);
  assert.equal(result.ids[0], '10000000301');
  assert.equal(result.ids[1], '10000000302');
  const forms = requests.map(request => Object.fromEntries(request.body.entries()));
  assert.equal(JSON.parse(forms[0].text_post_app_info).self_thread_context_id,
    JSON.parse(forms[1].text_post_app_info).self_thread_context_id);
});

test('Threads status waiter turns asynchronous ERROR into a sanitized create rejection', async () => {
  const context = fakeThreadsMetaContext();
  await assert.rejects(waitForThreadsPostPublished('client-error', { session: session('threads'),
    metaContextLoader: async () => context, querySender: async () => ({ payload: { data: { xdt_get_upload_status: {
      posts: [{ status: 'ERROR', error_info: { error_type: 'NO_RETRY', message: 'Missing info. sessionid=private-value' } }],
    } } } }) }), error => error.code === 'THREADS_CREATE_REJECTED'
      && error.detail.includes('NO_RETRY') && error.detail.includes('Missing info.') && !error.detail.includes('private-value'));
});

test('Threads unreadable HTTP 200 create stays held after an unproved no-match reconciliation', async t => {
  const journalDir = await tempDir(t);
  let calls = 0;
  const options = { session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'threads-body-unreadable',
    transport: async () => { calls += 1; return new Response('not-json', { status: 200,
      headers: { 'content-type': 'application/json' } }); } };
  await assert.rejects(publishChain(['one'], options), error => error.code === 'THREADS_RESPONSE_BODY_UNREADABLE'
    && error.detail.includes('HTTP 200') && error.detail.includes('body omitted'));
  await assert.rejects(publishChain(['one'], options), error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
  const file = path.join(journalDir, (await readdir(journalDir))[0]);
  await reconcileIntent({ file, result: { outcome: 'owner_profile_checked_no_matching_post' } });
  await assert.rejects(publishChain(['one'], { ...options,
    transport: async () => { calls += 1; return new Response(JSON.stringify({ status: 'ok', media: { pk: '10000000101' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }); },
    readbackClient: async (ids, readbackOptions, captions) => fakeThreadsReadback(ids, readbackOptions, captions) }),
    error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
});

test('Threads scalar replyId seeds the first post and then follows the created chain', async t => {
  const journalDir = await tempDir(t);
  const requests = [];
  let id = 0;
  const result = await publishChain(['one', 'two'], { session: session('threads'), rotateCookies: async () => {},
    journalDir, runKey: 'run-seeded-chain', replyId: '10000000099', readbackClient: async (ids, options, captions) => fakeThreadsReadback(ids, options, captions), transport: async request => {
      requests.push(request);
      id += 1;
      return new Response(JSON.stringify({ status: 'ok', media: { pk: `1000000001${id}` } }), { status: 200 });
    } });
  assert.deepEqual(result.ids, ['10000000011', '10000000012']);
  const forms = requests.map(request => Object.fromEntries(request.body.entries()));
  assert.deepEqual(forms.map(form => form.barcelona_source_reply_id), ['10000000099', '10000000011']);
  assert.equal(result.readbackVerified, true);
});

test('Threads explicit replyId arrays retain per-post overrides and null/undefined standalone entries', async t => {
  const journalDir = await tempDir(t);
  const requests = [];
  let id = 0;
  await publishChain(['one', 'two', 'three', 'four'], { session: session('threads'), rotateCookies: async () => {},
    journalDir, runKey: 'run-explicit-replies', readbackClient: async (ids, options, captions) => fakeThreadsReadback(ids, options, captions),
    replyId: ['external-parent', null, undefined, 'custom-parent'],
    transport: async request => {
      requests.push(request);
      id += 1;
      return new Response(JSON.stringify({ status: 'ok', media: { pk: `1000000100${id}` } }), { status: 200 });
    } });
  const forms = requests.map(request => Object.fromEntries(request.body.entries()));
  assert.deepEqual(forms.map(form => JSON.parse(form.text_post_app_info).reply_id), [
    'external-parent', null, undefined, 'custom-parent',
  ]);
  assert.deepEqual(forms.map(form => form.barcelona_source_reply_id), [
    'external-parent', undefined, undefined, 'custom-parent',
  ]);
});

test('Instagram carousel upload headers and configure body preserve input order', () => {
  const sessionBundle = session('instagram');
  const photo = buildInstagramPhotoUploadRequest({ bytes: png(), width: 4, height: 3, uploadId: 'u1', session: sessionBundle });
  assert.equal(photo.method, 'POST');
  assert.equal(photo.url, 'https://i.instagram.com/rupload_igphoto/u1');
  assert.equal(photo.headers.Offset, '0');
  assert.equal(photo.headers['X-Entity-Length'], '24');
  assert.equal(photo.headers['X-Entity-Name'], 'u1');
  assert.equal(photo.headers['X-Entity-Type'], 'image/png');
  assert.deepEqual(JSON.parse(photo.headers['X-Instagram-Rupload-Params']), {
    media_type: 1, upload_id: 'u1', upload_media_height: 3, upload_media_width: 4,
  });
  const configure = buildInstagramCarouselConfigureRequest({ caption: 'caption', uploadIds: ['u2', 'u1'],
    clientSidecarId: 'sidecar-1', requestContext: { fbDtsg: 'fake-fb-dtsg', jazoest: '12345' }, session: sessionBundle });
  assert.equal(configure.url, 'https://www.instagram.com/api/v1/media/configure_sidecar/');
  assert.equal(configure.headers['Content-Type'], 'application/json');
  assert.equal(configure.headers.Origin, 'https://www.instagram.com');
  assert.equal(configure.headers.Referer, 'https://www.instagram.com/');
  assert.equal(configure.headers['X-CSRFToken'], 'fake-csrftoken');
  assert.equal(configure.headers['X-IG-App-ID'], 'fake-app-id');
  assert.deepEqual(Object.keys(configure.body).sort(), [
    'archive_only', 'caption', 'children_metadata', 'client_sidecar_id', 'disable_comments', 'fb_dtsg',
    'is_open_to_public_submission', 'jazoest', 'like_and_view_counts_disabled', 'media_share_flow',
    'share_to_facebook', 'share_to_fb_destination_type', 'source_type',
  ].sort());
  assert.deepEqual(configure.body.children_metadata.map(item => item.upload_id), ['u2', 'u1']);
  assert.equal(configure.body.client_sidecar_id, 'sidecar-1');
  assert.equal(configure.body.fb_dtsg, 'fake-fb-dtsg');
  assert.equal(configure.body.jazoest, '12345');
  assert.equal(configure.body.source_type, 'library');
});

test('Instagram carousel publishes upload and configure requests through fakes', async t => {
  const journalDir = await tempDir(t);
  const requests = [];
  let upload = 0;
  const result = await publishCarousel([png(10, 20), png(30, 40)], 'caption', { session: session('instagram'),
    requestContext: { fbDtsg: 'fake-fb-dtsg', jazoest: '12345' },
    rotateCookies: async () => {}, journalDir, runKey: 'run-ig', randomUUIDImpl: (() => { let n = 0; return () => `generated-${++n}`; })(),
    transport: async request => {
      requests.push(request);
      if (request.url.includes('/rupload_igphoto/')) return new Response(JSON.stringify({ upload_id: `uploaded-${++upload}` }), { status: 200 });
      return new Response(JSON.stringify({ status: 'ok', media: { pk: 'ig-77', strong_id__: 'ig-77', permalink: 'https://www.instagram.com/p/example/' } }), { status: 200 });
    } });
  assert.equal(result.id, 'ig-77');
  assert.equal(result.readbackVerified, false);
  assert.equal(result.readbackReason, 'INSTAGRAM_READBACK_CONTRACT_MISSING');
  assert.equal(requests.length, 3);
  const children = requests[2].body.children_metadata;
  assert.deepEqual(children.map(item => item.upload_id), ['uploaded-1', 'uploaded-2']);
  assert.equal(requests[2].headers['Content-Type'], 'application/json');
  assert.equal(requests[2].body.fb_dtsg, 'fake-fb-dtsg');
  assert.deepEqual(requests.slice(0, 2).map(request => {
    const params = JSON.parse(request.headers['X-Instagram-Rupload-Params']);
    return [params.upload_media_width, params.upload_media_height];
  }), [[10, 20], [30, 40]]);
});

test('Instagram carousel errors retain safe provider detail and redact echoed dynamic fields', async t => {
  const journalDir = await tempDir(t);
  let upload = 0;
  await assert.rejects(publishCarousel([png(), png()], 'caption', { session: session('instagram'),
    requestContext: { fbDtsg: 'fake-fb-dtsg', jazoest: '12345' }, rotateCookies: async () => {},
    journalDir, runKey: 'run-ig-400', transport: async request => request.url.includes('/rupload_igphoto/')
      ? new Response(JSON.stringify({ upload_id: `uploaded-${++upload}` }), { status: 200 })
      : new Response(JSON.stringify({ message: 'Rejected fb_dtsg=do-not-leak-this', error_type: 'invalid_media', error_title: 'Bad media' }), { status: 400 }) }),
  error => error.code === 'INSTAGRAM_HTTP_400' && error.detail.includes('invalid_media')
    && error.detail.includes('Bad media') && !error.detail.includes('do-not-leak-this'));
});

test('Instagram Reel uses the observed numeric fb_uploader clip upload and configure contract', async t => {
  const journalDir = await tempDir(t);
  const sessionBundle = session('instagram');
  const uploadId = '17900000000000000';
  const request = buildInstagramVideoUploadRequest({ bytes: mp4(), width: 1080, height: 1920, durationMs: 5000,
    uploadId, session: sessionBundle });
  assert.equal(request.url, `https://i.instagram.com/rupload_igvideo/fb_uploader_${uploadId}`);
  const params = JSON.parse(request.headers['X-Instagram-Rupload-Params']);
  assert.deepEqual(params, { 'client-passthrough': '1', is_clips_video: '1', for_album: false, is_sidecar: '0',
    media_type: 2, upload_id: uploadId, upload_media_duration_ms: 5000, upload_media_height: 1920,
    upload_media_width: 1080, video_format: '', video_transform: null });
  const coverRequest = buildInstagramReelCoverUploadRequest({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    width: 1080, height: 1920, uploadId, session: sessionBundle });
  assert.equal(coverRequest.url, `https://i.instagram.com/rupload_igphoto/fb_uploader_${uploadId}`);
  assert.equal(coverRequest.headers['Content-Type'], 'image/jpeg');
  assert.deepEqual(JSON.parse(coverRequest.headers['X-Instagram-Rupload-Params']), { media_type: 2,
    upload_id: uploadId, upload_media_height: 1920, upload_media_width: 1080 });
  assert.equal(params.upload_media_duration_ms, 5000);
  assert.equal(params.media_type, 2);
  const configureRequest = buildInstagramReelConfigureRequest({ caption: 'reel', uploadId, sourceType: 'fake-source', session: sessionBundle });
  assert.equal(configureRequest.url, 'https://www.instagram.com/api/v1/media/configure_to_clips/');
  assert.equal(configureRequest.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(configureRequest.body.get('video_subtitles_enabled'), '0');
  assert.equal(configureRequest.body.get('source_type'), 'fake-source');
  const requests = [];
  let unavailableContractSends = 0;
  await assert.rejects(publishReel(Buffer.from('mp4'), 'reel', { session: sessionBundle,
    videoInfo: { width: 1080, height: 1920, durationMs: 5000 }, transport: async () => { unavailableContractSends += 1; } }),
  error => error.code === 'NOT_IMPLEMENTED_CONTRACT_MISSING');
  assert.equal(unavailableContractSends, 0);
  const result = await publishReel(mp4(), 'reel', { session: sessionBundle, sourceType: 'fake-source',
    videoInfo: { width: 1080, height: 1920, durationMs: 5000 }, cover: { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 1080, height: 1920, mimeType: 'image/jpeg' },
    uploadIdImpl: () => uploadId, metaContextLoader: async () => fakeInstagramUploadContext(),
    rotateCookies: async () => {}, journalDir, runKey: 'run-reel', transport: async value => {
      requests.push(value);
      return value.url.includes('/rupload_igvideo/') || value.url.includes('/rupload_igphoto/') ? new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
        : new Response(JSON.stringify({ media: { pk: 'reel-9' } }), { status: 200 });
    } });
  assert.equal(result.id, 'reel-9');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, `https://i.instagram.com/rupload_igvideo/fb_uploader_${uploadId}`);
  assert.equal(requests[1].url, `https://i.instagram.com/rupload_igphoto/fb_uploader_${uploadId}`);
  assert.equal(requests[2].body.get('upload_id'), uploadId);
});

test('Instagram Reel upload-only helper sends video and JPEG cover without configure or retained upload id', async t => {
  const journalDir = await tempDir(t, 'sns-instagram-video-only-');
  const video = mp4(2048);
  const requests = [];
  const result = await uploadInstagramVideoOnly(video, { session: session('instagram'),
    videoInfo: { width: 1080, height: 1920, durationMs: 58000 },
    cover: { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 1080, height: 1920, mimeType: 'image/jpeg' },
    uploadIdImpl: () => '17900000000000001', metaContextLoader: async () => fakeInstagramUploadContext(),
    runKey: 'instagram-video-only', journalDir,
    rotateCookies: async () => {}, transport: async request => {
      requests.push(request);
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    } });
  assert.deepEqual(result, { uploaded: true, bytes: 2048, width: 1080, height: 1920, durationMs: 58000,
    coverBytes: 4, mediaType: 2, writesSent: 2, uploadIdValidated: true, uploadIdValueRetained: false, postRequestsSent: 0,
    uploadHttpStatuses: [200, 200], ownerVerified: true, sourceGuardPassed: true, browserUsed: false });
  assert.equal(Object.hasOwn(result, 'uploadId'), false);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /rupload_igvideo\/fb_uploader_\d+$/);
  assert.match(requests[1].url, /rupload_igphoto\/fb_uploader_\d+$/);
  assert.equal((await readdir(journalDir)).length, 2);
});

test('Instagram Reel media upload requires a JPEG cover before any network request', async t => {
  const journalDir = await tempDir(t, 'sns-instagram-reel-cover-required-');
  let sends = 0;
  await assert.rejects(uploadInstagramVideoOnly(mp4(), { session: session('instagram'),
    videoInfo: { width: 1080, height: 1920, durationMs: 4500 }, runKey: 'instagram-no-cover', journalDir,
    transport: async () => { sends += 1; return new Response('{}', { status: 200 }); } }),
  { code: 'INSTAGRAM_REEL_COVER_REQUIRED' });
  assert.equal(sends, 0);
  assert.equal((await readdir(journalDir)).length, 0);
});

test('X request builder and injected sns-X client chain replies and verify TweetDetail', async t => {
  const firstPlan = buildCreateTweetRequest({ post: 'hello', contracts });
  assert.equal(firstPlan.url, 'https://x.com/i/api/graphql/fakeCreateId/CreateTweet');
  assert.equal(firstPlan.headers['Content-Type'], 'application/json');
  const variables = JSON.parse(firstPlan.body).variables;
  assert.deepEqual(variables.media, { media_entities: [], possibly_sensitive: false });
  const journalDir = await tempDir(t);
  const created = [];
  const client = {
    async request(operation, variables) {
      assert.equal(operation, 'CreateTweet');
      created.push(variables);
      return { data: { create_tweet: { tweet_results: { result: { rest_id: String(1000 + created.length) } } } }, receipt: { status: 200 } };
    },
    async conversation(id) {
      const index = Number(id) - 1001;
      return { focal: { id, text: ['first', 'second'][index], parentId: index ? '1001' : null } };
    },
  };
  const result = await publishThread(['first', 'second'], { client, contracts, journalDir, runKey: 'run-x' });
  assert.deepEqual(result.ids, ['1001', '1002']);
  assert.equal(created[1].reply.in_reply_to_tweet_id, '1001');
  assert.deepEqual(created[1].reply.exclude_reply_user_ids, []);
  assert.equal(result.readbackVerified, true);
  assert.equal((await readdir(journalDir)).length, 2);
});

test('X uses CreateTweet through weighted length 280 and CreateNoteTweet above it only with opt-in', async t => {
  const journalDir = await tempDir(t);
  const contracts = { operations: {
    CreateTweet: { queryId: 'short-id', features: { enabled: true }, fieldToggles: {} },
    CreateNoteTweet: { queryId: 'note-id', features: { enabled: true }, fieldToggles: {} },
  } };
  const boundary = 'a'.repeat(280), long = 'b'.repeat(281), quoteUrl = 'https://x.com/example/status/123', sent = [], posts = new Map();
  const client = {
    async request(operation, variables) {
      const id = String(3000 + sent.length);
      sent.push({ operation, variables, id });
      posts.set(id, { operation, text: variables.tweet_text, quoteUrl: variables.attachment_url });
      return operation === 'CreateNoteTweet'
        ? { data: { notetweet_create: { tweet_results: { result: { tweet: { rest_id: id } } } } }, receipt: { status: 200 } }
        : { data: { create_tweet: { tweet_results: { result: { rest_id: id } } } }, receipt: { status: 200 } };
    },
    async conversation(id) {
      const post = posts.get(id);
      return { focal: post.operation === 'CreateNoteTweet'
        ? { id, parentId: null, quotedPostId: '123', note_tweet: { note_tweet_results: { result: { text: post.text } } } }
        : { id, text: post.text } };
    },
  };
  const short = await publishThread([boundary], { client, contracts, journalDir, runKey: 'weight-280', longPostAllowed: true });
  const extended = await publishThread([long], { client, contracts, journalDir, runKey: 'weight-281', longPostAllowed: true, quoteUrl });
  assert.deepEqual(sent.map(row => row.operation), ['CreateTweet', 'CreateNoteTweet']);
  assert.equal(short.readbackVerified, true);
  assert.deepEqual(extended.ids, [sent[1].id]);
  assert.equal(extended.readbackVerified, true);
  const notePlan = buildCreateNoteTweetRequest({ post: long, contracts, quoteUrl });
  assert.equal(notePlan.url, 'https://x.com/i/api/graphql/note-id/CreateNoteTweet');
  const noteVariables = JSON.parse(notePlan.body).variables;
  assert.equal(noteVariables.tweet_text, long);
  assert.equal(noteVariables.attachment_url, quoteUrl);
  assert.deepEqual(noteVariables.media, { media_entities: [], possibly_sensitive: false });
  assert.equal('richtext_options' in noteVariables, false);
  assert.equal('media_options' in noteVariables, false);
  await assert.rejects(publishThread([long], { client, contracts, journalDir, runKey: 'weight-281-denied' }), { code: 'X_LONG_POST_NOT_ALLOWED' });
  assert.equal(sent.length, 2);
});

test('unknown transport outcome cannot resend after a bare operator no-create claim', async t => {
  const journalDir = await tempDir(t);
  let calls = 0;
  const options = { session: session('threads'), rotateCookies: async () => {}, journalDir, runKey: 'blocked-run',
    readbackClient: async (ids, options, captions) => fakeThreadsReadback(ids, options, captions),
    transport: async () => { calls += 1; throw new Error('connection dropped'); } };
  await assert.rejects(publishChain(['first'], options), /connection dropped/);
  await assert.rejects(publishChain(['second'], { ...options, transport: async () => { calls += 1; } }), error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
  const file = path.join(journalDir, (await readdir(journalDir))[0]);
  await reconcileIntent({ file, result: { outcome: 'operator_checked_not_created' } });
  await assert.rejects(publishChain(['second'], { ...options, transport: async () => {
    calls += 1;
    return new Response(JSON.stringify({ status: 'ok', media: { pk: '10000000100' } }), { status: 200 });
  } }), error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
});

test('X image upload count is capped at four before a session or request is used', async () => {
  await assert.rejects(publishThread(['text'], { images: ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'], client: {}, contracts }),
    error => error.code === 'X_IMAGES_INVALID');
});

test('dry-run prints requests without creating journal or modifying run files', async t => {
  const previousImages = process.env.SNS_THREADS_IMAGES;
  const previousVideo = process.env.SNS_THREADS_VIDEO;
  process.env.SNS_THREADS_IMAGES = 'on';
  delete process.env.SNS_THREADS_VIDEO;
  t.after(() => {
    if (previousImages === undefined) delete process.env.SNS_THREADS_IMAGES;
    else process.env.SNS_THREADS_IMAGES = previousImages;
    if (previousVideo === undefined) delete process.env.SNS_THREADS_VIDEO;
    else process.env.SNS_THREADS_VIDEO = previousVideo;
  });
  const runDir = await tempDir(t, 'sns-dry-run-');
  const snsDir = path.join(runDir, 'sns');
  await mkdir(snsDir);
  await writeFile(path.join(snsDir, 'instagram-01.png'), png(1080, 1350));
  await writeFile(path.join(runDir, 'final-verification.json'), JSON.stringify({ status: 'published_verified' }));
  await writeFile(path.join(snsDir, 'versions.json'), JSON.stringify({ threads: { posts: ['one', 'two'] } }));
  await writeFile(path.join(snsDir, 'sns-manifest.json'), JSON.stringify({ outputs: {} }));
  const before = (await readdir(runDir)).sort();
  const journalDir = path.join(runDir, 'journal');
  const result = await runSnsPublish({ runDir, channel: 'threads', dryRun: true, journalDir });
  assert.equal(result.dryRun, true);
  assert.equal(result.requests.length, 3);
  assert.equal(result.requests[0].headers.cookie, '<redacted>');
  assert.equal(result.requests[0].headers['Content-Type'], 'image/png');
  assert.equal(result.requests[0].body.binary, true);
  assert.equal(result.requests[1].headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  assert.equal(new URLSearchParams(result.requests[1].body).get('upload_id'), 'DRY-RUN-THREADS-COVER');
  assert.equal(JSON.stringify(result.requests).includes('fake-csrftoken'), false);
  assert.equal(await readFile(path.join(runDir, 'final-verification.json'), 'utf8'), JSON.stringify({ status: 'published_verified' }));
  assert.deepEqual((await readdir(runDir)).sort(), before);
  await assert.rejects(readdir(journalDir), error => error.code === 'ENOENT');
});

test('Threads attaches the shorts to post zero by default, SNS_THREADS_VIDEO=off opts out, images stay off', async t => {
  const previousImages = process.env.SNS_THREADS_IMAGES;
  const previousVideo = process.env.SNS_THREADS_VIDEO;
  delete process.env.SNS_THREADS_IMAGES;
  delete process.env.SNS_THREADS_VIDEO;
  t.after(() => {
    if (previousImages === undefined) delete process.env.SNS_THREADS_IMAGES;
    else process.env.SNS_THREADS_IMAGES = previousImages;
    if (previousVideo === undefined) delete process.env.SNS_THREADS_VIDEO;
    else process.env.SNS_THREADS_VIDEO = previousVideo;
  });

  const createRun = async () => {
    const runDir = await tempDir(t, 'sns-threads-video-gate-');
    const snsDir = path.join(runDir, 'sns');
    await mkdir(snsDir);
    await writeFile(path.join(runDir, 'final-verification.json'), JSON.stringify({ status: 'published_verified' }));
    await writeFile(path.join(snsDir, 'versions.json'), JSON.stringify({ threads: { posts: ['first', 'second'] } }));
    await writeFile(path.join(snsDir, 'sns-manifest.json'), JSON.stringify({ outputs: { shorts: { file: 'shorts.mp4', seconds: 3.5 } } }));
    await writeFile(path.join(snsDir, 'shorts.mp4'), mp4());
    return runDir;
  };
  const capturePublish = async runDir => {
    const captured = [];
    await runSnsPublish({ runDir, channel: 'threads', approvalId: 'owner-authorized-test', journalDir: path.join(runDir, 'journal'),
      writers: { publishChain: async (posts, options) => { captured.push({ posts, options }); return { ids: ['10000002010', '10000002011'] }; } } });
    return captured[0];
  };

  process.env.SNS_THREADS_VIDEO = 'off';
  const disabled = await capturePublish(await createRun());
  assert.deepEqual(disabled.options.images, []);
  assert.deepEqual(disabled.options.videos, []);

  delete process.env.SNS_THREADS_VIDEO;
  const noShorts = await tempDir(t, 'sns-threads-no-shorts-');
  await mkdir(path.join(noShorts, 'sns'));
  await writeFile(path.join(noShorts, 'final-verification.json'), JSON.stringify({ status: 'published_verified' }));
  await writeFile(path.join(noShorts, 'sns', 'versions.json'), JSON.stringify({ threads: { posts: ['first', 'second'] } }));
  await writeFile(path.join(noShorts, 'sns', 'sns-manifest.json'), JSON.stringify({ outputs: {} }));
  assert.deepEqual((await capturePublish(noShorts)).options.videos, []);

  const enabled = await capturePublish(await createRun());
  assert.deepEqual(enabled.options.images, []);
  assert.equal(enabled.options.videos.length, 1);
  assert.equal(enabled.options.videos[0].postIndex, 0);
  assert.equal(Buffer.isBuffer(enabled.options.videos[0].file.bytes), true);
  assert.deepEqual([enabled.options.videos[0].file.width, enabled.options.videos[0].file.height,
    enabled.options.videos[0].file.durationMs], [1080, 1920, 3500]);

  const preview = await runSnsPublish({ runDir: await createRun(), channel: 'threads', dryRun: true });
  assert.equal(preview.requests.length, 3);
  assert.match(preview.requests[0].url, /rupload_igvideo\/fb_uploader_1780000000000$/);
  assert.match(preview.requests[1].url, /configure_text_post_app_feed\/$/);
  assert.equal(new URLSearchParams(preview.requests[1].body).get('upload_id'), '1780000000000');
});

test('X CreateTweet carries uploaded media ids as media_entities (x-media.mjs, owner 2026-09-28)', async () => {
  const { buildCreateTweetRequest } = await import('../scripts/sns/writers/x.mjs');
  const contracts = { operations: { CreateTweet: { queryId: 'q', features: { a: true }, fieldToggles: {} } } };
  const v = JSON.parse(buildCreateTweetRequest({ post: 'hi', contracts, mediaIds: ['2104487500400267264'] }).body).variables;
  assert.deepEqual(v.media.media_entities, [{ media_id: '2104487500400267264', tagged_users: [] }]);
  assert.deepEqual(JSON.parse(buildCreateTweetRequest({ post: 'hi', contracts }).body).variables.media.media_entities, []);
});

test('X video is uploaded before CreateTweet and the independent readback verifies the media id', async t => {
  const journalDir = await tempDir(t, 'sns-x-video-');
  const order = [];
  const mediaId = '2104487500400267264';
  const client = {
    request: async (operation, variables) => {
      order.push('create');
      assert.equal(operation, 'CreateTweet');
      assert.deepEqual(variables.media.media_entities, [{ media_id: mediaId, tagged_users: [] }]);
      return { data: { create_tweet: { tweet_results: { result: { rest_id: '2104487885307257179' } } } } };
    },
    conversation: async id => {
      order.push('readback');
      return { focal: { id, text: 'Video post https://t.co/media', media: [{ id: mediaId, type: 'video' }] } };
    },
  };
  const result = await publishThread(['Video post'], {
    client, contracts, runKey: 'x-video-order-test', journalDir, videoFile: 'race.mp4',
    uploadVideo: async (file, options) => {
      order.push('upload');
      assert.equal(file, 'race.mp4');
      assert.equal(options.runKey, 'x-video-order-test');
      assert.equal(options.journalDir, journalDir);
      return { mediaId, processed: true };
    },
  });
  assert.deepEqual(order, ['upload', 'create', 'readback']);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.readbacks[0].mediaVerified, true);
});

test('X uploads up to four images before CreateTweet and attaches them to the root only', async t => {
  const journalDir = await tempDir(t, 'sns-x-images-');
  const order = [], createVariables = [];
  const mediaIds = ['2104487500400267201', '2104487500400267202', '2104487500400267203', '2104487500400267204'];
  let createCount = 0;
  const rootId = '2104487885307257101', replyId = '2104487885307257102';
  const client = {
    request: async (_operation, variables) => {
      order.push('create'); createVariables.push(variables); createCount += 1;
      return { data: { create_tweet: { tweet_results: { result: { rest_id: createCount === 1 ? rootId : replyId } } } } };
    },
    conversation: async id => {
      order.push('readback');
      return id === rootId
        ? { focal: { id, text: 'Image root https://t.co/media', media: mediaIds.map(mediaId => ({ id: mediaId, type: 'photo' })) } }
        : { focal: { id, text: 'Follow-up', parentId: rootId, media: [] } };
    },
  };
  const result = await publishThread(['Image root', 'Follow-up'], {
    client, contracts, runKey: 'x-image-root-only-test', journalDir,
    images: mediaIds.map((_, index) => ({ bytes: png(2 + index, 3), filename: `image-${index}.png`, mimeType: 'image/png', width: 2 + index, height: 3 })),
    uploadImage: async (_image, options) => {
      order.push('upload');
      assert.equal(options.runKey, 'x-image-root-only-test');
      assert.equal(options.journalDir, journalDir);
      return { mediaId: mediaIds[order.filter(item => item === 'upload').length - 1], processed: true };
    },
  });
  assert.deepEqual(order, ['upload', 'upload', 'upload', 'upload', 'create', 'readback', 'create', 'readback']);
  assert.deepEqual(createVariables[0].media.media_entities, mediaIds.map(media_id => ({ media_id, tagged_users: [] })));
  assert.deepEqual(createVariables[1].media.media_entities, []);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.readbacks[0].mediaVerified, true);
});

test('X media upload failure stops before the post create request', async t => {
  const journalDir = await tempDir(t, 'sns-x-video-stop-');
  let writes = 0;
  await assert.rejects(publishThread(['Video post'], {
    client: { request: async () => { writes += 1; }, conversation: async () => ({}) },
    contracts, runKey: 'x-video-failure-test', journalDir, videoFile: 'race.mp4',
    uploadVideo: async () => ({ mediaId: '2104487500400267264', processed: false }),
  }), { code: 'X_VIDEO_UPLOAD_UNVERIFIED' });
  assert.equal(writes, 0);
});

test('X run dry-run and writer receive the manifest video asset', async t => {
  const runDir = await tempDir(t, 'sns-x-run-video-');
  const snsDir = path.join(runDir, 'sns');
  await mkdir(snsDir);
  const mp4 = Buffer.alloc(1100);
  Buffer.from('ftyp').copy(mp4, 4);
  await writeFile(path.join(snsDir, 'shorts.mp4'), mp4);
  await writeFile(path.join(runDir, 'final-verification.json'), JSON.stringify({ status: 'published_verified' }));
  await writeFile(path.join(snsDir, 'versions.json'), JSON.stringify({ x: { posts: ['First'], affiliateReply: 'Follow-up' } }));
  await writeFile(path.join(snsDir, 'sns-manifest.json'), JSON.stringify({ outputs: { x: { videoFile: 'shorts.mp4' } } }));

  const preview = await runSnsPublish({ runDir, channel: 'x', dryRun: true, xContractsLoader: async () => contracts });
  assert.equal(preview.mediaUploadPlan.operation, 'x_video_upload');
  assert.equal(preview.mediaUploadPlan.attachedPostIndex, 0);
  const create = preview.requests.find(request => request.url.includes('/CreateTweet'));
  assert.deepEqual(JSON.parse(create.body).variables.media.media_entities,
    [{ media_id: '0000000000000000000', tagged_users: [] }]);

  const capturedOptions = [];
  await runSnsPublish({ runDir, channel: 'x', approvalId: 'test-approved', journalDir: path.join(runDir, 'journal'),
    writers: { publishThread: async (_posts, options) => { capturedOptions.push(options); return { ids: ['2104487885307257179'] }; } } });
  assert.equal(capturedOptions[0].videoFile, path.join(snsDir, 'shorts.mp4'));
  assert.equal(capturedOptions[0].journalDir, path.join(runDir, 'journal'));
  assert.equal(capturedOptions[1].journalDir, path.join(runDir, 'journal'));
  assert.equal(capturedOptions[1].runKey, `${capturedOptions[0].runKey}-affiliate`);
  assert.equal(capturedOptions[1].replyToId, '2104487885307257179');
});
