import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildOntology, pick } from '../research/content-store/code-video-references.mjs';

const v = (slug, author, prompt) => ({ slug, author, post_url: `https://x.com/${author}/status/1`, category: 'motion', tech_tags: ['canvas'], prompt });

test('formats come from the opening of the brief, techniques and devices from the whole prompt', () => {
  const x = classify(v('a', 'a', `Build a looping infinite zoom: the camera travels from landscape to landscape. 1080x1920, 24 fps, render(t) deterministic.${' filler'.repeat(200)} a bar chart appears`));
  assert.deepEqual(x.formats.sort(), ['loop_art', 'map_travel']);
  assert.ok(x.techniques.includes('camera_move') && x.techniques.includes('match_cut'));
  assert.ok(x.devices.includes('exact_spec') && x.devices.includes('draw_t_function'));
  assert.ok(x.genres.includes('travel'));
  assert.ok(x.excerpt.length <= 280);
  assert.match(x.prompt, /a bar chart appears/);
});

test('pick returns one reference per author and per reposted prompt, best fit first', () => {
  const shared = 'Make a 20-second travel postcard video: the camera flies over a map with a match cut to each city, 9:16, 30 fps.';
  const o = buildOntology([v('a', 'a', shared), v('b', 'b', shared), v('c', 'c', 'A travel map loop with an infinite zoom between landscapes.'),
    v('d', 'd', 'Make a product ad with a countdown.')], { checkedAt: '2026-09-29' });
  const r = pick(o, { genre: 'travel', n: 5 });
  assert.equal(r.length, 2);
  assert.equal(new Set(r.map(x => x.author)).size, 2);
  assert.throws(() => pick(o, { genre: 'nope' }), /unknown genre/);
});
