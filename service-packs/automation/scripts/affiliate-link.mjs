import {createAffiliateLink} from '../src/affiliate-link.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/affiliate-link.mjs <workspace-root>  (reads {"product":...} JSON from stdin)'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
const root=process.argv[2];
if(!root){console.error('Usage: node scripts/affiliate-link.mjs <workspace-root>');process.exitCode=2;}
else try{const {product}=JSON.parse(input);console.log(JSON.stringify(await createAffiliateLink(root,product)));}
catch(error){console.error(error.message);process.exitCode=1;}
