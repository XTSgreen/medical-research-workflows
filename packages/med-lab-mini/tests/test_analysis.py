import copy
import csv
import io
import json
import math
import statistics
import subprocess
import sys
from pathlib import Path
from importlib.resources import files

import mpmath as mp
import pytest

from med_lab_mini.core import load_csv, explore, make_plan, make_approval, approval_phrase, read_json, write_json
from med_lab_mini.analysis import run_analysis
from med_lab_mini.report import save_analysis, display, writer_records

mp.mp.dps = 45


def spec(method):
    return json.loads(files('med_lab_mini').joinpath(f'examples/{method}.json').read_text(encoding='utf-8'))


def csv_file(tmp_path, headers, rows):
    path = tmp_path / 'data.csv'
    with path.open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(headers)
        writer.writerows(rows)
    return path


def analyze(path, chosen):
    plan = make_plan(path, chosen)
    approval = make_approval(path, plan, 'test operator', 'Verified test design and method', approval_phrase(plan))
    result, prepared = run_analysis(path, plan, approval)
    return result, prepared, plan, approval


def t_pvalue(t, df):
    return mp.betainc(mp.mpf(df) / 2, mp.mpf('0.5'), 0, mp.mpf(df) / (mp.mpf(df) + mp.mpf(t) ** 2), regularized=True)


def t_critical(df, confidence):
    left, right = mp.mpf(0), mp.mpf(1000000)
    for _ in range(150):
        middle = (left + right) / 2
        if t_pvalue(middle, df) > 1 - mp.mpf(str(confidence)):
            left = middle
        else:
            right = middle
    return (left + right) / 2


def assert_measure(actual, expected, tol=1e-11):
    assert actual['state'] == 'finite'
    assert actual['value'] == pytest.approx(float(expected), rel=tol, abs=tol)


def test_welch_matches_independent_statistics_and_incomplete_beta(tmp_path):
    a, b = [1, 2, 3, 4, 5], [4, 7, 10, 13]
    path = csv_file(tmp_path, ['participant_id', 'group', 'score'], [[f'A{i}', 'A', v] for i, v in enumerate(a)] + [[f'B{i}', 'B', v] for i, v in enumerate(b)])
    artifact, _, _, _ = analyze(path, spec('welch'))
    result = artifact['result']
    diff = statistics.mean(a) - statistics.mean(b)
    va, vb = statistics.variance(a) / len(a), statistics.variance(b) / len(b)
    df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
    se = math.sqrt(va + vb)
    assert_measure(result['effect'], diff)
    assert_measure(result['statistic'], diff / se)
    assert_measure(result['p_value'], t_pvalue(diff / se, df))
    margin = t_critical(df, .95) * se
    assert_measure(result['interval']['low'], diff - margin)
    assert_measure(result['interval']['high'], diff + margin)
    assert result['degrees_of_freedom'] == pytest.approx(df)


def test_paired_t_matches_independent_difference_calculation(tmp_path):
    x, y = [8, 11, 9, 15, 13], [7, 8, 9, 11, 11]
    path = csv_file(tmp_path, ['participant_id', 'before', 'after'], [[f'P{i}', a, b] for i, (a, b) in enumerate(zip(x, y))])
    artifact, _, _, _ = analyze(path, spec('paired-t'))
    result = artifact['result']
    d = [a - b for a, b in zip(x, y)]
    estimate, se, df = statistics.mean(d), statistics.stdev(d) / math.sqrt(len(d)), len(d) - 1
    assert_measure(result['p_value'], t_pvalue(estimate / se, df))
    assert_measure(result['effect'], estimate)
    assert_measure(result['interval']['low'], estimate - t_critical(df, .95) * se)
    assert_measure(result['interval']['high'], estimate + t_critical(df, .95) * se)


