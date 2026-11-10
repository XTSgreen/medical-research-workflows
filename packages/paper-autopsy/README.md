# 论文解剖

开发预览版，包含独立 PDF 到五栏卡片的 CLI 与 dsh 宿主适配；当前只声明dsh 0.2.2-rc.1兼容，尚未公开发布到npm，真实模型阅读质量仍待验证。

输入为有权使用的 PDF，可附研究方向和带稳定 ID 的综述大纲。输出 `card.json` 与 `reading-card.md`，保留文件 SHA-256、PDF 物理页、提取文本、证据摘录、五栏内容、方法分项、归位建议与引用核查记录。输出是待核验的阅读辅助资料，不代表已经完成专家审读。

## 安装

Node.js 24.9.0 或以上。在工作区执行 `npm install`，PDF 提取使用固定版本 PDF.js；独立 tgz 包可用 `npm install /path/to/package.tgz` 安装。不要直接复制 src 后忽略依赖。

## dsh宿主流程

在启用插件管理器的dsh会话里，以`install_bundle`安装本包tgz绝对路径；若返回`restart-required`，重启相同profile后再检查工具。当前包名不代表已经可从npm下载。核心默认导出保留，宿主入口为`./dsh`。

| 工具 | 用途 |
| :-- | :-- |
| `paper_extract` | 通过宿主文件服务读取绝对路径PDF，返回物理页文本 |
| `paper_local_card` | 生成明确标记为本地启发式提取的卡片 |
| `paper_context` | 返回所选原页、大纲与结构要求，供当前宿主模型阅读 |
| `paper_build` | 核对宿主模型建议中的原句、页码、书目字段与章节ID |
| `paper_verify_references` | 选择卡内1至20个引用ID，向官方Crossref核对 |
| `paper_render` | 返回JSON卡和Markdown，交由宿主文件工具保存 |

`paper_extract`只接受宿主同平台的绝对路径，通过`ctx.fs.readBytes`读取完整且不超过50MB的PDF；页数上限500。使用`selectedPages`选择页码，遇到不可读页需OCR，只有显式`allowPartial:true`才可接受混合文档的可读节选。纯扫描件不生成空卡。文件服务可用时插件才激活；适配器不直接写盘。

宿主模型接收所选文本和大纲，适配器不另发模型请求、不读取模型密钥。`paper_context`说明建议格式；`paper_build`针对传入的提取JSON做定位校验，不重新打开PDF，不证明人为改写后的输入等于原文件，也不证明解释正确。请保留原提取结果和PDF供核对。

引用核查只向`api.crossref.org`发送所选引用的DOI或题名及可选联系邮箱，不发送PDF正文；网络错误保留unresolved。verified表示书目元数据匹配，正文主张是否受支持需要另行阅读。工具停止信号传给文件读取、逐页处理和联网请求，已启动的解析会完成当前步骤后退出。

自动书目候选跳过日期页脚，遇到带编号的Fig/Figure或中文图注时结束该条并等待下一编号书目，以处理已观察到的浮动图混入；跨页续行、无编号书目和其他复杂布局仍需人工分条，不保证完整提取。提交模型建议时选用单页可定位的原始书目片段。

