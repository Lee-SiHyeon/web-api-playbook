export const SERVICE_ID = 'gemini-web';
export const SERVICE_ORIGIN = 'https://gemini.google.com';
export const CREDENTIAL_NAME = 'gemini-web-session-v1';
export const CAPABILITIES = Object.freeze(['text', 'history', 'image', 'video']);
export const OPERATION_NAMES = Object.freeze([
  'identity', 'text', 'history', 'history_list', 'history_search', 'history_read', 'edit', 'delete',
  'share_create', 'share_revoke', 'share_read', 'share_public_read', 'attachment_upload', 'attachment_download',
  'attachment_readback', 'model_list', 'model_select', 'settings_read', 'settings_update',
  'session_renewal', 'image', 'video',
]);
