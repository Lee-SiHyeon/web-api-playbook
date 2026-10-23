import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** A checked-in catalog, never a caller-supplied module or shell command. */
export async function clientPacks() {
  const catalog = JSON.parse(await readFile(new URL('../service-packs/clients.json', import.meta.url), 'utf8'));
  if (catalog.schema !== 'playbook-client-packs-v1' || !Array.isArray(catalog.clients)) fail('CLIENT_CATALOG_INVALID');
  return structuredClone(catalog.clients);
}

export async function resolveClientPack(id) {
  const client = (await clientPacks()).find(value => value.id === id || value.aliases?.includes(id));
  if (!client) fail('CLIENT_PACK_UNKNOWN');
  const directory = await realpath(path.join(root, client.directory));
  if (!directory.startsWith(await realpath(path.join(root, 'service-packs')) + path.sep)) fail('CLIENT_PACK_SCOPE');
  return { ...client, directory };
}

/** Inherit stdin/stdout unchanged so native session envelopes and guards survive. */
export async function runClientPack(id, args = [], {
  cwd = process.cwd(), signal, stdio = 'inherit', spawnImpl = spawn,
} = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) fail('CLIENT_ARGUMENT_INVALID');
  const client = await resolveClientPack(id);
  if (!client.entrypoint) fail('CLIENT_LIBRARY_ONLY');
  const entrypoint = await realpath(path.join(client.directory, client.entrypoint));
  if (!entrypoint.startsWith(client.directory + path.sep)) fail('CLIENT_PACK_SCOPE');
  if (signal?.aborted) fail('CLIENT_ABORTED');
  const nodeArgs = (client.nodeArgs ?? []).map(arg => arg === '--import=tsx'
    ? '--import=' + pathToFileURL(createRequire(path.join(client.directory, 'package.json')).resolve('tsx')).href
    : arg);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [...nodeArgs, entrypoint, ...args], {
      cwd, stdio, shell: false, ...(signal ? { signal } : {}),
    });
    child.once('error', () => reject(Object.assign(new Error('CLIENT_PROCESS_FAILED'), { code: 'CLIENT_PROCESS_FAILED' })));
    child.once('close', (code, childSignal) => {
      resolve({ exitCode: code ?? (childSignal === 'SIGINT' ? 130 : 1), signal: childSignal });
    });
  });
}
