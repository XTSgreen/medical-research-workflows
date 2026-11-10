import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const source=JSON.parse(readFileSync(new URL('../content/review-basic-prompts.json',import.meta.url),'utf8'));
assert.equal(source.license,'MIT');
assert.deepEqual(source.prompts.map(p=>p.id),['P1-26','P1-27','P1-28','P1-29','P1-30']);
const target=new URL('../packages/review-copilot/src/prompts-data.json',import.meta.url);
if(process.argv.includes('--check'))assert.deepEqual(JSON.parse(readFileSync(target,'utf8')),source);
else writeFileSync(target,JSON.stringify(source,null,2)+'\n');
console.log('Five MIT basic prompts match the public source.');
