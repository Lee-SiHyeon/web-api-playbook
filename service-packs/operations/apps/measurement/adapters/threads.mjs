import { dateOnly, finiteCount, metric, postIdOf, publishedAtOf } from './shared.mjs';

function dateRange(items, now, since) {
  const endDate = dateOnly(now);
  const dates = items.map(item => dateOnly(publishedAtOf(item))).filter(Boolean);
  if (since) {
    const fromSince = dateOnly(since);
    if (fromSince) dates.push(fromSince);
  }
  const earliest = dates.sort()[0] ?? dateOnly(new Date(new Date(now).getTime() - 7 * 86_400_000));
  const maxStart = dateOnly(new Date(Date.parse(`${endDate}T00:00:00Z`) - 89 * 86_400_000));
  return { startDate: earliest < maxStart ? maxStart : earliest, endDate };
}

function postList(result) {
  if (Array.isArray(result?.data?.posts)) return result.data.posts;
  if (Array.isArray(result?.posts)) return result.posts;
  if (Array.isArray(result)) return result;
  return [];
}

function matchingPost(posts, item) {
  const wanted = postIdOf(item, 'threads');
  if (!wanted) return null;
  const normalized = String(wanted).split('_')[0];
  return posts.find(post => String(post?.id ?? '').split('_')[0] === normalized
    || post?.code === wanted || post?.url === item?.url) ?? null;
}

export function createThreadsAdapter({ deps = {}, items = [], now = new Date(), since } = {}) {
  const range = dateRange(items, now, since);
  let clientPromise;
  let postsPromise;

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        if (deps.threads?.client) return deps.threads.client;
        const injected = deps.threads?.createClient ?? deps.createThreadsInsightsClient;
        if (typeof injected === 'function') return injected(range);
        const { createThreadsInsightsClient } = await import('../../social-actions/threads-insights.mjs');
        return createThreadsInsightsClient(range);
      })();
    }
    return clientPromise;
  }

  async function ownerPosts() {
    if (!postsPromise) {
      postsPromise = (async () => {
        if (typeof deps.threads?.readPosts === 'function') return postList(await deps.threads.readPosts(range));
        const client = await getClient();
        return postList(await client.read('posts'));
      })();
    }
    return postsPromise;
  }

  return async function readThreadsItem(item) {
    const source = 'threads.creator-insights';
    const missing = reason => ({
      impressions: metric(null, { source, reason }),
      likes: metric(null, { source, reason }),
      replies: metric(null, { source, reason }),
      reposts: metric(null, { source, reason }),
      quotes: metric(null, { source, reason }),
    });
    if (typeof deps.threads?.readItem === 'function') {
      const fixture = await deps.threads.readItem(item, range);
      return Object.fromEntries(['impressions', 'likes', 'replies', 'reposts', 'quotes'].map(name => [name,
        metric(fixture?.[name], { source, reason: fixture?.[name] == null ? 'provider_metric_unavailable' : undefined })]));
    }
    const posts = await ownerPosts();
    const post = matchingPost(posts, item);
    if (!post) return missing('post_not_in_captured_first_page');
    const map = {
      impressions: post.impressions,
      likes: post.likes,
      replies: post.replies,
      reposts: post.reposts,
      quotes: post.quotes,
    };
    return Object.fromEntries(Object.entries(map).map(([name, value]) => [name,
      metric(finiteCount(value), { source, reason: value == null ? 'provider_metric_unavailable' : 'provider_metric_invalid' })]));
  };
}

export const threadsAdapterInternals = Object.freeze({ dateRange, matchingPost, postList });
