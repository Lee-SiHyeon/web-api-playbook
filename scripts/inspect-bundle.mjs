import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { options, reserveOutput, report, sha256, safeError } from '../lib/cli.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const excluded = new Set(['.git', 'node_modules', '.runtime', 'runtime', 'work', 'runs', 'workflow-runs', '__pycache__']);
const rules = [
 ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
 ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
 ['api_key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/g],
 ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g],
 ['signed_query', /[?&](?:credential|signature|access_token|refresh_token|sessionKey|wtoken|eccpw)=[A-Za-z0-9_%+\/-]{20,}/g],
 ['naver_cookie', /\bNID_(?:AUT|SES)\s*=\s*[A-Za-z0-9+\/%_-]{24,}/g],
 ['temporary_tunnel', /https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|ngrok-free\.app)/g],
];
let handle;
try {
 const args = options(process.argv.slice(2), ['output']); handle = await reserveOutput(args.output);
 const files = [], findings = [];
 async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
   if (excluded.has(entry.name)) continue;
   const full = path.join(dir, entry.name), relative = path.relative(root, full).split(path.sep).join('/');
   if (args.output && path.resolve(args.output) === full) continue;
   if (entry.isSymbolicLink()) { findings.push({ file: relative, kind: 'symlink' }); continue; }
   if (entry.isDirectory()) { await walk(full); continue; }
   if (!entry.isFile()) continue;
   if (/\.(?:dpapi|pem|key|har|pfx|db|sqlite)$/i.test(entry.name)) findings.push({ file: relative, kind: 'sensitive_file_type' });
   if (/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') findings.push({ file: relative, kind: 'environment_file' });
   const bytes = await readFile(full); files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
   if (!/\.(?:mjs|js|json|md|ps1|py|txt|ya?ml|toml|html|xml)$/i.test(entry.name)) continue;
   const text = bytes.toString('utf8');
   for (const [kind, regex] of rules) for (const match of text.matchAll(regex)) findings.push({ file: relative, kind, line: text.slice(0, match.index).split('\n').length });
  }
 }
 await walk(root);
 const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), files: files.length,
   secretPatternsFound: findings.length, findings, inventory: files,
   scope: 'File packaging and high-signal secret patterns; not proof of absence of every secret or live service success' };
 await report(result, handle); if (findings.length) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error) })); process.exitCode = 1; }
finally { await handle?.close(); }