公开源码仓库根目录可运行npm test与npm run check:packages，分别核对核心行为和打包后独立安装。SDK与真实API的开发环境检查另行记录，相关私有开发脚本和运行文件不随本仓库或npm包分发；公开检查不启动真实模型或宿主。范围见[验证说明](https://github.com/XTSgreen/medical-research-workflows/blob/main/docs/VALIDATION.md)，真实模型质量与插件界面仍需单独验收。

## 本地提取

从工作区根目录执行：

```powershell
node packages/paper-autopsy/cli.js analyze --pdf examples/autopsy/teaching-paper.pdf --outline examples/autopsy/outline.json --output output/my-reading-card
```

输出目录必须不存在，以免覆盖以前的阅读记录。示例 PDF 全部为原创虚构研究，不是医学证据；图像页测试 PDF 只是验证提取器行为。

默认 local 模式不调用模型，不发送 PDF 到外部服务。它按关键词定位主张候选、统计方法、样本、复现和局限相关原文，输出的是线索；未能识别的内容写为缺项，不生成虚构的可借鉴点或完整医学分析。关键词可能漏检或误检，原文上下文需人工核对。

## 模型深读

模型需支持 OpenAI 兼容 chat/completions 与 JSON 对象响应。配置 `RESEARCH_MODEL_BASE_URL`、`RESEARCH_MODEL_API_KEY`、`RESEARCH_MODEL` 后执行：

```powershell
node packages/paper-autopsy/cli.js analyze --pdf paper.pdf --mode model --send-to-model --outline outline.json --direction "我的综述问题" --output output/model-reading-card
```

所选页面文字、大纲和研究方向会发送给该服务。程序不会发送 PDF 二进制图片，但提取文本可能包含未公开研究或个人信息，请按你对这些材料的授权范围使用。每次 analyze 发起一次模型请求，费用按服务商实际计费。

每条主张、方法、可借鉴点、局限与归位建议都必须附证据；程序核对摘录是否出现在对应可读物理页。这个核对只确认文本定位，不能证明模型解释正确、因果判断成立或原研究可信。模型输出始终 unverified，不能通过一次结构检查成为已审读结论。

## 节选、扫描与长文

```powershell
node packages/paper-autopsy/cli.js analyze --pdf paper.pdf --pages 1-5,8 --allow-partial --output output/excerpt-card
```

页码从 PDF 文件第一页按 1 开始，保留原文件物理页，不按期刊页码重编号。未选择或文本不足的页列入 excludedPages。文本不足的图像页提示 OCR，空白或矢量文字页也可能被要求人工检查；默认不会悄悄跳过。显式 allow-partial 可在混合 PDF 中只处理可读页，全扫描且没有可靠文字时仍拒绝生成空白卡。

本版本没有内置 OCR。先用自己有权使用的 OCR 工具生成可搜索副本，再保留原版与副本对应关系；副本有自己的文件哈希，不冒充原文件。50 MB、500 页是当前提取上限，模型输入上限为100000字符，超过时选节或分批阅读。双栏、公式与表格提取顺序需要人工核对，字符存在不代表阅读顺序正确。

## 综述大纲

outline.json 是数组，每节包含 id、title、keywords：

```json
[
  { "id": "S1", "title": "观察性研究方法", "keywords": ["cohort", "regression"] },
  { "id": "S2", "title": "研究局限", "keywords": ["limitations"] }
]
```

本地模式按关键词给归位线索；模型模式给理由与原文证据。没有合适章节时保留待定，不新造章节 ID。keywords 可为空数组，用于只希望模型按节名判断的情况。

## 引用核查

在生成卡片时增加 `--verify-references`，或对已经保存的卡片运行：

```powershell
node packages/paper-autopsy/cli.js verify --input output/my-reading-card/card.json --output output/checked-reading-card
```

会将提取书目的 DOI 或题名发送到 Crossref 官方 API，按一秒以上间隔串行查询并有限重试。可用 `--email 自己的联系邮箱` 设置 Crossref mailto 标识。网络不可达或来源缺少记录时保留待核验，不断言文献不存在。

| 状态 | 含义 |
| :-- | :-- |
| verified | 提供的 DOI 与题名匹配，且已提供的作者、年份没有冲突；无 DOI 的题名检索还需唯一题名、作者与年份交叉匹配 |
| mismatch | 已提供的 DOI、题名、作者或年份与候选记录冲突 |
| unresolved | 无唯一候选、字段不足、无记录或网络失败 |

DOI 有记录但待核对题名为空时仍为 unresolved，不能确认整条引用。出版年可能因在线与纸刊版不同，工具保留候选登记的多个年份进行比较，未能自动确认时由人查看原记录。

本地参考文献提取只识别独立 References/Bibliography/参考文献标题及常见编号分条；未识别格式可能被保留为整段候选。模型未完整覆盖的自动候选不会丢弃。作者年份格式、双栏错序和跨页条目需要手动分条、补齐原书目中可见的 title/author/year 后再 verify，不能凭记忆填写。编辑后保留原始 raw 和页码来源。

verified 只确认书目匹配，不证明引用支持文章某句话，也不证明论文没有撤稿、设计缺陷或其他问题。本版本不是完整的撤稿与研究质量审核工具。

## 导出与复查

`paper-autopsy export --input card.json --output new-reading-card.md` 重新导出，拒绝覆盖。JSON 保存各证据的页面摘录与文本哈希，错误的证据 ID、页码、摘录或文本哈希会被拒绝。哈希不是作者签名，若人为同时修改全部内容与哈希，仍需原 PDF 独立核对。

使用 X4 等后续工具时应导入完整 card.json，保留 documentId、sourceFileHash、evidence ID 和物理页关系。局限条目的 reader-inference 表示阅读者推断，不能当作论文作者原话。

## 验证范围

公开源码仓库根目录 `npm test` 包含真实 PDF 字节提取、图像页拦截、节选、模型虚构证据拒绝、参考书目字段约束、元数据匹配/冲突/待定、本机 HTTP 模型协议及跨进程 CLI。测试中的论文与模型响应为教学构造，不是实际模型质量评估。


官方接口说明：PDF.js <https://mozilla.github.io/pdf.js/examples/>；Crossref <https://www.crossref.org/documentation/retrieve-metadata/rest-api/>。本软件 MIT，PDF、论文和外部服务保留各自权利与使用条款。
