#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { jsonFile, options, report, reserveOutput, safeError } from '../lib/cli.mjs';
import { prepareRecordPlan, validateRecordSet, verifyPublicDomain, verifyPublicDns, verifyPublicHttps } from '../lib/gabia-dns.mjs';

let output;
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'status' && args.length === 0) {
    await report({ schema: 'gabia-pack-status-v1', networkUsed: false,
      publicDns: { implemented: true, resolvers: ['Google Public DNS over HTTPS', 'Cloudflare DNS over HTTPS'] },
      authoritativeDns: { status: 'not_queried', evidenceBoundary: 'Public checks show recursive resolver answers only' },
      publicHttps: { implemented: true, tlsValidation: 'strict_platform_default', redirects: 'same-domain apex/www only' },
      prepareRecords: { implemented: true, writesExecuted: false },
      authenticatedConsole: {
        status: 'separate_authenticated_reader',
        reference: 'node scripts/gabia-read.mjs status',
        documentation: 'references/gabia-login-dns.md',
      },
      dnsWrites: { supported: false, reason: 'No observed authenticated Gabia write contract; fail closed' } });
  } else if (command === 'prepare') {
    const opts = options(args, ['input', 'output']);
    if (typeof opts.input !== 'string' || opts.output !== undefined && typeof opts.output !== 'string') {
      throw Object.assign(new Error(), { code: 'GABIA_ARGUMENT_INVALID' });
    }
    output = await reserveOutput(opts.output);
    const plan = prepareRecordPlan(await jsonFile(opts.input));
    await report(plan, output);
    if (plan.status !== 'prepared_only') process.exitCode = 2;
  } else if (command === 'verify') {
    const opts = options(args, ['input', 'url', 'output']);
    if (typeof opts.input !== 'string' || opts.url !== undefined && typeof opts.url !== 'string'
        || opts.output !== undefined && typeof opts.output !== 'string') {
      throw Object.assign(new Error(), { code: 'GABIA_ARGUMENT_INVALID' });
    }
    output = await reserveOutput(opts.output);
    const rawRecordSet = await jsonFile(opts.input);
    const recordSet = validateRecordSet(rawRecordSet);
    const result = opts.url === undefined
      ? await verifyPublicDomain({ recordSet: rawRecordSet })
      : await Promise.all([
        verifyPublicDns({ recordSet: rawRecordSet }),
        verifyPublicHttps({ domain: recordSet.domain, url: opts.url }),
      ]).then(([dns, https]) => ({ schema: 'gabia-public-domain-check-v1', domain: recordSet.domain,
        status: dns.status === 'verified' && https.status === 'reachable' ? 'verified'
          : dns.status === 'inconclusive' ? 'inconclusive' : 'needs_attention',
        networkUsed: true, writesExecuted: false, dns, https }));
    await report(result, output);
    if (result.status !== 'verified') process.exitCode = 2;
  } else {
    const usage = `Usage:\n  node ${fileURLToPath(import.meta.url)} status\n  node ${fileURLToPath(import.meta.url)} prepare --input=examples/gabia/lifehackailab-records.json\n  node ${fileURLToPath(import.meta.url)} verify --input=examples/gabia/lifehackailab-records.json [--url=https://lifehackailab.com/]`;
    if (command === 'help' || command === '--help' || command === undefined) console.log(usage);
    else throw Object.assign(new Error(), { code: 'GABIA_ARGUMENT_INVALID' });
  }
} catch (error) {
  await report({ ok: false, code: safeError(error), networkUsed: false, writesExecuted: false }, output);
  process.exitCode = 1;
} finally {
  await output?.close();
}
