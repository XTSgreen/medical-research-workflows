"""Validated CSV input, declared analysis plans and explicit approvals."""
import csv
import hashlib
import io
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


METHODS = {
    'welch': {'design': 'independent', 'columns': {'group', 'value'}, 'basis': 'Independent groups; unequal-variance t test; mean(groups[0]) minus mean(groups[1]).', 'url': 'https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_ind.html'},
    'paired-t': {'design': 'paired-wide', 'columns': {'x', 'y'}, 'basis': 'One complete pair per participant; paired mean difference x minus y; t interval on differences.', 'url': 'https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_rel.html'},
    'pearson': {'design': 'independent', 'columns': {'x', 'y'}, 'basis': 'Independent participants with two continuous measurements; linear correlation, two-sided test and Fisher-z confidence interval.', 'url': 'https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.pearsonr.html'},
    'fisher': {'design': 'independent', 'columns': {'row', 'column'}, 'basis': 'Independent participant-level binary categories; 2x2 Fisher two-sided test; conditional odds ratio with exact conditional interval.', 'url': 'https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.contingency.odds_ratio.html'},
}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write_json(path, value):
    # Exclusive create, including plans and approval records.
    payload = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    with Path(path).open('x', encoding='utf-8') as stream:
        stream.write(payload)


def load_csv(path):
    raw = Path(path).read_bytes()
    if len(raw) > 20_000_000:
        raise ValueError('CSV超过20 MB，请先按预先声明的研究范围整理')
    text = raw.decode('utf-8-sig')
    reader = csv.reader(io.StringIO(text, newline=''), strict=True)
    try:
        headers = [cell.strip() for cell in next(reader)]
    except StopIteration:
        raise ValueError('CSV为空')
    if not headers or len(headers) > 200 or any(not h for h in headers) or len(headers) != len(set(headers)):
        raise ValueError('CSV列名为空、重复或超过200列')
    rows = []
    for record, values in enumerate(reader, 1):
        if len(values) != len(headers):
            raise ValueError(f'CSV记录{record}字段数与表头不一致')
        rows.append(dict(zip(headers, [v.strip() for v in values])))
        if len(rows) > 100000:
            raise ValueError('CSV超过100000条记录')
    if not rows:
        raise ValueError('CSV没有数据记录')
    return {'sha256': digest(raw), 'headers': headers, 'rows': rows, 'row_count': len(rows)}


def numeric(value, column, record):
    try:
        result = float(value)
    except ValueError:
        raise ValueError(f'记录{record}的数值字段{column}无法解析；未静默删除')
    if not math.isfinite(result):
        raise ValueError(f'记录{record}的{column}含非有限数值，且未声明为缺失标记')
    return result


def summarize(values):
    a = np.asarray(values, dtype=float)
    if not len(a):
        return {'n': 0}
    q1, median, q3 = np.quantile(a, [0.25, 0.5, 0.75])
    result = {'n': len(a), 'mean': float(np.mean(a)), 'sd': float(np.std(a, ddof=1)) if len(a) > 1 else None, 'min': float(np.min(a)), 'q1': float(q1), 'median': float(median), 'q3': float(q3), 'max': float(np.max(a)), 'iqr_outlier_count': int(np.count_nonzero((a < q1 - 1.5 * (q3 - q1)) | (a > q3 + 1.5 * (q3 - q1))))}
    if any(isinstance(v, float) and not math.isfinite(v) for v in result.values()):
        raise ValueError('数值计算溢出，请核对数据单位和范围')
    return result


def explore(dataset, missing_tokens):
    if not isinstance(missing_tokens, list) or any(not isinstance(s, str) for s in missing_tokens) or '' not in missing_tokens:
        raise ValueError('缺失标记需为包含空字符串的文本数组')
    fields = []
    for column in dataset['headers']:
        present = [r[column] for r in dataset['rows'] if r[column] not in missing_tokens]
        numbers, bad = [], 0
        for value in present:
            try:
                number = float(value)
                if not math.isfinite(number):
                    raise ValueError()
                numbers.append(number)
            except ValueError:
                bad += 1
        counts = {}
        for value in present:
            counts[value] = counts.get(value, 0) + 1
        kind = 'numeric' if present and not bad else 'mixed' if numbers else 'categorical'
        fields.append({'column': column, 'type_hint': kind, 'missing': dataset['row_count'] - len(present), 'present': len(present), 'numeric_parse_failures': bad, 'summary': summarize(numbers) if kind == 'numeric' else None, 'unique_count': len(counts)})
    return {'schema_version': 1, 'data_sha256': dataset['sha256'], 'records': dataset['row_count'], 'missing_tokens': missing_tokens, 'fields': fields, 'notes': ['类型仅为字段格式提示，不能推断测量尺度或自动选统计方法。', 'IQR异常点只作提示，不自动排除；单个ID数字列也可能被识别为数值。', '为避免在探索文件中复制标识信息，不输出类别取值列表。']}


