import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parsePubmed, parseArxiv, parseBiorxiv, normalizeDoi, fetchSubscription, createTransport, xmlTree } from '../packages/literature-radar/src/sources.js';
import { validateConfig, validateState, emptyState, runRadar, parseDoiList, validateAssessment, modelAssessment, reportMarkdown, nextRunDelay } from '../packages/literature-radar/src/radar.js';
import { loadState, publishResult, withStateLock } from '../packages/literature-radar/src/store.js';
import {applyHostAssessments,modelReviewProgress,createHostRunner} from '../packages/literature-radar/src/host.js';

const config = () => ({ schemaVersion: 1, mode: 'local', direction: '睡眠与疲劳', focusTerms: ['sleep', 'fatigue'], email: 'fixture@example.org', maxRecords: 100, lookbackDays: 3, subscriptions: [{ id: 'sleep', source: 'pubmed', query: 'sleep AND fatigue' }] });
const paper = (patch = {}) => ({ source: 'pubmed', id: '123', doi: '10.1234/test', title: 'Sleep & fatigue', abstract: 'Study of sleep and fatigue.', authors: ['A Researcher'], published: '2025-01-01', url: 'https://pubmed.ncbi.nlm.nih.gov/123/', preprint: false, ...patch });
const fixture = (papers, truncated = false) => ({ papers, total: papers.length + Number(truncated), scanned: papers.length, truncated, filter: 'native-query' });
const pubmed = `<?xml version="1.0"?><!DOCTYPE PubmedArticleSet SYSTEM "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd"><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>Sleep <i>and</i> fatigue &amp; health</ArticleTitle><Abstract><AbstractText Label="METHODS">Observed cohort.</AbstractText><AbstractText Label="RESULTS">No causal test.</AbstractText></Abstract><Journal><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue></Journal><AuthorList><Author><LastName>Smith</LastName><ForeName>Anne</ForeName></Author></AuthorList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/TEST</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
const arxiv = (id = '2501.12345v2', total = 1) => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>${total}</opensearch:totalResults><entry><id>http://arxiv.org/abs/${id}</id><title>Sleep study</title><published>2025-01-01T00:00:00Z</published><summary>A model of sleep.</summary><author><name>A Researcher</name></author><arxiv:doi>10.1234/ABC</arxiv:doi></entry></feed>`;
const bio = (start = 0, count = 30, total = 31) => JSON.stringify({ messages: [{ status: 'ok', total, count, cursor: start }], collection: Array.from({ length: count }, (_, i) => ({ doi: `10.1101/2025.01.01.${String(start + i).padStart(6, '0')}`, title: `${i % 2 ? 'Fatigue' : 'Sleep'} study`, abstract: 'Example only', authors: 'First A; Second B', date: '2025-01-01', version: '1' })) });
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'radar-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('transport cancellation interrupts an active request without provider retries',async()=>{
  let calls=0,started;const ready=new Promise(resolve=>{started=resolve;});
  const controller=new AbortController();
  const request=createTransport({fetchImpl:async(_url,{signal})=>{calls++;started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const result=request('https://export.arxiv.org/api/query',{signal:controller.signal});
  await ready;controller.abort();
  await assert.rejects(result,{name:'AbortError'});assert.equal(calls,1);
});
test('aborted radar execution rejects instead of returning a committable next state',async()=>{
  const c=config(),state=emptyState(c),before=structuredClone(state),controller=new AbortController();
  await assert.rejects(runRadar(c,state,{signal:controller.signal,fetchSubscription:async()=>{controller.abort();throw new Error('fixture cancellation');}}),{name:'AbortError'});
  assert.deepEqual(state,before);
});
test('a cancelled queued job settles before unrelated work and preserves serialization',async()=>{
  const runner=createHostRunner({});let releaseFirst,firstStarted,secondRan=false,thirdRan=false;
  const ready=new Promise(resolve=>{firstStarted=resolve;}),blocked=new Promise(resolve=>{releaseFirst=resolve;});
  const first=runner.serial(async()=>{firstStarted();await blocked;},new AbortController().signal);
  await ready;const controller=new AbortController();let secondSettled=false;
  const second=runner.serial(async()=>{secondRan=true;},controller.signal);
  const observed=second.catch(()=>{secondSettled=true;});
  const third=runner.serial(async()=>{thirdRan=true;},new AbortController().signal);
  try {
    controller.abort();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(secondSettled,true);assert.equal(secondRan,false);assert.equal(thirdRan,false);
  } finally {releaseFirst();await Promise.allSettled([first,second,third,observed]);}
  assert.equal(thirdRan,true);
});
test('partial host review does not upgrade capture coverage or overwrite the original report',()=>{
  const report={schemaVersion:1,id:'synthetic-protocol-fixture',direction:'教学',from:'2025-01-01',to:'2025-01-01',complete:false,mode:'local',subscriptions:[],errors:[{message:'Original protocol fixture with incomplete capture'}],excluded:{previous:0,zotero:0,duplicate:0},papers:['A','B'].map(id=>({source:'arxiv',id,title:`Fictional sleep protocol example ${id}`,abstract:'Original synthetic protocol text.',authors:[],published:'2025-01-01',url:'https://example.org/fixture',preprint:true,doi:'',assessment:{mode:'local-keywords',score:id==='A'?100:90,summaryZh:null,status:'not-model-reviewed',reason:'fixture',evidence:[]}}))};
  const before=structuredClone(report);
  const entry=id=>({key:`arxiv:${id}`,score:60,summaryZh:'原创教学示例，不是真实论文结论。',reason:'只检查格式与原句，不评价科研质量。',evidence:[report.papers.find(p=>p.id===id).title]});
  const partial=applyHostAssessments(report,[entry('A')]);
  assert.deepEqual(partial.papers.map(p=>p.id),['A','B'],'Partial review must not mix local and model scores for reordering');
  assert.deepEqual(modelReviewProgress(partial),{reviewed:1,total:2,complete:false});assert.equal(partial.complete,false);
  assert.notEqual(partial.id,report.id);assert.equal(partial.parentReportId,report.id);assert.deepEqual(report,before);
  const full=applyHostAssessments(partial,[entry('B')]);
  assert.deepEqual(modelReviewProgress(full),{reviewed:2,total:2,complete:true});assert.equal(full.complete,false);assert.equal(full.originalCaptureId,report.id);
  assert.throws(()=>applyHostAssessments(report,[{...entry('A'),evidence:['An invented quotation not in the fixture.']}]),/逐字/);
});
test('source capture stays complete when only the API-model step fails',async()=>{
  const c={...config(),mode:'model'},state=emptyState(c);
  const result=await runRadar(c,state,{sendToModel:true,fetchSubscription:async()=>({papers:[paper()],total:1,scanned:1,truncated:false,filter:'protocol-fixture'}),assess:async()=>{throw new Error('Original model-error fixture');}});
  assert.equal(result.report.complete,false);assert.equal(result.report.captureComplete,true);
  assert.equal(result.report.errors[0].paper,'pubmed:123');assert.equal(result.nextState.lastSuccess,null);assert.deepEqual(result.nextState.seen,[]);
  assert.match(reportMarkdown(result.report),/配置范围内抓取完成/);
  assert.match(reportMarkdown(result.report),/存在未完成步骤/);
});

test('PubMed parser preserves mixed-content title, structured abstract, DOI and authors', () => {
  const [p] = parsePubmed(pubmed);
  assert.equal(p.title, 'Sleep and fatigue & health');
  assert.equal(p.abstract, 'METHODS: Observed cohort.\nRESULTS: No causal test.');
  assert.equal(p.doi, '10.1234/test'); assert.deepEqual(p.authors, ['Anne Smith']);
  assert.equal(p.published, '2025');
  assert.throws(() => parsePubmed('<html>challenge</html>'), /集合/);
  assert.throws(() => xmlTree('<!DOCTYPE x [<!ENTITY x "expansion">]><x>&x;</x>'), /不支持/);
  assert.throws(() => xmlTree('<broken>'), /无效/);
});
test('arXiv version-independent IDs and empty feeds are correctly handled', () => {
  const page = parseArxiv(arxiv());
  assert.equal(page.total, 1); assert.equal(page.papers[0].id, '2501.12345');
  assert.equal(page.papers[0].doi, '10.1234/abc');
  assert.equal(parseArxiv('<feed><totalResults>0</totalResults></feed>').papers.length, 0);
  assert.throws(() => parseArxiv('<feed><entry><id>http://arxiv.org/api/errors#x</id></entry></feed>'), /总数|错误/);
});
test('bioRxiv parser distinguishes empty success, provider errors and malformed records', () => {
  assert.equal(parseBiorxiv(bio()).papers.length, 30);
  assert.deepEqual(parseBiorxiv('{"messages":[{"status":"no posts found"}]}'), { papers: [], total: 0 });
  assert.throws(() => parseBiorxiv('{"messages":[{"status":"bad interval"}]}'), /错误/);
  assert.throws(() => parseBiorxiv('not json'), /有效/);
});
test('DOI list normalizes URL/case without silently accepting corrupted lines', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1234/ABC'), '10.1234/abc');
  assert.deepEqual([...parseDoiList('# Zotero\nDOI\n10.1234/ABC\nhttps://doi.org/10.1234/abc')], ['doi:10.1234/abc']);
  assert.throws(() => parseDoiList('not a DOI'), /无效行/);
});
test('PubMed requests use entry date, exact IDs and detect incomplete fetches', async () => {
  const urls = [];
  const result = await fetchSubscription(config().subscriptions[0], { from: '2025-01-01', to: '2025-01-03', email: 'fixture@example.org', request: async url => { urls.push(new URL(url)); return url.includes('esearch') ? '{"esearchresult":{"count":"1","idlist":["123"]}}' : pubmed; } });
  assert.equal(result.papers.length, 1);
  assert.equal(urls[0].searchParams.get('datetype'), 'edat');
  assert.equal(urls[0].searchParams.get('mindate'), '2025/01/01');
  assert.equal(urls[1].searchParams.get('id'), '123');
  await assert.rejects(fetchSubscription(config().subscriptions[0], { from: '2025-01-01', to: '2025-01-03', request: async () => '{"esearchresult":{"count":"2","idlist":["123"]}}' }), /不完整/);
  await assert.rejects(fetchSubscription(config().subscriptions[0], { from: '2025-02-30', to: '2025-03-01' }), /真实/);
});
test('arXiv query includes date window and pages through results', async () => {
  const urls = [];
  const result = await fetchSubscription({ source: 'arxiv', query: 'all:sleep' }, { from: '2025-01-01', to: '2025-01-01', maxRecords: 2, request: async url => { const u = new URL(url); urls.push(u); return arxiv(`2501.1234${urls.length}`, 2); } });
  assert.equal(result.papers.length, 2); assert.equal(result.truncated, false);
  assert.equal(urls[1].searchParams.get('start'), '1');
  assert.ok(urls[0].searchParams.get('search_query').includes('submittedDate:[202501010000 TO 202501012359]'));
});
test('bioRxiv paginates before local filtering and truncation reflects scanned, not matched', async () => {
  const urls = [];
  const subscription = { source: 'biorxiv', terms: ['sleep'], category: 'neuroscience' };
  const result = await fetchSubscription(subscription, { from: '2025-01-01', to: '2025-01-01', maxRecords: 31, request: async url => { urls.push(url); return urls.length === 1 ? bio() : bio(30, 1); } });
  assert.equal(result.scanned, 31); assert.equal(result.papers.length, 16); assert.equal(result.truncated, false);
  assert.ok(urls[1].includes('/30/json?category=neuroscience'));
  const truncated = await fetchSubscription(subscription, { from: '2025-01-01', to: '2025-01-01', maxRecords: 2, request: async () => bio() });
  assert.equal(truncated.scanned, 2); assert.equal(truncated.papers.length, 1); assert.equal(truncated.truncated, true);
});
test('transport retries 429 and 503, honors backoff and rejects permanent errors without body leaks', async () => {
  const sleeps = []; let calls = 0;
  const request = createTransport({ sleep: async ms => sleeps.push(ms), fetchImpl: async () => ++calls < 3 ? new Response('private error body', { status: calls === 1 ? 429 : 503, headers: { 'Retry-After': '2' } }) : new Response('success') });
  assert.equal(await request('https://example.org/test'), 'success'); assert.equal(calls, 3); assert.ok(sleeps.includes(2000));
  await assert.rejects(createTransport({ fetchImpl: async () => new Response('secret body', { status: 401 }) })('https://example.org/test'), error => error.message.includes('401') && !error.message.includes('secret'));
});
test('configuration validates source-specific query meaning and binds state to config', () => {
  assert.equal(validateConfig(config()).mode, 'local');
  const invalid = config(); invalid.subscriptions = [{ source: 'biorxiv', id: 'bio', query: 'sleep' }];
  assert.throws(() => validateConfig(invalid), /terms/);
  const c = config(), state = emptyState(c); c.direction = 'changed';
  assert.throws(() => validateState(state, c), /配置已变化/);
});
test('cross-source DOI dedup, Zotero exclusion and persistent restart do not lose attribution', async () => {
  const c = config(); c.subscriptions.push({ id: 'second', source: 'arxiv', query: 'all:sleep' });
  const result = await runRadar(c, emptyState(c), { now: new Date('2025-01-03T12:00:00Z'), zotero: parseDoiList('10.1234/excluded'), fetchSubscription: async s => fixture([paper(s.id === 'second' ? { source: 'arxiv', id: '2501.12345' } : {}), paper({ id: '456', doi: '10.1234/excluded' })]) });
  assert.equal(result.report.papers.length, 1); assert.deepEqual(result.report.papers[0].subscriptions, ['sleep', 'second']);
  assert.equal(result.report.excluded.zotero, 2); assert.equal(result.report.excluded.duplicate, 1);
  assert.ok(result.nextState.seen.includes('arxiv:2501.12345'));
  assert.equal(result.report.from, '2025-01-01'); assert.equal(result.report.papers[0].assessment.score, 100);
  const again = await runRadar(c, result.nextState, { fetchSubscription: async () => fixture([paper()]) });
  assert.equal(again.report.papers.length, 0);
});
test('source failure preserves all seen IDs for full retry; truncation cannot claim complete', async () => {
  const c = config(); c.subscriptions.push({ id: 'second', source: 'arxiv', query: 'all:sleep' });
  const state = emptyState(c);
  const failed = await runRadar(c, state, { fetchSubscription: async s => { if (s.id === 'second') throw new Error('offline'); return fixture([paper()]); } });
  assert.equal(failed.report.complete, false); assert.equal(failed.report.errors.length, 1); assert.deepEqual(failed.nextState.seen, []); assert.equal(failed.nextState.lastSuccess, null);
  const capped = await runRadar(c, state, { fetchSubscription: async () => fixture([paper()], true) });
  assert.equal(capped.report.complete, false); assert.equal(capped.nextState.lastSuccess, null); assert.equal(capped.nextState.seen.length, 2);
});
test('model mode requires explicit send; bad model output cannot consume IDs', async () => {
  const c = config(); c.mode = 'model';
  await assert.rejects(runRadar(c, emptyState(c)), /显式/);
  const result = await runRadar(c, emptyState(c), { sendToModel: true, fetchSubscription: async () => fixture([paper()]), assess: async () => { throw new Error('invalid model output'); } });
  assert.equal(result.report.complete, false); assert.deepEqual(result.nextState.seen, []);
  assert.throws(() => validateAssessment({ score: 80, summaryZh: '摘要', reason: '理由', evidence: ['invented text'] }, paper()), /逐字/);
});
test('actual local HTTP model protocol produces unverified Chinese summary with valid supporting excerpt', async t => {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); assert.equal(input.messages[0].role, 'system'); assert.ok(input.messages[1].content.includes('睡眠与疲劳')); assert.equal(req.headers.authorization, 'Bearer fixture-key');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 90, summaryZh: '该摘要描述睡眠与疲劳研究。', reason: '与声明的睡眠方向相关。', evidence: ['Study of sleep and fatigue.'] }) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const result = await modelAssessment(paper(), config(), { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', model: 'test-model' });
  assert.equal(result.status, 'unverified'); assert.equal(result.score, 90);
});
test('daily schedule resumes from persisted completion and uses retry delay after failure', () => {
  const state = emptyState(config());
  assert.equal(nextRunDelay(state, 86400, 300, Date.parse('2025-01-01')), 0);
  state.lastSuccess = state.lastAttempt = '2025-01-01T00:00:00Z';
  assert.equal(nextRunDelay(state, 86400, 300, Date.parse('2025-01-01T01:00:00Z')), 23 * 3600000);
  state.lastAttempt = '2025-01-02T00:00:00Z';
  assert.equal(nextRunDelay(state, 86400, 300, Date.parse('2025-01-02T00:01:00Z')), 240000);
});
test('historical backfill keeps the actual run timestamp distinct from the search window', async () => {
  const c = config(); let observed;
  const result = await runRadar(c, emptyState(c), { now: new Date('2026-11-10T08:00:00Z'), date: '2025-01-03', fetchSubscription: async (_s, args) => { observed = args; return fixture([]); } });
  assert.equal(result.report.at, '2026-11-10T08:00:00.000Z');
  assert.equal(observed.from, '2025-01-01'); assert.equal(observed.to, '2025-01-03');
  assert.equal(result.nextState.lastSuccess, '2026-11-10T08:00:00.000Z');
  await assert.rejects(runRadar(c, emptyState(c), { date: '2025-02-30' }), /真实/);
});
test('a response body disconnect is retried without returning partial metadata', async () => {
  let calls = 0;
  const request = createTransport({ sleep: async () => {}, fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('disconnect')); } }));
    return new Response('complete response');
  } });
  assert.equal(await request('https://example.org/body'), 'complete response');
  assert.equal(calls, 2);
});
test('publishing writes recoverable JSON and Markdown before consuming state; lock blocks concurrent runs', async t => {
  const dir = temp(t), statePath = join(dir, 'state.json'), reports = join(dir, 'reports'), c = config();
  const result = await runRadar(c, emptyState(c), { fetchSubscription: async () => fixture([paper({ title: '<script>alert(1)</script>' })]) });
  await withStateLock(statePath, async () => {
    await assert.rejects(withStateLock(statePath, async () => {}), /锁定/);
    const paths = publishResult(statePath, reports, result);
    assert.equal(JSON.parse(readFileSync(paths.jsonPath, 'utf8')).papers.length, 1);
    assert.ok(readFileSync(paths.markdownPath, 'utf8').includes('&lt;script&gt;'));
  });
  assert.equal(existsSync(`${statePath}.lock`), false); assert.deepEqual(loadState(statePath, c), result.nextState);
  const before = readFileSync(statePath, 'utf8');
  writeFileSync(join(dir, 'not-a-directory'), 'block writes');
  assert.throws(() => publishResult(statePath, join(dir, 'not-a-directory', 'reports'), result));
  assert.equal(readFileSync(statePath, 'utf8'), before);
});
