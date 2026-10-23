import {requestPartnerOperation} from '../src/partners-client.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/partners.mjs  (reads {"operation":"dashboard|search",...} JSON from stdin; productLink uses affiliate-link.mjs)'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
try{
 const request=JSON.parse(input);
 if(request.operation==='productLink')throw Error('Use scripts/affiliate-link.mjs so issuance is journalled before its single POST');
 console.log(JSON.stringify(await requestPartnerOperation(request)));
}
catch(error){console.error(error.message);process.exitCode=1;}
