import {collectPrices} from '../src/price-maintenance.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/price-check.mjs  (reads {"expected","directory"} JSON from stdin)'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
try{const {expected,directory}=JSON.parse(input);console.log(JSON.stringify(await collectPrices(expected,directory)));}
catch(error){console.error(error.message);process.exitCode=1;}
