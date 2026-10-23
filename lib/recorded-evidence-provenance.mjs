import path from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    !path.isAbsolute(value) && !/^[a-z]:\//i.test(value) && !value.includes('\\') && !value.includes('\0') &&
    !value.startsWith('-') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/**
 * Verify the runtime implementation recorded with historical evidence while
 * reporting explicitly allowlisted verifier/validator drift as provenance.
 * This function performs no filesystem or network access by itself.
 */
export async function verifyManifestImplementation({
  implementation,
  readFile,
  sha256,
  verificationToolKinds = {},
} = {}) {
  if (!object(implementation) || Object.keys(implementation).length === 0 ||
      typeof readFile !== 'function' || typeof sha256 !== 'function' || !object(verificationToolKinds)) {
    throw Object.assign(new Error('RECORDED_IMPLEMENTATION_INPUT_INVALID'), { code: 'RECORDED_IMPLEMENTATION_INPUT_INVALID' });
  }

  for (const [file, kind] of Object.entries(verificationToolKinds)) {
    if (!safeRelativePath(file) || typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(kind)) {
      throw Object.assign(new Error('RECORDED_VERIFICATION_TOOL_INVALID'), { code: 'RECORDED_VERIFICATION_TOOL_INVALID' });
    }
    if (!Object.hasOwn(implementation, file)) {
      throw Object.assign(new Error(`Recorded verification-tool hash missing: ${file}`), { code: 'RECORDED_VERIFICATION_TOOL_HASH_MISSING' });
    }
  }

  const verificationToolProvenance = [];
  for (const [file, recordedSha256] of Object.entries(implementation)) {
    if (!safeRelativePath(file) || !SHA256.test(recordedSha256 ?? '')) {
      throw Object.assign(new Error(`Recorded implementation hash invalid: ${file}`), { code: 'RECORDED_IMPLEMENTATION_HASH_INVALID' });
    }
    const bytes = await readFile(file);
    if (bytes === null || bytes === undefined) {
      throw Object.assign(new Error(`Recorded implementation file missing: ${file}`), { code: 'RECORDED_IMPLEMENTATION_FILE_MISSING' });
    }
    const currentSha256 = sha256(bytes);
    if (!SHA256.test(currentSha256 ?? '')) {
      throw Object.assign(new Error(`Current implementation hash invalid: ${file}`), { code: 'CURRENT_IMPLEMENTATION_HASH_INVALID' });
    }

    const isVerificationTool = Object.hasOwn(verificationToolKinds, file);
    const kind = isVerificationTool ? verificationToolKinds[file] : null;
    if (isVerificationTool) {
      verificationToolProvenance.push({
        path: file,
        kind,
        recordedSha256,
        currentSha256,
        status: currentSha256 === recordedSha256 ? 'recorded_hash_matches' : 'historical_tool_changed',
      });
    } else if (currentSha256 !== recordedSha256) {
      throw Object.assign(new Error(`Changed implementation: ${file}`), {
        code: 'RECORDED_RUNTIME_IMPLEMENTATION_CHANGED',
        path: file,
      });
    }
  }

  return {
    runtimeImplementationHashesMatched: true,
    verificationToolProvenance,
  };
}
