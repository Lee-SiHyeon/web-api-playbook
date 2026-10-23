import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const commands = Object.freeze({
  'category-tree': 'category-tree.mjs', 'category-branch': 'category-branch.mjs',
  partners: 'partners.mjs', 'daily-report': 'daily-report.mjs', reviews: 'reviews.mjs',
  measurements: 'measurements.mjs', 'price-check': 'price-check.mjs',
  'affiliate-link': 'affiliate-link.mjs', 'intake-poll': 'intake-poll.mjs',
  'publication-health': 'publication-health.mjs',
});

export function automationCommand(args) {
  const [command, ...rest] = args;
  if (!command || ['help', '--help'].includes(command)) return { file: 'help.mjs', args: [] };
  if (!Object.hasOwn(commands, command)) throw Object.assign(new Error('AUTOMATION_COMMAND_UNKNOWN'), { code: 'AUTOMATION_COMMAND_UNKNOWN' });
  return { file: commands[command], args: rest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const selected = automationCommand(process.argv.slice(2));
    const child = spawn(process.execPath, [fileURLToPath(new URL(selected.file, import.meta.url)), ...selected.args],
      { stdio: 'inherit', shell: false });
    child.once('error', () => { process.stderr.write('AUTOMATION_CHILD_FAILED\n'); process.exitCode = 1; });
    child.once('close', code => { process.exitCode = code ?? 1; });
  } catch (error) {
    process.stderr.write((error.code ?? 'AUTOMATION_COMMAND_FAILED') + '\n');
    process.exitCode = 1;
  }
}
