// Hook ontology runtime (hook-ontology.v1.json): find why a topic is rising now, then build hook candidates whose
// evidence is present. owner 2026-09-27: "이런거 좀 진부하지않냐? … 후킹 및 사용자 이목끌 방안 탐색해",
// "후킹같은거 온톨로지 확장해놔".
//
//   probeWhyNow(keyword)    public Naver news tab (anonymous GET, observed 2026-09-27), last month, relevance order:
//                           GET https://search.naver.com/search.naver?ssc=tab.news.all&query=<q>&sort=0&pd=2
//                           for "<kw> 할인", "<kw> 출시", "<kw>". Keeps articles naming the keyword as a word (레고, 레고코리아
//                           but not 레고랜드), classifies them into ontology trigger kinds, and reads end dates
//                           ("9월 11일부터 27일까지", "내달 11일까지", "22일 마감") and "최대 N%". Stops at a challenge page.
//   suggestHooks(event, whyNow)  ranked hook candidates (title, opening, basis URLs, what to verify) for patterns whose
//                           requirements are met; with no trigger only evergreen hooks and "원인 미확인".
//   validateHookOntology(o) structural checks used by the test.
//   Usage: node hooks.mjs --probe=<keyword> [--category=<name>]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const loadHookOntology = (file = path.join(HERE, 'hook-ontology.v1.json')) => JSON.parse(readFileSync(file, 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const CHALLENGE = /자동입력 방지 문자|보안문자를 입력|unusual traffic|비정상적인 접근/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateHookOntology(o) {
  const errors = [];
  const ids = new Set();
  for (const p of o.hookPatterns || []) {
    if (!p.id || ids.has(p.id)) errors.push(`pattern id ${p.id}`); ids.add(p.id);
    if (!p.formula || !Object.keys(p.formula).length) errors.push(`${p.id}: formula`);
    if (!Array.isArray(p.requires)) errors.push(`${p.id}: requires`);
    if (!p.examples?.length) errors.push(`${p.id}: no observed example`);
    for (const e of p.examples || []) if (!/^https:\/\//.test(e.url || '') || !e.text) errors.push(`${p.id}: example without url/text`);
  }
  for (const t of o.triggerKinds || []) { try { new RegExp(t.match); } catch { errors.push(`trigger ${t.id}: bad regex`); } }
  if (!(o.guardrails || []).some(g => g.id === 'sourced_urgency')) errors.push('guardrail sourced_urgency missing');
  return errors;
}

// News results: each headline anchor (span …headline1) followed by its snippet (span …body1).
export function parseNewsResults(html) {
  const src = String(html);
  const heads = [...src.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>\s*<span[^>]*headline1[^>]*>([\s\S]*?)<\/span>/g)];
  if (!heads.length && CHALLENGE.test(src)) fail('NEWS_CHALLENGE');
  return heads.map((m, i) => {
    const end = heads[i + 1]?.index ?? src.length;
    const body = /<span[^>]*body1[^>]*>([\s\S]*?)<\/span>/.exec(src.slice(m.index, end));
    return { headline: strip(m[2]), url: m[1], snippet: body ? strip(body[1]).slice(0, 400) : '' };
  });
}

// The keyword as a word: followed by a space, punctuation, a particle, or one of the brand compounds; not by other
// Hangul (레고랜드 is a theme park, not the toy).
const keywordRe = keyword => new RegExp(`${escapeRe(keyword)}(?=$|[^가-힣]|(?:코리아|그룹|공식|스토어|의|를|을|은|는|이|가|와|과|도|로|등|만)(?:$|[^가-힣]))`, 'g');
export const namesKeyword = (text, keyword) => keywordRe(keyword).test(text);

// The part of an article that is about the keyword: the whole headline when it names the keyword, otherwise only
// the snippet sentences around each mention. A roundup ("11번가 … 27일까지 할인") that lists the keyword once
// must not lend its dates and discounts to it.
export function keywordContext(article, keyword) {
  if (namesKeyword(article.headline, keyword)) return `${article.headline} ${article.snippet}`;
  const s = article.snippet || '', parts = [];
  for (const m of s.matchAll(keywordRe(keyword))) {
    const from = Math.max(0, s.lastIndexOf('.', m.index) + 1), next = s.indexOf('.', m.index);
    parts.push(s.slice(from, next < 0 ? s.length : next + 1));
  }
  return [...new Set(parts)].join(' ');
}

