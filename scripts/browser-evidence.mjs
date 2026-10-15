import { readFile, stat, writeFile } from 'node:fs/promises';
import { summarizeAgentHar, summarizeReaCapture } from '../lib/browser-evidence.mjs';

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: node scripts/browser-evidence.mjs --format=har|rea --input=<capture> [--output=<new-file>]');
    console.log('Outputs value-free contract metadata; review routes and field names before sharing. No HTTP replay or REA envelope authentication.');
    process.exit(0);
  }
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(format|input|output)=(.+)$/.exec(arg);
    if (!match) throw new Error('BROWSER_EVIDENCE_ARGUMENT_INVALID');
    return [match[1], match[2]];
  }));
  if (!args.input || !['har', 'rea'].includes(args.format)) throw new Error('BROWSER_EVIDENCE_ARGUMENT_INVALID');
  const info = await stat(args.input);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('BROWSER_EVIDENCE_INPUT_LIMIT');
  const input = JSON.parse((await readFile(args.input, 'utf8')).replace(/^\uFEFF/, ''));
  const result = args.format === 'har' ? summarizeAgentHar(input) : summarizeReaCapture(input);
  const text = JSON.stringify(result, null, 2) + '\n';
  if (args.output) { await writeFile(args.output, text, { flag: 'wx' }); console.log(JSON.stringify({ written: true, schema: result.schema, producer: result.producer })); }
  else process.stdout.write(text);
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'BROWSER_EVIDENCE_FAILED' }));
  process.exitCode = 1;
}
