// 리퍼·반품·임박 떨이 수집원 + 표기 규칙 (deep-discount-ontology.v1.json, deep-discount-sources.v1.json).
// Pure functions; the only network function is fetchEmart24Events (Document GET, anonymous, first page once).
//
//   loadOntology() / loadSources() / validateSources(reg)
//   classifyCondition(text)            -> { grade, ko, signals[], labelRequired }
//   conditionLabel(grade)              -> Korean label for the post
//   parseExpiry(text, now)             -> { date, kind, daysLeft } | null
//   conditionMatches(a, b)             -> true only when both titles carry the same condition grade
//   compareAgainstNew(item, newItem)   -> { allowed, reason, mustSay }          (rule R3)
//   checkPostCompliance(post, items)   -> { ok, violations[] }                  (rules R1 R2 R3 R4 R10)
//   partnerPathFor(sourceId)           -> registry partnerPath
//   parseEmart24Events(html)           -> convenience-store promo rows
//   fetchEmart24Events({fetchImpl})    -> same, from https://emart24.co.kr/goods/event
import { readFileSync } from 'node:fs';

const here = file => new URL(file, import.meta.url);
const fail = code => Object.assign(new Error(code), { code });
let ontologyCache = null;
let sourcesCache = null;
export const loadOntology = () => (ontologyCache ??= JSON.parse(readFileSync(here('./deep-discount-ontology.v1.json'), 'utf8')));
export const loadSources = () => (sourcesCache ??= JSON.parse(readFileSync(here('./deep-discount-sources.v1.json'), 'utf8')));

export function validateSources(reg = loadSources()) {
  const cv = reg?.controlledValues;
  if (reg?.schemaVersion !== 1 || !cv || !Array.isArray(reg.sites) || !reg.sites.length) throw fail('DEEP_DISCOUNT_SOURCES_SHAPE');
  const ids = new Set();
  for (const site of reg.sites) {
    if (!site.id || ids.has(site.id)) throw fail('DEEP_DISCOUNT_SOURCES_DUPLICATE');
    ids.add(site.id);
    if (!cv.group.includes(site.group) || !cv.partnerPath.includes(site.partnerPath?.path)) throw fail(`DEEP_DISCOUNT_SOURCES_VALUE:${site.id}`);
    if (!Array.isArray(site.capabilities) || !site.capabilities.length) throw fail(`DEEP_DISCOUNT_SOURCES_CAPABILITY:${site.id}`);
    for (const cap of site.capabilities) {
      for (const key of ['capability', 'access', 'decision', 'reason']) if (!cv[key].includes(cap[key])) throw fail(`DEEP_DISCOUNT_SOURCES_VALUE:${site.id}:${key}`);
      if (!cap.evidence || !cap.endpoint) throw fail(`DEEP_DISCOUNT_SOURCES_EVIDENCE:${site.id}`);
      // A blocked page must never be marked usable.
      if (cap.access === 'blocked' && cap.decision === 'use') throw fail(`DEEP_DISCOUNT_SOURCES_BLOCKED_USED:${site.id}`);
    }
  }
  return reg.sites;
}

export const partnerPathFor = (sourceId, reg = loadSources()) => reg.sites.find(s => s.id === sourceId)?.partnerPath ?? null;
export const usableSources = (group, reg = loadSources()) => reg.sites
  .filter(s => (!group || s.group === group) && s.capabilities.some(c => c.decision === 'use')).map(s => s.id);

// ---- condition ------------------------------------------------------------------------------------------------------
// Order matters: the first grade whose signal appears wins; more specific grades come first.
const GRADE_ORDER = ['near_expiry', 'clearance_closing', 'refurbished', 'returned', 'display', 'open_box', 'b_grade', 'used'];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const signalHit = (text, signal) => (/^[a-z0-9 \-]+$/i.test(signal)
  ? new RegExp(`(^|[^a-z0-9])${escapeRe(signal)}([^a-z0-9]|$)`, 'i') : new RegExp(escapeRe(signal), 'i')).test(text);

