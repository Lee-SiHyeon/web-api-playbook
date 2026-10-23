// Marketing-copy advisory lint for quick-fact posts. Warn-only: it never blocks a post.
//   node marketing-copy.mjs --file=posts.txt
// Rules and their sources live in apps/naver-blog-api/research/content-store/marketing-copy-ontology.v1.json (lintRules).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ONTOLOGY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../naver-blog-api/research/content-store/marketing-copy-ontology.v1.json');
export const loadOntology = () => JSON.parse(readFileSync(ONTOLOGY, 'utf8'));

const SLOP = ['혁신적', '획기적', '게임체인저', '최첨단', '패러다임', '시너지', '압도적'];
const BRAND_BANNED = ['역대급', '무조건', '100%', '대박', '미쳤'];
const WEASEL = /(전문가들?(은|이|들은)|업계(에서는|는)|알려져 있|많은 사람들(이|은))/;
const CLOSER = /(도움이 되셨|도움이 되었으면|궁금한 점이 있으시면)/;
const URGENCY = /(오늘만|오늘까지|금일|마감|남은 시간|선착순|한정|마지막 기회|곧 종료|서두르)/;
const DATE = /(\d{1,2}\/\d{1,2}|\d{1,2}월\s*\d{1,2}일|\d{4}[-.]\d{1,2}[-.]\d{1,2})/;
const SUPERLATIVE = /(최저가|최저|1위|최고|역대|최초|유일|가장\s*(싼|저렴))/;
const BASIS = /(기준|중간값|중위|대비|집계|발표|판매처|\d+\s*곳|보다)/;
const FEAR = /(폭락|폭등|사기|경고|위험|충격|난리|망했|위기|패닉)/;
const SO_WHAT = /(하세요|세요|할 수 있어요|받을 수 있어요|가능해요|무료예요|아껴요|싸요|줄어요|늘어요|더 내요|놓쳐요|넘어가세요)/;
const FINANCE = /(주식|종목|코인|ETF|비트코인|국채|채권|펀드|주가)/;
const ADVICE = /(사세요|사라|매수|매도|담으세요|팔아|추천주|유망|오를 것|수익 보장)/;
const AMBIGUOUS = /(체험단|기자단|서포터즈|내돈내산)/;
const FOREIGN_AD = /(#|\[|\()\s*(AD|PR|spon|sponsored)\b/i;
const PRICE_LEAD = /(\d[\d,]*)\s*원/;
const HOOK_LEAD = /(더 내요|싼 표가 떴)/;
const num = s => Number(String(s).replace(/,/g, ''));
const DISCLOSURES = ['쿠팡 파트너스 활동', '쇼핑 커넥트 활동', '여행 커넥트 활동', '마이리얼트립 파트너 활동', '토스쇼핑 쉐어링크 활동'];

export function lintPost(post) {
  const advisories = [];
  const add = (id, severity, message) => advisories.push({ id, severity, message });
  const body = post.body ?? [];
  const reply = post.reply?.body ?? [];
  const lead = body[0] ?? '';
  const all = [...body, ...reply].join('\n');
  const main = body.join('\n');

  if (!/\d/.test(lead)) add('lead_has_number', 'warn', '첫 줄에 숫자가 없어요. 원문 숫자 하나를 첫 줄에 넣으세요.');
  if (!body.some(l => SO_WHAT.test(l))) add('so_what', 'warn', '"그래서" 줄이 없어요. 독자가 할 일이나 얻는 것을 한 줄로 이으세요.');

  const slop = SLOP.filter(w => all.includes(w));
  if (slop.length) add('slop_vocab', 'warn', `빈 수식어: ${slop.join(', ')}`);
  const banned = BRAND_BANNED.filter(w => all.includes(w));
  if (banned.length) add('brand_banned', 'warn', `브랜드 보이스 금지어: ${banned.join(', ')}`);
  if (/—|\s--\s/.test(all)) add('em_dash', 'info', '줄표(—, --)는 AI 문체 징후예요. 마침표나 쉼표로 바꾸세요.');
  if (/[!！]/.test(all)) add('exclamation', 'info', '느낌표를 빼고 사실의 크기로 강조하세요.');
  if (WEASEL.test(all)) add('weasel_attribution', 'warn', '주어 없는 출처("전문가들은", "업계에서는")예요. 실제 출처 이름을 쓰세요.');
  if (CLOSER.test(all)) add('chatbot_closer', 'info', '챗봇식 맺음말이에요. 그래서 줄로 끝내세요.');

  if (URGENCY.test(all) && !DATE.test(all)) add('urgency_without_date', 'warn', '긴급 표현에 날짜가 없어요. 원문의 마감 날짜를 붙이거나 표현을 빼세요.');
  if (SUPERLATIVE.test(main) && !post.reply && !BASIS.test(main)) add('superlative_without_basis', 'warn', '"최저가·1위" 같은 주장에 비교 대상·기준 시각이 없어요. 같은 글에 붙이세요.');
  if (FEAR.test(all) && !(/\d/.test(all) && (DATE.test(all) || (post.links ?? []).length))) add('fear_without_source', 'warn', '공포 자극어에 숫자·날짜·출처가 함께 없어요. 원문 사실로만 쓰세요.');

  if ((post.affiliate ?? []).length) {
    const idx = body.findIndex(l => DISCLOSURES.some(d => l.includes(d)));
    if (idx < 0 || idx > 2) add('disclosure_position', 'warn', '제휴 공시가 본문 첫 부분(3줄 안)에 없어요.');
  }
  if (AMBIGUOUS.test(all)) add('ambiguous_disclosure_terms', 'warn', '체험단·기자단·서포터즈·내돈내산은 공시 문구로 부적절해요.');
  if (FOREIGN_AD.test(all)) add('foreign_abbrev_ad', 'warn', 'AD·PR·spon 같은 외국어 약어 대신 한글 공시("광고", "수수료 지급")를 쓰세요.');
  if (FINANCE.test(all) && ADVICE.test(all)) add('no_investment_advice', 'warn', '금융 소재에 매수·매도로 읽히는 표현이 있어요. 사실과 일정만 쓰세요.');

  if (!HOOK_LEAD.test(lead) && (PRICE_LEAD.test(lead) || (URGENCY.test(lead) && DATE.test(lead)))) add('feed_opener_price_or_deadline', 'info', '첫 줄이 가격·마감으로 열려요. 피드형 채널은 호기심·손실 프레임이 더 강했어요(쇼츠 대리 지표). tensions 참조.');

  const gap = /(\d[\d,]*)\s*원\s*싸/.exec(lead);
  const price = PRICE_LEAD.exec(lead);
  if (gap && price && !/%/.test(lead) && num(price[1]) < 100000) {
    const pct = Math.round(num(gap[1]) / (num(price[1]) + num(gap[1])) * 100);
    add('rule_of_100', 'info', `저가 특가는 %가 더 크게 느껴져요. 다음 판매처 기준 약 ${pct}% 싸다고 기준을 밝혀 쓸 수 있어요.`);
  }
  return advisories;
}

async function main() {
  const file = process.argv.find(a => a.startsWith('--file='))?.slice(7);
  if (!file) throw new Error('MARKETING_COPY_FILE_REQUIRED');
  const { parsePosts } = await import('./quick-fact.mjs');
  const report = parsePosts(readFileSync(path.resolve(file), 'utf8')).map(p => ({ hash: p.hash, lead: p.body[0], advisories: lintPost(p) }));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
