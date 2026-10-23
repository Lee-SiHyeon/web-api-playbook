import { throwIfBlocked } from './core.mjs';

export const platform = 'naver-clip';
export const expectedOwner = '@lifehack__ailab';
export const capability = Object.freeze({
  status: 'blocked',
  candidateMode: 'browser_assisted_upload',
  blockers: Object.freeze([
    'current_browser_runtime_unavailable',
    'upload_session_transfer_and_draft_sequence_uncaptured',
    'private_or_draft_visibility_not_verified',
    'upload_writer_not_implemented',
  ]),
  evidence: 'The existing Naver Clip client supports profile, progress, and content-list reads only. Prior upload-flow candidates were static bundle observations, not retained request captures.',
});

// Profile/content reads do not establish a safe write contract. Keep all video
// writes closed until a nonpublic UI flow and its ordered create phases are observed.
export async function uploadVideo(_input, _options = {}) {
  throwIfBlocked(platform, capability);
}
