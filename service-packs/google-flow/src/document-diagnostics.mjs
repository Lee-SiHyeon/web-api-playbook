import { FlowProtocolError } from './protocol.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const PROJECT_PATH = /^\/project\/([A-Fa-f0-9-]{16,64})\/?$/;
const REQUIRED_MARKERS = Object.freeze(['SNlM0e', 'FdrFJe', 'cfb2h']);
const OPTIONAL_MARKERS = Object.freeze(['xZbWve']);
const ALL_MARKERS = Object.freeze([...REQUIRED_MARKERS, ...OPTIONAL_MARKERS]);
const DOCUMENT_ERROR_CODES = new Set([
  'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING',
  'FLOW_DOCUMENT_FIELD_INVALID',
  'FLOW_DOCUMENT_FIELD_MISSING',
  'FLOW_DOCUMENT_REDIRECT',
  'FLOW_DOCUMENT_HTTP_ERROR',
  'FLOW_DOCUMENT_AUTH_COOKIE_DELETED',
  'FLOW_DOCUMENT_MIME_UNEXPECTED',
]);
const SAFE_PATH_KINDS = new Set(['project', 'flow_home', 'other_flow_path', 'other_origin', 'unknown']);
const SAFE_MIMES = new Set(['text/html', 'application/json', 'text/plain', 'application/octet-stream', 'other']);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function safeBooleanList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.inspected !== 'boolean') return null;
  const expectedKeys = value.inspected ? ['inspected', ...ALL_MARKERS] : ['inspected'];
  if (!exactKeys(value, expectedKeys)) return null;
  if (value.inspected && !ALL_MARKERS.every(name => typeof value[name] === 'boolean')) return null;
  return value.inspected
    ? ALL_MARKERS.map(name => `${name}:${value[name]}`).join(',')
    : 'not_inspected';
}

function markerPattern(name) {
  return new RegExp(`"${name}"\\s*:`);
}

function stringValue(html, name) {
  const pattern = new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = pattern.exec(html);
  if (!match) return { markerPresent: markerPattern(name).test(html), value: null };
  try {
    const value = JSON.parse(match[1]);
    return { markerPresent: true, value: typeof value === 'string' && value ? value : null };
  } catch {
    return { markerPresent: true, value: null };
  }
}

function pathKind(value) {
  if (typeof value !== 'string' || !value) return { kind: 'unknown', projectId: null };
  try {
    const url = new URL(value, FLOW_ORIGIN);
    if (url.origin !== FLOW_ORIGIN) return { kind: 'other_origin', projectId: null };
    const project = PROJECT_PATH.exec(url.pathname);
    if (project) return { kind: 'project', projectId: project[1].toLowerCase() };
    if (url.pathname === '/' || url.pathname === '/home' || url.pathname === '/home/') {
      return { kind: 'flow_home', projectId: null };
    }
    return { kind: 'other_flow_path', projectId: null };
  } catch {
    return { kind: 'unknown', projectId: null };
  }
}

function safePathHints(sourcePath, responseUrl) {
  const request = pathKind(sourcePath);
  const response = pathKind(responseUrl);
  const projectIdsComparable = request.projectId !== null && response.projectId !== null;
  return {
    requestPathKind: request.kind,
    responsePathKind: response.kind,
    responsePathMatchesRequestedProject: projectIdsComparable
      ? request.projectId === response.projectId : null,
  };
}

function normalizedMime(mime) {
  if (typeof mime !== 'string') return null;
  const value = mime.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) ? value : 'other';
}

function inspectFlowDocument(html) {
  const fields = Object.fromEntries([...REQUIRED_MARKERS, ...OPTIONAL_MARKERS]
    .map(name => [name, stringValue(html, name)]));
  const markerPresence = Object.fromEntries(Object.entries(fields)
    .map(([name, field]) => [name, field.markerPresent]));
  const validStringPresence = Object.fromEntries(Object.entries(fields)
    .map(([name, field]) => [name, field.value !== null]));
  return {
    values: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value])),
    markerPresence,
    validStringPresence,
  };
}

export function createFlowDocumentDiagnostics({
  httpStatus = null,
  mime = null,
  sourcePath,
  responseUrl,
  html,
} = {}) {
  const inspected = html === undefined ? null : inspectFlowDocument(html);
  return Object.freeze({
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    mime: normalizedMime(mime),
    sourcePathHints: Object.freeze(safePathHints(sourcePath, responseUrl)),
    markerPresence: Object.freeze(inspected === null
      ? { inspected: false }
      : { inspected: true, ...inspected.markerPresence }),
    validStringPresence: Object.freeze(inspected === null
      ? { inspected: false }
      : { inspected: true, ...inspected.validStringPresence }),
  });
}

