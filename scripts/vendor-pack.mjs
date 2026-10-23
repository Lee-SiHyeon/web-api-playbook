#!/usr/bin/env node
// Vendor a web-api-playbook service pack into a consumer repository.
// The playbook pack is the single source of truth; consumers carry a byte-identical
// copy plus PLAYBOOK_VENDOR.json (commit + sha256 per file). Edits belong upstream.
//
//   node scripts/vendor-pack.mjs --pack naver --subdir apps/naver-blog-api --dest ../repo/apps/naver-blog-api
//   node scripts/vendor-pack.mjs --pack tistory --dest ../repo --keep README.md --keep package.json
//   node scripts/vendor-pack.mjs --check --dest ../repo            (drift check, no writes)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = 'PLAYBOOK_VENDOR.json';
export const DEFAULT_KEEP = Object.freeze(['package.json', 'package-lock.json', 'README.md', '.gitignore', '.gitattributes']);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Line endings are normalized so a CRLF checkout (e.g. *.ps1 under .gitattributes) is not drift.
export const sha256 = file => createHash('sha256').update(readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');

export function parseArgs(argv) {
  const out = { keep: [], check: false, subdir: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (['--pack', '--subdir', '--dest'].includes(a)) out[a.slice(2)] = argv[++i];
    else if (a === '--keep') out.keep.push(argv[++i]);
    else throw new Error(`VENDOR_ARGUMENT_INVALID: ${a}`);
  }
  if (!out.dest) throw new Error('VENDOR_DEST_REQUIRED');
  if (!out.check && !/^(naver|tistory)$/.test(out.pack || '')) throw new Error('VENDOR_PACK_INVALID');
  return out;
}

export function packFiles({ pack, subdir = '', keep = [], repoRoot = root }) {
  const base = path.posix.join('service-packs', pack, subdir);
  const listed = execFileSync('git', ['ls-files', '--', base], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean).map(f => path.posix.relative(base, f));
  const skip = new Set([...DEFAULT_KEEP, ...keep, MANIFEST]);
  return { base, files: listed.filter(f => !skip.has(f) && !f.startsWith('node_modules/')) };
}

export function vendor({ pack, subdir = '', dest, keep = [], repoRoot = root }) {
  const { base, files } = packFiles({ pack, subdir, keep, repoRoot });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', base], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('VENDOR_SOURCE_DIRTY: commit the playbook pack before vendoring');
  const entries = files.map(rel => {
    const from = path.join(repoRoot, base, rel), to = path.join(dest, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    return { path: rel, sha256: sha256(to) };
  });
  const manifest = { schemaVersion: 1, source: 'github.com/Lee-SiHyeon/web-api-playbook', pack: base,
    commit, files: entries, policy: 'Vendored files are read-only here. Change them in web-api-playbook and re-vendor.' };
  writeFileSync(path.join(dest, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function checkVendored(dest) {
  const manifest = JSON.parse(readFileSync(path.join(dest, MANIFEST), 'utf8'));
  const drift = manifest.files.filter(f => !existsSync(path.join(dest, f.path)) || sha256(path.join(dest, f.path)) !== f.sha256)
    .map(f => f.path);
  return { commit: manifest.commit, pack: manifest.pack, files: manifest.files.length, drift };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('vendor-pack.mjs')) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.check) {
      const r = checkVendored(path.resolve(args.dest));
      console.log(JSON.stringify(r));
      if (r.drift.length) process.exitCode = 1;
    } else {
      const m = vendor({ ...args, dest: path.resolve(args.dest) });
      console.log(JSON.stringify({ commit: m.commit, pack: m.pack, files: m.files.length }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
