import path from 'node:path';
import { open } from 'node:fs/promises';
import { verifyHeadlessCreate } from './headless-create-probe.mjs';

let output, cookies;
try {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(blog-id|journal|output|write-output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('INPUT');
    options[match[1]] = match[2];
  }
  if (['blog-id','journal','output','write-output'].some(key => !options[key]) ||
      path.resolve(options.output) === path.resolve(options['write-output'])) throw Error('INPUT');
  output = await open(path.resolve(options.output), 'wx', 0o600);
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw Error('INPUT_LIMIT');
    chunks.push(chunk);
  }
  cookies = JSON.parse(Buffer.concat(chunks).toString('utf8')).cookies;
  chunks.forEach(chunk => chunk.fill(0));
  const evidence = await verifyHeadlessCreate({ cookies, blogId: options['blog-id'],
    journal: path.resolve(options.journal), output: path.resolve(options['write-output']),
    onStage: stage => console.log(JSON.stringify({ progress: stage })) });
  await output.writeFile(JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, ...evidence }));
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'HEADLESS_PROBE_FAILED';
  const result = { ok: false, code, details: error.details || {}, retryAllowed: false };
  if (output) await output.writeFile(JSON.stringify(result) + '\n');
  console.log(JSON.stringify(result)); process.exitCode = 2;
} finally {
  await output?.close();
  if (Array.isArray(cookies)) cookies.forEach(cookie => { cookie.value = ''; });
}
