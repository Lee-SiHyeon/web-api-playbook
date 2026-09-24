import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectApiOnlyState } from '../../workflows/affiliate-content-e2e/stage-gates.mjs';
import { readJsonFile } from './json-io.mjs';

function parseArgs(args) {
  const out = { input: null, output: null, required: [] };
  for (const arg of args) {
    if (arg.startsWith('--input=')) out.input = arg.slice(8);
    else if (arg.startsWith('--output=')) out.output = arg.slice(9);
    else if (arg.startsWith('--required=')) out.required = arg.slice(11).split(',').map(value => value.trim()).filter(Boolean);
    else if (!out.input) out.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.input) throw new Error('input path is required');
  return out;
}

function operationState(operation) {
  return {
    captured: Boolean(operation?.captured),
    client_exists: operation?.client_exists === true,
    remnant_free: operation?.remnant_free === true,
    credential_propagated: operation?.credential_propagated,
    live_replay: operation?.live_replay,
  };
}

const options = parseArgs(process.argv.slice(2));
const input = path.resolve(options.input);
const record = await readJsonFile(input);
let inspections = [];
if (Array.isArray(record)) {
  const selected = options.required.length
    ? record.filter(item => options.required.includes(item.operation))
    : record;
  inspections = selected.map(item => inspectApiOnlyState(operationState(item), { source: item.operation }));
} else if (record.sourceStates && typeof record.sourceStates === 'object') {
  const names = options.required.length ? options.required : Object.keys(record.sourceStates);
  inspections = names.map(name => inspectApiOnlyState(record.sourceStates[name], { source: name }));
} else if (record.sourceState) {
  inspections = [inspectApiOnlyState(record.sourceState, { source: record.mode || 'sourceState' })];
} else {
  throw new Error('input does not expose sourceStates, sourceState, or operation rows');
}
const missingRequired = options.required.filter(name => !inspections.some(item => item.source === name));
const passed = inspections.length > 0 && inspections.every(item => item.passed) && missingRequired.length === 0;
const result = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  input,
  passed,
  sourceCount: inspections.length,
  completeCount: inspections.filter(item => item.passed).length,
  incompleteCount: inspections.filter(item => !item.passed).length,
  missingRequired,
  inspections,
};
if (options.output) await writeFile(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(result, null, 2));
if (!passed) process.exitCode = 2;
