import {fetchReviewSample} from '../src/review-client.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/reviews.mjs  (reads {"productId","sample?","page?","mode?"} JSON from stdin)'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
try{console.log(JSON.stringify(await fetchReviewSample(JSON.parse(input))));}
catch(error){console.error(error.message);process.exitCode=1;}
