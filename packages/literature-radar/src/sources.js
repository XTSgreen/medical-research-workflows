import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { setTimeout as delay } from 'node:timers/promises';

const array = v => Array.isArray(v) ? v : [v];
export function xmlTree(xml) {
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/iu.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('无效或不支持的 XML');
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, parseTagValue: false, trimValues: false });
  function convert(items) {
    return items.flatMap(item => Object.entries(item).filter(([name]) => name !== ':@' && !name.startsWith('?')).map(([name, value]) => name === '#text' ? { name, value: String(value) } : { name, attrs: item[':@'] ?? {}, children: convert(array(value)) }));
  }
  return { name: 'root', children: convert(parser.parse(xml)) };
}
const children = (node, name) => (node?.children ?? []).filter(c => c.name === name);
function descendants(node, name) { return (node?.children ?? []).flatMap(child => [...(child.name === name ? [child] : []), ...descendants(child, name)]); }
const text = node => node ? node.name === '#text' ? node.value : (node.children ?? []).map(text).join('') : '';
const clean = node => text(node).replace(/\s+/g, ' ').trim();
const first = (node, name) => descendants(node, name)[0];
const get = (node, name) => clean(first(node, name));
export function normalizeDoi(input) {
  const value = String(input ?? '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi\s*:\s*/iu, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>]+$/u.test(value) ? value : '';
}
export function parsePubmed(xml) {
  const tree = xmlTree(xml);
  if (first(tree, 'ERROR')) throw new Error('PubMed 返回错误');
  if (!first(tree, 'PubmedArticleSet')) throw new Error('PubMed 响应缺少文章集合');
  return descendants(tree, 'PubmedArticle').map(article => {
    const pmid = get(first(article, 'MedlineCitation'), 'PMID');
    const title = get(article, 'ArticleTitle');
    if (!pmid || !title) throw new Error('PubMed 文章缺少 ID 或题名');
    const doi = normalizeDoi(clean(descendants(article, 'ArticleId').find(a => a.attrs.IdType === 'doi')));
    const abstract = descendants(first(article, 'Abstract'), 'AbstractText').map(a => `${a.attrs.Label ? `${a.attrs.Label}: ` : ''}${clean(a)}`).join('\n');
    const pubdate = first(first(article, 'Journal'), 'PubDate');
    return { source: 'pubmed', id: pmid, doi, title, abstract, authors: descendants(article, 'Author').map(a => get(a, 'CollectiveName') || [get(a, 'ForeName'), get(a, 'LastName')].filter(Boolean).join(' ')).filter(Boolean), published: get(pubdate, 'Year') || get(pubdate, 'MedlineDate'), url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, preprint: false };
  });
}
export function parseArxiv(xml) {
  const tree = xmlTree(xml), feed = first(tree, 'feed');
  if (!feed) throw new Error('arXiv 响应缺少 feed');
  const totalText = get(feed, 'totalResults');
  if (!/^\d+$/u.test(totalText)) throw new Error('arXiv 响应缺少有效总数');
  const papers = children(feed, 'entry').map(entry => {
    const rawId = get(entry, 'id');
    if (rawId.includes('/api/errors')) throw new Error('arXiv 检索式错误');
    const id = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//u, '').replace(/v\d+$/u, '');
    if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/u.test(id)) throw new Error('arXiv 文章 ID 无效');
    const title = get(entry, 'title'); if (!title) throw new Error('arXiv 缺少题名');
    return { source: 'arxiv', id, doi: normalizeDoi(get(entry, 'doi')), title, abstract: get(entry, 'summary'), authors: children(entry, 'author').map(a => get(a, 'name')), published: get(entry, 'published'), url: `https://arxiv.org/abs/${id}`, preprint: true };
  });
  return { total: Number(totalText), papers };
}
export function parseBiorxiv(body) {
  let data; try { data = JSON.parse(body); } catch { throw new Error('bioRxiv 响应不是有效 JSON'); }
  const message = data.messages?.[0];
  if (!message || !['ok', 'no posts found'].includes(message.status)) throw new Error('bioRxiv 返回错误状态');
  if (message.status === 'no posts found') return { total: 0, papers: [] };
  if (!Array.isArray(data.collection) || !/^\d+$/u.test(String(message.total))) throw new Error('bioRxiv 响应缺少集合或总数');
  return { total: Number(message.total), papers: data.collection.map(item => {
    const doi = normalizeDoi(item.doi);
    if (!doi || typeof item.title !== 'string' || !item.title.trim()) throw new Error('bioRxiv 文章缺少 DOI 或题名');
    return { source: 'biorxiv', id: doi, doi, title: item.title, abstract: item.abstract ?? '', authors: String(item.authors ?? '').split(';').map(a => a.trim()).filter(Boolean), published: item.date ?? '', version: String(item.version ?? ''), category: item.category ?? '', url: `https://doi.org/${doi}`, preprint: true };
  }) };
}

