import { createHash } from 'node:crypto';
import { mkdir, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
const MAX_BYTES = 64 * 1024 * 1024;

export function safeAttachmentName(name) {
  let cleaned = String(name || 'attachment.pdf').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160);
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `attachment-${cleaned || 'file.pdf'}`;
  return cleaned;
}

async function boundedBody(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw fail('CAFE_DOWNLOAD_TOO_LARGE');
  }
  if (!response.body) throw fail('CAFE_DOWNLOAD_EMPTY');
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('CAFE_DOWNLOAD_TIMEOUT')), 45000); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw fail('CAFE_DOWNLOAD_TOO_LARGE');
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function downloadAttachment(client, { articleId = '21', index = 0, outDir = 'runtime/downloads', maxBytes = MAX_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw fail('CAFE_DOWNLOAD_LIMIT_INVALID');
  const opened = await client.openAttachment({ articleId, index });
  const { response, attachment } = opened;
  if (response.status !== 200) { await response.body?.cancel(); throw fail('CAFE_DOWNLOAD_HTTP_FAILED'); }
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['application/pdf', 'application/octet-stream', 'binary/octet-stream'].includes(mime)) {
    await response.body?.cancel(); throw fail('CAFE_DOWNLOAD_MIME_INVALID');
  }
  const filename = safeAttachmentName(attachment.filename);
  if (!filename.toLowerCase().endsWith('.pdf') || String(attachment.extension).replace(/^\./, '').toLowerCase() !== 'pdf') {
    await response.body?.cancel(); throw fail('CAFE_DOWNLOAD_FORMAT_NOT_OBSERVED');
  }
  const bytes = await boundedBody(response, maxBytes);
  if (bytes.length < 8 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
    || !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))) throw fail('CAFE_DOWNLOAD_PDF_INVALID');
  if (Number(attachment.size) > 0 && bytes.length !== Number(attachment.size)) throw fail('CAFE_DOWNLOAD_LENGTH_MISMATCH');
  const directory = path.resolve(outDir);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, filename);
  if (path.dirname(target) !== directory) throw fail('CAFE_DOWNLOAD_PATH_INVALID');
  const digest = createHash('sha256').update(bytes).digest('hex');
  // The final file is exclusively created. Never replace an unrelated file.
  let created = false;
  try {
    const finalHandle = await open(target, 'wx');
    created = true;
    try { await finalHandle.writeFile(bytes); await finalHandle.sync(); } finally { await finalHandle.close(); }
  } catch (error) {
    if (created) await unlink(target).catch(() => {});
    if (error.code === 'EEXIST') throw fail('CAFE_DOWNLOAD_TARGET_EXISTS');
    throw error;
  }
  const stored = await stat(target);
  if (stored.size !== bytes.length) throw fail('CAFE_DOWNLOAD_SAVE_FAILED');
  return {
    ok: true, articleId: String(articleId), attachmentIndex: index, filename, path: target,
    bytes: bytes.length, sha256: digest, mimeType: mime, formatSignature: '%PDF-',
    declaredSizeMatched: Number.isSafeInteger(attachment.size) && attachment.size > 0 ? bytes.length === attachment.size : null,
    browserUsed: false, credentialValuesReturned: false,
    sourceOrigin: opened.origin || 'https://downapi.cafe.naver.com',
  };
}
