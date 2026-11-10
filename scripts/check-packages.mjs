import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';

assert.ok(process.env.npm_execpath,'Run through npm run check:packages');
const root=process.cwd(),output=resolve('artifacts/packages');mkdirSync(output,{recursive:true});
const packages=['literature-radar','paper-autopsy','review-copilot','clinic-writer'];
const archives=[],commands=[];
function npm(args,cwd=root){
  const result=spawnSync(process.execPath,[process.env.npm_execpath,...args],{cwd,encoding:'utf8'});
  commands.push({command:args[0],exitCode:result.status});
  assert.equal(result.status,0,result.stderr);return result.stdout;
}
for(const folder of packages){
  const manifest=JSON.parse(readFileSync(resolve('packages',folder,'package.json'),'utf8'));
  assert.equal(manifest.license,'MIT');assert.equal(manifest.engines.dsh,'0.2.2-rc.1');
  const result=JSON.parse(npm(['pack',`./packages/${folder}`,'--json','--pack-destination',output]));
  const files=result[0].files.map(f=>f.path);
  assert.ok(files.includes('src/dsh.js')&&files.includes('LICENSE')&&files.includes('cordis.patch.yml'));
  assert.ok(!files.some(f=>f.includes('node_modules/')||f.startsWith('products/')||f.endsWith('.env')));
  archives.push({name:manifest.name,version:manifest.version,file:result[0].filename,files:files.length});
}
const install=mkdtempSync(join(tmpdir(),'medical-research-packages-'));
npm(['install','--prefix',install,'--ignore-scripts','--no-audit','--no-fund',...archives.map(a=>resolve(output,a.file))]);
const execute=(file,args)=>{
  const result=spawnSync(process.execPath,[file,...args],{cwd:install,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return result.stdout;
};
for(const archive of archives){
  const folder=join(install,'node_modules',archive.name);
  assert.equal(JSON.parse(readFileSync(join(folder,'package.json'),'utf8')).version,archive.version);
  assert.ok(execute(join(folder,'cli.js'),['--help']).length>0);
}
const review=join(install,'node_modules/dsh-review-copilot/cli.js');
const prompts=JSON.parse(execute(review,['prompts']));assert.equal(prompts.prompts.length,5);assert.equal(prompts.license,'MIT');
const project=join(install,'review.json');
execute(review,['init','--project',project,'--input',resolve(root,'examples/review/reviews.txt'),'--title','Original fictional package exercise']);
const before=readFileSync(project,'utf8');
const context=JSON.parse(execute(review,['context','--project',project,'--id','R001']));
assert.equal(context.prompt.id,'P1-29');assert.equal(readFileSync(project,'utf8'),before);
const card=join(install,'card');
execute(join(install,'node_modules/dsh-paper-autopsy/cli.js'),['analyze','--pdf',resolve(root,'examples/autopsy/teaching-paper.pdf'),'--outline',resolve(root,'examples/autopsy/outline.json'),'--output',card]);
assert.ok(JSON.parse(readFileSync(join(card,'card.json'),'utf8')).pages.length>0);
execute(join(install,'node_modules/dsh-clinic-writer/examples/demo.js'),['--output',join(install,'writer-demo')]);
const result={status:'passed',node:process.version,packages:archives,commands,isolatedInstall:true,
  modelCalls:0,externalPaperRequests:0,realDshBootInThisCheck:false};
writeFileSync(resolve(output,'verification.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
