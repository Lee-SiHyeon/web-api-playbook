import { pathToFileURL } from 'node:url';
import { clientPacks, resolveClientPack, runClientPack } from '../lib/client-packs.mjs';

export async function main(args = process.argv.slice(2)) {
  const [command = 'list', ...rest] = args;
  const boundary = rest.indexOf('--');
  const options = boundary < 0 ? rest : rest.slice(0, boundary);
  const forwarded = boundary < 0 ? [] : rest.slice(boundary + 1);
  const matches = options.filter(value => /^--service=[a-z][a-z0-9-]*$/.test(value));
  if (options.length !== matches.length || matches.length > 1) throw Object.assign(new Error('CLIENT_ARGUMENT_INVALID'), { code: 'CLIENT_ARGUMENT_INVALID' });
  const id = matches[0]?.slice('--service='.length);
  if (command === 'list' && !id && !forwarded.length) {
    process.stdout.write(JSON.stringify({ schema: 'playbook-client-list-v1', networkUsed: false,
      currentAuthenticationVerified: false, clients: await clientPacks() }, null, 2) + '\n');
    return 0;
  }
  if (command === 'describe' && id && !forwarded.length) {
    const { directory, ...client } = await resolveClientPack(id);
    process.stdout.write(JSON.stringify(client, null, 2) + '\n');
    return 0;
  }
  if (command !== 'run' || !id) throw Object.assign(new Error('CLIENT_ARGUMENT_INVALID'), { code: 'CLIENT_ARGUMENT_INVALID' });
  return (await runClientPack(id, forwarded)).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => {
    const code = /^CLIENT_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'CLIENT_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
    process.exitCode = 1;
  });
}
