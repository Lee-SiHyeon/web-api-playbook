import {fetchSubcategories} from '../src/category-client.mjs';
import {traverseBranch} from '../src/category-branch.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/category-branch.mjs  (reads {"file","seed":{"linkcodes","component"},"budget?","intervalMs?"} JSON from stdin)'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
try{
 const {file,seed,budget,intervalMs}=JSON.parse(input);
 const result=await traverseBranch(file,seed,query=>fetchSubcategories(query,process.env.COUPANG_REVIEW_COOKIE),{...(budget===undefined?{}:{budget}),...(intervalMs===undefined?{}:{intervalMs})});
 console.log(JSON.stringify(result));
}catch(error){console.error(error.message);process.exitCode=1;}
