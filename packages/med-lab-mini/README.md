# Med-Lab Mini

开发预览版，提供本地 CSV 数据探索、明确方法确认、固定统计检验、PNG/SVG 图表和报告初稿。当前已验证 Windows / Python 3.12，其他平台与完整产品交付仍以工作区验收表为准。

## 安装

需要Python 3.11或以上，当前已在3.11/3.12运行数值检查。先取得公开源码，在仓库根目录创建独立环境并从源码安装，不依赖预先生成的wheel。Windows示例：

```powershell
python -m venv .venv-medlab
.venv-medlab/Scripts/python.exe -m pip install ./packages/med-lab-mini
.venv-medlab/Scripts/med-lab.exe --help
```

Linux/macOS将Scripts/python.exe替换为bin/python，入口为bin/med-lab。后续示例使用已激活环境中的med-lab；未激活时用该环境可执行文件的完整路径替代。也可在包目录执行python -m pip install .，开发与测试安装使用python -m pip install -e ".[test]"。运行时使用NumPy、SciPy与Matplotlib，不调用模型或上传原始数据。

## 从教学数据跑通流程

以下目录和文件都必须尚不存在，命令拒绝覆盖，也不复用已有空目录。示例是原创虚构数据，不是医学研究结果。

```powershell
med-lab example --output my-example
med-lab explore --data my-example/teaching.csv --output my-exploration
med-lab plan --data my-example/teaching.csv --spec my-example/welch.json --output my-plan.json
med-lab approve --data my-example/teaching.csv --plan my-plan.json --output my-approval.json --reviewer "核对者姓名" --note "核对设计、变量、单位、缺失和分析假设"
# 查看完整计划后，按终端提示输入该计划专用的 APPROVE 语句。
med-lab run --data my-example/teaching.csv --plan my-plan.json --approval my-approval.json --output my-report
```

plan 只生成方法与数据预检记录，不执行假设检验。approve 会展示完整计划，确认语句绑定该计划内容；没有自动 yes 参数。run 需要与当前数据和完整计划一致的确认记录，文件改变后需重新 plan 和 approve。明确确认不等于操作者身份认证，也不证明实际研究设计正确；能够手动编辑本机文件的人仍能自行构造记录，本工具不提供签名身份系统。

## 数据要求

UTF-8 逗号 CSV，表头唯一且不为空，字段数必须一致，最多20 MB、100000条数据记录、200列。表头及单元格统一去首尾空白，再判断 ID、类别、缺失和数值；如果原始空格承载含义，应在导入前明确编码，避免类别被合并。

每行一个独立参与者 ID，ID 不得缺失或重复；重复 ID 即使位于待排除记录也会拒绝。配对数据采用宽表，同一行放一个人的两次测量。多次随访的长表、聚类、匹配病例对照、时间结局或其他相关结构不能直接当独立记录运行本工具。

explore 默认 `""`、`"NA"`、`"NaN"` 为缺失，可用 `--missing-tokens '["","NA"]'` 指定。计划中的 missing_tokens 必须包含空字符串，其他标记大小写精确匹配。数值列中未声明的 NaN、无穷或非数值内容会拒绝分析，不自动填零、截断或删除。

完整个案只按该方法实际需要的字段判断，按分析报告排除数据记录序号和缺失字段；序号从第一条数据为1，不等于带换行引用字段时的文本物理行号。未用于该分析的列缺失不导致排除。完整个案方法的适用性需由使用者判断，工具不证明缺失机制合理。

## 方法与效应定义

| method | 输入 | 报告的效应与区间 |
| :-- | :-- | :-- |
| welch | 两个明确分组，连续 value | groups 首项均值减次项均值；Welch-Satterthwaite自由度与t区间 |
| paired-t | 同一行的 x 与 y，单位相同 | x减y的平均配对差；差值t区间 |
| pearson | 独立参与者的 x 与 y | Pearson r、双侧非相关检验、Fisher-z近似区间 |
| fisher | 两个二分类变量及行列类别顺序 | 2×2 Fisher双侧检验；条件MLE优势比和精确条件区间，另列样本优势比 |

全部方法为双侧，每份计划一个明确的主要检验，置信水平由计划指定。选择理由 rationale、方法假设 assumptions、多重比较安排 multiplicity_note 均需填写，软件不根据哪个方法更显著自动选择检验，也不自动用正态性检验切换方法。

