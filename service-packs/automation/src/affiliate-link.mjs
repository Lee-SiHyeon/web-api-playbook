import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,open,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {requestPartnerOperation} from './partners-client.mjs';

export async function createAffiliateLink(root,product,{env=process.env,fetchImpl=globalThis.fetch,now=()=>new Date(),uuid=randomUUID}={}){
 const ids=[product?.productId,product?.itemId,product?.vendorItemId];
 if(ids.some(x=>!/^\d+$/.test(String(x))))throw Error('Exact product option required');
 const key=ids.map(String).join('-'),directory=join(root,'data/affiliate-links');await mkdir(directory,{recursive:true});
 const file=join(directory,key+'.json');let existing;
 try{existing=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(existing){if(existing.status!=='generated')throw Error('Prior link request requires reconciliation');return {...existing,reused:true};}
 if(!env.COUPANG_COOKIE||!env.COUPANG_X_TOKEN)throw Error('Current authorized credentials required before link intent');
 const record={key,productId:String(ids[0]),itemId:String(ids[1]),vendorItemId:String(ids[2]),status:'intent',startedAt:now().toISOString(),payloadHash:createHash('sha256').update(JSON.stringify({product})).digest('hex')};
 const intent=await open(file,'wx');try{await intent.writeFile(JSON.stringify(record,null,2));await intent.sync();}finally{await intent.close();}
 // A failed or interrupted call leaves intent; never automatically repeat the issuance request.
 let result;
 try{result=await requestPartnerOperation({operation:'productLink',payload:{product},evidenceOnly:false},{cookie:env.COUPANG_COOKIE,xToken:env.COUPANG_X_TOKEN,fetchImpl,now});}
 catch{throw Error('Link request failed; reconcile saved intent');}
 Object.assign(record,{status:'generated',shortUrl:result.data.shortUrl,checkedAt:result.checkedAt,responseHash:result.responseHash,destinationVerified:false});
 const temp=file+'.'+uuid()+'.tmp';await writeFile(temp,JSON.stringify(record,null,2));await rename(temp,file);
 return {...record,file};
}
