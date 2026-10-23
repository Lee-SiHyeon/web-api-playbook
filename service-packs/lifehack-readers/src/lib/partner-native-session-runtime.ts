import { authorizedNativeHandoffRevision, clearNativeHandoffMaterial, exactKeys, NativeHandoffError,
  record, type NativeHandoffProvider } from './native-handoff-envelope';
import { type NaverNativeMaterial } from './naver-native-session-handoff';
import { verifyNaverSessionHealth, lastNaverHealthFailure, type NaverSessionState } from './naver-session-health';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { validateTossBundle, TossSessionError, tossFailureDiagnostics, tossHoldsSession, tossNeedsSecondFactor,
  type TossSessionBundle, type TossSessionState } from './toss-session-core';
import { verifyTossSharelinkHealth } from './toss-sharelink-health';
import { renewTossHttpSession } from './toss-session-renewal';
import { saveTossCookieRecovery } from './toss-session-recovery';
import { TossHttpAuthenticatedSessionHandle } from './toss-http-login-core';
import { casWriteServiceSession, claimServiceSession, releaseServiceSessionLease, verifyServiceSessionCredential,
  type ClaimedServiceSession, type ServiceSessionMetadata, type ServiceSessionOwnerScope } from './service-session-store';

export function nativeImportEligible(metadata: ServiceSessionMetadata): boolean {
  return !metadata.hasCredential && !metadata.leaseBusy
    && ['unconfigured', 'reauth_required', 'hold'].includes(metadata.status)
    && !['OWNER_ACTION_REQUIRED', 'OPERATOR_PAUSED', 'RATE_LIMITED'].includes(metadata.holdCode ?? '');
}

export interface PartnerNativeSessionResult { ready: boolean; stored: boolean; ownerVerified: boolean; revision: number }

/** Only an opaque handle created by the HTTP login core can supply a server-acquired session. */
export async function storeTossHttpLoginSession(scope: ServiceSessionOwnerScope, ownerEmail: string,
  expectedRevision: number, session: TossHttpAuthenticatedSessionHandle,
  observeStoredCredential?: (bytes: Buffer) => Promise<void>, fetchImpl?: typeof fetch): Promise<PartnerNativeSessionResult> {
  if (!(session instanceof TossHttpAuthenticatedSessionHandle) || scope.serviceId !== 'toss_sharelink') throw new NativeHandoffError('TOSS_HTTP_LOGIN_PROOF_REQUIRED');
  const claim = await claimServiceSession(scope, expectedRevision, 120);
  if (!claim) throw new NativeHandoffError('PARTNER_NATIVE_HANDOFF_NOT_ELIGIBLE');
  try {
    if (!nativeImportEligible({ ...claim.metadata, leaseBusy: false }) || claim.credential) throw new NativeHandoffError('PARTNER_NATIVE_HANDOFF_NOT_ELIGIBLE');
    return await session.withVerifiedBundle(async bundle => {
      const bytes = Buffer.from(JSON.stringify({ version: 1, provider: 'toss_sharelink', ownerEmail, bundle }));
      try { return await verifyAndStore(scope, claim, 'toss_sharelink', ownerEmail, bytes, false, observeStoredCredential, fetchImpl); }
      finally { bytes.fill(0); }
    });
  } finally { claim.credential?.destroy(); await releaseServiceSessionLease(scope, claim.lease).catch(() => false); }
}

