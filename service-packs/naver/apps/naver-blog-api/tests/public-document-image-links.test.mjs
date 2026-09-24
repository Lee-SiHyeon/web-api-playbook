import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicDocument } from '../scripts/api/public-document.mjs';

const url = 'https://blog.naver.com/PostView.naver?blogId=aicandoanything&logNo=224418405166';
const affiliate = 'https://myrealt.rip/rErE45';
const source = 'https://postfiles.pstatic.net/example/banner.png';
const classes = 'se-module-image-link-use se-module-image-link __se_image_link __se_link';
const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;');
const img = `<img src="${source}?type=w80_blur" data-lazy-src="${source}?type=w773">`;
const component = content => `<div class="se-component se-image" id="SE-banner">${content}</div>`;
const html = content => `<meta property="og:url" content="https://blog.naver.com/aicandoanything/224418405166"><meta property="og:title" content="Banner test"><div id="post-view224418405166"><div class="se-main-container">${content}</div></div>`;
const parse = content => parsePublicDocument(html(content), { url });
// Minimal public structure observed on the actual Naver post, 2026-09-21.
const nativeAnchor = ({ data, rawData, linktype = 'img', className = classes, tag = 'a', href = '#' } = {}) => {
  const encoded = rawData ?? JSON.stringify(data ?? { id: 'SE-banner', src: source, linkUse: 'true', link: affiliate });
  return `<${tag} href="${href}" class="${className}" onclick="return false;" data-linktype="${linktype}" data-linkdata='${escapeAttr(encoded)}'>${img}</${tag}>`;
};
const assertNotLinked = content => {
  const result = parse(content);
  assert.equal(result.units.filter(u => u.type === 'image').length, 1);
  assert.equal(result.units.find(u => u.type === 'image').href, undefined);
  assert.equal(result.links.includes(affiliate), false);
};

test('public Naver enabled image data resolves its target in both the image unit and links', () => {
  const result = parse(component(nativeAnchor()));
  assert.equal(result.targetIdentityVerified, true);
  assert.deepEqual(result.units, [{ type: 'image', value: source, href: affiliate }]);
  assert.deepEqual(result.links, [affiliate]);
  assert.equal(result.imageResources[0].url, `${source}?type=w773`);
});

test('ordinary HTTPS image anchors remain supported', () => {
  const result = parse(component(`<a href="${affiliate}">${img}</a>`));
  assert.equal(result.units[0].href, affiliate);
  assert.deepEqual(result.links, [affiliate]);
});

for (const [name, options] of [
  ['malformed JSON', { rawData: '{"linkUse":' }],
  ['null JSON', { rawData: 'null' }],
  ['array JSON', { rawData: '[{"linkUse":"true","link":"https://myrealt.rip/rErE45"}]' }],
  ['disabled string flag', { data: { linkUse: 'false', link: affiliate } }],
  ['boolean flag unsupported by the viewer', { data: { linkUse: true, link: affiliate } }],
  ['missing enable flag', { data: { link: affiliate } }],
  ['different link type', { linktype: 'text' }],
  ['missing enabled-image class', { className: 'se-module-image-link __se_image_link __se_link' }],
  ['missing delegated-handler class', { className: 'se-module-image-link-use __se_image_link' }],
  ['attributes on a non-anchor element', { tag: 'span' }],
  ['disabled native link cannot fall back to a misleading raw href', { href: affiliate, data: { linkUse: 'false', link: affiliate } }],
]) {
  test(`does not accept ${name}`, () => assertNotLinked(component(nativeAnchor(options))));
}

for (const link of ['http://myrealt.rip/rErE45', 'javascript:alert(1)', '//myrealt.rip/rErE45', 'https://user:pass@myrealt.rip/rErE45', 'https://myrealt.rip/rErE45\n']) {
  test(`rejects unsafe or non-HTTPS data target ${JSON.stringify(link)}`, () => {
    const result = parse(component(nativeAnchor({ data: { linkUse: 'true', link } })));
    assert.equal(result.units[0].href, undefined);
    assert.deepEqual(result.links, []);
  });
}

test('image metadata on an arbitrary anchor outside an image component does not supply a link', () => {
  const result = parse(`<div class="se-component se-text">${nativeAnchor()}</div>`);
  assert.equal(result.units.length, 0);
  assert.equal(result.links.includes(affiliate), false);
});

test('an unrelated ancestor cannot supply image-link metadata', () => {
  assertNotLinked(component(`<span class="${classes}" data-linktype="img" data-linkdata='{"linkUse":"true","link":"${affiliate}"}'><a href="#">${img}</a></span>`));
});

test('only the enabled banner is linked among ordinary Naver image components', () => {
  const result = parse(component(nativeAnchor()) + component(nativeAnchor({ data: { linkUse: 'false', link: '' } })));
  assert.equal(result.units.length, 2);
  assert.equal(result.units[0].href, affiliate);
  assert.equal(result.units[1].href, undefined);
  assert.deepEqual(result.links, [affiliate]);
});
