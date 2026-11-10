#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateConfig, runRadar, parseDoiList, reportMarkdown, nextRunDelay } from './src/radar.js';
import { loadState, withStateLock, publishResult } from './src/store.js';

const HELP = `literature-radar <run|watch|export> --config config.json --state state.json --reports reports/
run：抓取一轮。watch：按持久状态定时运行，进程关闭后停止。
可选 --zotero-dois DOI文本文件 --send-to-model；run 可选 --date YYYY-MM-DD 补抓历史窗口。
watch 可选 --interval-seconds 86400 --retry-seconds 300；最小 60 秒。
export --input report.json --output report.md：从原始报告重新导出，不读取配置。
模型模式显式发送题名、摘要与研究方向；本地关键词模式不调用模型。`;
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: 'string' }, state: { type: 'string' }, reports: { type: 'string' }, date: { type: 'string' }, 'zotero-dois': { type: 'string' }, 'send-to-model': { type: 'boolean' }, 'interval-seconds': { type: 'string' }, 'retry-seconds': { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (v.help || !positionals.length) { console.log(HELP); return; }
  const need = key => { if (!v[key]?.trim()) throw new Error(`缺少 --${key}`); return v[key]; };
  if (positionals.length !== 1 || !['run', 'watch', 'export'].includes(positionals[0])) throw new Error('需要 run、watch 或 export 子命令');
  if (positionals[0] === 'export') { const report = readJson(need('input')); if (report.schemaVersion !== 1 || !Array.isArray(report.papers)) throw new Error('报告结构无效'); writeFileSync(need('output'), reportMarkdown(report), { encoding: 'utf8', flag: 'wx' }); return; }
  const config = validateConfig(readJson(need('config'))), statePath = need('state'), reportDir = need('reports');
  if (positionals[0] === 'watch' && v.date) throw new Error('watch 不允许固定历史日期；请用 run 补抓');
  const options = { date: v.date, sendToModel: v['send-to-model'], zotero: v['zotero-dois'] ? parseDoiList(readFileSync(v['zotero-dois'], 'utf8')) : new Set() };
  if (config.mode === 'model' && !options.sendToModel) throw new Error('模型模式需显式指定 --send-to-model');
  const execute = async () => withStateLock(statePath, async () => {
    const result = await runRadar(config, loadState(statePath, config), options);
    const paths = publishResult(statePath, reportDir, result);
    console.log(JSON.stringify({ complete: result.report.complete, errors: result.report.errors.length, papers: result.report.papers.length, ...paths }));
    return result.report;
  });
  if (positionals[0] === 'run') { const report = await execute(); if (!report.complete) process.exitCode = 1; return; }
  const interval = Number(v['interval-seconds'] ?? 86400), retry = Number(v['retry-seconds'] ?? 300);
  if (![interval, retry].every(n => Number.isInteger(n) && n >= 60 && n <= 31 * 86400)) throw new Error('定时间隔需为 60 秒至 31 天的整数');
  let stopping = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      const state = loadState(statePath, config);
      const delay = nextRunDelay(state, interval, retry);
      if (delay) await new Promise(resolve => { const timer = setTimeout(resolve, Math.min(delay, 60000)); wake = () => { clearTimeout(timer); resolve(); }; });
      if (stopping) break;
      if (delay > 60000) continue;
      try { await execute(); } catch (error) { console.error(error.message); await new Promise(resolve => { const timer = setTimeout(resolve, 60000); wake = () => { clearTimeout(timer); resolve(); }; }); }
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
