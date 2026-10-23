import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OWNER = 'lifehack__ailab';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const validId = value => typeof value === 'string' && /^\d{10,25}$/.test(value);

export function threadsBenefitRuntimeRoot() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'threads-benefits');
}

export function THREADS_BENEFIT_CONFIG_PATH(root = threadsBenefitRuntimeRoot()) {
  return path.join(root, 'promotion.json');
}

function validPromotionUrl(value, owner) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === 'https://www.threads.com'
      && new RegExp(`^/@${owner}/post/[A-Za-z0-9_-]{5,64}/?$`).test(url.pathname)
      && !url.search && !url.hash;
  } catch { return false; }
}

export function validateThreadsBenefitConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || String(value.owner ?? '').toLowerCase() !== OWNER
    || !validId(value.activePromotionId)
    || !validPromotionUrl(value.url, OWNER)
    || value.readbackVerified !== true
    || value.pinReadbackVerified !== true
    || value.previousPromotionPinRemovedVerified !== true
    || !Array.isArray(value.previousPromotionIds)
    || value.previousPromotionIds.some(id => !validId(id))) fail('THREADS_BENEFIT_CONFIG_INVALID');

  const previousPromotionIds = [...new Set(value.previousPromotionIds)];
  if (previousPromotionIds.length !== value.previousPromotionIds.length
    || previousPromotionIds.includes(value.activePromotionId)) fail('THREADS_BENEFIT_CONFIG_INVALID');

  return Object.freeze({
    owner: OWNER,
    activePromotionId: value.activePromotionId,
    url: value.url,
    readbackVerified: true,
    pinReadbackVerified: true,
    previousPromotionPinRemovedVerified: true,
    previousPromotionIds: Object.freeze(previousPromotionIds),
    ...(typeof value.configuredAt === 'string' && Number.isFinite(Date.parse(value.configuredAt))
      ? { configuredAt: value.configuredAt } : {}),
    ...(Number.isSafeInteger(value.revision) && value.revision > 0 ? { revision: value.revision } : {}),
  });
}

export async function readThreadsBenefitConfig({ root = threadsBenefitRuntimeRoot(), readFileFn = readFile } = {}) {
  let raw;
  try { raw = await readFileFn(THREADS_BENEFIT_CONFIG_PATH(root), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') fail('THREADS_BENEFIT_CONFIG_MISSING');
    throw error;
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 32_768) fail('THREADS_BENEFIT_CONFIG_INVALID');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('THREADS_BENEFIT_CONFIG_INVALID'); }
  return validateThreadsBenefitConfig(parsed);
}

export async function resolveThreadsBenefitConfig({ promotionConfig, root, readFileFn } = {}) {
  return promotionConfig == null
    ? readThreadsBenefitConfig({ root: root ?? threadsBenefitRuntimeRoot(), readFileFn })
    : validateThreadsBenefitConfig(promotionConfig);
}

export function assertThreadsBenefitPromotionBinding(state, config) {
  if (state?.activePromotionId == null) return false;
  if (!validId(state.activePromotionId) || state.activePromotionId !== config.activePromotionId
    || state.activePromotionUrl && state.activePromotionUrl !== config.url) {
    fail('THREADS_BENEFIT_ACTIVE_PROMOTION_CHANGED_REVIEW_REQUIRED');
  }
  return true;
}

export function bindThreadsBenefitPromotion(state, config, at = new Date().toISOString()) {
  assertThreadsBenefitPromotionBinding(state, config);
  if (state.previousPromotionIds != null && (!Array.isArray(state.previousPromotionIds)
    || state.previousPromotionIds.some(id => !validId(id)))) fail('THREADS_BENEFIT_STATE_INVALID');
  if (state.activePromotionId == null) {
    state.activePromotionId = config.activePromotionId;
    state.activePromotionUrl = config.url;
    state.activePromotionBoundAt = at;
  }
  state.previousPromotionIds = [...new Set([...(state.previousPromotionIds || []), ...config.previousPromotionIds])];
  return state;
}
