import { withXReadContext } from './providers/x.mjs';
import { assertReadCapacity } from './x-read-budget.mjs';
import { decodeXTimeline } from '../naver-blog-api/research/content-store/x-xhr.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'lifehack__ailab';
const OPERATION = 'UserTweetsAndReplies';
const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, ...(receipt ? { receipt } : {}) }); };
const validId = value => /^\d{1,25}$/.test(String(value ?? ''));
const validQueryId = value => /^[A-Za-z0-9_-]{1,128}$/.test(value || '');
// Live 2026-10-02: the replies tab's sortIndex is a per-response sequence (consecutive integers counting
// down from a request-time base), not a post time, so it proves order only. Entry time = newest owner item.

// Contract evidence: apps/social-actions/contracts/x.json records the public
// first-party bundle main.941731a8bedadd89a.js (SHA-256
// ec1a1036398f66def72f097bc843a5a3dedb3db9281b147b2db85610108f67fe,
// captured 2026-09-28). In that bundle the exact regex
// /queryId:"([A-Za-z0-9_-]+)",operationName:"UserTweetsAndReplies",operationType:"query",metadata:\{featureSwitches:(\[[^\]]*\]),fieldToggles:(\[[^\]]*\])/ matched queryId
// wI-ubAWfScnG6odLK4XgCg. The profile-timeline call site selects this reader
// for the `with_replies` tab and builds userId/count/optional cursor; its
// request builder supplies includePromotedContent:true, withCommunity from
// c9s_enabled, withQuickPromoteEligibilityTweetFields:true, and withVoice.
// Its field-toggle builder sends withArticlePlainText:false and withPayments;
// omitting isPaymentsEnrolled makes withPayments false. Runtime operation
// metadata is refreshed from the first-party bundle by providers/x.mjs.

