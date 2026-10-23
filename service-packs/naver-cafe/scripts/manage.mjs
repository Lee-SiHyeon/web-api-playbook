import { pathToFileURL } from 'node:url';
import { CafeApiError } from '../lib/session.mjs';
import { NaverCafeManager } from '../lib/manager.mjs';

const COMMANDS = new Set(['menus', 'post-create', 'post-update', 'post-delete', 'post-links','post-inspect',
  'board-add', 'board-rename', 'board-delete']);

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 3_000_000) throw new CafeApiError('INPUT', 'Cafe management input is too large');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new CafeApiError('INPUT', 'A JSON object must be supplied on stdin');
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !COMMANDS.has(argv[0])) throw new CafeApiError('USAGE', 'Expected one Cafe management command');
  const manager = await NaverCafeManager.fromStored();
  const command = argv[0];
  if (command === 'menus') {
    const result = await manager.managerMenus();
    return { cafeId: result.cafeId, menus: result.menus.map(menu => ({
      menuId: String(menu.menuId), menuCode: menu.menuCode, menuName: menu.menuName,
    })), evidence: result.evidence };
  }
  const input = await readInput();
  switch (command) {
    case 'post-create': return manager.createPost(input);
    case 'post-update': return manager.updatePost(input);
    case 'post-delete': return manager.deletePost(input);
    case 'post-links': return manager.articleLinks(input);
    case 'post-inspect': return manager.inspectPost(input);
    case 'board-add': return manager.addBoard(input);
    case 'board-rename': return manager.renameBoard(input);
    case 'board-delete': return manager.deleteBoard(input);
    default: throw new CafeApiError('USAGE', 'Unsupported Cafe management command');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof CafeApiError ? error.code : 'INTERNAL',
      ...(typeof error?.details?.journal === 'string' ? { journal: error.details.journal } : {}),
      ...(error?.details?.httpStatus == null ? {} : { httpStatus: error.details.httpStatus }),
      ...(error?.details?.errorCode == null ? {} : { applicationErrorCode: error.details.errorCode }),
    })}\n`);
    process.exitCode = 1;
  }
}