const endOfDayKst = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 14, 59, 59)).toISOString(); // 23:59:59 KST
// End date and top discount from Korean promotion wording, relative to `now` (KST).
export function readPromotion(text, now = Date.now()) {
  const k = new Date(now + 9 * 3600e3), y = k.getUTCFullYear(), mNow = k.getUTCMonth() + 1;
  let m = null, d = null;
  let r = /(\d{1,2})월\s?(\d{1,2})일\s?(?:부터|~|-)\s?(?:(\d{1,2})월\s?)?(\d{1,2})일\s?까지/.exec(text);
  if (r) { m = Number(r[3] ?? r[1]); d = Number(r[4]); }
  if (!r && (r = /(\d{1,2})월\s?(\d{1,2})일\s?(?:까지|마감|종료)/.exec(text))) { m = Number(r[1]); d = Number(r[2]); }
  if (!r && (r = /(내달|다음\s?달)\s?(\d{1,2})일\s?(?:까지|마감|종료)/.exec(text))) { m = mNow === 12 ? 1 : mNow + 1; d = Number(r[2]); }
  if (!r && (r = /(?<![\d월])(\d{1,2})일\s?(?:까지|마감|종료)/.exec(text))) { m = mNow; d = Number(r[1]); }
  const pct = [...text.matchAll(/최대\s?(\d{1,2})\s?%/g)].map(x => Number(x[1]));
  const year = m && m < mNow - 6 ? y + 1 : y;
  return { endsAt: m && d ? endOfDayKst(year, m, d) : null, maxDiscountPct: pct.length ? Math.max(...pct) : null };
}

export async function probeWhyNow(keyword, { fetchImpl = globalThis.fetch, now = Date.now(), ontology = loadHookOntology(), delayMs = 1200 } = {}) {
  const queries = [`${keyword} 할인`, `${keyword} 행사`, `${keyword} 출시`, keyword];
  const seen = new Set(), items = [];
  for (const [i, q] of queries.entries()) {
    if (i && delayMs) await new Promise(r => setTimeout(r, delayMs));
    const res = await fetchImpl(`https://search.naver.com/search.naver?ssc=tab.news.all&query=${encodeURIComponent(q)}&sort=0&pd=2`, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR' } });
    if (res.status !== 200) fail(`NEWS_HTTP_${res.status}`);
    for (const a of parseNewsResults(await res.text())) {
      const context = keywordContext(a, keyword);
      if (seen.has(a.url) || !context) continue;
      seen.add(a.url);
      const kinds = ontology.triggerKinds.filter(t => new RegExp(t.match).test(context)).map(t => t.id);
      // End dates come from the article's keyword context; a discount only from a sentence that names the keyword
      // ("레고 40%·헬로카봇 50%" must not make 레고 50%).
      const sentences = `${a.headline}. ${a.snippet}`.split(/(?<=[.!?…])\s+|·|,\s*/).filter(x => namesKeyword(x, keyword)).join(' ');
      items.push({ ...a, inHeadline: namesKeyword(a.headline, keyword), kinds, endsAt: readPromotion(context, now).endsAt,
        maxDiscountPct: readPromotion(sentences, now).maxDiscountPct });
    }
  }
  const triggers = ontology.triggerKinds.map(t => {
    const hits = items.filter(a => a.kinds.includes(t.id));
    if (!hits.length) return null;
    // A promotion that has ended is history, not a reason for today.
    const live = hits.filter(a => !a.endsAt || Date.parse(a.endsAt) >= now);
    // Headline mentions first, then the nearest end date.
    const dated = live.filter(a => a.endsAt).sort((a, b) => (b.inHeadline - a.inHeadline) || (Date.parse(a.endsAt) - Date.parse(b.endsAt)));
    const best = dated[0] ?? live[0];
    if (!best) return null;
    return { kind: t.id, label: t.label, urgency: t.urgency, count: live.length, headline: best.headline, url: best.url, endsAt: best.endsAt ?? null,
      // The discount of the article the trigger stands on; others may be about other products or events.
      maxDiscountPct: best.maxDiscountPct ?? null, others: dated.slice(1, 3).map(a => ({ headline: a.headline, url: a.url, endsAt: a.endsAt })) };
  }).filter(Boolean);
  return { checkedAt: new Date(now).toISOString(), keyword, method: 'naver news tab, last month', articles: items.length, triggers, items: items.slice(0, 12) };
}

const URGENCY = { deadline: 5, scarcity: 4, risk: 3, freshness: 2, calendar: 1 };
const EFFECT = { deadline_loss: 3, segment_specific: 2, scarcity_discontinue: 2, price_anchor: 1, timing_insight: 1, reader_voice: 1, versus_choice: 1 };
const kstDate = iso => { const d = new Date(Date.parse(iso) + 9 * 3600e3); return { m: d.getUTCMonth() + 1, d: d.getUTCDate(), day: d.toISOString().slice(0, 10) }; };
// The event name inside quotes in a headline ('풍성한 추석 레고 선물', '해피 토이저러스데이').
const quotedName = h => /[‘'"“]([^’'"”]{3,24})[’'"”]/.exec(h || '')?.[1] ?? null;
// 이/가, 은/는 by the last syllable's final consonant (Latin/digits: treat as vowel-final).
const hasBatchim = w => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0; };
const iGa = w => `${w}${hasBatchim(w) ? '이' : '가'}`;
// 로/으로: 으로 after a final consonant other than ㄹ.
const euro = w => { const c = String(w).trim().slice(-1).charCodeAt(0); const f = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0; return `${w}${f && f !== 8 ? '으로' : '로'}`; };

