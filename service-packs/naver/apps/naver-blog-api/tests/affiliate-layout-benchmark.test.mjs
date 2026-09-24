import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const benchmark = JSON.parse(
  await readFile(new URL('../research/naver-storage-layout-benchmark-2026-09-20.json', import.meta.url), 'utf8'),
);

test('layout benchmark distinguishes OG thumbnails from custom Coupang banners', () => {
  assert.equal(benchmark.method.analyzedPosts, 30);
  assert.equal(benchmark.failures.length, 0);
  assert.equal(benchmark.ourPost.ctaStyle, 'og_link_card');
  assert.equal(benchmark.ourPost.ogAffiliateLinkCount, 1);
  assert.equal(benchmark.ourPost.customLinkedCoupangBannerCount, 0);
  assert.equal(benchmark.topAuthoritySummary.rates.hasCoupangImageBanner, 0);
});

test('layout benchmark exposes the actual visual gaps in the current post', () => {
  const delta = benchmark.ourVsTopAuthority;
  assert.equal(delta.imageCount.delta, -5);
  assert.equal(delta.headingCount.delta, -3);
  assert.equal(delta.componentCount.delta, -17);
  assert.equal(delta.ogLinkCount.delta, 0);
  assert.ok(delta.imageDensityPer1000Chars.percentile <= 10);
});

test('authority cohort is based on current search exposure, not an unsupported follower claim', () => {
  assert.match(benchmark.method.definitionOfAuthority, /top-3 exposure/);
  assert.match(benchmark.method.definitionOfAuthority, /not a follower-count claim/);
  assert.ok(benchmark.topAuthoritySummary.postCount >= 10);
});
