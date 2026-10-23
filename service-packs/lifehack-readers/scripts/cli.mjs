import { stdinJsonNoEcho, safeError } from '../../../lib/cli.mjs';
import { readDanawaTarget } from '../src/lib/collectors/danawa.mjs';
import { searchDanawaProducts, readDanawaProductOffers } from '../src/lib/collectors/danawa-discovery.mjs';

const operations = ['danawa-target', 'danawa-search', 'danawa-offers', 'eleventh', 'naver-deals'];
const command = process.argv[2] ?? 'describe';
try {
  if (['describe', 'help', '--help'].includes(command)) {
    process.stdout.write(JSON.stringify({ operations, networkUsed: false, input: 'run accepts one JSON object on stdin' }) + '\n');
  } else {
    if (command !== 'run' || process.argv.length !== 3) throw Object.assign(new Error('INPUT_INVALID'), { code: 'INPUT_INVALID' });
    const input = await stdinJsonNoEcho(64 * 1024);
    if (!input || !operations.includes(input.operation)) throw Object.assign(new Error('OPERATION_UNKNOWN'), { code: 'OPERATION_UNKNOWN' });
    let result;
    if (input.operation === 'danawa-target') result = await readDanawaTarget(input.sourceOfferId);
    if (input.operation === 'danawa-search') result = await searchDanawaProducts(input.query);
    if (input.operation === 'danawa-offers') result = await readDanawaProductOffers(input.pcode);
    if (input.operation === 'eleventh') {
      const { collectEleventh } = await import('../src/lib/hub/collectors/eleventh.ts');
      result = await collectEleventh(fetch, 'Web-API-Playbook/1.0', new Date());
    }
    if (input.operation === 'naver-deals') {
      const { collectNaverShopping } = await import('../src/lib/hub/collectors/naver-shopping.ts');
      result = await collectNaverShopping(fetch, 'Web-API-Playbook/1.0', new Date());
    }
    process.stdout.write(JSON.stringify({ operation: input.operation, result }) + '\n');
    if (result?.blocked === true || result?.error) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: safeError(error) }) + '\n');
  process.exitCode = 1;
}
