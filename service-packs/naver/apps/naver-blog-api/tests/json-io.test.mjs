import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonText } from '../scripts/gates/json-io.mjs';

test('gate JSON parser accepts Windows PowerShell UTF-8 BOM output', () => {
  assert.deepEqual(parseJsonText('\uFEFF{"ok":true}'), { ok: true });
});
