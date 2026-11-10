"""All statistical execution enters through a validated approval record."""
import argparse
import json
import sys
from pathlib import Path

from .core import load_csv, read_json, write_json, explore, make_plan, make_approval, check_plan, approval_phrase
from .analysis import run_analysis
from .report import save_analysis, save_exploration


def parser():
    p = argparse.ArgumentParser(prog='med-lab', description='Med-Lab Mini：数据探索、明确方法确认与本地统计报告')
    sub = p.add_subparsers(dest='command', required=True)
    e = sub.add_parser('explore', help='只做字段与缺失探索，不执行检验')
    e.add_argument('--data', required=True)
    e.add_argument('--output', required=True)
    e.add_argument('--missing-tokens', default='["", "NA", "NaN"]', help='JSON字符串数组')
    plan = sub.add_parser('plan', help='按明确规格产生待确认计划')
    plan.add_argument('--data', required=True)
    plan.add_argument('--spec', required=True)
    plan.add_argument('--output', required=True)
    a = sub.add_parser('approve', help='查看计划后输入专用确认语句；没有自动yes选项')
    a.add_argument('--data', required=True)
    a.add_argument('--plan', required=True)
    a.add_argument('--output', required=True)
    a.add_argument('--reviewer', required=True)
    a.add_argument('--note', required=True)
    run = sub.add_parser('run', help='只执行与当前数据和计划一致的已确认分析')
    run.add_argument('--data', required=True)
    run.add_argument('--plan', required=True)
    run.add_argument('--approval', required=True)
    run.add_argument('--output', required=True)
    demo = sub.add_parser('example', help='复制原创教学CSV与四份方法规格')
    demo.add_argument('--output', required=True)
    return p


def execute(args):
    target = Path(args.output)
    if target.exists():
        raise ValueError('目标已存在，拒绝覆盖；请选择新文件或目录')
    if args.command == 'example':
        from importlib.resources import files
        target.parent.mkdir(parents=True, exist_ok=True)
        target.mkdir()
        for item in files('med_lab_mini').joinpath('examples').iterdir():
            if item.name.endswith(('.json', '.csv')):
                (target / item.name).write_bytes(item.read_bytes())
        print('已复制原创虚构教学数据，不能作为医学证据。')
    elif args.command == 'explore':
        result = explore(load_csv(args.data), json.loads(args.missing_tokens))
        save_exploration(target, result)
        print(json.dumps({'records': result['records'], 'fields': len(result['fields']), 'output': str(target)}))
    elif args.command == 'plan':
        plan = make_plan(args.data, read_json(args.spec))
        target.parent.mkdir(parents=True, exist_ok=True)
        write_json(target, plan)
        print(f"待确认方法：{plan['spec']['method']}；完整记录：{plan['preflight']['included']}；计划未执行统计检验。")
    elif args.command == 'approve':
        plan = read_json(args.plan)
        check_plan(args.data, plan)
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        print('请核对方法、效应方向、单位、缺失、独立性及多重比较安排。该操作记录确认，不认证操作者身份。')
        phrase = input(f"确认时输入 {approval_phrase(plan)}：")
        approval = make_approval(args.data, plan, args.reviewer, args.note, phrase)
        target.parent.mkdir(parents=True, exist_ok=True)
        write_json(target, approval)
        print('已记录明确方法确认；数据或计划改变后需要重新确认。')
    else:
        artifact, prepared = run_analysis(args.data, read_json(args.plan), read_json(args.approval))
        save_analysis(target, artifact, prepared)
        print(json.dumps({'method': artifact['result']['method'], 'included': artifact['sample_flow']['included'], 'output': str(target)}))


def main():
    for stream in [sys.stdout, sys.stderr]:
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    args = parser().parse_args()
    try:
        execute(args)
    except (ValueError, OSError, EOFError, KeyError, TypeError) as error:
        print(f'未完成：{error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