export function createTransport({ fetchImpl = fetch, sleep = (ms, signal) => delay(ms, undefined, {signal}), timeoutMs = 30000, attempts = 3 } = {}) {
  const queues = new Map(), last = new Map();
  return async function request(url, {signal} = {}) {
    signal?.throwIfAborted();
    const target = new URL(url), host = target.hostname;
    const gap = host === 'export.arxiv.org' ? 3100 : host === 'eutils.ncbi.nlm.nih.gov' ? 350 : 1000;
    const predecessor = queues.get(host) ?? Promise.resolve();
    let unlock; const slot = new Promise(resolve => { unlock = resolve; }); queues.set(host, slot);
    await predecessor;
    try {
      signal?.throwIfAborted();
      for (let attempt = 0; attempt < attempts; attempt++) {
        signal?.throwIfAborted();
        const wait = gap - (Date.now() - (last.get(host) ?? 0)); if (wait > 0) await sleep(wait,signal);
        last.set(host, Date.now());
        let response;
        try { response = await fetchImpl(target, { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'hybrid-literature-radar/0.1 (research metadata monitor)' }, redirect: 'error' }); }
        catch { signal?.throwIfAborted(); if (attempt === attempts - 1) throw new Error(`${host} 网络请求失败`); await sleep(1000 * 2 ** attempt,signal); continue; }
        if (response.status === 429 || response.status >= 500) {
          const retry = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          if (attempt === attempts - 1) throw new Error(`${host} HTTP ${response.status}，重试耗尽`);
          await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 60000) : 1000 * 2 ** attempt,signal); continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`${host} HTTP ${response.status}`); }
        let size = 0; const chunks = [];
        try {
          for await (const chunk of response.body ?? []) {
            size += chunk.byteLength; if (size > 20_000_000) throw new Error(`${host} 响应超过 20 MB`);
            chunks.push(chunk);
          }
          return Buffer.concat(chunks).toString('utf8');
        } catch (error) {
          signal?.throwIfAborted();
          if (size > 20_000_000) throw error;
          if (attempt === attempts - 1) throw new Error(`${host} 响应读取失败或超时`);
          await sleep(1000 * 2 ** attempt,signal);
        }
      }
    } finally { unlock(); }
  };
}

function dateRange(from, to) {
  for (const d of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/u.test(d) || new Date(d).toISOString().slice(0, 10) !== d) throw new Error('日期必须为真实 YYYY-MM-DD');
  if (from > to) throw new Error('开始日期晚于结束日期');
}
export async function fetchSubscription(subscription, { from, to, maxRecords = 100, email, request = createTransport() }) {
  dateRange(from, to);
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000) throw new Error('maxRecords 必须为 1 至 1000');
  const papers = []; let total = 0;
  if (subscription.source === 'pubmed') {
    const params = new URLSearchParams({ db: 'pubmed', term: subscription.query, retmode: 'json', retmax: String(maxRecords), datetype: 'edat', mindate: from.replaceAll('-', '/'), maxdate: to.replaceAll('-', '/'), tool: 'hybrid-literature-radar', email });
    let data; try { data = JSON.parse(await request(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`)); } catch { throw new Error('PubMed 检索响应无效'); }
    const result = data.esearchresult;
    if (!result || result.ERROR || result.errorlist || !Array.isArray(result.idlist) || !/^\d+$/u.test(result.count)) throw new Error('PubMed 检索失败或响应结构无效');
    total = Number(result.count);
    if (result.idlist.some(id => !/^\d+$/u.test(id)) || result.idlist.length < Math.min(total, maxRecords)) throw new Error('PubMed ID 列表不完整');
    for (let start = 0; start < result.idlist.length; start += 200) {
      const ids = result.idlist.slice(start, start + 200);
      const batch = parsePubmed(await request(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${new URLSearchParams({ db: 'pubmed', id: ids.join(','), retmode: 'xml', tool: 'hybrid-literature-radar', email })}`));
      if (batch.length !== ids.length || batch.some(p => !ids.includes(p.id))) throw new Error('PubMed 全文元数据返回不完整');
      papers.push(...batch);
    }
  } else if (subscription.source === 'arxiv') {
    const range = `submittedDate:[${from.replaceAll('-', '')}0000 TO ${to.replaceAll('-', '')}2359]`;
    while (papers.length < maxRecords) {
      const pageSize = Math.min(100, maxRecords - papers.length);
      const params = new URLSearchParams({ search_query: `(${subscription.query}) AND ${range}`, start: String(papers.length), max_results: String(pageSize), sortBy: 'submittedDate', sortOrder: 'descending' });
      const page = parseArxiv(await request(`https://export.arxiv.org/api/query?${params}`));
      total = page.total;
      if (!page.papers.length && papers.length < total) throw new Error('arXiv 分页未返回预期条目');
      papers.push(...page.papers);
      if (papers.length >= total) break;
    }
  } else if (subscription.source === 'biorxiv') {
    let scanned = 0;
    do {
      const params = subscription.category ? `?${new URLSearchParams({ category: subscription.category })}` : '';
      const page = parseBiorxiv(await request(`https://api.biorxiv.org/details/biorxiv/${from}/${to}/${scanned}/json${params}`));
      total = page.total;
      if (!page.papers.length && scanned < total) throw new Error('bioRxiv 分页未返回预期条目');
      const selected = page.papers.slice(0, maxRecords - scanned);
      scanned += selected.length;
      papers.push(...selected.filter(paper => subscription.terms.some(term => `${paper.title}\n${paper.abstract}`.toLowerCase().includes(term.toLowerCase()))));
      if (scanned >= total || scanned >= maxRecords) break;
    } while (true);
    return { papers, total, scanned, truncated: scanned < total, filter: 'local-terms-any' };
  } else throw new Error('不支持的文献源');
  return { papers, total, scanned: papers.length, truncated: papers.length < total, filter: 'native-query' };
}
