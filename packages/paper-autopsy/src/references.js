const norm = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function normalizeDoi(value) {
  const doi = String(value ?? '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi\s*:\s*/iu, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>]+$/u.test(doi) ? doi : '';
}
export function findDois(text) {
  return [...new Set((text.match(/10\.\d{4,9}\/[^\s<>"\[\]]+/giu) ?? []).map(doi => {
    doi = doi.replace(/[.,;:]+$/u, '');
    while (doi.endsWith(')') && doi.split(')').length > doi.split('(').length) doi = doi.slice(0, -1);
    return normalizeDoi(doi);
  }).filter(Boolean))];
}
export function extractReferenceCandidates(document) {
  let inReferences = false, current = null, waitingForNumber = false;
  const results = [];
  const flush = () => { if (current?.raw.trim()) results.push({ ...current, id: `REF${String(results.length + 1).padStart(3, '0')}`, title: '', author: '', year: '', doi: findDois(current.raw)[0] ?? '', status: 'unresolved', note: '自动提取候选；未完成书目字段核对' }); current = null; };
  for (const page of document.pages) {
    if (page.needsReview) continue;
    for (const line of page.text.split(/\r?\n/u)) {
      const value = line.trim();
      if (/^(?:references|bibliography|参考文献)\s*[:：]?$/iu.test(value)) { flush(); inReferences = true; waitingForNumber=false; continue; }
      if (!inReferences || !value) continue;
      // Observed in the real 17-page paper: date/page footer and a floating figure
      // between numbered references must not become part of the first citation.
      if (/^(?:[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\s+)?\d+\s*\/\s*\d+\s*$/u.test(value)) continue;
      if (/^(?:(?:fig(?:ure)?\.?)\s*\d+|图\s*\d+)\s*[.:：]/iu.test(value)) { flush(); waitingForNumber=true; continue; }
      if (/^(?:appendix|supplementary|acknowledg|附录|致谢)/iu.test(value)) { flush(); inReferences = false; continue; }
      if (/^(?:\[\d+\]|\d+[.)])\s+/u.test(value)) { flush(); waitingForNumber=false; current = { page: page.page, raw: value }; }
      else if (waitingForNumber) continue;
      else if (current) current.raw += `\n${value}`;
      else current = { page: page.page, raw: value };
    }
  }
  flush();
  return results;
}
function metadata(work) {
  if (!work || !normalizeDoi(work.DOI) || !Array.isArray(work.title) || !work.title[0]) throw new Error('Crossref 元数据缺少 DOI 或题名');
  return { doi: normalizeDoi(work.DOI), title: work.title[0], authors: (work.author ?? []).map(a => a.family ?? a.name ?? '').filter(Boolean), years: [...new Set(['published', 'published-print', 'published-online', 'issued'].flatMap(key => work[key]?.['date-parts']?.map(p => String(p[0])) ?? []))], url: `https://doi.org/${normalizeDoi(work.DOI)}` };
}
export function compareReference(reference, candidate) {
  const conflicts = [];
  if (reference.doi && normalizeDoi(reference.doi) !== candidate.doi) conflicts.push('DOI不一致');
  if (reference.title && norm(reference.title) !== norm(candidate.title)) conflicts.push('题名不一致');
  if (reference.year && candidate.years.length && !candidate.years.includes(String(reference.year))) conflicts.push('年份不一致');
  if (reference.author && candidate.authors.length && !candidate.authors.some(a => norm(a) === norm(reference.author))) conflicts.push('作者不一致');
  if (conflicts.length) return { status: 'mismatch', note: conflicts.join('；') };
  if (!reference.title) return { status: 'unresolved', note: 'DOI有登记记录，但未提供待核对题名，不能确认整条引用' };
  if (!reference.doi && (!reference.author || !reference.year || !candidate.authors.length || !candidate.years.length)) return { status: 'unresolved', note: '题名检索候选缺少作者或年份交叉核对，不能自动确认' };
  if (reference.author && !candidate.authors.length || reference.year && !candidate.years.length) return { status: 'unresolved', note: '来源缺少可交叉核对字段' };
  return { status: 'verified', note: '所提供书目字段与Crossref记录匹配；未核验该文献是否支持正文主张' };
}
export function createCrossrefRequest({ fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 20000 } = {}) {
  let tail = Promise.resolve(), last = 0;
  return async url => {
    const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = 1050 - (Date.now() - last); if (wait > 0) await sleep(wait); last = Date.now();
        let response;
        try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'hybrid-paper-autopsy/0.1 (bibliographic metadata checks)' } }); }
        catch { if (attempt === 2) throw new Error('Crossref 网络请求失败'); await sleep(1000 * 2 ** attempt); continue; }
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (response.status === 429 || response.status >= 500) { const retry = Number(response.headers.get('retry-after')); await response.body?.cancel(); if (attempt === 2) throw new Error(`Crossref HTTP ${response.status}`); await sleep(retry > 0 ? Math.min(60000, retry * 1000) : 1000 * 2 ** attempt); continue; }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Crossref HTTP ${response.status}`); }
        const chunks = []; let size = 0;
        try {
          for await (const chunk of response.body ?? []) { size += chunk.byteLength; if (size > 2_000_000) throw new Error('Crossref 响应过大'); chunks.push(chunk); }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch { throw new Error('Crossref 响应读取失败或JSON无效'); }
      }
    } finally { release(); }
  };
}
export async function verifyReference(reference, { request = createCrossrefRequest(), email } = {}) {
  if (typeof reference.id !== 'string' || typeof reference.raw !== 'string') throw new Error('引用需有 id 与原始书目 raw');
  const result = { ...reference, checkedAt: new Date().toISOString(), provider: 'Crossref', status: 'unresolved', candidate: null };
  const doi = normalizeDoi(reference.doi);
  if (reference.doi && !doi) return { ...result, note: '输入 DOI 格式无效' };
  if (!doi && !reference.title?.trim()) return { ...result, note: '无 DOI 和题名，保留待核验' };
  try {
    const params = new URLSearchParams(email ? { mailto: email } : {});
    if (!doi) { params.set('query.title', reference.title); params.set('rows', '3'); }
    const endpoint = `https://api.crossref.org/works${doi ? `/${encodeURIComponent(doi)}` : ''}${params.size ? `?${params}` : ''}`;
    result.requestUrl = endpoint;
    const data = await request(endpoint);
    if (!data) return { ...result, note: 'Crossref未找到记录；可能属于其他注册机构或尚未登记，不据此断言伪造' };
    if (data.status !== 'ok') throw new Error('Crossref状态无效');
    if (doi) {
      const candidate = metadata(data.message);
      return { ...result, candidate, ...compareReference(reference, candidate) };
    }
    if (!Array.isArray(data.message?.items)) throw new Error('Crossref候选列表无效');
    const candidates = data.message.items.map(metadata);
    const matches = candidates.filter(candidate => norm(candidate.title) === norm(reference.title));
    if (matches.length !== 1) return { ...result, candidates, note: '没有唯一题名匹配候选，需人工核验' };
    return { ...result, candidate: matches[0], ...compareReference(reference, matches[0]) };
  } catch (error) { return { ...result, note: error.message }; }
}
