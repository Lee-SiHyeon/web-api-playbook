export class GeminiClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GeminiClientError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function fail(code, message, details) {
  throw new GeminiClientError(code, message, details);
}
