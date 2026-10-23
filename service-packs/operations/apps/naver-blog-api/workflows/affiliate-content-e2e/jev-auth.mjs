import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function jevSecretPath(home = os.homedir(), provider = 'typesafe') {
  const files = { typesafe: 'typesafe-api-key.dpapi', vercel: 'vercel-ai-gateway-api-key.dpapi' };
  if (!Object.hasOwn(files, provider)) throw new Error('JEV_LOCAL_SECRET_PROVIDER_INVALID');
  return path.join(home, '.config', 'affiliate-content-operations', files[provider]);
}

// The key only crosses an anonymous stdout pipe into this process. It is never
// passed as argv, exported globally, printed, or persisted as plaintext.
const decrypt = `$ErrorActionPreference = 'Stop'
$secure = Get-Content -Raw -LiteralPath $env:JEV_LOCAL_SECRET_PATH | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }`;

export function readWindowsJevKey({
  provider = 'typesafe',
  platform = process.platform,
  filename = jevSecretPath(undefined, provider),
  exists = existsSync,
  execute = execFileSync,
} = {}) {
  if (platform !== 'win32' || !exists(filename)) return '';
  try {
    const childEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA']) {
      if (process.env[name]) childEnv[name] = process.env[name];
    }
    childEnv.JEV_LOCAL_SECRET_PATH = filename;
    const key = execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(decrypt, 'utf16le').toString('base64')], {
      env: childEnv,
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!key || key.length > 4096 || /\s/.test(key)) throw new Error('invalid');
    return key;
  } catch {
    // PowerShell exceptions can contain data; do not forward stderr/cause.
    throw new Error('JEV_LOCAL_SECRET_UNREADABLE');
  }
}
