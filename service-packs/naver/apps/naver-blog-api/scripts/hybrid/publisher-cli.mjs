import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runHeadlessPublication } from './publisher.mjs';

try {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(command|job|journal|output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('INPUT');
    options[match[1]] = match[2];
  }
  if (!options.job || !options.command || !options.output || !options.journal) throw Error('INPUT');
  const jobPath = path.resolve(options.job);
  const job = JSON.parse((await readFile(jobPath, 'utf8')).replace(/^\uFEFF/, ''));
  const cookieHeader = process.env.NAVER_COOKIE;
  delete process.env.NAVER_COOKIE; // Playwright children do not inherit credentials.
  const result = await runHeadlessPublication({ job, jobPath, baseDir: path.dirname(jobPath),
    command: options.command, cookieHeader, journal: path.resolve(options.journal), output: path.resolve(options.output),
    onStage: progress => console.log(JSON.stringify({ progress })) });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: /^[A-Z_]+$/.test(error.code || error.message || '')
    ? error.code || error.message : 'HYBRID_FAILED', details: error.details || {}, retryAllowed: false }));
  process.exitCode = 2;
}
