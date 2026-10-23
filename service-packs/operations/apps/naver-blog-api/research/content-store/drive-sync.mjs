import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Copies a finished run directory into the Google Drive desktop mount and reads every byte back.
// The mount is a local folder, so a verified copy proves local placement, not cloud upload; the
// receipt says so. Nothing is ever overwritten and any file that looks like credential material
// aborts the whole sync before the first copy.
export const DEFAULT_ROOT = process.env.CONTENT_STORE_DRIVE_ROOT || 'G:\\내 드라이브\\affiliate-content-automation\\글감 수집 저장소';
const deniedName = /secret|cookie|session|credential|token|\.env$|\.bak$/i;
const secretPattern = /NID_AUT=|NID_SES=|auth_token=|(?:^|[^A-Za-z0-9])ct0=|Bearer [A-Za-z0-9._-]{20,}|"(?:cookie|cookies|authorization|password)"\s*:/i;
const textExtensions = new Set(['.json', '.jsonl', '.md', '.txt', '.csv', '.html', '.mjs', '.ps1']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('SYMLINK_IN_RUN');
    if (entry.isDirectory()) files.push(...await listFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

export async function scanRun(runDir, { maxBytes = 50 * 1024 * 1024 } = {}) {
  const planned = []; const skipped = [];
  for (const rel of await listFiles(runDir)) {
    if (deniedName.test(path.basename(rel))) { skipped.push({ relativePath: rel, reason: 'denied_name' }); continue; }
    const stat = await lstat(path.join(runDir, rel));
    if (stat.size > maxBytes) { skipped.push({ relativePath: rel, reason: 'exceeds_max_bytes' }); continue; }
    const bytes = await readFile(path.join(runDir, rel));
    if (textExtensions.has(path.extname(rel).toLowerCase()) && secretPattern.test(bytes.toString('utf8'))) throw new Error('SECRET_PATTERN_DETECTED');
    planned.push({ relativePath: rel, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { planned, skipped };
}

export async function syncRun(runDir, { root = DEFAULT_ROOT, name = path.basename(path.resolve(runDir)), maxBytes, now = new Date() } = {}) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('SYNC_NAME');
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('DRIVE_ROOT_UNAVAILABLE');
  const target = path.join(root, name);
  if (await lstat(target).catch(() => null)) throw new Error('TARGET_EXISTS');
  const { planned, skipped } = await scanRun(runDir, { maxBytes });
  if (!planned.length) throw new Error('NOTHING_TO_SYNC');
  await mkdir(target);
  const files = [];
  for (const file of planned) {
    const destination = path.join(target, file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(runDir, file.relativePath), destination, constants.COPYFILE_EXCL);
    const readback = await readFile(destination);
    const readbackVerified = readback.length === file.bytes && sha256(readback) === file.sha256;
    if (!readbackVerified) throw new Error('DRIVE_READBACK_MISMATCH');
    files.push({ ...file, readbackVerified });
  }
  return { schemaVersion: 1, kind: 'drive_local_mount_sync', root, target, checkedAt: now.toISOString(), syncMode: 'local_mount_copy_readback',
    files, skipped, cloudSyncVerified: false, note: '로컬 마운트 폴더에 복사하고 바이트를 다시 읽어 대조했습니다. 클라우드 업로드 완료나 다른 기기 동기화의 증거는 아닙니다.' };
}

export async function main(args) {
  const [runDir, ...rest] = args;
  if (!runDir) throw new Error('Use drive-sync.mjs RUN_DIRECTORY [--root=DRIVE_FOLDER] [--name=TARGET_NAME]');
  const options = {};
  for (const arg of rest) {
    const match = /^--(root|name)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('SYNC_OPTION');
    options[match[1]] = match[2];
  }
  const receiptPath = path.join(path.resolve(runDir), 'drive-sync-receipt.json');
  if (await lstat(receiptPath).catch(() => null)) throw new Error('RECEIPT_EXISTS');
  const receipt = await syncRun(path.resolve(runDir), options);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ target: receipt.target, files: receipt.files.length, skipped: receipt.skipped.length, readbackVerified: receipt.files.every(file => file.readbackVerified), cloudSyncVerified: false }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(/^[A-Z_]+$/.test(error?.message || '') ? error.message : 'DRIVE_SYNC_FAILED'); process.exitCode = 1; });
