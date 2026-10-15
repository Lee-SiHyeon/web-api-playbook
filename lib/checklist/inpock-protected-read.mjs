const INPOCK_ORIGIN = 'https://link-rest.inpock.co.kr';
const SAFE_STATS_FIELDS = ['today', 'accumulated', 'realtime', 'subscribers'];
const SHA256 = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function containsCredentialMaterial(value) {
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (!object(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^(?:authorization|cookie|setcookie|password|passwd|accesstoken|refreshtoken|idtoken|token|secret|clientsecret|headers|requestheaders|responseheaders|requestbody|responsebody|rawrequest|rawresponse|email|phone)$/.test(normalized)) return true;
    if (containsCredentialMaterial(child)) return true;
  }
  return false;
}

function validReceipt(receipt, route) {
  return object(receipt) && receipt.method === 'GET' && receipt.origin === INPOCK_ORIGIN &&
    receipt.path === route && receipt.httpStatus === 200 && receipt.mime === 'application/json' &&
    Number.isSafeInteger(receipt.responseBytes) && receipt.responseBytes > 0 &&
    receipt.browserUsed === false && validTime(receipt.checkedAt);
}

function capabilityShape(capId) {
  switch (capId) {
    case 'auth.owner': return { operation: 'auth.owner', command: 'verify', route: '/v2/users' };
    case 'auth.reuse': return { operation: 'auth.reuse', command: 'verify', route: '/v2/users' };
    case 'cards.read': return { operation: 'cards.read', command: 'blocks', route: '/v2/blocks' };
    case 'stats.read': return { operation: 'stats.read', command: 'stats', route: '/stats/mini' };
    default: return null;
  }
}

/** Validate current protected Inpock reads without accepting login or write evidence. */
export function inpockProtectedRead([proof], entry, cap) {
  const capId = cap?.id;
  const shape = capabilityShape(capId);
  if (!shape || !object(proof) || !object(entry)) return false;
  if (entry.kind !== 'inpock-protected-read-v1' || entry.service !== 'inpock' || entry.files?.length !== 1 ||
      proof.schema !== 'inpock-protected-reads-v1' || proof.service !== 'inpock' ||
      !Array.isArray(proof.capabilities) || !proof.capabilities.includes(capId) ||
      !validTime(proof.checkedAt) || !object(proof.operations) || !object(proof.implementation)) return false;
  if (proof.secretsPersistedInEvidence !== false || containsCredentialMaterial(proof) ||
      proof.executionMode !== 'pure_http' || proof.browserUsed !== false || proof.noWriteRequestsSent !== true ||
      proof.credentialProvider !== 'Windows DPAPI CurrentUser' || proof.persistent !== true ||
      proof.providerReadiness?.status !== 'ready' || proof.providerReadiness?.loginAvailable !== true ||
      proof.providerReadiness?.sessionAvailable !== true) return false;
  const nonReplayNotes = proof.notReplayed;
  if (!object(nonReplayNotes) || !/no login post was sent/i.test(nonReplayNotes['auth.login'] ?? '') ||
      !/no create was sent/i.test(nonReplayNotes['cards.create'] ?? '') ||
      !/no publication replay was sent/i.test(nonReplayNotes['publishing.idempotency'] ?? '') ||
      !/no write-bound rendering replay was sent/i.test(nonReplayNotes['publishing.public_rendering'] ?? '')) return false;

  const runner = proof.runner;
  if (!object(runner) || runner.entrypoint !== 'scripts/inpock.mjs' || runner.exitStatus !== 0 ||
      runner.executionMode !== 'pure_http' || runner.browserUsed !== false ||
      runner.credentialProvider !== 'Windows DPAPI CurrentUser' || runner.persistent !== true ||
      runner.writeRequestsSent !== 0 || !Array.isArray(runner.commands) || !runner.commands.includes(shape.command)) return false;

  if (!Array.isArray(entry.hashPaths) || entry.hashPaths.length === 0 ||
      entry.hashPaths.some(file => typeof file !== 'string' || !SHA256.test(proof.implementation[file] ?? ''))) return false;

  const operation = proof.operations[shape.operation];
  if (!object(operation) || operation.ok !== true || operation.authenticated !== true ||
      operation.ownerVerified !== true || operation.browserUsed !== false) return false;

  if (capId === 'auth.owner') {
    return validReceipt(operation.receipt, '/v2/users');
  }

  if (capId === 'auth.reuse') {
    return operation.renewal === 'stored_session' && Array.isArray(operation.receipts) &&
      operation.receipts.length >= 2 && operation.receipts.every(receipt => validReceipt(receipt, '/v2/users'));
  }

  if (capId === 'cards.read') {
    const receipts = operation.receipts;
    if (!Array.isArray(receipts) || receipts.length === 0 || operation.complete !== true ||
        operation.stopReason !== 'server_end' || operation.pages !== receipts.length ||
        !Number.isSafeInteger(operation.recordCount) || operation.recordCount <= 0 ||
        !receipts.every((receipt, index) => validReceipt(receipt, '/v2/blocks') &&
          Number.isSafeInteger(receipt.recordCount) && receipt.recordCount > 0 &&
          receipt.hasNext === (index < receipts.length - 1))) return false;
    return receipts.reduce((total, receipt) => total + receipt.recordCount, 0) === operation.recordCount;
  }

  return validReceipt(operation.receipt, '/stats/mini') &&
    Array.isArray(operation.fieldNames) && operation.fieldNames.length === SAFE_STATS_FIELDS.length &&
    SAFE_STATS_FIELDS.every(field => operation.fieldNames.includes(field)) &&
    Array.isArray(operation.receipt.fieldsReturned) && operation.receipt.fieldsReturned.length === SAFE_STATS_FIELDS.length &&
    SAFE_STATS_FIELDS.every(field => operation.receipt.fieldsReturned.includes(field));
}
