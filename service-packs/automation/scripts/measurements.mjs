import {collectMeasurements} from '../src/measurement-snapshot.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/measurements.mjs <output-directory> [post-id ...]'))process.exit(0);
const [directory,...postIds]=process.argv.slice(2);
if(!directory){console.error('Usage: node scripts/measurements.mjs <output-directory> [post-id ...]');process.exitCode=2;}
else try{const result=await collectMeasurements(directory,process.env,postIds);console.log(JSON.stringify(result));if(result.status!=='collected')process.exitCode=1;}
catch(error){console.error(error.message);process.exitCode=1;}
