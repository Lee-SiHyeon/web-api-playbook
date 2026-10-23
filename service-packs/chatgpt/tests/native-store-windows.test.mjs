import assert from 'node:assert/strict';
import { env as processEnv, platform } from 'node:process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runNativeHelperProcess } from '../src/native-helper-process.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environmentNames = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA'];
const slash = String.fromCharCode(92);
const newline = String.fromCharCode(10);

function helperEnvironment() {
  return Object.fromEntries(environmentNames.filter((name) => processEnv[name]).map((name) => [name, processEnv[name]]));
}

function powershellPath() {
  const systemRoot = processEnv.SystemRoot || processEnv.WINDIR;
  if (!systemRoot) throw new Error('WINDOWS_SYSTEM_ROOT_UNAVAILABLE');
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function removeFixtureTree(root) {
  const tempRoot = path.resolve(tmpdir());
  const resolvedRoot = path.resolve(root);
  const stat = await lstat(resolvedRoot);
  if (path.dirname(resolvedRoot) !== tempRoot || !path.basename(resolvedRoot).startsWith('chatgpt-native-store-')
    || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('NATIVE_TEST_CLEANUP_PATH_REJECTED');
  await rm(resolvedRoot, { recursive: true, force: false });
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'chatgpt-native-store-'));
  const folderName = path.basename(root);
  const helper = path.join(root, 'secure-credential-store.ps1');
  const source = await readFile(path.join(projectRoot, 'src', 'secure-credential-store.ps1'), 'utf8');
  const oldDirectory = `Join-Path $local 'chatgpt-web-xhr-client${slash}credentials'`;
  const isolatedDirectory = `Join-Path $env:TEMP '${folderName}${slash}credentials'`;
  assert.equal(source.split(oldDirectory).length - 1, 1, 'store-root replacement must match the production helper exactly once');
  await writeFile(helper, source.replace(oldDirectory, isolatedDirectory), 'utf8');
  const aclProbe = path.join(root, 'acl-probe.ps1');
  const aclProbeSource = [
    'param([Parameter(Mandatory=$true)][ValidateSet("summary","add-extra","unprotect")][string]$Action, [Parameter(Mandatory=$true)][string]$Target)',
    '$ErrorActionPreference = "Stop"',
    '$sections = [Security.AccessControl.AccessControlSections]::Access',
    '$acl = [IO.Directory]::GetAccessControl($Target, $sections)',
    'if ($Action -eq "add-extra") {',
    '  $everyone = [Security.Principal.SecurityIdentifier]::new("S-1-1-0")',
    '  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
    '  $rule = [Security.AccessControl.FileSystemAccessRule]::new($everyone, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.AddAccessRule($rule)',
    '  [IO.Directory]::SetAccessControl($Target, $acl)',
    '} elseif ($Action -eq "unprotect") {',
    '  $acl.SetAccessRuleProtection($false, $true)',
    '  [IO.Directory]::SetAccessControl($Target, $acl)',
    '}',
    '$acl = [IO.Directory]::GetAccessControl($Target, $sections)',
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {',
    '  [pscustomobject]@{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow); fullControl = ($_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl); inherited = $_.IsInherited; inheritanceFlags = [int]$_.InheritanceFlags; propagationFlags = [int]$_.PropagationFlags }',
    '})',
    '[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentUserSid = $identity.Value; rules = $rules } | ConvertTo-Json -Compress -Depth 4',
  ].join(newline);
  await writeFile(aclProbe, aclProbeSource, 'utf8');
  return { root, helper, aclProbe,
    credentials: path.join(processEnv.TEMP || tmpdir(), folderName, 'credentials') };
}

function callPowerShell(args, input) {
  return runNativeHelperProcess(powershellPath(), args, { input, env: helperEnvironment(), timeoutMs: 20_000 });
}

function callStore(helper, operation, name, input) {
  return callPowerShell(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Operation', operation, '-Name', name], input);
}

function callAclProbe(script, action, target) {
  return JSON.parse(callPowerShell(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', action, '-Target', target]));
}

function assertCurrentUserOnly(summary) {
  assert.equal(summary.protected, true);
  assert.equal(summary.rules.length, 1);
  const [rule] = summary.rules;
  assert.equal(rule.sid, summary.currentUserSid);
  assert.equal(rule.allow, true);
  assert.equal(rule.fullControl, true);
  assert.equal(rule.inherited, false);
  assert.equal(rule.propagationFlags, 0);
  assert.equal(rule.inheritanceFlags, 3);
}

test('DPAPI helper preserves exact current-user-only ACLs and repairs extra and inherited principals', {
  skip: platform !== 'win32' || processEnv.CHATGPT_NATIVE_STORE_INTEGRATION !== '1'
    ? 'Set CHATGPT_NATIVE_STORE_INTEGRATION=1 to run the disposable Windows DPAPI integration test'
    : false,
}, async (t) => {
  const fixture = await createFixture();
  t.after(async () => removeFixtureTree(fixture.root));
  const name = 'disposable-native-probe';

  const firstStatus = JSON.parse(callStore(fixture.helper, 'status', name));
  assert.equal(firstStatus.available, false);
  assertCurrentUserOnly(callAclProbe(fixture.aclProbe, 'summary', fixture.credentials));

  assert.equal(callStore(fixture.helper, 'read', name), '', 'read of absent disposable credential should return empty');
  const payload = Buffer.from('synthetic-dpapi-roundtrip').toString('base64');
  const write = JSON.parse(callStore(fixture.helper, 'write', name, payload));
  assert.equal(write.stored, true);
  assert.equal(write.plaintextPersisted, false);
  assert.equal(callStore(fixture.helper, 'read', name), 'synthetic-dpapi-roundtrip');

  callAclProbe(fixture.aclProbe, 'add-extra', fixture.credentials);
  callStore(fixture.helper, 'status', name);
  assertCurrentUserOnly(callAclProbe(fixture.aclProbe, 'summary', fixture.credentials));

  callAclProbe(fixture.aclProbe, 'unprotect', fixture.credentials);
  callStore(fixture.helper, 'status', name);
  assertCurrentUserOnly(callAclProbe(fixture.aclProbe, 'summary', fixture.credentials));
  assert.equal(callStore(fixture.helper, 'read', name), 'synthetic-dpapi-roundtrip', 'ACL repair must preserve the protected DPAPI value');
});
