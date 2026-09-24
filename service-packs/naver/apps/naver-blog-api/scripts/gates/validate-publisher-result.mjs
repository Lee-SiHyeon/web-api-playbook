import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluatePublisherResultGate } from './publisher-gates.mjs';
import { readJsonFile } from './json-io.mjs';

const jobPath = path.resolve(process.argv[2] || 'publisher-job.json');
const resultPath = path.resolve(process.argv[3] || 'publisher-result.json');
const output = path.resolve(process.argv[4] || resultPath.replace(/\.json$/i, '.gate.json'));
const [job, payload] = await Promise.all([readJsonFile(jobPath), readJsonFile(resultPath)]);
const gate = evaluatePublisherResultGate(job, payload);
await writeFile(output, JSON.stringify(gate, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ completed: true, job: jobPath, result: resultPath, output, passed: gate.passed, failedChecks: gate.failedChecks }));
if (!gate.passed) process.exitCode = 2;
