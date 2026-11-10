import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProject, classify, parseComments, updateItem, addEvidence, toMarkdown, saveProject, loadProject, validateProject, recordProposal } from '../packages/review-copilot/src/review.js';
import { generateProposal, validateProposal } from '../packages/review-copilot/src/model.js';
import {listPrompts,getPrompt,buildReviewContext} from '../packages/review-copilot/src/prompts.js';

const project = () => createProject('演示研究', 'Reviewer 1\n1. Please add an external validation cohort.\n\nDiscuss transportability.\n2. Correct the spelling.\nReviewer 2\nComment 1: Explain the statistical method.');
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'hybrid-review-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('P1 basic prompts preserve source text and read-only context preserves completed state',()=>{
  const source=JSON.parse(readFileSync('content/review-basic-prompts.json','utf8'));
  assert.deepEqual(listPrompts().prompts.map(p=>p.id),['P1-26','P1-27','P1-28','P1-29','P1-30']);
  for(const entry of listPrompts().prompts) {
    const prompt=getPrompt(entry.id),original=source.prompts.find(p=>p.id===entry.id);
    assert.equal(prompt.prompt,original.prompt);assert.deepEqual(prompt.inputs,original.inputs);assert.equal(prompt.license,'MIT');
    assert.equal(Object.hasOwn(prompt,'example'),false);
  }
  assert.throws(()=>getPrompt('P1-25'),/Unknown/);
  let p=updateItem(project(),'R002',{response:'Spelling corrected.',location:'Page 2, line 4'});
  p=updateItem(p,'R002',{status:'done',verification:'Fictional manuscript checked'});
  const before=structuredClone(p),context=buildReviewContext(p,{itemId:'R002'});
  assert.equal(context.projectRevision,p.revision);assert.equal(context.prompt.id,'P1-29');assert.equal(context.items.length,1);
  assert.equal(context.items[0].status,'done');assert.ok(context.prompt.prompt.includes('{{'));
  context.items[0].currentResponse='Changed copy';context.prompt.prompt='Changed template';
  assert.deepEqual(p,before);assert.notEqual(getPrompt('P1-29').prompt,'Changed template');
  assert.equal(buildReviewContext(p,{promptId:'P1-28'}).items.length,3);
  assert.throws(()=>buildReviewContext(p,{itemId:'R999'}),/不存在/);
});

