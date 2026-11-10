"""Deterministic reports and figures sourced from the approved numeric analysis."""
import html
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.ticker import MaxNLocator
import numpy as np

from .core import write_json


def display(n):
    if n['state'] == 'finite':
        return f"{n['value']:.8g}"
    return {'positive-infinity': '+infinity (boundary estimate)', 'negative-infinity': '-infinity', 'undefined': 'not estimable'}[n['state']]


def safe(value):
    return html.escape(str(value)).replace('|', '\\|').replace('\n', '<br>')


def make_figure(artifact, prepared, output):
    spec, records = artifact['plan']['spec'], prepared['complete']
    available = {f.name for f in font_manager.fontManager.ttflist}
    selected = next((name for name in ['Microsoft YaHei', 'Noto Sans CJK SC', 'SimHei'] if name in available), 'DejaVu Sans')
    with plt.rc_context({'font.family': selected, 'axes.unicode_minus': False, 'svg.fonttype': 'none'}):
        fig, ax = plt.subplots(figsize=(7.2, 4.8), constrained_layout=True)
        method = spec['method']
        shown = 0
        if method == 'welch':
            for i, group in enumerate(spec['groups']):
                values = np.asarray([r['value'] for r in records if r['group'] == group])
                sample = values[np.linspace(0, len(values) - 1, min(2000, len(values)), dtype=int)]
                ax.scatter(i + np.linspace(-0.16, 0.16, len(sample)), sample, alpha=.55, s=14, label=group)
                ax.plot([i - .23, i + .23], [np.mean(values)] * 2, color='black', linewidth=2)
                shown += len(sample)
            ax.set_xticks([0, 1], spec['groups'])
            ax.set_ylabel(f"{spec['columns']['value']} ({spec['units'][spec['columns']['value']]})")
            ax.set_title('Independent observations; black bars show group means')
        elif method == 'paired-t':
            sample = records[:200]
            for row in sample:
                ax.plot([0, 1], [row['x'], row['y']], marker='o', markersize=3, alpha=.35, color='#26635c')
            ax.set_xticks([0, 1], [spec['columns']['x'], spec['columns']['y']])
            ax.set_ylabel(next(iter(spec['units'].values())))
            ax.set_title('Paired measurements; each line is one participant')
            shown = len(sample)
        elif method == 'pearson':
            sample = [records[i] for i in np.linspace(0, len(records) - 1, min(2000, len(records)), dtype=int)]
            ax.scatter([r['x'] for r in sample], [r['y'] for r in sample], alpha=.6, s=16, color='#26635c')
            ax.set_xlabel(f"{spec['columns']['x']} ({spec['units'][spec['columns']['x']]})")
            ax.set_ylabel(f"{spec['columns']['y']} ({spec['units'][spec['columns']['y']]})")
            ax.set_title('Observed pairs; no causal interpretation')
            shown = len(sample)
        else:
            table = np.asarray(artifact['result']['table'])
            for i, label in enumerate(spec['column_levels']):
                ax.bar(np.arange(2) + (i - .5) * .34, table[:, i], width=.34, label=label)
            ax.set_xticks([0, 1], spec['row_levels'])
            ax.set_ylabel('Participant count')
            ax.yaxis.set_major_locator(MaxNLocator(integer=True))
            ax.set_title('Observed 2x2 counts; no error bars')
            ax.legend()
            shown = len(records)
        ax.spines[['top', 'right']].set_visible(False)
        ax.grid(axis='y', alpha=.15)
        fig.savefig(Path(output) / 'figure.png', dpi=180)
        fig.savefig(Path(output) / 'figure.svg')
        plt.close(fig)
    return {'font': selected, 'analysis_records': len(records), 'displayed_records': shown, 'subsampled_for_display': shown < len(records), 'note': '仅显示前200个配对或均匀选取最多2000点/组，检验仍使用全部完整记录。' if shown < len(records) else '所有完整记录参与图示。'}


