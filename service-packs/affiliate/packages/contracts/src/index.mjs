import { createHash } from 'node:crypto';

export const WORKFLOW_STATES = Object.freeze([
  'trend_observed',
  'intent_selected',
  'content_collision_checked',
  'evidence_collected',
  'product_set_normalized',
  'claims_supported',
  'draft_reviewable',
  'publish_authorized',
  'publish_verified',
  'attribution_observed',
  'outcome_evaluated',
  'refreshed_or_retired',
]);

export const TERMINAL_DECISIONS = Object.freeze([
  'selected_product',
  'alternative_product',
  'no_recommendation',
  'insufficient_evidence',
]);

export const CONTENT_COLLISION_DECISIONS = Object.freeze([
  'create', 'update', 'merge', 'differentiate', 'skip',
]);

export const CLAIM_SUPPORT = Object.freeze([
  'supports', 'contradicts', 'not_addressed', 'uncertain',
]);

export const ADAPTER_ROLES = Object.freeze([
  'monetization', 'inventory', 'discovery', 'enrichment',
  'evidence', 'attribution', 'reservation_watch',
]);

export const ADAPTER_ACCESS_STATES = Object.freeze([
  'public', 'api_key', 'partner_approval', 'account_portal',
  'manual_review', 'excluded',
]);

export const ADAPTER_VERIFICATION_STATES = Object.freeze([
  'official_docs_confirmed', 'partner_scope_to_verify',
  'live_read_verified', 'live_write_verified', 'design_only',
]);

export const ADAPTER_PRIORITIES = Object.freeze([
  'P0', 'P1', 'P2', 'ENRICHMENT', 'WATCH', 'EXCLUDE',
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function validateRunManifest(manifest) {
  assertPlainObject(manifest, 'manifest');
  for (const field of ['runId', 'goal', 'createdAt', 'codeHash', 'inputHash', 'templateHash', 'rubricHash']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) throw new TypeError(`manifest.${field} is required`);
  }
  return true;
}

export function validateProductCandidate(product) {
  assertPlainObject(product, 'product');
  for (const field of ['provider', 'productId', 'title', 'checkedAt']) {
    if (typeof product[field] !== 'string' || !product[field].trim()) throw new TypeError(`product.${field} is required`);
  }
  if (product.payablePriceKrw !== undefined && (!Number.isFinite(product.payablePriceKrw) || product.payablePriceKrw < 0)) {
    throw new TypeError('product.payablePriceKrw must be a non-negative number');
  }
  return true;
}

export function validateClaim(claim) {
  assertPlainObject(claim, 'claim');
  if (typeof claim.claimId !== 'string' || !claim.claimId) throw new TypeError('claim.claimId is required');
  if (typeof claim.text !== 'string' || !claim.text) throw new TypeError('claim.text is required');
  if (!CLAIM_SUPPORT.includes(claim.support)) throw new TypeError('claim.support is invalid');
  if (!Array.isArray(claim.sources) || claim.sources.length === 0) throw new TypeError('claim.sources must not be empty');
  return true;
}


export function validateAdapterCandidate(adapter) {
  assertPlainObject(adapter, 'adapter');
  for (const field of ['id', 'name', 'accessState', 'verification', 'priority']) {
    if (typeof adapter[field] !== 'string' || !adapter[field].trim()) {
      throw new TypeError(`adapter.${field} is required`);
    }
  }
  if (!ADAPTER_ACCESS_STATES.includes(adapter.accessState)) throw new TypeError('adapter.accessState is invalid');
  if (!ADAPTER_VERIFICATION_STATES.includes(adapter.verification)) throw new TypeError('adapter.verification is invalid');
  if (!ADAPTER_PRIORITIES.includes(adapter.priority)) throw new TypeError('adapter.priority is invalid');
  if (!Array.isArray(adapter.roles) || adapter.roles.length === 0 || adapter.roles.some(role => !ADAPTER_ROLES.includes(role))) {
    throw new TypeError('adapter.roles is invalid');
  }
  if (!Array.isArray(adapter.verticals) || adapter.verticals.length === 0 || adapter.verticals.some(value => typeof value !== 'string' || !value)) {
    throw new TypeError('adapter.verticals is invalid');
  }
  if (!Array.isArray(adapter.capabilities) || adapter.capabilities.some(value => typeof value !== 'string' || !value)) {
    throw new TypeError('adapter.capabilities is invalid');
  }
  if (adapter.verification !== 'design_only'
    && (!Array.isArray(adapter.officialSources) || adapter.officialSources.length === 0)) {
    throw new TypeError('adapter.officialSources is required for verified adapters');
  }
  return true;
}

export function createStepReceipt({ runId, step, state, inputs, outputs, completionContract, version }) {
  if (!WORKFLOW_STATES.includes(state)) throw new TypeError('state is invalid');
  const receipt = {
    schemaVersion: 1,
    runId,
    step,
    state,
    inputs,
    outputs,
    completionContract,
    version,
  };
  return { ...receipt, receiptHash: fingerprint(receipt) };
}
