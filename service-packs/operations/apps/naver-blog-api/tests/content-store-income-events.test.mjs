import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIncomeEventBriefInput,
  buildIncomeEventPost,
  buildOpenDartIpoRequest,
  checkIncomeEventDraft,
  collectIncomeEvents,
  eventRecordSchema,
  getReferralRegistryPath,
  incomeEventCandidates,
  loadIncomeEventsOntology,
  parseKindIpoTable,
  parseWooriBankEventList,
  parseKbCardEventList,
  parseBithumbNoticePayload,
  parsePublicIncomeEventHtml,
  parseOfficialNoticePayload,
  validateIncomeEventsOntology
} from '../research/content-store/income-events.mjs';

const ontologyPromise = loadIncomeEventsOntology();
const LAW22 = 'https://www.law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1031294935';
const ipoUrl = 'https://kind.krx.co.kr/listinvstg/pubofrschdl.do?method=searchPubofrScholMain';

const ipoDraft = (overrides = {}) => ({
  id: 'ipo-fixture',
  contentType: 'ipo_schedule_fact',
  title: '가상기업 청약 일정',
  text: '10월 5일 청약 일정: 가상기업의 청약일은 10월 5일입니다.\n그래서 청약 전 KIND 원문에서 정정 여부를 확인하세요.',
  sourceUrls: [ipoUrl],
  hookMetric: { value: '10월 5일', sourceUrl: ipoUrl, sourceQuote: '청약일은 10월 5일입니다.' },
  complianceRuleId: 'IPO-PUBLIC-FACT',
  ...overrides
});

const financialReferralDraft = (overrides = {}) => ({
  id: 'financial-referral-fixture',
  contentType: 'financial_referral',
  title: '은행 계좌 추천 프로그램',
  text: '광고·추천인 보상 3,000원: 조건 충족 시 작성자는 3,000원을 받습니다.\n그래서 가입 전 프로그램의 대상과 조건을 확인하세요.',
  sourceUrls: ['https://bank.example.invalid/events/referral'],
  hookMetric: { value: '3,000원', sourceUrl: 'https://bank.example.invalid/events/referral', sourceQuote: '조건 충족 시 작성자는 3,000원을 받습니다.' },
  referralProgram: {
    publicPostingAllowed: 'unknown',
    officialProgramUrl: 'https://bank.example.invalid/referral/terms',
    publicPostingEvidenceUrls: []
  },
  isFinancialProductReferral: true,
  financialCompliance: { rationale: '초대 프로그램의 금융상품 광고 해당 여부 확인 필요', lawUrls: [LAW22] },
  complianceRuleId: 'FINANCIAL-INVITE',
  ...overrides
});

