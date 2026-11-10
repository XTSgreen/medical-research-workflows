#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { extractPdf } from './src/pdf.js';
import { localCard, validateCard, validateOutline, cardMarkdown } from './src/autopsy.js';
import { analyzeWithModel } from './src/model.js';
import { verifyReference, createCrossrefRequest } from './src/references.js';

const HELP = `paper-autopsy analyze --pdf FILE --output NEW_DIRECTORY [--mode local|model]
可选 --pages 1-5,8 --allow-partial --outline outline.json --direction TEXT
模型需 --send-to-model 及 RESEARCH_MODEL_* 环境配置。
可选 --verify-references：向Crossref发送所提取书目信息并核验元数据。
paper-autopsy verify --input card.json --output NEW_DIRECTORY [--email CONTACT]
paper-autopsy export --input card.json --output NEW_FILE.md

本地模式输出原文线索，不冒充模型深度精读。扫描页需要先OCR。
输出目录必须不存在，包含card.json与reading-card.md。`;
export function parsePageSelection(value) {
  if (!value || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(value)) throw new Error('页码格式应为1-5,8');
  const pages = [];
  for (const part of value.split(',')) {
    const [start, end = start] = part.split('-').map(Number);
    if (start < 1 || end < start || end > 500) throw new Error('页码范围需在1至500内且递增');
    for (let p = start; p <= end; p++) pages.push(p);
  }
  if (new Set(pages).size !== pages.length) throw new Error('页码范围重复');
  return pages;
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
function saveBundle(path, card) {
  validateCard(card);
  const target = resolve(path); mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target); // exclusive: never overwrite a prior reading record
  writeFileSync(join(target, 'card.json'), JSON.stringify(card, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  writeFileSync(join(target, 'reading-card.md'), cardMarkdown(card), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: target, evidence: card.evidence.length, references: card.references.length, readScope: card.readScope, status: card.status }));
}
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(['pdf', 'input', 'output', 'mode', 'pages', 'outline', 'direction', 'email'].map(k => [k, { type: 'string' }]).concat(['help', 'allow-partial', 'send-to-model', 'verify-references'].map(k => [k, { type: 'boolean' }]))) });
  if (!positionals.length || v.help) { console.log(HELP); return; }
  if (positionals.length !== 1 || !['analyze', 'verify', 'export'].includes(positionals[0])) throw new Error('需要analyze、verify或export子命令');
  const need = key => { if (!v[key]?.trim()) throw new Error(`缺少 --${key}`); return v[key]; };
  const command = positionals[0], output = need('output');
  if (existsSync(output)) throw new Error('目标已存在，拒绝覆盖；请选择新目录或新文件');
  let card;
  if (command === 'analyze') {
    const mode = v.mode ?? 'local'; if (!['local', 'model'].includes(mode)) throw new Error('mode需为local或model');
    if (mode === 'model' && !v['send-to-model']) throw new Error('模型模式需要显式 --send-to-model');
    const document = await extractPdf(need('pdf'), { selectedPages: v.pages ? parsePageSelection(v.pages) : undefined, allowPartial: v['allow-partial'] });
    const outline = v.outline ? validateOutline(readJson(v.outline)) : [];
    card = mode === 'local' ? localCard(document, outline) : await analyzeWithModel(document, { outline, direction: v.direction ?? '', sendToModel: v['send-to-model'] });
  } else card = validateCard(readJson(need('input')));
  if (command === 'export') { writeFileSync(output, cardMarkdown(card), { encoding: 'utf8', flag: 'wx' }); return; }
  if (command === 'verify' || v['verify-references']) {
    const request = createCrossrefRequest();
    card = structuredClone(card);
    for (let i = 0; i < card.references.length; i++) card.references[i] = await verifyReference(card.references[i], { request, email: v.email });
    card.referenceCheckAt = new Date().toISOString();
  }
  saveBundle(output, card);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
