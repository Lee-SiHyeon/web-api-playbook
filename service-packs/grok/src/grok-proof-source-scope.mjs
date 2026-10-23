import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';

const SCHEMA = 'grok-operation-source-scope-v1';
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9._-]{0,95}$/;
const FILE = /^(?:src|scripts)\/[A-Za-z0-9._/-]+\.(?:mjs|js|py)$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };

function visit(node, callback, parents = []) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  callback(node, parents);
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc', 'range'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => visit(child, callback, [...parents, node]));
    else if (value && typeof value.type === 'string') visit(value, callback, [...parents, node]);
  }
}

function nodeName(node) {
  if (node?.type === 'PrivateIdentifier') return `#${node.name}`;
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/** Parse exactly named declarations or class methods; regex cannot bound JS bodies reliably. */
export function extractGrokSourceUnit(source, selector) {
  if (typeof source !== 'string' || typeof selector !== 'string' || selector.length > 160) {
    fail('SOURCE_SCOPE_UNIT_INVALID');
  }
  if (selector === '__module__') return source;
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { fail('SOURCE_SCOPE_JS_PARSE_FAILED'); }
  const matches = [];
  visit(ast, (node, parents) => {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id?.name === selector) matches.push(node);
    } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
        && node.id.name === selector) matches.push(node);
    else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      const owner = [...parents].reverse().find(parent => parent.type === 'ClassDeclaration');
      if (owner?.id?.name && `${owner.id.name}.${nodeName(node.key)}` === selector) matches.push(node);
    } else if (node.type === 'Property' && !node.computed && node.value?.type === 'FunctionExpression') {
      const owner = [...parents].reverse().find(parent => parent.type === 'FunctionDeclaration');
      if (owner?.id?.name && `${owner.id.name}.${nodeName(node.key)}` === selector) matches.push(node);
    }
  });
  if (matches.length !== 1) fail(matches.length ? 'SOURCE_SCOPE_UNIT_AMBIGUOUS' : 'SOURCE_SCOPE_UNIT_MISSING');
  return source.slice(matches[0].start, matches[0].end);
}

async function containedFile(root, relative) {
  if (!FILE.test(relative ?? '') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('SOURCE_SCOPE_FILE_INVALID');
  }
  const resolved = await realpath(path.join(root, relative)).catch(() => fail('SOURCE_SCOPE_FILE_MISSING'));
  if (!resolved.startsWith(root + path.sep)) fail('SOURCE_SCOPE_FILE_OUTSIDE_REPO');
  return resolved;
}

export function grokContractScopeProjection(registry, operationIds) {
  if (!Array.isArray(operationIds) || !operationIds.length || operationIds.some(id => !ID.test(id))) {
    fail('SOURCE_SCOPE_OPERATIONS_INVALID');
  }
  const ids = [...new Set([registry?.identityOperationId, ...operationIds])].sort();
  if (ids.some(id => !ID.test(id ?? ''))) fail('SOURCE_SCOPE_AUTH_OPERATION_MISSING');
  const operations = ids.map(id => {
    const operation = registry?.operations?.find(item => item.id === id);
    if (!operation) fail('SOURCE_SCOPE_OPERATION_MISSING');
    return operation;
  });
  return { schemaVersion: registry.schemaVersion, serviceId: registry.serviceId,
    serviceOrigin: registry.serviceOrigin, allowedOrigins: registry.allowedOrigins,
    identityOperationId: registry.identityOperationId, operations };
}

/** Descriptors are checked-in handler closures, not supplied by a live caller to shrink verification. */
export async function snapshotGrokProofSourceScope({ root, registry, operationIds, units } = {}) {
  if (!Array.isArray(units) || !units.length) fail('SOURCE_SCOPE_UNITS_MISSING');
  const repo = await realpath(root);
  const contractProjection = grokContractScopeProjection(registry, operationIds);
  const implementationUnits = [];
  const seen = new Set();
  for (const descriptor of units) {
    if (!descriptor || typeof descriptor.file !== 'string' || !Array.isArray(descriptor.selectors)
        || !descriptor.selectors.length) fail('SOURCE_SCOPE_DESCRIPTOR_INVALID');
    const file = await containedFile(repo, descriptor.file);
    const source = await readFile(file, 'utf8');
    for (const selector of descriptor.selectors) {
      const key = `${descriptor.file}#${selector}`;
      if (seen.has(key)) fail('SOURCE_SCOPE_UNIT_DUPLICATE');
      if (descriptor.file.endsWith('.py') && selector !== '__module__') fail('SOURCE_SCOPE_PYTHON_MODULE_REQUIRED');
      seen.add(key);
      implementationUnits.push({ path: key, sha256: hash(extractGrokSourceUnit(source, selector)) });
    }
  }
  implementationUnits.sort((a, b) => a.path.localeCompare(b.path));
  return { schema: SCHEMA, operationIds: [...new Set(operationIds)].sort(),
    authOperationId: registry.identityOperationId,
    contractScopeSha256: hash(canonical(contractProjection)),
    implementationUnits, implementationScopeSha256: hash(canonical(implementationUnits)) };
}

export function grokProofSourceScopeMatches(recorded, current) {
  return recorded?.schema === SCHEMA && current?.schema === SCHEMA
    && SHA.test(recorded.contractScopeSha256 ?? '')
    && SHA.test(recorded.implementationScopeSha256 ?? '')
    && canonical(recorded) === canonical(current);
}
