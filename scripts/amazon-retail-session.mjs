#!/usr/bin/env node
import { stdinJson, report, safeError } from '../lib/cli.mjs';
import { importAmazonRetailSession, amazonRetailStatus } from '../lib/retail/amazon-retail-session.mjs';
try {
  const [operation, ...rest] = process.argv.slice(2);
  if (rest.length || !['status','import'].includes(operation)) throw Object.assign(new Error(), { code: 'AMAZON_SESSION_ARGUMENT_INVALID' });
  await report(operation === 'status' ? amazonRetailStatus() : await importAmazonRetailSession(await stdinJson()));
} catch (error) { await report({ ok: false, code: safeError(error) }); process.exitCode = 1; }
