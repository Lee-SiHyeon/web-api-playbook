export class GrokClientError extends Error {
  constructor(code, details = undefined, options = undefined) {
    super(code, options);
    this.name = 'GrokClientError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, details, options) {
  return new GrokClientError(code, details, options);
}

export function publicError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const details = error?.details && typeof error.details === 'object'
    ? Object.fromEntries(Object.entries(error.details).filter(([key, value]) => (
      /^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key)
      && !/(?:id|token|cookie|url|secret|session)/i.test(key)
      && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)
    )))
    : undefined;
  return { code, ...(details ? { details } : {}) };
}
