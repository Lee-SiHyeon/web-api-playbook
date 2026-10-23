import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { searchXPosts } from './x-search.mjs';
import { inspectConversation } from './x-conversation.mjs';
import { assessCandidate } from './x-candidates.mjs';
import { safeBotFailure } from './lib/bot-diagnostics.mjs';

export function assessReplyCandidate(post, seed, options = {}) {
  if (post.replyToId !== seed.postId) return { eligible: false, reason: 'not_direct_reply_to_seed' };
  if (post.authorId === seed.authorId || post.author.toLowerCase() === seed.author.toLowerCase()) return { eligible: false, reason: 'seed_author' };
  return assessCandidate(post, { ...options, allowReply: true });
}

export function selectReplySeeds(report, { maxSeeds = 8 } = {}) {
  return report.candidates.flatMap(account => account.evidence.filter(e => !(e.contextCautions || []).length)
    .map(e => ({ authorId: account.authorId, author: account.author, ...e }))).slice(0, maxSeeds);
}

export async function discoverReplyCandidates(seeds, { now = Date.now(), days = 7, maxPages = 2, search = searchXPosts, readConversation = inspectConversation, viaSearch = false } = {}) {
  if (!Array.isArray(seeds) || seeds.length > 10 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw Object.assign(new Error(), { code: 'X_REPLY_CANDIDATES_INPUT' });
  const accounts = new Map(), seen = new Set(), replyIds = new Set(), directReplyIds = new Set(), excluded = {}, searches = [];
  let owner = '', failure = null;
  for (const seed of seeds) {
    if (!/^\d{1,25}$/.test(seed.postId || '') || !/^\d{1,25}$/.test(seed.authorId || '') || !/^[A-Za-z0-9_]{1,15}$/.test(seed.author || '')) throw Object.assign(new Error(), { code: 'X_REPLY_SEED_INVALID' });
    const query = `conversation_id:${seed.postId} filter:replies`;
    try {
      const result = viaSearch ? await search(query, { maxPages, blueOnly: false }) : await readConversation(seed.postId);
      if (!viaSearch) {
        const focal = result.items.find(post => post.id === seed.postId);
        if (!focal || focal.authorId !== seed.authorId) throw Object.assign(new Error(), { code: 'X_REPLY_SEED_READBACK_MISMATCH' });
      }
      if (owner && owner.toLowerCase() !== result.owner?.toLowerCase()) throw Object.assign(new Error(), { code: 'X_REPLY_OWNER_CHANGED' });
      owner = result.owner || owner;
      searches.push({ seedPostId: seed.postId, seedUrl: seed.url, query: viaSearch ? query : null, pages: result.pages, observedCount: result.observedCount,
        source: viaSearch ? 'search_index' : 'tweet_detail', hasNextPage: Boolean(result.nextCursor), stopReason: result.stopReason, receipts: result.receipts });
      for (const post of result.items) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        if (post.replyToId) replyIds.add(post.id);
        if (post.replyToId === seed.postId) directReplyIds.add(post.id);
        const assessment = assessReplyCandidate(post, seed, { now, days, owner });
        if (!assessment.eligible) { excluded[assessment.reason] = (excluded[assessment.reason] || 0) + 1; continue; }
        const account = accounts.get(post.authorId) || { authorId: post.authorId, author: post.author, blueVerified: true, reviewRequired: true, evidence: [] };
        account.evidence.push({ postId: post.id, url: post.url, text: post.text, publishedAt: post.publishedAt, replyToId: post.replyToId,
          seedAuthor: seed.author, seedUrl: seed.url, kind: assessment.kind, matchedPhrase: assessment.matchedPhrase, contextCautions: assessment.contextCautions });
        accounts.set(post.authorId, account);
      }
    } catch (error) {
      failure = { seedPostId: seed.postId, query, code: error.code || 'X_REPLY_SEARCH_FAILED', receipt: error.receipt || null };
      const store = safeBotFailure(error).localStore;
      if (store) failure.detail = store;
      break;
    }
  }
  return { generatedAt: new Date(now).toISOString(), owner, days, status: failure ? 'partial_failure' : 'complete_page_window', failure, seedPosts: seeds,
    searches, observedEntries: seen.size, observedReplies: replyIds.size, directReplies: directReplyIds.size, candidateAccounts: accounts.size, excluded, candidates: [...accounts.values()], fullConversation: false,
    coverage: viaSearch ? 'search_index_direct_replies_in_page_window' : 'direct_replies_in_first_detail_page', executionMode: 'pure_http', writes: 0 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const source = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const report = await discoverReplyCandidates(selectReplySeeds(source));
    const root = path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations', 'x-candidate-discovery');
    await mkdir(root, { recursive: true });
    const output = path.join(root, `replies-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }));
    if (report.failure) process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ code: error.code || 'X_REPLY_CANDIDATES_FAILED', writes: 0 })); process.exitCode = 2; }
}
