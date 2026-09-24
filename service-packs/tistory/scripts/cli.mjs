import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { login, requestManagement, safeError } from '../lib/operations.mjs';

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  const allowed = /^(?:--renew|--output=.+)$/;
  if (args.some(arg => !allowed.test(arg)) || args.filter(arg => arg.startsWith('--output=')).length > 1) throw new Error();
  let result;
  if (command === 'login' || command === 'status') {
    if (command === 'status' && args.includes('--renew')) throw new Error();
    result = await login({ renew: args.includes('--renew'), statusOnly: command === 'status' });
  } else if (command === 'request' && !args.includes('--renew')) {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error(); }
    const response = await requestManagement(JSON.parse(input));
    result = { httpStatus: response.httpStatus, mime: response.mime, bytes: response.bytes, schema: response.schema, auth: response.auth };
  } else throw new Error();
  const output = args.find(arg => arg.startsWith('--output='))?.slice(9);
  if (output) await writeFile(path.resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: safeError(error), browserStarted: false })); process.exitCode = 1; });
