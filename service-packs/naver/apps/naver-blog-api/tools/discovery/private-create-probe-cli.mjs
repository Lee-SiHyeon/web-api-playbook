import path from 'node:path';
import { open } from 'node:fs/promises';
import { environmentSession } from '../../scripts/api/environment-session.mjs';
import { WriteJournal } from '../../scripts/api/write-journal.mjs';
import { verifyPrivateCreate } from './private-create-probe.mjs';

let session, output;
try {
  const args = process.argv.slice(2), options = {};
  for (const arg of args) {
    const match = /^--(blog-id|journal|output|probe)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('INPUT');
    options[match[1]] = match[2];
  }
  if (!options['blog-id'] || !options.journal || !options.output) throw Error('INPUT');
  session = environmentSession({ NAVER_COOKIE: process.env.NAVER_COOKIE });
  output = await open(path.resolve(options.output), 'wx', 0o600);
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw Error('INPUT_LIMIT');
    chunks.push(chunk);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const receipt = await verifyPrivateCreate(envelope, { blogId: options['blog-id'], session,
    journal: new WriteJournal(path.resolve(options.journal)), probe: options.probe || 'browser' });
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, ...receipt }));
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'PROBE_FAILED';
  const receipt = { ok: false, code, details: error.details || {} };
  if (output) await output.writeFile(JSON.stringify(receipt) + '\n');
  console.log(JSON.stringify(receipt));
  process.exitCode = 2;
} finally { await output?.close(); session?.clear(); }
