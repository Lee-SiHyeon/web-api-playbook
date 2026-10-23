// Leader statements → Korea-related issue kinds → Japan/China official reactions (world-leaders-ontology.v1.json).
// owner 2026-09-30: "트럼프 … 한국에 대한 이슈의 일본 중국 각각 반응". Public, anonymous reads only:
//   Trump posts   https://www.trumpstruth.org/feed (RSS mirror of Truth Social; items carry truth:originalUrl)
//   Executive orders  Federal Register API (presidential_document_type=executive_order)
//   Japan         MOFA press conferences https://www.mofa.go.jp/press/kaiken/index.html (English pages, <p> transcript;
//                 the newest conference says "The text will be coming soon." until the transcript is posted)
//   China         MFA spokesperson regular press conferences https://www.mfa.gov.cn/eng/xw/fyrbt/ (English, <p> Q&A)
// A reaction is a paragraph (plus the answer that follows a question) whose text matches the same issue kind as a
// statement; it is shown with its speaker, date and URL. No match → "공식 반응 미확인". Nothing is inferred.
// Usage: node leader-statements.mjs [--hours=96] [--json] [--out=<file>]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const loadLeadersOntology = (file = path.join(HERE, 'world-leaders-ontology.v1.json')) => JSON.parse(readFileSync(file, 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const decode = s => String(s ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, '’').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const jsDisabled = /uses JavaScript|text will be coming soon|Copyright/i;

const CHECKED = ['body_verified', 'title_verified', 'agent_only'];
const CONFIDENCE = ['primary', 'institute', 'wire', 'secondary'];
const USE_LEVEL = { body_verified: 'quote_ok', title_verified: 'title_only', agent_only: 'reverify_first' };

// Non-assumption rules for the given issue kinds, each with its source URLs and how far it may be quoted:
// quote_ok (body checked), title_only (cite the headline only), reverify_first (only a subagent report; reopen the page first).
export function evidenceFor(ontology, kindIds) {
  const ids = new Set(kindIds);
  const url = id => ontology.sources?.[id]?.url ?? null;
  return (ontology.marketImpactRules ?? []).filter(r => r.status !== 'assumption' && ids.has(r.issueKind)).map(r => {
    const src = ontology.sources?.[r.sourceId] ?? {};
    return {
      id: r.id, issueKind: r.issueKind, status: r.status, statement: r.statement, numbers: r.numbers ?? [], caveat: r.caveat ?? null, postUse: r.postUse ?? null,
      sourceUrl: url(r.sourceId), alsoSourceUrls: (r.alsoSourceIds ?? []).map(url).filter(Boolean),
      confidence: src.confidence ?? null, checked: src.checked ?? null, useLevel: USE_LEVEL[src.checked] ?? (r.status === 'observed' ? 'quote_ok' : 'unknown'),
    };
  });
}

