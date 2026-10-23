import { createNaverClipClient, summarizeNaverClipOperation } from './naver-clip.mjs';

try {
  const command = process.argv[2] || 'probe';
  if (process.argv.length > 3 || !['probe', 'content-list'].includes(command)) {
    throw Object.assign(new Error(), { code: 'NAVER_CLIP_COMMAND_INVALID' });
  }
  const client = createNaverClipClient();
  const result = command === 'content-list'
    ? summarizeNaverClipOperation(await client.readContentList())
    : await client.probe();
  console.log(JSON.stringify(result));
  if (result.operations?.some(operation => operation.errorCode || operation.authenticatedRead === false)
    || result.errorCode || result.authenticatedRead === false) {
    process.exitCode = 2;
  }
} catch (error) {
  const code = /^NAVER_CLIP_[A-Z0-9_]+$/.test(error?.code || '')
    ? error.code : 'NAVER_CLIP_OPERATION_FAILED';
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 2;
}