export async function importPartnerNativeSession(input: {
  scope: ServiceSessionOwnerScope; provider: NativeHandoffProvider; ownerEmail: string;
  metadata: ServiceSessionMetadata; material: NaverNativeMaterial | TossSessionBundle;
  renewHttpSession?: boolean;
}): Promise<PartnerNativeSessionResult> {
  if (input.scope.serviceId !== input.provider || !nativeImportEligible(input.metadata)
    || authorizedNativeHandoffRevision(input.material, input.provider, input.ownerEmail) !== input.metadata.revision) {
    throw new NativeHandoffError('PARTNER_NATIVE_HANDOFF_NOT_ELIGIBLE');
  }
  const claim = await claimServiceSession(input.scope, input.metadata.revision, 120);
  if (!claim) throw new NativeHandoffError('PARTNER_SESSION_BUSY');
  let bytes: Buffer | null = null;
  try {
    if (!nativeImportEligible({ ...claim.metadata, leaseBusy: false }) || claim.credential
      || authorizedNativeHandoffRevision(input.material, input.provider, input.ownerEmail) !== claim.lease.revision) {
      throw new NativeHandoffError('PARTNER_NATIVE_HANDOFF_NOT_ELIGIBLE');
    }
    const state = input.provider === 'naver_connect'
      ? { version: 1, provider: input.provider, ownerEmail: input.ownerEmail,
        loginId: (input.material as NaverNativeMaterial).loginId, spaceId: (input.material as NaverNativeMaterial).spaceId,
        userAgent: (input.material as NaverNativeMaterial).userAgent, cookies: (input.material as NaverNativeMaterial).cookies }
      : { version: 1, provider: input.provider, ownerEmail: input.ownerEmail, bundle: input.material };
    bytes = Buffer.from(JSON.stringify(state));
    return await verifyAndStore(input.scope, claim, input.provider, input.ownerEmail, bytes, input.renewHttpSession === true);
  } finally {
    bytes?.fill(0);
    claim.credential?.destroy();
    await releaseServiceSessionLease(input.scope, claim.lease).catch(() => false);
  }
}

export async function verifyPartnerNativeSession(input: {
  scope: ServiceSessionOwnerScope; provider: NativeHandoffProvider; ownerEmail: string; metadata: ServiceSessionMetadata;
  observeStoredCredential?: (bytes: Buffer) => Promise<void>;
}): Promise<PartnerNativeSessionResult> {
  if (input.provider === 'toss_sharelink' && input.scope.serviceId === input.provider && input.metadata.status === 'hold') {
    throw new TossSessionError('TOSS_SESSION_HOLD');
  }
  if (input.scope.serviceId !== input.provider || input.metadata.status !== 'ready' || !input.metadata.hasCredential) {
    throw new NativeHandoffError('PARTNER_SESSION_REAUTH_REQUIRED');
  }
  const claim = await claimServiceSession(input.scope, input.metadata.revision, 120);
  if (!claim) throw new NativeHandoffError('PARTNER_SESSION_BUSY');
  try {
    if (!claim.credential) throw new NativeHandoffError('PARTNER_SESSION_REAUTH_REQUIRED');
    return await claim.credential.withBytes(bytes => verifyAndStore(input.scope, claim, input.provider, input.ownerEmail, bytes, false, input.observeStoredCredential));
  } finally {
    claim.credential?.destroy();
    await releaseServiceSessionLease(input.scope, claim.lease).catch(() => false);
  }
}

