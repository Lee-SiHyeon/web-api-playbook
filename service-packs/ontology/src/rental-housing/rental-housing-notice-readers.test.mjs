import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asDate, createRentalPublicReader } from './rental-housing-public-html.mjs';
import { collectMolitNotices, parseMolitNoticeDetail, parseMolitNoticeList } from './molit-notices.mjs';
import { collectPolicyBriefings, parsePolicyBriefingDetail, parsePolicyBriefingList } from './policy-briefing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const listFixture = await fs.readFile(path.join(here, 'fixtures/policy-briefing-list.sample.html'), 'utf8');
const detailFixture = await fs.readFile(path.join(here, 'fixtures/policy-briefing-detail.sample.html'), 'utf8');
const releaseUrl = 'https://www.korea.kr/briefing/pressReleaseView.do?newsId=156785228&pageIndex=1';

function htmlResponse(body, { status = 200, contentType = 'text/html; charset=UTF-8', location } = {}) {
  const headers = { 'content-type': contentType };
  if (location) headers.location = location;
  return new Response(body, { status, headers });
}

test('policy briefing parser extracts only observed press-release cards and metadata', () => {
  const parsed = parsePolicyBriefingList(listFixture);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, '156785228');
  assert.match(parsed.items[0].title, /^\[설명\]/);
  assert.equal(parsed.items[0].publishedAt, '2026-10-14');
  assert.match(parsed.items[0].summary, /^관련 보도자료 내용입니다/);
  assert.equal(parsed.items[0].rawLabels.publishedAt, '2026.10.14 국토교통부');
  assert.equal(parsed.pagination.currentPage, 1);
  assert.deepEqual(parsed.pagination.pages.map(item => item.pageNo), [2]);
  assert.equal(parsed.pagination.form.method, 'post');
  assert.equal(parsed.pagination.form.action, 'https://www.korea.kr/briefing/pressReleaseList.do');
});

test('policy detail parser preserves raw date labels and leaves boilerplate body summary empty', () => {
  const parsed = parsePolicyBriefingDetail(detailFixture, { url: releaseUrl });
  assert.equal(parsed.id, '156785228');
  assert.equal(parsed.publishedAt, '2026-10-14');
  assert.match(parsed.title, /^\[설명\]/);
  assert.equal(parsed.summary, null);
  assert.match(parsed.rawLabels.articleHead, /국토교통부/);
});

test('MOLIT parsers map header cells and detail labels without inventing values', () => {
  const listHtml = `<table><thead><tr><th>번호</th><th>제목</th><th>등록일</th><th>내용</th></tr></thead><tbody><tr><td>1</td><td><a href="https://www.molit.go.kr/USR/NEWS/m_71/dtl.jsp?id=8421">주거 정책 안내</a></td><td>2026.10.13</td><td>공식 안내 원문 요약</td></tr></tbody></table>`;
  const list = parseMolitNoticeList(listHtml);
  assert.equal(list.items[0].id, '8421');
  assert.equal(list.items[0].publishedAt, '2026-10-13');
  assert.equal(list.items[0].summary, '공식 안내 원문 요약');
  assert.equal(list.items[0].rawLabels['등록일'], '2026.10.13');

  const detailHtml = `<html><body><h1>주거 정책 안내</h1><table><tr><th>등록일</th><td>2026.10.13</td></tr></table><div class="view_cont"><p>공식 문서에 적힌 내용입니다.</p></div></body></html>`;
  const detail = parseMolitNoticeDetail(detailHtml, { url: list.items[0].url });
  assert.equal(detail.id, '8421');
  assert.equal(detail.publishedAt, '2026-10-13');
  assert.equal(detail.summary, '공식 문서에 적힌 내용입니다.');
});

test('missing semantic list structures and password pages fail with explicit codes', () => {
  assert.throws(() => parsePolicyBriefingList('<html><body><div class="changed"></div></body></html>'), { code: 'HTML_LAYOUT_CHANGED' });
  assert.throws(() => parseMolitNoticeList('<table><tr><th>분류</th></tr></table>'), { code: 'HTML_LAYOUT_CHANGED' });
  assert.throws(() => parsePolicyBriefingList('<title>로그인</title><form><input type="password"></form>'), { code: 'LOGIN_HTML' });
});

test('date normalization rejects impossible calendar dates and retains date-only precision', () => {
  assert.equal(asDate('2026.02.31'), null);
  assert.equal(asDate('2026-04-31'), null);
  assert.equal(asDate('2024.02.29'), '2024-02-29');
  assert.equal(asDate('2026-10-14T18:42:00+09:00'), '2026-10-14');
});