def validate_spec(spec, dataset):
    required = {'schema_version', 'question', 'method', 'design', 'id_column', 'columns', 'units', 'missing_tokens', 'missing_policy', 'confidence_level', 'analysis_role', 'rationale', 'assumptions', 'multiplicity_note'}
    optional = {'groups', 'row_levels', 'column_levels'}
    if not isinstance(spec, dict) or set(spec) - required - optional or not required <= set(spec) or spec['schema_version'] != 1:
        raise ValueError('分析规格字段缺失或含未知字段')
    method = spec['method']
    if not isinstance(method, str) or method not in METHODS or spec['design'] != METHODS[method]['design']:
        raise ValueError('方法与声明的研究设计不匹配')
    expected_optional = {'groups'} if method == 'welch' else {'row_levels', 'column_levels'} if method == 'fisher' else set()
    if set(spec) & optional != expected_optional:
        raise ValueError('分组参数与所选方法不匹配，拒绝忽略额外参数')
    for key in ['question', 'rationale', 'multiplicity_note']:
        if not isinstance(spec[key], str) or not spec[key].strip():
            raise ValueError(f'需明确填写{key}')
    if not isinstance(spec['assumptions'], list) or not spec['assumptions'] or any(not isinstance(s, str) or not s.strip() for s in spec['assumptions']):
        raise ValueError('需声明独立性、分布与方法适用假设')
    if spec['missing_policy'] != 'complete-case' or spec['analysis_role'] != 'single-primary':
        raise ValueError('本版本只执行明确声明的完整个案单一主要检验')
    cl = spec['confidence_level']
    if isinstance(cl, bool) or not isinstance(cl, (int, float)) or not 0 < cl < 1:
        raise ValueError('confidence_level必须介于0和1之间')
    if not isinstance(spec['columns'], dict) or set(spec['columns']) != METHODS[method]['columns']:
        raise ValueError('分析字段与方法要求不匹配')
    selected = list(spec['columns'].values())
    if any(not isinstance(c, str) or c not in dataset['headers'] for c in selected) or len(selected) != len(set(selected)):
        raise ValueError('分析列不存在或重复使用同一列')
    id_column = spec['id_column']
    if not isinstance(id_column, str) or id_column not in dataset['headers'] or id_column in selected:
        raise ValueError('需提供独立且存在的受试者ID列')
    missing = spec['missing_tokens']
    if not isinstance(missing, list) or '' not in missing or any(not isinstance(s, str) or s != s.strip() for s in missing):
        raise ValueError('missing_tokens需包含空字符串，且不能带首尾空格')
    ids = [r[id_column] for r in dataset['rows']]
    if any(i in missing for i in ids) or len(ids) != len(set(ids)):
        raise ValueError('受试者ID缺失或重复；本版本要求一人一行，不能把重复测量当独立样本')
    numeric_columns = [spec['columns'][k] for k in ({'value'} if method == 'welch' else {'x', 'y'} if method in {'paired-t', 'pearson'} else set())]
    if not isinstance(spec['units'], dict) or set(spec['units']) != set(numeric_columns) or any(not isinstance(v, str) or not v.strip() for v in spec['units'].values()):
        raise ValueError('每个数值分析字段需要明确且完整的单位声明')
    if method == 'paired-t' and len(set(spec['units'].values())) != 1:
        raise ValueError('配对差值要求两列使用同一单位，请先按有依据的规则换算')
    for key in (['groups'] if method == 'welch' else ['row_levels', 'column_levels'] if method == 'fisher' else []):
        levels = spec.get(key)
        if not isinstance(levels, list) or len(levels) != 2 or any(not isinstance(s, str) or not s or s in missing or s != s.strip() for s in levels) or len(set(levels)) != 2:
            raise ValueError(f'{key}需有两个不同且非缺失的明确类别，顺序决定效应方向')
    return spec


