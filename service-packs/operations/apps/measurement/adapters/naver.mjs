import { itemIdOf, metric, postIdOf } from './shared.mjs';

function blogIdOf(item, deps) {
  const refs = item?.refs?.naver ?? item?.refs?.naverBlog ?? {};
  const value = deps?.naver?.blogId ?? item?.blogId ?? refs.blogId ?? refs.blog_id;
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export function createNaverAdapter({ deps = {}, now = new Date() } = {}) {
  const cache = new Map();
  const readStats = async blogId => {
    if (!cache.has(blogId)) {
      const promise = (async () => {
        const injected = typeof deps.naver === 'function' ? deps.naver
          : deps.naver?.collectPostStats ?? deps.collectNaverPostStats;
        if (typeof injected === 'function') return injected({ blogId, days: 7, now });
        const { collectPostStats } = await import('../../naver-blog-api/research/content-store/post-stats.mjs');
        return collectPostStats({ blogId, days: 7, now });
      })();
      cache.set(blogId, promise);
    }
    return cache.get(blogId);
  };

  return async function readNaverItem(item) {
    const source = 'naver.blog-post-stats';
    const postId = postIdOf(item, 'naver');
    const base = {
      views: metric(null, { source, reason: 'per_post_views_not_available' }),
      conversions: metric(null, { source, reason: 'post_not_reported' }),
    };
    if (!postId || !/^\d{1,20}$/.test(postId)) {
      base.conversions.reason = 'post_id_missing';
      return base;
    }
    const blogId = blogIdOf(item, deps);
    if (!blogId) {
      base.conversions.reason = 'blog_id_missing';
      return base;
    }
    const stats = await readStats(blogId);
    const rows = stats?.blog?.topPostsByConversions;
    if (!Array.isArray(rows)) {
      base.conversions.reason = 'conversion_report_unavailable';
      return base;
    }
    const row = rows.find(candidate => String(candidate?.logNo ?? '') === postId);
    if (!row) return base;
    base.conversions = metric(row.conversions, { source, reason: 'conversion_count_not_returned' });
    return base;
  };
}

export const naverAdapterInternals = Object.freeze({ blogIdOf, itemIdOf });
