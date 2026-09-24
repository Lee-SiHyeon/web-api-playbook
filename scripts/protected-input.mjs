// Hidden stdin for an agent/connector. The value is never a command argument or terminal echo.
import { ProtectedStore } from '../lib/protected-store.mjs';
const name=process.argv[2];
if(name!=='reddit-login-link')process.exit(2);
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let raw='';const timer=setTimeout(()=>process.exit(2),60000);
process.stdout.write('PRIVATE_STDIN_READY\n');
process.stdin.on('data',chunk=>{
  raw+=chunk;
  if(raw.length>32768)process.exit(2);
  if(!/[\r\n]/.test(raw))return;
  try{
    const data=JSON.parse(raw.trim());
    const url=new URL(data.url);
    if(url.origin!=='https://www.reddit.com'||!url.pathname.startsWith('/magic_link/')||
      typeof data.handle!=='string'||!/^[-\w]{3,40}$/.test(data.handle))throw Error();
    new ProtectedStore().write(name,JSON.stringify({url:data.url,handle:data.handle,receivedAt:new Date().toISOString()}));
    raw='';process.stdout.write('{"ok":true,"stored":true}\n');
  }catch{process.stdout.write('{"ok":false,"code":"PRIVATE_INPUT_INVALID"}\n');process.exitCode=2;}
  clearTimeout(timer);if(process.stdin.isTTY)process.stdin.setRawMode(false);process.exit(process.exitCode||0);
});
