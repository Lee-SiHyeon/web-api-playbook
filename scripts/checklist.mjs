#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditCapabilityChecklist, renderCapabilityMarkdown, safeRelativePath } from '../lib/capability-checklist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args) {
  const out = { service: null, all: false, strict: false, json: false, runTests: false };
  for (const arg of args) {
    if (arg.startsWith('--service=')) out.service = arg.slice('--service='.length);
    else if (arg === '--all') out.all = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--run-tests') out.runTests = true;
    else if (arg === '--help') out.help = true;
    else throw new Error('CHECKLIST_ARGUMENT_INVALID');
  }
  if (out.service && !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(out.service) || out.service && out.all) throw new Error('CHECKLIST_ARGUMENT_INVALID');
  return out;
}

function runTestFile(file) {
  if (!safeRelativePath(file)) return 'failed';
  const result = spawnSync(process.execPath, ['--test', file], {
    cwd: root, timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    // Do not pass credential, proxy, token, or automation variables to test subprocesses.
    env: Object.fromEntries(['HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]])),
  });
  return result.status === 0 && !result.error ? 'passed' : 'failed';
}

function testResultMap(initialAudit) {
  const testDetails = initialAudit.capabilities.flatMap(cap => cap.code.details.filter(item => item.kind === 'test'));
  const files = [...new Set(testDetails.filter(item => item.state === 'present').map(item => item.path))];
  const results = Object.fromEntries(files.map(file => [file, runTestFile(file)]));
  return Object.fromEntries(initialAudit.capabilities.map(cap => {
    const tests = cap.code.details.filter(item => item.kind === 'test');
    return [cap.id, tests.length === 0 ? 'not_run' : tests.every(item => item.state === 'present' && results[item.path] === 'passed') ? 'passed' : 'failed'];
  }));
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/checklist.mjs [--service=inpock | --all] [--strict] [--json] [--run-tests]');
    console.log('Default is --all. Offline static and recorded-evidence audit; --run-tests explicitly executes local test files.');
    process.exit(0);
  }
  const services = args.service ? [args.service] :
    (await readdir(path.join(root, 'checklists', 'services'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort();
  if (!services.length) throw new Error('CHECKLIST_SERVICE_MISSING');
  const audits = [];
  for (const service of services) {
    const initialAudit = await auditCapabilityChecklist({ root, service });
    const testResults = args.runTests ? testResultMap(initialAudit) : null;
    audits.push(await auditCapabilityChecklist({ root, service, testResults }));
  }
  if (args.json) console.log(JSON.stringify({ schema: 'web-api-capability-audits-v1', audits }));
  else console.log(renderCapabilityMarkdown(audits));
  if (args.strict && audits.some(audit => !audit.summary.strictPassed)) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'CHECKLIST_FAILED' }));
  process.exitCode = 1;
}
