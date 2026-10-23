import { PlaceInfoError, readKakaoPlace, readNaverPlaceSummary, searchKakaoPlaces } from '../adapters/place-info.mjs';

const usage = [
  'Place data through observed public HTTP contracts:',
  '  node scripts/place-info.mjs kakao-search --query "성수 맛집" [--center "x,y"]',
  '  node scripts/place-info.mjs kakao-place --id 799001769',
  '  node scripts/place-info.mjs naver-summary --id 1930888437',
].join('\n');

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw new PlaceInfoError('PLACES_OPTION_INPUT');
    const separator = token.indexOf('=');
    const key = token.slice(2, separator < 0 ? undefined : separator);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (!key || value == null || value.startsWith('--') || Object.hasOwn(options, key))
      throw new PlaceInfoError('PLACES_OPTION_INPUT');
    options[key] = value;
  }
  return options;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage + '\n');
    return;
  }
  const options = parseOptions(args);
  let result;
  if (command === 'kakao-search') {
    if (Object.keys(options).some(key => !['query', 'center'].includes(key))) throw new PlaceInfoError('PLACES_OPTION_INPUT');
    result = await searchKakaoPlaces({ query: options.query, center: options.center });
  } else if (command === 'kakao-place') {
    if (Object.keys(options).some(key => key !== 'id')) throw new PlaceInfoError('PLACES_OPTION_INPUT');
    result = await readKakaoPlace({ placeId: options.id });
  } else if (command === 'naver-summary') {
    if (Object.keys(options).some(key => key !== 'id')) throw new PlaceInfoError('PLACES_OPTION_INPUT');
    result = await readNaverPlaceSummary({ placeId: options.id });
  } else {
    throw new PlaceInfoError('PLACES_COMMAND_INPUT');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(error => {
  const code = error instanceof PlaceInfoError ? error.code : 'PLACES_UNEXPECTED';
  process.stderr.write(code + '\n');
  process.exitCode = 2;
});
