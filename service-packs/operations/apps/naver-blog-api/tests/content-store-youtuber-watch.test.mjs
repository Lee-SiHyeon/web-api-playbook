import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, videosFromPage, TRIP_HINT } from '../research/content-store/youtuber-watch.mjs';

test('RSS entries and the channel page (old and current layouts) give video ids and titles', () => {
  const feed = '<feed><entry><yt:videoId>CYAxsMU63PM</yt:videoId><title>연차없이 1박 3일 파리 &amp; 루브르</title><published>2026-09-24T09:00:00+00:00</published><link href="https://www.youtube.com/watch?v=CYAxsMU63PM"/></entry>'
    + '<entry><yt:videoId>AAAAAAAAAAA</yt:videoId><title>쇼츠</title><published>2026-09-25T09:00:00+00:00</published><link href="https://www.youtube.com/shorts/AAAAAAAAAAA"/></entry></feed>';
  const f = parseFeed(feed);
  assert.deepEqual(f.map(v => [v.videoId, v.isShort]), [['CYAxsMU63PM', false], ['AAAAAAAAAAA', true]]);
  assert.equal(f[0].title, '연차없이 1박 3일 파리 & 루브르');
  const data = { contents: [{ videoRenderer: { videoId: 'BBBBBBBBBBB', title: { runs: [{ text: '도쿄 여행기' }] } } },
    { richItemRenderer: { content: { lockupViewModel: { contentId: 'CCCCCCCCCCC', metadata: { lockupMetadataViewModel: { title: { content: '다낭 2박4일' } } } } } } }] };
  const page = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  assert.deepEqual(videosFromPage(page).map(v => [v.videoId, v.title]), [['BBBBBBBBBBB', '도쿄 여행기'], ['CCCCCCCCCCC', '다낭 2박4일']]);
  assert.ok(TRIP_HINT.test('나홀로 2박4일 다낭 여행') && !TRIP_HINT.test('신종 다이어트템 결국..'));
});
