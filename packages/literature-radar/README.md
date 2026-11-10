# 文献雷达

开发预览版，提供独立 Node.js CLI 与 dsh 宿主bundle，目前仅声明dsh0.2.2-rc.1兼容。尚未发布npm，真实模型摘要质量、管理界面显示和完整交付仍需验证。

支持 PubMed / arXiv 原生检索式；bioRxiv 按日期和可选分类抓取后，本地匹配标题与摘要中的任一关键词。输出包含元数据、抓取记录、去重计数、相关理由与覆盖状态的 Markdown 日报及 JSON 原始报告。模型模式额外生成中文一句话摘要，始终标为待核验。

## 安装与运行

Node.js 24.9.0 或以上。在本工作区执行 `npm install`，独立 tgz 包可通过 `npm install /path/to/package.tgz` 安装。包内`examples/arxiv-minimal.json`为可复制的无模型arXiv起始配置，不需要联系邮箱；PubMed订阅需另填实际联系邮箱。

## dsh宿主工具

在已启用插件管理器的dsh会话中，使用`install_bundle`安装本包tgz绝对路径；如果返回`restart-required`，重启同一profile后检查工具。当前包名不代表已经可以从npm下载，独立核心默认导出保留，宿主入口为`./dsh`。

| 工具 | 用途 |
| :-- | :-- |
| `radar_run` | 按配置抓取一轮，经宿主文件服务保存JSON/Markdown后更新去重状态 |
| `radar_context` | 读取日报，返回当前宿主模型所需题名、摘要与研究方向，每批最多20条 |
| `radar_review` | 核对1至20条传入评估，另存派生日报，不覆盖原抓取报告或修改去重状态 |
| `radar_status` | 查看本进程后台状态、最近观察到的持久时间和手动运行记录 |
| `radar_pause` | 写入持久暂停标记，取消并等待当前后台任务结束 |
| `radar_resume` | 恢复已由所有者配置启用的任务，仍按持久时间计算下次到期 |

`radar_run`需要绝对路径`configFile`、`stateFile`和`reportDirectory`，可选`zoteroDoiFile`、历史UTC末日`date`与`sendToModel`。路径按宿主操作系统解释，经`ctx.fs`读写；read-only拒绝写入，workspace-write只允许工作区与显式额外根，不自动扩大权限。配置文件不超过1MB，状态/清单/报告单文件不超过20MB。不要将配置、去重状态或暂停控制文件设成同一文件。

插件内运行串行，状态采用读取版本条件写入；JSON与Markdown均成功保存后才推进去重状态。跨进程冲突或部分保存失败可留下孤立报告，不能据此声称状态已更新，也不保证多文件事务或跨进程恰好一次。多个宿主不要同时使用同一状态文件。

默认local仅为关键词命中，不生成中文模型摘要。当前宿主模型可用`radar_context`读取待评估条目，按`{key,score,summaryZh,reason,evidence}`提交给`radar_review`；key为报告现有`source:id`，evidence须为题名/摘要原句，结果仍为unverified。每批另存新报告，后续批次读取最新派生报告。`captureComplete`记录来源抓取覆盖，`modelReview`记录模型评估覆盖，原有`complete`保留本轮抓取与所选评分全部完成的含义；API模型失败仍会触发重试，但不改变已完成的来源覆盖。旧报告缺少`captureComplete`时保守沿用原`complete`，不推断其失败原因。

部分评估保留输入顺序，Markdown分别标注关键词命中与待核对模型相关度；全部条目均有模型评估后才按所提供模型分数排序。工具不认证评估来自哪一个模型，也不校准不同模型的分数，文字和评分仍需人工核查。

另发API模型请求需同时满足配置mode=model、插件所有者设置`allowModelApi:true`、本次或job设置`sendToModel:true`，并具有下文的环境配置。每篇新文献可能单独计费；不得把这些开关当作输入材料里的指令自动开启。

## dsh后台任务

