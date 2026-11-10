import { createHash } from 'node:crypto';
import { normalizeText } from './pdf.js';
import { extractReferenceCandidates, findDois, normalizeDoi } from './references.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const meaningful = value => typeof value === 'string' && value.trim().length > 0;
export function validateOutline(outline) {
  if (!Array.isArray(outline) || outline.some(s => !s || !meaningful(s.id) || !meaningful(s.title) || !Array.isArray(s.keywords) || s.keywords.some(k => !meaningful(k))) || new Set(outline.map(s => s.id)).size !== outline.length) throw new Error('大纲需为唯一id、title与keywords数组的章节列表');
  return outline;
}
function newCard(document, mode, outline) {
  if (document?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(document.sourceFileHash) || !Array.isArray(document.pages) || !document.pages.length) throw new Error('PDF提取记录无效');
  validateOutline(outline);
  return { schemaVersion: 1, documentId: document.documentId, sourceFileHash: document.sourceFileHash, title: document.title || document.pages.find(p => p.page === 1 && !p.needsReview)?.text.split('\n')[0] || '未识别题名（节选未含可读首页）', identifiers: { dois: findDois(document.pages.find(p => p.page === 1)?.text ?? '') }, createdAt: new Date().toISOString(), mode, status: 'unverified', readScope: document.readScope, pageCount: document.pageCount, excludedPages: document.excludedPages, pages: structuredClone(document.pages), warnings: [...document.warnings], claims: [], evidence: [], methods: [], reuse: [], limitations: [], references: extractReferenceCandidates(document), outline, outlinePlacement: [], missing: [] };
}
function evidenceFor(card, anchor) {
  if (!anchor || !Number.isInteger(anchor.page) || !meaningful(anchor.quote)) throw new Error('证据需要物理页码和原文摘录');
  const page = card.pages.find(p => p.page === anchor.page && !p.needsReview);
  const quote = normalizeText(anchor.quote);
  if (!page || quote.length < 8 || !normalizeText(page.text).includes(quote)) throw new Error('证据摘录不在对应可读物理页，或摘录过短');
  const id = `E-${hash(`${card.sourceFileHash}:${anchor.page}:${quote}`).slice(0, 20)}`;
  if (!card.evidence.some(e => e.id === id)) card.evidence.push({ id, page: anchor.page, quote });
  return id;
}
function grounded(card, value, index, prefix) {
  if (!value || !meaningful(value.text) || !Array.isArray(value.evidence) || !value.evidence.length) throw new Error('实质条目必须有文字及非空原文证据');
  return { id: `${prefix}${index + 1}`, text: value.text.trim(), evidenceIds: [...new Set(value.evidence.map(a => evidenceFor(card, a)))] };
}
export function cardFromProposal(document, proposal, outline = []) {
  const card = newCard(document, 'model', outline);
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('模型输出需为对象');
  const keys = ['title', 'claims', 'methods', 'reuse', 'limitations', 'references', 'outlinePlacement', 'missing'];
  if (Object.keys(proposal).some(key => !keys.includes(key))) throw new Error('模型输出含未知字段');
  for (const key of keys.filter(k => k !== 'title')) if (!Array.isArray(proposal[key])) throw new Error(`模型缺少数组 ${key}`);
  if (meaningful(proposal.title)) {
    if (!card.pages.some(p => normalizeText(p.text).includes(normalizeText(proposal.title)))) throw new Error('模型题名不在输入文本中');
    card.title = proposal.title;
  }
  card.claims = proposal.claims.map((v, i) => grounded(card, v, i, 'C'));
  card.reuse = proposal.reuse.map((v, i) => grounded(card, v, i, 'U'));
  card.limitations = proposal.limitations.map((v, i) => {
    if (!['author', 'reader-inference'].includes(v.kind)) throw new Error('局限需区分作者自述与读者推断');
    return { ...grounded(card, v, i, 'L'), kind: v.kind };
  });
  card.methods = proposal.methods.map((v, i) => {
    if (!['statistics', 'sample', 'reproducibility'].includes(v.aspect)) throw new Error('方法学aspect无效');
    return { ...grounded(card, v, i, 'M'), aspect: v.aspect };
  });
  card.missing = proposal.missing.map(s => { if (!meaningful(s)) throw new Error('缺项需为非空文字'); return s; });
  for (const aspect of ['statistics', 'sample', 'reproducibility']) if (!card.methods.some(m => m.aspect === aspect)) card.missing.push(`未形成可定位的${aspect}解析，请核对原文`);
  card.references = proposal.references.map((r, i) => {
    const item = grounded(card, { text: r.raw, evidence: r.evidence }, i, 'REF');
    if (!card.evidence.filter(e => item.evidenceIds.includes(e.id)).some(e => normalizeText(e.quote).includes(normalizeText(r.raw)))) throw new Error('引用原始书目必须出现在对应摘录内');
    for (const key of ['title', 'doi', 'author', 'year']) if (r[key] !== undefined && typeof r[key] !== 'string') throw new Error('书目字段需为文本');
    if (r.title && !normalizeText(r.raw).includes(normalizeText(r.title))) throw new Error('书目题名不在原始书目中');
    if (r.doi && (!normalizeDoi(r.doi) || !findDois(r.raw).includes(normalizeDoi(r.doi)))) throw new Error('书目 DOI 不在原文中');
    if (r.year && !r.raw.includes(r.year)) throw new Error('书目年份不在原文中');
    if (r.author && !normalizeText(r.raw).toLowerCase().includes(normalizeText(r.author).toLowerCase())) throw new Error('书目作者不在原文中');
    return { id: item.id, raw: r.raw, title: r.title ?? '', doi: normalizeDoi(r.doi), author: r.author ?? '', year: r.year ?? '', evidenceIds: item.evidenceIds, status: 'unresolved', note: '尚未联网核查' };
  });
  const omitted = extractReferenceCandidates(document).filter(candidate => !card.references.some(ref => normalizeText(ref.raw).includes(normalizeText(candidate.raw))));
  for (const [i, candidate] of omitted.entries()) card.references.push({ ...candidate, id: `AUTOREF${i + 1}`, note: '模型未覆盖的自动提取候选，需人工分条并核对字段' });
  if (omitted.length) card.missing.push(`保留了${omitted.length}条模型未完整覆盖的参考文献候选`);
  card.outlinePlacement = proposal.outlinePlacement.map((v, i) => {
    if (!outline.some(s => s.id === v.sectionId)) throw new Error('归位建议引用了不存在的章节ID');
    return { ...grounded(card, v, i, 'O'), sectionId: v.sectionId };
  });
  if (outline.length && !card.outlinePlacement.length) card.missing.push('未找到有证据支持的综述归位建议');
  return validateCard(card);
}
export function localCard(document, outline = []) {
  const card = newCard(document, 'local-extracts', outline);
  const lines = card.pages.filter(p => !p.needsReview).flatMap(p => p.text.split('\n').filter(line => normalizeText(line).length >= 20).map(line => ({ page: p.page, quote: normalizeText(line) })));
  const categories = [
    ['statistics', /regression|statistic|confidence interval|t-test|anova|统计|回归|置信区间/iu],
    ['sample', /\b(?:participants?|patients?|cohorts?|samples?)\b|受试者|样本|患者/iu],
    ['reproducibility', /code|data availab|preregist|github|代码|数据可用|预注册/iu],
  ];
  for (const [aspect, pattern] of categories) {
    const matches = lines.filter(line => pattern.test(line.quote)).slice(0, 3);
    for (const anchor of matches) card.methods.push({ id: `M${card.methods.length + 1}`, aspect, text: `原文线索，尚未作语义核验：${anchor.quote}`, evidenceIds: [evidenceFor(card, anchor)] });
    if (!matches.length) card.missing.push(`未按关键词定位到 ${aspect} 线索；不能据此断言论文未报告`);
  }
  for (const anchor of lines.filter(line => /\b(?:found|associated|results showed|we observed)\b|结果|关联/iu.test(line.quote)).slice(0, 5)) card.claims.push({ id: `C${card.claims.length + 1}`, text: `作者陈述候选，待核对上下文：${anchor.quote}`, evidenceIds: [evidenceFor(card, anchor)] });
  for (const anchor of lines.filter(line => /limitation|limited|局限|限制/iu.test(line.quote)).slice(0, 3)) card.limitations.push({ id: `L${card.limitations.length + 1}`, kind: 'author', text: `局限相关原文线索：${anchor.quote}`, evidenceIds: [evidenceFor(card, anchor)] });
  for (const section of outline) {
    const anchor = lines.find(line => section.keywords.some(word => line.quote.toLowerCase().includes(word.toLowerCase())));
    if (anchor) card.outlinePlacement.push({ id: `O${card.outlinePlacement.length + 1}`, sectionId: section.id, text: '关键词匹配归位线索，需人工确认章节用途', evidenceIds: [evidenceFor(card, anchor)] });
  }
  card.missing.push('本地模式未生成医学语义解析、可借鉴点或完整的局限判断；可人工补充或使用模型模式');
  return validateCard(card);
}
export function validateCard(card) {
  if (card?.schemaVersion !== 1 || !meaningful(card.documentId) || !/^[a-f0-9]{64}$/u.test(card.sourceFileHash) || !Array.isArray(card.pages) || !card.pages.length || !Array.isArray(card.evidence)) throw new Error('卡片结构无效');
  validateOutline(card.outline);
  const ids = new Set();
  for (const e of card.evidence) {
    const page = card.pages.find(p => p.page === e.page && !p.needsReview);
    if (ids.has(e.id) || !page || !meaningful(e.quote) || !normalizeText(page.text).includes(normalizeText(e.quote)) || e.id !== `E-${hash(`${card.sourceFileHash}:${e.page}:${normalizeText(e.quote)}`).slice(0, 20)}`) throw new Error('卡片证据不再对应原始页面');
    ids.add(e.id);
  }
  for (const page of card.pages) if (page.textHash !== hash(page.text)) throw new Error('页面文本哈希不一致');
  for (const field of ['claims', 'methods', 'reuse', 'limitations', 'outlinePlacement']) {
    if (!Array.isArray(card[field])) throw new Error(`卡片缺少 ${field}`);
    for (const item of card[field]) if (!meaningful(item.text) || !Array.isArray(item.evidenceIds) || !item.evidenceIds.length || item.evidenceIds.some(id => !ids.has(id))) throw new Error('卡片条目引用了不存在的证据');
  }
  if (card.outlinePlacement.some(item => !card.outline.some(s => s.id === item.sectionId))) throw new Error('卡片归位章节无效');
  if (!Array.isArray(card.references) || !Array.isArray(card.missing)) throw new Error('引用或缺项无效');
  if (!['local-extracts', 'model'].includes(card.mode) || card.status !== 'unverified' || !['excerpt', 'all-extracted-pages'].includes(card.readScope) || !Array.isArray(card.excludedPages)) throw new Error('卡片模式或阅读覆盖无效');
  if (card.methods.some(m => !['statistics', 'sample', 'reproducibility'].includes(m.aspect)) || card.limitations.some(l => !['author', 'reader-inference'].includes(l.kind))) throw new Error('方法或局限分类无效');
  const referenceIds = new Set();
  for (const ref of card.references) {
    if (!meaningful(ref.id) || referenceIds.has(ref.id) || !meaningful(ref.raw) || !['unresolved', 'verified', 'mismatch'].includes(ref.status) || ref.evidenceIds?.some(id => !ids.has(id))) throw new Error('引用结构无效');
    referenceIds.add(ref.id);
  }
  return card;
}
const safe = v => String(v ?? '').replace(/[&<>|`\[\]*_]/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '\\|' }[c] ?? `\\${c}`)).replace(/\r?\n/gu, '<br>');
export function cardMarkdown(card) {
  validateCard(card);
  const describe = items => items.length ? items.map(item => `${safe(item.text)} [${item.evidenceIds.map(safe).join(', ')}]`).join('<br><br>') : '未形成条目；参见缺项';
  const lines = [`# ${safe(card.title)}`, '', `文献ID：${card.documentId}；文件 SHA-256：${card.sourceFileHash}`, '', `模式：${card.mode}；状态：${card.status}；阅读覆盖：${card.readScope}；未覆盖或待检查物理页：${card.excludedPages.join(', ') || '无'}。`, '', '页码指 PDF 物理页，证据摘录定位已做文本比对，语义解释仍需人工核查。', '', '| 主张 | 证据 | 方法 | 可借鉴点 | 局限 |', '| :-- | :-- | :-- | :-- | :-- |', `| ${describe(card.claims)} | ${card.evidence.map(e => `${e.id}：p.${e.page}`).join('<br>') || '无'} | ${describe(card.methods)} | ${describe(card.reuse)} | ${describe(card.limitations)} |`, '', '## 原文证据', ''];
  for (const e of card.evidence) lines.push(`### ${e.id} · PDF p.${e.page}`, '', safe(e.quote), '');
  lines.push('## 方法学分项', '');
  for (const aspect of ['statistics', 'sample', 'reproducibility']) lines.push(`**${aspect}**：${describe(card.methods.filter(m => m.aspect === aspect))}`, '');
  lines.push('## 综述归位建议', '');
  for (const item of card.outlinePlacement) lines.push(`${safe(item.sectionId)} · ${safe(card.outline.find(s => s.id === item.sectionId)?.title)}：${safe(item.text)} [${item.evidenceIds.join(', ')}]`, '');
  if (!card.outlinePlacement.length) lines.push('未形成归位建议。', '');
  lines.push('## 引用核查', '', 'verified 仅表示所核对书目字段匹配，不能证明引用支持正文主张。', '');
  for (const ref of card.references) lines.push(`**${safe(ref.id)} · ${safe(ref.status)}**`, '', safe(ref.raw), '', `DOI：${safe(ref.candidate?.doi || ref.doi || '未确认')}；${safe(ref.note)}`, '');
  if (!card.references.length) lines.push('未自动提取到引用条目；请核查原文参考文献节。', '');
  lines.push('## 缺项与阅读提示', '');
  for (const note of [...card.missing, ...card.warnings]) lines.push(`${safe(note)}`, '');
  return lines.join('\n') + '\n';
}
