import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.js';
import { loadProject } from '../src/store.js';
import { evidenceBank } from '../src/writer.js';

const { values } = parseArgs({ options: { output: { type: 'string' }, card: { type: 'string' } } });
if (!values.output) throw new Error('需要 --output 新目录；可选 --card X2-card.json');
const output = resolve(values.output); mkdirSync(output, { recursive: false });
const data = filename => fileURLToPath(new URL(filename, import.meta.url));
const path = join(output, 'project.json');
await main(['init', '--project', path, '--title', '原创虚构教学草稿，不是真实研究', '--outline', data('outline.json')]);
await main(['import-records', '--project', path, '--input', data('study-records.json')]);
if (values.card) await main(['import-card', '--project', path, '--input', values.card]);
const bank = evidenceBank(loadProject(path));
const from = id => bank.find(e => e.sourceKind === 'study-record' && e.originalId === id);
const unit = id => ({ kind: 'fact', text: from(id).quote, support: [{ evidenceId: from(id).id, quote: from(id).quote }] });
const methods = join(output, 'methods-proposal.json'), results = join(output, 'results-proposal.json');
writeFileSync(methods, JSON.stringify({ units: [unit('sample'), { kind: 'missing', text: '[待补：仅供教学，未提供伦理批准信息]', support: [] }] }, null, 2));
writeFileSync(results, JSON.stringify({ units: [unit('result')] }, null, 2));
await main(['draft', '--project', path, '--section', 'methods', '--input', methods]);
await main(['draft', '--project', path, '--section', 'results', '--input', results]);
await main(['journal', '--project', path, '--input', data('journal-plosone-subset.json')]);
let blocked = false;
try { await main(['confirm', '--project', path, '--section', 'methods', '--reviewer', '教学检查', '--note', '演示无来源必须保持待补']); }
catch (error) { blocked = true; console.log(`预期拦截：${error.message}`); }
if (!blocked) throw new Error('无来源章节未被拦截');
await main(['confirm', '--project', path, '--section', 'results', '--reviewer', '教学检查', '--note', '逐字核对虚构记录与排版，未验证真实研究']);
await main(['export', '--project', path, '--output', join(output, 'draft.md')]);
console.log(JSON.stringify({ mode: 'teaching-no-model', output, missingSourceConfirmationBlocked: blocked }));