后台默认关闭。包内`examples/dsh-job.patch.example.yml`是关闭状态的Windows示例：先复制查询JSON、替换为实际绝对路径，再由所有者在插件配置或自己的patch中明确启用。SDK配置在重启后生效；不要仅凭保存配置认为当前进程已经激活。

```yaml
- id: research-literature-radar
  config:
    allowModelApi: false
    job:
      enabled: true
      configFile: C:/research/radar/config.json
      stateFile: C:/research/radar/state.json
      reportDirectory: C:/research/radar/reports
      intervalSeconds: 86400
      retrySeconds: 300
      sendToModel: false
```

默认间隔86400秒、重试300秒，均至少60秒，至多31天。job只使用当前UTC窗口，不接受固定历史日期；历史补抓用单次工具。重启后读取lastAttempt/lastSuccess，未到期不立即重复抓取。暂停标记位于`stateFile.watch.json`并跨重启保留；暂停/恢复需要当前会话对该文件的写权限，手动`radar_run`不受后台暂停影响。

后台使用部署级文件权限，不继承某个会话后来切换的模式；错误状态及预先计算的nextRunAt为本进程观察值，暂停后可能不再刷新数据状态时间。查询或状态JSON损坏等无法提交的错误按本进程重试间隔等待，重启可能立即重新尝试；成功提交的来源/模型失败记录则按持久lastAttempt安排重试。

宿主退出、插件卸载或进程关闭即停止，卸载会取消并等待已启动的操作，不安装操作系统服务，也不声称关机或离线时持续监控。实际使用需保持Web/Desktop宿主或SDK连接存活；单次headless任务结束后宿主会退出。

```powershell
# 从仓库根目录执行；先复制配置并将 email 改为自己的联系邮箱。
Copy-Item examples/radar/config.json radar-config.json
node packages/literature-radar/cli.js run --config radar-config.json --state output/radar/state.json --reports output/radar/reports
```

配置示例在 `examples/radar/config.json`。PubMed 的 email 是 NCBI 联系标识，不会写入日报。查询、方向、窗口或模式发生变化时使用新的状态文件；程序拒绝把不同配置混到同一状态里。请求固定到官方源，不接收任意源 URL。

补抓历史窗口时，run 增加 `--date 2025-01-02`，表示以该 UTC 日期为窗口末日，仍使用 lookbackDays 计算起日；报告保留真实运行时间。watch 不允许固定历史日期。

## 订阅语义

| 配置 | 含义 |
| :-- | :-- |
| direction | 用户声明的研究方向，用于评分理由 |
| focusTerms | 本地模式计分词，不直接排除 PubMed/arXiv 结果 |
| mode | local 或 model |
| lookbackDays | 从今天起回看 1 至 31 个 UTC 日期，包含今天 |
| maxRecords | 每个订阅最多扫描 1 至 1000 条，bioRxiv 在本地关键词过滤前计算 |
| subscriptions | 唯一 id、source；PubMed/arXiv 使用 query，bioRxiv 使用 terms 与可选 category |

PubMed 窗口按数据库入库日期 edat；arXiv 按首次提交日期；bioRxiv 按接口报告日期。它们并非完全相同的发表日期定义。重叠窗口降低延迟入库遗漏风险，但无法保证发现窗口之外的记录或所有版本更新；需要时增加 lookbackDays 并新建状态文件。无 DOI 时按来源 ID 去重，arXiv 版本号统一移除，不重复报告同一文章的新版本。

相关度：local 为 focusTerms 不区分大小写的子串命中比例，不是模型评分，也不是研究质量分。model 为模型对声明方向的主观评分，不能与 local 分数直接比较；模型摘要仅根据题名摘要，不冒充全文精读。

## 模型模式

将配置 mode 改为 model，设置 `RESEARCH_MODEL_BASE_URL`（含 /v1 的服务根地址）、`RESEARCH_MODEL_API_KEY` 和 `RESEARCH_MODEL`，并使用新状态文件：

