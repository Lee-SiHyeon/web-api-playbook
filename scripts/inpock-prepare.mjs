// No credentials, HTTP client, account write, or automatic publication.
import { stdinJson, safeError } from '../lib/cli.mjs';
import { prepareInpockAffiliate } from '../lib/inpock-affiliate.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/inpock-prepare.mjs < SOURCE.json\n'
      + 'Input: {destination:"article"|"affiliate",is_open:boolean,source:{kind,...}}.\n'
      + 'naver-publication: job, jobGate, full publicationReceipt artifacts.\n'
      + 'brandconnect-shopping-link: explicit title, original input, linkResult, managementResult.\n'
      + 'Travel source receipts do not bind the requested product URL and are unsupported.\n'
      + 'Output is prepared_only. It does not authenticate receipts, make HTTP requests, or publish. Credentials are rejected.');
  } else {
    if (args.length) throw Object.assign(new Error('ARGUMENT_INVALID'), { code: 'ARGUMENT_INVALID' });
    console.log(JSON.stringify({ ok: true, ...prepareInpockAffiliate(await stdinJson()) }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: safeError(error), status: 'preparation_rejected',
    publicationPerformed: false, networkUsed: false }));
  process.exitCode = 2;
}