export function createFlowDocumentError(message, {
  code,
  diagnostics,
  httpStatus,
  sessionStatus = 'undetermined',
} = {}) {
  const error = new FlowProtocolError(message, {
    code,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : diagnostics?.httpStatus ?? null,
  });
  error.sessionStatus = sessionStatus;
  error.documentDiagnostics = diagnostics;
  return error;
}

export function parseFlowDocument(html, { sourcePath, responseUrl, httpStatus, mime } = {}) {
  const parsed = inspectFlowDocument(html);
  const diagnostics = createFlowDocumentDiagnostics({ httpStatus, mime, sourcePath, responseUrl, html });
  const requiredField = REQUIRED_MARKERS.find(name => parsed.values[name] === null);
  if (requiredField) {
    const present = parsed.markerPresence[requiredField];
    if (requiredField === 'SNlM0e') {
      throw createFlowDocumentError(
        'Flow HTML omitted required request token SNlM0e; session validity is undetermined and no RPC was sent.',
        { code: 'FLOW_DOCUMENT_REQUEST_TOKEN_MISSING', diagnostics, sessionStatus: 'undetermined' },
      );
    }
    throw createFlowDocumentError(
      `Flow document ${present ? 'has an invalid' : 'is missing'} ${requiredField} field.`,
      {
        code: present ? 'FLOW_DOCUMENT_FIELD_INVALID' : 'FLOW_DOCUMENT_FIELD_MISSING',
        diagnostics,
        sessionStatus: 'undetermined',
      },
    );
  }
  return {
    sourcePath,
    at: parsed.values.SNlM0e,
    sid: parsed.values.FdrFJe,
    bl: parsed.values.cfb2h,
    siteKey: parsed.values.xZbWve,
  };
}

/** Returns only fixed enums, bounded status values, and allowlisted boolean markers. */
export function formatSafeFlowDocumentDiagnostics(error) {
  if (!DOCUMENT_ERROR_CODES.has(error?.code)) return null;
  const diagnostics = error?.documentDiagnostics;
  const diagnosticKeys = ['httpStatus', 'mime', 'sourcePathHints', 'markerPresence', 'validStringPresence'];
  if (!exactKeys(diagnostics, diagnosticKeys) || error.sessionStatus !== 'undetermined') return null;

  const status = diagnostics.httpStatus === null ? 'unknown'
    : Number.isInteger(diagnostics.httpStatus) && diagnostics.httpStatus >= 100 && diagnostics.httpStatus <= 599
      ? String(diagnostics.httpStatus) : null;
  const mime = diagnostics.mime === null ? 'unknown'
    : SAFE_MIMES.has(diagnostics.mime) ? diagnostics.mime : null;
  const paths = diagnostics.sourcePathHints;
  const pathKeys = ['requestPathKind', 'responsePathKind', 'responsePathMatchesRequestedProject'];
  if (status === null || mime === null || !exactKeys(paths, pathKeys)
    || !SAFE_PATH_KINDS.has(paths.requestPathKind) || !SAFE_PATH_KINDS.has(paths.responsePathKind)
    || !(paths.responsePathMatchesRequestedProject === null
      || typeof paths.responsePathMatchesRequestedProject === 'boolean')) return null;

  const markerPresence = safeBooleanList(diagnostics.markerPresence);
  const validStringPresence = safeBooleanList(diagnostics.validStringPresence);
  if (markerPresence === null || validStringPresence === null
    || diagnostics.markerPresence.inspected !== diagnostics.validStringPresence.inspected) return null;

  const pathMatch = paths.responsePathMatchesRequestedProject === null
    ? 'unknown' : String(paths.responsePathMatchesRequestedProject);
  return [
    `documentHttpStatus=${status}`,
    'sessionStatus=undetermined',
    `documentMime=${mime}`,
    `requestPathKind=${paths.requestPathKind}`,
    `responsePathKind=${paths.responsePathKind}`,
    `responsePathMatchesRequestedProject=${pathMatch}`,
    `documentMarkerPresence=${markerPresence}`,
    `documentValidStringPresence=${validStringPresence}`,
  ].join(' ');
}
