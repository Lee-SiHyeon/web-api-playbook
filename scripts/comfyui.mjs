#!/usr/bin/env node
// ComfyUI playbook CLI (read-only). Comfy Hub search/inspect needs no account; local-* reads the owner's own server on loopback.
//   node scripts/comfyui.mjs search  [--q=icon] [--category=generate-images] [--model=Flux] [--sort=newest] [--cursor=...]
//   node scripts/comfyui.mjs inspect --slug=<hub slug> [--no-licenses]
//   node scripts/comfyui.mjs scan    [--category=a,b] [--q=...] [--limit=20] [--out=work/comfyui-scan.json]   search + inspect each result
//   node scripts/comfyui.mjs status|nodes [--base=http://127.0.0.1:18188]
// Workflow graphs are untrusted data: parsed for node types and model links, never executed or installed.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServiceRegistry } from '../lib/service-operations/index.mjs';

const args = Object.fromEntries(process.argv.slice(3).map(a => { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const cmd = process.argv[2];
const out = (value, code = 0) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); process.exitCode = code; };
const pick = (keys) => Object.fromEntries(keys.filter(k => args[k] !== undefined && args[k] !== true).map(k => [k, String(args[k])]));

// Hub model names whose weights are non-commercial or revenue-capped (licence cards checked 2026-11-25; Comfy-Org repacks often leave license_name empty).
const NC_MODEL = /\bflux[ .]?1(?![ .-]*schnell)|flux[ .]?2 dev|krea dev|flux\.?1 fill|ltx-2|flux[ .]?3 klein|qwen[- ]image 2\.1|krea 2/i;
const registry = await createServiceRegistry('comfyui');
const run = async (operation, query) => (await registry.execute(operation, { query })).data;
try {
  if (cmd === 'search') out(await run('hub-workflows', pick(['q', 'category', 'model', 'sort', 'cursor'])));
  else if (cmd === 'inspect') { if (!args.slug) throw Object.assign(new Error('x'), { code: 'COMFYUI_SLUG_REQUIRED' }); out(await run('hub-workflow', { slug: String(args.slug), licenses: !args['no-licenses'] })); }
  else if (cmd === 'status' || cmd === 'nodes') out(await run(`local-${cmd}`, pick(['base'])));
  else if (cmd === 'scan') {
    const limit = Math.min(Number(args.limit ?? 20), 200); const cats = args.category ? String(args.category).split(',') : [undefined]; const rows = [];
    for (const category of cats) {
      let cursor; let taken = 0;
      do {
        const page = await run('hub-workflows', { ...pick(['q', 'model', 'sort']), ...(category ? { category } : {}), ...(cursor ? { cursor } : {}) });
        for (const item of page.items) {
          if (taken >= limit || rows.some(r => r.slug === item.slug)) continue; taken++;
          let report; try { report = await run('hub-workflow', { slug: item.slug, licenses: true }); } catch (error) { report = { error: error.code ?? 'COMFYUI_READ_FAILED' }; }
          rows.push({ slug: item.slug, name: item.name, author: item.author, category: category ?? null, hubModels: item.models, url: item.url,
            verdict: report.verdict ?? null, counts: report.counts ?? null, customPacks: report.customPacks ?? [], apiNodes: (report.nodes ?? []).filter(n => n.kind === 'api').map(n => n.type),
            models: (report.models ?? []).map(m => `${m.directory ?? '?'}/${m.name}`), nonCommercial: [...(report.licenses ?? []).filter(l => l.commercial === false).map(l => `${l.repo} (${l.license})`), ...item.models.filter(m => NC_MODEL.test(m)).map(m => `hub model: ${m}`)],
            licenseUnknown: (report.licenses ?? []).filter(l => l.commercial === null).map(l => l.repo), error: report.error ?? null });
          process.stderr.write(`${rows.at(-1).verdict ?? rows.at(-1).error}\t${item.slug}\n`);
        }
        cursor = page.nextCursor;
      } while (cursor && taken < limit);
    }
    const summary = Object.fromEntries(['local-core-only', 'paid-api-nodes', 'needs-custom-nodes'].map(v => [v, rows.filter(r => r.verdict === v).length]));
    const result = { scannedAt: new Date().toISOString(), summary, usableHere: rows.filter(r => r.verdict === 'local-core-only' && !r.nonCommercial.length).map(r => r.slug), licenceToCheck: rows.filter(r => r.verdict === 'local-core-only' && !r.nonCommercial.length && r.licenseUnknown.length).map(r => r.slug), rows };
    if (args.out) { await mkdir(path.dirname(String(args.out)), { recursive: true }); await writeFile(String(args.out), JSON.stringify(result, null, 1)); }
    out({ summary, usableHere: result.usableHere, file: args.out ?? null });
  } else out({ commands: ['search', 'inspect', 'scan', 'status', 'nodes'], example: 'node scripts/comfyui.mjs scan --category=sprite-sheets-and-game-assets,generate-images --limit=15 --out=work/comfyui-scan.json' });
} catch (error) { out({ ok: false, code: error.code ?? 'COMFYUI_FAILED' }, 1); }
finally { await registry.close(); }
