import { createHash, randomUUID } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const norm = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
const nonempty = value => typeof value === 'string' && !!value.trim();
const iso = () => new Date().toISOString();
export function createProject(title, outline) {
  if (!nonempty(title) || !Array.isArray(outline) || !outline.length || outline.some(s => !s || !/^[A-Za-z0-9_-]+$/u.test(s.id) || !nonempty(s.title) || !nonempty(s.requirements)) || new Set(outline.map(s => s.id)).size !== outline.length) throw new Error('需提供题名及唯一id、title、requirements组成的大纲');
  return { schemaVersion: 1, id: randomUUID(), revision: 0, title: title.trim(), createdAt: iso(), updatedAt: iso(), sources: [], journal: null, sections: outline.map(s => ({ ...s, status: 'todo', units: [], verification: null, history: [] })) };
}
function evidenceKey(documentId, evidenceId) { return `${documentId}:${evidenceId}`; }
export function sourceFromX2(card) {
  if (card?.schemaVersion !== 1 || !/^PDF-[a-f0-9]{16}$/u.test(card.documentId) || !/^[a-f0-9]{64}$/u.test(card.sourceFileHash) || card.documentId !== `PDF-${card.sourceFileHash.slice(0, 16)}` || !Array.isArray(card.pages) || !card.pages.length || !Array.isArray(card.evidence)) throw new Error('X2卡片结构无效');
  if (!['excerpt', 'all-extracted-pages'].includes(card.readScope) || !Array.isArray(card.excludedPages)) throw new Error('X2阅读覆盖信息无效');
  const seenPages = new Set();
  for (const page of card.pages) {
    if (!Number.isInteger(page.page) || page.page < 1 || seenPages.has(page.page) || typeof page.text !== 'string' || page.textHash !== hash(page.text)) throw new Error('X2页码或页面文本哈希无效');
    seenPages.add(page.page);
  }
  const ids = new Set();
  const evidence = card.evidence.map(e => {
    const page = card.pages.find(p => p.page === e.page && !p.needsReview);
    if (!nonempty(e.quote) || !page || !norm(page.text).includes(norm(e.quote)) || e.id !== `E-${hash(`${card.sourceFileHash}:${e.page}:${norm(e.quote)}`).slice(0, 20)}` || ids.has(e.id)) throw new Error('X2证据不对应原始可读页面');
    ids.add(e.id);
    return { id: evidenceKey(card.documentId, e.id), originalId: e.id, quote: e.quote, locator: `PDF p.${e.page}`, page: e.page };
  });
  if (!evidence.length) throw new Error('X2卡片没有可引用证据，请先完成可追溯提取');
  return { id: card.documentId, kind: 'paper', title: card.title, sourceFileHash: card.sourceFileHash, readScope: card.readScope, excludedPages: card.excludedPages, identifiers: card.identifiers ?? {}, evidence, snapshot: structuredClone(card), snapshotHash: hash(JSON.stringify(card)) };
}
export function sourceFromRecords(text) {
  let data; try { data = JSON.parse(text.replace(/^\uFEFF/u, '')); } catch { throw new Error('自有记录不是有效JSON'); }
  if (data?.schemaVersion !== 1 || !nonempty(data.title) || !Array.isArray(data.records) || !data.records.length || data.records.some(r => !r || !/^[A-Za-z0-9_-]+$/u.test(r.id) || !nonempty(r.text)) || new Set(data.records.map(r => r.id)).size !== data.records.length) throw new Error('自有记录需为schemaVersion:1、title、含唯一id与text的records数组');
  const fileHash = hash(text), id = `STUDY-${fileHash.slice(0, 16)}`;
  return { id, kind: 'study-record', title: data.title, sourceFileHash: fileHash, readScope: 'provided-records', excludedPages: [], identifiers: {}, evidence: data.records.map(r => ({ id: evidenceKey(id, r.id), originalId: r.id, quote: r.text, locator: `record:${r.id}`, page: null })), snapshot: text, snapshotHash: fileHash };
}
function validateSource(source) {
  if (!source || !['paper', 'study-record'].includes(source.kind) || !nonempty(source.title) || !/^[a-f0-9]{64}$/u.test(source.sourceFileHash) || !Array.isArray(source.evidence) || !source.evidence.length) throw new Error('资料源结构无效');
  if (source.kind === 'paper') {
    if (source.snapshotHash !== hash(JSON.stringify(source.snapshot))) throw new Error('X2源快照已改变');
    const expected = sourceFromX2(source.snapshot);
    if (JSON.stringify(expected) !== JSON.stringify(source)) throw new Error('X2导入字段与源快照不一致');
  } else {
    const expected = sourceFromRecords(source.snapshot);
    if (JSON.stringify(expected) !== JSON.stringify(source)) throw new Error('自有记录与源快照不一致');
  }
}
export function addSource(project, source) {
  validateProject(project); validateSource(source);
  if (project.sources.some(s => s.id === source.id)) throw new Error('相同文献版本或记录已导入，拒绝重复');
  const next = structuredClone(project); next.sources.push(source); next.updatedAt = iso(); return next;
}
export function evidenceBank(project) { return project.sources.flatMap(source => source.evidence.map(e => ({ ...e, sourceId: source.id, sourceTitle: source.title, sourceKind: source.kind, sourceFileHash: source.sourceFileHash, readScope: source.readScope }))); }
export function getSection(project, id) { const s = project.sections.find(s => s.id === id); if (!s) throw new Error(`不存在章节 ${id}`); return s; }
function numericTokens(value) { return [...new Set((value.match(/(?<![\p{L}\p{N}])[-+−]?\d+(?:[.,]\d+)*(?:%|‰)?/gu) ?? []).map(n => n.replace(/,/gu, '').replace(/−/gu, '-')))]; }
function doiTokens(value) { return [...new Set((value.match(/10\.\d{4,9}\/[^\s<>\[\]]+/giu) ?? []).map(d => d.toLowerCase().replace(/[.,;]+$/u, '')))]; }
export function normalizeUnits(project, sectionId, units) {
  if (!Array.isArray(units) || !units.length || units.length > 300) throw new Error('章节草稿需含1至300个事实或解释单元');
  const bank = new Map(evidenceBank(project).map(e => [e.id, e]));
  const knownDois = new Set(project.sources.flatMap(s => [...doiTokens(s.evidence.map(e => e.quote).join('\n')), ...(s.identifiers?.dois ?? []).map(d => d.toLowerCase())]));
  return units.map((unit, i) => {
    if (!unit || !['fact', 'interpretation', 'missing'].includes(unit.kind) || !nonempty(unit.text) || !Array.isArray(unit.support)) throw new Error('单元需有kind、text及support数组');
    if (Object.keys(unit).some(k => !['id', 'kind', 'text', 'support'].includes(k))) throw new Error('单元包含未知字段');
    if (doiTokens(unit.text).some(d => !knownDois.has(d))) throw new Error('草稿包含资料库中不存在的DOI');
    const support = unit.support.map(item => {
      const e = bank.get(item?.evidenceId);
      if (!e || !nonempty(item.quote) || norm(item.quote).length < 8 || !norm(e.quote).includes(norm(item.quote))) throw new Error('支持片段或证据ID不在已导入资料中');
      return { evidenceId: e.id, quote: norm(item.quote), sourceId: e.sourceId, sourceFileHash: e.sourceFileHash, locator: e.locator };
    });
    const warnings = [];
    if (!support.length || unit.kind === 'missing') warnings.push('待补来源');
    if (support.length && numericTokens(unit.text).some(token => !numericTokens(support.map(s => s.quote).join(' ')).includes(token))) warnings.push('正文数字未在所列支持片段中找到，需核对或补证据');
    if (/\{\{|\[待|TODO|TBD/iu.test(unit.text)) warnings.push('仍有占位内容');
    return { id: `${sectionId}-C${String(i + 1).padStart(3, '0')}`, kind: unit.kind, text: unit.text.trim(), support, sourceStatus: support.length && unit.kind !== 'missing' ? 'linked-unverified' : 'missing', warnings };
  });
}
export function draftSection(project, sectionId, proposal, actor = 'user') {
  validateProject(project);
  if (!proposal || Object.keys(proposal).some(key => key !== 'units')) throw new Error('草稿对象只允许units字段，正文从单元生成');
  const units = normalizeUnits(project, sectionId, proposal.units), next = structuredClone(project), section = getSection(next, sectionId);
  section.history.push({ at: iso(), actor, action: 'draft', previousUnits: structuredClone(section.units), previousVerification: section.verification });
  section.units = units; section.status = 'draft'; section.verification = null; next.updatedAt = iso();
  return invalidateChangedRenderings(next);
}
export function confirmSection(project, sectionId, reviewer, note) {
  validateProject(project); const next = structuredClone(project), section = getSection(next, sectionId);
  if (!nonempty(reviewer) || !nonempty(note)) throw new Error('确认需要核对者与具体核对说明');
  if (!section.units.length || section.units.some(u => u.sourceStatus === 'missing' || u.warnings.length)) throw new Error('存在无来源、数字待查或占位内容，不能确认完成');
  const styled = styleTexts(next);
  section.status = 'checked'; section.verification = { reviewer, note, at: iso(), unitsHash: hash(JSON.stringify(section.units)), journalHash: next.journal ? hash(JSON.stringify(next.journal)) : null, renderedText: section.units.map(u => styled.get(u.id)) };
  section.history.push({ at: iso(), actor: reviewer, action: 'confirm', note }); next.updatedAt = iso(); return next;
}
export function validateJournal(profile) {
  if (!profile || !nonempty(profile.name) || !nonempty(profile.sourceText) || !nonempty(profile.retrievedAt) || !Number.isFinite(Date.parse(profile.retrievedAt))) throw new Error('期刊规则需要name、sourceText、retrievedAt');
  const url = new URL(profile.url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('期刊指南需为不含凭据的HTTPS官方URL');
  if (!Array.isArray(profile.rules) || !profile.rules.length) throw new Error('期刊规则不能为空');
  const ids = new Set();
  for (const r of profile.rules) {
    if (!nonempty(r.id) || ids.has(r.id) || !['tense', 'abbreviation', 'figure-label', 'table-label'].includes(r.type) || !nonempty(r.quote) || !norm(profile.sourceText).includes(norm(r.quote))) throw new Error('期刊规则缺少唯一ID或可定位原文'); ids.add(r.id);
    if (r.type === 'tense' && !['past', 'present', 'mixed'].includes(r.value)) throw new Error('时态规则无效');
    if (r.type === 'figure-label' && !['Figure', 'Fig.', 'Fig'].includes(r.value) || r.type === 'table-label' && !['Table', 'Tab.', 'Tab'].includes(r.value)) throw new Error('图表称谓无效');
    if (r.type === 'abbreviation' && (!/^[A-Za-z][A-Za-z0-9-]{1,15}$/u.test(r.short) || !nonempty(r.long))) throw new Error('缩写规则需有short与long');
  }
  if (['tense', 'figure-label', 'table-label'].some(type => profile.rules.filter(r => r.type === type).length > 1) || new Set(profile.rules.filter(r => r.type === 'abbreviation').map(r => r.short)).size !== profile.rules.filter(r => r.type === 'abbreviation').length) throw new Error('期刊规则互相冲突');
  return profile;
}
export function setJournal(project, profile) {
  validateProject(project); validateJournal(profile);
  const next = structuredClone(project); next.journal = structuredClone(profile);
  for (const section of next.sections) if (section.units.length) { section.history.push({ at: iso(), actor: 'user', action: 'journal-change', previousVerification: section.verification }); section.status = 'draft'; section.verification = null; }
  next.updatedAt = iso(); return next;
}
export function adaptSection(project, sectionId, proposal) {
  validateProject(project);
  if (!project.journal) throw new Error('先提供有来源的期刊规则');
  const section = getSection(project, sectionId);
  if (!section.units.length || !proposal || !Array.isArray(proposal.units) || proposal.units.length !== section.units.length) throw new Error('适配不得增加或删除单元');
  for (let i = 0; i < proposal.units.length; i++) {
    const u = proposal.units[i], old = section.units[i];
    if (u.id !== old.id || u.kind !== old.kind || JSON.stringify(u.support) !== JSON.stringify(old.support.map(({ evidenceId, quote }) => ({ evidenceId, quote })))) throw new Error('期刊适配不得改变单元ID、类别或证据');
    if (JSON.stringify(numericTokens(u.text).sort()) !== JSON.stringify(numericTokens(old.text).sort()) || JSON.stringify(doiTokens(u.text).sort()) !== JSON.stringify(doiTokens(old.text).sort())) throw new Error('期刊适配不得改变数字或DOI');
    if (/\b(?:may|might|could|possibly|potentially)\b|可能|尚不确定/iu.test(old.text) && !/\b(?:may|might|could|possibly|potentially)\b|可能|尚不确定/iu.test(u.text)) throw new Error('期刊适配移除了不确定性词语，需作者单独处理');
  }
  const next = draftSection(project, sectionId, { units: proposal.units }, 'model-style');
  getSection(next, sectionId).history.at(-1).action = 'journal-adapt'; return next;
}
export function validateProject(project) {
  if (project?.schemaVersion !== 1 || !nonempty(project.id) || !nonempty(project.title) || !Number.isInteger(project.revision) || project.revision < 0 || !Array.isArray(project.sources) || !Array.isArray(project.sections) || !project.sections.length) throw new Error('写作项目结构无效');
  const ids = new Set();
  for (const source of project.sources) { validateSource(source); if (ids.has(source.id)) throw new Error('资料源重复'); ids.add(source.id); }
  if (project.journal) validateJournal(project.journal);
  const sectionIds = new Set();
  for (const s of project.sections) {
    if (!nonempty(s.id) || sectionIds.has(s.id) || !nonempty(s.title) || !nonempty(s.requirements) || !['todo', 'draft', 'checked'].includes(s.status) || !Array.isArray(s.units) || !Array.isArray(s.history)) throw new Error('章节结构无效'); sectionIds.add(s.id);
    if (s.units.length) {
      const expected = normalizeUnits(project, s.id, s.units.map(({ id, kind, text, support }) => ({ id, kind, text, support: support.map(({ evidenceId, quote }) => ({ evidenceId, quote })) })));
      if (JSON.stringify(expected) !== JSON.stringify(s.units)) throw new Error('章节单元或来源映射已改变');
    }
    if (s.status === 'checked' && (!s.units.length || s.units.some(u => u.warnings.length || u.sourceStatus === 'missing') || !nonempty(s.verification?.reviewer) || !nonempty(s.verification?.note) || s.verification.unitsHash !== hash(JSON.stringify(s.units)) || s.verification.journalHash !== (project.journal ? hash(JSON.stringify(project.journal)) : null) || JSON.stringify(s.verification.renderedText) !== JSON.stringify(s.units.map(u => styleTexts(project).get(u.id))))) throw new Error('章节确认记录无效或已过期');
  }
  return project;
}
const escape = text => String(text ?? '').replace(/[&<>|`\[\]*_]/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '\\|' }[c] ?? `\\${c}`)).replace(/\r?\n/gu, '<br>');
const regexEscape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export function styleTexts(project) {
  const texts = new Map(), seen = new Set(), rules = project.journal?.rules ?? [];
  for (const s of project.sections) for (const unit of s.units) {
    let text = unit.text;
    for (const rule of rules) {
      if (rule.type === 'figure-label') text = text.replace(/\b(?:Figure|Fig\.?)\s*(\d+)\b/gu, (_all, n) => `${rule.value} ${n}`);
      if (rule.type === 'table-label') text = text.replace(/\b(?:Table|Tab\.?)\s*(\d+)\b/gu, (_all, n) => `${rule.value} ${n}`);
      if (rule.type === 'abbreviation') {
        const expansion = `${rule.long} (${rule.short})`;
        text = text.replace(new RegExp(`${regexEscape(expansion)}|\\b${regexEscape(rule.short)}\\b`, 'giu'), match => {
          if (match.toLowerCase() === expansion.toLowerCase()) { seen.add(rule.id); return match; }
          if (match !== rule.short) return match;
          if (seen.has(rule.id)) return match;
          seen.add(rule.id); return expansion;
        });
      }
    }
    texts.set(unit.id, text);
  }
  return texts;
}
function invalidateChangedRenderings(project) {
  const styled = styleTexts(project);
  for (const section of project.sections) if (section.status === 'checked' && JSON.stringify(section.verification.renderedText) !== JSON.stringify(section.units.map(u => styled.get(u.id)))) {
    section.history.push({ at: iso(), actor: 'system', action: 'render-change', previousVerification: section.verification });
    section.status = 'draft'; section.verification = null;
  }
  return project;
}
export function manuscriptMarkdown(project) {
  validateProject(project); const texts = styleTexts(project);
  const lines = [`# ${escape(project.title)}`, '', `版本：${project.revision}；性质：辅助草稿，采用前需逐条核对。`, '', '每个事实与解释单元均列出来源；有文本定位不代表语义支持已经核验，无来源处保留待补标记。', ''];
  if (project.journal) lines.push(`期刊：${escape(project.journal.name)}；指南：${project.journal.url}；获取日期：${escape(project.journal.retrievedAt)}。`, '', '缩写与图表称谓按规则排版；时态需显式执行adapt并人工复核。', '');
  for (const s of project.sections) {
    lines.push(`## ${escape(s.title)}`, '', `状态：${s.status}；要求：${escape(s.requirements)}`, '');
    if (!s.units.length) lines.push('[待撰写：尚无草稿单元]', '');
    for (const u of s.units) lines.push(`${u.sourceStatus === 'missing' ? '**[待补来源]** ' : ''}${escape(texts.get(u.id))} [${escape(u.id)}；${u.support.map(e => escape(e.evidenceId)).join(', ') || '无来源'}]`, '', ...(u.warnings.length ? [`待查：${u.warnings.map(escape).join('；')}`, ''] : []));
    lines.push('### 本节事实与解释的来源清单', '', '| 单元 | 类别 | 状态 | 原文支持片段 | 定位 |', '| :-- | :-- | :-- | :-- | :-- |');
    for (const u of s.units) lines.push(`| ${u.id} | ${u.kind} | ${s.status === 'checked' ? '作者已核对' : u.sourceStatus} | ${u.support.map(e => escape(e.quote)).join('<br>') || '待补'} | ${u.support.map(e => `${escape(e.sourceId)} · ${escape(e.locator)} · ${escape(e.sourceFileHash)}`).join('<br>') || '待补'} |`);
    if (s.verification) lines.push('', `核对者：${escape(s.verification.reviewer)}；${escape(s.verification.note)}`, '');
    lines.push('');
  }
  lines.push('## 资料版本', '');
  for (const source of project.sources) lines.push(`${escape(source.id)} · ${escape(source.title)} · ${source.kind} · ${source.readScope} · SHA-256 ${source.sourceFileHash}`, '');
  if (project.journal) {
    lines.push('## 期刊规则来源', '');
    for (const r of project.journal.rules) lines.push(`${escape(r.id)} · ${r.type}：${escape(r.quote)}`, '');
  }
  return lines.join('\n') + '\n';
}
