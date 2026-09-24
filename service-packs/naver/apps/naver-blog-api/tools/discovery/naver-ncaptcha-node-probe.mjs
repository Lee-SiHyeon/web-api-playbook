import { issueLoginTokenInWorker } from '../../scripts/naver-login-token-client.mjs';

try {
  const result = await issueLoginTokenInWorker();
  console.log(JSON.stringify(result.receipt));
  if (!result.token) process.exitCode = 2;
  result.token = null;
} catch (error) {
  console.error(/^[A-Z_]+$/.test(error?.message || '') ? error.message : 'LOGIN_TOKEN_PROBE_FAILED');
  process.exitCode = 2;
}