def test_pearson_and_fisher_z_interval_match_independent_arithmetic(tmp_path):
    x, y = [1, 2, 3, 4, 5, 6], [7, 4, 6, 3, 2, 1]
    path = csv_file(tmp_path, ['participant_id', 'sleep_hours', 'fatigue'], [[f'P{i}', a, b] for i, (a, b) in enumerate(zip(x, y))])
    artifact, _, _, _ = analyze(path, spec('pearson'))
    result = artifact['result']
    dx, dy = [v - statistics.mean(x) for v in x], [v - statistics.mean(y) for v in y]
    r = sum(a * b for a, b in zip(dx, dy)) / math.sqrt(sum(a * a for a in dx) * sum(b * b for b in dy))
    p = t_pvalue(r * math.sqrt((len(x) - 2) / (1 - r * r)), len(x) - 2)
    margin = mp.sqrt(2) * mp.erfinv(mp.mpf('.95')) / mp.sqrt(len(x) - 3)
    assert_measure(result['effect'], r)
    assert_measure(result['p_value'], p)
    assert_measure(result['interval']['low'], mp.tanh(mp.atanh(r) - margin))
    assert_measure(result['interval']['high'], mp.tanh(mp.atanh(r) + margin))


def fisher_distribution(table, theta=mp.mpf(1)):
    a, b = table[0]
    c, d = table[1]
    row_total, col1, col2 = a + b, a + c, b + d
    weights = {k: mp.mpf(math.comb(col1, k)) * math.comb(col2, row_total - k) * theta ** k for k in range(max(0, row_total - col2), min(row_total, col1) + 1)}
    total = sum(weights.values())
    return {k: v / total for k, v in weights.items()}


def solve_log_theta(function, target, increasing):
    left, right = mp.mpf(-40), mp.mpf(40)
    for _ in range(160):
        middle = (left + right) / 2
        value = function(mp.exp(middle))
        if (value < target) == increasing:
            left = middle
        else:
            right = middle
    return mp.exp((left + right) / 2)


def fisher_csv(tmp_path, table):
    rows = []
    for i, group in enumerate(['A', 'B']):
        for j, event in enumerate(['yes', 'no']):
            rows.extend([[f'P{len(rows) + k}', group, event] for k in range(table[i][j])])
    return csv_file(tmp_path, ['participant_id', 'group', 'event'], rows)


def test_fisher_matches_combinatorial_p_and_noncentral_exact_interval(tmp_path):
    table = [[6, 2], [1, 4]]
    artifact, _, _, _ = analyze(fisher_csv(tmp_path, table), spec('fisher'))
    result = artifact['result']
    null = fisher_distribution(table)
    observed = table[0][0]
    p = sum(prob for prob in null.values() if prob <= null[observed] + mp.mpf('1e-40'))
    conditional = solve_log_theta(lambda theta: sum(k * prob for k, prob in fisher_distribution(table, theta).items()), mp.mpf(observed), True)
    lower = solve_log_theta(lambda theta: sum(prob for k, prob in fisher_distribution(table, theta).items() if k >= observed), mp.mpf('.025'), True)
    upper = solve_log_theta(lambda theta: sum(prob for k, prob in fisher_distribution(table, theta).items() if k <= observed), mp.mpf('.025'), False)
    assert_measure(result['p_value'], p)
    assert_measure(result['effect'], conditional, tol=1e-9)
    assert_measure(result['interval']['low'], lower, tol=1e-9)
    assert_measure(result['interval']['high'], upper, tol=1e-9)
    assert_measure(result['sample_odds_ratio'], 12)


def test_zero_cell_fisher_represents_boundary_infinity_without_invalid_json(tmp_path):
    artifact, _, _, _ = analyze(fisher_csv(tmp_path, [[4, 0], [1, 5]]), spec('fisher'))
    assert artifact['result']['effect'] == {'value': None, 'state': 'positive-infinity'}
    assert artifact['result']['interval']['high']['state'] == 'positive-infinity'
    json.dumps(artifact, allow_nan=False)


def test_complete_case_flow_is_analysis_specific_and_preserves_missing_record_numbers(tmp_path):
    path = tmp_path / 'teaching.csv'
    path.write_bytes(files('med_lab_mini').joinpath('examples/teaching.csv').read_bytes())
    welch, _, _, _ = analyze(path, spec('welch'))
    paired, _, _, _ = analyze(path, spec('paired-t'))
    assert welch['sample_flow'] == {'total': 10, 'included': 9, 'excluded': [{'record_number': 10, 'missing_fields': ['score']}]}
    assert paired['sample_flow']['included'] == 10


