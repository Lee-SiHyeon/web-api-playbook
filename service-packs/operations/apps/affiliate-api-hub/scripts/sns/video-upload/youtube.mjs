import { throwIfBlocked } from './core.mjs';

export const platform = 'youtube';
export const expectedOwner = 'UCtLdZc1Ooz6KLbDNfo60E5A';
export const capability = Object.freeze({
  status: 'blocked',
  candidateMode: 'browser_assisted_upload',
  blockers: Object.freeze([
    'current_browser_runtime_unavailable',
    'private_final_metadata_flow_not_verified',
    'existing_sender_requires_public_visibility',
  ]),
  evidence: 'A browser-assisted HTTP upload was verified on 2026-09-28, but it published publicly. The current sender only validates a public final metadata update.',
});

// The existing YouTube sender publishes PUBLIC metadata. Keep this entry point
// closed until a private native Studio flow and its full create-phase plan are verified.
export async function uploadVideo(_input, _options = {}) {
  throwIfBlocked(platform, capability);
}