def prepare(dataset, spec):
    validate_spec(spec, dataset)
    method, columns, missing = spec['method'], spec['columns'], spec['missing_tokens']
    complete, excluded = [], []
    for index, row in enumerate(dataset['rows'], 1):
        if method == 'welch' and row[columns['group']] not in missing and row[columns['group']] not in spec['groups']:
            raise ValueError(f'记录{index}出现未声明分组；未将其静默排除')
        if method == 'fisher':
            for role, levels in [('row', spec['row_levels']), ('column', spec['column_levels'])]:
                if row[columns[role]] not in missing and row[columns[role]] not in levels:
                    raise ValueError(f'记录{index}出现未声明二分类值')
        absent = [column for column in columns.values() if row[column] in missing]
        if absent:
            excluded.append({'record_number': index, 'missing_fields': absent})
            continue
        parsed = {role: numeric(row[column], column, index) if role in ('value', 'x', 'y') else row[column] for role, column in columns.items()}
        complete.append(parsed)
    if not complete:
        raise ValueError('没有可用于所选分析的完整记录')
    if method == 'welch':
        groups = [[r['value'] for r in complete if r['group'] == g] for g in spec['groups']]
        if min(map(len, groups)) < 2 or sum(float(np.var(a, ddof=1)) for a in groups) <= 0:
            raise ValueError('Welch要求每组至少2例且不能两组均为常数')
        summary = {g: summarize(a) for g, a in zip(spec['groups'], groups)}
    elif method in ('paired-t', 'pearson'):
        x, y = np.array([r['x'] for r in complete]), np.array([r['y'] for r in complete])
        if method == 'paired-t' and (len(x) < 2 or float(np.var(x - y, ddof=1)) <= 0):
            raise ValueError('配对t要求至少2个完整配对且差值方差大于0')
        if method == 'pearson' and (len(x) < 4 or np.ptp(x) == 0 or np.ptp(y) == 0):
            raise ValueError('Pearson区间要求至少4例，且两个变量均非常数')
        summary = {'x': summarize(x), 'y': summarize(y)}
        if method == 'paired-t':
            summary['difference_x_minus_y'] = summarize(x - y)
    else:
        table = [[sum(r['row'] == a and r['column'] == b for r in complete) for b in spec['column_levels']] for a in spec['row_levels']]
        if min(sum(row) for row in table) == 0 or min(map(sum, zip(*table))) == 0:
            raise ValueError('Fisher要求两行两列的边际计数均大于0')
        summary = {'table': table, 'rows': spec['row_levels'], 'columns': spec['column_levels']}
    return {'complete': complete, 'excluded': excluded, 'included': len(complete), 'total': dataset['row_count'], 'descriptives': summary}


def make_plan(data_path, spec):
    dataset = load_csv(data_path)
    prepared = prepare(dataset, spec)
    basis = {key: METHODS[spec['method']][key] for key in ['basis', 'url']}
    return {'schema_version': 1, 'created_at': now(), 'data_sha256': dataset['sha256'], 'spec': spec, 'preflight': {k: v for k, v in prepared.items() if k != 'complete'}, 'method_basis': basis, 'exploration': explore(dataset, spec['missing_tokens'])}


def check_plan(data_path, plan):
    if not isinstance(plan, dict) or plan.get('schema_version') != 1:
        raise ValueError('计划文件结构无效')
    dataset = load_csv(data_path)
    if plan.get('data_sha256') != dataset['sha256']:
        raise ValueError('数据已改变，原计划与确认失效，请重新生成计划')
    prepared = prepare(dataset, plan['spec'])
    basis = {key: METHODS[plan['spec']['method']][key] for key in ['basis', 'url']}
    if plan.get('preflight') != {k: v for k, v in prepared.items() if k != 'complete'} or plan.get('method_basis') != basis or plan.get('exploration') != explore(dataset, plan['spec']['missing_tokens']):
        raise ValueError('计划中的描述、方法或探索与当前数据不一致')
    return dataset, prepared


def approval_phrase(plan):
    return f"APPROVE {digest(canonical(plan))[:12]}"


def make_approval(data_path, plan, reviewer, note, phrase):
    check_plan(data_path, plan)
    if not isinstance(reviewer, str) or not reviewer.strip() or not isinstance(note, str) or not note.strip():
        raise ValueError('需填写核对者及针对本计划的核对说明')
    if phrase != approval_phrase(plan):
        raise ValueError('确认语句不匹配，未批准分析')
    return {'schema_version': 1, 'at': now(), 'reviewer': reviewer.strip(), 'note': note.strip(), 'data_sha256': plan['data_sha256'], 'plan_sha256': digest(canonical(plan)), 'action': 'explicit-method-approval'}


def check_approval(data_path, plan, approval):
    dataset, prepared = check_plan(data_path, plan)
    if not isinstance(approval, dict) or approval.get('schema_version') != 1 or approval.get('action') != 'explicit-method-approval' or approval.get('data_sha256') != dataset['sha256'] or approval.get('plan_sha256') != digest(canonical(plan)) or not approval.get('reviewer') or not approval.get('note') or not approval.get('at'):
        raise ValueError('缺少与当前数据及完整计划一致的明确方法确认，拒绝执行检验')
    return dataset, prepared
