import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { auditCapabilityChecklist, safeRelativePath } from './capability-checklist.mjs';

const SKIP = new Set(['node_modules', '.git', '.venv', '.venv-oliveyoung', '__pycache__', '.runtime', 'runtime', 'work', 'runs', 'workflow-runs', 'private', 'secrets', 'credentials', 'raw-captures']);
const hash = value => createHash('sha256').update(value).digest('hex');
const tally = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const code = error => error?.code === 'ENOENT' ? 'AUDIT_FILE_MISSING' : error instanceof SyntaxError ? 'AUDIT_JSON_INVALID' :
  /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'AUDIT_READ_FAILED';

export async function readAuditFile(root, relative) {
  if (!safeRelativePath(relative)) throw new Error('AUDIT_PATH_INVALID');
  const base = await realpath(root);
  const target = await realpath(path.join(base, relative));
  if (!target.startsWith(base + path.sep)) throw new Error('AUDIT_PATH_ESCAPE');
  const info = await stat(target);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('AUDIT_FILE_INVALID');
  return readFile(target, 'utf8');
}

async function filesBelow(root, relative) {
  const out = [];
  const walk = async directory => {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(item.name) || item.isSymbolicLink()) continue;
      const file = path.posix.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) out.push(file);
    }
  };
  await walk(relative);
  return out;
}

