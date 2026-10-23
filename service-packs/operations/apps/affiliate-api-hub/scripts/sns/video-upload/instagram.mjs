import { throwIfBlocked } from './core.mjs';

export const platform = 'instagram';
export const expectedOwner = 'lifehack__ailab';
export const capability = Object.freeze({
  status: 'blocked',
  candidateMode: 'browser_assisted_upload',
  blockers: Object.freeze([
    'current_browser_runtime_unavailable',
    'reel_source_type_unverified',
    'video_upload_and_configure_sequence_uncaptured',
    'private_or_draft_visibility_not_verified',
  ]),
  evidence: 'The existing Reel writer fails closed without source_type. No current upload, configure, AI-label, or owner-readback request was captured.',
});

// Do not call the existing native writer until the Reel configure value and
// nonpublic UI behavior are observed and every create phase can be journaled.
export async function uploadVideo(_input, _options = {}) {
  throwIfBlocked(platform, capability);
}
