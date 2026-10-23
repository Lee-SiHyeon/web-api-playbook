import { fail } from './errors.mjs';

export function readJsonPointer(value, pointer) {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) throw fail('JSON_POINTER_INVALID');
  if (pointer === '') return value;
  const parts = pointer.slice(1).split('/').map(part => {
    if (/~(?![01])/.test(part)) throw fail('JSON_POINTER_INVALID');
    return part.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  let current = value;
  for (const part of parts) {
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') throw fail('JSON_POINTER_INVALID');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(part)) throw fail('JSON_POINTER_NOT_FOUND');
      current = current[Number(part)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      throw fail('JSON_POINTER_NOT_FOUND');
    }
  }
  return current;
}
