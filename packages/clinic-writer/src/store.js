import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateProject } from './writer.js';

export const loadProject = path => validateProject(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')));
export function saveProject(path, project, { create = false } = {}) {
  validateProject(project); mkdirSync(dirname(path), { recursive: true }); let fd;
  try { fd = openSync(`${path}.lock`, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('写作项目已锁定；请确认没有写入进程后再处理遗留锁'); throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    let previous;
    try { previous = loadProject(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (create && previous) throw new Error('项目已存在，拒绝覆盖');
    if (!create && !previous) throw new Error('项目不存在，拒绝静默重建');
    if (previous && (previous.id !== project.id || previous.revision !== project.revision)) throw new Error('项目版本已改变，请重新加载后重试');
    const next = structuredClone(project); next.revision++;
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); renameSync(temp, path); return next;
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    closeSync(fd); unlinkSync(`${path}.lock`);
  }
}
