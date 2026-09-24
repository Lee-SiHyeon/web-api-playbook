import test from 'node:test';
import assert from 'node:assert/strict';
import { observedReadPages } from '../tools/discovery/read-pages.mjs';

test('HTTP discovery requires an observed read path and rejects unobserved commands', () => {
  const allowed = observedReadPages([
    'https://admin.blog.naver.com/4053103',
    'https://blog.stat.naver.com/blog/visit/cv?blogId=4053103&isIE8=false',
  ]);
  assert.ok(allowed('https://admin.blog.naver.com/4053103'));
  assert.ok(allowed('https://blog.stat.naver.com/blog/visit/cv?isIE8=false&blogId=4053103'));
  for (const raw of [
    'https://admin.blog.naver.com/4053103/save',
    'https://admin.blog.naver.com/4053103?action=delete',
    'https://blog.stat.naver.com/blog/unknown',
    'https://blog.stat.naver.com/blog/visit/cv?blogId=someone-else',
    'https://blog.stat.naver.com/blog/visit/cv?blogId=4053103&token=fixture',
    'https://blog.stat.naver.com/blog/visit/cv?isIE8=%5Bredacted%5D',
    'https://fixture@admin.blog.naver.com/4053103',
  ]) assert.equal(allowed(raw), false);
});
