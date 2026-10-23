export const GROK_ATTACHMENT_MULTIPART_BOUNDARY = 'GrokWebAttachmentUploadV2Boundary';
export const MAX_NATIVE_DIRECT_UPLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_NATIVE_UPLOAD_FILE_BYTES = 150 * 1024 * 1024;
export const LEGACY_UNVERIFIED_DIRECT_UPLOAD_BYTES = 512 * 1024;

const MAX_FILE_NAME_BYTES = 128;
export const MAX_DIRECT_MULTIPART_OVERHEAD_BYTES = Buffer.byteLength(
  `--${GROK_ATTACHMENT_MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${'f'.repeat(MAX_FILE_NAME_BYTES)}"\r\nContent-Type: ${'a'.repeat(80)}/${'b'.repeat(80)}\r\n\r\n\r\n--${GROK_ATTACHMENT_MULTIPART_BOUNDARY}--\r\n`,
  'utf8',
);
export const MAX_DIRECT_MULTIPART_BODY_BYTES = MAX_NATIVE_DIRECT_UPLOAD_BYTES + MAX_DIRECT_MULTIPART_OVERHEAD_BYTES;
export const MAX_DIRECT_MULTIPART_BASE64_LENGTH = 4 * Math.ceil(MAX_DIRECT_MULTIPART_BODY_BYTES / 3);
