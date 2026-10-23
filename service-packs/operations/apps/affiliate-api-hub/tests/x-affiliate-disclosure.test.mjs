import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertXAffiliateDisclosure, COUPANG_DISCLOSURE } from '../scripts/sns/writers/x-affiliate-disclosure.mjs';
import { publishThread, publishAffiliateVideoFromFile } from '../scripts/sns/writers/x.mjs';
import { runSnsPublish } from '../scripts/sns-publish.mjs';

const link = 'https://link.coupang.com/a/test';
const main = '광고 · 쿠팡 파트너스 활동의 일환으로 수수료를 제공받습니다. 길은 고양이가 고르고, 짐은 내가 메고.\n\n#광고 #AI연출';
const reply = `${COUPANG_DISCLOSURE}\n${link}`;

test('affiliate publication rejects missing main or reply disclosure before gate, upload and send', async () => {
  let sideEffects = 0;
  const options = { runKey: 'disclosure-reject', videoFile: 'unused.mp4',
    writeGate: async () => { sideEffects++; }, uploadVideo: async () => { sideEffects++; } };
  await assert.rejects(publishThread(['길은 고양이가 고르고.'], { ...options, affiliateReply: reply }), { code: 'X_AFFILIATE_MAIN_DISCLOSURE_REQUIRED' });
  await assert.rejects(publishThread([main], { ...options, affiliateReply: link }), { code: 'X_COUPANG_REPLY_DISCLOSURE_REQUIRED' });
  await assert.rejects(publishThread([reply], { ...options, replyToId: '100' }), { code: 'X_AFFILIATE_MAIN_DISCLOSURE_REQUIRED' });
  await assert.rejects(publishThread([link], { ...options, replyToId: '100', mainText: main }), { code: 'X_COUPANG_REPLY_DISCLOSURE_REQUIRED' });
  assert.equal(sideEffects, 0);
  await assert.rejects(publishAffiliateVideoFromFile('unused-post.txt', undefined, options), { code: 'X_AFFILIATE_REPLY_REQUIRED' });
});

test('SNS orchestrator checks the planned affiliate reply before reserving or calling a writer', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'x-sns-disclosure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'sns'));
  await writeFile(path.join(dir, 'final-verification.json'), JSON.stringify({ status: 'published_verified' }));
  await writeFile(path.join(dir, 'sns', 'versions.json'), JSON.stringify({ x: { posts: [main], affiliateReply: link } }));
  await writeFile(path.join(dir, 'sns', 'sns-manifest.json'), '{}');
  let writes = 0;
  await assert.rejects(runSnsPublish({ runDir: dir, channel: 'x', approvalId: 'approved',
    writers: { publishThread: async () => { writes++; } } }), { code: 'X_COUPANG_REPLY_DISCLOSURE_REQUIRED' });
  assert.equal(writes, 0);
  assert.deepEqual((await readdir(path.join(dir, 'sns'))).sort(), ['sns-manifest.json', 'versions.json']);
});

test('main affiliate links and inline thread replies also need full Coupang disclosure', () => {
  assert.throws(() => assertXAffiliateDisclosure([`${main}\n${link}`]), { code: 'X_COUPANG_REPLY_DISCLOSURE_REQUIRED' });
  assert.throws(() => assertXAffiliateDisclosure([main, link]), { code: 'X_COUPANG_REPLY_DISCLOSURE_REQUIRED' });
  assert.doesNotThrow(() => assertXAffiliateDisclosure([main, reply]));
  assert.doesNotThrow(() => assertXAffiliateDisclosure([`${main}\n${COUPANG_DISCLOSURE}\n${link}`]));
  assert.doesNotThrow(() => assertXAffiliateDisclosure(['일반 게시물']));
});

test('file publisher keeps full first line, attaches one video and sends one disclosed reply', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'x-disclosure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const postFile = path.join(dir, 'post.txt');
  await writeFile(postFile, main + '\n');
  const calls = [], published = new Map();
  let uploads = 0;
  const client = {
    async request(operation, variables) {
      const id = String(100 + calls.length);
      calls.push({ operation, variables });
      published.set(id, { id, text: variables.tweet_text,
        parentId: variables.reply?.in_reply_to_tweet_id,
        media: variables.media.media_entities.map(m => ({ id: m.media_id })) });
      return { data: { create_tweet: { tweet_results: { result: { rest_id: id } } } }, receipt: { status: 200 } };
    },
    async conversation(id) { return { focal: published.get(id) }; },
  };
  const result = await publishAffiliateVideoFromFile(postFile, reply, {
    client, contracts: { operations: { CreateTweet: { queryId: 'testCreate', features: {} } } },
    runKey: 'file-disclosure', journalDir: path.join(dir, 'journal'), videoFile: 'cut-acting.mp4',
    uploadVideo: async () => { uploads++; return { mediaId: '1234', processed: true }; },
  });
  assert.equal(result.readbackVerified, true);
  assert.equal(uploads, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].variables.tweet_text, main);
  assert.deepEqual(calls[0].variables.media.media_entities, [{ media_id: '1234', tagged_users: [] }]);
  assert.equal(calls[1].variables.tweet_text, reply);
  assert.equal(calls[1].variables.reply.in_reply_to_tweet_id, '100');
  assert.deepEqual(calls[1].variables.media.media_entities, []);
});