// Hook candidates for one event. `facts` may add evidence found elsewhere (measured prices, owner use).
export function suggestHooks(event, whyNow, { ontology = loadHookOntology(), now = Date.now(), facts = {}, max = 3 } = {}) {
  const kw = event.data?.keyword ?? event.keyword ?? '';
  const category = event.data?.category ?? null;
  const triggers = whyNow?.triggers ?? [];
  const byKind = k => triggers.find(t => t.kind === k);
  const today = kstDate(new Date(now).toISOString()).day;
  const promo = [byKind('promotion'), byKind('price_change'), byKind('policy_change')].find(t => t?.endsAt);
  const scarce = byKind('discontinuation') ?? byKind('stock_shortage');
  // Segments of this category (or any) whose products include the keyword; gift framing applies to any product.
  const segments = ontology.audienceSegments.filter(s => (s.category === category || s.category === '*')
    && (s.keywordPattern ? new RegExp(s.keywordPattern).test(kw) : s.id === 'gift_giver' && s.category === category));
  const out = [];
  const add = (id, title, opening, basis, verify, urgency = 'calendar') => {
    const p = ontology.hookPatterns.find(x => x.id === id);
    if (!p || (p.defaultAllowed === false && !facts[`allow_${id}`])) return;
    out.push({ patternId: id, label: p.label, title, opening, basis: basis.filter(Boolean), verify, score: (URGENCY[urgency] ?? 0) * 10 + (EFFECT[id] ?? 0) });
  };
  if (promo) {
    const end = kstDate(promo.endsAt), isToday = end.day === today;
    const name = quotedName(promo.headline);
    const when = isToday ? '오늘' : `${end.m}월 ${end.d}일`;
    const pct = promo.maxDiscountPct ? `최대 ${promo.maxDiscountPct}%` : '할인';
    add('deadline_loss', `${kw} ${name ? `${name} ` : ''}${when}${isToday ? ' 마감' : '까지'}｜${pct} 중 진짜 싼 세트만 골랐습니다`,
      `${iGa(name ?? `${kw} 할인`)} ${when} 끝납니다. 할인 목록 중 다른 쇼핑몰보다 실제로 싼 것부터 말하면 …`,
      [promo.url, ...(promo.others || []).map(o => o.url)], ['행사 원문에서 기간·대상 품번 확인', '할인가를 다나와·다른 몰과 같은 조건(배송비 포함)으로 비교', '마감 이후엔 발행하지 않음'], 'deadline');
    if (promo.maxDiscountPct) add('price_anchor', `${kw} ${pct} 할인, 할인율 말고 실제 가격으로 비교해 보니`, `할인율이 큰 세트가 꼭 제일 싼 건 아닙니다. 품번별 실제 결제가를 비교하면 …`,
      [promo.url], ['품번별 정가·할인가·다른 몰 최저가 표'], 'deadline');
    add('timing_insight', `${kw} 지금 사도 될까｜${when}${isToday ? ' 마감' : '까지'} 행사 vs 다음 할인`, `다음 할인을 기다릴지는 행사 일정과 가격 흐름으로 정해집니다.`,
      [promo.url, ...(promo.others || []).map(o => o.url)], ['이어지는 다른 행사(유통사별) 일정 확인', '가격 이력(다나와) 확인'], 'deadline');
  }
  if (scarce) add('scarcity_discontinue', `${kw} ${scarce.kind === 'discontinuation' ? '단종 예정' : '품절 임박'} 세트｜지금 사둘 만한 것`, `${scarce.headline}.`, [scarce.url], ['단종·품절 원문(공식·유통사) 확인'], 'scarcity');
  const fresh = byKind('new_release');
  if (fresh && !promo) add('reader_voice', `“${kw} 신제품, 기다렸다 사야 하나?” ${kw} 신상 먼저 볼 것`, `${fresh.headline} — 사기 전에 볼 것만 추리면 …`, [fresh.url], ['출시일·가격 원문'], 'freshness');
  if (segments.length) {
    // Gift framing only when gift demand itself is in the news about the keyword; otherwise the first (age) segment.
    const gift = segments.find(x => x.id === 'gift_giver');
    const s = gift && (byKind('season_gift')?.count ?? 0) >= 2 ? gift : segments.find(x => x.id !== 'gift_giver') ?? segments[0];
    const who = s.titleLabel ?? s.label;
    add('segment_specific', `${who} ${kw} 추천｜${euro(s.fitCheck.replace(/\(.*\)/, '').trim())} 고르는 법`, `${who}${hasBatchim(who) ? '이라면' : '라면'} ${s.fitCheck}부터 보세요.`,
      [], [`적합성 근거: ${s.fitRule}`], s.id === 'gift_giver' ? 'calendar' : undefined);
  }
  add('reader_voice', `“${kw} 요즘 왜 이렇게 찾지?” ${triggers[0] ? `원인은 ${triggers[0].label}, ` : ''}살 때 볼 것`,
    triggers[0] ? `${kw} 검색이 는 데는 ${iGa(triggers[0].label)} 겹쳐 있습니다. 살 때 볼 것부터 말하면 …` : '검색이 는 원인은 아직 확인하지 못했습니다(원인 미확인).', [triggers[0]?.url], ['원인 문장은 원문 기준'], triggers[0]?.urgency);
  // One candidate per pattern (the higher-scored one).
  const ranked = out.sort((a, b) => b.score - a.score).filter((c, i, a) => a.findIndex(x => x.patternId === c.patternId) === i);
  // Feed channels (Shorts, TikTok, Reels, Threads, X) open differently: curiosity and questions lift views there while
  // price and deadline openers fall below titles with no hook (channelPreferences, YouTube 2026-09-27). The facts stay
  // the same; only the first line changes.
  const feed = [
    { patternId: 'curiosity_story', text: promo ? `${kw} 할인율만 보고 사면 안 되는 이유` : `${kw} 살 때 다들 놓치는 한 가지`, verify: ['영상 안에서 이유를 바로 보여줄 것'] },
    { patternId: 'community_question', text: promo ? `${kw} 지금 사도 될까요? ${kstDate(promo.endsAt).m}월 ${kstDate(promo.endsAt).d}일까지라는데` : `${kw} 뭐 사야 할지 모르겠다면?`, verify: [] },
    ...(promo ? [{ patternId: 'regret_aversion', text: `${kw} 할인 때 사고 후회하는 이유`, verify: ['후회 이유는 가격 비교 결과로'] }] : []),
  ].filter(c => ontology.hookPatterns.some(p => p.id === c.patternId));
  return { keyword: kw, feed, trigger: triggers[0] ? { kind: triggers[0].kind, label: triggers[0].label, headline: triggers[0].headline, url: triggers[0].url } : null,
    deadline: promo?.endsAt ?? null, noTrigger: !triggers.length, candidates: ranked.slice(0, max) };
}