test('ontology validates the required classes, evidence links and conservative source gates', async () => {
  const ontology = await ontologyPromise;
  assert.deepEqual(validateIncomeEventsOntology(ontology), []);
  assert.equal(ontology.sourceRegistry.length, 16);
  assert.deepEqual(ontology.sourceRegistry.filter(source => source.autoCollect).map(source => source.id).sort(),
    ['kb-card-events', 'kind-ipo', 'woori-bank-events']);
  assert.equal(ontology.quickfactConnection.workerDomainEnabled, true);
  assert.equal(ontology.sourceRegistry.filter(source => source.termsReview.verdict === 'restricted').length, 3);
  for (const source of ontology.sourceRegistry.filter(source => source.termsReview.verdict === 'restricted')) {
    assert.ok(source.termsReview.quote);
    assert.match(source.termsReview.quoteUrl, /^https:\/\//);
  }
  assert.ok(ontology.complianceRules.every(rule => rule.evidenceUrls.length > 0));

  const bad = structuredClone(ontology);
  bad.complianceRules[0].evidenceUrls = [];
  bad.assumptions[0].status = 'observed';
  bad.sourceRegistry[0].autoCollect = true;
  assert.ok(validateIncomeEventsOntology(bad).some(code => code === 'RULE_EVIDENCE_URL:NONFIN-APP-EVENT'));
  assert.ok(validateIncomeEventsOntology(bad).some(code => code === 'ASSUMPTION_MARKER:A-SAMPLE-CLASSIFICATION'));
  assert.ok(validateIncomeEventsOntology(bad).some(code => code === 'COLLECT_NOT_CLEARED:kb-bank-events'));

  const missingQuote = structuredClone(ontology);
  const shinhan = missingQuote.sourceRegistry.find(source => source.id === 'shinhan-card-events');
  shinhan.termsReview.quote = '';
  assert.ok(validateIncomeEventsOntology(missingQuote).includes('TERMS_RESTRICTED_EVIDENCE:shinhan-card-events'));

  const unprovenAllowed = structuredClone(ontology);
  const kbCard = unprovenAllowed.sourceRegistry.find(source => source.id === 'kb-card-events');
  kbCard.termsReview.verdict = 'allowed';
  kbCard.termsReview.fullTextReviewed = false;
  kbCard.termsReview.noProhibitionConfirmed = false;
  assert.ok(validateIncomeEventsOntology(unprovenAllowed).includes('TERMS_ALLOWED_EVIDENCE:kb-card-events'));

  const goodUnknown = ontology.sourceRegistry.find(source => source.id === 'woori-bank-events');
  assert.equal(goodUnknown.termsReview.verdict, 'unknown');
  assert.equal(goodUnknown.collectionBasis.kind, 'owner_authorized_unknown_terms');
  assert.equal(goodUnknown.collectionEndpoint.robotsPathAllowed, true);
  assert.equal(validateIncomeEventsOntology(ontology).some(code => code.startsWith('COLLECT_')), false);

  const restricted = structuredClone(ontology);
  const restrictedShinhan = restricted.sourceRegistry.find(source => source.id === 'shinhan-card-events');
  restrictedShinhan.autoCollect = true;
  restrictedShinhan.collectionBasis = structuredClone(goodUnknown.collectionBasis);
  restrictedShinhan.collectionEndpoint = structuredClone(goodUnknown.collectionEndpoint);
  restrictedShinhan.collectionObservation = structuredClone(goodUnknown.collectionObservation);
  assert.ok(validateIncomeEventsOntology(restricted).includes('COLLECT_NOT_CLEARED:shinhan-card-events'));

  const noBasis = structuredClone(ontology);
  delete noBasis.sourceRegistry.find(source => source.id === 'woori-bank-events').collectionBasis;
  assert.ok(validateIncomeEventsOntology(noBasis).includes('COLLECT_NOT_CLEARED:woori-bank-events'));
  assert.ok(validateIncomeEventsOntology(noBasis).includes('COLLECT_OWNER_BASIS:woori-bank-events'));

  const robotsBlocked = structuredClone(ontology);
  robotsBlocked.sourceRegistry.find(source => source.id === 'woori-bank-events').collectionEndpoint.robotsPathAllowed = false;
  assert.ok(validateIncomeEventsOntology(robotsBlocked).includes('COLLECT_ENDPOINT_ROBOTS:woori-bank-events'));
});

test('an IPO schedule fact passes with KIND evidence while an investment recommendation is forbidden', async () => {
  const ontology = await ontologyPromise;
  const fact = checkIncomeEventDraft(ipoDraft(), ontology);
  assert.equal(fact.status, 'pass');
  assert.equal(fact.decision, 'allow');

  const recommendation = checkIncomeEventDraft(ipoDraft({
    text: '10월 5일 청약: 이 종목은 매수 추천입니다. 지금 청약하세요.\n그래서 바로 청약을 넣으세요.'
  }), ontology);
  assert.equal(recommendation.status, 'forbid');
  assert.ok(recommendation.findings.some(item => item.code === 'INVESTMENT_RECOMMENDATION'));

  const unsupportedHook = checkIncomeEventDraft(ipoDraft({
    hookMetric: { value: '10월 5일', sourceUrl: ipoUrl, sourceQuote: '청약일은 10월 6일입니다.' }
  }), ontology);
  assert.equal(unsupportedHook.status, 'hold');
  assert.ok(unsupportedHook.findings.some(item => item.code === 'HOOK_NEEDS_VERIFIED_NUMBER'));
});

test('guaranteed return, income-proof claims and unreported foreign exchange are forbidden', async () => {
  const ontology = await ontologyPromise;
  const guaranteed = checkIncomeEventDraft(ipoDraft({ text: '월 10% 확정 수익을 보장합니다.\n그래서 가입하세요.' }), ontology);
  assert.equal(guaranteed.status, 'forbid');
  assert.ok(guaranteed.findings.some(item => item.code.startsWith('BANNED:BAN-GUARANTEED-RETURN')));

  const proof = checkIncomeEventDraft(ipoDraft({ incomeProof: true }), ontology);
  assert.equal(proof.status, 'forbid');
  assert.ok(proof.findings.some(item => item.code === 'INCOME_PROOF_FORBIDDEN'));

  const offshore = checkIncomeEventDraft(ipoDraft({
    text: '미신고 해외 거래소 신규가입 혜택 5,000원\n그래서 가입하세요.',
    provider: { domesticReportingStatus: 'unreported' }
  }), ontology);
  assert.equal(offshore.status, 'forbid');
  assert.ok(offshore.findings.some(item => item.code === 'UNREPORTED_FOREIGN_EXCHANGE'));
});

test('advertising disclosure must appear in the opening and name the recommender reward', async () => {
  const ontology = await ontologyPromise;
  const draft = financialReferralDraft({
    isFinancialProductReferral: false,
    complianceRuleId: 'NONFIN-APP-EVENT',
    text: '친구 초대 보상 3,000원 안내입니다.\n조건: 신규 회원이 가입합니다.\n그래서 대상인지 확인하세요.\n광고·추천인 보상: 조건 충족 시 작성자는 3,000원을 받습니다.'
  });
  const result = checkIncomeEventDraft(draft, ontology);
  assert.equal(result.status, 'hold');
  assert.ok(result.findings.some(item => item.code === 'DISCLOSURE_NOT_AT_OPENING'));
});

test('financial-product referral holds unless public posting is allowed and the Financial Consumer Act basis is present', async () => {
  const ontology = await ontologyPromise;
  const unknown = checkIncomeEventDraft(financialReferralDraft(), ontology);
  assert.equal(unknown.status, 'hold');
  assert.ok(unknown.findings.some(item => item.code === 'FINANCIAL_REFERRAL_NOT_ALLOWED'));

  const allowed = checkIncomeEventDraft(financialReferralDraft({
    referralProgram: {
      publicPostingAllowed: 'allowed',
      officialProgramUrl: 'https://bank.example.invalid/referral/terms',
      publicPostingEvidenceUrls: ['https://bank.example.invalid/referral/terms']
    }
  }), ontology);
  assert.equal(allowed.status, 'pass');
  assert.equal(allowed.decision, 'conditional');

  const noLawBasis = checkIncomeEventDraft(financialReferralDraft({
    referralProgram: {
      publicPostingAllowed: 'allowed',
      officialProgramUrl: 'https://bank.example.invalid/referral/terms',
      publicPostingEvidenceUrls: ['https://bank.example.invalid/referral/terms']
    },
    financialCompliance: { rationale: '', lawUrls: [] }
  }), ontology);
  assert.equal(noLawBasis.status, 'hold');
  assert.ok(noLawBasis.findings.some(item => item.code === 'FINANCIAL_LAW_BASIS_REQUIRED'));
});

test('reported-exchange event is conditional, and stays held until its notice terms are verified', async () => {
  const ontology = await ontologyPromise;
  const draft = {
    id: 'exchange-fixture',
    contentType: 'crypto_event',
    title: '거래 이벤트',
    text: '거래 이벤트 보상 1,000P\n조건과 기간은 공지를 확인하세요.\n그래서 거래 전 수수료와 조건을 확인하세요.',
    sourceUrls: ['https://support.coinone.co.kr/notices/123'],
    complianceRuleId: 'CRYPTO-EVENT',
    provider: { type: 'crypto_exchange', domesticReportingStatus: 'reported' },
    hookMetric: { value: '1,000P', sourceUrl: 'https://support.coinone.co.kr/notices/123', sourceQuote: '거래 미션 완료 시 1,000P 적립' },
    officialTermsVerified: false
  };
  const hold = checkIncomeEventDraft(draft, ontology);
  assert.equal(hold.status, 'hold');
  assert.ok(hold.findings.some(item => item.code === 'CRYPTO_TERMS_NOT_VERIFIED'));

  const allowed = checkIncomeEventDraft({ ...draft, officialTermsVerified: true }, ontology);
  assert.equal(allowed.status, 'pass');
  assert.equal(allowed.decision, 'conditional');

  const unreported = checkIncomeEventDraft({ ...draft, provider: { domesticReportingStatus: 'unreported' } }, ontology);
  assert.equal(unreported.status, 'forbid');
});

test('income-event candidates exclude stale, unverified and unapproved-referral items; Telegram builder keeps the disclosure and so-what line', async () => {
  const ontology = await ontologyPromise;
  const good = {
    id: 'apptech-fixture',
    title: '출석 이벤트',
    status: 'open',
    factsVerified: true,
    checkedAt: '2026-10-02',
    contentType: 'apptech_event',
    complianceRuleId: 'NONFIN-APP-EVENT',
    sourceUrls: ['https://retail.example.invalid/events/123'],
    hookMetric: { value: 5000, unit: 'P', label: '포인트 보상', sourceUrl: 'https://retail.example.invalid/events/123', sourceQuote: '출석 미션 완료 시 5,000P 지급' },
    provider: { name: '예시 리테일', type: 'retail' },
    rewardRule: { amount: 5000, currencyOrUnit: 'P', payoutDate: '2026-10-15', limits: ['1인 1회'] },
    eligibility: { who: '신규 참여자', requirements: ['출석 미션 완료'] },
    schedule: { start: '2026-10-01', end: '2026-10-30' }
  };
  const unapproved = { ...good, id: 'referral-unknown', referralProgram: { publicPostingAllowed: 'unknown' } };
  const candidates = incomeEventCandidates([good, unapproved, { ...good, id: 'unverified', factsVerified: false }], { ontology, today: '2026-10-02' });
  assert.deepEqual(candidates.map(item => item.id), ['apptech-fixture']);

  const ordered = incomeEventCandidates({ results: [{ records: [
    { ...good, id: 'later-large', schedule: { ...good.schedule, end: '2026-10-05' }, rewardRule: { amount: 20000 } },
    { ...good, id: 'urgent-small', schedule: { ...good.schedule, end: '2026-10-03' }, rewardRule: { amount: 1000 } },
    { ...good, id: 'urgent-large', schedule: { ...good.schedule, end: '2026-10-03' }, rewardRule: { amount: 5000 } }
  ] }] }, { ontology, today: '2026-10-02', limit: 3 });
  assert.deepEqual(ordered.map(item => item.id), ['urgent-large', 'urgent-small', 'later-large']);

  const post = buildIncomeEventPost(good);
  assert.equal(post.channel, 'telegram');
  assert.match(post.text, /^5,000P 포인트 보상/);
  assert.match(post.text, /그래서 /);
  assert.match(post.text, /투자 권유가 아닙니다/);
  assert.equal(post.publicationStatus, 'draft_only');
  assert.equal(buildIncomeEventPost(good, { channel: 'quickfact' }).channel, 'quickfact');
  const permittedReferral = buildIncomeEventPost({ ...good, referralProgram: {
    publicPostingAllowed: 'allowed', officialProgramUrl: 'https://retail.example.invalid/referral',
    publicPostingEvidenceUrls: ['https://retail.example.invalid/referral'], codeOrLink: 'https://retail.example.invalid/ref/fixture'
  } }, { channel: 'quickfact' });
  assert.match(permittedReferral.text, /초대 링크·코드: https:\/\/retail\.example\.invalid\/ref\/fixture/);

  assert.deepEqual(buildIncomeEventBriefInput('event-1').id, 'event-1');
  assert.equal(getReferralRegistryPath({ LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local' }), pathJoinExpected());
});

function pathJoinExpected() {
  return 'C:\\Users\\Owner\\AppData\\Local\\affiliate-content-operations\\income-events\\referrals.json';
}

test('unknown terms need the exact owner basis and endpoint robots proof; restricted sources and OpenDART stay blocked', async () => {
  const ontology = await ontologyPromise;
  let calls = 0;
  const allDisabled = structuredClone(ontology);
  for (const source of allDisabled.sourceRegistry) source.autoCollect = false;
  const blocked = await collectIncomeEvents({ ontology: allDisabled, fetchImpl: async () => { calls++; throw new Error('should not fetch'); } });
  assert.equal(blocked.status, 'no_sources_enabled');
  assert.equal(blocked.readyCount, 0);
  assert.equal(blocked.setupRequired[0].sourceId, 'opendart-ipo');
  assert.equal(blocked.setupRequired[0].stage, 'owner_configuration_required');
  assert.equal(blocked.skipped.length, 16);
  assert.equal(calls, 0);

  const dart = structuredClone(ontology.sourceRegistry.find(source => source.id === 'opendart-ipo'));
  dart.autoCollect = true;
  dart.robotsReview.verdict = 'allowed';
  dart.termsReview.verdict = 'allowed';
  dart.collectionEndpoint.robotsPathAllowed = true;
  const setupOnly = await collectIncomeEvents({
    ontology: { sourceRegistry: [dart] },
    fetchImpl: async () => { calls++; throw new Error('OpenDART must stop at setup'); }
  });
  assert.equal(setupOnly.results[0].status, 'setup_required');
  assert.equal(setupOnly.results[0].reason, 'api_key_required');
  assert.equal(calls, 0);

  const woori = structuredClone(ontology.sourceRegistry.find(source => source.id === 'woori-bank-events'));
  let request;
  const allowedUnknown = await collectIncomeEvents({
    ontology: { sourceRegistry: [woori] },
    fetchImpl: async (url, options) => {
      calls++;
      request = { url, options };
      return { ok: true, status: 200, text: async () => '<dl class="list-set"><dt><span class="hidden">Fixture Event</span></dt><dd><ul><li class="contl"><dl><dd>혜택 안내</dd><dd>이벤트기간 : 2026.10.01 ~ 2026.10.31</dd></dl></li></ul></dd></dl>' };
    }
  });
  assert.equal(allowedUnknown.results[0].count, 1);
  assert.equal(request.url, woori.collectionEndpoint.url);
  assert.equal(request.options.method, 'POST');

  const noBasis = structuredClone(woori);
  delete noBasis.collectionBasis;
  const withoutBasis = await collectIncomeEvents({
    ontology: { sourceRegistry: [noBasis] },
    fetchImpl: async () => { calls++; throw new Error('missing owner basis must not fetch'); }
  });
  assert.equal(withoutBasis.readyCount, 0);

  const restricted = structuredClone(ontology.sourceRegistry.find(source => source.id === 'shinhan-card-events'));
  restricted.autoCollect = true;
  restricted.collectionBasis = structuredClone(woori.collectionBasis);
  restricted.collectionEndpoint = structuredClone(woori.collectionEndpoint);
  restricted.collectionObservation = structuredClone(woori.collectionObservation);
  restricted.robotsReview.verdict = 'allowed';
  const restrictedResult = await collectIncomeEvents({
    ontology: { sourceRegistry: [restricted] },
    fetchImpl: async () => { calls++; throw new Error('restricted source must not fetch'); }
  });
  assert.equal(restrictedResult.readyCount, 0);

  const kind = structuredClone(ontology.sourceRegistry.find(source => source.id === 'kind-ipo'));
  const secondKind = { ...structuredClone(kind), id: 'kind-ipo-second' };
  for (const source of [kind, secondKind]) {
    source.autoCollect = true;
    source.robotsReview.verdict = 'allowed';
    source.termsReview.verdict = 'allowed';
  }
  let virtualNow = 1000;
  let requestCount = 0;
  const requestTimes = [];
  const delays = [];
  const requestOptions = [];
  const spaced = await collectIncomeEvents({
    ontology: { sourceRegistry: [kind, secondKind] },
    nowImpl: () => virtualNow,
    delayImpl: async ms => { delays.push(ms); virtualNow += ms; },
    fetchImpl: async (_url, options) => {
      requestTimes.push(virtualNow);
      requestOptions.push(options);
      if (requestCount++ === 0) throw Object.assign(new Error('fixture failure'), { code: 'ECONNRESET' });
      return { ok: true, status: 200, text: async () => '<table></table>' };
    }
  });
  assert.deepEqual(requestTimes, [1000, 4000]);
  assert.deepEqual(delays, [3000]);
  assert.deepEqual(requestOptions.map(options => options.method), ['POST', 'POST']);
  assert.match(requestOptions[0].headers['user-agent'], /Chrome\/126/);
  assert.equal(requestOptions[0].headers['accept-language'], 'ko-KR,ko;q=0.9,en;q=0.6');
  assert.equal(new URLSearchParams(requestOptions[0].body).get('method'), 'searchPubofrScholCalnd');
  assert.equal(spaced.results[0].status, 'fetch_error');
  assert.equal(spaced.results[1].status, 'read');
});

test('KIND IPO and official exchange notice parsers retain source links and reject off-host notice URLs', () => {
  const kindFixture = '<table><tr><th>기업명</th><th>청약일정</th><th>환불일</th><th>상장일</th></tr>' +
    '<tr><td><a href="https://kind.krx.co.kr/listinvstg/view/1">가상기업</a></td><td>2026-10-05 ~ 2026-10-06</td><td>2026-10-08</td><td>2026-10-15</td></tr></table>';
  const kind = parseKindIpoTable(kindFixture, { sourceUrl: ipoUrl, checkedAt: '2026-10-02T00:00:00Z' });
  assert.equal(kind.length, 1);
  assert.equal(kind[0].title, '가상기업');
  assert.deepEqual(kind[0].schedule, {
    subscriptionRaw: '2026-10-05 ~ 2026-10-06',
    refundOrPaymentRaw: '2026-10-08',
    listingRaw: '2026-10-15'
  });
  assert.equal(kind[0].sourceUrl, 'https://kind.krx.co.kr/listinvstg/view/1');

  const calendarFixture = '<center>2026년 10월</center><table summary="일, 월, 화, 수, 목, 금, 토"><tr>' +
    '<td>1<ul><li><strong>청약</strong></li><li><a href="#" onclick="fnDetailView(\'12345\')">가상기업</a></li></ul></td></tr></table>';
  const calendar = parseKindIpoTable(calendarFixture, { sourceUrl: ipoUrl, checkedAt: '2026-10-01T00:00:00Z' });
  assert.equal(calendar.length, 1);
  assert.equal(calendar[0].title, '가상기업');
  assert.deepEqual(calendar[0].schedule, { start: '2026-10-01', end: '2026-10-01', stage: '청약' });
  assert.equal(calendar[0].factsVerified, false);
  assert.match(calendar[0].sourceUrl, /bzProcsNo=12345/);

  const eventPage = '<li><a href="/event/1"><strong>출석 리워드</strong><p>이벤트 기간 2026.10.01 ~ 2026.10.31</p>' +
    '<p>혜택 최대 5,000원 적립</p><p>대상 신규 가입자</p></a></li>';
  const parsedEvent = parsePublicIncomeEventHtml(eventPage, { sourceId: 'fixture', sourceUrl: 'https://events.example.invalid/list', checkedAt: '2026-10-02T00:00:00Z' });
  assert.equal(parsedEvent.length, 1);
  assert.equal(parsedEvent[0].title, '출석 리워드');
  assert.equal(parsedEvent[0].schedule.end, '2026-10-31');
  assert.equal(parsedEvent[0].rewardRule.amount, '5000원');
  assert.equal(parsedEvent[0].eligibility.who, '대상 신규 가입자');
  assert.equal(parsedEvent[0].sourceUrls[0], 'https://events.example.invalid/event/1');
  assert.equal(parsedEvent[0].factsVerified, true);

  const navigationPage = '<li><a href="/benefit"><strong>은행소개</strong><p>혜택 5% 할인</p><p>대상: 모든 고객</p></a></li>';
  assert.deepEqual(parsePublicIncomeEventHtml(navigationPage, {
    sourceId: 'fixture', sourceUrl: 'https://events.example.invalid/list', checkedAt: '2026-10-02T00:00:00Z'
  }), []);

  const notices = parseOfficialNoticePayload({ items: [
    { uuid: 'n1', title: '신규 에어드랍 안내', category: '이벤트', url: 'https://support.coinone.co.kr/notices/n1', created_at: '2026-10-02T00:00:00Z' },
    { uuid: 'n2', title: '거래지원 공지', category: '일반', url: 'https://support.coinone.co.kr/notices/n2' },
    { uuid: 'n3', title: '에어드랍 링크', category: '이벤트', url: 'https://evil.example/notices/n3' }
  ] }, { sourceUrl: 'https://support.coinone.co.kr/notices', checkedAt: '2026-10-02T01:00:00Z' });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'airdrop_notice');
  assert.equal(notices[0].sourceUrl, 'https://support.coinone.co.kr/notices/n1');
});

test('XHR source parsers normalize explicit periods and discard rows without period evidence', () => {
  const checkedAt = '2026-10-02T00:00:00Z';
  const wooriHtml = '<dl class="list-set"><dt><span class="hidden">우리 이벤트</span></dt><dd><ul><li class="contl"><dl>' +
    '<dt><a>우리 이벤트</a></dt><dd>친구 추가 혜택</dd><dd>이벤트기간 : 2026.01.14 ~ 2026.12.31</dd></dl></li></ul></dd></dl>';
  const woori = parseWooriBankEventList(wooriHtml, {
    sourceUrl: 'https://spot.wooribank.com/pot/Dream?withyou=EVEVT0001', checkedAt
  });
  assert.equal(woori.length, 1);
  assert.equal(woori[0].periodStart, '2026-01-14');
  assert.equal(woori[0].periodEnd, '2026-12-31');
  assert.equal(woori[0].benefitText, '친구 추가 혜택');

  const kbHtml = '<ul><li><span class="subject">카드 혜택</span><span class="date">2026.10.01~2026.10.31</span>' +
    '<span class="category"><em>할인</em></span></li><li><span class="subject">기간 없는 혜택</span><span class="date">상시</span></li></ul>';
  const kb = parseKbCardEventList(kbHtml, { sourceUrl: 'https://card.kbcard.com/BON/DVIEW/HBBMCXCRVNEC0001', checkedAt });
  assert.equal(kb.length, 1);
  assert.equal(kb[0].title, '카드 혜택');
  assert.equal(kb[0].benefitText, '할인');
  assert.equal(kb[0].target, null);

  const notices = parseBithumbNoticePayload([
    { title: '일반 공지', pc_url: 'https://feed.bithumb.com/notice/1', published_at: '2026-10-02T00:00:00Z' },
    { title: '기간을 갖춘 행사', pc_url: 'https://feed.bithumb.com/notice/2', period: '2026.10.01 ~ 2026.10.31', benefit: '거래 혜택' }
  ], { checkedAt });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].periodStart, '2026-10-01');
  assert.equal(notices[0].officialUrl, 'https://feed.bithumb.com/notice/2');
  for (const row of [...woori, ...kb, ...notices]) {
    for (const key of eventRecordSchema.required) assert.ok(Object.hasOwn(row, key), `${key} missing`);
    assert.equal(row.factsVerified, false);
  }
});

test('OpenDART request builder targets the documented keyed API and refuses to run without a supplied key', () => {
  assert.throws(() => buildOpenDartIpoRequest({ beginDate: '20261001', endDate: '20261031' }), /OPENDART_API_KEY_REQUIRED/);
  const request = buildOpenDartIpoRequest({ apiKey: 'test-key', corpCode: '12345678', beginDate: '20261001', endDate: '20261031' });
  const url = new URL(request.url);
  assert.equal(request.method, 'GET');
  assert.equal(url.origin + url.pathname, 'https://opendart.fss.or.kr/api/estkRs.json');
  assert.equal(url.searchParams.get('corp_code'), '12345678');
  assert.equal(url.searchParams.get('bgn_de'), '20261001');
  assert.equal(url.searchParams.get('end_de'), '20261031');
});
