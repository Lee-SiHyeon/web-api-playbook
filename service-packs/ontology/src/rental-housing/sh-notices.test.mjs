import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  collectShNotices,
  expectedShNoticeLayout,
  parseShNoticeDetail,
  parseShNoticeHomepage,
  parseShNoticeList,
} from './sh-notices.mjs';

const fixture = name => readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const asResponse = (body, status = 200, headers = {}) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=UTF-8', ...headers },
});

test('homepage entry follows its observed meta refresh and parses the public rental navigation', async () => {
  const entry = await fixture('sh-notice-entry.html');
  const home = await fixture('sh-notice-home.html');
  const first = parseShNoticeHomepage(entry);
  assert.equal(new URL(first.refreshUrl).pathname, '/index.do');
  assert.equal(first.rentalListUrl, null);

  const second = parseShNoticeHomepage(home, { baseUrl: 'https://www.i-sh.co.kr/main/index.do' });
  const list = new URL(second.rentalListUrl);
  assert.equal(list.pathname, '/main/lay2/program/S1T294C297/www/brd/m_247/list.do');
  assert.equal(list.searchParams.get('multi_itm_seq'), '2');
});

test('versioned layout manifest matches the parser contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('./verification/sh-notices-layout.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(expectedShNoticeLayout(), manifest);
});

test('list parser reads visible labels, observed detail form action, and layout contract', async () => {
  const html = await fixture('sh-notice-list.html');
  const parsed = parseShNoticeList(html, {
    baseUrl: 'https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2',
  });

  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].id, '311549');
  assert.equal(parsed.items[0].title, '성북구 도전숙(수요자맞춤) 잔여세대 입주자 모집 공고');
  assert.equal(parsed.items[0].publishedAt, '2026-10-14');
  assert.equal(parsed.items[0].url, 'https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2');
  assert.equal(parsed.items[0].rawLabels.department.value, '매입주택공급부');
  assert.equal(parsed.items[0].rawLabels.category, undefined);
  assert.equal(parsed.pageNumber, 1);
  assert.equal(parsed.maximumPageObserved, 173);
  assert.deepEqual(parsed.layout, expectedShNoticeLayout().list);
});

test('detail parser exposes only printed housing facts and suppresses contact lines from summary', async () => {
  const html = await fixture('sh-notice-detail.html');
  const parsed = parseShNoticeDetail(html, { id: '311549', baseUrl: 'https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/view.do' });

  assert.equal(parsed.publishedAt, '2026-10-14');
  assert.deepEqual(parsed.housingFacts, {
    recruitmentAnnouncementDate: '2026-10-14',
    supplyUnits: {
      raw: '총 41세대(1인형 37세대, 부부형 4세대)',
      total: 41,
      breakdown: [{ label: '1인형', count: 37 }, { label: '부부형', count: 4 }],
    },
    applicationStart: '2026-10-21',
    applicationEnd: '2026-10-28',
    applicationPeriod: {
      raw: '2026.10.21.(수) ~ 10.28.(수)',
      start: { value: '2026-10-21', raw: '2026.10.21', precision: 'day', yearSource: 'printed' },
      end: { value: '2026-10-28', raw: '10.28', precision: 'month_day', yearSource: 'range_start_context' },
      resolution: 'same_range_year',
    },
    winnerAnnouncementDate: '2026-12-23',
    winnerAnnouncementStatus: 'scheduled',
  });
  assert.doesNotMatch(parsed.summary, /@|문의|0\d{1,2}-\d{3,4}-\d{4}/);

  const withoutRecruitmentDate = html.replace(/<p>■ 모집공고일 :[^<]*<\/p>/, '');
  const onlyExplicitFacts = parseShNoticeDetail(withoutRecruitmentDate);
  assert.equal(onlyExplicitFacts.housingFacts.recruitmentAnnouncementDate, undefined);
  assert.equal(onlyExplicitFacts.housingFacts.applicationStart, '2026-10-21');

  const noHousingFacts = parseShNoticeDetail('<div class="detailTable"><table><caption>공지만</caption><tbody><tr><td>등록일 : 2026-10-14 조회수 : 3</td></tr><tr><td class="cont"><p>일반 안내 내용</p></td></tr></tbody></table></div>');
  assert.equal(noHousingFacts.housingFacts, undefined);
});

test('application period resolution keeps omitted-year rollovers and reversed explicit ranges unresolved', async () => {
  const withinMonth = parseShNoticeDetail(await fixture('sh-notice-range-within-month.html'));
  assert.equal(withinMonth.housingFacts.applicationStart, '2026-10-21');
  assert.equal(withinMonth.housingFacts.applicationEnd, '2026-10-28');
  assert.equal(withinMonth.housingFacts.applicationPeriod.end.yearSource, 'range_start_context');

  const rollover = parseShNoticeDetail(await fixture('sh-notice-range-rollover.html'));
  assert.equal(rollover.housingFacts.applicationStart, '2026-12-30');
  assert.equal(rollover.housingFacts.applicationEnd, undefined);
  assert.equal(rollover.housingFacts.applicationPeriod.end.value, null);
  assert.equal(rollover.housingFacts.applicationPeriod.end.raw, '1.3');
  assert.equal(rollover.housingFacts.applicationPeriod.end.reason, 'omitted_year_would_precede_start');
  assert.equal(rollover.housingFacts.applicationPeriod.resolution, 'end_year_unresolved');

  const reversed = parseShNoticeDetail(await fixture('sh-notice-range-invalid-explicit.html'));
  assert.equal(reversed.housingFacts.applicationStart, undefined);
  assert.equal(reversed.housingFacts.applicationEnd, undefined);
  assert.equal(reversed.housingFacts.applicationPeriod.start.value, null);
  assert.equal(reversed.housingFacts.applicationPeriod.end.value, null);
  assert.equal(reversed.housingFacts.applicationPeriod.resolution, 'explicit_end_before_start');
});

