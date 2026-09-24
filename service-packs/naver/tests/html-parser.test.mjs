import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('HTTP HTML discovery decodes observed links and keeps sensitive field values out of metadata', () => {
  const body = `<a href="/4053103/config/blog?x=1&amp;y=2">menu</a><iframe src="https://blog.stat.naver.com/blog/visit/cv?blogId=4053103"></iframe><script src="/observed.js"></script><form method="post" action="/save"><input name="password" value="private-password-fixture"><input name="csrf" value="private-csrf-fixture"></form><script>const options = {startDate: '2026-09-13', timeDimension: 'fixture'}; const url = '/api/blog/visit/cv';</script>`;
  const result = spawnSync(process.env.PYTHON || 'python', [fileURLToPath(new URL('../tools/discovery/parse-html.py', import.meta.url))], {
    input: JSON.stringify({ url: 'https://admin.blog.naver.com/4053103', body }), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.links[0].url, 'https://admin.blog.naver.com/4053103/config/blog?x=1&y=2');
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.forms[0].method, 'POST');
  assert.deepEqual(parsed.apiCandidates, ['/api/blog/visit/cv']);
  assert.deepEqual(parsed.literalDefaults.startDate, ['2026-09-13']);
  assert.ok(!result.stdout.includes('private-password-fixture'));
  assert.ok(!result.stdout.includes('private-csrf-fixture'));
});
