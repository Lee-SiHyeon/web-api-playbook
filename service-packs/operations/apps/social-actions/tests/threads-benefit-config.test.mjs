import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { THREADS_BENEFIT_CONFIG_PATH, bindThreadsBenefitPromotion, readThreadsBenefitConfig,
  validateThreadsBenefitConfig } from '../threads-benefit-config.mjs';

const OLD = '3996994421430736442';
const ACTIVE = '3997000000000000123';
const config = () => ({ owner: 'lifehack__ailab', activePromotionId: ACTIVE,
  url: 'https://www.threads.com/@lifehack__ailab/post/Dd6AAAAAA1', readbackVerified: true,
  pinReadbackVerified: true, previousPromotionPinRemovedVerified: true, previousPromotionIds: [OLD] });

test('runtime promotion config requires verified active pin and removal of the previous pin', () => {
  assert.equal(validateThreadsBenefitConfig(config()).activePromotionId, ACTIVE);
  for (const field of ['readbackVerified', 'pinReadbackVerified', 'previousPromotionPinRemovedVerified']) {
    assert.throws(() => validateThreadsBenefitConfig({ ...config(), [field]: false }),
      { code: 'THREADS_BENEFIT_CONFIG_INVALID' });
  }
  assert.throws(() => validateThreadsBenefitConfig({ ...config(), url: 'https://www.threads.com/share/BBK7k3y_8E/' }),
    { code: 'THREADS_BENEFIT_CONFIG_INVALID' });
  assert.throws(() => validateThreadsBenefitConfig({ ...config(), previousPromotionIds: [ACTIVE] }),
    { code: 'THREADS_BENEFIT_CONFIG_INVALID' });
});

test('config is read only from the runtime promotion file and a missing config has no static fallback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-benefit-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(readThreadsBenefitConfig({ root }), { code: 'THREADS_BENEFIT_CONFIG_MISSING' });
  await mkdir(root, { recursive: true });
  await writeFile(THREADS_BENEFIT_CONFIG_PATH(root), JSON.stringify(config()), 'utf8');
  const loaded = await readThreadsBenefitConfig({ root });
  assert.equal(loaded.activePromotionId, ACTIVE);
  assert.deepEqual(loaded.previousPromotionIds, [OLD]);
  assert.equal(Object.isFrozen(loaded.previousPromotionIds), true);
});

test('the active promotion ID and URL are bound on first execution and later revision changes fail closed', () => {
  const state = {};
  bindThreadsBenefitPromotion(state, validateThreadsBenefitConfig(config()), '2026-09-30T10:00:00.000Z');
  assert.equal(state.activePromotionId, ACTIVE);
  assert.equal(state.previousPromotionIds[0], OLD);
  assert.throws(() => bindThreadsBenefitPromotion(state, validateThreadsBenefitConfig({ ...config(),
    activePromotionId: '3997000000000000456', url: 'https://www.threads.com/@lifehack__ailab/post/Dd6AAAAAA2' })),
  { code: 'THREADS_BENEFIT_ACTIVE_PROMOTION_CHANGED_REVIEW_REQUIRED' });
});
