"""Small standard-library data summary for the MIT workflow tutorial."""
import argparse
import csv
import json
import math
import statistics
from pathlib import Path


def summarize(path):
    with Path(path).open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ['sample_id', 'group', 'value']:
            raise ValueError('Expected sample_id,group,value columns in this order')
        rows = list(reader)
    if not rows:
        raise ValueError('No data records')
    seen, grouped = set(), {}
    for number, row in enumerate(rows, 1):
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f'Malformed data record {number}')
        identifier, group, text = [row[name].strip() for name in ['sample_id', 'group', 'value']]
        if not identifier or identifier in seen:
            raise ValueError(f'Missing or duplicate sample_id at data record {number}')
        if group not in {'A', 'B'}:
            raise ValueError(f'Unknown group at data record {number}')
        seen.add(identifier)
        bucket = grouped.setdefault(group, {'records': 0, 'values': []})
        bucket['records'] += 1
        if text:
            value = float(text)
            if not math.isfinite(value):
                raise ValueError(f'Non-finite value at data record {number}')
            bucket['values'].append(value)
    groups = {}
    for group, bucket in sorted(grouped.items()):
        values = bucket['values']
        groups[group] = {
            'records': bucket['records'], 'observed': len(values),
            'missing': bucket['records'] - len(values),
            'mean': statistics.mean(values) if values else None,
            'sample_sd': statistics.stdev(values) if len(values) > 1 else None,
        }
    return {'kind': 'fictional-teaching-data', 'records': len(rows), 'groups': groups,
            'scope': 'Descriptive calculation only; no hypothesis test or medical interpretation.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = summarize(args.data)
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps(result))
