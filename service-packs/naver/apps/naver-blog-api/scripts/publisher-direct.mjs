import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

// This Windows-user launcher only bridges the protected session to the
// maintained publisher process. Editorial, authorization, and write gates stay
// in the publisher. No credential value is written to files or command args.
const vaultPath = fileURLToPath(new URL('./session-vault.mjs', import.meta.url));
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const publisherPaths = {
  api: `${appRoot}\\scripts\\api\\publisher-cli.mjs`,
  headless: `${appRoot}\\scripts\\hybrid\\publisher-cli.mjs`,
  republish: `${appRoot}\\workflows\\republish\\run.mjs`,
};

let cookies;
let header = '';
try {
  if (process.platform !== 'win32') throw Error('WINDOWS_SESSION_REQUIRED');
  const raw = process.argv.slice(2);
  const modes = raw.filter(value => value.startsWith('--mode='));
  if (modes.length !== 1) throw Error('MODE_REQUIRED');
  const mode = modes[0].slice('--mode='.length);
  if (!Object.hasOwn(publisherPaths, mode)) throw Error('MODE_INVALID');
  const args = raw.filter(value => value !== modes[0]);
  if (args.some(value => /NAVER_COOKIE|NID_AUT|NID_SES|--cookie|--token/i.test(value))) {
    throw Error('CREDENTIAL_ARGUMENT_FORBIDDEN');
  }
  const { loadNaverCookies } = await import(pathToFileURL(vaultPath).href);
  const saved = await loadNaverCookies({ env: {} });
  if (saved.provider !== 'windows_dpapi_current_user' || saved.persisted !== true) throw Error('AUTH_MISSING');
  cookies = saved.cookies;
  const selected = ['NID_AUT', 'NID_SES'].map(name => {
    const matches = cookies.filter(cookie => cookie.name === name
      && cookie.domain?.toLowerCase() === '.naver.com'
      && cookie.path === '/'
      && cookie.secure === true
      && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
    if (matches.length !== 1) throw Error('AUTH_SCOPE_AMBIGUOUS');
    return matches[0];
  });
  header = selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  console.log(JSON.stringify({ launcher: 'naver-dpapi-direct', provider: saved.provider, mode, protectedStoreLoaded: true }));
  const exitCode = await new Promise((resolve, reject) => {
    const republish = mode === 'republish';
    const child = spawn(process.execPath, [publisherPaths[mode], ...args], {
      cwd: appRoot,
      env: { ...process.env, ...(republish ? {} : { NAVER_COOKIE: header }), NAVER_SESSION_VAULT_MODULE: vaultPath },
      stdio: republish ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      shell: false,
      windowsHide: true,
    });
    if (republish) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ cookieHeader: header }));
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 2)));
  });
  process.exitCode = exitCode;
} catch (error) {
  const code = /^(?:WINDOWS_SESSION_REQUIRED|MODE_REQUIRED|MODE_INVALID|CREDENTIAL_ARGUMENT_FORBIDDEN|AUTH_MISSING|AUTH_SCOPE_AMBIGUOUS)$/.test(error?.message || '')
    ? error.message : 'DIRECT_LAUNCH_FAILED';
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 2;
} finally {
  if (Array.isArray(cookies)) for (const cookie of cookies) cookie.value = '';
  header = '';
}
