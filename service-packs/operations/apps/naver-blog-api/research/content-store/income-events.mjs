// Read-only income-event ontology utilities.
// Usage:
//   node income-events.mjs validate
//   node income-events.mjs check <draft.json>
//   node income-events.mjs collect
//   node income-events.mjs brief <id>
//
// collect only reads sources with both robots and applicable terms explicitly reviewed as allowed.
// OpenDART collection is setup-only here: the owner must configure access outside this CLI.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONTOLOGY_PATH = path.join(HERE, 'income-events-ontology.v1.json');
const VALID_DECISIONS = new Set(['allow', 'conditional', 'hold', 'forbid']);
const VALID_POSTING = new Set(['allowed', 'forbidden', 'unknown']);
const OWNER_AUTHORIZED_BASIS = Object.freeze({
  kind: 'owner_authorized_unknown_terms',
  decidedAt: '2026-10-02',
  instruction: '\uBBF8\uBA85\uC2DC\uBA74 xhr api only\uC791\uC5C5\uD574\uC11C \uCEE4\uBC0B\uD558\uB77C\uD574',
  mode: 'xhr_api_only'
});
const PRIMARY_EVENT_HOSTS = ['fss.or.kr', 'kind.krx.co.kr', 'upbit.com', 'bithumb.com', 'coinone.co.kr', 'korbit.co.kr'];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const RECOMMENDATION_RE = /매수\s*(?:추천|하세요)|매도\s*(?:추천|하세요)|지금\s*청약\s*(?:하세요|받으세요)|청약\s*강추|오늘\s*상한가|개별\s*(?:종목|주식)\s*(?:추천|리딩)/i;
const FOREIGN_EXCHANGE_RE = /미신고\s*(?:해외\s*)?(?:가상자산\s*)?거래소|미등록\s*(?:해외\s*)?(?:가상자산\s*)?거래소/i;
const INCOME_PROOF_RE = /수익\s*(?:인증|인증샷|인증\s*후기)|월\s*\d[\d,]*\s*만?원\s*(?:벌었|수익)/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isHttps = value => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};
const dateOk = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
const textOf = value => String(value ?? '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, ' ').trim();
const parseJsonFile = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

export const eventRecordSchema = Object.freeze({
  type: 'object',
  required: ['title', 'periodStart', 'periodEnd', 'benefitText', 'target', 'officialUrl', 'checkedAt'],
  properties: {
    title: { type: 'string', minLength: 1 },
    periodStart: { type: 'string', format: 'date' },
    periodEnd: { type: 'string', format: 'date' },
    benefitText: { type: ['string', 'null'] },
    target: { type: ['string', 'null'] },
    officialUrl: { type: 'string', format: 'uri', protocol: 'https:' },
    checkedAt: { type: 'string', format: 'date-time' }
  }
});

function exactOwnerBasis(source) {
  const basis = source?.collectionBasis;
  return Boolean(basis && Object.keys(OWNER_AUTHORIZED_BASIS).length === Object.keys(basis).length
    && Object.entries(OWNER_AUTHORIZED_BASIS).every(([key, value]) => basis[key] === value));
}

function hasLiveCollectionProof(source) {
  const observation = source?.collectionObservation;
  if (Number(observation?.observedStatus) !== 200) return false;
  if (Number(observation?.normalizedRowsReturned) > 0) return true;
  return Number(observation?.normalizedRowsReturned) === 0
    && typeof observation?.verifiedEmptyExplanation === 'string'
    && observation.verifiedEmptyExplanation.trim().length > 0;
}

export const loadIncomeEventsOntology = async (file = ONTOLOGY_PATH) => parseJsonFile(file);

export function validateIncomeEventsOntology(ontology) {
  const errors = [];
  if (ontology?.schemaVersion !== 1 || ontology?.ontologyId !== 'acada:income-events') errors.push('HEADER');
  const requiredClasses = ['Event', 'Provider', 'RewardRule', 'Eligibility', 'ReferralProgram', 'IPOSchedule', 'Airdrop', 'ComplianceRule', 'DisclosureTemplate', 'BannedPhrase'];
  const classIds = new Set((ontology?.classes ?? []).map(item => item.id));
  for (const id of requiredClasses) if (!classIds.has(id)) errors.push('CLASS_MISSING:' + id);

  for (const ref of ontology?.legalReferences ?? []) if (!isHttps(ref.url)) errors.push('LEGAL_URL:' + ref.id);

  const rules = new Map();
  for (const rule of ontology?.complianceRules ?? []) {
    if (!rule.id || rules.has(rule.id)) errors.push('RULE_ID:' + (rule.id ?? 'missing'));
    rules.set(rule.id, rule);
    if (!VALID_DECISIONS.has(rule.decision)) errors.push('RULE_DECISION:' + rule.id);
    if (!Array.isArray(rule.evidenceUrls) || rule.evidenceUrls.length === 0 || rule.evidenceUrls.some(url => !isHttps(url))) errors.push('RULE_EVIDENCE_URL:' + rule.id);
    if (rule.assumption === true && !rule.conditions?.length) errors.push('ASSUMPTION_SCOPE:' + rule.id);
    if (rule.assumption !== true && (!Array.isArray(rule.conditions) || !rule.conditions.length)) errors.push('RULE_RATIONALE:' + rule.id);
  }

  for (const assumption of ontology?.assumptions ?? []) {
    if (assumption.status !== 'assumption' || !assumption.statement || !isHttps(assumption.sourceUrl)) errors.push('ASSUMPTION_MARKER:' + assumption.id);
  }

  const sources = ontology?.sourceRegistry ?? [];
  if (sources.length !== 16) errors.push('SOURCE_COUNT:' + sources.length);
  const sourceIds = new Set();
  for (const source of sources) {
    if (!source.id || sourceIds.has(source.id)) errors.push('SOURCE_ID:' + (source.id ?? 'missing'));
    sourceIds.add(source.id);
    if (!isHttps(source.url)) errors.push('SOURCE_URL:' + source.id);
    if (!['primary', 'aggregator', 'community'].includes(source.trust)) errors.push('SOURCE_TRUST:' + source.id);
    if (!['verified', 'partial', 'unknown'].includes(source.sourceCheck)) errors.push('SOURCE_CHECK:' + source.id);
    if (!dateOk(source.robotsReview?.checkedAt) || !Array.isArray(source.robotsReview?.robotsUrls) || source.robotsReview.robotsUrls.some(url => !isHttps(url))) errors.push('ROBOTS_REVIEW:' + source.id);
    if (!['allowed', 'restricted', 'unknown'].includes(source.robotsReview?.verdict)) errors.push('ROBOTS_VERDICT:' + source.id);
    if (!dateOk(source.termsReview?.checkedAt) || !['allowed', 'restricted', 'unknown'].includes(source.termsReview?.verdict)) errors.push('TERMS_REVIEW:' + source.id);
    if (source.termsReview?.termsUrl && !isHttps(source.termsReview.termsUrl)) errors.push('TERMS_URL:' + source.id);
    if ((source.termsReview?.relatedTermsUrls ?? []).some(url => !isHttps(url))) errors.push('RELATED_TERMS_URL:' + source.id);
    if (typeof source.termsReview?.result !== 'string' || !source.termsReview.result.trim()) errors.push('TERMS_RESULT:' + source.id);
    if (source.termsReview?.quoteUrl && !isHttps(source.termsReview.quoteUrl)) errors.push('TERMS_QUOTE_URL:' + source.id);
    if (source.termsReview?.verdict === 'restricted' && (!source.termsReview.quote?.trim() || !isHttps(source.termsReview.quoteUrl))) errors.push('TERMS_RESTRICTED_EVIDENCE:' + source.id);
    if (source.termsReview?.verdict === 'allowed' && (source.termsReview.fullTextReviewed !== true || source.termsReview.noProhibitionConfirmed !== true)) errors.push('TERMS_ALLOWED_EVIDENCE:' + source.id);
    if (source.autoCollect === true) {
      const unknownTermsAuthorized = source.termsReview.verdict === 'unknown'
        && exactOwnerBasis(source)
        && hasLiveCollectionProof(source);
      if (source.robotsReview.verdict !== 'allowed'
        || source.termsReview.verdict === 'restricted'
        || (source.termsReview.verdict !== 'allowed' && !unknownTermsAuthorized)) {
        errors.push('COLLECT_NOT_CLEARED:' + source.id);
      }
      if (!isHttps(source.collectionEndpoint?.url)
        || !['GET', 'POST'].includes(source.collectionEndpoint?.method)
        || source.collectionEndpoint?.robotsPathAllowed !== true) errors.push('COLLECT_ENDPOINT_ROBOTS:' + source.id);
      if (source.termsReview.verdict === 'unknown' && !exactOwnerBasis(source)) errors.push('COLLECT_OWNER_BASIS:' + source.id);
      if (source.termsReview.verdict === 'unknown' && !hasLiveCollectionProof(source)) errors.push('COLLECT_LIVE_PROOF:' + source.id);
      if (Number(source.minIntervalSeconds) < 3) errors.push('COLLECT_INTERVAL:' + source.id);
    }
  }

  const knownRuleIds = new Set(rules.keys());
  for (const phrase of ontology?.bannedPhrases ?? []) {
    if (!phrase.id || !phrase.pattern || !knownRuleIds.has(phrase.ruleId)) errors.push('BANNED_PHRASE:' + phrase.id);
    try { new RegExp(phrase.pattern, 'i'); } catch { errors.push('BANNED_REGEX:' + phrase.id); }
    if (!Array.isArray(phrase.evidenceUrls) || !phrase.evidenceUrls.length || phrase.evidenceUrls.some(url => !isHttps(url))) errors.push('BANNED_EVIDENCE:' + phrase.id);
  }
  for (const template of ontology?.disclosureTemplates ?? []) {
    if (template.placement !== 'opening' || !template.template || !template.evidenceUrls?.length || template.evidenceUrls.some(url => !isHttps(url))) errors.push('DISCLOSURE_TEMPLATE:' + template.id);
  }
  for (const example of ontology?.referralProgramExamples ?? []) {
    if (!VALID_POSTING.has(example.publicPostingAllowed)) errors.push('REFERRAL_POSTING:' + example.id);
    if (!isHttps(example.officialProgramUrl)) errors.push('REFERRAL_URL:' + example.id);
    if (example.publicPostingAllowed === 'allowed' && !(example.publicPostingEvidenceUrls ?? []).some(isHttps)) errors.push('REFERRAL_ALLOW_EVIDENCE:' + example.id);
  }
  if (ontology?.quickfactConnection?.proposedDomain !== 'G' || ontology?.quickfactConnection?.workerDomainEnabled !== true) errors.push('QUICKFACT_DOMAIN_NOT_ENABLED');
  return errors;
}

const asUrlList = draft => {
  const values = draft?.sourceUrls ?? draft?.sources ?? [];
  return (Array.isArray(values) ? values : [values]).map(value => typeof value === 'string' ? value : value?.url).filter(Boolean);
};
const referralOf = draft => draft?.referralProgram && typeof draft.referralProgram === 'object' ? draft.referralProgram : null;
const isFinancialReferral = draft => Boolean(draft?.isFinancialProductReferral || referralOf(draft)?.isFinancialProduct);
const openingLine = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
const compactMetricText = value => String(value ?? '').replace(/[,\s]/g, '');
const hasOpeningDisclosure = text => {
  const line = openingLine(text).slice(0, 220);
  return /광고|제휴|협찬|추천인\s*보상|초대\s*보상/.test(line)
    && /작성자|운영자/.test(line)
    && /\d/.test(line)
    && /보상|수수료|원고료|제공/.test(line)
    && /조건|완료|충족|지급/.test(line);
};
const sourceHostname = value => {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
};
const matchesOfficialHost = url => PRIMARY_EVENT_HOSTS.some(host => sourceHostname(url) === host || sourceHostname(url).endsWith('.' + host));

export function checkIncomeEventDraft(draft, ontology) {
  const findings = [];
  const text = String((draft?.title ?? '') + '\n' + (draft?.text ?? ''));
  const sourceUrls = asUrlList(draft);
  const add = (code, decision, message) => findings.push({ code, decision, message });

  if (!draft || typeof draft !== 'object') return { status: 'hold', decision: 'hold', findings: [{ code: 'DRAFT_INVALID', decision: 'hold', message: '초안 JSON 객체가 필요합니다.' }] };
  if (!String(draft.text ?? '').trim()) add('DRAFT_TEXT_REQUIRED', 'hold', '본문 텍스트가 비어 있습니다.');
  if (!sourceUrls.length || sourceUrls.some(url => !isHttps(url))) add('SOURCE_URL_REQUIRED', 'hold', 'HTTPS 공식 출처 URL이 필요합니다.');
  if (draft.hookMetric) {
    const hookValue = String(draft.hookMetric.value ?? '');
    const hookUrl = draft.hookMetric.sourceUrl;
    const sourceQuote = String(draft.hookMetric.sourceQuote ?? '');
    if (!hookValue || !sourceUrls.includes(hookUrl) || !compactMetricText(openingLine(draft.text)).includes(compactMetricText(hookValue))
      || !sourceQuote || !compactMetricText(sourceQuote).includes(compactMetricText(hookValue))) {
      add('HOOK_NEEDS_VERIFIED_NUMBER', 'hold', '첫 줄의 실제 숫자·차이는 공식 출처 URL로 뒷받침되어야 합니다.');
    }
  } else if (draft.requireNumericHook !== false) {
    add('HOOK_METRIC_REQUIRED', 'hold', '첫 줄에는 공식 원문에서 확인한 실제 숫자·차이와 인용 근거가 필요합니다.');
  }

  const soWhatLines = String(draft.text ?? '').split(/\r?\n/).filter(line => /^그래서(?:\s|:)/.test(line.trim()));
  if (draft.requireSoWhat !== false && soWhatLines.length !== 1) add('SOWHAT_LINE', 'hold', '그래서 한 줄을 정확히 하나 포함해야 합니다.');

  for (const phrase of ontology?.bannedPhrases ?? []) {
    let matches = false;
    try { matches = new RegExp(phrase.pattern, 'i').test(text); } catch { /* ontology validator reports invalid patterns */ }
    if (matches && phrase.severity === 'forbid') add('BANNED:' + phrase.id, 'forbid', '금지 표현 탐지: ' + phrase.id);
    else if (matches && phrase.severity === 'disclosure_review') add('REVIEW:' + phrase.id, 'hold', '고지·조건 누락 여부 검토 필요: ' + phrase.id);
  }

  if (draft.incomeProof === true || INCOME_PROOF_RE.test(text)) add('INCOME_PROOF_FORBIDDEN', 'forbid', '수익 인증·수익 실현 주장은 이 체크에서 게시 금지입니다.');
  if (draft.isUnreportedForeignExchange === true || draft.provider?.domesticReportingStatus === 'unreported' || FOREIGN_EXCHANGE_RE.test(text)) {
    add('UNREPORTED_FOREIGN_EXCHANGE', 'forbid', '미신고 해외 거래소의 국내 이용자 모집·링크 홍보는 금지입니다.');
  }
  if (draft.investmentRecommendation === true || RECOMMENDATION_RE.test(text)) add('INVESTMENT_RECOMMENDATION', 'forbid', '공모주·주식 매수/매도 권유 표현은 금지입니다.');
  if (draft.provider?.domesticReportingStatus === 'unknown' && ['crypto_event', 'airdrop', 'crypto_referral'].includes(draft.contentType)) {
    add('PROVIDER_REPORTING_UNKNOWN', 'hold', '거래소의 국내 신고 상태를 확인해야 합니다.');
  }

  const referral = referralOf(draft);
  const hasEconomicInterest = Boolean(referral || draft.economicInterest || draft.isAd);
  if (hasEconomicInterest && !hasOpeningDisclosure(draft.text)) {
    add('DISCLOSURE_NOT_AT_OPENING', 'hold', '광고·이해관계 고지와 보상 조건이 첫 부분에 없습니다.');
  }
  if (referral) {
    if (!VALID_POSTING.has(referral.publicPostingAllowed)) add('REFERRAL_POSTING_STATUS_INVALID', 'hold', 'ReferralProgram.publicPostingAllowed 값이 필요합니다.');
    else if (referral.publicPostingAllowed === 'forbidden') add('REFERRAL_PUBLIC_POSTING_FORBIDDEN', 'forbid', '공식 프로그램이 공개 게시를 금지합니다.');
    else if (referral.publicPostingAllowed === 'unknown') add('REFERRAL_PUBLIC_POSTING_UNKNOWN', 'hold', '공개 게시 허용 근거가 unknown입니다.');
    if (referral.publicPostingAllowed === 'allowed' && (!(referral.publicPostingEvidenceUrls ?? []).some(isHttps) || !referral.officialProgramUrl || !isHttps(referral.officialProgramUrl))) {
      add('REFERRAL_ALLOW_EVIDENCE_REQUIRED', 'hold', '공식 프로그램 URL과 공개 게시 허용 근거 URL이 필요합니다.');
    }
  }

  const financial = isFinancialReferral(draft);
  if (financial) {
    const law22 = 'https://www.law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1031294935';
    const fin = draft.financialCompliance;
    if (!referral || referral.publicPostingAllowed !== 'allowed') add('FINANCIAL_REFERRAL_NOT_ALLOWED', 'hold', '금융상품 초대는 공식 공개 게시 허용이 allowed여야 합니다.');
    if (draft.complianceRuleId !== 'FINANCIAL-INVITE') add('FINANCIAL_LAW_RULE_REQUIRED', 'hold', '금융상품 초대에는 FINANCIAL-INVITE 금소법 판정 규칙이 필요합니다.');
    if (!fin?.rationale?.trim() || !(fin.lawUrls ?? []).some(url => url === law22 || url.includes('lspttninf') || url.includes('277247'))) {
      add('FINANCIAL_LAW_BASIS_REQUIRED', 'hold', '금소법 조문 URL과 게시 판정 사유가 필요합니다.');
    }
  }

  const cryptoTypes = ['crypto_event', 'airdrop', 'crypto_referral'];
  if (cryptoTypes.includes(draft.contentType)) {
    if (draft.provider?.domesticReportingStatus !== 'reported') add('CRYPTO_PROVIDER_NOT_VERIFIED', 'hold', '국내 신고 거래소 상태가 확인되지 않았습니다.');
    if (draft.officialTermsVerified !== true) add('CRYPTO_TERMS_NOT_VERIFIED', 'hold', '거래소 공지·이벤트 약관 확인이 필요합니다.');
    if (!sourceUrls.some(matchesOfficialHost)) add('CRYPTO_OFFICIAL_SOURCE_REQUIRED', 'hold', '거래소 또는 프로젝트 공식 공지 URL이 필요합니다.');
  }

  const expectedRuleId = financial ? 'FINANCIAL-INVITE'
    : cryptoTypes.includes(draft.contentType) ? 'CRYPTO-EVENT'
      : ['ipo_fact', 'ipo_schedule_fact'].includes(draft.contentType) ? 'IPO-PUBLIC-FACT'
        : ['apptech_event', 'income_event', 'retail_event'].includes(draft.contentType) ? 'NONFIN-APP-EVENT'
          : null;
  const ruleId = draft.complianceRuleId ?? expectedRuleId;
  const complianceRule = (ontology?.complianceRules ?? []).find(rule => rule.id === ruleId);
  if (expectedRuleId && draft.complianceRuleId && draft.complianceRuleId !== expectedRuleId) add('COMPLIANCE_RULE_MISMATCH', 'hold', '해당 소재에는 ' + expectedRuleId + ' 판정 근거가 필요합니다.');
  if (!ruleId || !complianceRule) add('COMPLIANCE_BASIS_REQUIRED', 'hold', '준법 판정 규칙과 근거 URL을 지정해야 합니다.');
  else if (!VALID_DECISIONS.has(complianceRule.decision) || !complianceRule.evidenceUrls?.length) add('COMPLIANCE_BASIS_INVALID', 'hold', '준법 판정 근거 URL이 유효하지 않습니다.');
  else if (complianceRule.decision === 'forbid') add('COMPLIANCE_FORBID', 'forbid', '준법 규칙 ' + ruleId + ' 판정이 forbid입니다.');
  else if (complianceRule.decision === 'hold') add('COMPLIANCE_HOLD', 'hold', '준법 규칙 ' + ruleId + ' 판정이 hold입니다.');

  if (['ipo_fact', 'ipo_schedule_fact'].includes(draft.contentType) && !sourceUrls.some(url => ['opendart.fss.or.kr', 'kind.krx.co.kr'].includes(sourceHostname(url)))) {
    add('IPO_PRIMARY_SOURCE_REQUIRED', 'hold', '공모주 사실에는 DART 또는 KIND 원문 URL이 필요합니다.');
  }

  const status = findings.some(item => item.decision === 'forbid') ? 'forbid'
    : findings.some(item => item.decision === 'hold') ? 'hold' : 'pass';
  return { status, decision: complianceRule?.decision ?? 'hold', complianceRuleId: complianceRule?.id ?? null, findings };
}

const numberText = value => new Intl.NumberFormat('ko-KR').format(Number(value));
const dateText = value => value ? String(value) : '원문에서 미확인';
const listText = value => Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value ?? '원문에서 미확인');

