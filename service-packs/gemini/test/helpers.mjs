import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';
import { validateObservedContract } from '../src/contract.mjs';

export function operation({
  effect = 'read',
  method = 'GET',
  path = '/captured/operation',
  queryKeys = [],
  headerNames = ['accept'],
  contentType,
  framing = 'json',
  responseContentType = 'application/json',
  rpcId,
  retryPolicy,
} = {}) {
  const mutation = effect === 'mutation';
  return {
    observation: { requestResponse: true },
    effect,
    ...(mutation ? { retryPolicy: retryPolicy || 'never' } : {}),
    request: {
      method,
      origin: SERVICE_ORIGIN,
      path,
      queryKeys,
      headerNames,
      ...(contentType ? { contentType } : {}),
    },
    response: {
      contentType: responseContentType,
      framing,
      ...(framing === 'batchexecute' ? { frameLengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2 } : {}),
      ...(rpcId ? { rpcId } : {}),
    },
  };
}

export function rawContract({
  auth = { origins: [SERVICE_ORIGIN], cookieNames: [], headerNames: [] },
  assetOrigins = [],
  operations = { history: operation() },
} = {}) {
  return {
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-03T00:00:00.000Z',
    auth,
    assetOrigins,
    operations,
  };
}

export function contract(options = {}) {
  return validateObservedContract(rawContract(options));
}

export function session({
  cookieNames = [],
  headerNames = [],
  cookieValue = 'test-cookie-value',
  headerValue = 'test-header-value',
} = {}) {
  return {
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    capturedAt: '2026-10-03T00:00:00.000Z',
    cookies: cookieNames.map((name) => ({ name, value: cookieValue })),
    headers: Object.fromEntries(headerNames.map((name) => [name, headerValue])),
  };
}
