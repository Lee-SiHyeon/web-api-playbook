import { authError } from './auth.mjs';

// Observed from the current editor's image upload and caption autosave.
// Returned markup contains a signed media URL: use in memory or protected
// storage, not in plaintext diagnostics or publication receipts.
const escapeText = value => String(value).replace(/[&<>"'|\[\]]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  '|': '&#124;', '[': '&#91;', ']': '&#93;',
})[char]);

function attachmentReference(attachment) {
  let url;
  try { url = new URL(attachment?.url); } catch { throw authError('TISTORY_IMAGE_REFERENCE_INVALID'); }
  if (url.origin !== 'https://blog.kakaocdn.net' || !url.pathname.startsWith('/dna/')
    || url.username || url.password || url.hash || !url.search
    || typeof attachment.key !== 'string' || typeof attachment.filename !== 'string'
    || url.pathname !== '/dna/' + attachment.key + '/' + attachment.filename
    || /[|<>"'\s]/.test(attachment.key + attachment.filename + url.search)
    || [...url.searchParams.keys()].some(key => !['credential', 'expires', 'allow_ip', 'allow_referer', 'signature'].includes(key))
    || !url.searchParams.get('credential') || !url.searchParams.get('signature')) throw authError('TISTORY_IMAGE_REFERENCE_INVALID');
  if (typeof attachment.name !== 'string' || !attachment.name || attachment.name.length > 255) throw authError('TISTORY_IMAGE_METADATA_INVALID');
  return 'kage@' + attachment.key + '/' + attachment.filename + url.search.replace(/&/g, '&amp;');
}

const sha256Pattern = /^[a-f0-9]{64}$/;

// The player locates the native File shortcode's rendered download link at
// runtime. It never embeds or persists a signed CDN URL in the script.
export const videoScript = `<script>(function(){function start(){document.querySelectorAll('figure[data-tistory-video-file]').forEach(function(figure){var file=document.getElementById(figure.getAttribute('data-tistory-video-file'));var link=file&&file.querySelector('a[href]');var video=figure.querySelector('video');if(!link||!video)return;try{var url=new URL(link.href);if(url.protocol!=='https:'||url.hostname!=='blog.kakaocdn.net')return;video.src=url.href;video.load();}catch(error){}});}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();</script>`;

export function nativeImageMarkup(attachment, { width, height, caption = '' } = {}) {
  const reference = attachmentReference(attachment);
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)
    || typeof caption !== 'string' || caption.length > 10000) throw authError('TISTORY_IMAGE_METADATA_INVALID');
  const metadata = { originWidth: width, originHeight: height, style: 'alignCenter',
    ...(caption ? { caption: escapeText(caption) } : {}), filename: escapeText(attachment.name) };
  return '<p>[##_Image|' + reference + '|CDM|1.3|' + JSON.stringify(metadata) + '_##]</p>';
}

// Observed File shortcode for an MP4 uploaded through the normal File menu.
// This creates a downloadable file card. It does not create a video player.
export function nativeVideoAttachmentMarkup(attachment) {
  const reference = attachmentReference(attachment);
  if (!attachment.filename.endsWith('.mp4') || !Number.isSafeInteger(attachment.size)
    || attachment.size < 1 || attachment.size > 10 * 1024 * 1024) throw authError('TISTORY_VIDEO_ATTACHMENT_INVALID');
  const size = (attachment.size / (1024 * 1024)).toFixed(2) + 'MB';
  return '<p>[##_File|' + reference + '|filename="' + escapeText(attachment.name)
    + '" size="' + size + '" data-ke-align="alignCenter"|_##]</p>';
}

// Inline playback is built on top of the observed File shortcode. Require the
// uploader's successful independent hash readback before creating a player.
export function renderVideo({ attachment, caption = '', uploadReceipt } = {}) {
  const sourceHash = uploadReceipt?.sourceSha256;
  if (uploadReceipt?.schema !== 'tistory-downloadable-video-attachment-receipt-v1'
    || uploadReceipt.status !== 'verified'
    || typeof sourceHash !== 'string' || !sha256Pattern.test(sourceHash)
    || uploadReceipt.remoteSha256 !== sourceHash
    || !Number.isSafeInteger(uploadReceipt.sourceBytes) || uploadReceipt.sourceBytes < 1
    || uploadReceipt.remoteBytes !== uploadReceipt.sourceBytes
    || typeof caption !== 'string' || caption.length > 10000) {
    throw authError('TISTORY_VIDEO_VERIFICATION_REQUIRED');
  }
  const fileId = 'tistory-video-file-' + sourceHash.slice(0, 16);
  const player = '<figure data-tistory-video-file="' + fileId
    + '" style="margin:24px 0"><video controls="controls" preload="metadata" playsinline="playsinline" style="display:block;width:100%;max-height:720px;background:#111"></video>'
    + (caption ? '<figcaption>' + escapeText(caption) + '</figcaption>' : '')
    + '</figure>\n<details><summary>영상 파일 다운로드</summary><div id="' + fileId + '">'
    + nativeVideoAttachmentMarkup(attachment) + '</div></details>';
  return player;
}
