import { TossSessionClient, TossSessionError, validateTossBundle, type TossSessionState } from './toss-session-core';
import { tossRuntimeHttpFetch } from './toss-direct-http';

/** First-party member GET with the signed bundle's protected owner; no grant or password login. */
export async function verifyTossSharelinkHealth(state: TossSessionState, fetchImpl: typeof fetch = tossRuntimeHttpFetch): Promise<TossSessionState> {
  if (state.version !== 1 || state.provider !== 'toss_sharelink' || !state.ownerEmail) throw new TossSessionError('TOSS_STATE_INVALID');
  const client = new TossSessionClient(validateTossBundle(state.bundle), { fetchImpl });
  await client.verifyOwner();
  return { ...state, bundle: client.bundle };
}
