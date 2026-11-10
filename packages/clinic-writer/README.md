# 写作流水线

开发预览版，包含独立 Node.js CLI 与 dsh 宿主适配，真实模型质量验证仍待完成。提供从大纲、原文证据和本研究记录到分节草稿的工作流，每节附逐项来源，缺少资料时保留待补标记；目前只声明 dsh 0.2.2-rc.1 兼容。

这是一套作者核对工具，所有自动生成内容均为辅助草稿。证据定位、字面数字和 DOI 检查不能证明解释正确或论证成立，使用者仍需核查原文、统计结果与期刊要求。

## 安装与教学演示

需要 Node.js 24.9.0 或以上，无第三方运行时依赖。在本工作区可以直接运行 CLI；独立包安装后可执行 `clinic-writer --help`。

## dsh宿主流程

以插件管理器的`install_bundle`安装本包tgz绝对路径，重启相同profile后核对`writer_`工具；当前未公开发布，请勿把包名当成可用npm下载地址。独立核心默认导出保留，宿主入口为`./dsh`，工具由Cordis上下文拥有并随其卸载。

| 工具 | 用途 |
| :-- | :-- |
| `writer_create` | 按题名与包含id/title/requirements的大纲创建项目 |
| `writer_import_card` | 导入X2卡片，保留原文页码、证据ID与来源快照 |
| `writer_import_records` | 导入作者提供的原始JSON记录文本 |
| `writer_context` | 返回本节要求、来源库与约束，供宿主模型起草 |
| `writer_draft` | 验证并保存来源单元，状态保持draft |
| `writer_journal` | 设置有来源原句的期刊规则，撤销受影响的核对状态 |
| `writer_adapt` | 保留ID、数量、证据、数值及不确定性，调整文字 |
| `writer_render` | 返回带逐项来源与缺项的Markdown |

工具传入、返回完整项目JSON，适配器不直接保存文件，也不另发模型请求；使用宿主原有文件工具读写最新项目。独立CLI的文件锁和版本冲突保护不覆盖宿主保存，避免多人同时覆盖同一文件。资料会进入宿主当前模型上下文，请按资料权限使用。

每次成功导入、草拟或期刊修改均将返回项目的revision递增1，创建从0开始，上下文与导出不变；该值区分工具编辑版本，不表示文件已保存。单元ID可在后续草稿复用，引用单元时同时保留项目revision。升级使用新的包版本与tgz文件名，安装后逐文件核对，避免同版本缓存造成旧代码继续运行。

单元格式为`{kind,text,support:[{evidenceId,quote}]}`；kind为fact、interpretation或missing，支持片段至少8字符。`writer_context`返回精确ID与原文，不能自行编造引用；适配任务还需保留原单元id。论文来源与本研究记录分别标记，外部论文结果不能写成本研究结果。

宿主没有作者确认工具，模型操作保留draft；实际核对后用CLI确认保存的项目。输入中已有checked只表示所提供的记录，工具不认证操作者身份，不证明研究实际完成。期刊规则仅核对提供的原句，不自动证明来源网站真实性或满足整份投稿指南。

