import type { HubItem } from '../hub/types';

export const CREATOR_MARKETS = ['KR', 'US', 'JP', 'TW', 'ES', 'FR', 'DE', 'BR', 'CN', 'GLOBAL', 'UNKNOWN'] as const;
export type CreatorMarket = typeof CREATOR_MARKETS[number];
export const CREATOR_TYPES = ['keyword', 'issue', 'video', 'hashtag'] as const;
export type CreatorSignalType = typeof CREATOR_TYPES[number];
export const CREATOR_SOURCES = ['googletrends', 'tiktok_trends', 'meta_newsroom', 'threads_public', 'threads_trending'] as const;
export type CreatorSource = typeof CREATOR_SOURCES[number];
export const CREATOR_PLATFORMS = ['google', 'tiktok', 'meta', 'instagram', 'facebook', 'threads', 'youtube', 'naver', 'x'] as const;
export type CreatorPlatform = typeof CREATOR_PLATFORMS[number];
/** Platforms exposed by the Inspiration screen; official updates have their own source identities. */
export const CREATOR_INSPIRATION_PLATFORMS = ['threads', 'tiktok', 'youtube', 'instagram', 'facebook', 'x', 'naver', 'google'] as const;
export function creatorPlatformSources(platform: CreatorPlatform): CreatorSource[] {
  return ({ google: ['googletrends'], tiktok: ['tiktok_trends'], meta: ['meta_newsroom'],
    instagram: [], facebook: [], threads: ['threads_trending'],
    youtube: [], naver: [], x: [] } satisfies Record<CreatorPlatform, CreatorSource[]>)[platform];
}
export type CreatorSignalMetric = { kind: string; rawLabel: string; valueRaw: string | null; unit: string | null; approximate: boolean; period: string | null };
export type CreatorRelatedArticle = { title: string; url: string; source: string | null };
export type CreatorSignalFacts = {
  platform: CreatorPlatform; type: CreatorSignalType; market: CreatorMarket; window: string | null;
  windowVerified: boolean | null; sourcePublishedAt: string | null; sourceUpdatedAt: string | null;
  sourceKind: 'rss' | 'public_json_api' | 'authenticated_public_api'; provenanceUrl: string; sourceItemId: string;
  explicitRank: number | null; sequencePosition: number | null; selectionBasis: string;
  coverage: 'bounded_feed' | 'anonymous_preview' | 'search_sample' | 'complete_snapshot';
  metrics: CreatorSignalMetric[]; relatedArticles: CreatorRelatedArticle[];
  requestedPeriodDays?: number; sourcePeriodEndAt?: string; sourcePeriodDimension?: number; sourceHandle?: string; bodySha256?: string; keyword?: string;
  surface?: 'trending_topics'; scope?: 'unlocalized_topic_preview'; summaryOrigin?: 'source_ai';
};
export type CreatorSignal = {
  id: string; title: string; label: string; source: CreatorSource; platform: CreatorPlatform;
  type: CreatorSignalType; market: CreatorMarket; observedAt: string; sourcePublishedAt: string | null;
  provenanceUrl: string; facts: CreatorSignalFacts; metric: CreatorSignalMetric | null;
  relatedNews: CreatorRelatedArticle[]; imageUrl: string | null; sourceUrl: string; summary: string | null;
};
export type CreatorFeedQuery = { market?: CreatorMarket; type?: CreatorSignalType; source?: CreatorSource; platform?: CreatorPlatform; q?: string; limit?: number; before?: string };
export type CreatorSourceStatus = {
  source: CreatorSource; platform: CreatorPlatform; market: CreatorMarket;
  state: 'readable' | 'empty' | 'stale' | 'unavailable' | 'unverified' | 'unsupported'; lastObservedAt: string | null; reason: string | null;
};
export type CreatorFeedResult = { items: CreatorSignal[]; sourceStatuses: CreatorSourceStatus[]; mode: 'live' | 'demo'; unavailable: boolean; nextCursor: string | null; unconfiguredPlatform?: CreatorPlatform };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const nullableText = (v: unknown, max: number) => v === null || text(v, max);
const date = (v: unknown) => v === null || typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const positive = (v: unknown) => v === null || Number.isSafeInteger(v) && Number(v) > 0;
export function publicCreatorUrl(v: unknown, max = 700): v is string {
  if (!text(v, max)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash
      && ![...u.searchParams.keys()].some(k => /^(?:access_token|refresh_token|token|session|session_id|auth|authorization|cookie|secret|signature|csrf|csrf_token|oauth_code|code|state)$/i.test(k));
  } catch { return false; }
}
/** Anonymous TikTok media uses signed CDN URLs whose refresh_token is an image
 * delivery parameter. This exception never applies to provenance or article URLs. */
