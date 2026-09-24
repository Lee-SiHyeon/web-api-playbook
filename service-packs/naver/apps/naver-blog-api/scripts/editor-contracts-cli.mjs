import { ApiError } from './client.mjs';
import { getEditorCandidate, listEditorCandidates } from './editor-contracts.mjs';

try {
  const args = process.argv.slice(2);
  let capability = null;
  let mutationOnly = false;
  let id = null;
  for (const arg of args) {
    if (arg === '--mutation-only') { mutationOnly = true; continue; }
    const capabilityMatch = /^--capability=([a-z_]{1,64})$/.exec(arg);
    if (capabilityMatch) { capability = capabilityMatch[1]; continue; }
    const idMatch = /^--id=([a-f0-9]{20})$/.exec(arg);
    if (idMatch) { id = idMatch[1]; continue; }
    if (arg === '--list') continue;
    throw new ApiError('INPUT', 'Supported flags: --list, --mutation-only, --capability=<name>, --id=<candidate-id>');
  }
  if (id && (capability || mutationOnly)) throw new ApiError('INPUT', '--id cannot be combined with filters');
  const output = id ? getEditorCandidate(id) : listEditorCandidates({ capability, mutationOnly });
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof ApiError ? error.code : 'INTERNAL',
    message: error instanceof ApiError ? error.message : 'Unexpected editor contract CLI error' }));
  process.exitCode = 1;
}
