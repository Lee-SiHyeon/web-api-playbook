import {collectDailyReport} from '../src/partners-report.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/daily-report.mjs  (reads {"startDate","endDate","directory"} JSON from stdin)'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
try{const {startDate,endDate,directory}=JSON.parse(input);console.log(JSON.stringify(await collectDailyReport({startDate,endDate},directory)));}
catch(error){console.error(error.message);process.exitCode=1;}