export function publicCreatorImageUrl(source: CreatorSource, v: unknown, max = 1900): v is string {
  if (!text(v, max) || /\s/.test(v)) return false;
  if (publicCreatorUrl(v, max)) return true;
  if (source !== 'tiktok_trends') return false;
  try {
    const u = new URL(v);
    const keys = new Set(['dr', 'nonce', 'refresh_token', 'x-expires', 'x-signature', 'idc', 'ps', 'shcp', 'shp', 't']);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash
      && /(?:^|\.)tiktokcdn(?:-us)?\.com$/i.test(u.hostname)
      && [...u.searchParams.keys()].every(key => keys.has(key));
  } catch { return false; }
}
/** Bound public facts; unknown fields and private account exports cannot pass through JSONB. */
export function validCreatorFacts(v: unknown): v is CreatorSignalFacts {
  if (!record(v) || JSON.stringify(v).length > 3900) return false;
  const keys = new Set(['platform', 'type', 'market', 'window', 'windowVerified', 'sourcePublishedAt', 'sourceUpdatedAt', 'sourceKind', 'provenanceUrl', 'sourceItemId', 'explicitRank', 'sequencePosition', 'selectionBasis', 'coverage', 'metrics', 'relatedArticles', 'requestedPeriodDays', 'sourcePeriodEndAt', 'sourcePeriodDimension', 'sourceHandle', 'bodySha256', 'keyword', 'surface', 'scope', 'summaryOrigin']);
  if (Object.keys(v).some(k => !keys.has(k))) return false;
  if (!['google', 'tiktok', 'meta', 'instagram', 'facebook', 'threads', 'youtube', 'naver', 'x'].includes(String(v.platform))
    || !(CREATOR_TYPES as readonly unknown[]).includes(v.type) || !(CREATOR_MARKETS as readonly unknown[]).includes(v.market)
    || !nullableText(v.window, 160) || ![true, false, null].includes(v.windowVerified as boolean | null)
    || !date(v.sourcePublishedAt) || !date(v.sourceUpdatedAt)
    || !['rss', 'public_json_api', 'authenticated_public_api'].includes(String(v.sourceKind))
    || !publicCreatorUrl(v.provenanceUrl) || !text(v.sourceItemId, 100) || !v.sourceItemId
    || !positive(v.explicitRank) || !positive(v.sequencePosition) || !text(v.selectionBasis, 160)
    || !['bounded_feed', 'anonymous_preview', 'search_sample', 'complete_snapshot'].includes(String(v.coverage))) return false;
  if (!Array.isArray(v.metrics) || v.metrics.length > 8 || !v.metrics.every(m => record(m)
    && Object.keys(m).every(k => ['kind', 'rawLabel', 'valueRaw', 'unit', 'approximate', 'period'].includes(k))
    && text(m.kind, 80) && /^[a-z][a-z0-9_]*$/.test(m.kind) && text(m.rawLabel, 120)
    && nullableText(m.valueRaw, 120) && nullableText(m.unit, 80) && typeof m.approximate === 'boolean' && nullableText(m.period, 120))) return false;
  if (!Array.isArray(v.relatedArticles) || v.relatedArticles.length > 3 || !v.relatedArticles.every(a => record(a)
    && Object.keys(a).every(k => ['title', 'url', 'source'].includes(k)) && text(a.title, 180) && !!a.title
    && publicCreatorUrl(a.url) && nullableText(a.source, 80))) return false;
  return (v.requestedPeriodDays === undefined || positive(v.requestedPeriodDays) && v.requestedPeriodDays !== null && Number(v.requestedPeriodDays) <= 365)
    && (v.sourcePeriodDimension === undefined || positive(v.sourcePeriodDimension) && v.sourcePeriodDimension !== null)
    && (v.sourcePeriodEndAt === undefined || v.sourcePeriodEndAt !== null && date(v.sourcePeriodEndAt))
    && (v.sourceHandle === undefined || text(v.sourceHandle, 80))
    && (v.keyword === undefined || text(v.keyword, 300))
    && (v.surface === undefined || v.surface === 'trending_topics')
    && (v.scope === undefined || v.scope === 'unlocalized_topic_preview')
    && (v.summaryOrigin === undefined || v.summaryOrigin === 'source_ai')
    && (v.bodySha256 === undefined || typeof v.bodySha256 === 'string' && /^[a-f0-9]{64}$/.test(v.bodySha256));
}
export function toCreatorSignal(item: HubItem): CreatorSignal | null {
  const facts = item.facts?.creator;
  if (item.kind !== 'trend' || !(CREATOR_SOURCES as readonly string[]).includes(item.source)
    || !validCreatorFacts(facts) || !item.observedAt || !Number.isFinite(Date.parse(item.observedAt))) return null;
  if (item.source === 'googletrends' && facts.platform !== 'google'
    || item.source === 'tiktok_trends' && (facts.platform !== 'tiktok' || facts.type !== 'video' || !['JP', 'US'].includes(facts.market))
    || item.source === 'threads_public' && (facts.platform !== 'threads' || facts.market !== 'GLOBAL')
    || item.source === 'threads_trending' && (facts.platform !== 'threads' || facts.type !== 'keyword' || facts.market !== 'UNKNOWN'
      || facts.surface !== 'trending_topics' || facts.scope !== 'unlocalized_topic_preview' || facts.summaryOrigin !== 'source_ai'
      || facts.explicitRank !== null || facts.window !== null || facts.windowVerified !== null || facts.metrics.length !== 0
      || facts.sourcePublishedAt !== null || facts.sourceUpdatedAt !== null || facts.sourceKind !== 'public_json_api'
      || facts.coverage !== 'anonymous_preview' || facts.sequencePosition === null || facts.sequencePosition > 5
      || facts.requestedPeriodDays !== undefined || facts.sourcePeriodEndAt !== undefined || facts.sourcePeriodDimension !== undefined)
    || item.source === 'meta_newsroom' && (!['meta', 'instagram', 'facebook', 'threads'].includes(facts.platform) || facts.market !== 'GLOBAL')) return null;
  return { id: item.id, title: item.title, label: item.title, source: item.source as CreatorSource,
    platform: facts.platform, type: facts.type, market: facts.market, observedAt: item.observedAt,
    sourcePublishedAt: facts.sourcePublishedAt, provenanceUrl: facts.provenanceUrl, facts,
    metric: facts.metrics[0] ?? null, relatedNews: facts.relatedArticles, imageUrl: item.imageUrl, sourceUrl: item.sourceUrl, summary: item.summary };
}
