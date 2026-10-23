import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_PROFILE, PROFILE_OWNER,
  INSTAGRAM_ORIGIN,
  buildFreshInstagramProfilePictureMutationRequest, buildInstagramProfileEditRequest, buildInstagramProfilePictureRequests,
  buildThreadsProfileEditRequest, readProfilePictureFile, redactProfileRequest, sendInstagramProfile,
  sendInstagramProfilePicture,
} from './sns/writers/profile.mjs';
import { defaultJournalDir } from './sns/writers/journal.mjs';

export const DEFAULT_PROFILE_PICTURE_PATH = 'C:/Users/User/Documents/Codex/2026-09-28/brand-logo/logo-b.png';
const fail = code => { throw Object.assign(new Error(code), { code }); };

function previewSession(service) {
  return {
    service, owner: PROFILE_OWNER,
    cookies: ['sessionid', 'csrftoken', 'ds_user_id', 'rur'].map(name => ({ name, value: '<redacted>' })),
    ownerRequest: { headers: {
      'x-ig-app-id': '<redacted>', 'x-asbd-id': '<redacted>', 'x-fb-lsd': '<redacted>',
      'x-web-session-id': '<redacted>', 'x-ig-www-claim': '<redacted>', 'x-instagram-ajax': '<redacted>',
    } },
  };
}

function dryRunInstagramRequests({ profile, picture, session, pictureOnly = false }) {
  const uploadId = 'DRY-RUN-PROFILE-PICTURE';
  const requests = buildInstagramProfilePictureRequests({ ...picture, uploadId, session });
  if (pictureOnly) {
    const context = {
      bundle: { ...session, origin: INSTAGRAM_ORIGIN, cookies: session.cookies.map(cookie => ({ ...cookie,
        domain: 'instagram.com', path: '/', secure: true })) },
      createdAt: Date.now(), requestCount: 0,
      document: { modules: new Map([
        ['SiteData', { haste_session: 'DRY-RUN', pr: 1, client_revision: 1, hsi: 'DRY-RUN', comet_env: 1,
          __spin_r: 1, __spin_b: 'trunk', __spin_t: 1 }],
        ['RelayAPIConfigDefaults', { actorID: '0', graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': '<redacted>' } }],
        ['DTSGInitialData', { token: 'DRY-RUN-FRESH-DTSG' }], ['LSD', { token: 'DRY-RUN-FRESH-LSD' }],
        ['CurrentUserInitialData', { USER_ID: '0' }],
        ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
      ]), route: { canonicalRouteName: 'DRY-RUN' } },
      sources: new Map([['DTSGUtils', { source: 'token.charCodeAt(0); SprinkleConfig' }]]),
    };
    requests[1] = buildFreshInstagramProfilePictureMutationRequest({ uploadId, session, context });
  }
  return (pictureOnly ? requests : [buildInstagramProfileEditRequest({ profile, session }), ...requests])
    .map(redactProfileRequest);
}

async function sendTransport(request) {
  const headers = { ...request.headers };
  let body = request.body;
  if (body instanceof URLSearchParams) body = body.toString();
  else if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    body = JSON.stringify(body);
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  return fetch(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }),
    redirect: 'error', signal: AbortSignal.timeout(20000) });
}

export async function runSnsProfile({ channel, dryRun = false, approvalId, profile = DEFAULT_PROFILE,
  picturePath = DEFAULT_PROFILE_PICTURE_PATH, pictureOnly = false, journalDir, transport = sendTransport } = {}) {
  if (!['instagram', 'threads'].includes(channel)) fail('SNS_ARGUMENTS_INVALID');
  if (pictureOnly && channel !== 'instagram') fail('SNS_ARGUMENTS_INVALID');
  if (channel === 'threads') {
    if (!dryRun && (!approvalId || !approvalId.trim())) fail('APPROVAL_REQUIRED');
    try {
      buildThreadsProfileEditRequest({ session: previewSession('threads') });
      fail('THREADS_PROFILE_BUILDER_UNEXPECTEDLY_AVAILABLE');
    } catch (error) {
      if (error.code !== 'THREADS_PROFILE_CONTRACT_MISSING') throw error;
      return { channel, owner: PROFILE_OWNER, dryRun, approvalId: dryRun ? undefined : approvalId,
        requests: [], blockedReason: error.code,
        note: 'Threads profile edit request is not implemented because the cached first-party bundle set contains no profile edit operation.' };
    }
  }

  const picture = await readProfilePictureFile(picturePath);
  if (dryRun) {
    const requests = dryRunInstagramRequests({ profile, picture, session: previewSession('instagram'), pictureOnly });
    return { channel, owner: PROFILE_OWNER, dryRun: true, ...(pictureOnly ? { pictureOnly: true } : { profile }), picture: { path: picturePath,
      width: picture.width, height: picture.height, byteLength: picture.bytes.length },
      contractStatus: { ...(pictureOnly ? {} : { profileEdit: 'partially_verified', bioLinks: 'assumed' }),
        profilePicture: 'verified_from_code' }, requests };
  }
  if (typeof approvalId !== 'string' || !approvalId.trim()) fail('APPROVAL_REQUIRED');
  if (pictureOnly) return sendInstagramProfilePicture({ picture, approvalId, transport,
    journalDir: journalDir || defaultJournalDir() });
  return sendInstagramProfile({ profile, picture, approvalId, transport,
    journalDir: journalDir || defaultJournalDir() });
}

function cliArgs(argv) {
  const values = Object.fromEntries(argv.filter(arg => arg.startsWith('--') && arg.includes('='))
    .map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
  return { channel: values.channel, approvalId: values.approval, dryRun: argv.includes('--dry-run'),
    pictureOnly: argv.includes('--picture-only') };
}

async function main() {
  const result = await runSnsProfile(cliArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'SNS_PROFILE_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
