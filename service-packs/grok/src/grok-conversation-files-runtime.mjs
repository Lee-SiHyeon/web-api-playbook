import { GrokWebClient, loadContractRegistry } from './client.mjs';
import { createAuthenticatedChromeFetch } from './authenticated-chrome-fetch.mjs';
import { createGrokFileArtifactFetch } from './grok-file-artifact-fetch.mjs';
import { OperationJournal } from './journal.mjs';
import { NonSecretJsonFileStore } from './nonsecret-json-store.mjs';
import { ProtectedJsonStore } from './protected-json-store.mjs';
import { createGrokConversationFilesClient } from './grok-conversation-files.mjs';
import { fail } from './errors.mjs';

export async function createInMemoryGrokConversationFilesRuntime({
  registry,
  pythonExecutable = process.env.GROK_CHROME_PYTHON ?? 'python3',
  timeoutMs,
  journalFilePath,
} = {}) {
  const resolvedRegistry = registry ?? await loadContractRegistry();
  if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim()) throw fail('FILE_RUNTIME_PYTHON_REQUIRED');
  const apiFetch = createAuthenticatedChromeFetch({ registry: resolvedRegistry, pythonExecutable, timeoutMs });
  const artifactFetch = createGrokFileArtifactFetch({ registry: resolvedRegistry, pythonExecutable, timeoutMs });
  const fetchImpl = (input, init = {}) => init.credentials === 'omit'
    ? artifactFetch.fetch(input, init)
    : apiFetch(input, init);
  const sessionPersistence = new ProtectedJsonStore({ provider: 'memory' });
  const journal = new OperationJournal({ store: new NonSecretJsonFileStore({ filePath: journalFilePath }) });
  const client = new GrokWebClient({ registry: resolvedRegistry, sessionPersistence, journal, fetchImpl, timeoutMs });
  return Object.freeze({
    client,
    sessionPersistence,
    journal,
    files: createGrokConversationFilesClient({ client,
      fetchSourceResolvedArtifact: artifactFetch.fetchSourceResolvedArtifact }),
  });
}
