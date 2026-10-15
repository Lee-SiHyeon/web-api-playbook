#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { options, reserveOutput, report, safeError } from '../lib/cli.mjs';
import { safeRelativePath } from '../lib/capability-checklist.mjs';
import { projectOverseasRetail } from '../lib/retail/ontology.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
let output;
try {
  const opts = options(process.argv.slice(2), ['input', 'proof', 'output']);
  if (!safeRelativePath(opts.input) || !safeRelativePath(opts.proof)) throw new Error('ARGUMENT_INVALID');
  const bytes = await readFile(path.join(root, opts.input));
  if (bytes.length > 2 * 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
  const run = JSON.parse(bytes);
  const proof = JSON.parse(await readFile(path.join(root, opts.proof), 'utf8'));
  if (proof.schema !== 'web-api-public-read-receipt-v1' || proof.service !== run.service
    || proof.schemaVerified !== true || proof.expectedResultVerified !== true
    || proof.contractProvenance?.kind !== 'direct_http_observed'
    || proof.contractProvenance.projectionSha256 !== sha(JSON.stringify(run.data))
    || proof.implementation?.[opts.input] !== sha(bytes)) throw new Error('PROOF_MISMATCH');
  for (const [file, expected] of Object.entries(proof.implementation)) {
    if (!safeRelativePath(file) || sha(await readFile(path.join(root, file))) !== expected) throw new Error('PROOF_STALE');
  }
  const projection = projectOverseasRetail(run);
  projection.input = { file: opts.input, sha256: sha(bytes), proof: opts.proof };
  projection.implementation = {};
  for (const file of ['lib/retail/ontology.mjs', 'scripts/overseas-retail-ontology.mjs'])
    projection.implementation[file] = sha(await readFile(path.join(root, file)));
  output = await reserveOutput(opts.output);
  await report(projection, output);
} catch (error) {
  await report({ ok: false, networkUsed: false, databaseWrites: 0, code: safeError(error) }, output);
  process.exitCode = 1;
} finally { await output?.close(); }