export function buildIncomeEventPost(event, { channel = 'telegram' } = {}) {
  const metric = event?.hookMetric;
  const sourceUrls = event?.sourceUrls ?? [];
  if (!event?.id || !event?.title || !Array.isArray(sourceUrls) || !sourceUrls.some(isHttps)) throw new Error('INCOME_EVENT_NEEDS_ID_TITLE_SOURCE');
  if (!metric || !Number.isFinite(Number(metric.value)) || !metric.unit || !metric.label || !metric.sourceUrl || !sourceUrls.includes(metric.sourceUrl)
    || metric.assumption === true || !metric.sourceQuote || !compactMetricText(metric.sourceQuote).includes(compactMetricText(metric.value))) {
    throw new Error('INCOME_EVENT_HOOK_NEEDS_VERIFIED_NUMBER');
  }
  const reward = event.rewardRule ?? {};
  const referral = event.referralProgram ?? null;
  const providerName = event.provider?.name ?? '제공자 미확인';
  const formatted = numberText(metric.value) + metric.unit;
  const heading = referral
    ? '광고·추천인 보상 ' + formatted + ': ' + providerName + ' ' + event.title + '. 조건 충족 시 작성자는 ' + (referral.inviterReward ?? reward.amount ?? '보상 조건 확인 필요') + '을 받습니다.'
    : formatted + ' ' + metric.label + ': ' + event.title;
  const lines = [
    heading,
    '대상·조건: ' + listText(event.eligibility?.requirements ?? event.conditions),
    '기간·지급: ' + dateText(event.schedule?.start) + ' ~ ' + dateText(event.schedule?.end) + ' / ' + dateText(reward.payoutDate),
    '공식 원문:',
    sourceUrls[0],
    '그래서 원문에서 내 대상 여부와 남은 조건을 먼저 확인하세요.',
    '투자 권유가 아닙니다. 일정·혜택은 변경될 수 있으니 신청 전에 공식 원문을 확인하세요.'
  ];
  if (referral?.publicPostingAllowed === 'allowed' && typeof referral.codeOrLink === 'string' && referral.codeOrLink.trim()) {
    lines.splice(4, 0, '초대 링크·코드: ' + referral.codeOrLink.trim());
  }
  if (event.contentType === 'crypto_event' || event.contentType === 'airdrop' || event.contentType === 'crypto_referral') {
    lines.push('가상자산은 가격 변동으로 원금 전부 또는 일부를 잃을 수 있습니다.');
  }
  if (channel === 'blog') {
    lines.splice(1, 0, '혜택: ' + (reward.amount ?? '원문에서 미확인') + ' ' + (reward.currencyOrUnit ?? '') + '; 한도: ' + listText(reward.limits));
    lines.splice(2, 0, '참여 자격: ' + listText(event.eligibility?.who));
  } else if (channel !== 'telegram' && channel !== 'quickfact') {
    throw new Error('INCOME_EVENT_CHANNEL_UNSUPPORTED');
  }
  return {
    id: event.id,
    channel,
    title: event.title,
    contentType: event.contentType ?? 'income_event',
    complianceRuleId: event.complianceRuleId ?? 'NONFIN-APP-EVENT',
    sourceUrls,
    hookMetric: metric,
    referralProgram: referral,
    isFinancialProductReferral: event.isFinancialProductReferral === true,
    provider: event.provider,
    text: lines.join('\n'),
    publicationStatus: 'draft_only'
  };
}

