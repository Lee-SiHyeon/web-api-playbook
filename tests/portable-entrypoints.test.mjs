import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const parent = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(parent, 'portable-entrypoints-')));
  t.after(async () => {
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('portable-entrypoints-')) throw Error('TEST_CLEANUP_SCOPE');
    await rm(directory, { recursive: true, force: true });
  });
  const checkout = path.join(directory, 'checkout with spaces 한글');
  await mkdir(path.join(checkout, 'scripts'), { recursive: true });
  return { directory, checkout };
}
async function copyScript(checkout, name) {
  await writeFile(path.join(checkout, 'scripts', name), await readFile(path.join(root, 'scripts', name)));
}
async function file(directory, name, content) {
  const target = path.join(directory, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
function run(checkout, name, overrides = {}) {
  const env = { ...process.env };
  delete env.ACO_ROOT;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [path.join(checkout, 'scripts', name)], {
    cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
}

test('Kakao entrypoint resolves its packaged store from a relocated checkout without opening a real store', async (t) => {
  const { checkout } = await fixture(t);
  await copyScript(checkout, 'kakao-login-fill.mjs');
  await file(checkout, 'lib/protected-store.mjs', 'export class ProtectedStore { read() { return null; } }');
  const result = run(checkout, 'kakao-login-fill.mjs');
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'IDENTITY_MISSING' });
});

test('Meta optional integration fails before browser work when its helper is absent', async (t) => {
  const { checkout } = await fixture(t);
  await copyScript(checkout, 'meta-session-from-canary.mjs');
  const result = run(checkout, 'meta-session-from-canary.mjs');
  assert.equal(result.status, 2, result.stderr);
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.code, 'META_SESSION_HELPER_UNAVAILABLE');
  assert.match(diagnostic.hint, /ACO_ROOT/);
  assert.equal(result.stdout, '');
});

test('Meta resolves a sibling helper and prefers an explicit ACO_ROOT override', async (t) => {
  const { directory, checkout } = await fixture(t);
  await copyScript(checkout, 'meta-session-from-canary.mjs');
  const helper = 'apps/naver-blog-api/scripts/meta-auth-session.mjs';
  // Invalid exports stop execution before any browser or credential operations.
  await file(path.join(directory, 'affiliate-content-operations'), helper, 'export const storeMetaSession = null;');
  const sibling = run(checkout, 'meta-session-from-canary.mjs');
  assert.equal(sibling.status, 2, sibling.stderr);
  assert.equal(JSON.parse(sibling.stderr).code, 'META_SESSION_HELPER_INVALID');
  const overridden = run(checkout, 'meta-session-from-canary.mjs', { ACO_ROOT: path.join(directory, 'missing explicit checkout') });
  assert.equal(overridden.status, 2, overridden.stderr);
  assert.equal(JSON.parse(overridden.stderr).code, 'META_SESSION_HELPER_UNAVAILABLE');
  await file(path.join(directory, 'explicit checkout'), helper, 'export const loadMetaSession = null;');
  const explicit = run(checkout, 'meta-session-from-canary.mjs', { ACO_ROOT: path.join(directory, 'explicit checkout') });
  assert.equal(explicit.status, 2, explicit.stderr);
  assert.equal(JSON.parse(explicit.stderr).code, 'META_SESSION_HELPER_INVALID');
});

test('Meta resolves the bundled helper before a sibling checkout without opening a provider', async (t) => {
  const { directory, checkout } = await fixture(t);
  await copyScript(checkout, 'meta-session-from-canary.mjs');
  const helper = 'apps/naver-blog-api/scripts/meta-auth-session.mjs';
  await file(checkout, 'service-packs/operations/' + helper, 'export const storeMetaSession = null;');
  await file(path.join(directory, 'affiliate-content-operations'), helper, 'throw Error("SIBLING_MUST_NOT_LOAD");');
  const result = run(checkout, 'meta-session-from-canary.mjs');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stderr).code, 'META_SESSION_HELPER_INVALID');
  assert.equal(result.stdout, '');
});

test('consolidated HTTP adapters load bundled auth modules from a relocated checkout and honor explicit roots', async (t) => {
  const { directory, checkout } = await fixture(t);
  const helper = 'service-packs/operations/apps/affiliate-api-hub/adapters/web-auth-provider.mjs';
  await file(checkout, helper, await readFile(path.join(root, helper), 'utf8'));
  await file(checkout, 'lib/web-auth/myrealtrip.mjs', 'export const createMyrealtripAuth = () => ({ source: "bundled-stub" });');
  await file(checkout, 'scripts/probe-auth.mjs', `
    import { webApiPlaybookRoot, loadWebAuth } from '../${helper}';
    console.log(JSON.stringify({ root: webApiPlaybookRoot(), auth: await loadWebAuth('myrealtrip') }));
  `);
  const bundled = run(checkout, 'probe-auth.mjs', { WEB_API_PLAYBOOK_ROOT: '', WEB_API_PLAYBOOK: '' });
  assert.equal(bundled.status, 0, bundled.stderr);
  const actual = JSON.parse(bundled.stdout);
  assert.equal(path.resolve(actual.root), checkout);
  assert.deepEqual(actual.auth, { source: 'bundled-stub' });
  const explicit = path.join(directory, 'explicit playbook');
  await file(explicit, 'lib/web-auth/myrealtrip.mjs', 'export const createMyrealtripAuth = () => ({ source: "explicit-stub" });');
  for (const variable of ['WEB_API_PLAYBOOK_ROOT', 'WEB_API_PLAYBOOK']) {
    const result = run(checkout, 'probe-auth.mjs', { WEB_API_PLAYBOOK_ROOT: '', WEB_API_PLAYBOOK: '', [variable]: explicit });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { root: explicit, auth: { source: 'explicit-stub' } });
  }
});

test('doctor checks every declared runtime dependency and fails when any one is unavailable', async (t) => {
  const { checkout } = await fixture(t);
  await copyScript(checkout, 'doctor.mjs');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await file(checkout, 'package.json', JSON.stringify(manifest));
  for (const name of ['SKILL.md', 'package-lock.json', 'lib/scoped-session.mjs', 'lib/protected-store.mjs', 'scripts/request.mjs']) {
    await file(checkout, name, '');
  }
  for (const name of Object.keys(manifest.dependencies)) {
    await file(checkout, `node_modules/${name}/package.json`, JSON.stringify({ name, type: 'module', exports: './index.mjs' }));
    await file(checkout, `node_modules/${name}/index.mjs`, 'export default {};');
  }
  const healthy = run(checkout, 'doctor.mjs');
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.deepEqual(JSON.parse(healthy.stdout).dependencies, Object.fromEntries(Object.keys(manifest.dependencies).map(name => [name, true])));
  manifest.dependencies['missing-portability-test-dependency'] = '1.0.0';
  await file(checkout, 'package.json', JSON.stringify(manifest));
  const incomplete = run(checkout, 'doctor.mjs');
  assert.equal(incomplete.status, 1, incomplete.stderr);
  const report = JSON.parse(incomplete.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.dependencies['missing-portability-test-dependency'], false);
});
