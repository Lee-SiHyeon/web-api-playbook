import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { FlowClient } from './client.mjs';
import { buildTextVideoRequest } from './protocol.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = path.join(APP_DIR, '.runtime', 'flow-video.mp4');

function parseArgs(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--confirm-generation') {
      options['confirm-generation'] = true;
      continue;
    }
    if (!key.startsWith('--')) throw new Error('Unexpected argument: ' + key);
    const name = key.slice(2);
    if (!['prompt', 'prompt-file', 'out', 'aspect', 'duration', 'resolution', 'project-id', 'job', 'media-id'].includes(name)) {
      throw new Error('Unknown option: --' + name);
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + name);
    options[name] = value;
    i += 1;
  }
  return { command, options };
}

async function readPrompt(options) {
  if (options.prompt && options['prompt-file']) throw new Error('Use either --prompt or --prompt-file.');
  if (options.prompt) return options.prompt;
  if (options['prompt-file']) return (await readFile(path.resolve(options['prompt-file']), 'utf8')).trim();
  throw new Error('Provide --prompt or --prompt-file.');
}

async function confirmGeneration(options) {
  if (options['confirm-generation']) return;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Non-interactive runs must include --confirm-generation to authorize one credit-consuming Flow generation.');
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question('This mints Flow CAPTCHA and submits one video generation using account credits. Continue? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Generation was not submitted.');
  } finally {
    readline.close();
  }
}

function usage() {
  console.log([
    'Google Flow Omni 1.1 Flash via observed Flow XHR',
    '  node src/cli.mjs generate --prompt-file ./prompt.txt [--aspect 16:9] [--duration 4] [--resolution 720p] [--out ./.runtime/video.mp4]',
    '  Add --confirm-generation for a non-interactive, explicitly authorized create request.',
    '  node src/cli.mjs download --media-id EXISTING_MEDIA_ID --out ./.runtime/existing.mp4',
    '  node src/cli.mjs list',
    '  node src/cli.mjs reconcile --job ./.runtime/jobs/YOUR_JOB_ID.json',
    '  node src/cli.mjs status',
    'Open a signed-in Flow project in Chrome. The local Flow Bridge extension must be installed and enabled.',
  ].join('\n'));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') return usage();
  if (command !== 'generate' && command !== 'download' && command !== 'list' && command !== 'status' && command !== 'reconcile') {
    throw new Error('Command must be generate, download, list, reconcile, or status.');
  }
  if (command === 'generate' && !options.prompt && !options['prompt-file']) throw new Error('Provide --prompt or --prompt-file.');
  if (command === 'reconcile' && !options.job) throw new Error('Provide --job for reconcile.');
  if (command === 'download' && (!options['media-id'] || !options.out)) {
    throw new Error('Provide --media-id and --out for download.');
  }

  const client = new FlowClient();
  try {
    await client.start();
    if (command === 'status') {
      const context = await client.getContext();
      console.log(JSON.stringify({ bridge: 'connected', flowProjectOpen: Boolean(context.projectId) }));
      return;
    }
    if (command === 'list') {
      const mediaIds = await client.listMediaIds();
      console.log(JSON.stringify({ count: mediaIds.length, mediaIds }));
      return;
    }
    if (command === 'reconcile') {
      const result = await client.reconcileJob(path.resolve(options.job));
      console.log(JSON.stringify({ status: 'downloaded', outputPath: result.outputPath, bytes: result.bytes, jobPath: result.jobPath }));
      return;
    }
    if (command === 'download') {
      const result = await client.downloadExistingVideo(options['media-id'], path.resolve(options.out));
      console.log(JSON.stringify({ status: 'downloaded', outputPath: result.outputPath, bytes: result.bytes }));
      return;
    }
    const prompt = await readPrompt(options);
    const projectId = options['project-id'] || (await client.getContext()).projectId;
    const generation = {
      prompt,
      aspect: options.aspect || '16:9',
      duration: Number(options.duration || 4),
      resolution: options.resolution || '720p',
      projectId,
    };
    buildTextVideoRequest(generation);
    const outputPath = await client.prepareOutputPath(path.resolve(options.out || DEFAULT_OUTPUT));
    await confirmGeneration(options);
    const result = await client.generateVideo({ ...generation, outputPath });
    console.log(JSON.stringify({ status: 'downloaded', outputPath: result.outputPath, bytes: result.bytes, jobPath: result.jobPath }));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  const message = error?.message || 'Flow operation failed.';
  console.error(message.replace(/[\r\n]+/g, ' ').slice(0, 240));
  process.exitCode = 1;
});
