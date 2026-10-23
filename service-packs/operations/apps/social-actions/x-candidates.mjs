import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { searchXPosts } from './x-search.mjs';
import { safeBotFailure } from './lib/bot-diagnostics.mjs';

const DAY = 86400000;
const invitations = [
  { kind: 'follow_invitation', pattern: /(?:맞팔|상호\s*팔로우)[^\n.!?]{0,30}(?:환영|구해|구하|구합|하실|할\s*분|주세요|부탁|받아|받습|가능|해드|해요|하자|해주|해줘|할게|가겠)/i },
  { kind: 'interaction_invitation', pattern: /(?:소통|교류|트친)[^\n.!?]{0,30}(?:환영|구해|구하|구합|하실|할\s*분|주세요|부탁|해요|하자)/i },
  { kind: 'follow_invitation', pattern: /(?:follow\s+(?:me|back)|followback|mutuals?)\s+(?:are\s+)?(?:welcome|please|anyone|everyone)|(?:looking\s+for|let['’]?s\s+(?:be|connect\s+as))[^\n.!?]{0,25}mutuals?/i },
  { kind: 'interaction_invitation', pattern: /(?:drop|leave)\s+(?:a\s+)?comment|let['’]?s\s+connect/i },
  { kind: 'follow_invitation', pattern: /(?:팔로우|팔로워)[^\n.!?]{0,25}(?:해주시면|하면|하시면)[^\n.!?]{0,25}맞팔/i },
  { kind: 'follow_invitation', pattern: /맞팔[^\n.!?]{0,45}댓글[^\n.!?]{0,15}(?:달아|남겨|주세요)/i },
];
const otherPlatform = /인스타|instagram|스레드|threads\.net|threads\.com|틱톡|tiktok|유튜브|youtube/i;
const restrictedAudience = /비계|비공계|비공개\s*계정|성인만|성인\s*[^\n]{0,10}위주|미성년자|미자|장르계|덕질계|팬계|알페스|동담|겹친|同担|코스어|코스프레|지하돌|오시|오타분|트친소/i;
const refusal = /맞팔[^\n.!?]{0,12}(?:안\s*해|안\s*받|안\s*합|거절|금지|사절|싫|하지\s*않)|(?:맞팔|소통|교류|트친)[^\n.!?]{0,8}(?:X|❌)|(?:no|not)\s+(?:follow\s*back|mutuals?)/i;

export function assessCandidate(post, { now = Date.now(), days = 7, owner = '', allowReply = false } = {}) {
  const reject = reason => ({ eligible: false, reason });
  if (!/^\d{1,25}$/.test(post.authorId || '') || !/^[A-Za-z0-9_]{1,15}$/.test(post.author || '')) return reject('invalid_identity');
  if (post.author.toLowerCase() === owner.toLowerCase()) return reject('own_account');
  if (post.blueVerified !== true) return reject('not_blue_verified');
  if (post.protected !== false) return reject('public_status_unconfirmed');
  const published = Date.parse(post.publishedAt);
  if (!Number.isFinite(published) || published > now || now - published > days * DAY) return reject('outside_recent_window');
  if (post.replyToId && !allowReply) return reject('reply_context');
  const text = post.text || '';
  if (otherPlatform.test(text)) return reject('other_platform');
  if (restrictedAudience.test(text)) return reject('restricted_audience');
  if (refusal.test(text)) return reject('declined_interaction');
  if (/맞팔[^\n.!?]{0,20}받아내|선팔[^\n.!?]{0,30}해라|팔로워[^\n.!?]{0,20}(?:늘리는\s*방법|늘리기\s*팁)/i.test(text)) return reject('general_advice');
  // Public invitations are evidence for review, not consent to automated promotions.
  for (const rule of invitations) {
    const match = text.replace(/\s+/g, ' ').match(rule.pattern);
    if (match && (rule.kind !== 'interaction_invitation' || /파딱|블루체크|팔로워|맞팔|blue\s*checks?|verified/i.test(text))) return { eligible: true, kind: rule.kind, matchedPhrase: match[0], reviewRequired: true,
      contextCautions: /부질없|현타|저격|짜치는|뮤트|pointless|useless/i.test(text) ? ['mixed_or_critical_context'] : [] };
  }
  if (allowReply) {
    const match = text.match(/맞팔\s*(?:완료|했|해|부탁|가요|가겠|하자|하실|주세요)|선팔\s*(?:완료|했|해)|팔로우\s*(?:완료|했|해드렸)|(?:i(?:['’]ve|\s+have)?\s+)?followed(?:\s+you)?|following\s+you|follow\s*(?:me|back)|let['’]?s\s+(?:connect|be\s+mutuals)/i);
    if (match) return { eligible: true, kind: 'reply_participation', matchedPhrase: match[0], reviewRequired: true, contextCautions: [] };
  }
  return reject('no_explicit_invitation');
}

export function discoveryQueries(now = Date.now(), days = 7) {
  const since = new Date(now - days * DAY).toISOString().slice(0, 10);
  return [
    `맞팔 -filter:replies since:${since}`,
    `(블루체크 OR 파딱) (맞팔 OR 소통 OR 팔로워) -filter:replies`,
    `(followback OR mutuals) (verified OR blue) -filter:replies`,
  ];
}

export async function discoverCandidates({ now = Date.now(), days = 7, maxPages = 3, search = searchXPosts } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw Object.assign(new Error(), { code: 'X_CANDIDATES_INPUT' });
  const posts = new Map(), searches = [];
  let owner = '', failure = null;
  for (const query of discoveryQueries(now, days)) {
    try {
      const result = await search(query, { maxPages, blueOnly: false });
      if (owner && owner.toLowerCase() !== result.owner?.toLowerCase()) throw Object.assign(new Error(), { code: 'X_CANDIDATES_OWNER_CHANGED' });
      owner = result.owner || owner;
      for (const post of result.items) posts.set(post.id, post);
      searches.push({ query, pages: result.pages, observedCount: result.observedCount, hasNextPage: Boolean(result.nextCursor), stopReason: result.stopReason, receipts: result.receipts });
    } catch (error) {
      failure = { query, code: error.code || 'X_CANDIDATES_SEARCH_FAILED', receipt: error.receipt || null };
      const store = safeBotFailure(error).localStore;
      if (store) failure.detail = store;
      break; // Authentication failures and throttling never trigger another query or retry.
    }
  }
  const excluded = {}, accounts = new Map();
  for (const post of posts.values()) {
    const result = assessCandidate(post, { now, days, owner });
    if (!result.eligible) { excluded[result.reason] = (excluded[result.reason] || 0) + 1; continue; }
    const candidate = accounts.get(post.authorId) || { authorId: post.authorId, author: post.author, blueVerified: true, reviewRequired: true, evidence: [] };
    candidate.evidence.push({ postId: post.id, url: post.url, text: post.text, publishedAt: post.publishedAt, kind: result.kind, matchedPhrase: result.matchedPhrase, contextCautions: result.contextCautions, quotedPostId: post.quotedPostId || null });
    accounts.set(post.authorId, candidate);
  }
  const candidates = [...accounts.values()].map(account => ({ ...account, evidence: account.evidence.sort((a,b) => Date.parse(b.publishedAt)-Date.parse(a.publishedAt)) }))
    .sort((a,b) => Date.parse(b.evidence[0].publishedAt)-Date.parse(a.evidence[0].publishedAt));
  return { generatedAt: new Date(now).toISOString(), days, owner, status: failure ? 'partial_failure' : 'complete_page_window', failure,
    searches, observedPosts: posts.size, candidateAccounts: candidates.length, excluded, candidates, fullSearch: false, executionMode: 'pure_http', writes: 0 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = await discoverCandidates();
    const root = path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations', 'x-candidate-discovery');
    await mkdir(root, { recursive: true });
    const output = path.join(root, `${report.generatedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }));
    if (report.failure) process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ code: error.code || 'X_CANDIDATES_FAILED', writes: 0 })); process.exitCode = 2; }
}
