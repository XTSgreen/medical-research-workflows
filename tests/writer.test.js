import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProject, addSource, sourceFromX2, sourceFromRecords, draftSection, confirmSection, setJournal, adaptSection, validateProject, evidenceBank, manuscriptMarkdown, styleTexts } from '../packages/clinic-writer/src/writer.js';
import { loadProject, saveProject } from '../packages/clinic-writer/src/store.js';
import { modelSection } from '../packages/clinic-writer/src/model.js';
import { extractPdf } from '../packages/paper-autopsy/src/pdf.js';
import { localCard } from '../packages/paper-autopsy/src/autopsy.js';
import { makePdf, fixturePages } from '../test-support/pdf-fixture.js';

const outline = [{ id: 'methods', title: 'Methods', requirements: '仅描述实际完成的研究流程' }, { id: 'results', title: 'Results', requirements: '只引用结果记录，不改写数值' }];
const records = readFileSync('examples/writer/study-records.json', 'utf8');
const journal = JSON.parse(readFileSync('examples/writer/journal-teaching.json', 'utf8'));
const project = () => addSource(createProject('Fictional teaching paper', outline), sourceFromRecords(records));
const supported = (p, index = 0, text) => { const e = evidenceBank(p)[index]; return { kind: 'fact', text: text ?? e.quote, support: [{ evidenceId: e.id, quote: e.quote }] }; };
const adaptation = section => ({ units: section.units.map(({ id, kind, text, support }) => ({ id, kind, text, support: support.map(({ evidenceId, quote }) => ({ evidenceId, quote })) })) });
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'writer-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('project requires explicit section requirements and unique IDs', () => {
  assert.equal(createProject('test', outline).sections.length, 2);
  assert.throws(() => createProject('test', [...outline, outline[0]]), /唯一/);
  assert.throws(() => createProject('test', [{ id: 'a', title: 'a' }]), /requirements/);
});
test('real X2 cards import with original page, document version and evidence IDs intact', async t => {
  const dir = temp(t), input = join(dir, 'paper.pdf'); writeFileSync(input, makePdf(fixturePages));
  const card = localCard(await extractPdf(input)), source = sourceFromX2(card);
  const p = addSource(project(), source), bank = evidenceBank(p), original = card.evidence[0];
  const imported = bank.find(e => e.id === `${card.documentId}:${original.id}`);
  assert.equal(imported.quote, original.quote); assert.equal(imported.page, original.page); assert.equal(imported.sourceFileHash, card.sourceFileHash);
  const bad = structuredClone(card); bad.pages[0].text += 'modified';
  assert.throws(() => sourceFromX2(bad), /哈希/);
  assert.throws(() => addSource(p, source), /重复/);
});
test('study records preserve source snapshots and reject accidental bank mutation', () => {
  const p = project(); p.sources[0].evidence[0].quote = 'modified';
  assert.throws(() => validateProject(p), /快照/);
  assert.throws(() => sourceFromRecords('{bad'), /有效JSON/);
  assert.throws(() => sourceFromRecords(JSON.stringify({ schemaVersion: 1, title: 'test', records: [{ id: 'r', text: 'x' }, { id: 'r', text: 'y' }] })), /唯一/);
});
test('all draft prose is generated from traceable units, and unsupported content stays visibly missing', () => {
  const p = project(), next = draftSection(p, 'methods', { units: [supported(p), { kind: 'fact', text: 'Ethical approval details have not been supplied.', support: [] }] });
  assert.equal(next.sections[0].units[0].sourceStatus, 'linked-unverified');
  assert.equal(next.sections[0].units[1].sourceStatus, 'missing');
  assert.ok(manuscriptMarkdown(next).includes('**[待补来源]**'));
  assert.ok(manuscriptMarkdown(next).includes('本节事实与解释的来源清单'));
  assert.throws(() => confirmSection(next, 'methods', 'author', 'checked'), /无来源/);
  assert.throws(() => draftSection(p, 'methods', { units: [supported(p)], prose: 'uncited free prose' }), /只允许units/);
});
test('fabricated evidence, quotes and DOIs cannot silently enter the manuscript', () => {
  const p = project(), unit = supported(p); unit.support[0].evidenceId = 'invented';
  assert.throws(() => draftSection(p, 'methods', { units: [unit] }), /证据ID/);
  const unit2 = supported(p); unit2.support[0].quote = 'An invented clinical benefit.';
  assert.throws(() => draftSection(p, 'methods', { units: [unit2] }), /支持片段/);
  assert.throws(() => draftSection(p, 'methods', { units: [{ kind: 'fact', text: 'See doi:10.1234/fabricated', support: [] }] }), /不存在的DOI/);
});
test('unsupported numeric claims and sign changes are flagged before author confirmation', () => {
  const p = project(), next = draftSection(p, 'results', { units: [supported(p, 1, 'The estimate was 0.4 points.')] });
  assert.ok(next.sections[1].units[0].warnings.some(w => w.includes('数字')));
  assert.throws(() => confirmSection(next, 'results', 'author', 'checked'), /数字/);
  const okay = draftSection(p, 'results', { units: [supported(p, 1, 'The estimate was -0.4 points.')] });
  assert.equal(okay.sections[1].units[0].warnings.length, 0);
});
test('author checks are content-bound and any draft change revokes prior confirmation', () => {
  let p = project(); p = draftSection(p, 'methods', { units: [supported(p)] });
  p = confirmSection(p, 'methods', 'Teaching author', 'Checked source record sample against the sentence');
  assert.equal(p.sections[0].status, 'checked');
  const changed = draftSection(p, 'methods', { units: [supported(p, 0, 'This fictional cohort included 80 adults.')] });
  assert.equal(changed.sections[0].status, 'draft'); assert.equal(changed.sections[0].verification, null);
  const tampered = structuredClone(p); tampered.sections[0].verification.unitsHash = 'wrong';
  assert.throws(() => validateProject(tampered), /已过期/);
});
test('journal rules need source quotes, cannot conflict, and reset checked sections', () => {
  const p = confirmSection(draftSection(project(), 'methods', { units: [supported(project())] }), 'methods', 'author', 'source checked');
  const next = setJournal(p, journal); assert.equal(next.sections[0].status, 'draft'); assert.equal(next.sections[0].verification, null);
  const bad = structuredClone(journal); bad.rules[0].quote = 'invented policy';
  assert.throws(() => setJournal(p, bad), /原文/);
  const conflicting = structuredClone(journal); conflicting.rules.push({ ...conflicting.rules[0], id: 'T2', value: 'present' });
  assert.throws(() => setJournal(p, conflicting), /冲突/);
});
test('abbreviations expand at first use across sections, figure labels adapt, original evidence stays unchanged', () => {
  let p = project(); p = draftSection(p, 'methods', { units: [supported(p, 1, 'The 95% CI is shown in Fig. 1.')] });
  p = draftSection(p, 'results', { units: [supported(p, 1, 'The 95% CI ranges from -0.7 to -0.1 points.')] });
  p = setJournal(p, journal);
  const styled = styleTexts(p);
  assert.equal(styled.get('methods-C001'), 'The 95% confidence interval (CI) is shown in Figure 1.');
  assert.equal(styled.get('results-C001'), 'The 95% CI ranges from -0.7 to -0.1 points.');
  assert.ok(p.sections[0].units[0].support[0].quote.includes('Fig. 1'));
  assert.ok(manuscriptMarkdown(p).includes('期刊规则来源'));
});
test('journal language adaptation preserves IDs, support, signed values and uncertainty', () => {
  let p = project(); p = draftSection(p, 'results', { units: [supported(p, 1, 'The fictional estimate is -0.4 points.')] }); p = setJournal(p, journal);
  const adapt = adaptation(p.sections[1]); adapt.units[0].text = 'The fictional estimate was -0.4 points.';
  assert.equal(adaptSection(p, 'results', adapt).sections[1].units[0].text, adapt.units[0].text);
  adapt.units[0].text = 'The fictional estimate was 0.4 points.';
  assert.throws(() => adaptSection(p, 'results', adapt), /数字/);
  const changedSupport = adaptation(p.sections[1]); changedSupport.units[0].support = [];
  assert.throws(() => adaptSection(p, 'results', changedSupport), /证据/);
  let p2 = project(); p2 = setJournal(draftSection(p2, 'methods', { units: [supported(p2, 2)] }), journal);
  const stronger = adaptation(p2.sections[0]); stronger.units[0].text = stronger.units[0].text.replace('may be', 'is');
  assert.throws(() => adaptSection(p2, 'methods', stronger), /不确定性/);
});
test('existing definitions retain sentence capitalization, and real guideline subset formats figures and tables', () => {
  let p = project();
  p = draftSection(p, 'results', { units: [supported(p, 1, 'Confidence interval (CI) is shown in Figure 1 and Tab. 1.')] });
  const actual = JSON.parse(readFileSync('examples/writer/journal-plosone-subset.json', 'utf8'));
  p = setJournal(p, actual);
  assert.equal(styleTexts(p).get('results-C001'), 'Confidence interval (CI) is shown in Fig 1 and Table 1.');
});
test('moving first abbreviation use into an earlier section revokes downstream rendered-text confirmation', () => {
  let p = setJournal(project(), journal);
  p = draftSection(p, 'results', { units: [supported(p, 1, 'The 95% CI is shown in Fig. 1.')] });
  p = confirmSection(p, 'results', 'author', 'Checked rendered text and sources');
  assert.ok(p.sections[1].verification.renderedText[0].includes('confidence interval'));
  p = draftSection(p, 'methods', { units: [supported(p, 1, 'The 95% CI is discussed here.')] });
  assert.equal(p.sections[1].status, 'draft'); assert.equal(p.sections[1].verification, null);
  assert.ok(p.sections[1].history.some(h => h.action === 'render-change'));
  assert.ok(!styleTexts(p).get('results-C001').includes('confidence interval'));
});
test('atomic project store rejects stale writers and preserves corruption rather than overwriting it', t => {
  const path = join(temp(t), 'project.json'), p = saveProject(path, project(), { create: true });
  const next = saveProject(path, draftSection(p, 'methods', { units: [supported(p)] }));
  assert.equal(next.revision, 2); assert.throws(() => saveProject(path, p), /版本已改变/);
  assert.equal(loadProject(path).sections[0].status, 'draft');
  writeFileSync(`${path}.lock`, 'live writer'); assert.throws(() => saveProject(path, next), /锁定/);
  rmSync(`${path}.lock`); writeFileSync(path, '{broken');
  assert.throws(() => saveProject(path, project(), { create: true })); assert.equal(readFileSync(path, 'utf8'), '{broken'); assert.equal(existsSync(`${path}.lock`), false);
});
test('actual local model protocol generates a grounded section and separately adapts tense', async t => {
  let p = setJournal(project(), journal); const e = evidenceBank(p)[0]; let requests = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body), data = JSON.parse(payload.messages[1].content); requests++;
    assert.equal(req.headers.authorization, 'Bearer fixture-key'); assert.equal(payload.messages[0].role, 'system'); assert.equal(data.section.id, 'methods');
    const units = requests === 1 ? [supported(p, 0, 'This fictional study includes 80 adults.')] : [{ ...data.existingUnits[0], text: 'This fictional study included 80 adults.' }];
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ units }) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', model: 'test-model', sendToModel: true };
  await assert.rejects(modelSection(p, 'methods'), /显式/);
  p = await modelSection(p, 'methods', options); assert.equal(p.sections[0].status, 'draft'); assert.equal(p.sections[0].units[0].support[0].evidenceId, e.id);
  p = await modelSection(p, 'methods', { ...options, adapt: true }); assert.ok(p.sections[0].units[0].text.includes('included')); assert.equal(requests, 2);
});
test('model failures cannot leak provider body or silently update projects', async () => {
  const p = project(), before = JSON.stringify(p), options = { baseUrl: 'https://provider.example/v1', apiKey: 'private', model: 'test', sendToModel: true };
  await assert.rejects(modelSection(p, 'methods', { ...options, fetchImpl: async () => new Response('private provider body', { status: 401 }) }), error => error.message.includes('401') && !error.message.includes('private'));
  await assert.rejects(modelSection(p, 'methods', { ...options, fetchImpl: async () => new Response('not json') }), /有效JSON/);
  assert.equal(JSON.stringify(p), before);
});
test('CLI completes import, author checking and export across independent processes', t => {
  const dir = temp(t), path = join(dir, 'project.json'), proposalFile = join(dir, 'proposal.json'), output = join(dir, 'draft.md');
  const run = (...args) => spawnSync(process.execPath, [resolve('packages/clinic-writer/cli.js'), ...args], { encoding: 'utf8' });
  let result = run('init', '--project', path, '--title', 'Teaching only', '--outline', 'examples/writer/outline.json'); assert.equal(result.status, 0, result.stderr);
  result = run('import-records', '--project', path, '--input', 'examples/writer/study-records.json'); assert.equal(result.status, 0, result.stderr);
  const p = loadProject(path); writeFileSync(proposalFile, JSON.stringify({ units: [supported(p)] }));
  result = run('draft', '--project', path, '--section', 'methods', '--input', proposalFile); assert.equal(result.status, 0, result.stderr);
  result = run('confirm', '--project', path, '--section', 'methods', '--reviewer', 'Teaching author', '--note', 'Checked example source'); assert.equal(result.status, 0, result.stderr);
  result = run('export', '--project', path, '--output', output); assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(output, 'utf8').includes('作者已核对')); assert.equal(run('export', '--project', path, '--output', output).status, 1);
  assert.equal(run('generate', '--project', path, '--section', 'methods').status, 1);
});
