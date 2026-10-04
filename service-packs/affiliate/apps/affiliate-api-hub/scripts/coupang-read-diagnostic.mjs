import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readCoupangConsumerOfferList, coupangConsumerProductUrl } from '../adapters/coupang-consumer.mjs';
import { createCoupangVisitorContext } from '../lib/coupang-visitor-context.mjs';
import { projectCoupangReadProof } from '../lib/coupang-read-proof.mjs';

const ORIGIN = 'https://www.coupang.com';
const OFFER_PATH = '/next-api/offer-list';
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_VISITOR_CONTEXT_MAX_AGE_MS = 1_200_000;
const CONTEXT_SAFETY_MARGIN_MS = 1000;
const MAX_SLEEP_CHUNK_MS = 30_000;
const SAFE_ERROR_CODE = /^(?:COUPANG_|SESSION_|SHOPPING_)[A-Z0-9_]{1,90}$/;

export class CoupangReadDiagnosticInputError extends Error {
  constructor() { super('COUPANG_READ_DIAGNOSTIC_INPUT_INVALID'); this.code = 'COUPANG_READ_DIAGNOSTIC_INPUT_INVALID'; }
}
const inputError = () => { throw new CoupangReadDiagnosticInputError(); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeErrorCode = error => typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
  ? error.code : 'DIAGNOSTIC_FAILED';
const moneyKrw = value => value?.currency === 'KRW' && Number.isSafeInteger(value.amount) && value.amount >= 0
  ? value.amount : null;

function normalizeDiagnosticInput(input) {
  if (!isRecord(input)) inputError();
  const keys = Object.keys(input);
  if (keys.some(key => !['targets', 'repeat', 'intervalMs', 'fourthDelaySeconds'].includes(key))) inputError();
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 4) inputError();

  let targets;
  try {
    targets = input.targets.map(url => {
      if (typeof url !== 'string' || url.length > 2048) inputError();
      const identity = coupangConsumerProductUrl(url);
      return { url: identity.url, productId: identity.productId, itemId: identity.itemId,
        vendorItemId: identity.vendorItemId };
    });
  } catch {
    inputError();
  }

  let repeat = 1;
  if (Object.hasOwn(input, 'repeat')) {
    if (targets.length !== 1 || !Number.isInteger(input.repeat) || input.repeat < 1 || input.repeat > 4) inputError();
    repeat = input.repeat;
  }
  if (targets.length > 1 && Object.hasOwn(input, 'repeat')) inputError();
  const plannedReads = targets.length === 1 ? repeat : targets.length;

  const intervalMs = Object.hasOwn(input, 'intervalMs') ? input.intervalMs : DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 10_000) inputError();

  const fourthDelaySeconds = Object.hasOwn(input, 'fourthDelaySeconds') ? input.fourthDelaySeconds : 0;
  if (!Number.isInteger(fourthDelaySeconds) || fourthDelaySeconds < 0 || fourthDelaySeconds > 600
    || Object.hasOwn(input, 'fourthDelaySeconds') && plannedReads !== 4) inputError();

  const identities = targets.map(row => JSON.stringify([row.productId, row.itemId, row.vendorItemId]));
  if (new Set(identities).size !== identities.length && targets.length > 1) inputError();

  const targetForOrdinal = ordinal => targets.length === 1 ? targets[0] : targets[ordinal];
  return { targets, repeat, intervalMs, fourthDelaySeconds, plannedReads, targetForOrdinal };
}

function publicReadProofIsSafe(proof, { firstRead }) {
  return isRecord(proof)
    && proof.operation === 'offer_list'
    && proof.method === 'GET'
    && proof.origin === ORIGIN
    && proof.path === OFFER_PATH
    && proof.execution === 'pure_http'
    && ['native_fetch', 'injected'].includes(proof.transport)
    && proof.authMode === 'visitor'
    && proof.credentialSent === false
    && proof.credentialPropagated === false
    && proof.authenticatedOwnerVerified === false
    && proof.browserUsed === false
    && proof.retry === false
    && proof.redirectsFollowed === false
    && proof.exactRequestIdentityMatched === true
    && proof.visitorCookiesSent === true
    && Array.isArray(proof.visitorCookieNames)
    && proof.visitorCookieNames.includes('PCID')
    && proof.visitorCookieRotationApplied === false
    && proof.challengeConfirmed === false
    && (firstRead ? proof.visitorBootstrapStatus === 200 : proof.visitorBootstrapStatus === null);
}

