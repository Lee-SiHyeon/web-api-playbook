import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateCommercialSnapshot } from './commercial-snapshot-gates.mjs';
import { readJsonFile } from './json-io.mjs';

const input = path.resolve(process.argv[2] || 'commercial-snapshot.json');
const outputArg = process.argv.find(value => value.startsWith('--output='));
const asOfArg = process.argv.find(value => value.startsWith('--as-of='));
const maxAgeArg = process.argv.find(value => value.startsWith('--max-age-minutes='));
const snapshot = await readJsonFile(input);
const now = asOfArg ? new Date(asOfArg.slice(8)) : new Date();
const maxAgeMinutes = maxAgeArg ? Number(maxAgeArg.slice(18)) : 60;
const gate = evaluateCommercialSnapshot(snapshot, { now, maxAgeMinutes });
const output = path.resolve(outputArg?.slice(9) || input.replace(/\.json$/i, '.gate.json'));
await writeFile(output, JSON.stringify(gate, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ completed: true, input, output, passed: gate.passed, failedChecks: gate.failedChecks }));
if (!gate.passed) process.exitCode = 2;
