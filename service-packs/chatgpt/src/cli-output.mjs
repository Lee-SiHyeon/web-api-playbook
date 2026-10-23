export function responseSummary(result) {
  return {
    ...(typeof result?.operationId === 'string' ? { operationId: result.operationId } : {}),
    ...(typeof result?.journalId === 'string' ? { journalId: result.journalId } : {}),
    ...(typeof result?.state === 'string' ? { state: result.state } : {}),
    ...(Number.isInteger(result?.httpStatus) ? { httpStatus: result.httpStatus } : {}),
    ...(typeof result?.mimeType === 'string' ? { mimeType: result.mimeType } : {}),
    ...(typeof result?.responseKind === 'string' ? { responseKind: result.responseKind } : {}),
    bodyOmitted: true,
  };
}

export async function streamSummary(result) {
  let eventCount = 0;
  let dataBytes = 0;
  for await (const event of result.events) {
    eventCount += 1;
    if (typeof event?.data === 'string') dataBytes += Buffer.byteLength(event.data, 'utf8');
  }
  return {
    ...(typeof result?.operationId === 'string' ? { operationId: result.operationId } : {}),
    ...(typeof result?.journalId === 'string' ? { journalId: result.journalId } : {}),
    ...(typeof result?.state === 'string' ? { state: result.state } : {}),
    ...(Number.isInteger(result?.httpStatus) ? { httpStatus: result.httpStatus } : {}),
    ...(typeof result?.mimeType === 'string' ? { mimeType: result.mimeType } : {}),
    responseKind: 'sse', eventCount, dataBytes, bodyOmitted: true,
  };
}

export function downloadSummary(result) {
  return {
    saved: true,
    ...(Number.isInteger(result?.bytes) ? { bytes: result.bytes } : {}),
    ...(typeof result?.mimeType === 'string' ? { mimeType: result.mimeType } : {}),
    ...(result?.signatureVerified === true ? { signatureVerified: true } : {}),
  };
}

export function safeCliFailure(error) {
  const candidate = typeof error?.code === 'string' ? error.code : error?.message;
  if (typeof candidate !== 'string' || !/^CREDENTIAL_[A-Z_]+$/.test(candidate)) return { error: 'INTERNAL_ERROR' };
  const result = { error: candidate };
  if (['status', 'read', 'write'].includes(error?.providerOperation)) result.providerOperation = error.providerOperation;
  if (['ETIMEDOUT', 'PROCESS_LAUNCH_OR_EXIT', 'HELPER_FAILURE'].includes(error?.providerCause)) result.providerCause = error.providerCause;
  for (const key of ['providerStage', 'providerErrorClass', 'providerErrorId']) {
    if (typeof error?.[key] === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(error[key])) result[key] = error[key];
  }
  return result;
}
