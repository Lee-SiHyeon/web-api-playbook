import { readFile, readdir } from 'node:fs/promises';
import { createOperationRegistry, validateOperationProfile } from '../operation-registry.mjs';
import { serviceName } from '../profile.mjs';

const MODULES = ['commerce', 'retail', 'native', 'travel', 'extras'];
const FRAMEWORK_SCOPES = new Set(['catalog', 'commerce', 'operation-runtime', 'service-operations', 'creator-access-gaps']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const problem = code => { throw Object.assign(new Error(code), { code }); };
let defaults;

export function validateServiceDefinitions(definitions) {
  if (!Array.isArray(definitions)) problem('SERVICE_CATALOG_INVALID');
  const names = new Set();
  for (const definition of definitions) {
    if (!object(definition) || !serviceName(definition.id) || definition.profile?.serviceId !== definition.id ||
        typeof definition.title !== 'string' || typeof definition.createAdapters !== 'function') problem('SERVICE_DEFINITION_INVALID');
    validateOperationProfile(definition.profile);
    if (Object.values(definition.profile.operations).some(operation => operation.semantics !== 'read' || !operation.adapter)) problem('SERVICE_READ_ADAPTER_REQUIRED');
    if (!Array.isArray(definition.verificationChecks ?? [])) problem('SERVICE_CHECKS_INVALID');
    for (const check of definition.verificationChecks ?? []) {
      if (!object(check) || !Object.hasOwn(definition.profile.operations, check.operation) ||
          check.input !== undefined && !object(check.input) || check.kind !== undefined && !['live_read', 'local'].includes(check.kind)) problem('SERVICE_CHECKS_INVALID');
    }
    for (const name of [definition.id, ...(definition.aliases ?? [])]) {
      if (!serviceName(name) || names.has(name)) problem('SERVICE_NAME_COLLISION');
      names.add(name);
    }
  }
  return definitions;
}

export async function loadServiceDefinitions() {
  defaults ??= Promise.all(MODULES.map(async name => (await import(`./${name}.mjs`)).definitions))
    .then(groups => validateServiceDefinitions(groups.flat()).sort((a, b) => a.id.localeCompare(b.id)))
    .catch(error => { defaults = undefined; throw error; });
  return defaults;
}

export async function resolveServiceDefinition(id, { definitions } = {}) {
  if (!serviceName(id)) problem('SERVICE_ID_INVALID');
  const entries = definitions === undefined ? await loadServiceDefinitions() : validateServiceDefinitions(definitions);
  const definition = entries.find(entry => entry.id === id || entry.aliases?.includes(id));
  if (!definition) problem('SERVICE_NOT_CONNECTED');
  return definition;
}

/** Metadata-only callers can opt out of binding: no provider/client is opened. */
export async function createServiceRegistry(id, { definitions, bind = true, ...options } = {}) {
  const definition = await resolveServiceDefinition(id, { definitions });
  const binding = bind ? await definition.createAdapters(options) : {};
  if (!object(binding) || bind && !object(binding.adapters)) problem('SERVICE_ADAPTER_BINDING_INVALID');
  if (bind && Object.values(definition.profile.operations).some(op => typeof binding.adapters[op.adapter] !== 'function')) problem('SERVICE_ADAPTER_BINDING_INCOMPLETE');
  const registry = createOperationRegistry(definition.profile, binding);
  let closed = false;
  const execute = (...args) => { if (closed) problem('SERVICE_REGISTRY_CLOSED'); return registry.execute(...args); };
  const callTool = (...args) => { if (closed) problem('SERVICE_REGISTRY_CLOSED'); return registry.callTool(...args); };
  const close = async () => { if (closed) return; closed = true; await binding.close?.(); };
  return { ...registry, execute, callTool, close, title: definition.title,
    verificationChecks: structuredClone(definition.verificationChecks ?? []),
    checklistIds: [...(definition.checklistIds ?? [definition.id])], aliases: [...(definition.aliases ?? [])] };
}

/** Whole inventory remains separate from executable/verified coverage. */
export async function listServiceOperations({ definitions, includeUnconnected = true,
  checklistDirectory = new URL('../../checklists/services/', import.meta.url) } = {}) {
  const entries = definitions === undefined ? await loadServiceDefinitions() : validateServiceDefinitions(definitions);
  const covered = new Set(entries.flatMap(definition => definition.checklistIds ?? [definition.id]));
  const services = entries.map(definition => ({ id: definition.id, title: definition.title,
    connection: 'connected', operations: Object.keys(definition.profile.operations),
    verificationOperations: (definition.verificationChecks ?? []).map(check => check.operation),
    checklistIds: [...(definition.checklistIds ?? [definition.id])], aliases: [...(definition.aliases ?? [])],
    requires: definition.requires ?? [], liveState: 'not_checked_by_listing' }));
  if (includeUnconnected) {
    for (const file of (await readdir(checklistDirectory)).filter(name => /^[a-z][a-z0-9._-]*\.json$/.test(name)).sort()) {
      const id = file.slice(0, -5);
      if (covered.has(id)) continue;
      const source = typeof checklistDirectory === 'string'
        ? (await import('node:path')).join(checklistDirectory, file) : new URL(file, checklistDirectory);
      const manifest = JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/, ''));
      const scopeOnly = FRAMEWORK_SCOPES.has(id);
      services.push({ id, title: manifest.description ?? id, connection: scopeOnly ? 'scope_only' : 'not_connected', operations: [],
        verificationOperations: [], checklistIds: [id], aliases: [], requires: [],
        liveState: scopeOnly ? 'not_a_service_endpoint' : 'not_verified', reason: scopeOnly ? 'AGGREGATE_CAPABILITY_SCOPE' : 'NO_COMMON_CLI_ADAPTER',
        existingImplementationRecorded: manifest.capabilities?.some(capability => capability.implementation?.files?.length > 0) ?? false });
    }
  }
  services.sort((a, b) => a.id.localeCompare(b.id));
  return { schema: 'playbook-service-catalog-v1', networkUsed: false, services,
    summary: { connectedServices: entries.length, operations: entries.reduce((n, entry) => n + Object.keys(entry.profile.operations).length, 0),
      unconnectedChecklistScopes: services.filter(service => service.connection === 'not_connected').length,
      aggregateChecklistScopes: services.filter(service => service.connection === 'scope_only').length,
      liveReadiness: 'not_established_by_inventory' } };
}
