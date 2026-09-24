import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateClaimEvidenceGate } from './claim-evidence-gates.mjs';
import { readJsonFile } from './json-io.mjs';

const ledgerPath = path.resolve(process.argv[2] || 'claim-evidence-ledger.json');
const draftArg = process.argv.find(value => value.startsWith('--draft='));
const outputArg = process.argv.find(value => value.startsWith('--output='));
const asOfArg = process.argv.find(value => value.startsWith('--as-of='));
const draft = draftArg ? await readFile(path.resolve(draftArg.slice(8)), 'utf8') : '';
const ledger = await readJsonFile(ledgerPath);
const now = asOfArg ? new Date(asOfArg.slice(8)) : new Date();
if (Number.isNaN(now.getTime())) throw new Error('invalid --as-of timestamp');
const gate = evaluateClaimEvidenceGate(ledger, { now, draft });
const output = path.resolve(outputArg?.slice(9) || ledgerPath.replace(/\.json$/i, '.gate.json'));
await writeFile(output, JSON.stringify(gate, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ completed: true, input: ledgerPath, output, passed: gate.passed, failedChecks: gate.failedChecks }));
if (!gate.passed) process.exitCode = 2;
