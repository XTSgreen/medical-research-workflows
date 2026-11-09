"""One small arXiv metadata query; no PDF download, retries or scheduled polling."""
import argparse
from datetime import datetime, timezone
import json
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ATOM = '{http://www.w3.org/2005/Atom}'
ARXIV = '{http://arxiv.org/schemas/atom}'
OPEN = '{http://a9.com/-/spec/opensearch/1.1/}'


def parse_feed(raw):
    feed = ET.fromstring(raw)
    total_text = feed.findtext(OPEN + 'totalResults')
    if feed.tag != ATOM + 'feed' or total_text is None:
        raise ValueError('Expected Atom feed with an explicit totalResults count')
    total = int(total_text)
    if total < 0:
        raise ValueError('Expected nonnegative totalResults')
    records = []
    for entry in feed.findall(ATOM + 'entry'):
        identifier = entry.findtext(ATOM + 'id', '')
        if not identifier.startswith(('http://arxiv.org/abs/', 'https://arxiv.org/abs/')):
            raise ValueError('Expected a versioned arXiv article record, not an API error entry')
        arxiv_id = identifier.split('/abs/', 1)[1]
        if not re.search(r'v[1-9][0-9]*$', arxiv_id):
            raise ValueError('Expected an explicit article version')
        records.append({
            'id': arxiv_id,
            'url': identifier.replace('http://', 'https://', 1),
            'title': ' '.join(entry.findtext(ATOM + 'title', '').split()),
            'authors': [author.findtext(ATOM + 'name', '') for author in entry.findall(ATOM + 'author')],
            'published': entry.findtext(ATOM + 'published'),
            'updated': entry.findtext(ATOM + 'updated'),
            'doi': entry.findtext(ARXIV + 'doi'),
            'journal_reference': entry.findtext(ARXIV + 'journal_ref'),
            'peer_review_status': 'Not independently established by this metadata exercise.',
        })
    if not len(records) <= min(total, 5):
        raise ValueError('Inconsistent count or more than the requested five entries')
    return total, records


def run(query, output):
    destination = Path(output)
    if destination.exists():
        raise FileExistsError('Use a new output directory')
    url = 'https://export.arxiv.org/api/query?' + urlencode({
        'search_query': query, 'start': 0, 'max_results': 5,
        'sortBy': 'submittedDate', 'sortOrder': 'descending',
    })
    request = Request(url, headers={'User-Agent': 'XTSgreen-workflow-tutorial/0.1 (+https://github.com/XTSgreen/medical-research-workflows)'})
    with urlopen(request, timeout=30) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError('Response unexpectedly exceeds the small teaching request')
    total, records = parse_feed(raw)
    result = {'source': 'arxiv', 'query': query, 'url': url,
              'retrieved_utc': datetime.now(timezone.utc).isoformat(),
              'requested': 5, 'total_results': total, 'returned': len(records),
              'complete_search': total <= len(records), 'records': records,
              'scope': 'Metadata discovery only. Read and verify the source before using it as evidence.'}
    destination.mkdir(parents=True)
    (destination / 'feed.xml').write_bytes(raw)
    (destination / 'records.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'total_results': total, 'returned': len(records), 'complete_search': result['complete_search']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--query', default='ti:prediction AND all:clinical')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.query, args.output)))
