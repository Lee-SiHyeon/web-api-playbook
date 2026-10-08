import { createHash } from 'node:crypto';

/** Observe only the bytes consumed by the caller; never attach an eager data listener. */
export function observeResponse(response, { onAudit } = {}) {
  if (!response?.body?.[Symbol.asyncIterator] || (onAudit !== undefined && typeof onAudit !== 'function')) {
    throw new TypeError('An async response body and optional audit callback are required.');
  }
  const originalBody = response.body;
  const hash = createHash('sha256');
  let bytes = 0;
  let started = false;
  let fullyRead = false;
  let audit = null;
  const body = {
    async *[Symbol.asyncIterator]() {
      if (started) throw new Error('RESPONSE_BODY_ALREADY_CONSUMED');
      started = true;
      try {
        for await (const chunk of originalBody) {
          const bytesChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += bytesChunk.length;
          hash.update(bytesChunk);
          yield chunk;
        }
        fullyRead = true;
      } finally {
        audit = Object.freeze({ bytes, sha256: hash.digest('hex'), fullyRead });
        try { await onAudit?.(audit); }
        catch { audit = Object.freeze({ ...audit, auditCallbackFailed: true }); }
      }
    },
    cancel: async (...args) => {
      if (typeof originalBody.cancel === 'function') await originalBody.cancel(...args);
      else originalBody.destroy?.();
    },
    destroy: (...args) => originalBody.destroy?.(...args),
  };
  return { ...response, body, get audit() { return audit; } };
}
