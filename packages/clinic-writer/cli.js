#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createProject, addSource, sourceFromX2, sourceFromRecords, evidenceBank, draftSection, confirmSection, setJournal, manuscriptMarkdown } from './src/writer.js';
import { loadProject, saveProject } from './src/store.js';
import { modelSection } from './src/model.js';

const HELP = `clinic-writer <command> --project FILE [options]
init --title TEXT --outline outline.json
import-card --input X2-card.json
import-records --input records.json
sources：列出可引用的原文证据ID。
draft --section ID --input proposal.json：保存人工准备的单元草稿。
generate --section ID --send-to-model：用所配模型起草一节。
journal --input journal.json：设置有原文出处的期刊规则。
adapt --section ID --send-to-model：按期刊规则修改已有单元文本。
confirm --section ID --reviewer NAME --note TEXT：作者逐项核对后确认。
show：输出当前草稿和来源清单。
export --output NEW.md：导出并拒绝覆盖。

模型使用RESEARCH_MODEL_BASE_URL、RESEARCH_MODEL_API_KEY、RESEARCH_MODEL。
无来源内容保留待补标记，模型草稿不能直接成为人工确认。`;
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(['project', 'title', 'outline', 'input', 'output', 'section', 'reviewer', 'note'].map(k => [k, { type: 'string' }]).concat([['help', { type: 'boolean' }], ['send-to-model', { type: 'boolean' }]])) });
  if (v.help || !positionals.length) { console.log(HELP); return; }
  const commands = ['init', 'import-card', 'import-records', 'sources', 'draft', 'generate', 'journal', 'adapt', 'confirm', 'show', 'export'];
  if (positionals.length !== 1 || !commands.includes(positionals[0])) throw new Error('未知写作子命令');
  const need = key => { if (!v[key]?.trim()) throw new Error(`缺少 --${key}`); return v[key]; };
  const path = need('project'), command = positionals[0];
  if (command === 'init') { const saved = saveProject(path, createProject(need('title'), readJson(need('outline'))), { create: true }); console.log(`已建立${saved.sections.length}节写作项目`); return; }
  const project = loadProject(path);
  if (command === 'sources') { console.log(JSON.stringify(evidenceBank(project), null, 2)); return; }
  if (command === 'show') { console.log(manuscriptMarkdown(project)); return; }
  if (command === 'export') { writeFileSync(need('output'), manuscriptMarkdown(project), { encoding: 'utf8', flag: 'wx' }); console.log('已导出草稿与逐项来源'); return; }
  let next;
  if (command === 'import-card') next = addSource(project, sourceFromX2(readJson(need('input'))));
  if (command === 'import-records') next = addSource(project, sourceFromRecords(readFileSync(need('input'), 'utf8')));
  if (command === 'draft') next = draftSection(project, need('section'), readJson(need('input')));
  if (command === 'journal') next = setJournal(project, readJson(need('input')));
  if (command === 'confirm') next = confirmSection(project, need('section'), need('reviewer'), need('note'));
  if (command === 'generate' || command === 'adapt') next = await modelSection(project, need('section'), { adapt: command === 'adapt', sendToModel: v['send-to-model'] });
  const saved = saveProject(path, next); console.log(`已保存，版本${saved.revision}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
