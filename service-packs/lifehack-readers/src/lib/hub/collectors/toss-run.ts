import type { TossCollectorRunClaim } from '../../service-session-store';
import type { TossRuntimeCollection } from '../../toss-session-runtime';
import { tossErrorCode, tossFailureDiagnostics, tossStopsSession, type TossFailureDiagnostics } from '../../toss-session-core';
import type { HubItem } from '../types';
import { TOSS_WRITER } from './toss-sharelink';

export interface TossRunReceipt { fetched: number; upserted: number; blocked: boolean; error: string | null; persisted: boolean; complete: boolean;
  diagnostics: TossFailureDiagnostics | null }
export async function runTossCollector(dependencies: {
  begin: () => Promise<TossCollectorRunClaim>;
  collect: () => Promise<TossRuntimeCollection>;
  upsert: (items: HubItem[], writer: string) => Promise<{ error: unknown; count: number }>;
  finish: (run: Extract<TossCollectorRunClaim, { claimed: true }>, receipt: TossRunReceipt) => Promise<boolean>;
}) {
  const run = await dependencies.begin();
  if (!run.claimed) return { status: run.status, runId: run.runId ?? null, fetched: run.fetched ?? 0,
    upserted: run.upserted ?? 0, persisted: run.persisted ?? false, complete: run.complete ?? false, error: run.error ?? null,
    diagnostics: run.diagnostics ?? null, sourceRequests: 0, issued: 0, skipped: 0, issues: run.error ? [run.error] : [] };
  const receipt: TossRunReceipt = { fetched: 0, upserted: 0, blocked: false, error: null, persisted: false, complete: false, diagnostics: null };
  let sourceRequests = 0, issued = 0, skipped = 0;
  let issues: string[] = [];
  try {
    const collection = await dependencies.collect();
    receipt.fetched = collection.fetched;
    sourceRequests = collection.sourceRequests; issued = collection.issued; skipped = collection.skipped;
    issues = collection.errors;
    const saved = await dependencies.upsert(collection.items, TOSS_WRITER);
    receipt.upserted = saved.count;
    receipt.persisted = !saved.error && saved.count === collection.items.length;
    receipt.error = !receipt.persisted ? 'TOSS_HUB_WRITE_FAILED'
      : collection.errors.length || !collection.complete ? 'PARTIAL_LIST:TOSS_PARTIAL' : null;
    receipt.complete = receipt.persisted && receipt.error === null && collection.complete;
  } catch (error) {
    receipt.error = tossErrorCode(error);
    issues = [receipt.error];
    receipt.diagnostics = tossFailureDiagnostics(error);
    receipt.blocked = tossStopsSession(receipt.error) || ['TOSS_SESSION_BUSY', 'TOSS_SESSION_HOLD'].includes(receipt.error);
  }
  const logged = await dependencies.finish(run, receipt);
  return { status: !logged ? 'receipt_failed' : receipt.blocked ? 'blocked' : receipt.error ? 'partial' : 'succeeded',
    runId: run.runId, ...receipt, sourceRequests, issued, skipped, issues, logged };
}
