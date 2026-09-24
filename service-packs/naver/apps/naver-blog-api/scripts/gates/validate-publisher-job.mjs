import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluatePublisherJobGate } from './publisher-gates.mjs';
import { readJsonFile } from './json-io.mjs';

const target = path.resolve(process.argv[2] || 'publisher-job.json');
const output = path.resolve(process.argv[3] || target.replace(/\.json$/i, '.gate.json'));
const job = await readJsonFile(target);
const gate = await evaluatePublisherJobGate(job, { baseDir: path.dirname(target) });
await writeFile(output, JSON.stringify(gate, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ completed: true, input: target, output, passed: gate.passed, failedChecks: gate.failedChecks }));
if (!gate.passed) process.exitCode = 2;