test('policy collector directly reads the public list and one observed detail with anonymous transport', async () => {
  const calls = [];
  const result = await collectPolicyBriefings({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, credentials: init.credentials, headers: init.headers });
      return String(url).includes('pressReleaseView.do') ? htmlResponse(detailFixture) : htmlResponse(listFixture);
    },
    now: new Date('2026-10-14T15:00:00.000Z'),
    minIntervalMs: 0
  });
  assert.equal(result.receipt.status, 'read');
  assert.equal(result.receipt.ok, true);
  assert.equal(result.receipt.liveReplay, true);
  assert.equal(result.receipt.clientExists, true);
  assert.equal(result.receipt.remnantFree, true);
  assert.equal(result.receipt.remnantFreeScope, 'http_browser_dependency');
  assert.equal(result.receipt.captureCleanupVerified, true);
  assert.equal(result.receipt.captureCleanupErrorCode, null);
  assert.equal(result.receipt.captured, false);
  assert.equal(result.receipt.browserXhrCaptured, false);
  assert.equal(result.receipt.requestKind, 'top_level_document');
  assert.equal(result.receipt.detailReadCount, 1);
  assert.equal(result.items[0].source, 'korea-policy-briefing');
  assert.equal(result.items[0].domain, 'www.korea.kr');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.credentials === 'omit' && !('cookie' in call.headers)));
  assert.ok(result.receipt.requests.every(request => request.captureCleanupVerified === true));
  assert.equal(/rawPath|metaPath|rental-public-html-/.test(JSON.stringify(result.receipt)), false);
});

test('policy pagination posts only fields from the observed page form and the observed onclick page number', async () => {
  const calls = [];
  const result = await collectPolicyBriefings({
    maxPages: 2,
    detailLimit: 0,
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body, credentials: init.credentials });
      return htmlResponse(listFixture);
    }
  });
  assert.equal(result.receipt.listPagesRead, 2);
  assert.equal(result.receipt.pageTraversal, 'observed_form_post');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.equal(new URLSearchParams(calls[1].body).get('pageIndex'), '2');
  assert.equal(new URLSearchParams(calls[1].body).get('startDate'), '2025-10-14');
  assert.equal(calls[1].credentials, 'omit');
  assert.equal(result.receipt.captured, false);
});

test('MOLIT self-redirect is reported as blocked without repeated requests or fake rows', async () => {
  let calls = 0;
  const result = await collectMolitNotices({
    url: 'https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp',
    detailLimit: 2,
    minIntervalMs: 0,
    fetchImpl: async url => {
      calls += 1;
      return htmlResponse('', { status: 307, contentType: '', location: String(url) });
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.receipt.status, 'redirect_blocked');
  assert.equal(result.receipt.listPagesRead, 0);
  assert.equal(result.receipt.ok, false);
  assert.equal(result.receipt.liveReplay, false);
  assert.equal(result.items.length, 0);
  assert.equal(result.receipt.requests[0].status, 307);
  assert.equal(result.receipt.requests[0].captureCleanupVerified, true);
  assert.equal(result.receipt.captureCleanupVerified, true);
});

test('challenge HTML is classified before list parsing and leaves a zero-row receipt', async () => {
  const result = await collectPolicyBriefings({
    minIntervalMs: 0,
    detailLimit: 0,
    fetchImpl: async () => htmlResponse('<title>Just a moment...</title><p>Verify you are human</p>', { status: 403 })
  });
  assert.equal(result.receipt.status, 'challenge_blocked');
  assert.equal(result.receipt.itemCount, 0);
  assert.equal(result.receipt.liveReplay, false);
});

test('HTTP-200 challenge markers on an observed form POST are classified before layout parsing', async () => {
  const calls = [];
  const result = await collectPolicyBriefings({
    maxPages: 2,
    detailLimit: 0,
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      calls.push({ method: init.method, url: String(url) });
      if (init.method === 'POST') return htmlResponse('<html><head><title>Just a moment...</title></head><body><p>Checking your browser...</p></body></html>');
      return htmlResponse(listFixture);
    }
  });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
  assert.equal(result.receipt.status, 'challenge_blocked');
  assert.equal(result.receipt.requests[1].error, 'CHALLENGE_HTML');
  assert.equal(result.receipt.requests[1].challenge.reason, 'challenge_html');
  assert.equal(result.receipt.captureCleanupVerified, true);
});

test('form POST body is bounded while streaming without a content-length header', async () => {
  const reader = await createRentalPublicReader({
    sourceId: 'reader-test',
    allowedHosts: ['www.korea.kr'],
    minIntervalMs: 0,
    maxBodyBytes: 32,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
        controller.close();
      }
    }), { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } })
  });
  try {
    const response = await reader.postObservedForm('https://www.korea.kr/briefing/pressReleaseList.do', { pageIndex: '2' });
    assert.equal(response.error, 'PUBLIC_BODY_TOO_LARGE');
    assert.equal(response.record.bytes, 0);
  } finally {
    const cleanup = await reader.close();
    assert.equal(cleanup.cleanupVerified, true);
    assert.equal(cleanup.cleanupErrorCode, null);
  }
});

test('oversized HTML is stopped by the streaming response bound', async () => {
  const result = await collectPolicyBriefings({
    maxBodyBytes: 32,
    minIntervalMs: 0,
    detailLimit: 0,
    fetchImpl: async () => htmlResponse('<html><body>' + 'x'.repeat(1000) + '</body></html>')
  });
  assert.equal(result.receipt.status, 'response_invalid');
  assert.equal(result.receipt.itemCount, 0);
  assert.equal(result.receipt.requests[0].error, 'PUBLIC_BODY_TOO_LARGE');
});
