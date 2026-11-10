import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CATEGORIES = ['method', 'experiment', 'format', 'clarification'];
export const STRATEGIES = ['add-evidence', 'existing-evidence', 'acknowledge-revise'];
const rules = {
  method: /统计|方法|混杂|偏倚|样本量|多重比较|statistic|method|confound|bias|sample size|multiple compar/iu,
  experiment: /补充.*实验|新增.*实验|验证集|外部验证|消融|additional experiment|new experiment|ablation|external valid|validation cohort/iu,
  format: /格式|拼写|缩写|标点|图注|参考文献格式|format|typo|spelling|abbreviation|punctuation|figure legend/iu,
  clarification: /澄清|解释|不清楚|含义|误解|clarif|unclear|explain|misunderstand/iu,
};
const now = () => new Date().toISOString();
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须为非空文本`);
  return value.trim();
}
export function classify(text) {
  const categories = CATEGORIES.filter(key => rules[key].test(text));
  return categories.length ? categories : ['clarification'];
}

// Split only explicit review/comment headings; paragraphs within a comment remain intact.
export function parseComments(input) {
  nonempty(input, '审稿意见');
  let reviewer = 'Editor', current = null;
  const comments = [];
  const flush = () => {
    if (current?.lines.join('\n').trim()) comments.push({ reviewer: current.reviewer, text: current.lines.join('\n').trim() });
    current = null;
  };
  for (const line of input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^\s*(?:#{1,6}\s*)?(Reviewer\s*\d+|审稿人\s*[一二三四五六七八九十\d]+|Editor|编辑)\s*[:：]?\s*$/iu);
    if (heading) { flush(); reviewer = heading[1]; continue; }
    const comment = line.match(/^\s*(?:#{1,6}\s*)?(?:(?:Comment|意见|问题)\s*\d+\s*[:：.)、]|\d+[.)、])\s*(.*)$/iu);
    if (comment) { flush(); current = { reviewer, lines: [comment[1]] }; }
    else {
      if (!current && line.trim()) current = { reviewer, lines: [] };
      if (current) current.lines.push(line);
    }
  }
  flush();
  if (!comments.length) throw new Error('没有可导入的意见正文');
  return comments;
}

export function createProject(title, input) {
  return {
    schemaVersion: 1, id: randomUUID(), title: nonempty(title, '项目名称'), revision: 0,
    createdAt: now(), updatedAt: now(),
    items: parseComments(input).map((comment, i) => {
      const categories = classify(comment.text);
      return {
        id: `R${String(i + 1).padStart(3, '0')}`, ...comment, categories,
        strategy: categories.includes('experiment') ? 'add-evidence' : 'acknowledge-revise',
        status: 'todo', response: '', location: '', verification: '', evidence: [],
        proposal: null, history: [],
      };
    }),
  };
}

export function validateProject(project) {
  if (!project || project.schemaVersion !== 1 || !Array.isArray(project.items) || !Number.isInteger(project.revision) || project.revision < 0) throw new Error('不支持或损坏的项目文件');
  nonempty(project.title, '项目名称');
  const ids = new Set();
  for (const item of project.items) {
    if (!item.id || ids.has(item.id)) throw new Error('意见 ID 缺失或重复');
    ids.add(item.id);
    nonempty(item.text, '意见正文');
    if (!Array.isArray(item.categories) || !item.categories.length || item.categories.some(c => !CATEGORIES.includes(c))) throw new Error('意见分类无效');
    if (!STRATEGIES.includes(item.strategy) || !['todo', 'draft', 'done'].includes(item.status)) throw new Error('意见策略或状态无效');
    for (const field of ['reviewer', 'response', 'location', 'verification']) if (typeof item[field] !== 'string') throw new Error(`字段 ${field} 无效`);
    if (!Array.isArray(item.evidence) || !Array.isArray(item.history)) throw new Error('证据或历史记录无效');
    const evidenceIds = new Set();
    for (const evidence of item.evidence) {
      for (const field of ['id', 'source', 'excerpt']) nonempty(evidence[field], `证据 ${field}`);
      if (evidenceIds.has(evidence.id)) throw new Error('证据 ID 重复');
      evidenceIds.add(evidence.id);
    }
    if (item.status === 'done') assertCompletable(item);
  }
  return project;
}
export function getItem(project, id) {
  const item = project.items.find(i => i.id === id);
  if (!item) throw new Error(`不存在意见 ${id}`);
  return item;
}
export function assertCompletable(item) {
  nonempty(item.response, '回应正文'); nonempty(item.location, '修改位置或不修改的说明');
  nonempty(item.verification, '人工核对说明');
  if (/\{\{|\[待|待补|TODO|TBD/iu.test(item.response + item.location)) throw new Error('仍有未填写的占位内容');
  if ((item.categories.includes('experiment') || item.strategy === 'existing-evidence' || item.strategy === 'add-evidence') && !item.evidence.length) throw new Error('该意见完成前必须添加证据');
}
export function updateItem(project, id, patch, actor = 'user') {
  const next = structuredClone(validateProject(project));
  const item = getItem(next, id);
  const allowed = ['categories', 'strategy', 'response', 'location', 'verification', 'status'];
  for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new Error(`不允许修改字段 ${key}`);
  const changesContent = Object.keys(patch).some(k => k !== 'status' && JSON.stringify(patch[k]) !== JSON.stringify(item[k]));
  Object.assign(item, patch);
  if (changesContent) {
    item.status = 'draft';
    if (!Object.hasOwn(patch, 'verification')) item.verification = '';
  }
  if (patch.status === 'done') { assertCompletable(item); item.status = 'done'; }
  item.history.push({ at: now(), actor, action: 'update', fields: Object.keys(patch) });
  next.updatedAt = now();
  return validateProject(next);
}
export function addEvidence(project, id, source, excerpt) {
  const next = structuredClone(validateProject(project));
  const item = getItem(next, id);
  item.evidence.push({ id: randomUUID(), source: nonempty(source, '证据来源'), excerpt: nonempty(excerpt, '证据摘录'), addedAt: now() });
  item.status = 'draft'; item.verification = '';
  item.history.push({ at: now(), actor: 'user', action: 'add-evidence' });
  next.updatedAt = now();
  return next;
}
export function recordProposal(project, id, proposal) {
  const next = structuredClone(validateProject(project));
  const item = getItem(next, id);
  item.proposal = proposal;
  item.history.push({ at: now(), actor: 'model', action: 'propose' });
  next.updatedAt = now();
  return next;
}

const safe = text => String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
export function toMarkdown(project) {
  validateProject(project);
  const done = project.items.filter(i => i.status === 'done').length;
  const lines = [`# ${safe(project.title)}`, '', `版本：${project.revision}；人工确认完成：${done}/${project.items.length}。`, '', '自动分类、策略和模型草稿均需使用者核查；证据摘录由使用者提供，工具不验证实验是否真实完成。', '', '| ID | 审稿人 | 类别 | 策略 | 状态 |', '| :-- | :-- | :-- | :-- | :-- |'];
  for (const item of project.items) lines.push(`| ${item.id} | ${safe(item.reviewer)} | ${item.categories.join(', ')} | ${item.strategy} | ${item.status} |`);
  for (const item of project.items) {
    lines.push('', `## ${item.id}`, '', '**原始意见**', '', safe(item.text), '', '**回应正文**', '', safe(item.response || '待填写'), '', '**修改位置**', '', safe(item.location || '待填写'), '', '**人工核对**', '', safe(item.verification || '未核对'), '', '**证据**', '');
    for (const e of item.evidence) lines.push(`${safe(e.id)} · ${safe(e.source)}`, '', safe(e.excerpt), '');
    if (!item.evidence.length) lines.push('未提供');
    if (item.proposal) lines.push('', '**模型建议（未自动接受）**', '', safe(JSON.stringify(item.proposal, null, 2)));
  }
  return lines.join('\n') + '\n';
}

export function loadProject(path) { return validateProject(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))); }
export function saveProject(path, project, { create = false } = {}) {
  validateProject(project);
  mkdirSync(dirname(path), { recursive: true });
  // Fail closed on a live or abandoned lock; never guess that another writer is dead.
  const lock = `${path}.lock`;
  let fd;
  try { fd = openSync(lock, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw new Error('项目正被其他进程写入；若锁已遗留，请确认没有写入进程后手动移除 .lock'); throw e; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    let exists = true, previous;
    try { previous = loadProject(path); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
    if (create && exists) throw new Error('项目已存在，拒绝覆盖');
    if (!create && !exists) throw new Error('项目已不存在，拒绝重建');
    if (exists && (previous.id !== project.id || previous.revision !== project.revision)) throw new Error('项目已被修改，请重新加载后重试');
    const saved = structuredClone(project); saved.revision++;
    writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    return saved;
  } finally {
    try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    closeSync(fd); unlinkSync(lock);
  }
}
