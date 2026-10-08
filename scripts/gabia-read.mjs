#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { options, report, reserveOutput, safeError, stdinJson } from '../lib/cli.mjs';
import { createGabiaReadClient } from '../lib/gabia-read.mjs';

let output;
try {
  const [command = 'status', ...args] = process.argv.slice(2);
  const opts = options(args, ['credentials-stdin', 'receipt']);
  if (!['status', 'read'].includes(command)
      || (opts['credentials-stdin'] !== undefined && opts['credentials-stdin'] !== true)
      || (opts.receipt !== undefined && typeof opts.receipt !== 'string')
      || (command === 'status' && (opts['credentials-stdin'] !== undefined || opts.receipt !== undefined))
      || (command === 'read' && opts['credentials-stdin'] !== true)) {
    throw Object.assign(new Error(), { code: 'GABIA_COMMAND_NOT_ALLOWED' });
  }

  output = await reserveOutput(opts.receipt);
  if (command === 'status') {
    await report({
      schema: 'gabia-read-status-v1', service: 'gabia', networkUsed: false, writesExecuted: false,
      authentication: { loginAcquisition: 'browser_automation_google_login',
        credentialHandoff: 'process_memory_stdin', businessRequests: 'pure_http_node_fetch',
        browserUsedForBusiness: false, sessionPersistence: false, renewal: 'not_tested' },
      operations: {
        owner: { status: 'replay_verified', method: 'GET', origin: 'https://gabia-user-api.gabia.com', path: '/v1/users/me' },
        domainList: { status: 'replay_verified', method: 'GET', origin: 'https://dns.gabia.com', path: '/dns/ajax/domain' },
        dnsRecords: { status: 'replay_verified', method: 'GET', origin: 'https://dns.gabia.com', path: '/dns/ajax/dns' },
        writes: { status: 'not_implemented', reason: 'No authenticated write was dispatched or independently reconciled' },
      },
    }, output);
  } else {
    const input = await stdinJson(1024 * 1024);
    const reader = createGabiaReadClient({ input });
    // The session object has copied the cookie values into its in-memory jar.
    // Remove the separately parsed stdin copy before any business request.
    if (Array.isArray(input?.cookies)) for (const cookie of input.cookies) {
      if (cookie && typeof cookie === 'object') cookie.value = '';
    }
    if (input && typeof input === 'object') input.expectedUserId = '';
    const result = await reader.readDomain();
    await report({ ok: true, ...result }, output);
  }
} catch (error) {
  await report({ ok: false, service: 'gabia', code: safeError(error),
    ...(error?.receipt ? { receipt: error.receipt } : {}), networkUsed: error?.receipt !== undefined,
    writesExecuted: false }, output);
  process.exitCode = 2;
} finally {
  await output?.close();
}