def test_duplicates_are_rejected_even_if_the_repeated_row_would_be_missing(tmp_path):
    path = csv_file(tmp_path, ['participant_id', 'group', 'score'], [['P1', 'A', 1], ['P1', 'A', 'NA'], ['P2', 'B', 2]])
    with pytest.raises(ValueError, match='重复'):
        make_plan(path, spec('welch'))


@pytest.mark.parametrize('bad', ['inf', '-inf', 'NaN-not-declared', 'not-numeric'])
def test_bad_numeric_cells_are_not_silently_dropped(tmp_path, bad):
    path = csv_file(tmp_path, ['participant_id', 'group', 'score'], [['P1', 'A', 1], ['P2', 'A', 2], ['P3', 'B', 3], ['P4', 'B', bad]])
    with pytest.raises(ValueError, match='解析|非有限'):
        make_plan(path, spec('welch'))


@pytest.mark.parametrize('method,headers,rows', [
    ('welch', ['participant_id', 'group', 'score'], [['P1', 'A', 1], ['P2', 'A', 1], ['P3', 'B', 2], ['P4', 'B', 2]]),
    ('paired-t', ['participant_id', 'before', 'after'], [['P1', 2, 1], ['P2', 3, 2]]),
    ('pearson', ['participant_id', 'sleep_hours', 'fatigue'], [['P1', 1, 2], ['P2', 1, 3], ['P3', 1, 4], ['P4', 1, 5]]),
    ('fisher', ['participant_id', 'group', 'event'], [['P1', 'A', 'yes'], ['P2', 'B', 'yes']]),
])
def test_degenerate_designs_fail_with_actionable_error(tmp_path, method, headers, rows):
    with pytest.raises(ValueError, match='要求'):
        make_plan(csv_file(tmp_path, headers, rows), spec(method))


def test_unknown_groups_and_design_parameters_are_not_ignored(tmp_path):
    path = csv_file(tmp_path, ['participant_id', 'group', 'score'], [['P1', 'A', 1], ['P2', 'A', 2], ['P3', 'B', 3], ['P4', 'C', 4]])
    with pytest.raises(ValueError, match='未声明分组'):
        make_plan(path, spec('welch'))
    chosen = spec('welch')
    chosen['row_levels'] = ['A', 'B']
    with pytest.raises(ValueError, match='额外参数'):
        make_plan(path, chosen)


def test_exploration_reports_mixed_types_missing_and_iqr_outliers_without_removal(tmp_path):
    path = csv_file(tmp_path, ['id', 'numeric', 'mixed'], [['P1', 1, 1], ['P2', 2, 'bad'], ['P3', 3, 'NA'], ['P4', 4, 4], ['P5', 100, 5]])
    result = explore(load_csv(path), ['', 'NA'])
    assert result['records'] == 5
    assert result['fields'][1]['summary']['iqr_outlier_count'] == 1
    assert result['fields'][1]['summary']['n'] == 5
    assert result['fields'][2]['type_hint'] == 'mixed'
    assert result['fields'][2]['missing'] == 1


def test_failed_json_serialization_leaves_no_partial_artifact(tmp_path):
    path = tmp_path / 'bad.json'
    with pytest.raises(TypeError):
        write_json(path, {'invalid': {1, 2}})
    assert not path.exists()


def test_csv_duplicate_headers_and_malformed_rows_are_rejected(tmp_path):
    path = tmp_path / 'bad.csv'
    path.write_text('id,id\nP1,1\n', encoding='utf-8')
    with pytest.raises(ValueError, match='重复'):
        load_csv(path)
    path.write_text('id,value\nP1,1,extra\n', encoding='utf-8')
    with pytest.raises(ValueError, match='字段数'):
        load_csv(path)


