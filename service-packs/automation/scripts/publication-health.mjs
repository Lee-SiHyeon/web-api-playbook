import {checkPublication} from '../src/publication-health.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/publication-health.mjs  (reads {"expected","directory"} JSON from stdin)'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
try{const {expected,directory}=JSON.parse(input);console.log(JSON.stringify(await checkPublication(expected,directory)));}
catch(error){console.error(error.message);process.exitCode=1;}
