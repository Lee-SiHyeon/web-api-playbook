import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scopedLoginHeader } from './publisher-session-handoff.mjs';
import { collectHeadlessEnvelope as collectInputs, headlessCookies } from '../../scripts/hybrid/headless-inputs.mjs';
export { headlessCookies };
import { environmentSession } from '../../scripts/api/environment-session.mjs';
import { NaverEditorClient } from '../../scripts/api/editor-client.mjs';
import { HEADLESS_CREATE_TITLE, HEADLESS_CREATE_PARAGRAPHS,
  validatePrivateCreateEnvelope } from './private-create-probe.mjs';

// Explicit headless discovery only. The normal HTTP publisher never imports this
// module. No persistent profile, extension, stealth patch, or challenge solver.
const fail = code => { throw Error(code); };
export function collectHeadlessEnvelope(options, dependencies) {
  return collectInputs({ ...options, document: { blogId: options.blogId,
    title: HEADLESS_CREATE_TITLE,
    blocks: HEADLESS_CREATE_PARAGRAPHS.map(text => ({ type: 'paragraph', text })) } }, dependencies);
}

export async function publishHeadlessEnvelope({ envelope, cookieHeader, blogId, journal, output }, {
  spawnImpl = spawn, nodeExecutable = process.execPath, env = process.env,
} = {}) {
  validatePrivateCreateEnvelope(envelope, { blogId, probe: 'headless' });
  const app = fileURLToPath(new URL('../../', import.meta.url));
  const childEnv = { NAVER_COOKIE: cookieHeader };
  if (env.SystemRoot) childEnv.SystemRoot = env.SystemRoot;
  const secrets = [new URLSearchParams(envelope.body).get('tokenId'),
    ...cookieHeader.split(';').map(part => part.slice(part.indexOf('=') + 1).trim())];
  try {
    return await new Promise((resolve, reject) => {
      let outputText = '', oversized = false;
      const child = spawnImpl(nodeExecutable, ['tools/discovery/private-create-probe-cli.mjs',
        `--blog-id=${blogId}`, '--probe=headless', `--journal=${journal}`, `--output=${output}`], {
        cwd: app, windowsHide: true, shell: false, env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 45000,
      });
      const collect = chunk => {
        if (outputText.length + chunk.length > 32768) { oversized = true; child.kill(); return; }
        outputText += chunk.toString();
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.stdin.on('error', () => {});
      child.on('error', () => reject(Error('HEADLESS_HTTP_RUNNER_FAILED')));
      child.on('close', exitCode => {
        if (oversized || secrets.some(secret => secret && outputText.includes(secret)))
          return reject(Error('HEADLESS_HTTP_OUTPUT_REDACTED'));
        let data;
        try { data = JSON.parse(outputText); } catch { return reject(Error('HEADLESS_HTTP_OUTPUT_INVALID')); }
        if (exitCode !== 0 || data.ok !== true) {
          const error = Error('HEADLESS_HTTP_WRITE_NOT_VERIFIED');
          error.details = { code: /^[A-Z_]+$/.test(data.code || '') ? data.code : 'UNKNOWN',
            retryAllowed: false };
          return reject(error);
        }
        resolve(data);
      });
      child.stdin.end(JSON.stringify(envelope));
    });
  } finally { delete childEnv.NAVER_COOKIE; secrets.fill(''); }
}

export async function verifyHeadlessCreate({ cookies, blogId, journal, output, onStage = () => {} }, {
  collect = collectHeadlessEnvelope, publish = publishHeadlessEnvelope,
  verifyOwner = async session => new NaverEditorClient({ blogId, session }).loadEditor(undefined, { allowEmpty: true }),
} = {}) {
  const seeds = headlessCookies(cookies, blogId);
  const session = environmentSession({ NAVER_COOKIE: scopedLoginHeader(seeds) });
  let first, second;
  try {
    await verifyOwner(session);
    onStage('owner_http_verified');
    first = await collect({ cookies: seeds, blogId, onStage });
    if (!first.metadata.browserClosed) fail('HEADLESS_BROWSER_NOT_CLOSED');
    onStage('first_browser_closed');
    second = await collect({ cookies: seeds, blogId, onStage });
    if (!second.metadata.browserClosed) fail('HEADLESS_BROWSER_NOT_CLOSED');
    const tokensDiffer = new URLSearchParams(first.envelope.body).get('tokenId') !==
      new URLSearchParams(second.envelope.body).get('tokenId');
    if (!tokensDiffer) fail('HEADLESS_FRESH_TOKEN_UNVERIFIED');
    first.envelope.body = ''; first.cookieHeader = '';
    onStage('second_browser_closed_http_handoff');
    const receipt = await publish({ envelope: second.envelope, cookieHeader: second.cookieHeader,
      blogId, journal, output });
    return { schemaVersion: 1, checkedAt: new Date().toISOString(), operation: 'headlessPrivateCreateProbe',
      executionHost: `${process.platform === 'win32' ? 'Windows' : process.platform} ${hostname()}`, blogId,
      ownerHTTPVerified: true, browserRuns: [first.metadata, second.metadata],
      distinctSdkTokens: tokensDiffer, headlessRestartReissuanceVerified: true,
      browserClosedBeforeHTTPWrite: true, httpWrite: receipt,
      initialSessionSource: 'authorized_current_browser_cookie_handoff',
      passwordLoginVerified: false, loginSessionRenewalVerified: false,
      browserEngineFree: false, unattendedLongTermRenewalVerified: false,
      commercialPublicationQualityVerified: false, retainedSecrets: false };
  } finally {
    session.clear();
    for (const cookie of seeds) cookie.value = '';
    for (const capture of [first, second]) if (capture) { capture.cookieHeader = ''; capture.envelope.body = ''; }
  }
}