// The reader question for the brief, led by the best hook instead of the fixed template.
export function hookQuestion(event, hooks) {
  const kw = hooks?.keyword || event.data?.keyword;
  const top = hooks?.candidates?.[0];
  if (!top || hooks.noTrigger) return null;
  if (top.patternId === 'deadline_loss' || top.patternId === 'price_anchor' || top.patternId === 'timing_insight') {
    const end = kstDate(hooks.deadline);
    return `${kw} 할인이 ${end.m}월 ${end.d}일에 끝나는데, 할인 목록 중 다른 쇼핑몰보다 실제로 싼 건 무엇이고 지금 사는 게 맞나?`;
  }
  if (top.patternId === 'scarcity_discontinue') return `${kw} 중 곧 단종·품절되는 것은 무엇이고 지금 사둘 만한가?`;
  return null;
}

async function main() {
  const keyword = process.argv.find(a => a.startsWith('--probe='))?.slice(8);
  if (!keyword) fail('USAGE: --probe=<keyword>');
  const category = process.argv.find(a => a.startsWith('--category='))?.slice(11) ?? null;
  const whyNow = await probeWhyNow(keyword);
  const hooks = suggestHooks({ kind: 'shopping_trend', data: { keyword, category } }, whyNow);
  console.log(JSON.stringify({ whyNow: { ...whyNow, items: whyNow.items.slice(0, 6) }, hooks, question: hookQuestion({ data: { keyword } }, hooks) }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
