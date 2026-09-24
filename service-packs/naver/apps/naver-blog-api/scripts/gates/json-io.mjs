import { readFile } from 'node:fs/promises';

export function parseJsonText(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

export async function readJsonFile(target) {
  return parseJsonText(await readFile(target, 'utf8'));
}
