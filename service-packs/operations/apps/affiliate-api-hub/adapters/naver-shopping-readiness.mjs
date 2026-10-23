import { ACCOUNT_OPERATIONS } from './partner-account-probes.mjs';

// This is a preparation gate, never a link-generation or publishing authority.
// Input is the sanitized output of the existing independent HTTP account runner.
export function evaluateShoppingReadiness(probe, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('INVALID_CLOCK');
  const account = probe?.services?.brandconnect;
  const operation = ACCOUNT_OPERATIONS.brandconnect;
  const age = now - Date.parse(account?.checkedAt ?? '');
  const authenticRead = account?.ok === true && account.service === 'brandconnect'
    && account.method === 'GET' && account.origin === operation.origin && account.path === operation.path
    && account.httpStatus === 200 && account.authenticated === true && account.identityVerified === true
    && account.credentialPropagated === true && account.executionMode === 'pure_http' && account.browserUsed === false;
  const stages = { accountRead: 'unverified', creator: 'unverified', space: 'unverified',
    affiliateTerms: 'unverified', productSearch: 'unverified', productDetail: 'unverified',
    linkIssue: 'unverified', linkReadback: 'unverified', outcomes: 'unverified' };
  let status = 'account_probe_required';
  let nextAction = 'Run the current scoped Brandconnect account probe through the independent HTTP runner.';
  if (authenticRead) {
    if (!Number.isFinite(age) || age < 0 || age > 300000) {
      status = 'fresh_account_probe_required';
    } else {
      stages.accountRead = 'verified';
      if (account.entitlement?.creator !== true || account.entitlement?.accountAssigned !== true) {
        status = 'blocked_creator_access';
        stages.creator = 'missing';
        nextAction = 'Resolve creator/account access through the official service.';
      } else {
        stages.creator = 'verified';
        const space = account.spaceStatus;
        if (space?.observed !== true || !Number.isSafeInteger(space.activeSpaceCount) || space.activeSpaceCount < 0
          || !Number.isSafeInteger(space.spaceCount) || space.spaceCount < space.activeSpaceCount
          || typeof space.selectedSpaceAssigned !== 'boolean') {
          status = 'space_state_unverified';
          nextAction = 'Refresh the account space schema and inspect the official creator entry page.';
        } else if (space.activeSpaceCount === 0) {
          stages.space = space.waitingSpace === true ? 'pending' : 'missing';
          status = space.waitingSpace === true ? 'blocked_space_pending' : 'blocked_space_setup';
          nextAction = 'Complete or resolve creator-space setup, then verify the active space and affiliate terms separately.';
        } else {
          stages.space = 'active_present';
          status = 'ready_for_scoped_discovery';
          nextAction = 'Select the intended creator space; verify affiliate terms and observe product/search/link contracts before implementation.';
        }
      }
    }
  }
  return { schemaVersion: 1, provider: 'naver-shopping-connect', checkedAt: new Date(now).toISOString(),
    status, stages, nextAction,
    readyForScopedDiscovery: status === 'ready_for_scoped_discovery',
    commercialOperationsEnabled: false, publishingEnabled: false,
    freshnessPolicy: { maxAgeMs: 300000, source: 'local_receipt_policy_not_server_session_ttl' } };
}
