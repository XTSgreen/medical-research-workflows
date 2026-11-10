import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makePdf, fixturePages } from '../test-support/pdf-fixture.js';
import { extractPdf, extractPdfBytes, normalizeText } from '../packages/paper-autopsy/src/pdf.js';
import { localCard, cardFromProposal, validateCard, cardMarkdown } from '../packages/paper-autopsy/src/autopsy.js';
import { extractReferenceCandidates, verifyReference, findDois, compareReference, createCrossrefRequest } from '../packages/paper-autopsy/src/references.js';
import { analyzeWithModel } from '../packages/paper-autopsy/src/model.js';
import { parsePageSelection } from '../packages/paper-autopsy/cli.js';

function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'autopsy-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('host byte extraction matches file extraction and honors pre-dispatch cancellation', async t=>{
  const bytes=makePdf(fixturePages),file=join(temp(t),'bytes.pdf');writeFileSync(file,bytes);
  assert.deepEqual(await extractPdfBytes(new Uint8Array(bytes)),await extractPdf(file));
  const controller=new AbortController();controller.abort();
  await assert.rejects(extractPdfBytes(bytes,{signal:controller.signal}),{name:'AbortError'});
});
async function document(t, pages = fixturePages, options) { const path = join(temp(t), 'fixture.pdf'); writeFileSync(path, makePdf(pages)); return extractPdf(path, options); }
const anchor = { page: 1, quote: 'Participants were 80 adults in an observational cohort.' };
const outline = [{ id: 'S1', title: '方法', keywords: ['regression'] }];
function proposal() { return { title: 'Teaching paper: Sleep and fatigue', claims: [{ text: '作者报告观察性队列。', evidence: [anchor] }], methods: [{ aspect: 'sample', text: '教学样例包含80位成年人。', evidence: [anchor] }], reuse: [{ text: '可参考观察性样本描述。', evidence: [anchor] }], limitations: [{ kind: 'reader-inference', text: '观察设计不足以自行确认因果关系。', evidence: [anchor] }], references: [], outlinePlacement: [{ sectionId: 'S1', text: '可作为设计描述线索。', evidence: [anchor] }], missing: ['未完整核对统计结果'] }; }
const work = { DOI: '10.1234/example-only', title: ['Example reference for testing'], author: [{ family: 'Smith' }], published: { 'date-parts': [[2025]] } };
test('floating figure and dated footer between numbered references do not pollute citation candidates',()=>{
  const candidates=extractReferenceCandidates({pages:[
    {page:11,text:'References\n1. Huhn. Wearable technologies. 2022.\nMarch 4, 2025 11/17'},
    {page:12,text:'Fig 6. Weekly sleep times.\nOriginal teaching figure description.\n2. Smith. Other teaching reference. 2025.'},
  ]});
  assert.deepEqual(candidates.map(r=>({page:r.page,raw:r.raw})),[
    {page:11,raw:'1. Huhn. Wearable technologies. 2022.'},
    {page:12,raw:'2. Smith. Other teaching reference. 2025.'},
  ]);
});
const reference = () => ({ id: 'REF1', raw: 'Smith. Example reference for testing. 2025. doi:10.1234/example-only', doi: '10.1234/example-only', title: 'Example reference for testing', author: 'Smith', year: '2025' });

