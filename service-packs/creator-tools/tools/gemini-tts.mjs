if (process.argv.includes('--help')) { console.log('gemini-tts.mjs — see service-packs/creator-tools/README.md for inputs and execution mode'); process.exit(0); }
// node gemini-tts.mjs <model> <voice> <textFile> <out.wav> [styleFile]
// One generateContent call -> 24kHz 16-bit mono PCM -> WAV. Key from DPAPI ('gemini-api-key').
import fs from 'node:fs';
import { ProtectedStore } from '../../../lib/protected-store.mjs';
const [model, voice, textFile, out, styleFile] = process.argv.slice(2);
const key = JSON.parse(new ProtectedStore().read('gemini-api-key')).key;
const style = styleFile ? fs.readFileSync(styleFile, 'utf8').trim() + '\n\n' : '';
const text = style + fs.readFileSync(textFile, 'utf8');
const t0 = Date.now();
const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
  signal: AbortSignal.timeout(900000) });
const j = await r.json();
if (r.status !== 200) { console.log('FAIL', r.status, j.error?.message); process.exit(2); }
const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
const pcm = Buffer.from(part.inlineData.data, 'base64');
const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] || 24000);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
fs.writeFileSync(out, Buffer.concat([h, pcm]));
console.log('ok', out, (pcm.length / 2 / rate).toFixed(2) + 's', 'took', ((Date.now() - t0) / 1000).toFixed(1) + 's', part.inlineData.mimeType, j.usageMetadata?.totalTokenCount);
