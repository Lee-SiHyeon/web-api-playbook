import { HubSource } from '../types';

/** Configuration for each working hotdeal feed source. */
export interface FeedSource {
  source: HubSource;
  url: string;
  kind: 'hotdeal';
  rssFormat: 'rss2' | 'atom';
}

/**
 * Working RSS/feed sources verified 2026-10-11.
 * Community board sources; RSS format.
 * Platform deal sources (coupang, naver_shopping, toss, eleventh) are collected via APIs in run.ts.
 */
export const WORKING_SOURCES: FeedSource[] = [
  {
    source: 'ppomppu',
    url: 'https://www.ppomppu.co.kr/rss.php?id=ppomppu',
    kind: 'hotdeal',
    rssFormat: 'rss2',
  },
];

/**
 * Blocked sources and their block reasons.
 * These return 403, 400, or bot challenges on public fetch.
 */
export const BLOCKED_SOURCES: Record<string, { reason: string; attemptedUrl: string }> = {
  ruliweb: {
    reason: 'Vercel IPs: connection fails or stalls (hub_collector_runs 2026-10-11); the PC importer hub-push.mjs collects it',
    attemptedUrl: 'https://bbs.ruliweb.com/market/board/1020/rss',
  },
  quasarzone: {
    reason: '403 Forbidden',
    attemptedUrl: 'https://quasarzone.com/bbs/qb_saleinfo/rss',
  },
  clien: {
    reason: '400 Bad Request',
    attemptedUrl: 'https://www.clien.net/service/board/jirum/rss',
  },
};
