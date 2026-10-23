import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { auditPlaybook, renderPlaybookAudit } from '../lib/playbook-audit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/audit-playbook.mjs --output-dir=<new-directory> [--run-tests] [--strict]');
    console.log('Whole-repository inventory and recorded-receipt audit. No service CLI is scheduled.');
    console.log('--run-tests executes declared local test files; these are trusted repository code, not network-sandboxed.');
  } else {
    if (args.some(arg => !['--run-tests', '--strict'].includes(arg) && !arg.startsWith('--output-dir=')) || args.filter(arg => arg.startsWith('--output-dir=')).length !== 1) throw new Error('AUDIT_ARGUMENT_INVALID');
    const destination = path.resolve(args.find(arg => arg.startsWith('--output-dir=')).slice(13));
    // Reserve the directory first; never overwrite an earlier audit.
    await mkdir(destination, { recursive: false });
    const report = await auditPlaybook({ root, runTests: args.includes('--run-tests'),
      onProgress: item => process.stderr.write(JSON.stringify(item) + '\n') });
    await writeFile(path.join(destination, 'audit.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await writeFile(path.join(destination, 'audit.md'), renderPlaybookAudit(report), { flag: 'wx' });
    console.log(JSON.stringify({ ...report.summary, output: destination }));
    if (report.errors.length) process.exitCode = 1;
    else if (args.includes('--strict') && !report.summary.allRequiredGatesPassed) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'AUDIT_FAILED' }));
  process.exitCode = 1;
}