公开源码仓库根目录可运行npm test与npm run check:packages，分别核对核心行为和打包后独立安装。SDK与真实API的开发环境检查另行记录，相关私有开发脚本和运行文件不随本仓库或npm包分发；公开检查不启动真实模型或宿主。范围见[验证说明](https://github.com/XTSgreen/medical-research-workflows/blob/main/docs/VALIDATION.md)，真实模型质量与插件界面仍需单独验收。

仓库内运行：

```powershell
node packages/clinic-writer/examples/demo.js --output output/writer-demo
```

安装 tgz 后，可运行 `node node_modules/dsh-clinic-writer/examples/demo.js --output my-writing-demo`。教学示例不调用模型，数字和研究记录均为原创虚构内容，不能作为研究证据。演示还会验证缺少来源的章节无法完成确认。

## 建立项目并导入资料

```powershell
node packages/clinic-writer/cli.js init --project output/writer/project.json --title "我的论文草稿" --outline examples/writer/outline.json
node packages/clinic-writer/cli.js import-card --project output/writer/project.json --input my-x2-card/card.json
node packages/clinic-writer/cli.js import-records --project output/writer/project.json --input my-study-records.json
node packages/clinic-writer/cli.js sources --project output/writer/project.json
```

大纲为章节数组，每节包含唯一 id、title、requirements。requirements 应写清该节要回答的问题和允许使用的资料类型，例如方法与结果节只能描述本研究实际完成的行为和数据，不能将外部论文写成本研究过程。

X2 卡片导入检查页面文本哈希、原始摘录与证据 ID，保留原 documentId、sourceFileHash、物理页码和阅读覆盖范围。相同文献版本不重复导入，另一个 PDF 版本作为独立来源保存。X4 不需要安装 X2，也不会重新解析 PDF，只读取 X2 的公开卡片结构。

本研究记录为 JSON：

```json
{
  "schemaVersion": 1,
  "title": "实际分析记录的名称和版本",
  "records": [
    { "id": "methods", "text": "将有权使用的真实方法记录写在这里。" },
    { "id": "results", "text": "将已经核对的真实结果、单位和区间写在这里。" }
  ]
}
```

程序保留输入快照与文件哈希，不能把录入一段文字当作证明实验真实发生。本研究记录和外部论文使用不同来源类型，并在模型上下文与导出清单中显式区分。

## 保存单节草稿

使用 sources 输出中的完整 evidenceId，准备 proposal.json：

```json
{
  "units": [
    {
      "kind": "fact",
      "text": "依据所给记录写出的一个事实句。",
      "support": [{ "evidenceId": "从sources复制完整ID", "quote": "从该证据复制至少8字符的原文支持片段" }]
    },
    { "kind": "missing", "text": "[待补：伦理批准信息]", "support": [] }
  ]
}
```

```powershell
node packages/clinic-writer/cli.js draft --project output/writer/project.json --section methods --input proposal.json
```

正文完全从 units 生成，不另接收脱离来源表的自由段落。kind 为 fact、interpretation 或 missing。没有支持片段时明确标记待补来源；有支持片段时仍标为 linked-unverified，表示文本定位存在，语义尚未核对。外部论文中的读者推断不能写成作者原话。

每次 draft/generate 整体替换指定节，并按当前位置分配 methods-C001 等ID；这些ID只在当前项目版本内有效。跨版本沟通应同时写项目revision，不能把单元ID当作永久事实标识。旧单元保存在章节历史中。

数字按字面检查，包括正负号和百分比；计算出的新数值、单位换算或其他表示方式需补入有依据的研究记录，再引用该记录。程序不自动核验推导，不允许仅以一句核对说明绕过尚未解决的数字警告。数值相同也可能存在分母、组别或单位错误，仍需人工检查。

## 模型按节起草

设置 `RESEARCH_MODEL_BASE_URL`、`RESEARCH_MODEL_API_KEY` 和 `RESEARCH_MODEL`，服务需支持 OpenAI 兼容 chat/completions 与 JSON 对象响应，然后运行：

```powershell
node packages/clinic-writer/cli.js generate --project output/writer/project.json --section methods --send-to-model
```

模型接收已导入原文摘录、资料类型、研究方向对应的大纲要求和前节草稿。它不会收到完整 PDF 二进制，但这些文本可能涉及未公开研究，使用前按授权范围选择服务。每次操作发送一次请求，费用以服务商计费为准，上下文超过120000字符时需拆分任务。

模型返回的草稿需通过相同来源校验，不能直接确认完成。模型未生成的后续章节仍为 todo；一次 generate 只处理指定章节。前文草稿也可能存在错误，不能把它当作新的原始证据。

## 期刊格式适配

```powershell
node packages/clinic-writer/cli.js journal --project output/writer/project.json --input journal-profile.json
node packages/clinic-writer/cli.js adapt --project output/writer/project.json --section methods --send-to-model
```

profile 保存期刊 name、官方 url、retrievedAt、指南摘录 sourceText 和 rules。程序核对规则 quote 确实存在于所给 sourceText，不自动证明网址属于该期刊，也不自动下载或核验整份指南；使用者需确认来源和解释。仓库与包内提供明确标注的虚构规则，以及依据已读取官方页面制作的 PLOS One 部分规则示例。

支持规则：tense（past/present/mixed）、abbreviation（short/long）、figure-label（Figure/Fig./Fig）、table-label（Table/Tab./Tab）。各规则有唯一 id 和原文 quote；同类时态、图或表称谓不能互相冲突。

缩写在全文第一次出现时展开，图表称谓在导出时统一，原始证据摘录不改写。缩写全称由使用者的术语表提供，不能推断为期刊指定术语。当前图表规则只调整英文阿拉伯数字称谓，不负责核对图文件、图号顺序、子图、参考文献样式、排版或完整投稿要求。

时态不能靠简单文本替换安全完成，因此 adapt 显式调用模型，保留单元数量、顺序、ID、类别与支持片段。数字、DOI 和明显不确定性词被改变时拒绝应用。其余含义变化仍需作者核对，不能以这些检查通过宣称意义完全保持。

更换期刊规则会撤销已有章节确认；修改前文使后文的首次缩写展开变化时，也会撤销受影响后文确认。核对记录绑定原始单元与实际排版文本，防止确认后导出的文字已经变化。

## 人工确认与导出

```powershell
node packages/clinic-writer/cli.js confirm --project output/writer/project.json --section methods --reviewer "核对者姓名" --note "逐项核对方法记录、来源定位与排版文本"
node packages/clinic-writer/cli.js export --project output/writer/project.json --output output/writer/draft.md
```

确认需所有单元都有来源、没有占位或数字警告，并填写核对者与说明。工具验证字段和状态，不证明核对者真的完成了审查。任何草稿变更撤销相关确认，历史保留旧内容和确认记录。

export 可以导出未完成草稿，会保留 todo、draft、待补来源和缺项；这不代表稿件已经可以投稿。每节包含单元ID、类别、状态、支持片段、来源文件版本和定位，文末列出资料版本与期刊规则出处。导出拒绝覆盖已有文件，Markdown 的手动修改不会同步回项目。

## 文件与验证

JSON 为权威项目文件，含原文快照、研究记录和写作历史，应按科研资料管理。文件写入使用独占锁、版本冲突检查和原子替换，崩溃遗留锁时先确认没有仍在写入的进程，再处理 .lock。不要在同步盘上多机同时编辑同一项目。

公开源码仓库根目录 npm test 验证 X2 实际卡片导入、无来源标记、伪证据与伪DOI拒绝、数字与符号约束、作者确认失效、期刊规则和本机 HTTP 模型生成/时态适配协议。测试服务的输出为固定教学构造，不是商业模型或本地模型的语义质量评估。真实模型、插件界面和实际科研使用试验仍待验证。
