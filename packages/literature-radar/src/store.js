import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, validateState, reportMarkdown } from './radar.js';

export function loadState(path, config) {
  try { return validateState(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')), config); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(config); throw error; }
}
export function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export async function withStateLock(path, operation) {
  mkdirSync(dirname(path), { recursive: true }); let fd;
  try { fd = openSync(`${path}.lock`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('状态文件已锁定；确认没有运行进程后再处理遗留 .lock'); throw error; }
  try { return await operation(); } finally { closeSync(fd); unlinkSync(`${path}.lock`); }
}
export function publishResult(statePath, reportDir, result) {
  const stem = `${result.report.to}-${result.report.id}`;
  mkdirSync(reportDir, { recursive: true });
  // Both recoverable reports are committed before consuming IDs in state.
  const jsonPath = join(reportDir, `${stem}.json`), markdownPath = join(reportDir, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(result.report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  writeFileSync(markdownPath, reportMarkdown(result.report), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  atomicWrite(statePath, JSON.stringify(result.nextState, null, 2) + '\n');
  return { jsonPath, markdownPath };
}
