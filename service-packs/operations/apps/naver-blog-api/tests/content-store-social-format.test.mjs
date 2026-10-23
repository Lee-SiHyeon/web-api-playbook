import test from 'node:test';
import assert from 'node:assert/strict';
import { xFormat } from '../research/content-store/x-xhr.mjs';
import { threadsFormat } from '../research/content-store/threads-public.mjs';

test('X format: media, link card, long-form rich text, own-thread reply and line rhythm', () => {
  const text = '첫 줄 🚀\n\n둘째 줄 #AI';
  const f = xFormat(
    { card: { rest_id: 'card' }, note_tweet: { note_tweet_results: { result: { text, richtext: { richtext_tags: [{ from_index: 0, to_index: 3, richtext_types: ['Bold'] }] } } } } },
    { extended_entities: { media: [{ type: 'photo' }, { type: 'video' }] }, entities: { urls: [{}], hashtags: [{ text: 'AI' }], user_mentions: [] },
      in_reply_to_screen_name: 'Sama', is_quote_status: true, lang: 'ko' },
    text, 'sama');
  assert.deepEqual({ photos: f.photos, videos: f.videos, linkCard: f.linkCard, longForm: f.longForm, richText: f.richText, ownThread: f.ownThread, quote: f.quote },
    { photos: 1, videos: 1, linkCard: true, longForm: true, richText: true, ownThread: true, quote: true });
  assert.deepEqual(f.hashtags, ['AI']);
  assert.equal(f.lines, 3); assert.equal(f.blankLines, 1); assert.equal(f.emoji, 1);
});

test('Threads format: carousel media, link card, own-thread continuation and fragments', () => {
  const v = { caption: { text: '한 줄\n두 줄' }, carousel_media: [{ image_versions2: {} }, { video_versions: [{}] }, { image_versions2: {} }] };
  const info = { link_preview_attachment: { url: 'https://x' }, is_reply: true, reply_to_author: { username: 'choi.openai' },
    text_fragments: { fragments: [{ fragment_type: 'mention' }, { fragment_type: 'link' }, { fragment_type: 'plaintext' }] }, share_info: {} };
  const f = threadsFormat(v, info, 'choi.openai');
  assert.deepEqual({ photos: f.photos, videos: f.videos, linkCard: f.linkCard, ownThread: f.ownThread, links: f.links, mentions: f.mentions, lines: f.lines },
    { photos: 2, videos: 1, linkCard: true, ownThread: true, links: 1, mentions: 1, lines: 2 });
  assert.equal(threadsFormat({ caption: { text: 'x' }, video_versions: [{}], image_versions2: { candidates: [{}] } }, {}, 'a').videos, 1);
  assert.equal(threadsFormat({ caption: { text: 'x' } }, { is_reply: true, reply_to_author: { username: 'other' } }, 'a').ownThread, false);
});
