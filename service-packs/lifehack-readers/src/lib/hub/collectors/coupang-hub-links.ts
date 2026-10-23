import { normalizeCoupangExactProductTarget } from '../../coupang-partner-link-issue-core';
import type { CoupangPartnerLinkIssueRecord } from '../../service-session-store';

export const HUB_COUPANG_LINK_CAP = 40;
export interface HubCoupangLinkCandidate {
  hub_item_id: string; product_url: string; product_identity: string; target_snapshot: string;
}
export interface HubCoupangLinkSummary {
  listed: number; attempted: number; issued: number; cached: number; attached: number;
  skipped: number; unverified: number; stopCode: string | null;
}
export function parseHubCoupangLinkCandidates(value: unknown): HubCoupangLinkCandidate[] {
  if (!Array.isArray(value) || value.length > 300) throw new Error('COUPANG_HUB_LINK_CANDIDATES_INVALID');
  const ids = new Set<string>();
  return value.map((row) => {
    const target = normalizeCoupangExactProductTarget(row?.product_url);
    if (!row || Object.keys(row).sort().join(',') !== 'hub_item_id,product_identity,product_url,target_snapshot'
      || typeof row.hub_item_id !== 'string' || !row.hub_item_id || row.hub_item_id.length > 300
      || !target || target.identity !== row.product_identity || typeof row.target_snapshot !== 'string'
      || row.target_snapshot.length > 2048 || ids.has(row.hub_item_id)) throw new Error('COUPANG_HUB_LINK_CANDIDATES_INVALID');
    ids.add(row.hub_item_id);
    return row as HubCoupangLinkCandidate;
  });
}

/** Candidates are DB ordered: picks:match first, then newest last_seen_at. Exact options share one issue. */
export async function runHubCoupangLinkBatch(rows: readonly HubCoupangLinkCandidate[], deps: {
  issue(row: HubCoupangLinkCandidate, hooks: { onDispatch(): void; onIssued(): void }):
    Promise<{ record: CoupangPartnerLinkIssueRecord; cached: boolean }>;
  attach(row: HubCoupangLinkCandidate, record: CoupangPartnerLinkIssueRecord): Promise<boolean>;
  timeRemaining(): boolean;
}): Promise<HubCoupangLinkSummary> {
  const summary: HubCoupangLinkSummary = { listed: rows.length, attempted: 0, issued: 0, cached: 0,
    attached: 0, skipped: 0, unverified: 0, stopCode: null };
  const groups = new Map<string, HubCoupangLinkCandidate[]>();
  for (const row of rows) groups.set(row.product_identity, [...(groups.get(row.product_identity) ?? []), row]);
  for (const group of groups.values()) {
    if (!deps.timeRemaining()) { summary.stopCode = 'COUPANG_HUB_LINK_TIME_BUDGET'; break; }
    if (summary.attempted >= HUB_COUPANG_LINK_CAP) break;
    let countedIssued = false;
    try {
      const result = await deps.issue(group[0], {
        onDispatch: () => { summary.attempted += 1; },
        onIssued: () => { if (!countedIssued) summary.issued += 1; countedIssued = true; },
      });
      if (result.cached) summary.cached += 1;
      for (const row of group) {
        if (await deps.attach(row, result.record)) summary.attached += 1;
        else summary.skipped += 1; // changed option, a new accepted link, expired row, or quarantine
      }
    } catch (error) {
      const raw = error && typeof error === 'object' && 'code' in error ? error.code : null;
      const code = typeof raw === 'string' && /^COUPANG_[A-Z0-9_]{1,64}$/.test(raw) ? raw : 'COUPANG_HUB_LINK_FAILED';
      if (code === 'COUPANG_HUB_TARGET_CHANGED') { summary.skipped += group.length; continue; }
      if (code === 'COUPANG_LINK_ATTRIBUTION_UNVERIFIED') {
        summary.unverified += group.length;
        continue; // receipt remains private and must never be dispatched again
      }
      summary.stopCode = code;
      break;
    }
  }
  return summary;
}