function classifyStop(proof, code) {
  if (proof?.challengeConfirmed === true) return 'challenge_confirmed';
  if ([401, 403, 418, 429].includes(proof?.status)) return `access_blocked_${proof.status}`;
  if (code === 'COUPANG_VISITOR_CONTEXT_EXPIRED') return 'visitor_context_expired';
  return 'read_failed';
}

/**
 * Run a bounded public offer-list comparison in one ordinary in-memory visitor context.
 * Dependencies are injectable so regressions never need network access or local credentials.
 */
export async function runCoupangReadDiagnostic(input, {
  fetchImpl = globalThis.fetch,
  readOfferList = readCoupangConsumerOfferList,
  createVisitorContext = createCoupangVisitorContext,
  projectReadProof = projectCoupangReadProof,
  clock = () => performance.now(),
  wallClock = () => Date.now(),
  sleep = milliseconds => delay(milliseconds),
  onProgress = () => {},
  visitorContextMaxAgeMs = DEFAULT_VISITOR_CONTEXT_MAX_AGE_MS,
} = {}) {
  const plan = normalizeDiagnosticInput(input);
  if (typeof fetchImpl !== 'function' || typeof readOfferList !== 'function'
    || typeof createVisitorContext !== 'function' || typeof projectReadProof !== 'function'
    || typeof clock !== 'function' || typeof wallClock !== 'function' || typeof sleep !== 'function' || typeof onProgress !== 'function'
    || !Number.isInteger(visitorContextMaxAgeMs) || visitorContextMaxAgeMs < 1000
    || visitorContextMaxAgeMs > 1_200_000) inputError();

  const startedAt = clock();
  if (!Number.isFinite(startedAt)) inputError();
  let visitorContext;
  try {
    visitorContext = createVisitorContext({ fetchImpl, now: wallClock, maxAgeMs: visitorContextMaxAgeMs, allowRebootstrap: false });
  } catch (error) {
    return makeEarlyFailure(plan, startedAt, clock, safeErrorCode(error));
  }

  const output = {
    schemaVersion: 1,
    operation: 'coupang_public_offer_list_repeat_cooldown_diagnostic',
    checkedAt: new Date().toISOString(),
    execution: 'not_observed',
    executionMode: 'pure_http_client',
    browserUsed: false,
    ownerCredentialUsed: false,
    automaticRetry: false,
    visitorReplacementAllowed: false,
    visitorContextCreatedOnce: true,
    plannedReads: plan.plannedReads,
    attemptedReads: 0,
    failedReads: 0,
    unattemptedReads: plan.plannedReads,
    intervalMs: plan.intervalMs,
    fourthDelaySeconds: plan.fourthDelaySeconds,
    visitorContextMaxAgeMs,
    reads: [],
    actualFourthDelayMs: null,
    fourthInvoked: false,
    sameVisitorContextVerified: false,
    visitorBootstrapResponsesProjected: 0,
    fourthOrdinal403Observed: false,
    fourthRequestPerCategoryHypothesis: {
      assessment: 'not_assessed',
      currentCategoryEvidenceProvided: false,
      reason: 'Request order alone does not establish current product categories.',
    },
    states: { captured: true, client_exists: true, credential_propagated: false, remnant_free: true, live_replay: false },
    passed: false,
    stopReason: null,
    comparisonLimit: 'Measures only these exact public SKUs, spacing and this local visitor-context lifetime; it does not establish a category quota, server cooldown policy, or future availability.',
  };

  let contextCreatedAt = clock();
  if (!Number.isFinite(contextCreatedAt) || contextCreatedAt < startedAt) contextCreatedAt = startedAt;
  let previousCompletedAt = null;

  const waitUntil = async (targetAt, ordinal, label) => {
    if (targetAt - contextCreatedAt + CONTEXT_SAFETY_MARGIN_MS >= visitorContextMaxAgeMs) return false;
    while (clock() < targetAt) {
      const now = clock();
      if (!Number.isFinite(now) || now - contextCreatedAt + CONTEXT_SAFETY_MARGIN_MS >= visitorContextMaxAgeMs)
        return false;
      const remainingMs = targetAt - now;
      if (remainingMs > 1000) onProgress({ stage: 'waiting', ordinal, label,
        elapsedMs: Math.max(0, Math.round(now - (previousCompletedAt ?? now))),
        remainingMs: Math.ceil(remainingMs) });
      await sleep(Math.min(MAX_SLEEP_CHUNK_MS, Math.max(1, Math.ceil(remainingMs))));
    }
    const now = clock();
    return Number.isFinite(now) && now - contextCreatedAt + CONTEXT_SAFETY_MARGIN_MS < visitorContextMaxAgeMs;
  };

  for (let index = 0; index < plan.plannedReads; index++) {
    const ordinal = index + 1;
    const identity = plan.targetForOrdinal(index);
    const desiredGapMs = previousCompletedAt === null ? 0
      : ordinal === 4 ? Math.max(plan.intervalMs, plan.fourthDelaySeconds * 1000) : plan.intervalMs;
    const targetAt = previousCompletedAt === null ? clock() : previousCompletedAt + desiredGapMs;
    if (previousCompletedAt !== null && !(await waitUntil(targetAt, ordinal, identity.productId))) {
      output.stopReason = 'context_lifetime_guard';
      break;
    }
    const invokedAt = clock();
    if (!Number.isFinite(invokedAt) || invokedAt - contextCreatedAt + CONTEXT_SAFETY_MARGIN_MS >= visitorContextMaxAgeMs) {
      output.stopReason = 'context_lifetime_guard';
      break;
    }

    const gapMs = previousCompletedAt === null ? null : Math.max(0, Math.round(invokedAt - previousCompletedAt));
    output.attemptedReads++;
    let result = null, proof = null, code = null, nativeTransport = false;
    try {
      result = await readOfferList({ url: identity.url, authentication: 'visitor', visitorContext, fetchImpl });
      proof = projectReadProof(result?.receipt, identity);
      nativeTransport = proof?.execution === 'pure_http' && proof?.transport === 'native_fetch';
    } catch (error) {
      proof = projectReadProof(error?.receipt, identity);
      code = safeErrorCode(error);
      nativeTransport = proof?.execution === 'pure_http' && proof?.transport === 'native_fetch';
    }
    const completedAt = clock();
    previousCompletedAt = Number.isFinite(completedAt) && completedAt >= invokedAt ? completedAt : invokedAt;
    const selectedOffer = result?.selectedOffer;
    const selectedIdentityMatches = selectedOffer?.selected === true
      && selectedOffer.productId === identity.productId
      && selectedOffer.itemId === identity.itemId
      && selectedOffer.vendorItemId === identity.vendorItemId;
    const generalPriceKRW = selectedOffer?.price?.priceKind === 'offer_list_general_sale_price'
      && selectedOffer?.price?.basis === 'public_offer_list' ? moneyKrw(selectedOffer.price) : null;
    const shippingFeeKRW = selectedOffer?.shippingReadStatus === 'verified'
      && selectedOffer?.shipping?.sourceScope === 'consumer_public_offer_list'
      && selectedOffer?.shipping?.memberEligibilityVerified === false
      && selectedOffer?.shipping?.fee?.priceKind === 'public_offer_list_shipping_fee'
      && selectedOffer?.shipping?.fee?.basis === 'public_offer_list'
      ? moneyKrw(selectedOffer.shipping.fee) : null;
    const firstRead = index === 0;
    const proofSafe = publicReadProofIsSafe(proof, { firstRead });
    const success = result !== null && proof?.status === 200 && proofSafe
      && selectedIdentityMatches && generalPriceKRW !== null;
    const liveReplay = success && result?.states?.live_replay === true && nativeTransport;
    const safeRow = {
      ordinal,
      identity: { productId: identity.productId, itemId: identity.itemId, vendorItemId: identity.vendorItemId },
      status: proof?.status ?? null,
      proof,
      code: success ? null : code ?? (proof?.status === 200 ? 'COUPANG_READ_DIAGNOSTIC_SCHEMA_OR_CONTEXT' : 'DIAGNOSTIC_FAILED'),
      generalPriceKRW: success ? generalPriceKRW : null,
      shippingFeeKRW: success ? shippingFeeKRW : null,
      shippingReadStatus: success && ['verified', 'absent', 'conditional_unverified', 'invalid'].includes(selectedOffer?.shippingReadStatus)
        ? selectedOffer.shippingReadStatus : null,
      memberPriceVerified: false,
      contextBootstrapStatus: proof?.visitorBootstrapStatus ?? null,
      sameVisitorContextVerified: proofSafe && success,
      liveReplay,
      gapFromPriorCompletionMs: gapMs,
      completedAtElapsedMs: Math.max(0, Math.round(previousCompletedAt - contextCreatedAt)),
      verified: success,
    };
    output.reads.push(safeRow);
    if (ordinal === 4) {
      output.fourthInvoked = true;
      output.actualFourthDelayMs = gapMs;
      output.fourthOrdinal403Observed = proof?.status === 403;
    }
    if (!success) {
      output.failedReads++;
      output.stopReason = classifyStop(proof, safeRow.code);
      break;
    }
  }

  output.unattemptedReads = output.plannedReads - output.attemptedReads;
  output.visitorBootstrapResponsesProjected = output.reads.filter(row => row.contextBootstrapStatus !== null).length;
  output.sameVisitorContextVerified = output.reads.length === output.plannedReads
    && output.reads.every(row => row.sameVisitorContextVerified)
    && output.reads[0]?.contextBootstrapStatus === 200
    && output.reads.slice(1).every(row => row.contextBootstrapStatus === null);
  output.states.live_replay = output.reads.some(row => row.liveReplay);
  const transports = new Set(output.reads.map(row => row.proof?.transport).filter(Boolean));
  output.execution = transports.size > 1 ? 'mixed'
    : transports.has('native_fetch') ? 'pure_http'
      : transports.has('injected') ? 'injected' : 'not_observed';
  output.passed = output.stopReason === null && output.attemptedReads === output.plannedReads
    && output.reads.every(row => row.verified);
  if (!output.stopReason && output.unattemptedReads > 0) output.stopReason = 'incomplete';
  output.completedAt = new Date().toISOString();
  return output;
}

