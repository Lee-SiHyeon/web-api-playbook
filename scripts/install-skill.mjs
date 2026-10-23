import { lstat, mkdir, readdir, copyFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { options, fail, safeError } from '../lib/cli.mjs';

const source = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', '.auth', '.vercel', '.runtime', 'runtime', 'work', 'runs', 'workflow-runs', '__pycache__', 'credentials', 'private', 'secrets', 'raw-captures', 'affiliate-content-operations']);
// These working-checkout captures are not distribution assets. Other research docs remain distributable.
const excludedRootPaths = new Set(['research/dots', 'research/grokbot']);
const forbidden = file => /\.(?:dpapi|sealed|har|log|pem|key|pfx|p12|db|sqlite)$/i.test(file)
  || /^(?:\.?auth|\.?credentials|cookies|session|storage-?state|token|tokens)(?:[.-].*)?\.json$/i.test(file)
  || /^\.env(?:\.|$)/i.test(file) && file.toLowerCase() !== '.env.example';
try {
  const args = options(process.argv.slice(2), ['target']);
  if (args.target === true) fail('TARGET_INVALID');
  const skillRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const target = path.resolve(args.target || path.join(skillRoot, 'skills', 'xhr-to-api-only'));
  const relative = path.relative(source, target);
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) fail('TARGET_INSIDE_SOURCE');
  if (target === path.parse(target).root || target === os.homedir()) fail('TARGET_INVALID');
  try { await lstat(target); fail('TARGET_ALREADY_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Reserve a new destination. Never delete/replace another installed skill.
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target);
  let copied = 0;
  async function copy(dir, dest) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name), to = path.join(dest, entry.name);
      const relativePath = path.relative(source, from).split(path.sep).join('/').toLowerCase();
      if (excluded.has(entry.name.toLowerCase()) || forbidden(entry.name)
        || excludedRootPaths.has(relativePath) || dir === source && /^\.tmp-/i.test(entry.name)
        || entry.isDirectory() && /^\.?venv(?:[._-].*)?$/i.test(entry.name)) continue;
      if (entry.isSymbolicLink()) fail('SYMLINK_NOT_DISTRIBUTABLE');
      if (entry.isDirectory()) { await mkdir(to); await copy(from, to); }
      else if (entry.isFile()) { await copyFile(from, to, constants.COPYFILE_EXCL); copied++; }
    }
  }
  await copy(source, target);
  const pkg = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  console.log(JSON.stringify({ installed: true, target, version: pkg.version, files: copied,
    dependenciesInstalled: false, credentialsCopied: null,
    credentialExclusion: 'known_paths_only_not_content_verified',
    next: ['Change directory to target', 'npm ci --ignore-scripts', 'npm run doctor', 'Start a new agent session to discover the skill'] }, null, 2));
} catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error) })); process.exitCode = 1; }
