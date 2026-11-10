#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createProject, loadProject, saveProject, updateItem, addEvidence, getItem, recordProposal, toMarkdown } from './src/review.js';
import { generateProposal } from './src/model.js';
import { listPrompts, getPrompt, buildReviewContext } from './src/prompts.js';

const HELP = `review-copilot <command> [options]
prompts [--prompt P1-29]
context --project FILE [--id R001] [--prompt P1-29]
init --project FILE --input reviews.txt --title TITLE
show --project FILE
update --project FILE --id R001 --response-file FILE --location TEXT [--strategy STRATEGY] [--categories method,experiment]
evidence --project FILE --id R001 --source TEXT --excerpt-file FILE
draft --project FILE --id R001 --send-to-model
complete --project FILE --id R001 --verification TEXT
reopen --project FILE --id R001
export --project FILE --output responses.md

export 拒绝覆盖现有文件。draft 将意见和证据发给环境变量指定的模型服务，建议单独保存，不会改写人工正文。`;

export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries([
    'project', 'input', 'title', 'id', 'response-file', 'location', 'strategy', 'categories', 'source', 'excerpt-file', 'verification', 'output', 'prompt',
  ].map(key => [key, { type: 'string' }]).concat([['help', { type: 'boolean' }], ['send-to-model', { type: 'boolean' }]])) });
  if (v.help || !positionals.length) { console.log(HELP); return; }
  if (positionals.length !== 1) throw new Error('仅支持一个子命令');
  const command = positionals[0];
  if (!['init', 'show', 'update', 'evidence', 'draft', 'complete', 'reopen', 'export', 'prompts', 'context'].includes(command)) throw new Error(`未知命令 ${command}`);
  if (command === 'prompts') { console.log(JSON.stringify(v.prompt ? getPrompt(v.prompt) : listPrompts(), null, 2)); return; }
  const need = key => { if (!v[key]?.trim()) throw new Error(`缺少 --${key}`); return v[key]; };
  const path = need('project');
  if (command === 'init') {
    const saved = saveProject(path, createProject(need('title'), readFileSync(need('input'), 'utf8')), { create: true });
    console.log(`已导入 ${saved.items.length} 条意见，版本 ${saved.revision}`); return;
  }
  const project = loadProject(path);
  if (command === 'context') { console.log(JSON.stringify(buildReviewContext(project,{itemId:v.id,promptId:v.prompt}),null,2)); return; }
  if (command === 'show') { console.log(toMarkdown(project)); return; }
  if (command === 'export') { writeFileSync(need('output'), toMarkdown(project), { encoding: 'utf8', flag: 'wx' }); console.log('已导出'); return; }
  const id = need('id'); getItem(project, id);
  let next;
  if (command === 'update') {
    const patch = {};
    if (v['response-file']) patch.response = readFileSync(v['response-file'], 'utf8').replace(/^\uFEFF/, '').trim();
    for (const key of ['location', 'strategy']) if (v[key]) patch[key] = v[key];
    if (v.categories) patch.categories = v.categories.split(',').map(x => x.trim());
    if (!Object.keys(patch).length) throw new Error('未指定修改内容');
    next = updateItem(project, id, patch);
  }
  if (command === 'evidence') next = addEvidence(project, id, need('source'), readFileSync(need('excerpt-file'), 'utf8').replace(/^\uFEFF/, '').trim());
  if (command === 'complete') next = updateItem(project, id, { status: 'done', verification: need('verification') });
  if (command === 'reopen') next = updateItem(project, id, { status: 'draft', verification: '' });
  if (command === 'draft') {
    if (!v['send-to-model']) throw new Error('draft 会向配置的服务发送意见和证据；请显式添加 --send-to-model');
    next = recordProposal(project, id, await generateProposal(getItem(project, id)));
  }
  const saved = saveProject(path, next);
  console.log(`已保存 ${id}，版本 ${saved.revision}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
