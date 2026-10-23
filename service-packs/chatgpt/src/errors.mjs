const SAFE_DETAIL_KEYS = new Set([
  'operationId', 'journalId', 'httpStatus', 'mimeType', 'byteLength',
  'contractState', 'origin', 'status', 'reason', 'responseKind',
]);

export class ChatGPTWebError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'ChatGPTWebError';
    this.code = code;
    this.details = Object.fromEntries(Object.entries(details)
      .filter(([key, value]) => SAFE_DETAIL_KEYS.has(key)
        && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')));
  }
}

export function fail(code, details) {
  throw new ChatGPTWebError(code, details);
}
