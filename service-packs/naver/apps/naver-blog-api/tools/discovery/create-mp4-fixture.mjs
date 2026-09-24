import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 const result=await page.evaluate(async()=>{
  const mime=['video/mp4;codecs=avc1.42001E','video/mp4'].find(m=>MediaRecorder.isTypeSupported(m));if(!mime)return {supported:false};
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
  const ctx=canvas.getContext('2d'),stream=canvas.captureStream(12),parts=[],rec=new MediaRecorder(stream,{mimeType:mime});
  rec.ondataavailable=e=>parts.push(e.data);const stopped=new Promise(r=>rec.onstop=r);
  rec.start();for(let i=0;i<24;i++){ctx.fillStyle='#173027';ctx.fillRect(0,0,320,180);ctx.fillStyle='#FCD34D';ctx.beginPath();ctx.arc(30+i*10,75,18,0,Math.PI*2);ctx.fill();ctx.font='16px sans-serif';ctx.fillText('MP4 publisher capability check',18,140);await new Promise(r=>setTimeout(r,85));}
  rec.stop();await stopped;stream.getTracks().forEach(t=>t.stop());return {supported:true,mime,bytes:[...new Uint8Array(await new Blob(parts).arrayBuffer())]};
 });
 if(result.supported){const bytes=Buffer.from(result.bytes);await fs.writeFile('runs/2026-09-24-video-publisher/publisher-mp4-check.mp4',bytes);console.log(JSON.stringify({supported:true,mime:result.mime,bytes:bytes.length,ftyp:bytes.subarray(4,8).toString()}));}
 else console.log(JSON.stringify(result));
}finally{await browser.close();}
