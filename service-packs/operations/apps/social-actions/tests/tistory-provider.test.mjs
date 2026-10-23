import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBlogIdFromHtml } from '../providers/tistory.mjs';

const host = 'worye.tistory.com';

test('resolves the public page BLOG.id when the home page has no subscription button', () => {
  const html = '<script>window.Tistory={"BLOG":{"id":5647532,"name":"worye"},"USER":{"id":0}}</script>';
  assert.equal(resolveBlogIdFromHtml(html, host), '5647532');
});

test('accepts the subscription button id when it agrees with BLOG.id', () => {
  const html = '<script>window.Tistory={"BLOG":{"id":5647532}}</script>'
    + '<button class="btn_menu_toolbar btn_subscription #subscribe" data-blog-id="5647532" data-url="https://worye.tistory.com/86">';
  assert.equal(resolveBlogIdFromHtml(html, host), '5647532');
});

test('rejects conflicting public identity fields', () => {
  const html = '<script>window.Tistory={"BLOG":{"id":5647532}}</script>'
    + '<button class="btn_subscription" data-blog-id="5647533" data-url="https://worye.tistory.com/86">';
  assert.throws(() => resolveBlogIdFromHtml(html, host), { code: 'TISTORY_TARGET_IDENTITY_AMBIGUOUS' });
});

test('rejects a subscription button that points to a different host', () => {
  const html = '<button class="btn_subscription" data-blog-id="5647532" data-url="https://other.tistory.com/86">';
  assert.throws(() => resolveBlogIdFromHtml(html, host), { code: 'TISTORY_TARGET_IDENTITY_MISMATCH' });
});

test('ignores unrelated toolbar buttons and fails closed when no blog id exists', () => {
  const html = '<button class="btn_menu_toolbar" data-blog-id="5647532" data-url="https://worye.tistory.com/86">';
  assert.throws(() => resolveBlogIdFromHtml(html, host), { code: 'TISTORY_TARGET_ID_UNRESOLVED' });
});
