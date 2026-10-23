import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const CONSOLIDATION_MANIFESTS = [
  'provenance/repository-consolidation-2026-10-23.json',
  'provenance/operations-consolidation-2026-10-23.json',
  'provenance/additional-client-consolidation-2026-10-23.json',
  'provenance/automation-consolidation-2026-10-23.json',
  'provenance/naver-media-consolidation-2026-10-23.json',
  'provenance/social-x-consolidation-2026-10-23.json',
];
const relative = value => typeof value === 'string' && value.length > 0 && !value.includes('\\')
  && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Check installed bytes only; a source hash or a passing test is not live proof. */
export async function auditConsolidation(root, { manifests = CONSOLIDATION_MANIFESTS } = {}) {
  const base = await realpath(root), expected = new Map(), errors = [], repositories = new Set();
  async function read(relativePath) {
    if (!relative(relativePath)) throw Error('CONSOLIDATION_PATH_INVALID');
    const target = await realpath(path.join(base, relativePath));
    if (!target.startsWith(base + path.sep)) throw Error('CONSOLIDATION_PATH_ESCAPE');
    return readFile(target);
  }
  for (const name of manifests) {
    try {
      const manifest = JSON.parse(await read(name));
      const repo = manifest.repository ?? manifest.donor?.repository;
      if (repo) repositories.add(repo.replace('https://github.com/', '').replace(/\.git$/, ''));
      const files = [...(manifest.files ?? []), ...(manifest.outputFiles ?? [])];
      for (const source of manifest.sources ?? []) {
        repositories.add(source.repository); files.push(...source.files);
      }
      for (const file of files) {
        if (!relative(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw Error('CONSOLIDATION_MANIFEST_INVALID');
        if (expected.has(file.path) && expected.get(file.path) !== file.sha256) throw Error('CONSOLIDATION_HASH_CONFLICT');
        expected.set(file.path, file.sha256);
      }
      if (!files.length) throw Error('CONSOLIDATION_MANIFEST_EMPTY');
    } catch (error) {
      errors.push({ path: name, code: /^CONSOLIDATION_[A-Z_]+$/.test(error.message) ? error.message : 'CONSOLIDATION_MANIFEST_UNREADABLE' });
    }
  }
  for (const [name, sha256] of expected) {
    try {
      if (digest(await read(name)) !== sha256) errors.push({ path: name, code: 'CONSOLIDATION_HASH_MISMATCH' });
    } catch { errors.push({ path: name, code: 'CONSOLIDATION_FILE_UNREADABLE' }); }
  }
  return { schema: 'playbook-consolidation-audit-v1', ok: !errors.length, files: expected.size,
    repositories: [...repositories].sort(), manifests: manifests.length, errors,
    evidenceScope: 'packaged_bytes_only', currentAuthenticationVerified: false, liveReplayVerified: false };
}