test('collector replays only observed anonymous GET/form POST requests and returns partial receipt for bounded sampling', async () => {
  const entry = await fixture('sh-notice-entry.html');
  const home = await fixture('sh-notice-home.html');
  const list = await fixture('sh-notice-list.html');
  const detail = await fixture('sh-notice-detail.html');
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/') return asResponse(entry);
    if (url.pathname === '/index.do') return asResponse(null, 302, { location: '/main/index.do' });
    if (url.pathname === '/main/index.do') return asResponse(home);
    if (url.pathname.endsWith('/list.do') && init.method === 'GET') return asResponse(list);
    if (url.pathname.endsWith('/view.do') && init.method === 'POST') return asResponse(detail);
    return asResponse('missing', 404);
  };

  const result = await collectShNotices({
    fetchImpl,
    now: new Date('2026-10-14T00:00:00.000Z'),
    limit: 2,
    maxPages: 1,
    detailLimit: 1,
    minIntervalMs: 0,
    timeoutMs: 1000,
    requestBudget: 10,
  });

  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'GET', 'GET', 'GET', 'POST']);
  assert.ok(calls.every(call => call.init.credentials === 'omit' && call.init.redirect === 'manual'));
  assert.ok(calls.every(call => !Object.keys(call.init.headers).some(name => /cookie|authorization/i.test(name))));
  assert.match(calls[4].init.body, /(?:^|&)seq=311549(?:&|$)/);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].url, 'https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/list.do?multi_itm_seq=2');
  assert.equal(result.items[0].housingFacts.supplyUnits.total, 41);
  assert.equal(result.items[1].housingFacts, undefined);
  assert.equal(result.receipt.ok, true);
  assert.equal(result.receipt.status, 'partial');
  assert.ok(result.receipt.partialReasons.includes('detail_sampling'));
  assert.equal(result.receipt.operations.noticeList.liveReplay, true);
  assert.equal(result.receipt.operations.noticeDetail.liveReplay, true);
  assert.equal(result.receipt.counts.requests, 5);
  assert.equal(result.receipt.details[0].id, '311549');
  assert.equal(result.receipt.details[0].method, 'POST');
  assert.equal(result.receipt.details[0].sequenceField, 'seq');
  assert.ok(result.receipt.details[0].requestFieldNames.includes('seq'));
  assert.equal(result.receipt.details[0].target.url, 'https://www.i-sh.co.kr/main/lay2/program/S1T294C297/www/brd/m_247/view.do');
});

test('collector attaches a failed receipt when a public challenge replaces the notice list', async () => {
  const entry = await fixture('sh-notice-entry.html');
  const home = await fixture('sh-notice-home.html');
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === '/') return asResponse(entry);
    if (url.pathname === '/index.do') return asResponse(null, 302, { location: '/main/index.do' });
    if (url.pathname === '/main/index.do') return asResponse(home);
    if (url.pathname.endsWith('/list.do')) {
      return asResponse('<html><head><title>Access Denied</title></head><body>Request blocked</body></html>', 503);
    }
    return asResponse('missing', 404);
  };

  await assert.rejects(
    collectShNotices({ fetchImpl, minIntervalMs: 0, timeoutMs: 1000, requestBudget: 10 }),
    error => {
      assert.equal(error.code, 'SH_NOTICE_CHALLENGE_HTML');
      assert.equal(error.receipt.ok, false);
      assert.equal(error.receipt.status, 'error');
      assert.equal(error.receipt.error.details.challenge.reason, 'challenge_title');
      return true;
    },
  );
  assert.equal(calls.at(-1), '/main/lay2/program/S1T294C297/www/brd/m_247/list.do');
});

test('collector stops reading an oversized response before buffering the body', async () => {
  const entry = await fixture('sh-notice-entry.html');
  const home = await fixture('sh-notice-home.html');
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname === '/') return asResponse(entry);
    if (url.pathname === '/index.do') return asResponse(null, 302, { location: '/main/index.do' });
    if (url.pathname === '/main/index.do') return asResponse(home);
    if (url.pathname.endsWith('/list.do')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    }
    return asResponse('missing', 404);
  };

  await assert.rejects(
    collectShNotices({ fetchImpl, minIntervalMs: 0, timeoutMs: 1000, requestBudget: 10 }),
    error => {
      assert.equal(error.code, 'SH_NOTICE_RESPONSE_TOO_LARGE');
      assert.equal(error.receipt.status, 'error');
      assert.equal(error.receipt.counts.requests, 4);
      const attempt = error.receipt.requests.at(-1);
      assert.equal(attempt.error, 'SH_NOTICE_RESPONSE_TOO_LARGE');
      assert.equal(attempt.sha256, null);
      return true;
    },
  );
});
