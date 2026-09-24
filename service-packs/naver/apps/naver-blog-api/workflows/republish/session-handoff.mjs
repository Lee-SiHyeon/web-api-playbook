import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadContext} from './core.mjs';
export async function startHandoff({manifestFile,post}){
 await loadContext(manifestFile,post); // Fail before listening if the target is not explicitly configured.
 const allowed=['baseline','upload','preview','prepare','publish','readback'];
 const nonce=randomBytes(24).toString('hex');let consumed=false,origin;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.headers.host!==new URL(origin).host)return res.writeHead(403).end();
  if(req.method==='GET'&&req.url==='/')return res.end(`<meta charset="utf-8"><h1>Republish ${post}</h1><form method="post" action="/handoff"><input type="hidden" name="nonce" value="${nonce}"><label>Operation<select name="operation">${allowed.map(x=>`<option>${x}</option>`).join('')}</select></label><label>Session envelope<input type="password" name="envelope" autocomplete="off"></label><button>Run selected operation</button></form>`);
  if(req.method!=='POST'||req.url!=='/handoff'||req.headers.origin!==origin||consumed)return res.writeHead(403).end();
  let envelope='';try{
   const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>65536)throw Error('SIZE');chunks.push(c);}const form=new URLSearchParams(Buffer.concat(chunks).toString());chunks.forEach(c=>c.fill(0));
   const op=form.get('operation');if(form.get('nonce')!==nonce||!allowed.includes(op))throw Error('SCOPE');
   envelope=form.get('envelope');form.delete('envelope');if(typeof JSON.parse(envelope).cookieHeader!=='string')throw Error('INPUT');consumed=true;clearTimeout(deadline);res.end('Operation started. See local receipt.');
   const exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./run.mjs',import.meta.url)),op,`--manifest=${manifestFile}`,`--post=${post}`],{stdio:['pipe','inherit','inherit'],windowsHide:true});child.stdin.end(envelope);child.on('error',reject);child.on('exit',resolve);});if(exitCode!==0)process.exitCode=2;
  }catch{process.exitCode=2;if(!res.writableEnded)res.writeHead(400).end('Operation rejected.');}
  finally{envelope='';server.close();server.closeAllConnections();clearTimeout(deadline);}
 });
 const deadline=setTimeout(()=>{server.close();server.closeAllConnections();process.exitCode=2;},180000);
 server.listen(0,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;console.log(origin);});
}
