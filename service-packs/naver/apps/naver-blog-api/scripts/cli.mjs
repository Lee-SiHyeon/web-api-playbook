import { read, operations, ApiError } from './client.mjs';

try {
  const flags = process.argv.slice(2);
  if (flags.some(f => !['--list', '--data'].includes(f)) || (flags.includes('--list') && flags.includes('--data'))) throw new ApiError('INPUT', 'Supported flags: --list OR --data');
  if (flags.includes('--list')) {
    console.log(JSON.stringify(operations, null, 2));
  } else {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 65536) throw new ApiError('INPUT', 'Input exceeds 64 KiB');
    }
    let request;
    try { request = JSON.parse(input); } catch { throw new ApiError('INPUT', 'Provide a JSON request on stdin'); }
    const result = await read(request);
    console.log(JSON.stringify(flags.includes('--data') ? result.data : result.evidence, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof ApiError ? error.code : 'INTERNAL', message: error instanceof ApiError ? error.message : 'Unexpected local error', ...(error instanceof ApiError ? error.details : {}) }));
  process.exitCode = 1;
}
