#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { options, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { safeRelativePath } from '../lib/capability-checklist.mjs';
import { projectAmazonRetail } from '../lib/retail/amazon-ontology.mjs';
let output;
try {
  const opts = options(process.argv.slice(2), ['inputs', 'output']);
  const files = typeof opts.inputs === 'string' ? opts.inputs.split(',') : [];
  if (!files.length || files.length > 100 || new Set(files).size !== files.length || files.some(f => !safeRelativePath(f)))
    throw Object.assign(new Error(), { code: 'AMAZON_ONTOLOGY_ARGUMENT_INVALID' });
  const inputs = await Promise.all(files.map(async file => {
    const raw = await readFile(file); if (raw.length > 4 * 1024 * 1024) throw Object.assign(new Error(), { code: 'AMAZON_ONTOLOGY_INPUT_TOO_LARGE' });
    return { file, sha256: createHash('sha256').update(raw).digest('hex'), run: JSON.parse(raw.toString('utf8')) };
  }));
  const result = projectAmazonRetail(inputs.map(i => i.run));
  output = await reserveOutput(opts.output);
  await report({ ...result, inputs: inputs.map(({ file, sha256 }) => ({ file, sha256 })) }, output);
} catch (error) { await report({ ok: false, code: safeError(error) }, output); process.exitCode = 1; }
finally { await output?.close(); }
