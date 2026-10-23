import {readFile} from 'node:fs/promises';
const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
const section=readme.split('## Commands\n')[1]?.split('\n## ')[0];
if(!section)throw Error('Static command list missing from README');
process.stdout.write('Automation API pack help (static; no credentials or network access)\n\n'+section.trim()+'\n');