// Dated hooks (rules with watch.date), with days left counted from today's KST date. A passed date stays listed as 'passed'.
export function upcomingWatches(ontology, now = Date.now()) {
  const today = Date.parse(new Date(now + 9 * 3600e3).toISOString().slice(0, 10));
  return (ontology.marketImpactRules ?? []).filter(r => r.watch?.date).map(r => {
    const daysLeft = Math.round((Date.parse(r.watch.date) - today) / 864e5);
    return { ruleId: r.id, date: r.watch.date, daysLeft, state: daysLeft >= 0 ? 'upcoming' : 'passed', what: r.watch.what, caveat: r.caveat ?? null, sourceUrl: ontology.sources?.[r.sourceId]?.url ?? null };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function validateLeadersOntology(o) {
  const errors = [];
  if (o.schemaVersion !== 1 || !o.id) errors.push('HEADER');
  const src = new Set(Object.keys(o.sources ?? {}));
  for (const [k, v] of Object.entries(o.sources ?? {})) if (!/^https?:\/\//.test(v.url ?? '')) errors.push(`SOURCE_URL:${k}`);
  for (const k of o.issueKinds ?? []) {
    if (!k.id || !Array.isArray(k.patterns) || !k.patterns.length) errors.push(`ISSUE:${k.id}`);
    for (const p of k.patterns ?? []) for (const re of p) { try { new RegExp(re, 'i'); } catch { errors.push(`REGEX:${k.id}:${re}`); } }
    if (!['assumption', 'observed', 'sourced'].includes(k.basis)) errors.push(`BASIS:${k.id}`);
    if (k.basis !== 'assumption' && !src.has(k.sourceId)) errors.push(`SOURCE_MISSING:${k.id}`);
  }
  for (const [k, v] of Object.entries(o.sources ?? {})) {
    if (v.checked !== undefined && !CHECKED.includes(v.checked)) errors.push(`SOURCE_CHECKED:${k}`);
    if (v.confidence !== undefined && !CONFIDENCE.includes(v.confidence)) errors.push(`SOURCE_CONFIDENCE:${k}`);
  }
  const kindIds = new Set((o.issueKinds ?? []).map(k => k.id));
  for (const r of o.marketImpactRules ?? []) {
    if (!['sourced', 'observed', 'assumption'].includes(r.status)) errors.push(`RULE_STATUS:${r.id}`);
    if (r.status !== 'assumption' && !src.has(r.sourceId)) errors.push(`RULE_SOURCE:${r.id}`);
    if (r.status === 'assumption' && !r.measurementPlan) errors.push(`RULE_PLAN:${r.id}`);
    if (r.issueKind !== '*' && !kindIds.has(r.issueKind)) errors.push(`RULE_KIND:${r.id}`);
    for (const s of r.alsoSourceIds ?? []) if (!src.has(s)) errors.push(`RULE_ALSO_SOURCE:${r.id}:${s}`);
    const level = o.sources?.[r.sourceId]?.checked;
    if (level === 'agent_only' && r.postUse !== 'reverify_first') errors.push(`AGENT_ONLY_NEEDS_REVERIFY:${r.id}`);
    if (level === 'title_verified' && (r.numbers ?? []).length) errors.push(`TITLE_ONLY_NUMBERS:${r.id}`);
    if (r.watch && !/^\d{4}-\d{2}-\d{2}$/.test(r.watch.date ?? '')) errors.push(`RULE_WATCH:${r.id}`);
  }
  for (const [k, c] of Object.entries(o.statementChannels ?? {})) if (!/^https?:\/\//.test(c.url ?? '')) errors.push(`CHANNEL_URL:${k}`);
  for (const [k, c] of Object.entries(o.reactionChannels ?? {})) if (!/^https?:\/\//.test(c.url ?? '')) errors.push(`REACTION_URL:${k}`);
  return errors;
}

const KOREA = /\b(Republic of Korea|ROK|South Korea|Korea|Korean)\b/;
export const mentionsKorea = text => KOREA.test(String(text ?? ''));

// mode 'reaction' uses reactionPatterns when a kind has them: on a Chinese or Japanese ministry page the words
// "China"/"Japan" appear in almost every paragraph, so the statement patterns would match everything.
export function classifyIssues(text, ontology, mode = 'statement') {
  const t = String(text ?? '');
  const out = [];
  for (const kind of ontology.issueKinds) {
    for (const pattern of (mode === 'reaction' && kind.reactionPatterns) || kind.patterns) {
      if (pattern.every(re => new RegExp(re, 'i').test(t))) { out.push({ id: kind.id, label: kind.label, matched: pattern.join(' + ') }); break; }
    }
  }
  return out;
}

export function parseTruthFeed(xml) {
  return String(xml).split('<item>').slice(1).map(item => {
    const pick = tag => (item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) ?? [])[1];
    const text = decode(pick('description'));
    return { id: decode(pick('truth:originalId')) || decode(pick('guid')), publishedAt: new Date(decode(pick('pubDate'))).toISOString(), text, mirrorUrl: decode(pick('link')), originalUrl: decode(pick('truth:originalUrl')) || null };
  }).filter(s => s.text && !Number.isNaN(Date.parse(s.publishedAt)));
}

export function parseExecutiveOrders(json) {
  return (json?.results ?? []).map(d => ({ title: d.title, number: d.executive_order_number ?? null, signedAt: d.signing_date ?? null, publishedAt: d.publication_date ?? null, url: d.html_url ?? null }));
}

export function paragraphs(html) {
  const clean = String(html).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  return [...clean.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => decode(m[1])).filter(p => p && !jsDisabled.test(p));
}

export function parseChinaList(html, base = 'https://www.mfa.gov.cn/eng/xw/fyrbt/') {
  const seen = new Set();
  return [...String(html).matchAll(/<a[^>]+href="(\.\/lxjzh\/\d{6}\/t(\d{8})_\d+\.html)"[^>]*>([^<]+)</g)].flatMap(m => {
    const url = new URL(m[1], base).href;
    if (seen.has(url)) return [];
    seen.add(url);
    return [{ url, date: `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`, title: decode(m[3]) }];
  });
}

export function parseJapanList(html, base = 'https://www.mofa.go.jp') {
  const seen = new Set();
  return [...String(html).matchAll(/<a[^>]+href="(\/press\/kaiken\/kaikenwe_000001_\d+\.html)"[^>]*>([^<]*\([A-Z][a-z]+ \d{1,2}, \d{4}[^<)]*\)[^<]*)</g)].flatMap(m => {
    const url = new URL(m[1], base).href;
    if (seen.has(url)) return [];
    seen.add(url);
    const d = decode(m[2]).match(/\(([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
    const date = d && MONTHS[d[1]] ? `${d[3]}-${String(MONTHS[d[1]]).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}` : null;
    return date ? [{ url, date, title: decode(m[2]) }] : [];
  });
}

// Paragraphs whose text matches an issue kind. A question paragraph ("Reuters: …") is paired with the next paragraph
// (the spokesperson's or minister's answer) so the reaction is the answer, not only the question.
const ANSWERER = /^(Guo Jiakun|Lin Jian|Mao Ning|Foreign Minister [A-Z]+[^:]{0,30}|Press Secretary [^:]{0,40}|Deputy Press Secretary [^:]{0,40}):/i;
export function findReactions(paras, ontology, { country, date, url, title }) {
  const out = [];
  const used = new Set();
  paras.forEach((p, i) => {
    if (used.has(i)) return;
    const question = !ANSWERER.test(p) && /^[^:]{2,60}:/.test(p);
    const answerIdx = question && paras[i + 1] && ANSWERER.test(paras[i + 1]) ? i + 1 : null;
    const answer = answerIdx === null ? null : paras[answerIdx];
    const kinds = new Map([...classifyIssues(p, ontology, 'reaction'), ...(answer ? classifyIssues(answer, ontology, 'reaction') : [])].map(k => [k.id, k]));
    const korea = mentionsKorea(p) || mentionsKorea(answer);
    if (!kinds.size && !korea) return;
    if (answerIdx !== null) used.add(answerIdx);
    out.push({ country, date, sourceUrl: url, sourceTitle: title, paragraph: p.slice(0, 700), answer: answer ? answer.slice(0, 900) : null, issueKinds: [...kinds.values()], mentionsKorea: korea });
  });
  return out;
}

const fetchText = async (fetchImpl, url) => { const r = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'en,ko;q=0.8' }, signal: AbortSignal.timeout(25000) }); if (!r.ok) throw Object.assign(new Error(`HTTP_${r.status}`), { code: `HTTP_${r.status}`, url }); return Buffer.from(await r.arrayBuffer()).toString('utf8'); };

export async function collectLeaderBrief({ fetchImpl = fetch, now = Date.now(), hours = 96, ontology = loadLeadersOntology(), maxPages = 4 } = {}) {
  const errors = [];
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { errors.push(`${label}:${e.code ?? e.message}`); return null; } };
  const cut = now - hours * 3600e3;
  const feed = await safe('trump_feed', () => fetchText(fetchImpl, ontology.statementChannels.trump_truth_mirror.url));
  const statements = (feed ? parseTruthFeed(feed) : []).filter(s => Date.parse(s.publishedAt) >= cut)
    .map(s => ({ leaderId: 'trump', ...s, issueKinds: classifyIssues(s.text, ontology) }));
  const eoJson = await safe('federal_register', async () => JSON.parse(await fetchText(fetchImpl, ontology.statementChannels.federal_register_eo.url)));
  const executiveOrders = parseExecutiveOrders(eoJson).filter(e => !e.signedAt || Date.parse(e.signedAt) >= cut - 7 * 864e5);

  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const since = day(cut - 864e5);
  const [cnList, jpList] = await Promise.all([
    safe('cn_list', async () => parseChinaList(await fetchText(fetchImpl, ontology.reactionChannels.cn_mfa_spokesperson.url))),
    safe('jp_list', async () => parseJapanList(await fetchText(fetchImpl, ontology.reactionChannels.jp_mofa_press.url))),
  ]);
  const reactions = [], pending = [];
  for (const [country, list] of [['cn', cnList ?? []], ['jp', jpList ?? []]]) {
    for (const page of list.filter(p => p.date >= since).slice(0, maxPages)) {
      const html = await safe(`${country}_page`, () => fetchText(fetchImpl, page.url));
      if (!html) continue;
      const paras = paragraphs(html);
      if (!paras.length) { pending.push({ country, url: page.url, date: page.date, note: '본문 미게시(transcript pending)' }); continue; }
      reactions.push(...findReactions(paras, ontology, { country, ...page }));
    }
  }
  const linked = statements.filter(s => s.issueKinds.length || mentionsKorea(s.text)).map(s => {
    const ids = new Set(s.issueKinds.map(k => k.id));
    const korea = mentionsKorea(s.text);
    const rel = c => reactions.filter(r => r.country === c && r.date >= s.publishedAt.slice(0, 10) && (r.issueKinds.some(k => ids.has(k.id)) || (korea && r.mentionsKorea)));
    return { statement: { text: s.text.slice(0, 500), publishedAt: s.publishedAt, originalUrl: s.originalUrl, mirrorUrl: s.mirrorUrl, issueKinds: s.issueKinds.map(k => k.id), mentionsKorea: korea }, jp: rel('jp'), cn: rel('cn'), evidence: evidenceFor(ontology, ids) };
  });
  return {
    generatedAt: new Date(now).toISOString(), windowHours: hours, statementCount: statements.length,
    linked, watches: upcomingWatches(ontology, now), gaps: (ontology.marketImpactRules ?? []).flatMap(r => r.gaps ?? []), koreaMentionedByJpCn: reactions.filter(r => r.mentionsKorea),
    unlinkedReactions: reactions.filter(r => !linked.some(l => l.jp.includes(r) || l.cn.includes(r))),
    executiveOrders, pendingTranscripts: pending, errors, policy: ontology.policy.slice(0, 4),
  };
}

export function renderLeaderBrief(b) {
  const lines = [`발언 ${b.statementCount}건(최근 ${b.windowHours}h), 이슈 후보 ${b.linked.length}건 (한국 직접 언급 ${b.linked.filter(l => l.statement.mentionsKorea).length}건)`];
  for (const l of b.linked) {
    lines.push(`- [${l.statement.publishedAt.slice(0, 16)}Z] ${l.statement.mentionsKorea ? '한국언급 ' : ''}${l.statement.issueKinds.join(',')} — ${l.statement.text.slice(0, 160)} (${l.statement.originalUrl ?? l.statement.mirrorUrl})`);
    lines.push(`    일본: ${l.jp.length ? l.jp.map(r => `${r.date} ${(r.answer ?? r.paragraph).slice(0, 140)} (${r.sourceUrl})`).join(' | ') : '공식 반응 미확인'}`);
    lines.push(`    중국: ${l.cn.length ? l.cn.map(r => `${r.date} ${(r.answer ?? r.paragraph).slice(0, 140)} (${r.sourceUrl})`).join(' | ') : '공식 반응 미확인'}`);
    const order = { quote_ok: 0, title_only: 1, reverify_first: 2, unknown: 3 };
    for (const e of [...(l.evidence ?? [])].sort((a, b) => order[a.useLevel] - order[b.useLevel]).slice(0, 3)) {
      lines.push(`    참고[${e.useLevel}/${e.confidence ?? '?'}] ${e.id}: ${e.statement.slice(0, 110)} (${e.sourceUrl})`);
    }
    if (!(l.evidence ?? []).length) lines.push('    참고: 이 이슈 종류에 검증된 시장 영향 자료 없음(가정만 있음)');
    else lines.push('    ※ 참고는 같은 이슈 종류의 검증 자료다. 이 발언과 직접 관련되는지는 글 쓸 때 판단한다.');
  }
  for (const w of b.watches ?? []) lines.push(`기한 ${w.date} ${w.state === 'upcoming' ? `D-${w.daysLeft}` : `${-w.daysLeft}일 지남 — 연장·변경 재확인`}: ${w.what} — 문서상 기한, 연장 여부 미확인 (${w.sourceUrl})`);
  if (b.koreaMentionedByJpCn.length) lines.push(`일·중 공식 채널의 한국 언급 ${b.koreaMentionedByJpCn.length}건: ${b.koreaMentionedByJpCn.slice(0, 4).map(r => `${r.country} ${r.date} ${(r.answer ?? r.paragraph).slice(0, 120)} (${r.sourceUrl})`).join(' | ')}`);
  if (b.unlinkedReactions.length) lines.push(`발언과 연결되지 않은 일·중 공식 문단 ${b.unlinkedReactions.length}건: ${b.unlinkedReactions.slice(0, 3).map(r => `${r.country} ${r.date} ${r.issueKinds.map(k => k.id).join(',')}`).join(' / ')}`);
  if (b.executiveOrders.length) lines.push(`행정명령: ${b.executiveOrders.slice(0, 3).map(e => `EO ${e.number ?? '?'} ${e.title} (${e.signedAt ?? e.publishedAt})`).join(' / ')}`);
  if (b.pendingTranscripts.length) lines.push(`본문 미게시: ${b.pendingTranscripts.map(p => `${p.country} ${p.date}`).join(', ')}`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) ?? '').split('=')[1];
  const errs = validateLeadersOntology(loadLeadersOntology());
  if (errs.length) { console.error('ONTOLOGY_INVALID', errs.join(', ')); process.exit(2); }
  const b = await collectLeaderBrief({ hours: Number(arg('hours') ?? 96) });
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify(b, null, 2));
  console.log(process.argv.includes('--json') ? JSON.stringify(b, null, 2) : renderLeaderBrief(b));
  if (b.errors.length) console.error('errors:', b.errors.join(', '));
}