function makeEarlyFailure(plan, startedAt, clock, code) {
  const completedAt = clock();
  return {
    schemaVersion: 1,
    operation: 'coupang_public_offer_list_repeat_cooldown_diagnostic',
    checkedAt: new Date().toISOString(),
    execution: 'not_observed',
    executionMode: 'pure_http_client',
    browserUsed: false,
    ownerCredentialUsed: false,
    automaticRetry: false,
    visitorReplacementAllowed: false,
    visitorContextCreatedOnce: false,
    plannedReads: plan.plannedReads,
    attemptedReads: 0,
    failedReads: 0,
    unattemptedReads: plan.plannedReads,
    reads: [],
    sameVisitorContextVerified: false,
    visitorBootstrapResponsesProjected: 0,
    states: { captured: true, client_exists: true, credential_propagated: false, remnant_free: true, live_replay: false },
    passed: false,
    stopReason: 'visitor_context_creation_failed',
    code,
    elapsedMs: Number.isFinite(completedAt) && Number.isFinite(startedAt) ? Math.max(0, Math.round(completedAt - startedAt)) : null,
  };
}

export async function main({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let input;
  try {
    let body = '';
    for await (const chunk of stdin) {
      body += chunk;
      if (Buffer.byteLength(body) > 32 * 1024) throw new CoupangReadDiagnosticInputError();
    }
    input = JSON.parse(body);
  } catch {
    stdout.write(JSON.stringify({ errorCode: 'COUPANG_READ_DIAGNOSTIC_INPUT_INVALID', attemptedReads: 0, failedReads: 0 }) + '\n');
    return 2;
  }

  try {
    const result = await runCoupangReadDiagnostic(input, {
      onProgress: event => {
        if (input?.fourthDelaySeconds >= 30) stderr.write(JSON.stringify({ ...event, progressOnly: true }) + '\n');
      },
    });
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.passed ? 0 : 1;
  } catch (error) {
    stdout.write(JSON.stringify({ errorCode: safeErrorCode(error), attemptedReads: 0, failedReads: 0 }) + '\n');
    return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await main();
}
