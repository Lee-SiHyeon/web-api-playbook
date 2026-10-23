import { getSupabaseAdminClient } from './supabase/admin';
import { beginTossCollectorRun, finishTossCollectorRun, pendingTossCollectorSlots, readServiceSessionMetadata,
  type ServiceSessionOwnerScope } from './service-session-store';
import { tossLogicalSlot } from './hub/collectors/toss-sharelink';
import { runTossCollector } from './hub/collectors/toss-run';
import { upsertHubItems } from './hub/row';
import { collectTossFromVercel } from './toss-session-runtime';
import { requestConfiguredTossReauthentication } from './toss-automatic-reauth';
import { TossSessionError } from './toss-session-core';

export function tossCollectionEnabled() { return process.env.TOSS_COLLECTION_ENABLED === 'true'; }

/** One persistent logical run for cron, operator initiation and post-approval continuation. */
export async function runTossCollection(scope: ServiceSessionOwnerScope, scheduledAt = tossLogicalSlot(new Date())) {
  if (!tossCollectionEnabled()) return { status: 'disabled', sourceRequests: 0, persisted: false, error: 'TOSS_COLLECTION_DISABLED' };
  if (scope.serviceId !== 'toss_sharelink' || !Number.isFinite(Date.parse(scheduledAt))) throw new TossSessionError('TOSS_RUN_SCOPE_INVALID');
  const db = getSupabaseAdminClient();
  const result = await runTossCollector({
    begin: () => beginTossCollectorRun(scope, scheduledAt),
    collect: () => collectTossFromVercel(scope),
    upsert: (items, writer) => upsertHubItems(db, items, writer),
    finish: (run, receipt) => finishTossCollectorRun(scope, run, receipt),
  });
  // A waiting run can outlive its discarded cookie recovery candidate. A new
  // login uses the configured expected identity and password, never stale tokens.
  const auth = ['TOSS_REAUTH_REQUIRED', 'TOSS_TWO_FACTOR_REQUIRED'].includes(result.error ?? '')
    ? await requestConfiguredTossReauthentication(scope).catch(() => ({ reauthStatus: 'unavailable' })) : {};
  return { ...result, ...auth };
}

/** Runs immediately after approval in the same invocation, or from the recovery cron. */
export async function resumePendingTossCollections(scope: ServiceSessionOwnerScope) {
  if (!tossCollectionEnabled()) return { status: 'disabled', runs: 0, fetched: 0, upserted: 0, issued: 0 };
  const slots = await pendingTossCollectorSlots(scope);
  if (!slots.length) return { status: 'idle', runs: 0, fetched: 0, upserted: 0, issued: 0 };
  const metadata = await readServiceSessionMetadata(scope);
  if (metadata?.status !== 'ready' || !metadata.hasCredential) return { status: 'awaiting_auth', runs: 0, fetched: 0, upserted: 0, issued: 0,
    ...await requestConfiguredTossReauthentication(scope) };
  const result = await runTossCollection(scope, slots[0]);
  return { status: result.status, runs: 1, fetched: 'fetched' in result ? result.fetched : 0,
    upserted: 'upserted' in result ? result.upserted : 0, issued: 'issued' in result ? result.issued : 0,
    persisted: result.persisted, complete: 'complete' in result ? result.complete : false,
    error: result.error, issues: 'issues' in result ? result.issues : [] };
}
