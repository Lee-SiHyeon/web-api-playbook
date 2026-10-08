import test from 'node:test';
import assert from 'node:assert/strict';
import { productKey, parseBannerResponses } from '../lib/web-auth/coupang-banner.mjs';

test('exact option key from a Coupang product URL; other shapes are refused', () => {
  assert.deepEqual(productKey('https://www.coupang.com/vp/products/1271064981?itemId=2743467546&vendorItemId=70733487961'),
    { productId: '1271064981', itemId: '2743467546', vendorItemId: '70733487961', key: '1271064981:2743467546:70733487961' });
  assert.throws(() => productKey('https://www.coupang.com/vp/products/1271064981'), /BANNER_PRODUCT_URL_INVALID/);
  assert.throws(() => productKey('https://evil.example/vp/products/1?itemId=2&vendorItemId=3'), /BANNER_PRODUCT_URL_INVALID/);
});

test('portal banner payloads: iframe fields and the banner/gen payload that is the image HTML itself', () => {
  const iframe = { shortUrl: 'https://link.coupang.com/a/hGqlQOL5Ii', title: 't', description: 'd', imageUrl: 'https://t1c.coupangcdn.com/x.jpg',
    iframeHtmlTagBorderOn: '<iframe src="https://coupa.ng/cp1nz4" width="120" height="240" frameborder="0" scrolling="no" referrerpolicy="unsafe-url"></iframe>' };
  const image = '<a href="https://link.coupang.com/a/hGquv6BkxE" target="_blank" referrerpolicy="unsafe-url"><img src="https://image12.coupangcdn.com/image/affiliate/banner/f1@2x.jpg" alt="a" width="120" height="240"></a>';
  const r = parseBannerResponses(iframe, image, 'k');
  assert.equal(r.iframe.src, 'https://coupa.ng/cp1nz4');
  assert.deepEqual([r.iframe.width, r.iframe.height], [120, 240]);
  assert.equal(r.image.src, 'https://image12.coupangcdn.com/image/affiliate/banner/f1@2x.jpg');
  assert.equal(r.image.href, 'https://link.coupang.com/a/hGquv6BkxE');
  assert.equal(parseBannerResponses(iframe, { imageHtmlTag: image }, 'k').image.href, 'https://link.coupang.com/a/hGquv6BkxE');
  assert.throws(() => parseBannerResponses({ ...iframe, shortUrl: 'https://evil.example/a/x' }, image, 'k'), /BANNER_SHORT_URL_INVALID/);
});