export async function readOwnerRepliesBefore({ cutoffAt, maxPages = 100 } = {}, {
  withContext = withXReadContext,
  readCapacity = assertReadCapacity,
  onPageSummary = null,
} = {}) {
  const cutoff = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoff) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) fail('X_OWNER_REPLIES_INPUT');
  return withContext(async context => {
    const owner = String(context.ownerHandle || '').toLowerCase();
    if (owner !== OWNER) fail('X_OWNER_REPLIES_OWNER_MISMATCH');
    const contract = context.ownerRepliesContract;
    if (!contract || contract.operation !== OPERATION || !validQueryId(contract.queryId) || contract.missing?.length
      || !contract.features || Object.values(contract.features).some(value => typeof value !== 'boolean')) {
      fail('X_OWNER_REPLIES_CONTRACT_UNAVAILABLE');
    }
    const profile = await context.lookupUser(context.ownerHandle);
    if (!validId(profile?.userId) || profile.handle?.toLowerCase() !== OWNER || profile.protected === true) {
      fail('X_OWNER_REPLIES_IDENTITY_UNVERIFIED');
    }

    const prefix = context.apiTransitionEnabled ? '/i/api' : '';
    const origin = context.apiTransitionEnabled ? 'https://x.com' : 'https://api.x.com';
    const route = `${prefix}/graphql/${contract.queryId}/${OPERATION}`;
    const items = [], seenIds = new Map(), seenCursors = new Set();
    let cursor, pagesRead = 0, rangeStartMs = null, rangeEndMs = null;
    let previousSortIndex = null, previousEntryTime = Infinity, reachedEntryCutoff = false;
    let reachedCutoff = false, endReached = false, ordered = true, cursorInvalid = false;
    let ownerItemCount = 0;

    while (pagesRead < maxPages && !reachedCutoff && !endReached && !cursorInvalid) {
      await readCapacity(owner, OPERATION, { needed: 1 });
      const variables = {
        userId: profile.userId,
        count: 20,
        ...(cursor ? { cursor } : {}),
        includePromotedContent: true,
        withCommunity: context.timelineWithCommunity === true,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: context.timelineWithVoice === true,
      };
      const url = new URL(route, origin);
      url.searchParams.set('variables', JSON.stringify(variables));
      url.searchParams.set('features', JSON.stringify(contract.features));
      url.searchParams.set('fieldToggles', JSON.stringify({ withPayments: false, withArticlePlainText: false }));
      const response = await context.request('GET', route, url.href);
      pagesRead++;
      const mime = (response.headers?.['content-type'] || '').split(';')[0];
      const receipt = { operation: OPERATION, httpStatus: response.status, mime, pagesRead, browserUsed: false, executionMode: 'pure_http' };
      if (response.status !== 200 || !mime.includes('json')) fail('X_OWNER_REPLIES_READ_REJECTED', receipt);
      let payload;
      try { payload = JSON.parse(response.raw); } catch { fail('X_OWNER_REPLIES_SCHEMA', receipt); }
      if (payload.errors?.length) fail('X_OWNER_REPLIES_SCHEMA', receipt);
      const instructions = payload.data?.user?.result?.timeline?.timeline?.instructions
        ?? payload.data?.user?.result?.timeline_v2?.timeline?.instructions;
      let decoded;
      try { decoded = decodeXTimeline(instructions, context.ownerHandle); } catch { fail('X_OWNER_REPLIES_SCHEMA', receipt); }
      if (!Array.isArray(decoded.timelineEntries)) fail('X_OWNER_REPLIES_SCHEMA', receipt);
      if (decoded.invalidCursor === true) { ordered = false; cursorInvalid = true; }
      const entryKinds = {}, pageIndices = [];
      let pageOwnerItemCount = 0;
      for (const entry of decoded.timelineEntries) {
        const kind = ['tweet', 'profile-conversation', 'cursor', 'pin', 'other'].includes(entry.kind) ? entry.kind : 'other';
        entryKinds[kind] = (entryKinds[kind] || 0) + 1;
        if (entry.isPinned === true || kind === 'pin' || entry.isCursor === true || kind === 'cursor') continue;
        const index = entry.sortIndex && /^\d{1,20}$/.test(entry.sortIndex) ? BigInt(entry.sortIndex) : null;
        if (index == null) ordered = false;
        else {
          pageIndices.push(index);
          if (previousSortIndex != null && index >= previousSortIndex) ordered = false;
          previousSortIndex = index;
        }
        const ownerRows = Array.isArray(entry.ownerItems) ? entry.ownerItems : [];
        const entryTimes = ownerRows.map(item => Date.parse(item.publishedAt || '')).filter(Number.isFinite);
        if (entryTimes.length) {
          const entryTime = Math.max(...entryTimes);
          if (entryTime > previousEntryTime) ordered = false;
          previousEntryTime = entryTime;
          if (entryTime <= cutoff) reachedEntryCutoff = true;
        }
        const malformedCount = Number.isInteger(entry.malformedOwnerItemCount) && entry.malformedOwnerItemCount >= 0
          ? entry.malformedOwnerItemCount : 0;
        pageOwnerItemCount += ownerRows.length + malformedCount;
        ownerItemCount += ownerRows.length + malformedCount;
        if (malformedCount) ordered = false;
        for (const item of ownerRows) {
          const created = Date.parse(item.publishedAt || '');
          if (!validId(item.id) || !validId(item.publisherId) || item.publisherId !== profile.userId
            || item.publisher?.toLowerCase() !== OWNER || typeof item.text !== 'string' || !item.text.trim() || !Number.isFinite(created)) {
            ordered = false;
            continue;
          }
          rangeStartMs = rangeStartMs == null ? created : Math.max(rangeStartMs, created);
          rangeEndMs = rangeEndMs == null ? created : Math.min(rangeEndMs, created);
          const normalized = { id: item.id, authorId: item.publisherId, author: item.publisher,
            replyToId: item.replyToPostId || null, text: item.text, createdAt: new Date(created).toISOString() };
          const prior = seenIds.get(item.id);
          if (prior) {
            if (prior.authorId !== normalized.authorId || prior.replyToId !== normalized.replyToId
              || prior.text !== normalized.text || prior.createdAt !== normalized.createdAt) ordered = false;
            continue;
          }
          seenIds.set(item.id, normalized);
          items.push(normalized);
        }
      }
      const rangeEndAt = rangeEndMs == null ? null : new Date(rangeEndMs).toISOString();
      const ownerDateReachedCutoff = reachedEntryCutoff;
      const next = decoded.nextCursor;
      if (next) {
        if (typeof next !== 'string' || next.length > 4096 || seenCursors.has(next)) {
          ordered = false; cursorInvalid = true;
        } else {
          seenCursors.add(next);
          cursor = next;
        }
      } else if (!cursorInvalid) endReached = true;
      reachedCutoff = ordered && ownerDateReachedCutoff;
      if (typeof onPageSummary === 'function') {
        const newest = pageIndices.reduce((best, value) => best == null || value > best ? value : best, null);
        const oldest = pageIndices.reduce((best, value) => best == null || value < best ? value : best, null);
        await onPageSummary({
          type: 'page', page: pagesRead, entryKinds,
          sortIndexRange: { newest: newest == null ? null : newest.toString(), oldest: oldest == null ? null : oldest.toString() },
          ownerItemCount: pageOwnerItemCount,
          coverage: { ordered, entryTimeReachedCutoff: reachedEntryCutoff,
            ownerItemReachedCutoff: ownerDateReachedCutoff, reachedCutoff, endReached,
            complete: ordered && Boolean(rangeEndAt) && (reachedCutoff || endReached) },
        });
      }
    }

    const rangeStartAt = rangeStartMs == null ? null : new Date(rangeStartMs).toISOString();
    const rangeEndAt = rangeEndMs == null ? null : new Date(rangeEndMs).toISOString();
    const coverageComplete = ordered && Boolean(rangeStartAt && rangeEndAt) && (reachedCutoff || endReached);
    return {
      items,
      ownerId: profile.userId,
      owner,
      pagesRead,
      rangeStartAt,
      rangeEndAt,
      cutoffAt: new Date(cutoff).toISOString(),
      reachedCutoff,
      endReached,
      coverageComplete,
      ownerItemCount,
      writes: 0,
    };
  });
}

async function runProbe(args) {
  let cutoffAt = null, maxPages = 100;
  for (const arg of args) {
    if (arg.startsWith('--cutoff=')) cutoffAt = arg.slice('--cutoff='.length);
    else if (arg.startsWith('--max-pages=')) maxPages = Number(arg.slice('--max-pages='.length));
    else fail('X_OWNER_REPLIES_CLI_USAGE');
  }
  if (!cutoffAt) fail('X_OWNER_REPLIES_CLI_USAGE');
  const result = await readOwnerRepliesBefore({ cutoffAt, maxPages }, {
    onPageSummary: summary => console.log(JSON.stringify(summary)),
  });
  console.log(JSON.stringify({ type: 'coverage', pagesRead: result.pagesRead, ownerItemCount: result.ownerItemCount,
    reachedCutoff: result.reachedCutoff, endReached: result.endReached, coverageComplete: result.coverageComplete }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'probe') {
    console.log(JSON.stringify({ success: false, code: 'X_OWNER_REPLIES_CLI_USAGE' }));
    process.exitCode = 2;
  } else runProbe(args).catch(error => {
    const code = /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'X_OWNER_REPLIES_PROBE_FAILED';
    console.log(JSON.stringify({ success: false, code }));
    process.exitCode = 2;
  });
}
