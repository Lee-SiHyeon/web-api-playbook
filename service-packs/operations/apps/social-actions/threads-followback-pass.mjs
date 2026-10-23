import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSessionLock } from '../tistory-api/lib/lock.mjs';
import { openMetaContext } from './lib/meta-bootstrap.mjs';
import { readThreadsFollowers } from './threads-social.mjs';
import { readMetaRelationship, prepareMetaAction, executeMetaAction } from './providers/meta.mjs';
import { executeJournaled } from './lib/journal.mjs';
import { verifyThreadsActivePromotion } from './threads-benefit-runner.mjs';
import { ThreadsBenefitReadTimeout, readThreadsBenefitPhase } from './lib/threads-read-recovery.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function verifyIncoming(actor, { contextLoader = openMetaContext, relationshipReader = readMetaRelationship } = {}) {
  const context = await contextLoader('threads', actor.username);
  if (context?.service !== 'threads' || context.bundle?.owner !== 'lifehack__ailab' || !context.documentReceipt?.ownerVerified) fail('THREADS_BENEFIT_OWNER_UNVERIFIED');
  const relationship = await relationshipReader(context);
  const rows = context.document.profiles.filter(row => String(row.pk ?? row.id) === actor.id && row.username?.toLowerCase() === actor.username.toLowerCase());
  if (relationship.id !== actor.id || !rows.length) fail('THREADS_BENEFIT_ACTOR_UNVERIFIED');
  if (!rows.every(row => row.friendship_status?.followed_by === true)) fail('THREADS_BENEFIT_INCOMING_FOLLOW_CHANGED');
  return relationship;
}

export async function runThreadsFollowbackPass(config, { root, sleep, isStopRequested }, dependencies = {}) {
  const deps = {
    now: Date.now, followersReader: readThreadsFollowers, verifyPromotion: verifyThreadsActivePromotion,
    verifyIncoming, executeJournaled, prepare: prepareMetaAction, execute: executeMetaAction,
    readState: async () => JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')),
    saveState: async state => { const file = path.join(root, 'state.json'), temp = file + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temp, file); },
    lock: task => withSessionLock(task, { lockPath: path.join(root, 'coordinator.lock'), timeoutMs: 600_000 }),
    ...dependencies,
  };
  const summary = { observed: 0, eligible: 0, followed: 0, writes: 0, held: [], coverage: 'observed_first_follower_page' };
  const stopRequested = async () => typeof isStopRequested === 'function' && await isStopRequested();
  if (await stopRequested()) fail('THREADS_BENEFIT_STOPPED');
  await readThreadsBenefitPhase('followback_promotion', () => deps.verifyPromotion(config));
  if (await stopRequested()) fail('THREADS_BENEFIT_STOPPED');
  const followers = await readThreadsBenefitPhase('followback_followers', () => deps.followersReader());
  if (!Array.isArray(followers?.followers)) fail('THREADS_BENEFIT_FOLLOWERS_INVALID');
  if (await stopRequested()) fail('THREADS_BENEFIT_STOPPED');
  summary.observed = followers.followers.length;
  for (const actor of followers.followers) {
    if (actor.followsOwner !== true || actor.following !== false || actor.outgoingRequest !== false) continue;
    if (await isStopRequested()) break;
    summary.eligible++;
    try { await deps.lock(async () => {
      if (await isStopRequested()) return;
      const state = await deps.readState();
      const previous = Date.parse(state.lastAccountAttemptAt || '');
      const wait = Number.isFinite(previous) ? 20_000 - (deps.now() - previous) : 0;
      if (wait > 0 && !await sleep(wait)) return;
      if (await isStopRequested()) return;
      const relationship = await readThreadsBenefitPhase('followback_actor_preflight', () => deps.verifyIncoming(actor));
      if (relationship.state.following || relationship.state.outgoingRequest) return;
      state.lastAccountAttemptAt = new Date(deps.now()).toISOString(); await deps.saveState(state);
      const input = { service: 'threads', operation: 'follow', target: actor.username };
      const check = receipt => { if (receipt.normalizedTarget !== actor.id || receipt.target?.toLowerCase() !== actor.username.toLowerCase() || !receipt.auth?.ownerVerified) fail('THREADS_BENEFIT_ACTOR_UNVERIFIED'); };
      const provider = {
        prepare: async value => {
          const receipt = await readThreadsBenefitPhase('followback_action_prepare', () => deps.prepare(value));
          check(receipt); return receipt;
        },
        execute: (value, options) => deps.execute(value, { ...options, beforeWrite: async receipt => {
          check(receipt);
          await readThreadsBenefitPhase('followback_actor_revalidation', () => deps.verifyIncoming(actor));
          if (await isStopRequested()) fail('THREADS_BENEFIT_STOPPED');
          return options.beforeWrite(receipt);
        } }),
      };
      const result = await deps.executeJournaled(input, provider);
      if (result.success) check(result);
      summary.writes += Number.isSafeInteger(result.mutationCount) ? result.mutationCount : 0;
      if (result.status === 'blocked' && result.code === 'THREADS_BENEFIT_READ_TIMEOUT'
        && result.mutationCount === 0 && result.writeSent === false && result.needs_reconciliation === false
        && typeof result.journalPath === 'string') {
        summary.held.push({ id: actor.id, handle: actor.username, code: result.code,
          phase: 'followback_actor_revalidation' });
        return;
      }
      if (!result.success || !result.readbackVerified || !(result.currentState?.following || result.currentState?.outgoingRequest)) {
        summary.held.push({ id: actor.id, handle: actor.username, code: result.code || 'THREADS_BENEFIT_FOLLOW_UNVERIFIED' });
        if (result.needs_reconciliation) fail('THREADS_BENEFIT_FOLLOW_RECONCILIATION_REQUIRED');
        throw Object.assign(new Error(), { code: result.code || 'THREADS_BENEFIT_FOLLOW_UNVERIFIED', receipt: result });
      }
      state.fastFollowbacks ||= {}; state.fastFollowbacks[actor.id] = { handle: actor.username, checkedAt: new Date(deps.now()).toISOString(), journalPath: result.journalPath, following: result.currentState.following, pending: result.currentState.outgoingRequest, readbackVerified: true };
      await deps.saveState(state); summary.followed++;
    }); } catch (error) {
      if (error instanceof ThreadsBenefitReadTimeout
        && ['followback_actor_preflight', 'followback_action_prepare'].includes(error.phase)) {
        summary.held.push({ id: actor.id, handle: actor.username, code: error.code, phase: error.phase });
        continue;
      }
      if (!['THREADS_BENEFIT_INCOMING_FOLLOW_CHANGED', 'THREADS_BENEFIT_ACTOR_UNVERIFIED'].includes(error.code)) throw error;
      summary.held.push({ id: actor.id, handle: actor.username, code: error.code });
    }
  }
  return summary;
}