test('real PDF text extraction retains physical pages, hashes and selected read scope', async t => {
  const doc = await document(t);
  assert.equal(doc.pageCount, 2); assert.equal(doc.pages[1].page, 2);
  assert.ok(doc.pages[0].text.includes(anchor.quote)); assert.match(doc.sourceFileHash, /^[a-f0-9]{64}$/u);
  assert.equal(doc.readScope, 'all-extracted-pages');
  const selected = await document(t, fixturePages, { selectedPages: [2] });
  assert.equal(selected.readScope, 'excerpt'); assert.deepEqual(selected.excludedPages, [1]); assert.equal(selected.pages[0].page, 2);
  assert.ok(localCard(selected).title.includes('节选未含可读首页'));
  await assert.rejects(document(t, fixturePages, { selectedPages: [3] }), /超出范围/);
});
test('image-only PDFs cannot silently produce empty cards; mixed PDFs require explicit partial selection', async t => {
  await assert.rejects(document(t, [{ imageOnly: true }]), /OCR/);
  await assert.rejects(document(t, [{ imageOnly: true }], { allowPartial: true }), /不生成空白/);
  await assert.rejects(document(t, [fixturePages[0], { imageOnly: true }]), /OCR/);
  const partial = await document(t, [fixturePages[0], { imageOnly: true }], { allowPartial: true });
  assert.equal(partial.pages[1].needsOcr, true); assert.equal(partial.readScope, 'excerpt'); assert.deepEqual(partial.excludedPages, [2]);
});
test('invalid and oversized PDF inputs fail before analysis', async t => {
  const file = join(temp(t), 'not.pdf'); writeFileSync(file, 'not a PDF');
  await assert.rejects(extractPdf(file), /不是 PDF/);
  await assert.rejects(extractPdf(file, { maxBytes: 1 }), /50 MB/);
  assert.deepEqual(parsePageSelection('1-3,5'), [1, 2, 3, 5]);
  assert.throws(() => parsePageSelection('1-3,3'), /重复/);
  assert.throws(() => parsePageSelection('5-1'), /递增/);
});
test('local card retains five-column output, method clues, source evidence and limitations of local mode', async t => {
  const card = localCard(await document(t), outline);
  assert.equal(card.mode, 'local-extracts'); assert.equal(card.status, 'unverified');
  assert.ok(card.methods.some(m => m.aspect === 'sample' && m.text.includes('Participants were 80 adults')));
  assert.ok(!card.methods.some(m => m.aspect === 'sample' && m.text.includes('was associated with fatigue')), 'example must not be matched as sample');
  assert.ok(card.evidence.every(e => normalizeText(card.pages[e.page - 1].text).includes(e.quote)));
  assert.equal(card.outlinePlacement[0].sectionId, 'S1'); assert.equal(card.references.length, 1);
  const md = cardMarkdown(card);
  assert.ok(md.includes('| 主张 | 证据 | 方法 | 可借鉴点 | 局限 |'));
  assert.ok(md.includes('未生成医学语义解析')); assert.ok(md.includes('PDF p.1'));
});
test('model cards reject fabricated quotes, page numbers and invented outline sections', async t => {
  const doc = await document(t), p = proposal();
  const card = cardFromProposal(doc, p, outline); assert.ok(card.missing.some(m => m.includes('statistics')));
  assert.equal(card.references[0].id, 'AUTOREF1', 'model omission must not erase detected bibliography');
  p.claims[0].evidence[0] = { page: 1, quote: 'Invented experiment achieved 100% accuracy.' };
  assert.throws(() => cardFromProposal(doc, p, outline), /不在对应/);
  p.claims[0].evidence[0] = { page: 99, quote: anchor.quote };
  assert.throws(() => cardFromProposal(doc, p, outline), /不在对应/);
  const p2 = proposal(); p2.outlinePlacement[0].sectionId = 'invented';
  assert.throws(() => cardFromProposal(doc, p2, outline), /不存在/);
});
test('model bibliography fields must be grounded in original reference text', async t => {
  const doc = await document(t), p = proposal();
  const raw = '1. Smith. Example reference for testing. 2025. doi:10.1234/example-only';
  p.references = [{ ...reference(), raw, evidence: [{ page: 2, quote: raw }] }];
  assert.equal(cardFromProposal(doc, p, outline).references.length, 1);
  p.references[0].doi = '10.1234/hallucination';
  assert.throws(() => cardFromProposal(doc, p, outline), /DOI 不在原文/);
});
test('persisted card rejects broken source text hashes and missing evidence IDs', async t => {
  const card = localCard(await document(t));
  const bad = structuredClone(card); bad.pages[0].text = 'changed';
  assert.throws(() => validateCard(bad), /证据|哈希/);
  const bad2 = structuredClone(card); bad2.claims[0].evidenceIds = ['invented'];
  assert.throws(() => validateCard(bad2), /不存在/);
});
test('DOI parsing preserves balanced parentheses while removing citation punctuation', () => {
  assert.deepEqual(findDois('doi:10.1234/A(BC). (https://doi.org/10.1234/DEF).'), ['10.1234/a(bc)', '10.1234/def']);
});
test('reference verification distinguishes matched metadata, mismatches and unresolved DOI-only records', async () => {
  const request = async () => ({ status: 'ok', message: work });
  assert.equal((await verifyReference(reference(), { request })).status, 'verified');
  assert.equal((await verifyReference({ ...reference(), title: 'Incorrect title' }, { request })).status, 'mismatch');
  assert.equal((await verifyReference({ ...reference(), year: '2020' }, { request })).status, 'mismatch');
  assert.equal((await verifyReference({ ...reference(), author: 'Another' }, { request })).status, 'mismatch');
  assert.equal((await verifyReference({ ...reference(), title: '' }, { request })).status, 'unresolved');
  assert.equal((await verifyReference(reference(), { request: async () => null })).status, 'unresolved');
  assert.equal((await verifyReference(reference(), { request: async () => { throw new Error('offline'); } })).status, 'unresolved');
});
test('title-only search requires a unique match with author and year cross-checks', async () => {
  const ref = { ...reference(), doi: '' }, request = async () => ({ status: 'ok', message: { items: [work] } });
  assert.equal((await verifyReference(ref, { request })).status, 'verified');
  assert.equal((await verifyReference({ ...ref, author: '' }, { request })).status, 'unresolved');
  assert.equal((await verifyReference(ref, { request: async () => ({ status: 'ok', message: { items: [work, work] } }) })).status, 'unresolved');
});
test('Crossref transport retries throttling and treats 404 as unresolved without leaking provider body', async () => {
  let calls = 0;
  const request = createCrossrefRequest({ sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? new Response('private provider body', { status: 429 }) : new Response(JSON.stringify({ status: 'ok', message: work })) });
  assert.equal((await request('https://api.crossref.org/works/test')).status, 'ok'); assert.equal(calls, 2);
  assert.equal(await createCrossrefRequest({ fetchImpl: async () => new Response('not found', { status: 404 }) })('https://api.crossref.org/works/test'), null);
});
test('model opt-in, structured protocol and grounded response work against real local HTTP', async t => {
  const doc = await document(t);
  await assert.rejects(analyzeWithModel(doc), /显式/);
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer fixture-key');
    const data = JSON.parse(input.messages[1].content); assert.equal(data.pages[0].page, 1); assert.equal(data.outline[0].id, 'S1');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal()) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const card = await analyzeWithModel(doc, { outline, sendToModel: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', model: 'test-model' });
  assert.equal(card.mode, 'model'); assert.equal(card.status, 'unverified');
});
test('CLI independently processes PDFs, exports cards, refuses overwrite and rejects scans', t => {
  const dir = temp(t), input = join(dir, 'paper.pdf'), output = join(dir, 'card'), exported = join(dir, 'card.md');
  writeFileSync(input, makePdf(fixturePages));
  const run = (...args) => spawnSync(process.execPath, [resolve('packages/paper-autopsy/cli.js'), ...args], { encoding: 'utf8' });
  let result = run('analyze', '--pdf', input, '--output', output);
  assert.equal(result.status, 0, result.stderr); assert.ok(existsSync(join(output, 'card.json')));
  result = run('export', '--input', join(output, 'card.json'), '--output', exported); assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(exported, 'utf8').includes('五栏') || readFileSync(exported, 'utf8').includes('可借鉴点'));
  assert.equal(run('analyze', '--pdf', input, '--output', output).status, 1);
  const scan = join(dir, 'scan.pdf'); writeFileSync(scan, makePdf([{ imageOnly: true }]));
  result = run('analyze', '--pdf', scan, '--output', join(dir, 'scan-card')); assert.equal(result.status, 1); assert.ok(result.stderr.includes('OCR')); assert.equal(existsSync(join(dir, 'scan-card')), false);
});