def report_markdown(artifact):
    plan, result, flow, approval = artifact['plan'], artifact['result'], artifact['sample_flow'], artifact['approval']
    spec = plan['spec']
    lines = ['# Med-Lab Mini 分析报告', '', '**性质：经方法确认后的统计结果与报告初稿，研究结论仍需作者核对。**', '', f"问题：{safe(spec['question'])}", '', f"方法：{result['method']}；双侧检验；置信水平：{spec['confidence_level']:.6g}。", '', f"效应定义：{safe(result['effect_name'])}；方向：{safe(result['direction'])}。", '', f"效应估计：**{display(result['effect'])}**；区间：**[{display(result['interval']['low'])}, {display(result['interval']['high'])}]**；P值：**{display(result['p_value'])}**。", '', f"检验返回统计量：{display(result['statistic'])}；自由度：{result['degrees_of_freedom'] if result['degrees_of_freedom'] is not None else '不适用'}。", '', '## 方法依据与人工确认', '', safe(plan['method_basis']['basis']), '', plan['method_basis']['url'], '', f"选择依据：{safe(spec['rationale'])}", '', f"核对者：{safe(approval['reviewer'])}；时间：{safe(approval['at'])}；说明：{safe(approval['note'])}", '', f"数据SHA-256：{artifact['data_sha256']}；计划SHA-256：{approval['plan_sha256']}", '', '**声明的假设，需结合设计与图示判断：**', '']
    lines.extend(safe(a) + '\n' for a in spec['assumptions'])
    lines += ['## 样本流转与缺失', '', f"原始记录 {flow['total']} = 完整个案 {flow['included']} + 排除 {len(flow['excluded'])}。", '', '排除按所需字段缺失执行，不自动填补或删除IQR极端值。记录号从CSV首条数据按1开始，不等于含多行引用字段时的文本物理行号。', '', '| 数据记录号 | 缺失字段 |', '| :-- | :-- |']
    for excluded in flow['excluded']:
        lines.append(f"| {excluded['record_number']} | {safe(', '.join(excluded['missing_fields']))} |")
    if not flow['excluded']:
        lines.append('| 无 | 无 |')
    lines += ['', '## 描述统计', '', '```json', json.dumps(artifact['descriptives'], ensure_ascii=False, indent=2, allow_nan=False), '```', '', '## 图表', '', '![批准数据的图示](figure.png)', '', f"图示记录 {artifact['figure']['displayed_records']}；分析记录 {artifact['figure']['analysis_records']}。{safe(artifact['figure']['note'])}", '', '图中原始观测或计数不表示模型调整后的因果效应；SVG为可编辑图，PNG为预览。', '', '## 解释边界与多重比较', '', safe(spec['multiplicity_note']), '']
    if result.get('interval_method'):
        lines += [safe(result['interval_method']), '', f"Fisher检验返回的样本优势比：{display(result['sample_odds_ratio'])}，与报告效应的条件MLE估计需区分。", '']
    if result['p_value_note']:
        lines += [safe(result['p_value_note']), '']
    lines.extend(safe(note) + '\n' for note in artifact['notes'])
    lines += ['## 运行环境', '', '```json', json.dumps(artifact['environment'], indent=2), '```', '']
    lines.insert(8, f"效应单位：{safe(result['unit'])}。")
    return '\n'.join(lines)


def writer_records(artifact):
    result, flow, spec = artifact['result'], artifact['sample_flow'], artifact['plan']['spec']
    p_note = f" {result['p_value_note']}" if result['p_value_note'] else ''
    return {'schemaVersion': 1, 'title': f"Med-Lab Mini {artifact['at']}，经方法确认的统计输出；研究事实需作者核查", 'records': [
        {'id': 'context', 'text': f"Question: {spec['question']}. Analysis fields: {json.dumps(spec['columns'], ensure_ascii=False)}. Units: {json.dumps(spec['units'], ensure_ascii=False)}. Display values use 8 significant digits; analysis.json retains full numeric precision."},
        {'id': 'method', 'text': f"Method: {result['method']}; alternative: two-sided; confidence level: {spec['confidence_level']}. Direction: {result['direction']}. Data SHA-256: {artifact['data_sha256']}."},
        {'id': 'flow', 'text': f"Of {flow['total']} records, {flow['included']} complete records were analyzed and {len(flow['excluded'])} were excluded for missing required fields."},
        {'id': 'result', 'text': f"{result['effect_name']} = {display(result['effect'])} {result['unit']}; interval [{display(result['interval']['low'])}, {display(result['interval']['high'])}] {result['unit']}; P = {display(result['p_value'])}.{p_note}"},
        {'id': 'limits', 'text': 'These results do not by themselves establish causality, absence of confounding, clinical benefit or the validity of the research design.'},
    ]}


def save_analysis(output, artifact, prepared):
    target = Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()  # Never overwrite an earlier report.
    artifact['figure'] = make_figure(artifact, prepared, target)
    artifact['environment']['matplotlib'] = matplotlib.__version__
    write_json(target / 'analysis.json', artifact)
    write_json(target / 'exploration.json', artifact['plan']['exploration'])
    write_json(target / 'plan.json', artifact['plan'])
    write_json(target / 'approval.json', artifact['approval'])
    write_json(target / 'writer-records.json', writer_records(artifact))
    (target / 'report.md').write_text(report_markdown(artifact), encoding='utf-8')
    return target


def save_exploration(output, exploration):
    target = Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    write_json(target / 'exploration.json', exploration)
    lines = ['# 数据探索记录', '', f"记录数：{exploration['records']}；数据SHA-256：{exploration['data_sha256']}", '', '| 字段 | 格式提示 | 有值 | 缺失 | 数值解析失败 | 唯一值数 |', '| :-- | :-- | :-- | :-- | :-- | :-- |']
    for field in exploration['fields']:
        lines.append(f"| {safe(field['column'])} | {field['type_hint']} | {field['present']} | {field['missing']} | {field['numeric_parse_failures']} | {field['unique_count']} |")
    lines += ['', '## 数值字段描述', '', '```json', json.dumps({f['column']: f['summary'] for f in exploration['fields'] if f['summary'] is not None}, ensure_ascii=False, indent=2, allow_nan=False), '```', '']
    lines.extend(safe(n) + '\n' for n in exploration['notes'])
    (target / 'exploration.md').write_text('\n'.join(lines), encoding='utf-8')
    return target
