import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// External peer implementations stay outside this workspace. Load them only for
// explicit integration checks; unit tests must not silently use a fake runtime.
export async function loadOptionalPeerModule(environmentVariable, relativeFile) {
  const root = process.env[environmentVariable];
  if (!root) return {
    module: null,
    skip: `Optional peer unavailable: set ${environmentVariable}; see apps/social-actions/tests/PEERS.md`,
  };
  const filename = path.resolve(root, relativeFile);
  try {
    await access(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      module: null,
      skip: `Optional peer unavailable: ${environmentVariable} entrypoint missing at ${filename}`,
    };
    throw error;
  }
  return { module: await import(pathToFileURL(filename).href), skip: undefined };
}
