import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildThreadsConfigureRequest, buildTextPostAppInfo, publishChain } from '../scripts/sns/writers/threads.mjs';

const POST_ID = '12345678901';

function fakeSession() {
  return { service: 'threads', owner: 'lifehack__ailab',
    cookies: ['sessionid', 'csrftoken', 'ds_user_id', 'rur'].map(name => ({ name, value: `fake-${name}` })),
    ownerRequest: { headers: { 'x-ig-app-id': 'fake-app-id', 'x-fb-lsd': 'fake-lsd' } } };
}

function fakeReadback(ids, _options, captions) {
  const threadId = 'fake-thread';
  return { owner: 'lifehack__ailab', ownerVerified: true,
    posts: ids.map((id, index) => ({ id, code: `fake${index}`, owner: 'lifehack__ailab',
      captionSha256: createHash('sha256').update(captions[index]).digest('hex'),
      threadId, position: index + 1, threadLength: ids.length, isReply: index > 0 })),
    relations: ids.slice(0, -1).map((id, index) => ({ parentId: id, childIds: [ids[index + 1]] })) };
}

async function temporaryDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'threads-topic-writer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Threads writer puts an ordinary topic in the captured display_text-only tag header', () => {
  const topic = { displayText: '스하리 1000명 프로젝트', id: '18466046173000007', isCommunity: false };
  const appInfo = JSON.parse(buildTextPostAppInfo({ caption: 'one', topic, selfThreadContextId: 'ctx-topic' }));
  assert.deepEqual(appInfo.tag_header, { display_text: '스하리 1000명 프로젝트' });
  assert.deepEqual(Object.keys(appInfo.tag_header), ['display_text']);

  const request = buildThreadsConfigureRequest({ caption: 'one', uploadId: 'upload-1', topic,
    session: fakeSession(), selfThreadContextId: 'ctx-topic' });
  const fields = Object.fromEntries(request.body.entries());
  assert.deepEqual(JSON.parse(fields.text_post_app_info).tag_header, { display_text: '스하리 1000명 프로젝트' });
  assert.equal(request.url, 'https://www.threads.com/api/v1/media/configure_text_only_post/');
});

