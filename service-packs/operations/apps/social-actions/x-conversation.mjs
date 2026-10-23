import { readFile } from 'node:fs/promises';
import { withXReadContext } from './providers/x.mjs';
import { decodeXSearch } from './x-search.mjs';

const route = '/i/api/graphql/blErEeZkos5TDrWmrCp7cw/TweetDetail';
export function decodeConversation(data) {
  const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions;
  if (!Array.isArray(instructions) || data.errors?.length) throw Object.assign(new Error(), { code: 'X_CONVERSATION_SCHEMA' });
  return decodeXSearch({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } });
}
export async function inspectConversation(id, { withContext = withXReadContext } = {}) {
  if (!/^\d{1,25}$/.test(id || '')) throw Object.assign(new Error(), { code: 'X_CONVERSATION_INPUT' });
  const contract = JSON.parse(await readFile(new URL('./contracts/x-followers.json', import.meta.url), 'utf8'));
  return withContext(async context => {
    const url = new URL(route, 'https://x.com');
    url.searchParams.set('variables', JSON.stringify({ focalTweetId: id, with_rux_injections: false, rankingMode: 'Relevance', includePromotedContent: true, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true }));
    url.searchParams.set('features', JSON.stringify(contract.features));
    url.searchParams.set('fieldToggles', JSON.stringify({ withPayments: false, withArticleRichContentState: true, withArticlePlainText: false, withArticleSummaryText: true, withArticleVoiceOver: true, withGrokAnalyze: false, withDisallowedReplyControls: false }));
    const response = await context.request('GET', route, url.href);
    const receipt = { operation: 'TweetDetail', httpStatus: response.status, browserUsed: false, mime:(response.headers['content-type']||'').split(';')[0],
      rateLimitReset: /^\d+$/.test(response.headers['x-rate-limit-reset'] || '') ? Number(response.headers['x-rate-limit-reset']) : null };
    receipt.bodyBytes=Buffer.byteLength(response.raw||'');
    if (response.status !== 200) throw Object.assign(new Error(), { code: 'X_CONVERSATION_REJECTED', receipt });
    let data; try { data = JSON.parse(response.raw); } catch { throw Object.assign(new Error(), { code: 'X_CONVERSATION_SCHEMA', receipt }); }
    let decoded;
    try { decoded = decodeConversation(data); } catch (error) {
      error.receipt = { ...receipt, dataKeys: Object.keys(data.data || {}), errors: (data.errors || []).map(e => ({ code: e.code, message: typeof e.message === 'string' ? e.message.slice(0,180) : null })),
        conversationKeys: Object.keys(data.data?.threaded_conversation_with_injections_v2 || {}) };
      throw error;
    }
    return { owner: context.ownerHandle, items: decoded.items, observedCount: decoded.items.length, pages: 1, nextCursor: decoded.cursor,
      stopReason: 'first_detail_page', receipts: [receipt], fullConversation: false, executionMode: 'pure_http', writes: 0 };
  });
}