export function classifyCondition(text, ontology = loadOntology()) {
  const raw = String(text ?? '');
  // "미개봉 새상품" etc. stay new even though they contain 개봉.
  for (const id of GRADE_ORDER) {
    const grade = ontology.conditionGrades.find(g => g.id === id);
    const signals = grade.signals.filter(s => signalHit(raw, s));
    if (!signals.length) continue;
    // 'S급', 'A급' only count as 중고 when written as a grade next to 중고/급 wording; bare 'a급' is accepted by the ontology.
    return { grade: id, ko: grade.ko, signals, labelRequired: grade.labelRequired === true, expiryRequired: grade.expiryRequired === true };
  }
  return { grade: 'new', ko: '새상품', signals: [], labelRequired: false, expiryRequired: false };
}

export const conditionLabel = (grade, ontology = loadOntology()) => ontology.conditionGrades.find(g => g.id === grade)?.ko ?? null;

// Two titles refer to the same product condition only if their grades match. Replaces the 못난이/B급 regex in coupang-flash-check.mjs.
export const conditionMatches = (a, b) => classifyCondition(a).grade === classifyCondition(b).grade;

// ---- expiry ---------------------------------------------------------------------------------------------------------
const EXPIRY_LABEL = /(소비\s*기한|유통\s*기한|품질\s*유지\s*기한|유효\s*기한|EXP)/i;
const kindOf = label => /소비/.test(label) ? '소비기한' : /품질/.test(label) ? '품질유지기한' : '유통기한';
const pad = n => String(n).padStart(2, '0');
function validDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
// Reads "소비기한 2026.10.12", "유통기한: 26-10-12", "~10/12까지" after a label. Day precision, KST dates.
export function parseExpiry(text, now = new Date()) {
  const raw = String(text ?? '');
  const label = raw.match(EXPIRY_LABEL);
  const tail = label ? raw.slice(label.index + label[0].length, label.index + label[0].length + 40) : raw;
  let m = tail.match(/(20\d{2}|\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  let date = null;
  if (m) date = validDate(m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]), Number(m[2]), Number(m[3]));
  else if (label && (m = tail.match(/(\d{1,2})\s*[./월]\s*(\d{1,2})\s*(?:일)?/))) {
    const kst = new Date(now.getTime() + 9 * 3600_000);
    date = validDate(kst.getUTCFullYear(), Number(m[1]), Number(m[2]));
  }
  if (!date) return null;
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const today = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
  const [y, mo, d] = date.split('-').map(Number);
  return { date, kind: label ? kindOf(label[0]) : null, daysLeft: Math.round((Date.UTC(y, mo - 1, d) - today) / 86_400_000) };
}

// ---- rule R3: never compare a 리퍼 price with a new-item price as the same product -------------------------------------
export function compareAgainstNew(item, newItem, ontology = loadOntology()) {
  const g = classifyCondition(`${item?.title ?? ''} ${item?.conditionRaw ?? ''}`, ontology);
  const n = classifyCondition(`${newItem?.title ?? ''} ${newItem?.conditionRaw ?? ''}`, ontology);
  if (item?.conditionGrade && item.conditionGrade !== 'new') g.grade = item.conditionGrade;
  if (g.grade === n.grade) return { allowed: true, reason: 'same_condition', mustSay: null };
  return {
    allowed: false, reason: n.grade === 'new' ? 'condition_differs_from_new' : 'condition_mismatch',
    mustSay: `${conditionLabel(g.grade, ontology)} 상품이라 새상품과 같은 상품의 최저가로 비교할 수 없습니다. 새상품 가격은 참고용입니다.`,
  };
}

// ---- post compliance (R1, R2, R3, R4, R10) ---------------------------------------------------------------------------
const COMPARE_WORDS = /(최저가|가장\s*싸|제일\s*싸|보다\s*(?:\d[\d,]*\s*원|\d+\s*%)?\s*(?:더\s*)?(?:싸|저렴)|대비\s*\d+\s*%|\d+\s*%\s*(?:싸|저렴|할인))/;
const WARRANTY_WORD = /(보증|A\/S|AS\s|워런티|무상\s*수리)/;
const COUPANG_RM = /반품\s*마켓/;
const COUPANG_LINK = /https?:\/\/link\.coupang\.com\//;

