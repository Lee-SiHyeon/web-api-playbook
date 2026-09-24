import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['SKILL.md', 'package.json', 'package-lock.json', 'lib/scoped-session.mjs', 'lib/protected-store.mjs', 'scripts/request.mjs'];
const checkFiles = {};
for (const file of files) { try { await access(path.join(root, file), constants.R_OK); checkFiles[file] = true; } catch { checkFiles[file] = false; } }
const dependencies = {};
for (const name of ['parse5', 'tough-cookie']) { try { await import(name); dependencies[name] = true; } catch { dependencies[name] = false; } }
const nodeSupported = Number(process.versions.node.split('.')[0]) >= 24;
const powershell = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).status === 0
  : false;
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const ok = nodeSupported && Object.values(checkFiles).every(Boolean) && Object.values(dependencies).every(Boolean);
console.log(JSON.stringify({ ok, version: manifest.version, platform: process.platform, architecture: process.arch,
  node: process.versions.node, nodeSupported, files: checkFiles, dependencies,
  authentication: { dpapiAvailable: process.platform === 'win32' && powershell, stdinMemoryAvailable: true, credentialsRead: false, serviceSessionVerified: false },
  browserRequiredForCore: false, servicePacksHaveOwnRequirements: true }, null, 2));
if (!ok) process.exitCode = 1;
