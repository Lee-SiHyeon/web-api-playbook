import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileImagePrompt } from '../research/image-prompts/build.mjs';

const preset = JSON.parse(await readFile(
  new URL('../research/image-prompts/home-room-product-snapshot.json', import.meta.url),
  'utf8',
));

test('home-room prompt compiler separates positive, negative and disclosure contracts', () => {
  const result = compileImagePrompt(preset, {
    variant: 'kitchen_gap',
    subject: '아이보리색 3단 슬림 트롤리',
    timeWeather: '흐린 오전',
    colorTone: '따뜻하지만 채도를 낮춘 아이폰 기본 색감',
    siteDetails: '12cm 남짓한 틈, 바닥 걸레받이, 사용 중인 양념병과 키친타월',
  });
  assert.match(result.prompt, /아이보리색 3단 슬림 트롤리/);
  assert.match(result.prompt, /냉장고와 수납장 사이/);
  assert.match(result.negativePrompt, /3D 렌더/);
  assert.equal(result.disclosure.mayBeUsedAsDirectExperienceEvidence, false);
});

test('home-room prompt compiler fails closed when material slots are missing', () => {
  assert.throws(() => compileImagePrompt(preset, { variant: 'kitchen_gap' }), /missing required image prompt slots/);
});