// item: { title?, grade?, expiryDate?, warrantyKnown?, sourceId? }. The text is the whole post (or the part sent to a channel).
export function checkPostCompliance(post, items = [], ontology = loadOntology()) {
  const text = String(post ?? '');
  const violations = [];
  const add = (rule, message, item = null) => violations.push({ rule, severity: ontology.rules.find(r => r.id === rule)?.severity ?? 'warn', message, item: item?.title ?? null });
  for (const item of items) {
    const grade = item.grade ?? classifyCondition(item.title, ontology).grade;
    const def = ontology.conditionGrades.find(g => g.id === grade);
    if (!def || grade === 'new') continue;
    if (def.labelRequired && !text.includes(def.ko.replace(/\(.*\)/, '')) && !def.signals.some(s => signalHit(text, s))) {
      add('R1_label_condition', `${def.ko} 상품인데 글에 상태 표기가 없습니다.`, item);
    }
    if (def.expiryRequired) {
      const found = parseExpiry(text) ?? (item.expiryDate ? { date: item.expiryDate } : null);
      const dateInText = parseExpiry(text);
      if (!found) add('R2_show_expiry_for_near_expiry_food', '임박 식품인데 기한 날짜 자료가 없습니다. 임박 상품으로 소개하지 않습니다.', item);
      else if (!dateInText) add('R2_show_expiry_for_near_expiry_food', `기한(${found.date})이 있지만 글에 날짜가 적혀 있지 않습니다.`, item);
    }
    if (COMPARE_WORDS.test(text) && !/(상태가 다른|새상품 가격은 참고|새상품과 (?:같은|직접)[^.]{0,12}비교)/.test(text)) {
      add('R3_no_refurb_vs_new_as_same_product', '상태가 다른 상품을 최저가·새상품 대비 할인으로 비교했습니다.', item);
    }
    if (!item.warrantyKnown && !WARRANTY_WORD.test(text)) add('R4_warranty_disclosed_or_unknown', '보증 조건 문구가 없습니다.', item);
    if ((item.sourceId === 'coupang_return_market' || COUPANG_RM.test(text)) && COUPANG_LINK.test(text)) {
      add('R10_partner_link_gate', '쿠팡 반품마켓 상품에 쿠팡 파트너스 링크를 붙였습니다(파트너스 검색으로 확인 불가).', item);
    }
  }
  return { ok: !violations.some(v => v.severity === 'error'), violations };
}

// ---- 이마트24 행사상품 (Document GET, SSR HTML) -------------------------------------------------------------------------
const PROMO_CLASS = { onepl: '1+1', twopl: '2+1', threepl: '3+1', sale: '할인', gola: '골라담기' };
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

export function parseEmart24Events(html) {
  const rows = [];
  for (const block of String(html).split('<div class="itemWrap">').slice(1)) {
    const promoClass = block.match(/class="(onepl|twopl|threepl|sale|gola)\s+floatR"/);
    const title = block.match(/<div class="itemtitle">[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    const price = block.match(/class="price">\s*([\d,]+)\s*원/);
    if (!title || !price) continue;
    rows.push({
      sourceId: 'emart24_event', title: decode(title[1]), price: Number(price[1].replace(/,/g, '')),
      promoType: promoClass ? PROMO_CLASS[promoClass[1]] : null,
      isNew: /class="floatL"\s*>\s*NEW/.test(block),
      conditionGrade: 'new', expiryDate: null,
      image: block.match(/<img[^>]*src="([^"]+)"/)?.[1] ?? null,
    });
  }
  if (!rows.length) throw fail('EMART24_EVENT_SCHEMA');
  return rows;
}

export async function fetchEmart24Events({ fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl('https://emart24.co.kr/goods/event', {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12_000), headers: { accept: 'text/html' },
  });
  if (response.status !== 200) { await response.body?.cancel(); throw fail(`EMART24_EVENT_HTTP_${response.status}`); }
  if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) { await response.body?.cancel(); throw fail('EMART24_EVENT_MIME'); }
  return parseEmart24Events(await response.text());
}