async function verifyAndStore(scope: ServiceSessionOwnerScope, claim: ClaimedServiceSession,
  provider: NativeHandoffProvider, ownerEmail: string, bytes: Buffer, renewHttpSession = false,
  observeStoredCredential?: (bytes: Buffer) => Promise<void>, fetchImpl?: typeof fetch): Promise<PartnerNativeSessionResult> {
  const updated = { bytes: null as Buffer | null };
  let healthCode = provider === 'naver_connect' ? 'NAVER_CONNECT_HEALTH_NOT_VERIFIED' : 'TOSS_SHARELINK_HEALTH_NOT_VERIFIED';
  let healthVerified = false;
  let handoffStep: string | null = null;
  let tossFailure: TossSessionError | null = null;
  const recoveryCandidate = { bytes: null as Buffer | null };
  try {
    const proof = await verifyServiceSessionCredential(scope, bytes, async (candidate, acceptVerifiedCredential) => {
      let state: Record<string, unknown> | null = null;
      let verified: NaverSessionState | TossSessionState | null = null;
      try {
        state = record(JSON.parse(candidate.toString('utf8')));
        if (!state || state.version !== 1 || state.provider !== provider || state.ownerEmail !== ownerEmail) throw new Error();
        if (provider === 'naver_connect') {
          if (!exactKeys(state, ['version', 'provider', 'ownerEmail', 'loginId', 'spaceId', 'userAgent', 'cookies'])) { handoffStep = 'state-keys'; throw new Error(); }
          if (state.loginId !== process.env.NAVER_CONNECT_OWNER_LOGIN_ID?.trim()) { handoffStep = 'login-id-env'; throw new Error(); }
          verified = await verifyNaverSessionHealth(state as unknown as NaverSessionState);
        } else {
          if (!exactKeys(state, ['version', 'provider', 'ownerEmail', 'bundle'])) throw new Error();
          validateTossBundle(state.bundle);
          if (renewHttpSession) state.bundle = (await renewTossHttpSession(state.bundle as TossSessionBundle, fetchImpl,
            candidate => { state!.bundle = candidate; })).bundle;
          verified = await verifyTossSharelinkHealth(state as unknown as TossSessionState, fetchImpl);
        }
        if (!acceptVerifiedCredential) throw new Error();
        updated.bytes = Buffer.from(JSON.stringify(verified));
        acceptVerifiedCredential(updated.bytes);
        return { outcome: 'verified', ownerVerified: true, readOnly: true };
      } catch (error) {
        if (error instanceof NativeHandoffError || error instanceof TossSessionError) healthCode = error.code;
        if (error instanceof TossSessionError) {
          tossFailure = error;
          if (state && tossNeedsSecondFactor(error)) recoveryCandidate.bytes = Buffer.from(JSON.stringify(state));
        }
        if (provider === 'naver_connect' && !handoffStep) handoffStep = lastNaverHealthFailure ?? 'unknown';
        throw error;
      } finally { clearNativeHandoffMaterial(verified); clearNativeHandoffMaterial(state); }
    });
    healthVerified = true;
    if (!updated.bytes) throw new NativeHandoffError(healthCode);
    const saved = await casWriteServiceSession({ scope, lease: claim.lease, status: 'ready',
      credential: updated.bytes, healthProof: proof });
    if (!saved) throw new NativeHandoffError('PARTNER_SESSION_CAS_CONFLICT');
    await observeStoredCredential?.(updated.bytes);
    return { ready: true, stored: true, ownerVerified: true, revision: saved.revision };
  } catch (error) {
    if (!healthVerified) {
      const recoverySaveFailed = recoveryCandidate.bytes !== null
        && !await saveTossCookieRecovery(recoveryCandidate.bytes, claim.lease.revision + 1).catch(() => false);
      const hold = provider === 'toss_sharelink' && (tossHoldsSession(healthCode) || healthCode === 'TOSS_THROTTLED');
      const rejected = !recoverySaveFailed ? await casWriteServiceSession({ scope, lease: claim.lease, status: hold ? 'hold' : 'reauth_required',
        holdCode: provider === 'toss_sharelink' && healthCode === 'TOSS_THROTTLED' ? 'RATE_LIMITED' : 'HEALTH_CHECK_FAILED' }).catch(() => null) : null;
      if (rejected && recoveryCandidate.bytes && tossFailure && tossNeedsSecondFactor(tossFailure)) {
        const candidate = JSON.parse(recoveryCandidate.bytes.toString()) as TossSessionState;
        try {
          const { requestTossAutomaticReauth } = await import('./toss-automatic-reauth');
          await requestTossAutomaticReauth(scope, candidate, rejected.revision, { fetchImpl }).catch(() => {});
        } finally { clearNativeHandoffMaterial(candidate); }
      }
      // Operator diagnostics without secrets: which step of the provider health check failed.
      await Promise.resolve(getSupabaseAdminClient().from('hub_collector_runs').insert({
        source: `handoff:${provider}`, fetched: 0, upserted: 0, blocked: false,
        error: provider === 'toss_sharelink' ? healthCode : `${healthCode} step=${handoffStep ?? 'unknown'}`.slice(0, 500),
        ...(provider === 'toss_sharelink' ? { diagnostics: tossFailureDiagnostics(tossFailure ?? new TossSessionError(healthCode)) } : {}),
      })).catch(() => null);
      if (tossFailure) throw tossFailure;
      throw new NativeHandoffError(healthCode);
    }
    throw error;
  } finally { updated.bytes?.fill(0); recoveryCandidate.bytes?.fill(0); }
}