test('Threads public publishChain passes the topic and journals the exact payload digest', async t => {
  const journalDir = await temporaryDir(t);
  const sent = [];
  const result = await publishChain(['한 줄 게시물'], {
    session: fakeSession(), rotateCookies: async () => {}, journalDir, runKey: 'topic-run',
    topic: { displayText: '스하리 1000명 프로젝트', isCommunity: false },
    transport: async request => {
      sent.push(request);
      return new Response(JSON.stringify({ status: 'ok', media: { pk: POST_ID,
        permalink: 'https://www.threads.com/@lifehack__ailab/post/ABCDE' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
    readbackClient: async (ids, options, captions) => fakeReadback(ids, options, captions),
  });
  assert.deepEqual(result.ids, [POST_ID]);
  assert.equal(result.readbackVerified, true);
  assert.equal(sent.length, 1);
  const fields = Object.fromEntries(sent[0].body.entries());
  assert.deepEqual(JSON.parse(fields.text_post_app_info).tag_header, { display_text: '스하리 1000명 프로젝트' });

  const files = (await readdir(journalDir)).filter(file => file.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const journal = (await readFile(path.join(journalDir, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  const intent = journal.find(event => event.type === 'intent');
  const bodyText = sent[0].body.toString();
  const expectedHash = createHash('sha256').update(bodyText).digest('hex');
  const noTopicHash = createHash('sha256').update(buildThreadsConfigureRequest({ caption: '한 줄 게시물', uploadId: 'upload-1',
    session: fakeSession(), selfThreadContextId: 'ctx-topic' }).body.toString()).digest('hex');
  assert.equal(intent.request.bodySha256, expectedHash);
  assert.notEqual(intent.request.bodySha256, noTopicHash);
  assert.equal((await readFile(path.join(journalDir, files[0]), 'utf8')).includes('스하리 1000명 프로젝트'), false);
});

test('Threads writer blocks community topics and unsupported community fields before transport', async () => {
  let createCount = 0;
  const options = { transport: async () => { createCount += 1; throw new Error('write should not run'); },
    runKey: 'community-blocked', session: fakeSession() };
  await assert.rejects(publishChain(['게시물'], { ...options,
    topic: { displayText: '테스트 커뮤니티', isCommunity: true } }),
  error => error.code === 'THREADS_TOPIC_COMMUNITY_UNVERIFIED');
  assert.throws(() => buildThreadsConfigureRequest({ caption: '게시물', uploadId: 'upload-1',
    topic: { displayText: '보통 주제', isCommunity: false }, communityFlairId: 'unverified', session: fakeSession() }),
  error => error.code === 'THREADS_TOPIC_COMMUNITY_UNVERIFIED');
  assert.equal(createCount, 0);
});

test('Threads writer rejects topics on media posts before any upload or configure request', async () => {
  let createCount = 0;
  await assert.rejects(publishChain(['사진 게시물'], { session: fakeSession(), runKey: 'topic-media-blocked',
    topic: '스하리 1000명 프로젝트', images: [{ bytes: Buffer.from('image'), width: 1, height: 1 }],
    rotateCookies: async () => {}, transport: async () => { createCount += 1; throw new Error('write should not run'); } }),
  error => error.code === 'THREADS_TOPIC_MEDIA_UNVERIFIED');
  assert.equal(createCount, 0);
});

test('Threads observed image configure shapes retain tag_header inside text_post_app_info', () => {
  const topic = { displayText: '생활용품 추천', isCommunity: false };
  const requestContext = { jazoest: '12345', lsd: 'fake-lsd' };
  const single = buildThreadsConfigureRequest({ caption: '추천 상품', uploadIds: ['image-upload'], topic,
    allowTopicMedia: true, requestContext, session: fakeSession(), selfThreadContextId: 'ctx-image-topic' });
  const singleFields = new URLSearchParams(single.body);
  assert.equal(single.url, 'https://www.threads.com/api/v1/media/configure_text_post_app_feed/');
  assert.deepEqual(JSON.parse(singleFields.get('text_post_app_info')).tag_header, { display_text: '생활용품 추천' });

  const sidecar = buildThreadsConfigureRequest({ caption: '추천 상품', uploadIds: ['image-1', 'image-2'], topic,
    allowTopicMedia: true, clientSidecarId: 'sidecar-1', requestContext, session: fakeSession(), selfThreadContextId: 'ctx-image-topic' });
  assert.equal(sidecar.url, 'https://www.threads.com/api/v1/media/configure_text_post_app_sidecar/');
  assert.equal(sidecar.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.deepEqual(JSON.parse(sidecar.body).text_post_app_info && JSON.parse(JSON.parse(sidecar.body).text_post_app_info).tag_header,
    { display_text: '생활용품 추천' });
  assert.equal(JSON.parse(sidecar.body).children_metadata.length, 2);
  assert.throws(() => buildThreadsConfigureRequest({ caption: '추천 상품', uploadIds: ['image-upload'], topic,
    requestContext, session: fakeSession() }), { code: 'THREADS_TOPIC_MEDIA_UNVERIFIED' });
});

test('Threads topic and image configure runs only with explicit verification opt-in and journals image hash', async t => {
  const journalDir = await temporaryDir(t);
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(3, 20);
  const imageSha256 = createHash('sha256').update(bytes).digest('hex');
  const sent = [];
  const options = { session: fakeSession(), rotateCookies: async () => {}, journalDir, runKey: 'topic-image-run',
    requestContext: { jazoest: '12345', lsd: 'fake-lsd' }, topic: '생활용품 추천', images: [{ bytes, width: 2, height: 3, mimeType: 'image/png' }],
    transport: async request => {
      sent.push(request);
      if (request.url.includes('/rupload_igphoto/')) return new Response(JSON.stringify({ upload_id: 'image-upload' }));
      return new Response(JSON.stringify({ status: 'ok', media: { pk: POST_ID,
        permalink: 'https://www.threads.com/@lifehack__ailab/post/ABCDE' } }));
    }, readbackClient: async (ids, requestOptions, captions) => fakeReadback(ids, requestOptions, captions) };
  await assert.rejects(publishChain(['추천 상품'], options), { code: 'THREADS_TOPIC_MEDIA_UNVERIFIED' });
  assert.equal(sent.length, 0);

  const result = await publishChain(['추천 상품'], { ...options, allowTopicMedia: true });
  assert.deepEqual(result.ids, [POST_ID]);
  assert.equal(result.readbackVerified, true);
  const configFields = new URLSearchParams(sent[1].body);
  assert.deepEqual(JSON.parse(configFields.get('text_post_app_info')).tag_header, { display_text: '생활용품 추천' });
  const files = await readdir(journalDir);
  const journals = await Promise.all(files.map(file => readFile(path.join(journalDir, file), 'utf8')));
  assert.equal(journals.some(text => text.includes(`"assetSha256":"${imageSha256}"`)), true);
});
