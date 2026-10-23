import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// 2026-10-22: a Chrome user-agent made Threads serve the profile document without the embedded profile (META_TARGET_NOT_FOUND).
test('Meta requests do not send a custom user-agent header', async () => {
  const src = await readFile(new URL('../lib/meta-bootstrap.mjs', import.meta.url), 'utf8');
  assert.ok(!/'user-agent':\s*META_USER_AGENT/.test(src));
});