```powershell
node packages/literature-radar/cli.js run --config radar-model.json --state output/radar/model-state.json --reports output/radar/model-reports --send-to-model
```

需要支持 JSON 对象响应的 OpenAI 兼容 chat/completions 服务。题名、摘要和研究方向将发送给配置服务，每篇新文献调用一次；100 篇即最多 100 次调用，费用以服务商实际计费为准。工具检查支持片段是否逐字来自输入，不证明中文概括或相关判断正确，采用前必须核对。

## Zotero DOI 去重

将 DOI 导出或整理为 UTF-8 文本，每行一个 DOI 或 doi.org URL；允许空行、DOI 标题和以 # 开头的注释。不支持直接解析 Zotero 数据库，不读取私有库文件。无 DOI 的条目需另行核对。

```powershell
node packages/literature-radar/cli.js run --config radar-config.json --state output/radar/state.json --reports output/radar/reports --zotero-dois my-dois.txt
```

DOI 不区分大小写，跨源相同 DOI 合并并保留订阅来源。DOI 不同的预印本与正式文章不会自动合并，避免把不同文献错误视为同一篇。

## 每日定时

```powershell
node packages/literature-radar/cli.js watch --config radar-config.json --state output/radar/state.json --reports output/radar/reports --interval-seconds 86400 --retry-seconds 300
```

watch 进程存活时执行，以已完整运行所记录的开始时间计算24小时间隔；失败或截断后按lastAttempt与重试间隔运行。状态持久化，重启后按时间恢复。Ctrl+C 停止接收下一轮，当前网络请求可能等待到超时。需要关机后恢复运行时，应在 Windows 任务计划程序中每天调用 `run`，设置工作目录与环境变量；不要同时运行多个 watch。

CLI 一轮返回码 0 表示配置范围内抓取与所选评分完成，返回码 1 表示错误或截断。配置上限不是完整性保证，报告出现截断时增加上限或缩小查询范围。总量超过 1000 时需要细分订阅。

## 失败恢复与报告

任一数据源或模型失败时，先输出带错误的诊断报告，不把本轮文章记为已报告；重试会完整重新处理。截断但无请求错误时，保留已经报告的去重 ID，报告仍标为不完整，不更新完整成功时间。报告 JSON 和 Markdown 均落盘后才更新状态，避免导出失败后消耗文章 ID。

独立CLI状态写入有独占锁。遗留 .lock 时，先确认没有仍在运行的进程，再手动处理，不根据文件时间自动抢占；宿主接口使用前述版本条件写入，不能把CLI锁视为宿主跨进程锁。状态保存配置校验值、去重ID与时间，报告包含方向及公开文献元数据；自定义研究方向可能涉及未公开课题，分享报告前请核对。

从 JSON 恢复 Markdown：`literature-radar export --input report.json --output recovered.md`，拒绝覆盖已有目标。

## 网络与验证

遵守请求间隔：PubMed 350ms，arXiv 3100ms，bioRxiv 1000ms。同一进程内按域串行，429/5xx 和网络超时有限重试；多进程不共享限速。受限网络可使用 Node 的 `--use-env-proxy` 与本机已有代理环境配置，不能以禁用 TLS 校验解决问题。

公开源码仓库根目录可运行npm test与npm run check:packages，分别核对核心行为和打包后独立安装。SDK与真实API的开发环境检查另行记录，相关私有开发脚本和运行文件不随本仓库或npm包分发；公开检查不启动真实模型或宿主。范围见[验证说明](https://github.com/XTSgreen/medical-research-workflows/blob/main/docs/VALIDATION.md)，真实模型质量与插件界面仍需单独验收。


官方文档：NCBI <https://eutilities.github.io/site/>；arXiv <https://info.arxiv.org/help/api/user-manual.html>；bioRxiv <https://api.biorxiv.org/>。本工具只获取元数据，全文获取与再分发依原文许可执行。