Welch 每组至少2例，且两组不能均为常数；一组常数、另一组有方差时仍可计算。配对至少2个完整对且差值方差大于0。Pearson 至少4例且两列非常数，以便报告 Fisher-z 区间。Fisher 两行和两列边际均需大于0，行列顺序明确决定优势比方向。非有限计算被拒绝；Fisher 合法零格可能产生边界优势比或无界区间，以 value=null 和明确 state 表示，不把它写成普通 JSON 的 Infinity。

Fisher 的条件MLE效应不是样本交叉乘积优势比，报告分开列出，不能混用。Pearson 只刻画线性关联，不自动处理混杂、非线性、重复测量或异常点影响。p_value 为0时保留浮点零说明，不能将接口返回0直接写成精确概率为零。

## 分析规格

包内 example 命令提供四种方法的完整 JSON 模板。共同字段包括 question、method、design、id_column、columns、units、missing_tokens、missing_policy、confidence_level、analysis_role、rationale、assumptions、multiplicity_note。

Welch 声明 `columns:{"group":"分组列","value":"数值列"}` 和两个有顺序的 groups；配对与相关声明 x/y；Fisher 声明 row/column、row_levels 和 column_levels。数值字段每列有单位，Fisher units 为空对象。未知分组、额外方法参数、字段不存在或设计不符时拒绝，不静默忽略。

## 描述、图表与文件

描述统计包括样本量、均值、样本标准差（ddof=1）、最小最大值、线性插值分位数和IQR提示。单例标准差为空；严格低于Q1−1.5IQR或高于Q3+1.5IQR才计为极端值，只提示不删除。字段格式提示不能判断测量尺度，数字 ID 也可能被识别为数值列。

| 文件 | 内容 |
| :-- | :-- |
| analysis.json | 完整数值、样本流转、方法、环境与确认记录，浮点值保留完整精度 |
| report.md | 报告初稿与图示，数字显示8位有效数字 |
| figure.png / figure.svg | 图像预览与可编辑矢量图 |
| exploration.json | 字段、缺失与描述统计 |
| plan.json / approval.json | 实际执行的计划与明确确认 |
| writer-records.json | 可导入 X4 的问题/字段/单位、方法、流转、结果及限制摘要 |

检验使用全部完整记录。图示为避免大文件，Welch每组按记录索引均匀选择最多2000点，Pearson最多2000点，配对图取前200对；报告明确显示图示数和分析数。记录顺序可能影响所显示子集，不能仅凭图中子集断言完整样本的模式。Welch黑色横线是组均值，没有冒充置信区间；Fisher图为实际计数，没有错误条。

PNG 已渲染文字，SVG 保留可编辑文本，跨机器打开SVG时需相应字体。本机优先选择微软雅黑、Noto Sans CJK或黑体，没有这些字体时使用DejaVu Sans；中文字段需检查实际显示效果。图表导出不证明达到目标期刊所有作图规范。

X4可直接 `import-records --input my-report/writer-records.json`。记录中的数字与报告采用同样8位显示精度，并保留分析对象和P值零说明；完整精度与所有筛选信息仍以 analysis.json 和计划为准，不把精简记录当作原始数据。

## 复现与验证范围

方法依据链接直接写入计划及报告，来源为SciPy官方说明。测试用 Python statistics 与高精度不完全Beta公式独立对照Welch/配对t，独立协方差和Fisher-z公式对照Pearson，并用组合数及非中心超几何枚举对照Fisher P值、条件估计与区间。mPMath只作为测试依赖，不是统计运行时。

当前测试包含缺失、非法数值、重复ID、未知组别、退化设计、过期确认、未确认不得调用检验、图表与X4导出，以及跨进程CLI。在公开仓库根目录执行python -m pip install -e "packages/med-lab-mini[test]"，再执行python -m pytest packages/med-lab-mini/tests；这些检查使用虚构输入，不作为人工批准真实研究的服务。

单个计划声明单一主要分析，不会阻止使用者反复创建其他计划；多个结局、亚组或不同方法的探索仍需另外制定并核查多重比较安排。报告只支持实际设计范围内的统计描述与推断，不自动证明因果、临床获益、伦理批准或数据真实性。
