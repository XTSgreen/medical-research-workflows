# 审稿回复副驾驶

当前版本为开发预览，独立 CLI 与 dsh 宿主适配已实现，并在隔离的 dsh 0.2.2-rc.1 中完成安装和工具调用。尚未公开发布到 npm，真实模型回复质量与完整产品试用仍待验证。

Node.js 24.9.0 或以上，无运行时第三方依赖；宿主兼容范围目前只声明已测试的 dsh 0.2.2-rc.1。支持中文与英文审稿人标题及编号意见，普通段落保留。自动分类供初筛；可编辑分类与策略。JSON 保存项目状态，Markdown 用于交付与审阅。导出后直接修改 Markdown 不会同步回项目。

## dsh 宿主使用

包的 `./dsh` 导出为宿主插件，默认导出仍是独立核心。`cordis.patch.yml` 插入 `research-review-copilot`，提供以下六个工具：

| 工具 | 输入与结果 |
| :-- | :-- |
| `review_context` | 完整项目、可选意见ID和P1提示词ID，返回只读模板、原版本及意见/证据 |
| `review_create` | 标题和意见文本，返回初始项目 JSON |
| `review_evidence` | 项目、意见 ID、来源和摘录，返回待核对项目 |
| `review_propose` | 项目、意见 ID 和五字段模型建议，单独保存未接受建议 |
| `review_draft` | 项目、意见 ID、回复正文和可选位置/策略，保存为 draft 并清除原核对说明 |
| `review_render` | 项目，返回项目 JSON 和 Markdown 工作表 |

在启用插件管理器的 dsh 会话中，请宿主使用 `plugin_manager` 的 `install_bundle` 操作，`spec` 指向本包压缩文件的绝对路径；本地开发时也可指向本目录的绝对路径。当前未发布，请勿把包名当成已经可用的 npm 下载地址。安装结果若为 `restart-required`，关闭并重新启动相同 profile 后再查工具列表；保存成功不表示当前进程已经激活。

宿主模型读取作者提供的意见和资料后调用这些工具，再用宿主原有文件工具保存返回的项目 JSON 与 Markdown。适配器不直接操作文件、不读取模型密钥、不另发模型请求；资料会进入当前宿主模型的上下文，是否适合提供给该模型由作者判断。后续操作须读取最后保存的完整项目，避免覆盖较新的版本。

成功记录建议、增加证据或修改草稿时，返回项目的revision递增1；创建从0开始，导出不变。它标记工具编辑版本，不证明宿主文件已经保存，也不提供并发锁。

模型建议必须含 `strategy`、`rationale`、`draft`、`evidenceIds`、`missing`，证据 ID 只能引用该意见已有的记录；没有证据时保留 `[待补：具体内容]` 和缺项。工具校验字段与 ID，叙述是否真实受到证据支持仍需人工核对。传入额外参数会报错。

宿主工具没有完成操作，模型更新回复时强制保留 draft。作者核查实际修改和来源后，可对保存的 JSON 使用 CLI 的 `complete` 命令；输入 JSON 中已有的 done 只是照录的状态，工具不验证操作者身份，不能据此证明作者确已核查。已有 done 项增加证据或修改正文时会撤销完成。

