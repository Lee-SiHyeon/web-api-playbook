import {RedditClient,RedditError} from '../src/reddit.mjs';
let client;
try{const [operation,value]=process.argv.slice(2);if(!['search','comments'].includes(operation))throw new RedditError('OPERATION_DENIED');client=new RedditClient({accessToken:process.env.REDDIT_ACCESS_TOKEN,userAgent:process.env.REDDIT_USER_AGENT});console.log(JSON.stringify({ok:true,result:await client[operation](value)},null,2));}
catch(e){console.error(JSON.stringify({ok:false,code:e instanceof RedditError?e.code:'LOCAL_ERROR',receipt:e instanceof RedditError?e.receipt:undefined}));process.exitCode=1;}
finally{client?.close();}
