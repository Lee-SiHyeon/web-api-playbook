import { readFile } from 'node:fs/promises';
import { ChatGPTWebClient } from './client.mjs';
import { downloadSummary, responseSummary, safeCliFailure, streamSummary } from './cli-output.mjs';
import { ChatGPTWebError } from './errors.mjs';

function parseArgs(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--')) throw new ChatGPTWebError('CLI_ARGUMENT_INVALID');
    const key = name.slice(2);
    if (!['operation', 'inputs', 'file', 'out', 'journal-id'].includes(key)) throw new ChatGPTWebError('CLI_OPTION_UNKNOWN');
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new ChatGPTWebError('CLI_OPTION_VALUE_REQUIRED');
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

async function readInputs(file) {
  if (!file) return {};
  try {
    const bytes = await readFile(file);
    if (bytes.length > 1_000_000) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ChatGPTWebError('INPUT_FILE_INVALID'); }
}

function usage() {
  console.log([
    'ChatGPT web contract-driven direct HTTP client',
    '  npm run status',
    '  npm run contracts',
    '  npm run bootstrap',
    '  node src/cli.mjs read --operation <captured-operation-id> [--inputs <private-json-file>]',
    '  node src/cli.mjs stream --operation <captured-operation-id> [--inputs <private-json-file>]',
    '  node src/cli.mjs send --operation <captured-operation-id> [--inputs <private-json-file>]',
    '  node src/cli.mjs upload --operation <captured-upload-id> --file <path> [--inputs <private-json-file>]',
    '  node src/cli.mjs download --operation <captured-download-id> --out <path> [--inputs <private-json-file>]',
    '  node src/cli.mjs journals',
    'No ChatGPT operation is enabled until its browser XHR contract is observed and recorded.',
  ].join('\n'));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') return usage();
  const client = await ChatGPTWebClient.create();
  if (command === 'status') {
    console.log(JSON.stringify(await client.status()));
    return;
  }
  if (command === 'contracts') {
    const { operations, ...status } = client.registry;
    console.log(JSON.stringify({ service: status.service, captured: status.captured,
      operationIds: operations.map(({ id, kind, family, captured }) => ({ id, kind, family, captured })) }));
    return;
  }
  if (command === 'journals') {
    console.log(JSON.stringify({ journals: await client.listJournals() }));
    return;
  }
  const operationId = options.operation;
  if (!operationId) throw new ChatGPTWebError('CLI_OPERATION_REQUIRED');
  const inputs = await readInputs(options.inputs);
  if (command === 'read') {
    console.log(JSON.stringify(responseSummary(await client.sendRead(operationId, inputs))));
    return;
  }
  if (command === 'stream') {
    const result = await client.streamRead(operationId, inputs);
    console.log(JSON.stringify(await streamSummary(result)));
    return;
  }
  if (command === 'send') {
    const result = await client.sendMutation(operationId, inputs);
    console.log(JSON.stringify(result.events ? await streamSummary(result) : responseSummary(result)));
    return;
  }
  if (command === 'upload') {
    if (!options.file) throw new ChatGPTWebError('CLI_FILE_REQUIRED');
    const result = await client.uploadMedia(operationId, inputs, options.file);
    console.log(JSON.stringify({ operationId: result.operationId, journalId: result.journalId,
      state: result.state, httpStatus: result.httpStatus, mimeType: result.mimeType }));
    return;
  }
  if (command === 'download') {
    if (!options.out) throw new ChatGPTWebError('CLI_OUTPUT_REQUIRED');
    console.log(JSON.stringify(downloadSummary(await client.downloadMedia(operationId, inputs, options.out))));
    return;
  }
  if (command === 'reconcile') {
    throw new ChatGPTWebError('RECONCILIATION_MATCHER_REQUIRED');
  }
  throw new ChatGPTWebError('CLI_COMMAND_UNKNOWN');
}

main().catch((error) => {
  if (error instanceof ChatGPTWebError) {
    console.error(JSON.stringify({ error: error.code, ...error.details }));
  } else console.error(JSON.stringify(safeCliFailure(error)));
  process.exitCode = 1;
});
