import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fail } from './errors.mjs';

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd().Trim()
$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw))
$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
$protected = ConvertFrom-SecureString -SecureString $secure
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($protected)))
`;

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd().Trim()
$protected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw))
$secure = ConvertTo-SecureString -String $protected
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
`;

function powershellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  const candidate = root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  if (!candidate || !existsSync(candidate)) throw fail('DPAPI_HELPER_UNAVAILABLE');
  return candidate;
}

function childEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function runPowerShell(script, input) {
  if (process.platform !== 'win32') throw fail('DPAPI_UNAVAILABLE');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  let inputBase64 = Buffer.from(input).toString('base64');
  try {
    const result = spawnSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      env: childEnvironment(),
      input: Buffer.from(inputBase64, 'ascii'),
      encoding: 'buffer',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0 || result.signal) throw fail('DPAPI_OPERATION_FAILED');
    const encodedOutput = result.stdout.toString('ascii').trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encodedOutput) || encodedOutput.length > 2 * 1024 * 1024) {
      throw fail('DPAPI_OUTPUT_INVALID');
    }
    return Buffer.from(encodedOutput, 'base64');
  } catch (error) {
    if (error?.code?.startsWith('DPAPI_')) throw error;
    throw fail('DPAPI_OPERATION_FAILED');
  } finally {
    inputBase64 = '';
  }
}

export class WindowsDpapiProtector {
  get provider() { return 'Windows DPAPI CurrentUser'; }

  protect(value) {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const output = runPowerShell(protectScript, input);
    return output;
  }

  unprotect(value) {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return runPowerShell(unprotectScript, input);
  }

  secureAppDirectory(directory) {
    if (process.platform !== 'win32' || typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('DPAPI_DIRECTORY_SCOPE');
    const root = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
    const expected = path.resolve(root, 'grok-web-xhr-client');
    if (path.resolve(directory).toLowerCase() !== expected.toLowerCase()) throw fail('DPAPI_DIRECTORY_SCOPE');
    const sidResult = spawnSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], {
      env: childEnvironment(),
      encoding: 'buffer',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (sidResult.error || sidResult.status !== 0 || sidResult.signal) throw fail('DPAPI_DIRECTORY_ACL_FAILED', {
      failure: 'CURRENT_USER_SID_UNAVAILABLE',
      spawnError: sidResult.error?.code ?? null,
      status: Number.isInteger(sidResult.status) ? sidResult.status : null,
      signal: sidResult.signal ?? null,
    });
    const sid = sidResult.stdout.toString('ascii').trim();
    if (!/^S-1-[0-9-]{5,180}$/.test(sid)) throw fail('DPAPI_DIRECTORY_ACL_FAILED', { failure: 'CURRENT_USER_SID_INVALID' });

    const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
    const icacls = windowsRoot ? path.join(windowsRoot, 'System32', 'icacls.exe') : null;
    if (!icacls || !existsSync(icacls)) throw fail('DPAPI_DIRECTORY_ACL_FAILED', { failure: 'ICACLS_UNAVAILABLE' });
    const result = spawnSync(icacls, [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], {
      env: childEnvironment(),
      encoding: 'buffer',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0 || result.signal) {
      throw fail('DPAPI_DIRECTORY_ACL_FAILED', {
        failure: result.error?.code ?? 'DACL_UPDATE_FAILED',
        status: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal ?? null,
      });
    }
    return { secured: true, scope: 'app_directory_only' };
  }
}

export const dpapiContract = Object.freeze({
  provider: 'Windows DPAPI CurrentUser',
  inputTransport: 'secret material enters the PowerShell helper on stdin only',
  persistence: 'DPAPI protected bytes only; no credential or session values in process arguments, environment, or logs',
  scope: 'the Grok consumer origin only; this is session storage, not a login or renewal flow',
});
