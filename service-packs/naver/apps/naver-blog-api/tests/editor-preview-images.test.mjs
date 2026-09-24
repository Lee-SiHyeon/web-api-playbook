import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {loadEditorPreviewImages,loadEditorPreviewVideos} from '../scripts/hybrid/editor-preview.mjs';

let browser;
before(async () => {browser = await chromium.launch({channel: 'chromium', headless: true});});
after(async () => {await browser?.close();});
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="navy"/></svg>';
const placeholder = 'data:image/svg+xml,' + encodeURIComponent(svg);

async function fixture(html) {
  const page = await browser.newPage({viewport: {width: 800, height: 600}});
  await page.route('**://images.example/**', route => route.fulfill({status: 200, contentType: 'image/svg+xml', body: svg}));
  await page.setContent(`<style>.se-canvas{height:300px;overflow:auto}.gap{height:1400px}img{width:240px;height:120px;display:block}</style><div class="se-canvas">${html}</div>`);
  return {page, canvas: page.locator('.se-canvas')};
}

test('scrolls the actual editor viewport to load every below-fold image and returns only observed URLs', async () => {
  const {page, canvas} = await fixture([1, 2, 3].map(i => `<div class="gap"></div><div class="se-image"><img src="${placeholder}" data-lazy="https://images.example/${i}.svg"></div>`).join(''));
  try {
    await page.evaluate(() => {
      const root = document.querySelector('.se-canvas');
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          entry.target.src = entry.target.dataset.lazy;
          observer.unobserve(entry.target);
        }
      }, {root});
      for (const img of root.querySelectorAll('img')) observer.observe(img);
    });
    assert.ok((await canvas.locator('img').evaluateAll(imgs => imgs.map(i => i.src))).every(s => s.startsWith('data:')));
    assert.deepEqual(await loadEditorPreviewImages(canvas), [1, 2, 3].map(i => `https://images.example/${i}.svg`));
    assert.ok(await canvas.evaluate(e => e.scrollTop > 3000));
    assert.deepEqual(await canvas.locator('img').evaluateAll(imgs => imgs.map(i => ({loaded: i.complete && i.naturalWidth > 0, source: i.currentSrc}))), [1, 2, 3].map(i => ({loaded: true, source: `https://images.example/${i}.svg`})));
  } finally {await page.close();}
});

test('a successfully decoded SVG placeholder never passes as the article image', async () => {
  const {page, canvas} = await fixture(`<div class="se-image"><img src="${placeholder}"></div>`);
  try {
    await canvas.locator('img').evaluate(img => img.decode());
    assert.ok(await canvas.locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
    await assert.rejects(loadEditorPreviewImages(canvas, {timeoutMs: 150}), /NATIVE_IMAGE_NOT_LOADED/);
    assert.equal(await canvas.locator('img').getAttribute('src'), placeholder);
  } finally {await page.close();}
});

test('loaded HTTP resources and failed HTTPS resources fail closed', async () => {
  for (const source of ['http://images.example/insecure.svg', 'https://broken.example/missing.png']) {
    const {page, canvas} = await fixture(`<div class="se-image"><img src="${source}"></div>`);
    try {
      await page.route('https://broken.example/**', route => route.abort());
      await assert.rejects(loadEditorPreviewImages(canvas, {timeoutMs: 150}), /NATIVE_IMAGE_NOT_LOADED/);
      assert.equal(await canvas.locator('img').getAttribute('src'), source);
    } finally {await page.close();}
  }
});

test('video preview verifies the observed CSS thumbnail without promoting a placeholder image',async()=>{
 const {page,canvas}=await fixture('<div class="gap"></div><div class="se-component se-video" data-compid="video-observed"><div class="se-video-thumbnail" style="width:240px;height:120px;background-image:url(https://images.example/video.svg)"><img src="'+placeholder+'"></div></div>');
 try{
  const result=await loadEditorPreviewVideos(canvas);
  assert.equal(result['video-observed'].source,'https://images.example/video.svg');
  assert.equal(result['video-observed'].sourceKind,'observed_native_css_background');
  assert.equal(result['video-observed'].loaded,true);
  assert.equal(await canvas.locator('img').getAttribute('src'),placeholder);
  await canvas.locator('.se-video-thumbnail').evaluate(e=>{e.style.backgroundImage='none'});
  await assert.rejects(loadEditorPreviewVideos(canvas),/NATIVE_VIDEO_BACKGROUND_MISSING/);
 }finally{await page.close();}
});
