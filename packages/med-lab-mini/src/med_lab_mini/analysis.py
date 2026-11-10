"""Fixed SciPy methods; no hypothesis test is called before approval validation."""
import math
import platform

import numpy as np
import scipy
from scipy import stats

from . import __version__
from .core import check_approval, now


def number(value):
    value = float(value)
    if math.isfinite(value):
        return {'value': value, 'state': 'finite'}
    return {'value': None, 'state': 'positive-infinity' if value == math.inf else 'negative-infinity' if value == -math.inf else 'undefined'}


def _compute(prepared, spec):
    records, method, cl = prepared['complete'], spec['method'], spec['confidence_level']
    result = {'method': method, 'alternative': 'two-sided', 'confidence_level': cl, 'direction': '', 'effect_name': '', 'degrees_of_freedom': None, 'unit': spec['units'][spec['columns']['value']] if method == 'welch' else spec['units'][spec['columns']['x']] if method == 'paired-t' else 'dimensionless'}
    if method == 'welch':
        a, b = [np.asarray([r['value'] for r in records if r['group'] == label]) for label in spec['groups']]
        va, vb = np.var(a, ddof=1) / len(a), np.var(b, ddof=1) / len(b)
        se = math.sqrt(va + vb)
        df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
        estimate = float(np.mean(a) - np.mean(b))
        statistic, p = stats.ttest_ind(a, b, equal_var=False, alternative='two-sided', nan_policy='raise')
        margin = stats.t.ppf((1 + cl) / 2, df) * se
        low, high = estimate - margin, estimate + margin
        result.update(effect_name='mean_difference', direction=f"{spec['groups'][0]} minus {spec['groups'][1]}", degrees_of_freedom=float(df))
    elif method == 'paired-t':
        x, y = np.asarray([r['x'] for r in records]), np.asarray([r['y'] for r in records])
        differences = x - y
        estimate, df = float(np.mean(differences)), len(differences) - 1
        statistic, p = stats.ttest_rel(x, y, alternative='two-sided', nan_policy='raise')
        margin = stats.t.ppf((1 + cl) / 2, df) * np.std(differences, ddof=1) / math.sqrt(len(differences))
        low, high = estimate - margin, estimate + margin
        result.update(effect_name='paired_mean_difference', direction=f"{spec['columns']['x']} minus {spec['columns']['y']}", degrees_of_freedom=float(df))
    elif method == 'pearson':
        x, y = np.asarray([r['x'] for r in records]), np.asarray([r['y'] for r in records])
        estimate, p = stats.pearsonr(x, y, alternative='two-sided')
        estimate = float(estimate)
        if abs(estimate) >= 1:
            low = high = estimate
        else:
            z = np.arctanh(estimate)
            margin = stats.norm.ppf((1 + cl) / 2) / math.sqrt(len(x) - 3)
            low, high = np.tanh(z - margin), np.tanh(z + margin)
        statistic = estimate
        result.update(effect_name='pearson_r', direction='linear association; not a causal effect', degrees_of_freedom=float(len(x) - 2))
    else:
        table = np.asarray(prepared['descriptives']['table'], dtype=np.int64)
        sample_odds, p = stats.fisher_exact(table, alternative='two-sided')
        conditional = stats.contingency.odds_ratio(table, kind='conditional')
        estimate = conditional.statistic
        interval = conditional.confidence_interval(confidence_level=cl, alternative='two-sided')
        low, high, statistic = interval.low, interval.high, sample_odds
        result.update(effect_name='conditional_odds_ratio', direction=f"odds({spec['column_levels'][0]} vs {spec['column_levels'][1]}) in {spec['row_levels'][0]} divided by {spec['row_levels'][1]}", sample_odds_ratio=number(sample_odds), table=table.tolist(), interval_method='exact conditional interval; estimate is conditional MLE, not sample odds ratio')
    if not math.isfinite(float(p)) or not 0 <= p <= 1:
        raise ValueError('检验未产生有效P值，停止生成结论')
    if method != 'fisher' and any(not math.isfinite(float(v)) for v in [statistic, estimate, low, high]):
        raise ValueError('计算结果非有限，请核对数据尺度、方差与方法适用性')
    result.update(statistic=number(statistic), effect=number(estimate), interval={'low': number(low), 'high': number(high)}, p_value=number(p), p_value_note='floating-point zero returned; do not interpret as mathematically exact zero' if p == 0 else None)
    return result


def run_analysis(data_path, plan, approval):
    dataset, prepared = check_approval(data_path, plan, approval)
    result = _compute(prepared, plan['spec'])
    artifact = {'schema_version': 1, 'at': now(), 'data_sha256': dataset['sha256'], 'approval': approval, 'plan': plan, 'sample_flow': {k: prepared[k] for k in ['total', 'included', 'excluded']}, 'descriptives': prepared['descriptives'], 'result': result, 'environment': {'med_lab_mini': __version__, 'python': platform.python_version(), 'numpy': np.__version__, 'scipy': scipy.__version__}, 'notes': ['结果为预先指定的单次分析，工具不证明研究设计、数据真实性或人工判断正确。', '多个计划或探索性尝试会产生多重比较问题，本工具不自动管理跨计划的检验家族。', '未调整混杂、选择偏倚或测量误差；观察性关联不得直接解释为因果或临床获益。']}
    return artifact, prepared
