import { publishCapturedTikTok, reconcileTikTokPublish, readTikTokItem, tiktokPublishCapabilities } from './tiktok-publisher.mjs';

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'help') {
    console.log('TikTok observed web HTTP client. Commands: capabilities, publish-captured, reconcile, item. JSON input is read from stdin. Any post needs a fresh DPAPI-protected envelope from a blocked first-party browser request; public requires an explicit visibility intent and the user\'s branded-terms consent.');
    return;
  }
  if (command === 'capabilities') { console.log(JSON.stringify(tiktokPublishCapabilities)); return; }
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 65536) throw Object.assign(new Error(), { code: 'TIKTOK_CLI_INPUT_LIMIT' }); }
  const input = JSON.parse(raw);
  let result;
  if (command === 'publish-captured') result = await publishCapturedTikTok(input);
  else if (command === 'reconcile') result = await reconcileTikTokPublish(input);
  else if (command === 'item') result = await readTikTokItem(input.itemId, input);
  else throw Object.assign(new Error(), { code: 'TIKTOK_CLI_COMMAND_INVALID' });
  console.log(JSON.stringify(result));
  if ((result.state && !['published_private_verified', 'published_public_verified'].includes(result.state))
    || (command === 'item' && !result.readbackVerified)
    || (command === 'reconcile' && result.freshReadback === false)) process.exitCode = 2;
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: /^TIKTOK_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'TIKTOK_CLI_FAILED' }));
  process.exitCode = 1;
});
