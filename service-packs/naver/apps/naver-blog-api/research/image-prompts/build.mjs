import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function fill(template, values) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => String(values[key] ?? '').trim());
}

export function compileImagePrompt(preset, input = {}) {
  const variant = input.variant ? preset.variants?.[input.variant] || {} : {};
  const values = {
    ...preset.defaultValues,
    ...variant,
    ...input,
  };
  const missing = preset.requiredSlots.filter(key => !String(values[key] ?? '').trim());
  if (missing.length) throw new TypeError(`missing required image prompt slots: ${missing.join(', ')}`);
  return {
    schemaVersion: 1,
    presetId: preset.id,
    prompt: fill(preset.positiveTemplate, values).replace(/\s+/g, ' ').trim(),
    negativePrompt: preset.negativePrompt.join(', '),
    aspectRatio: values.aspectRatio,
    disclosure: preset.disclosurePolicy,
    values: Object.fromEntries([...preset.requiredSlots, ...preset.optionalSlots].map(key => [key, values[key] ?? null])),
  };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  const presetPath = process.argv[2] || path.join(root, 'home-room-product-snapshot.json');
  const input = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : {};
  const preset = JSON.parse(await readFile(presetPath, 'utf8'));
  console.log(JSON.stringify(compileImagePrompt(preset, input), null, 2));
}