export function incomeEventCandidates(input, { ontology, limit = 5, today = new Date().toISOString().slice(0, 10) } = {}) {
  const rows = Array.isArray(input) ? input : input?.events ?? input?.results?.flatMap(result => result.records ?? []) ?? [];
  const allowedRuleIds = new Set((ontology?.complianceRules ?? []).filter(rule => ['allow', 'conditional'].includes(rule.decision)).map(rule => rule.id));
  const candidates = rows.filter(event => {
    if (event?.status !== 'open' || event?.factsVerified !== true || !dateOk(event?.checkedAt)) return false;
    if (event.schedule?.end && dateOk(event.schedule.end) && event.schedule.end < today) return false;
    if (!Array.isArray(event.sourceUrls) || !event.sourceUrls.some(isHttps) || !event.hookMetric || event.hookMetric.assumption === true
      || !event.sourceUrls.includes(event.hookMetric.sourceUrl) || !event.hookMetric.sourceQuote
      || !compactMetricText(event.hookMetric.sourceQuote).includes(compactMetricText(event.hookMetric.value))) return false;
    if (!allowedRuleIds.has(event.complianceRuleId)) return false;
    const referral = event.referralProgram;
    if (referral && (referral.publicPostingAllowed !== 'allowed' || !(referral.publicPostingEvidenceUrls ?? []).some(isHttps))) return false;
    if (event.isFinancialProductReferral && (!event.financialCompliance?.rationale?.trim() || !event.financialCompliance?.lawUrls?.length)) return false;
    if (['crypto_event', 'airdrop', 'crypto_referral'].includes(event.contentType)
      && (event.provider?.domesticReportingStatus !== 'reported' || event.officialTermsVerified !== true || !event.sourceUrls.some(matchesOfficialHost))) return false;
    return true;
  });
  const deadline = event => dateOk(event.schedule?.end) ? event.schedule.end : '9999-12-31';
  const benefit = event => {
    const value = event.rewardRule?.amount ?? event.rewardAmount ?? 0;
    if (Number.isFinite(Number(value))) return Number(value);
    const match = String(value).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(억|만|천)?\s*원/);
    if (!match) return 0;
    return Number(match[1]) * ({ 억: 100000000, 만: 10000, 천: 1000 }[match[2] ?? ''] ?? 1);
  };
  return candidates.sort((a, b) => deadline(a).localeCompare(deadline(b)) || benefit(b) - benefit(a))
    .slice(0, Math.max(0, limit));
}

function strictIsoDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function strictFullYearRange(value) {
  const match = /((?:19|20)\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*(?:~|∼|－|–|-)\s*((?:19|20)\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/.exec(String(value ?? ''));
  if (!match) return null;
  const start = strictIsoDate(match[1], match[2], match[3]);
  const end = strictIsoDate(match[4], match[5], match[6]);
  if (!start || !end || end < start) return null;
  return { start, end };
}

function normalizedEventRecord({ sourceId, title, periodStart, periodEnd, benefitText = null, target = null,
  officialUrl, checkedAt, kind = 'income_event', sourceQuote = null }) {
  const cleanTitle = String(title ?? '').trim();
  const cleanBenefit = String(benefitText ?? '').trim() || null;
  const cleanTarget = String(target ?? '').trim() || null;
  if (!cleanTitle || !dateOk(periodStart) || !dateOk(periodEnd) || periodEnd < periodStart || !isHttps(officialUrl)) return null;
  return {
    id: `${sourceId}:${cleanTitle}:${periodStart}:${periodEnd}`,
    sourceId, title: cleanTitle, periodStart, periodEnd, benefitText: cleanBenefit, target: cleanTarget,
    officialUrl, checkedAt, kind, contentType: kind === 'ipo_schedule' ? 'ipo_schedule_fact' : 'income_event',
    factsVerified: false, sourceQuote: sourceQuote ?? null, sourceUrl: officialUrl, sourceUrls: [officialUrl],
    schedule: { start: periodStart, end: periodEnd }, rewardRule: cleanBenefit ? { raw: cleanBenefit } : {},
    eligibility: cleanTarget ? { who: cleanTarget, requirements: [cleanTarget] } : { who: '원문에서 확인되지 않음', requirements: [] },
    hookMetric: null, evidenceStatus: 'public_xhr_list_parsed'
  };
}

function extractBalancedTagBlocks(html, tagName, requiredClass) {
  const body = String(html ?? '');
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  const blocks = [];
  let opening;
  while ((opening = openRe.exec(body))) {
    const className = /\bclass\s*=\s*["']([^"']*)["']/i.exec(opening[0])?.[1] ?? '';
    if (!className.split(/\s+/).includes(requiredClass)) continue;
    let depth = 1;
    closeRe.lastIndex = openRe.lastIndex;
    let token;
    while ((token = closeRe.exec(body))) {
      if (/^<\//.test(token[0])) depth--;
      else if (!/\/\s*>$/.test(token[0])) depth++;
      if (depth === 0) {
        blocks.push(body.slice(opening.index, closeRe.lastIndex));
        openRe.lastIndex = closeRe.lastIndex;
        break;
      }
    }
  }
  return blocks;
}

export function parseWooriBankEventList(html, { sourceUrl, checkedAt = new Date().toISOString() } = {}) {
  return extractBalancedTagBlocks(html, 'dl', 'list-set').flatMap(block => {
    const title = textOf(/<span\b[^>]*class=["'][^"']*\bhidden\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1]
      ?? /<dt\b[^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1]);
    const range = strictFullYearRange(block);
    const details = /<li\b[^>]*class=["'][^"']*\bcontl\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/i.exec(block)?.[1] ?? block;
    const detailLines = eventTextLines(details).filter(line => !strictFullYearRange(line));
    const benefitText = detailLines.filter(line => line !== title).join(' ').trim() || null;
    const record = range && normalizedEventRecord({
      sourceId: 'woori-bank-events', title, periodStart: range.start, periodEnd: range.end,
      benefitText, officialUrl: sourceUrl, checkedAt, sourceQuote: eventTextLines(block).join(' ')
    });
    return record ? [record] : [];
  });
}

export function parseKbCardEventList(html, { sourceUrl, checkedAt = new Date().toISOString() } = {}) {
  const rows = [...String(html ?? '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(match => match[1]);
  return rows.flatMap(block => {
    const titleHtml = /<span\b[^>]*class=["'][^"']*\bsubject\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1];
    const periodText = /<span\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1];
    if (!titleHtml || !periodText) return [];
    const range = strictFullYearRange(textOf(periodText));
    const title = textOf(titleHtml);
    const benefitText = textOf(/<span\b[^>]*class=["'][^"']*\bcategory\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? '') || null;
    const record = range && normalizedEventRecord({
      sourceId: 'kb-card-events', title, periodStart: range.start, periodEnd: range.end,
      benefitText, officialUrl: sourceUrl, checkedAt, sourceQuote: `${title} ${textOf(periodText)}`
    });
    return record ? [record] : [];
  });
}

export function parseBithumbNoticePayload(payload, { checkedAt = new Date().toISOString() } = {}) {
  let parsed = payload;
  if (typeof payload === 'string') {
    try { parsed = JSON.parse(payload); } catch { return []; }
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.data ?? parsed?.items ?? parsed?.notices ?? [];
  return rows.flatMap(row => {
    const title = String(row?.title ?? row?.subject ?? '').trim();
    const periodValue = row?.period ?? row?.event_period ?? row?.date_range ?? row?.schedule?.period ?? '';
    const range = (row?.periodStart && row?.periodEnd)
      ? { start: row.periodStart, end: row.periodEnd }
      : (row?.start_date && row?.end_date)
        ? { start: row.start_date, end: row.end_date }
        : strictFullYearRange(periodValue);
    const officialUrl = row?.pc_url ?? row?.url ?? row?.link;
    let host = '';
    try { host = new URL(officialUrl).hostname.toLowerCase(); } catch { return []; }
    if (!/(?:^|\.)bithumb\.com$/.test(host)) return [];
    const record = range && normalizedEventRecord({
      sourceId: 'bithumb-notices', title, periodStart: range.start, periodEnd: range.end,
      benefitText: row?.benefit ?? row?.description ?? row?.content ?? null,
      target: row?.target ?? row?.eligibility ?? null, officialUrl, checkedAt, sourceQuote: title
    });
    return record ? [record] : [];
  });
}

export function buildOpenDartIpoRequest({ apiKey, corpCode = '', beginDate, endDate } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('OPENDART_API_KEY_REQUIRED');
  if (!/^\d{8}$/.test(beginDate ?? '') || !/^\d{8}$/.test(endDate ?? '') || endDate < beginDate) {
    throw new Error('OPENDART_DATE_RANGE_REQUIRED');
  }
  const url = new URL('https://opendart.fss.or.kr/api/estkRs.json');
  url.searchParams.set('crtfc_key', apiKey.trim());
  if (corpCode) url.searchParams.set('corp_code', corpCode);
  url.searchParams.set('bgn_de', beginDate);
  url.searchParams.set('end_de', endDate);
  return { url: url.href, method: 'GET' };
}

export function parseKindIpoTable(html, { sourceUrl, checkedAt = new Date().toISOString() } = {}) {
  const calendarRecords = parseKindCalendar(html, { sourceUrl, checkedAt });
  if (calendarRecords.length) return calendarRecords;
  const rows = [...String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  const cellsOf = row => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => match[1]);
  const headerIndex = rows.findIndex(row => /<th\b/i.test(row));
  if (headerIndex < 0) return [];
  const headers = cellsOf(rows[headerIndex]).map(textOf);
  const findColumn = regex => headers.findIndex(header => regex.test(header));
  const companyCol = findColumn(/기업|종목|회사명/);
  const applyCol = findColumn(/청약/);
  const refundCol = findColumn(/환불|납입/);
  const listingCol = findColumn(/상장/);
  return rows.slice(headerIndex + 1).flatMap(row => {
    const cells = cellsOf(row);
    const title = textOf(cells[companyCol >= 0 ? companyCol : 0] ?? '');
    if (!title || !cells.length) return [];
    const anchor = cells[companyCol >= 0 ? companyCol : 0]?.match(/href=["']([^"']+)["']/i)?.[1];
    const dateAt = col => col >= 0 ? textOf(cells[col] ?? '') : null;
    const dates = [dateAt(applyCol), dateAt(refundCol), dateAt(listingCol)];
    if (!dates.some(value => value && /\d/.test(value))) return [];
    const range = strictFullYearRange(dates[0])
      ?? dates.map(value => strictFullYearRange(value)).find(Boolean)
      ?? (() => {
        const point = dates.map(value => /((?:19|20)\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/.exec(value ?? '')).find(Boolean);
        const date = point && strictIsoDate(point[1], point[2], point[3]);
        return date ? { start: date, end: date } : null;
      })();
    let officialUrl = sourceUrl;
    if (anchor) {
      try {
        const candidate = new URL(anchor, sourceUrl);
        if (candidate.protocol === 'https:' && candidate.hostname === 'kind.krx.co.kr') officialUrl = candidate.href;
      } catch { /* Keep the verified public source page. */ }
    }
    if (!range) return [];
    const base = normalizedEventRecord({
      sourceId: 'kind-ipo', title, periodStart: range.start, periodEnd: range.end,
      benefitText: `청약 일정: ${dates.filter(Boolean).join('; ')}`, officialUrl, checkedAt,
      kind: 'ipo_schedule', sourceQuote: `${title} ${dates.filter(Boolean).join(' ')}`
    });
    if (!base) return [];
    return [{
      ...base,
      id: 'kind-ipo:' + title + ':' + checkedAt.slice(0, 10),
      title,
      kind: 'ipo_schedule',
      schedule: { subscriptionRaw: dates[0], refundOrPaymentRaw: dates[1], listingRaw: dates[2] },
      sourceUrl: officialUrl,
      checkedAt,
      evidenceStatus: 'source_text_parsed'
    }];
  });
}

const eventTextLines = html => String(html ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '\n').replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
  .replace(/<br\b[^>]*>/gi, '\n').replace(/<\/(?:p|li|h[1-6]|tr|td|div|section|article|dt|dd)>/gi, '\n')
  .split('\n').map(textOf).filter(Boolean);

const eventDateRange = lines => {
  const source = lines.find(line => /기간|일정/.test(line) && /20\d{2}/.test(line));
  if (!source) return null;
  const dotted = /(20\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\s*(?:~|∼|－|–|-|부터)\s*(?:(20\d{2})[.\-/]\s*)?(\d{1,2})[.\-/]\s*(\d{1,2})/.exec(source);
  const korean = dotted ? null : /(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일?\s*(?:~|∼|－|–|-|부터)\s*(?:(20\d{2})년\s*)?(\d{1,2})월\s*(\d{1,2})일?/.exec(source);
  const match = dotted ?? korean;
  if (!match) return null;
  const [, year, month, day, endYear, endMonth, endDay] = match;
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start: iso(year, month, day), end: iso(endYear ?? year, endMonth, endDay) };
};

const eventRewardMetric = lines => {
  for (const line of lines) {
    if (!/^\s*(?:혜택|보상|리워드|캐시백|적립|할인)\s*[:：]?/.test(line)) continue;
    const match = /(\d[\d,]*(?:\.\d+)?)\s*(만\s?원|천\s?원|원|만\s?포인트|포인트|P|%)/.exec(line);
    if (match) return { value: match[1].replace(/,/g, ''), unit: match[2].replace(/\s/g, ''), label: '혜택', sourceQuote: line };
  }
  return null;
};

const eventTarget = lines => lines.find(line => /^\s*(?:대상|참여\s*자격|참여\s*대상|응모\s*대상)\s*[:：]?\s*\S+/.test(line)) ?? null;
const genericEventTitle = title => !title || /^(?:이벤트|event)(?:\s*[|｜]\s*(?:혜택|benefit))?(?:\s*[|｜]\s*[^|｜]{2,24})?$|^(?:진행중인? 이벤트|지난 이벤트|이벤트 메인|혜택\/이벤트|상세보기|바로가기|목록|더보기)$/i.test(title);

export function parsePublicIncomeEventHtml(html, { sourceId = 'public-event', sourceUrl, checkedAt = new Date().toISOString() } = {}) {
  const base = new URL(sourceUrl);
  const body = String(html ?? '');
  const observations = [];
  for (const match of body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = textOf(/<(?:strong|h[1-6])\b[^>]*>([\s\S]*?)<\/(?:strong|h[1-6])>/i.exec(match[2])?.[1] ?? match[2]);
    if (genericEventTitle(title) || title.length < 3 || /^(?:javascript:|mailto:|#)/i.test(match[1])) continue;
    let url;
    try { url = new URL(match[1], base).href; } catch { continue; }
    if (!isHttps(url) || new URL(url).hostname !== base.hostname || url === base.href) continue;
    const listOpen = body.lastIndexOf('<li', match.index);
    const listClose = listOpen >= 0 ? body.indexOf('</li>', match.index) : -1;
    const articleOpen = body.lastIndexOf('<article', match.index);
    const articleClose = articleOpen >= 0 ? body.indexOf('</article>', match.index) : -1;
    const start = listClose > match.index ? listOpen : articleClose > match.index ? articleOpen : match.index;
    const end = start === listOpen ? listClose + 5 : start === articleOpen ? articleClose + 10 : match.index + match[0].length;
    const block = body.slice(Math.max(0, start), Math.min(body.length, Math.max(end, start + 1), start + 8000));
    const lines = eventTextLines(block);
    const schedule = eventDateRange(lines);
    const metric = eventRewardMetric(lines);
    const target = eventTarget(lines);
    if (!schedule) continue;
    if (!metric && !target) continue;
    observations.push({ title, url, lines, schedule, metric, target });
  }

  if (!observations.length) {
    const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1]
      ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    const title = textOf(heading ?? '');
    const lines = eventTextLines(body);
    const schedule = eventDateRange(lines);
    const metric = eventRewardMetric(lines);
    const target = eventTarget(lines);
    if (!genericEventTitle(title) && schedule && (metric || target)) observations.push({ title, url: base.href, lines, schedule, metric, target });
  }

  return observations.map(({ title, url, lines, schedule, metric, target }) => {
    const today = checkedAt.slice(0, 10);
    const status = !schedule ? 'unknown' : schedule.end < today ? 'closed' : schedule.start > today ? 'upcoming' : 'open';
    return {
      id: `${sourceId}:${url}`,
      title,
      contentType: 'apptech_event',
      kind: 'apptech_event_observation',
      status,
      checkedAt,
      factsVerified: Boolean(schedule && metric && target),
      schedule: schedule ?? {},
      rewardRule: metric ? { amount: metric.value + metric.unit, currencyOrUnit: metric.unit, raw: metric.sourceQuote } : {},
      eligibility: target ? { who: target, requirements: [target] } : { who: '원문에서 확인 필요', requirements: [] },
      sourceUrls: [url],
      sourceUrl: url,
      hookMetric: metric ? { ...metric, sourceUrl: url } : null,
      sourceQuote: metric?.sourceQuote ?? null,
      complianceRuleId: 'NONFIN-APP-EVENT',
      evidenceStatus: 'source_text_parsed',
      parsedLines: lines.filter(line => /기간|일정|혜택|대상|적립|할인|캐시백/.test(line)).slice(0, 12)
    };
  });
}

function parseKindCalendar(html, { sourceUrl, checkedAt }) {
  const body = String(html ?? '');
  const calendar = body.match(/<table\b[^>]*summary=["']일,\s*월,\s*화,\s*수,\s*목,\s*금,\s*토["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!calendar) return [];
  const monthLabel = textOf(/<center\b[^>]*>([\s\S]*?)<\/center>/i.exec(body)?.[1] ?? '');
  const monthParts = /(20\d{2})년\s*(\d{1,2})월/.exec(monthLabel);
  if (!monthParts) return [];
  const [, year, month] = monthParts;
  const rows = [...calendar.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  const records = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    for (const cell of cells) {
      const day = /^(\d{1,2})\b/.exec(textOf(cell))?.[1];
      if (!day) continue;
      const date = strictIsoDate(year, month, day);
      if (!date) continue;
      const items = [...cell.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(match => match[1]);
      for (let index = 0; index < items.length; index++) {
        const stage = textOf(items[index]);
        if (!/^(?:신고서제출|수요예측|IR|청약|납입|상장)$/.test(stage)) continue;
        const detail = items[index + 1] ?? '';
        const title = textOf(detail);
        const processId = /fnDetailView\(["']([^"']+)["']\)/i.exec(detail)?.[1];
        if (!title || !processId) continue;
        const detailUrl = new URL(`/listinvstg/pubofrprogcomdetail.do?method=searchProgComDetailMain&bzProcsNo=${encodeURIComponent(processId)}`, sourceUrl).href;
        const normalized = normalizedEventRecord({
          sourceId: 'kind-ipo', title, periodStart: date, periodEnd: date,
          benefitText: stage, officialUrl: detailUrl, checkedAt, kind: 'ipo_schedule',
          sourceQuote: `${date} ${stage} ${title}`
        });
        if (!normalized) continue;
        records.push({
          ...normalized,
          id: `kind-ipo:${processId}:${date}:${stage}`,
          title,
          kind: 'ipo_schedule_observation',
          contentType: 'ipo_schedule_fact',
          status: date < checkedAt.slice(0, 10) ? 'closed' : 'open',
          checkedAt,
          factsVerified: false,
          schedule: { start: date, end: date, stage },
          rewardRule: {},
          eligibility: { who: 'KIND 공모 상세 원문에서 확인 필요', requirements: [] },
          sourceUrls: [detailUrl],
          sourceUrl: detailUrl,
          sourceQuote: `${date} ${stage} ${title}`,
          evidenceStatus: 'source_text_parsed'
        });
      }
    }
  }
  return records;
}

export function parseOfficialNoticePayload(payload, { sourceUrl, checkedAt = new Date().toISOString() } = {}) {
  let parsed = payload;
  if (typeof payload === 'string') {
    try { parsed = JSON.parse(payload); } catch { return parseOfficialNoticeHtml(payload, { sourceUrl, checkedAt }); }
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.items ?? parsed?.list ?? parsed?.notices ?? parsed?.data?.items ?? [];
  return rows.flatMap(row => {
    const title = String(row?.title ?? row?.subject ?? '').trim();
    const category = String(row?.category ?? row?.type ?? '').trim();
    const body = String(row?.body ?? row?.content ?? '').trim();
    if (!title || !/(?:에어드랍|에어드롭|이벤트|신규\s*가입|친구\s*초대|추천인)/i.test(title + ' ' + category)) return [];
    const url = row.url ?? row.link ?? row.notice_url ?? sourceUrl;
    if (!isHttps(url) || new URL(url).hostname !== new URL(sourceUrl).hostname) return [];
    return [{
      id: String(row.uuid ?? row.id ?? (title + ':' + (row.created_at ?? row.createdAt ?? checkedAt))),
      title,
      body,
      category: category || null,
      sourceUrl: url,
      checkedAt,
      publishedAt: row.created_at ?? row.createdAt ?? null,
      kind: /에어드랍|에어드롭/i.test(title + ' ' + category) ? 'airdrop_notice' : 'exchange_event_notice'
    }];
  });
}

export function parseOfficialNoticeHtml(html, { sourceUrl, checkedAt = new Date().toISOString() } = {}) {
  const base = new URL(sourceUrl);
  const out = [];
  for (const match of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = textOf(match[2]);
    if (!/(?:에어드랍|에어드롭|이벤트|거래\s*지원|지급|신규\s*가입)/i.test(title)) continue;
    let url;
    try { url = new URL(match[1], base).href; } catch { continue; }
    if (url.startsWith('https://') && new URL(url).hostname === base.hostname) {
      out.push({ id: url + '#' + checkedAt.slice(0, 10), title, sourceUrl: url, checkedAt, kind: /에어드랍|에어드롭/i.test(title) ? 'airdrop_notice' : 'exchange_event_notice' });
    }
  }
  return out;
}

const sourceCleared = source => source.autoCollect === true
  && source.robotsReview?.verdict === 'allowed'
  && source.collectionEndpoint?.robotsPathAllowed === true
  && source.collectionEndpoint?.url && isHttps(source.collectionEndpoint.url)
  && ['GET', 'POST'].includes(source.collectionEndpoint.method)
  && Number(source.minIntervalSeconds) >= 3
  && (source.termsReview?.verdict === 'allowed'
    || (source.termsReview?.verdict === 'unknown' && exactOwnerBasis(source) && hasLiveCollectionProof(source)));

function extractKbCardFormEntries(html) {
  const form = /<form\b[^>]*id=["']mainForm["'][^>]*>([\s\S]*?)<\/form>/i.exec(String(html ?? ''))?.[1];
  if (!form) return [];
  const allowedNames = new Set(['pageCount', '카드이벤트구분', '이벤트혜택구분', '이벤트일련번호', '가맹점분류코드', 'prevUrl', '대고객게시여부', 'admin', '검색이벤트명']);
  const entries = [];
  for (const match of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!allowedNames.has(name)) continue;
    const type = /\btype=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? 'text';
    if (['checkbox', 'radio'].includes(type) && !/\bchecked(?:\s|=|\/?>)/i.test(tag)) continue;
    const value = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    entries.push([name, value]);
  }
  for (const match of form.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = /\bname=["']([^"']+)["']/i.exec(match[0])?.[1];
    if (!allowedNames.has(name)) continue;
    const options = [...match[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const option = options.find(item => /\bselected(?:\s|=|\/?>)/i.test(item[1])) ?? options[0];
    if (option) entries.push([name, /\bvalue=["']([^"']*)["']/i.exec(option[1])?.[1] ?? textOf(option[2])]);
  }
  return entries;
}

export async function collectIncomeEvents({
  ontology,
  fetchImpl = fetch,
  delayImpl = sleep,
  nowImpl = () => Date.now(),
  checkedAt = new Date().toISOString()
} = {}) {
  const model = ontology ?? await loadIncomeEventsOntology();
  const sources = model.sourceRegistry ?? [];
  const setupRequired = sources
    .filter(source => source.setupOnly || source.collectorType === 'opendart_setup_only')
    .map(source => ({
      sourceId: source.id,
      stage: 'owner_configuration_required',
      reason: source.blockedReason ?? 'api_key_required',
      note: source.requiredSetup ?? 'OpenDART API key setup is required; this CLI does not inspect credentials.'
    }));
  const ready = sources.filter(sourceCleared);
  const skipped = sources.filter(source => !sourceCleared(source)).map(source => ({
    sourceId: source.id,
    status: 'skipped',
    reason: source.collectionObservation?.blockedReason ?? 'robots_terms_or_xhr_basis_not_cleared'
  }));
  const results = [];
  let lastRequestStartedAt = null;
  const request = async (source, url, options = {}) => {
    const intervalMs = Math.max(3000, Number(source.minIntervalSeconds) * 1000);
    if (lastRequestStartedAt !== null) {
      const waitMs = Math.max(0, intervalMs - (nowImpl() - lastRequestStartedAt));
      if (waitMs) await delayImpl(waitMs);
    }
    lastRequestStartedAt = nowImpl();
    return fetchImpl(url, {
      ...options,
      headers: {
        accept: 'text/html,application/json',
        'user-agent': BROWSER_UA,
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.6',
        ...(options.headers ?? {})
      },
      signal: AbortSignal.timeout(10000)
    });
  };
  for (const source of ready) {
    if (source.setupOnly || source.collectorType === 'opendart_setup_only') {
      results.push({ sourceId: source.id, status: 'setup_required', reason: 'api_key_required', note: 'OpenDART key setup is required; this CLI does not inspect credentials and made no API request.' });
      continue;
    }
    if (source.collectorType === 'disabled') {
      results.push({ sourceId: source.id, status: 'unsupported_collector' });
      continue;
    }
    try {
      const endpoint = source.collectionEndpoint.url;
      let response;
      if (source.collectorType === 'kb_card_xhr') {
        const page = await request(source, source.url, { method: 'GET' });
        if (!page.ok) {
          results.push({ sourceId: source.id, status: 'http_error', stage: 'public_form_read', httpStatus: page.status,
            blockedReason: [401, 403, 429].includes(page.status) ? 'challenge_or_login_gate' : null });
          continue;
        }
        const fields = extractKbCardFormEntries(await page.text());
        if (!fields.length) {
          results.push({ sourceId: source.id, status: 'parse_error', stage: 'public_form_read', reason: 'public_search_form_missing' });
          continue;
        }
        response = await request(source, endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest', origin: new URL(source.url).origin, referer: source.url
          },
          body: new URLSearchParams(fields).toString()
        });
      } else {
        const method = source.collectionEndpoint.method;
        const body = source.collectorType === 'woori_bank_xhr'
          ? new URLSearchParams({ NowPage: '1', searchCategory: '', searchWord: '', dummy: '' }).toString()
          : source.collectorType === 'kind_calendar'
            ? new URLSearchParams({
              currentPageSize: '', pageIndex: '', method: 'searchPubofrScholCalnd', forward: 'pubofrSchol_sub',
              marketType: '', scholType: '', selYear: checkedAt.slice(0, 4), selMonth: checkedAt.slice(5, 7)
            }).toString()
            : undefined;
        response = await request(source, endpoint, {
          method,
          ...(body ? {
            body,
            headers: {
              'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
              referer: source.url,
              ...(source.collectorType === 'woori_bank_xhr' ? { origin: new URL(source.url).origin } : {})
            }
          } : {})
        });
      }
      if (!response.ok) {
        results.push({ sourceId: source.id, status: 'http_error', httpStatus: response.status,
          blockedReason: [401, 403, 429].includes(response.status) ? 'challenge_or_login_gate' : null });
        continue;
      }
      const body = await response.text();
      const records = ['kind_html', 'kind_calendar'].includes(source.collectorType)
        ? parseKindIpoTable(body, { sourceUrl: source.url, checkedAt })
        : source.collectorType === 'woori_bank_xhr'
          ? parseWooriBankEventList(body, { sourceUrl: source.url, checkedAt })
          : source.collectorType === 'kb_card_xhr'
            ? parseKbCardEventList(body, { sourceUrl: source.url, checkedAt })
            : source.collectorType === 'bithumb_notice_api'
              ? parseBithumbNoticePayload(body, { checkedAt })
              : source.collectorType === 'official_notice_html'
          ? parseOfficialNoticeHtml(body, { sourceUrl: source.url, checkedAt })
          : parsePublicIncomeEventHtml(body, { sourceId: source.id, sourceUrl: source.url, checkedAt });
      results.push({ sourceId: source.id, status: 'read', httpStatus: response.status, count: records.length, records });
    } catch (error) {
      results.push({ sourceId: source.id, status: 'fetch_error', code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'SOURCE_FETCH_FAILED' });
    }
  }
  return {
    checkedAt,
    status: ready.length ? 'completed_or_partial' : 'no_sources_enabled',
    readyCount: ready.length,
    setupRequired,
    skipped,
    results,
    note: 'This operation makes public read-only requests only (GET, plus the public KIND calendar search form). No login, application, referral use, message send, or remote write occurs.'
  };
}

export function buildIncomeEventBriefInput(id) {
  if (!String(id ?? '').trim()) throw new Error('BRIEF_ID_REQUIRED');
  return {
    id: String(id),
    title: '',
    contentType: 'income_event',
    provider: { name: '', type: 'unknown', domesticReportingStatus: 'unknown' },
    rewardRule: { form: 'unknown', amount: null, currencyOrUnit: 'unknown', payoutDate: null, conditions: [], limits: [] },
    eligibility: { who: 'unknown', requirements: [], exclusions: [] },
    schedule: { start: null, end: null },
    sourceUrls: [],
    checkedAt: null,
    hookMetric: { value: null, unit: '', label: '', sourceUrl: '', assumption: false },
    referralProgram: null,
    complianceRuleId: 'NONFIN-APP-EVENT',
    text: '',
    publicationStatus: 'draft_only'
  };
}

export function getReferralRegistryPath(env = process.env) {
  if (!env.LOCALAPPDATA) return null;
  const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(env.LOCALAPPDATA) ? path.win32 : path;
  return paths.join(env.LOCALAPPDATA, 'affiliate-content-operations', 'income-events', 'referrals.json');
}

async function runCli(argv = process.argv.slice(2)) {
  const [command, argument] = argv;
  if (command === 'validate') {
    const ontology = await loadIncomeEventsOntology();
    const errors = validateIncomeEventsOntology(ontology);
    process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors, sourceCount: ontology.sourceRegistry.length, autoCollectCount: ontology.sourceRegistry.filter(source => source.autoCollect).length }, null, 2) + '\n');
    if (errors.length) process.exitCode = 1;
    return;
  }
  if (command === 'check') {
    if (!argument) throw new Error('CHECK_DRAFT_PATH_REQUIRED');
    const [ontology, draft] = await Promise.all([loadIncomeEventsOntology(), parseJsonFile(path.resolve(argument))]);
    const result = checkIncomeEventDraft(draft, ontology);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status !== 'pass') process.exitCode = result.status === 'forbid' ? 3 : 2;
    return;
  }
  if (command === 'collect') {
    const ontology = await loadIncomeEventsOntology();
    const result = await collectIncomeEvents({ ontology });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'brief') {
    process.stdout.write(JSON.stringify(buildIncomeEventBriefInput(argument), null, 2) + '\n');
    return;
  }
  process.stdout.write('Usage: node income-events.mjs validate | check <draft.json> | collect | brief <id>\n');
  process.exitCode = 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch(error => {
    process.stderr.write((error?.message ?? 'INCOME_EVENTS_FAILED') + '\n');
    process.exitCode = 1;
  });
}