export async function inventoryPlaybook(root) {
  const names = (await readdir(path.join(root, 'checklists/services'))).filter(name => name.endsWith('.json')).sort();
  const manifests = [], errors = [];
  for (const name of names) {
    try {
      if (!/^[a-z][a-z0-9._-]*\.json$/.test(name)) throw new Error('AUDIT_MANIFEST_NAME_INVALID');
      const value = JSON.parse(await readAuditFile(root, `checklists/services/${name}`));
      if (value.service !== name.slice(0, -5) || !Array.isArray(value.capabilities)) throw new Error('AUDIT_MANIFEST_INVALID');
      // Validate the inventory fields before traversing them. The existing checker
      // remains responsible for the full manifest and evidence semantics.
      for (const cap of value.capabilities) {
        if (!cap || typeof cap.id !== 'string' || !cap.implementation ||
          !['files', 'tests'].every(key => Array.isArray(cap.implementation[key])) ||
          (cap.implementation.cli !== undefined && !Array.isArray(cap.implementation.cli)) ||
          ![...cap.implementation.files, ...(cap.implementation.cli ?? [])].every(item => item && safeRelativePath(item.path)) ||
          !cap.implementation.tests.every(safeRelativePath) ||
          !['evidence', 'sourceEvidence'].every(key => cap[key] === undefined || (Array.isArray(cap[key]) && cap[key].every(item =>
            item && ['files', 'hashPaths'].every(field => item[field] === undefined || (Array.isArray(item[field]) && item[field].every(safeRelativePath))))))) {
          throw new Error('AUDIT_MANIFEST_INVALID');
        }
      }
      manifests.push(value);
    } catch (error) { errors.push({ file: `checklists/services/${name}`, code: code(error) }); }
  }
  const implementation = new Set(), cli = new Set(), tests = new Set(), referenced = new Set();
  for (const manifest of manifests) for (const cap of manifest.capabilities) {
    for (const item of cap.implementation?.files ?? []) implementation.add(item.path);
    for (const item of cap.implementation?.cli ?? []) cli.add(item.path);
    for (const file of cap.implementation?.tests ?? []) tests.add(file);
    for (const item of [...cap.evidence ?? [], ...cap.sourceEvidence ?? []]) {
      for (const file of [...item.files ?? [], ...item.hashPaths ?? []]) referenced.add(file);
    }
  }
  for (const file of [...implementation, ...cli, ...tests]) referenced.add(file);
  const missingReferences = [];
  for (const file of [...referenced].sort()) {
    try { await readAuditFile(root, file); }
    catch (error) { missingReferences.push({ path: safeRelativePath(file) ? file : null, code: code(error) }); }
  }
  const all = await filesBelow(root, '.');
  const entrypoints = [], runtimeEntrypoints = [], browserMentions = [], catalogs = [], packageCommands = [];
  const addRuntime = (declaredBy, target, kind) => {
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(declaredBy), target));
    if (!safeRelativePath(file)) { errors.push({ file: declaredBy, code: 'AUDIT_RUNTIME_TARGET_INVALID' }); return; }
    runtimeEntrypoints.push({ path: file, kind, declaredBy, sourcePresent: all.includes(file),
      implementationReferenced: implementation.has(file) || cli.has(file), conclusion: 'static_declaration_not_execution_proof' });
  };
  for (const file of ['package.json', ...all.filter(file => file.endsWith('/package.json'))]) {
    let pkg;
    try {
      pkg = JSON.parse(await readAuditFile(root, file));
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('AUDIT_PACKAGE_INVALID');
    }
    catch (error) { errors.push({ file, code: code(error) }); continue; }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      // Inventory only. Never execute a package script discovered from source.
      const match = /^node\s+([\w./-]+\.mjs)(?:\s|$)/.exec(command);
      if (!match) {
        packageCommands.push({ package: file, name, target: null, parsing: 'not_a_direct_node_mjs_command', declaredInManifest: null });
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (!safeRelativePath(target)) { errors.push({ file, code: 'AUDIT_PACKAGE_TARGET_INVALID' }); continue; }
      packageCommands.push({ package: file, name, target, declaredInManifest: cli.has(target) });
    }
  }
  for (const file of all) {
    if (file.endsWith('/manifest.json')) {
      try {
        const manifest = JSON.parse(await readAuditFile(root, file));
        if ([2, 3].includes(manifest.manifest_version)) {
          if (typeof manifest.background?.service_worker === 'string') addRuntime(file, manifest.background.service_worker, 'browser_extension_service_worker');
          for (const target of manifest.background?.scripts ?? []) if (typeof target === 'string') addRuntime(file, target, 'browser_extension_background_script');
          for (const group of manifest.content_scripts ?? []) for (const target of group.js ?? []) if (typeof target === 'string') addRuntime(file, target, 'browser_extension_content_script');
        }
      } catch (error) { errors.push({ file, code: code(error) }); }
    }
    if (file.endsWith('/api-catalog.json')) {
      try {
        const data = JSON.parse(await readAuditFile(root, file));
        const rows = Array.isArray(data) ? data : Array.isArray(data.contracts) ? data.contracts : [];
        catalogs.push({ path: file, entries: rows.length, kind: 'recorded_catalog_not_live_probe' });
      } catch (error) { errors.push({ file, code: code(error) }); }
    }
    if (!/\.(?:mjs|cjs|js|ts|tsx|py|ps1|sh|rs)$/.test(file) || /(?:^|\/)(?:tests?|fixtures|examples)\//.test(file)) continue;
    let raw;
    try { raw = await readAuditFile(root, file); }
    catch (error) { errors.push({ file, code: code(error) }); continue; }
    if (file.endsWith('.mjs') && (file.startsWith('scripts/') || /\bprocess\.argv\b/.test(raw))) {
      entrypoints.push({ path: file, declaredInManifest: cli.has(file), implementationReferenced: implementation.has(file) });
    }
    const kinds = [];
    if (/(?:from\s*|import\s*\()["'][^"']*(?:playwright|puppeteer|chromium|selenium)/.test(raw)) kinds.push('browser_import');
    if (/connectOverCDP|remote-debugging-port|webSocketDebuggerUrl|Network\.getResponseBody/.test(raw)) kinds.push('cdp_reference');
    if (/\b(?:chromium|firefox|webkit)\.launch\b/.test(raw)) kinds.push('browser_launch_reference');
    if (/\bchrome\.debugger\b/.test(raw)) kinds.push('chrome_extension_debugger_reference');
    if (/SetForegroundWindow|SendInput|Set-Clipboard|\.SendKeys\(/.test(raw)) kinds.push('native_ui_reference');
    if (file.endsWith('.ps1')) for (const match of raw.matchAll(/Join-Path\s+\$PSScriptRoot\s+['"]([\w.-]+\.js)['"]/g)) {
      addRuntime(file, match[1], 'powershell_relative_js_reference');
    }
    if (kinds.length) browserMentions.push({ path: file, kinds, conclusion: 'review_candidate_not_runtime_dependency_proof' });
  }
  // package.json can invoke a file without process.argv or a scripts/ directory.
  for (const item of packageCommands) if (item.target && !entrypoints.some(entry => entry.path === item.target)) {
    entrypoints.push({ path: item.target, declaredInManifest: cli.has(item.target), implementationReferenced: implementation.has(item.target) });
  }
  entrypoints.sort((a, b) => a.path.localeCompare(b.path));
  const packs = (await readdir(path.join(root, 'service-packs'), { withFileTypes: true })).filter(entry => entry.isDirectory() && !SKIP.has(entry.name)).map(entry => {
    const prefix = `service-packs/${entry.name}/`;
    return { name: entry.name, implementationFiles: [...implementation].filter(file => file.startsWith(prefix)).length,
      manifestCliReferences: [...cli].filter(file => file.startsWith(prefix)).length,
      entrypoints: entrypoints.filter(item => item.path.startsWith(prefix)).length,
      catalogEntries: catalogs.filter(item => item.path.startsWith(prefix)).reduce((sum, item) => sum + item.entries, 0) };
  });
  return { manifests, errors, inventory: { manifestFiles: names.length, servicePacks: packs, missingReferences, packageCommands,
    sourceAssets: all.filter(file => /\.(?:mjs|cjs|js|ts|tsx|py|ps1|sh|rs)$/.test(file)),
    entrypointDetection: 'node_mjs_package_targets_or_scripts_directory_or_process_argv; other_languages_indexed_as_source_assets',
    entrypoints, runtimeEntrypoints, browserMentions, catalogs, uniqueDeclaredTests: [...tests].sort(),
    multipleEvidenceGroups: manifests.flatMap(m => m.capabilities.filter(c => c.evidence?.length > 1).map(c => ({ service: m.service, capabilityId: c.id, groups: c.evidence.length, existingSemantics: 'any_valid_group' }))) } };
}

export function runAuditTest(root, file) {
  if (!safeRelativePath(file)) return { state: 'failed', reason: 'invalid_path' };
  const allowedEnv = ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'WINDIR', 'ComSpec', 'LANG', 'LC_ALL'];
  const result = spawnSync(process.execPath, ['--test', file], { cwd: root, windowsHide: true, encoding: 'utf8',
    timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: Object.fromEntries(allowedEnv.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  return { state: result.status === 0 && !result.error ? 'passed' : 'failed',
    reason: result.error?.code === 'ETIMEDOUT' ? 'timeout' : result.status === 0 ? null : 'test_process_failed' };
}

export async function auditPlaybook({ root, runTests = false, onProgress = () => {}, testRunner = runAuditTest } = {}) {
  const startedAt = new Date().toISOString();
  const { manifests, inventory, errors } = await inventoryPlaybook(root);
  const testFiles = {};
  if (runTests) for (const file of inventory.uniqueDeclaredTests) {
    onProgress({ stage: 'test', file });
    try { await readAuditFile(root, file); testFiles[file] = await testRunner(root, file); }
    catch (error) { testFiles[file] = { state: error?.code === 'ENOENT' ? 'missing' : 'failed', reason: code(error) }; }
  }
  const services = [];
  for (const manifest of manifests) {
    onProgress({ stage: 'service', service: manifest.service });
    try {
      const testResults = runTests ? Object.fromEntries(manifest.capabilities.map(cap => [cap.id,
        cap.implementation.tests.length === 0 ? 'not_run' : cap.implementation.tests.every(file => testFiles[file]?.state === 'passed') ? 'passed' : 'failed'])) : null;
      const audit = await auditCapabilityChecklist({ root, service: manifest.service, testResults });
      services.push(audit);
    } catch (error) { errors.push({ service: manifest.service, code: code(error) }); }
  }
  const capabilities = services.flatMap(service => service.capabilities);
  const sourceHashes = Object.fromEntries(await Promise.all(['lib/playbook-audit.mjs', 'lib/capability-checklist.mjs'].map(async file => {
    try { return [file, hash(await readAuditFile(root, file))]; } catch { return [file, null]; }
  })));
  return { schema: 'web-api-playbook-audit-v1', startedAt, checkedAt: new Date().toISOString(),
    scope: 'all_registered_capabilities_and_repository_source_inventory',
    auditNetworkUsed: runTests ? 'not_measured_in_tests' : false,
    liveReplaysScheduledByAudit: 0, liveReplaysExecutedByAudit: runTests ? 'not_measured_in_tests' : 0,
    testExecution: { requested: runTests, environment: 'reduced_environment_not_a_sandbox', networkIsolated: false },
    secretsPersistedInEvidence: false, implementation: sourceHashes, inventory, testFiles, services, errors,
    summary: { manifestCount: inventory.manifestFiles, auditedServices: services.length,
      allManifestAuditsCompleted: errors.length === 0 && services.length === inventory.manifestFiles,
      allReferencedFilesPresent: inventory.missingReferences.length === 0,
      capabilities: capabilities.length, byStatus: tally(capabilities.map(cap => cap.status)), byPriority: tally(capabilities.map(cap => cap.priority)),
      requiredGaps: services.reduce((n, service) => n + service.summary.requiredGaps.length, 0),
      unmappedEntrypoints: inventory.entrypoints.filter(item => !item.declaredInManifest).length,
      declaredRuntimeEntrypoints: inventory.runtimeEntrypoints.length,
      tests: tally(Object.values(testFiles).map(test => test.state)),
      allRequiredGatesPassed: errors.length === 0 && services.length > 0 && services.every(service => service.summary.strictPassed),
      currentRemoteReadiness: 'not_established_by_offline_audit' } };
}

export function renderPlaybookAudit(report) {
  const lines = ['# 플레이북 전수조사', '', `조사 시각: ${report.checkedAt}`, '',
    '등록 기능 전체와 저장소 실행기 재고를 조사했다. 저장 영수증 통과는 기록 시점의 실증이며 현재 세션이나 원격 동작의 재확인이 아니다.', '',
    `서비스 ${report.summary.auditedServices}/${report.summary.manifestCount}, 기능 ${report.summary.capabilities}, 필수 미충족 ${report.summary.requiredGaps}.`, '',
    '| 상태 | 기능 수 |', '|---|---:|', ...Object.entries(report.summary.byStatus).map(([name, count]) => `| ${name} | ${count} |`), '',
    '## 서비스별 범위', '', '| 서비스 | 기능 | 기록 실증 | 필수 미충족 |', '|---|---:|---:|---:|',
    ...report.services.map(s => `| ${s.service} | ${s.summary.total} | ${s.summary.recordedLive} | ${s.summary.requiredGaps.length} |`), '',
    '## 서비스 팩과 등록 범위', '', '| 팩 | 선언된 구현 파일 | 선언된 CLI | 발견 실행기 | 저장 catalog 항목 |', '|---|---:|---:|---:|---:|',
    ...report.inventory.servicePacks.map(p => `| ${p.name} | ${p.implementationFiles} | ${p.manifestCliReferences} | ${p.entrypoints} | ${p.catalogEntries} |`), '',
    'CLI 미등록과 browser 문자열은 검토 후보다. 런타임 전체 의존성이나 미구현을 단정하는 검사가 아니다. API catalog 중복 사본은 각 파일에 남기며 건수를 고유 계약 수로 합산하지 않는다.', '',
    '## 모든 기능', '', '| 서비스 | 기능 | 코드 | 로컬 테스트 | 기록 상태 |', '|---|---|---|---|---|',
    ...report.services.flatMap(s => s.capabilities.map(c => `| ${s.service} | ${c.id} | ${c.code.state} | ${c.test} | ${c.status} |`)), '',
    '## 미등록 실행기 후보', '', ...report.inventory.entrypoints.filter(item => !item.declaredInManifest).map(item => `- \`${item.path}\``), '',
    '## 확장 및 스크립트의 선언된 실행 참조', '',
    ...report.inventory.runtimeEntrypoints.map(item => `- \`${item.path}\` — ${item.kind}; declared by \`${item.declaredBy}\`; source present: ${item.sourcePresent}`), '',
    '## 브라우저와 UI 의존 검토 후보', '',
    '문자열·정적 선언 검출이며 반복 HTTP 경로에 실제로 남아 있다는 증명은 아니다.', '',
    ...report.inventory.browserMentions.map(item => `- \`${item.path}\` (${item.kinds.join(', ')})`), '',
    '## 누락 참조', '', ...report.inventory.missingReferences.map(item => `- \`${item.path ?? 'invalid path'}\` (${item.code})`), '',
    '## 조사 오류', '', ...report.errors.map(item => `- ${item.service ?? item.file}: ${item.code}`), ''];
  return lines.join('\n');
}
