import { validateClaim } from '../../../../packages/contracts/src/index.mjs';

function validDate(value) {
  return Number.isFinite(Date.parse(String(value || '')));
}

export function evaluateClaimEvidenceGate(ledger, { now = new Date(), draft = '' } = {}) {
  const evidence = ledger?.evidence && typeof ledger.evidence === 'object' && !Array.isArray(ledger.evidence)
    ? ledger.evidence
    : {};
  const claims = Array.isArray(ledger?.claims) ? ledger.claims : [];
  const errors = [];
  const ids = new Set();
  const expiredClaims = [];
  const unresolvedPublishableClaims = [];
  const missingSources = [];
  const invalidEvidenceDates = [];

  for (const [id, item] of Object.entries(evidence)) {
    if (!item || typeof item !== 'object') errors.push(`evidence_${id}_invalid`);
    if (!validDate(item?.checkedAt)) invalidEvidenceDates.push(id);
  }
  for (const claim of claims) {
    try { validateClaim(claim); }
    catch (error) { errors.push(`${claim?.claimId || 'unknown'}:${error.message}`); continue; }
    if (ids.has(claim.claimId)) errors.push(`duplicate_claim_${claim.claimId}`);
    ids.add(claim.claimId);
    for (const source of claim.sources) {
      if (!evidence[source]) missingSources.push(`${claim.claimId}:${source}`);
    }
    if (claim.expiresAt && (!validDate(claim.expiresAt) || Date.parse(claim.expiresAt) < now.getTime())) {
      expiredClaims.push(claim.claimId);
    }
    if (claim.publishable === true && claim.support !== 'supports') {
      unresolvedPublishableClaims.push(claim.claimId);
    }
    if (claim.forbiddenWording && String(draft).includes(claim.forbiddenWording)) {
      errors.push(`forbidden_wording_${claim.claimId}`);
    }
  }

  const checks = {
    schemaVersion: ledger?.schemaVersion === 1,
    evidencePresent: Object.keys(evidence).length > 0,
    claimsPresent: claims.length > 0,
    claimSchemasValid: errors.filter(value => !value.startsWith('forbidden_wording_')).length === 0,
    claimIdsUnique: claims.length === ids.size,
    evidenceDatesValid: invalidEvidenceDates.length === 0,
    sourceReferencesResolve: missingSources.length === 0,
    noExpiredClaims: expiredClaims.length === 0,
    noUnsupportedPublishableClaims: unresolvedPublishableClaims.length === 0,
    forbiddenWordingAbsent: errors.filter(value => value.startsWith('forbidden_wording_')).length === 0,
    uncertaintyExplicit: claims
      .filter(claim => claim.support !== 'supports')
      .every(claim => claim.claimType === 'uncertainty' || typeof claim.allowedWording === 'string'),
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name);
  return {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    metrics: {
      evidenceCount: Object.keys(evidence).length,
      claimCount: claims.length,
      supportedCount: claims.filter(claim => claim.support === 'supports').length,
      unresolvedCount: claims.filter(claim => claim.support !== 'supports').length,
    },
    details: {
      errors,
      invalidEvidenceDates,
      missingSources,
      expiredClaims,
      unresolvedPublishableClaims,
    },
  };
}
