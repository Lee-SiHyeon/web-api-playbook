import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPostStats } from '../research/content-store/post-stats.mjs';

const reply = rows => ({ data: { result: { statDataList: rows.map(dataRows => ({ data: { rows: dataRows } })) } } });
const fixedNow = new Date('2026-09-25T03:00:00.000Z');

test('maps blog daily views, search inflow keywords, and conversion-ranked posts without inventing per-post views', async () => {
  const calls = [];
  const fixtures = {
    'visit/visit': reply([{ date: ['2026-09-23', '2026-09-24', '2026-09-25'], visit: [31, 42, 60] }]),
    'user/referer/search': reply([
      { date: ['2026-09-24', '2026-09-24'], searchQuery: ['캠핑 의자', '여행 가방'], cv: [3, 2] },
      { date: ['2026-09-17'], searchQuery: ['old keyword'], cv: [90] },
    ]),
    'rank/cvContentPc': reply([{
      date: ['2026-09-24', '2026-09-24', '2026-09-17'],
      createDate: ['2026-09-12', '2026-09-13', '2026-09-01'],
      rank: [1, 2, 1], cv: [10, 7, 99],
      title: ['private title one', 'private title two', 'old title'],
      uri: [
        'https://blog.naver.com/PostView.naver?blogId=owner&logNo=123456',
        'https://blog.naver.com/owner/234567',
        'https://blog.naver.com/PostView.naver?blogId=owner&logNo=345678',
      ],
    }]),
  };

  const record = await collectPostStats({
    blogId: 'aicandoanything', days: 7, now: fixedNow,
    readImpl: async input => { calls.push(input); return fixtures[input.operation]; },
  });

  assert.deepEqual(calls.map(call => call.operation), ['visit/visit', 'user/referer/search', 'rank/cvContentPc']);
  assert.ok(calls.every(call => Object.keys(call.query).sort().join(',') === '_,exclude,startDate,timeDimension'));
  assert.equal(calls[0].query.startDate, '2026-09-19');
  assert.deepEqual(record.blog.dailyViews, [
    { date: '2026-09-23', views: 31 },
    { date: '2026-09-24', views: 42 },
    { date: '2026-09-25', views: 60 },
  ]);
  assert.deepEqual(record.blog.inflowKeywords, [
    { date: '2026-09-24', keyword: '캠핑 의자', count: 3 },
    { date: '2026-09-24', keyword: '여행 가방', count: 2 },
  ]);
  assert.deepEqual(record.posts, [
    { logNo: '123456', date: '2026-09-24', views: null, inflowKeywords: [] },
    { logNo: '234567', date: '2026-09-24', views: null, inflowKeywords: [] },
  ]);
  assert.deepEqual(record.blog.topPostsByConversions, [
    { logNo: '123456', date: '2026-09-24', rank: 1, conversions: 10 },
    { logNo: '234567', date: '2026-09-24', rank: 2, conversions: 7 },
  ]);
  assert.equal(record.coverage.status, 'partial');
  assert.equal(record.coverage.perPostViews, false);
  assert.deepEqual(record.coverage.missing, [
    'per-post daily views (visit/visit is blog-level only)',
    'per-post inflow keywords (user/referer/search is blog-level only)',
  ]);
  assert.equal(record.posts.some(post => Object.hasOwn(post, 'title') || Object.hasOwn(post, 'uri')), false);
  assert.equal(record.blog.inflowKeywords.some(item => item.keyword === 'old keyword'), false);
});

test('AUTH_MISSING returns an empty auth_required record without further reads', async () => {
  let calls = 0;
  const record = await collectPostStats({
    blogId: 'aicandoanything', now: fixedNow,
    readImpl: async () => { calls++; throw Object.assign(new Error('session unavailable'), { code: 'AUTH_MISSING' }); },
  });

  assert.equal(calls, 1);
  assert.equal(record.coverage.status, 'auth_required');
  assert.deepEqual(record.posts, []);
  assert.deepEqual(record.blog, { dailyViews: [], inflowKeywords: [], topPostsByConversions: [] });
  assert.deepEqual(record.failures, [{ operation: 'visit/visit', code: 'AUTH_MISSING' }]);
});
