import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit one-time handoff from a supported, already authorized provider.
// This utility never opens a browser, reads profiles, writes credentials or
// changes the normal HTTP client's dependency graph.
export function scopedLoginHeader(cookies, now = Date.now()) {
  if (!Array.isArray(cookies)) throw Error('AUTH_MISSING');
  return ['NID_AUT', 'NID_SES'].map(name => {
    const matches = cookies.filter(c => c?.name === name &&
      ['.naver.com', 'blog.naver.com', '.blog.naver.com'].includes(c.domain) &&
      c.path === '/' && (c.expires <= 0 || c.expires * 1000 > now));
    if (matches.length !== 1 || typeof matches[0].value !== 'string' ||
        !matches[0].value || /[;\r\n\x00-\x20\x7f]/.test(matches[0].value)) throw Error('AUTH_MISSING');
    return `${name}=${matches[0].value}`;
  }).join('; ');
}

export async function runAuthorizedPublisher({cookies, args, nodeExecutable}, {
  spawnImpl = spawn, env = process.env, now = Date.now,
} = {}) {
  if (typeof nodeExecutable !== 'string' || !Array.isArray(args) ||
      args.some(a => typeof a !== 'string' || !/^--[a-z-]+=/.test(a) || /[\r\n\0]/.test(a)) ||
      args.some(a => /^--(?:cookie|token|env|from-chrome)=/.test(a))) throw Error('INPUT');
  let cookie = scopedLoginHeader(cookies, now());
  const childEnv = { NAVER_COOKIE: cookie };
  if (env.SystemRoot) childEnv.SystemRoot = env.SystemRoot;
  const app = fileURLToPath(new URL('../../', import.meta.url));
  try {
    return await new Promise(resolve => {
      let output = '', oversized = false;
      const child = spawnImpl(nodeExecutable, ['scripts/api/publisher-cli.mjs', ...args], {
        cwd: app, windowsHide: true, env: childEnv,
        shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
      });
      const collect = data => {
        if (output.length + data.length > 512 * 1024) {
          oversized = true; child.kill(); return;
        }
        output += data.toString();
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('error', () => resolve({ok:false,code:'RUNNER_SPAWN_FAILED'}));
      child.on('close', exitCode => {
        if (oversized) return resolve({ok:false,code:'RUNNER_OUTPUT_LIMIT'});
        // Never emit raw process exceptions or a credential echoed by a fault.
        if (cookies.some(c => ['NID_AUT','NID_SES'].includes(c?.name) && c?.value && output.includes(c.value)))
          return resolve({ok:false,code:'RUNNER_OUTPUT_REDACTED'});
        try { resolve({exitCode,...JSON.parse(output.trim())}); }
        catch { resolve({ok:false,exitCode,code:'RUNNER_OUTPUT_INVALID'}); }
      });
    });
  } finally { cookie = ''; delete childEnv.NAVER_COOKIE; }
}