def test_no_test_runs_before_explicit_approval_and_changed_data_or_plan_invalidates_approval(tmp_path, monkeypatch):
    path = csv_file(tmp_path, ['participant_id', 'group', 'score'], [['P1', 'A', 1], ['P2', 'A', 2], ['P3', 'B', 3], ['P4', 'B', 5]])
    from med_lab_mini import analysis
    called = []
    monkeypatch.setattr(analysis.stats, 'ttest_ind', lambda *a, **k: called.append(True))
    plan = make_plan(path, spec('welch'))
    with pytest.raises(ValueError, match='确认'):
        run_analysis(path, plan, {})
    assert not called
    with pytest.raises(ValueError, match='确认语句'):
        make_approval(path, plan, 'author', 'checked', 'yes')
    approval = make_approval(path, plan, 'author', 'checked', approval_phrase(plan))
    changed = copy.deepcopy(plan)
    changed['spec']['rationale'] = 'Changed reason'
    with pytest.raises(ValueError, match='确认'):
        run_analysis(path, changed, approval)
    path.write_text(path.read_text() + 'P5,B,6\n')
    with pytest.raises(ValueError, match='数据已改变'):
        run_analysis(path, plan, approval)
    assert not called


def test_report_figures_and_x4_records_are_derived_from_the_actual_approved_result(tmp_path):
    a = [[f'A{i}', 'A', n] for i, n in enumerate([1, 2, 3, 4])]
    b = [[f'B{i}', 'B', n] for i, n in enumerate([4, 6, 8, 10])]
    artifact, prepared, _, _ = analyze(csv_file(tmp_path, ['participant_id', 'group', 'score'], a + b), spec('welch'))
    output = tmp_path / 'report'
    save_analysis(output, artifact, prepared)
    assert (output / 'figure.png').read_bytes().startswith(b'\x89PNG')
    assert '<svg' in (output / 'figure.svg').read_text(encoding='utf-8')
    saved = read_json(output / 'analysis.json')
    assert display(saved['result']['effect']) in (output / 'report.md').read_text(encoding='utf-8')
    records = read_json(output / 'writer-records.json')
    assert records['schemaVersion'] == 1
    assert display(saved['result']['effect']) in next(r['text'] for r in records['records'] if r['id'] == 'result')
    assert saved['figure']['analysis_records'] == 8
    with pytest.raises(FileExistsError):
        save_analysis(output, artifact, prepared)


def test_x4_export_keeps_variables_and_zero_p_value_explanation(tmp_path):
    path = csv_file(tmp_path, ['participant_id', 'sleep_hours', 'fatigue'], [[f'P{i}', i, 2 * i] for i in range(1, 7)])
    artifact, _, _, _ = analyze(path, spec('pearson'))
    assert artifact['result']['p_value']['value'] == 0
    exported = writer_records(artifact)
    text = '\n'.join(r['text'] for r in exported['records'])
    assert 'sleep_hours' in text and 'fatigue' in text
    assert artifact['plan']['spec']['question'] in text
    assert 'floating-point zero returned' in text


def test_cli_requires_approval_input_and_survives_separate_processes(tmp_path):
    def run(*args, input=None):
        return subprocess.run([sys.executable, '-m', 'med_lab_mini.cli', *map(str, args)], input=input, text=True, capture_output=True, encoding='utf-8')
    example = tmp_path / 'example'
    assert run('example', '--output', example).returncode == 0
    data, plan_path, approval_path = example / 'teaching.csv', tmp_path / 'plan.json', tmp_path / 'approval.json'
    result = run('plan', '--data', data, '--spec', example / 'welch.json', '--output', plan_path)
    assert result.returncode == 0, result.stderr
    assert run('run', '--data', data, '--plan', plan_path, '--output', tmp_path / 'unapproved').returncode == 2
    plan = read_json(plan_path)
    result = run('approve', '--data', data, '--plan', plan_path, '--output', approval_path, '--reviewer', 'Test author', '--note', 'Teaching fixture only', input=approval_phrase(plan) + '\n')
    assert result.returncode == 0, result.stderr
    result = run('run', '--data', data, '--plan', plan_path, '--approval', approval_path, '--output', tmp_path / 'approved')
    assert result.returncode == 0, result.stderr
    assert (tmp_path / 'approved' / 'report.md').exists()
