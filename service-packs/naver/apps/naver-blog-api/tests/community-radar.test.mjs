import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('community radar is public metadata-only and never imports browser automation', async () => {
  const source = await readFile(new URL('../research/community-radar/run.py', import.meta.url), 'utf8');
  assert.match(source, /where=article/);
  assert.match(source, /personalUsernamesCaptured/);
  assert.match(source, /fullCommentsCaptured/);
  assert.doesNotMatch(source, /playwright|selenium|cookie|authorization/i);
});

test('community issue taxonomy includes the product decision risks', async () => {
  const source = await readFile(new URL('../research/community-radar/run.py', import.meta.url), 'utf8');
  for (const issue of ['heat', 'case_compatibility', 'actual_capacity', 'port_strain', 'durability']) {
    assert.match(source, new RegExp(`"${issue}"`));
  }
});

test('community radar supports committed category profiles without weakening the default taxonomy', async () => {
  const source = await readFile(new URL('../research/community-radar/run.py', import.meta.url), 'utf8');
  const profile = JSON.parse(await readFile(
    new URL('../research/community-radar/profiles/home-storage.json', import.meta.url),
    'utf8',
  ));
  assert.match(source, /--profile/);
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.name, 'home-storage');
  for (const issue of ['fit_measurement', 'load_capacity', 'moisture_hygiene', 'plastic_durability']) {
    assert.ok(profile.issues[issue]?.length > 0, `missing profile issue: ${issue}`);
    assert.ok(profile.questions[issue], `missing profile question: ${issue}`);
  }
});