test('parser preserves paragraphs, reviewer attribution and Chinese headings', () => {
  const p = project();
  assert.equal(p.items.length, 3);
  assert.equal(p.items[0].text, 'Please add an external validation cohort.\n\nDiscuss transportability.');
  assert.equal(p.items[2].reviewer, 'Reviewer 2');
  assert.deepEqual(parseComments('审稿人一\n意见1：请解释统计方法\n意见2：改正拼写'), [{ reviewer: '审稿人一', text: '请解释统计方法' }, { reviewer: '审稿人一', text: '改正拼写' }]);
  assert.throws(() => parseComments('Reviewer 1'), /正文/);
  assert.throws(() => parseComments(''), /非空/);
});
test('multi-label classification does not hide experiment or method concerns', () => {
  assert.deepEqual(classify('请补充验证集实验并解释统计方法与格式'), ['method', 'experiment', 'format', 'clarification']);
  assert.deepEqual(classify('Interesting work'), ['clarification']);
});
test('completion requires response, location, verification and evidence', () => {
  let p = project();
  assert.throws(() => updateItem(p, 'R001', { status: 'done' }), /回应正文/);
  p = updateItem(p, 'R001', { response: '我们已在附录报告外部验证结果。', location: '附录表 S2' });
  assert.throws(() => updateItem(p, 'R001', { status: 'done', verification: '作者已核对' }), /证据/);
  p = addEvidence(p, 'R001', '附录表 S2，第 5 页', '教学示例：外部队列分析已经写入附录。');
  p = updateItem(p, 'R001', { status: 'done', verification: '逐项核对附录与回复' });
  assert.equal(p.items[0].status, 'done');
  const changed = updateItem(p, 'R001', { response: '修改后的回应' });
  assert.equal(changed.items[0].status, 'draft');
  assert.equal(changed.items[0].verification, '');
  assert.equal(p.items[0].status, 'done', 'updates must not mutate original project');
});
test('completion rejects placeholders and existing-evidence strategy without evidence', () => {
  let p = updateItem(project(), 'R002', { response: '已更正[待补：拼写]', location: '第 2 页', verification: '已看过' });
  assert.throws(() => updateItem(p, 'R002', { status: 'done', verification: '已核对' }), /占位/);
  p = updateItem(p, 'R002', { response: '已更正拼写。', strategy: 'existing-evidence' });
  assert.throws(() => updateItem(p, 'R002', { status: 'done', verification: '已核对' }), /证据/);
  assert.throws(() => updateItem(p, 'R002', { strategy: 'invent' }), /策略/);
  assert.throws(() => updateItem(p, 'R002', { text: '静默替换原文' }), /字段/);
});
test('invalid persisted data is rejected rather than repaired silently', () => {
  const p = project(); p.items[0].status = 'done';
  assert.throws(() => validateProject(p), /回应正文/);
  const duplicate = project(); duplicate.items[1].id = duplicate.items[0].id;
  assert.throws(() => validateProject(duplicate), /重复/);
});
test('atomic persistence, create protection, stale revision and lock behavior', t => {
  const path = join(temp(t), 'nested', 'project.json');
  const p = saveProject(path, project(), { create: true });
  assert.equal(p.revision, 1);
  assert.deepEqual(loadProject(path), p);
  assert.throws(() => saveProject(path, project(), { create: true }), /拒绝覆盖/);
  const next = saveProject(path, updateItem(p, 'R002', { response: '拼写已修正。' }));
  assert.equal(next.revision, 2);
  assert.throws(() => saveProject(path, p), /重新加载/);
  writeFileSync(`${path}.lock`, 'another writer');
  assert.throws(() => saveProject(path, next), /其他进程/);
  assert.equal(loadProject(path).revision, 2);
});
test('corrupted project remains untouched on save failure and lock is cleaned', t => {
  const path = join(temp(t), 'project.json'); writeFileSync(path, '{broken');
  assert.throws(() => saveProject(path, project(), { create: true }));
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  assert.equal(existsSync(`${path}.lock`), false);
});
test('Markdown includes all items, escapes unsafe HTML, and proposal stays separate', () => {
  const p = updateItem(project(), 'R002', { response: '<script>alert(1)</script> | test' });
  const next = recordProposal(p, 'R002', { draft: 'model text', reviewStatus: 'unverified' });
  assert.equal(next.items[1].response, p.items[1].response);
  const md = toMarkdown(next);
  assert.ok(md.includes('R003'));
  assert.ok(md.includes('&lt;script&gt;'));
  assert.ok(!md.includes('<script>'));
  assert.ok(md.includes('未自动接受'));
});
const sampleProposal = { strategy: 'acknowledge-revise', rationale: '先核查再修改', draft: '感谢指出。[待补：核对后说明修改]', evidenceIds: [], missing: ['修改位置'] };
test('model proposals reject hallucinated evidence and missing placeholders', () => {
  const item = project().items[0];
  assert.equal(validateProposal(sampleProposal, item).reviewStatus, 'unverified');
  assert.throws(() => validateProposal({ ...sampleProposal, evidenceIds: ['invented'] }, item), /不存在/);
  assert.throws(() => validateProposal({ ...sampleProposal, draft: 'We performed the experiments.' }, item), /无证据/);
  assert.throws(() => validateProposal({ ...sampleProposal, status: 'done' }, item), /未知字段/);
});
test('real HTTP protocol integration uses configured endpoint, schema, auth and separate data message', async t => {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    const payload = JSON.parse(body);
    assert.equal(payload.model, 'test-model');
    assert.equal(payload.messages[0].role, 'system');
    assert.ok(payload.messages[1].content.includes('external validation'));
    const context=JSON.parse(payload.messages[1].content);
    assert.equal(context.workflowPrompt.id,'P1-29');assert.equal(context.workflowPrompt.prompt,getPrompt('P1-29').prompt);
    assert.equal(context.workflowPrompt.version,'0.1.0');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleProposal) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const generated = await generateProposal(project().items[0], { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', model: 'test-model' });
  assert.equal(generated.draft, sampleProposal.draft);
  assert.equal(generated.model, 'test-model');
  assert.deepEqual(generated.workflowPrompt,{product:'P1',id:'P1-29',version:'0.1.0',license:'MIT'});
});
test('model failure does not leak provider body; remote plaintext is rejected', async () => {
  const options = { baseUrl: 'https://example.org/v1', apiKey: 'private-key', model: 'test-model' };
  await assert.rejects(generateProposal(project().items[0], { ...options, fetch: async () => new Response('private-key and evidence', { status: 401 }) }), /HTTP 401/);
  await assert.rejects(generateProposal(project().items[0], { ...options, baseUrl: 'http://example.org/v1' }), /HTTPS/);
  await assert.rejects(generateProposal(project().items[0], { ...options, fetch: async () => new Response('not JSON') }), /有效 JSON/);
});
test('CLI survives separate processes and refuses overwriting exports', t => {
  const dir = temp(t), path = join(dir, 'project.json'), input = join(dir, 'reviews.txt'), response = join(dir, 'response.txt'), output = join(dir, 'responses.md');
  writeFileSync(input, 'Reviewer 1\n1. Correct spelling.'); writeFileSync(response, 'We corrected the spelling of cohort.');
  const run = (...args) => spawnSync(process.execPath, [resolve('packages/review-copilot/cli.js'), ...args], { encoding: 'utf8' });
  let result = run('init', '--project', path, '--input', input, '--title', 'CLI fixture');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run('init', '--project', path, '--input', input, '--title', 'overwrite').status, 1);
  result = run('update', '--project', path, '--id', 'R001', '--response-file', response, '--location', 'Page 2, line 4');
  assert.equal(result.status, 0, result.stderr);
  result = run('complete', '--project', path, '--id', 'R001', '--verification', 'Checked revised manuscript');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadProject(path).items[0].status, 'done');
  const before=readFileSync(path,'utf8');
  const context=run('context','--project',path,'--id','R001','--prompt','P1-29');
  assert.equal(context.status,0,context.stderr);assert.equal(JSON.parse(context.stdout).items[0].status,'done');
  assert.equal(readFileSync(path,'utf8'),before);
  assert.equal(JSON.parse(run('prompts').stdout).prompts.length,5);
  assert.equal(run('prompts','--prompt','ADV-01').status,1);
  result = run('export', '--project', path, '--output', output);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(output, 'utf8').includes('1/1'));
  assert.equal(run('export', '--project', path, '--output', output).status, 1);
  assert.equal(run('draft', '--project', path, '--id', 'R001').status, 1);
});