公开源码仓库根目录可运行npm test与npm run check:packages，分别核对核心行为和打包后独立安装。SDK与真实API的开发环境检查另行记录，相关私有开发脚本和运行文件不随本仓库或npm包分发；公开检查不启动真实模型或宿主。范围见[验证说明](https://github.com/XTSgreen/medical-research-workflows/blob/main/docs/VALIDATION.md)，真实模型质量与插件界面仍需单独验收。

## P1基础提示词

内置P1 0.1.0的P1-26筛选期刊、P1-27投稿信、P1-28拆解意见、P1-29逐条回复与P1-30拒稿后分析五条完整基础文本，随本包按MIT免费提供；不需要购买或读取付费资料目录。P1付费包明确包含这些免费文本，其他提示词、人工对照和高级扩展按各自许可，不随本npm包提供。

```powershell
node packages/review-copilot/cli.js prompts
node packages/review-copilot/cli.js prompts --prompt P1-29
node packages/review-copilot/cli.js context --project output/review.json --id R001 --prompt P1-29
```

review_context与CLI的context默认P1-29，省略意见ID时返回项目全部意见；显式ID只返回该条意见。它保留原模板占位符，inputChecklist是待作者核对的字段清单，不是自动检测的缺项或已完成记录。已有意见和证据不能代替尚未提供的修订稿、真实分析或位置；作者需补齐所选任务的实际材料。读取不递增项目revision、不改状态，也不写文件；输入中的done不证明操作者已经核查。

./prompts导出listPrompts、getPrompt与buildReviewContext，可供其他本机流程调用。CLI的API草稿请求实际携带P1-29模板，仍使用原有五字段JSON协议，返回的workflowPrompt由程序记录模板来源；该记录不能证明模型遵循模板或回复内容正确。宿主读取上下文只说明模板已提供，不记录为模型已使用。

## 快速使用

在仓库根目录执行；示例全部为教学数据：

```powershell
node packages/review-copilot/cli.js init --project output/review.json --input examples/review/reviews.txt --title "返修演示"
node packages/review-copilot/cli.js show --project output/review.json
node packages/review-copilot/cli.js update --project output/review.json --id R003 --response-file examples/review/response.txt --location "修订稿第 2 页第 18 行"
node packages/review-copilot/cli.js complete --project output/review.json --id R003 --verification "已逐项核对示例修订稿；此记录只用于教学"
node packages/review-copilot/cli.js export --project output/review.json --output output/responses.md
```

提供证据：`evidence --project output/review.json --id R002 --source "附录表S2" --excerpt-file evidence.txt`。

策略值为 `add-evidence`（计划补证据）、`existing-evidence`（依据已有证据）、`acknowledge-revise`（承认并修订）。分类为 `method,experiment,format,clarification`，通过 `update --categories method,clarification` 人工修正。用 `reopen` 撤销完成。

完成一项需要回应正文、修改位置和人工核对说明；实验类和证据策略额外需要证据摘录。工具检查这些字段存在，证据是否充分及实验是否真实由作者判断。修改已完成项或添加证据会撤销完成状态，需再次人工确认。

## 可选模型草稿

配置环境变量后才可使用，意见和证据会发送到指定服务。请先确认可向该服务提供这些资料；本地操作不联网。

```powershell
$env:RESEARCH_MODEL_BASE_URL = "https://your-provider.example/v1"
$env:RESEARCH_MODEL = "your-model"
# RESEARCH_MODEL_API_KEY 通过本机环境或密钥管理器设置，不写入项目文件。
node packages/review-copilot/cli.js draft --project output/review.json --id R001 --send-to-model
```

服务须支持 OpenAI 兼容 `chat/completions` 与 JSON 对象响应。模型建议单独存储，始终标为 unverified，不会覆盖作者正文。格式验证可拦截不存在的证据 ID，但不能证明模型叙述受到证据支持；作者核查后以 `update --response-file` 保存采用的文本。

## 文件与错误恢复

项目含审稿原文、回应与证据，按科研资料管理；默认只在本机保存。不要上传含个人信息或未授权内容的项目至公开仓库。导入和导出拒绝覆盖。写入使用独占锁、版本比对和临时文件替换；崩溃遗留 `.lock` 时，先确认没有写入进程，再手动删除锁并检查项目。不要在多机同步盘上同时编辑同一项目。

未发现编号时将整段作为一条意见，导入后先执行 `show` 核对分段。PDF、OCR 和嵌套编号格式不在当前文本导入接口中；请先整理成明确的 Reviewer / Comment 标题。

## 验证范围

公开源码仓库根目录 `npm test` 验证状态约束、独立进程操作、文件冲突、错误恢复、模型协议与无效响应。模型协议测试使用本机 HTTP 测试服务，尚无真实商业模型验证。所有输出用于辅助起草，作者需负责核查，不提供代写服务。
