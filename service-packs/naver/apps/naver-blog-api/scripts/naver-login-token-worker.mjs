import { issueNaverLoginToken } from './naver-login-token-provider.mjs';

// Token values travel only on the private parent/child IPC channel, never stdout.
if (typeof process.send !== 'function') {
  console.error('LOGIN_TOKEN_WORKER_IPC_REQUIRED');
  process.exit(2);
}
process.once('message', async request => {
  try {
    if (request?.operation !== 'issue-naver-login-token') throw new Error('LOGIN_TOKEN_WORKER_SCOPE');
    const result = await issueNaverLoginToken({ pageUrl: request.pageUrl, sdk: request.sdk });
    process.send(result, () => process.exit(result.token ? 0 : 2));
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'LOGIN_TOKEN_WORKER_FAILED';
    process.send({ token: null, receipt: { code, usableTokenReceived: false, browserEngineUsed: false } }, () => process.exit(2));
  }
});
