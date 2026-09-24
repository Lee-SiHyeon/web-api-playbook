import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateStageGate, evaluatePublishPackageGate } from '../../workflows/affiliate-content-e2e/stage-gates.mjs';
import { readJsonFile } from './json-io.mjs';

const runDirectory = path.resolve(process.argv[2] || '.');
const state = await readJsonFile(path.join(runDirectory, 'state.json'));
const receiptDirectory = path.join(runDirectory, 'receipts');
const gateDirectory = path.join(runDirectory, 'gates');
const receiptFiles = (await readdir(receiptDirectory)).filter(name => name.endsWith('.json')).sort();
const stages = [];
for (const name of receiptFiles) {
  const stage = name.replace(/\.json$/, '');
  const receipt = await readJsonFile(path.join(receiptDirectory, name));
  const actual = evaluateStageGate(stage, receipt);
  let stored = null;
  try { stored = await readJsonFile(path.join(gateDirectory, name)); } catch {}
  stages.push({
    stage,
    passed: actual.passed && stored?.passed === true && stored?.inputFingerprint === actual.inputFingerprint,
    actual,
    storedFingerprint: stored?.inputFingerprint || null,
  });
}
let publishPackageGate = null;
try {
  const pkg = await readJsonFile(path.join(runDirectory, 'publish-package.json'));
  publishPackageGate = evaluatePublishPackageGate(pkg);
} catch {}
const completedStages = Object.entries(state.stages || {}).filter(([, value]) => value?.status === 'completed').map(([name]) => name);
const missingReceipts = completedStages.filter(name => !receiptFiles.includes(`${name}.json`));
const passed = stages.length > 0
  && stages.every(item => item.passed)
  && missingReceipts.length === 0
  && (!publishPackageGate || publishPackageGate.passed);
const result = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  runDirectory,
  runId: state.runId,
  status: state.status || null,
  passed,
  missingReceipts,
  stages,
  publishPackageGate,
};
await writeFile(path.join(gateDirectory, 'run-validation.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ completed: true, runId: state.runId, passed, stageCount: stages.length, missingReceipts }));
if (!passed) process.exitCode = 2;
