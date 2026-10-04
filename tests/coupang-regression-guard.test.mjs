import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const guard = new URL('../scripts/coupang-offline-guard.mjs', import.meta.url).href;
function child(code) {
  return execFileSync(process.execPath, ['--import', guard, '--input-type=module', '--eval', code],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
}

test('offline regression child rejects native fetch before a network attempt', () => {
  const output = child("try { await fetch('https://partners.coupang.com/api/v1/dashboard'); } catch (error) { console.log(error.code); }");
  assert.equal(output, 'COUPANG_REGRESSION_NETWORK_FORBIDDEN');
});

test('offline regression child rejects the DPAPI helper before executing it', () => {
  const output = child("import { execFileSync } from 'node:child_process'; try { execFileSync('powershell.exe', ['-File', 'C:/synthetic/dpapi-store.ps1']); } catch (error) { console.log(error.code); }");
  assert.equal(output, 'COUPANG_REGRESSION_PROTECTED_STORE_FORBIDDEN');
});

test('offline regression child can use an explicitly mocked fetch', () => {
  const output = child("globalThis.fetch = async () => new Response('{\"mocked\":true}', { headers: {'content-type':'application/json'} }); console.log((await (await fetch('https://synthetic.invalid')).json()).mocked);");
  assert.equal(output, 'true');
});
