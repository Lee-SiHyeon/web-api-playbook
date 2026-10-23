import {collectIntake} from '../src/intake-collector.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/intake-poll.mjs <output-directory> <published-post-id> [...]'))process.exit(0);
const [directory,...postIds]=process.argv.slice(2);
if(!directory||!postIds.length){console.error('Usage: node scripts/intake-poll.mjs <output-directory> <published-post-id> [...]');process.exitCode=2;}
else try{console.log(JSON.stringify(await collectIntake(directory,postIds)));}
catch(error){console.error(error.message);process.exitCode=1;}
