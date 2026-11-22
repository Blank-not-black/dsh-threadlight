# 图谱契约 v1

输入位置为当前 DSH 会话工作目录中的 .threadlight/graph.json。CLI 也可读取用户指定的同格式 JSON。examples/basic.graph.json 是可直接运行的最小例子。

| 层级 | 字段 |
| --- | --- |
| 项目 | schemaVersion 为 1，project.name，顶层 groups，可选 project.areas 和 glossary |
| 领域 | project.areas 中的对象，含 id、title 和可选的 summary |
| 源码快照 | refresh 写入可选 snapshot，含 scope（working-tree）、id（快照 SHA-256）、baseCommit（Git HEAD，无提交时为 null） |
| 术语 | glossary 为对象数组。term 是正文中的词，最长 64 字符。definition 是单行解释，最长 360 字符 |
| 功能区 | id、title、flows，可选 summary。声明了领域时必须填写 group.area |
| 线路 | id、title、summary、nodes、edges，可选 layout.rows 和 links |
| 实现节点 | id、title、summary、details、sources。宿主可写入 state、verification 和 divergence |
| 证据 | path、kind，可选正整数 line。kind 可取 source、test、documentation、workflow。宿主可写入 anchor、status、preview 和 symbol |
| 步骤连线 | from、to、kind。kind 可取 sequence、branch、merge。可选 label 表述走这条边的条件 |
| 跨线路链接 | group、flow、kind。目标为另一条已定义线路，kind 可取 uses、continues |

ID 使用小写字母、数字和连字符。领域 ID 在项目内唯一，功能区 ID 在整个项目中全局唯一，线路和步骤 ID 在各自父级中唯一。引用节点的完整身份为 group/flow/node。源码路径用仓库相对路径和正斜杠，行号只是当前快照中的定位依据。保留稳定的语义 ID 可支持后续跨版本批注。没有源码或测试依据时，可以留空 sources 并在 details 中说明待核实的问题。

节点的 summary 写一两句话，说明这一环节发生什么以及用户看到什么。details 记录输入、状态变化、失败后的动作和证据。refresh 提交的新线路和修订线路中，每条 branch 边都要用 label 写明触发条件，例如「摘要不符」「主机可达」。既有图谱仍可读取。重试边明确指回相应步骤。layout.rows 中每个节点出现一次，外层每项为画布的一列。省略布局时按连线排出先后与并行分支，环内节点以输入顺序安置。

项目术语最多 200 条，按不区分大小写的术语名去重。查看器优先显示项目解释，并为常见术语提供内置解释。增量文档补丁里的 glossary 只需包含新增或修订的定义。

## 项目层级

有领域的图谱按「项目 → 领域 → 功能区 → 线路 → 步骤」展示。project.areas 是最多 32 项的数组。每个领域的 id 是最长 64 字符的小写 slug，title 是最长 160 字符的非空单行文本，summary 是最长 6000 字符的可选文本。功能区仍保存在顶层 groups。声明领域后，每个功能区的 area 必须是某个已声明领域的 ID。领域按 project.areas 的顺序展示，同一领域内的功能区按 groups 的顺序展示。省略 project.areas 或使用空数组时，图谱按「项目 → 功能区 → 线路 → 步骤」展示，所有功能区必须省略 area。跨线路链接、步骤锚点和批注继续使用原有标识。

文档会话可以在 update.json 的顶层填写可选的 areas，结构与 project.areas 相同。合并时，同 ID 的定义在原位置整项替换，新 ID 按补丁顺序追加，未提及的领域会保留。功能区补丁可填写 area 调整归属，省略时沿用已有归属。第一次给旧图谱加领域时，需要给所有保留的功能区填写归属。合并结果仍须满足领域数量和引用约束，任何校验失败都会使整次更新失败。领域定义只支持新增和替换。

## 增量审阅

文档会话用 reviewedPaths 报告变更路径，用 reviewedFlows 逐条回答输入中的 affectedFlows。每项使用 group、flow、reason，reason 为一行最多 360 字符的复核说明。模型可返回空 groups 表示沿用现有文档，程序按线路 ID 比较合并前后的可见内容和证据定位，独立计算实际新增、修改和删除数量。状态文件记录最近一次模型会话的 reviewedFlows。受影响范围根据已记录的证据关联以及待复核标记计算。

refresh 为带行号的证据写入 anchor。lineHash 是引用行的 SHA-256，contextHash 覆盖引用行及相邻两行，unique 和 contextUnique 分别表明引用行和这组上下文在文件内是否唯一。源码改动后，沿用的引用优先按在旧文件和新文件内均唯一的上下文定位，也可用在两份文件内均唯一的引用行定位。定位失败时保留路径，移除行号，以 status: needs-review 显示「证据待复核」。无指纹的旧引用在文件未变时可建立指纹。模型有意在同一位置引用新的内容时，可在补丁中提供精确 lineText。程序校验原文并在发布前移除该字段。

## 步骤、文档与实现依据

工作树快照中的证据可以附带 preview，包含从 startLine 起的短文本片段。文档引用优先填写对应标题或段落的行号。启用 Rust 索引器后，带行号的 JavaScript 证据可以附带 symbol，包含 name、kind、startLine 和 endLine。kind 可取 function、class、method、import 或 call。导入和调用记录来自语法树。测试源码引用用于查找测试定义，实际执行结果需另有验证记录。待复核的引用保留文件位置。

查看器按步骤展示源码、测试和相关文档。同一份源文档可以关联多个步骤，查看器提供返回其他引用步骤的入口。功能区文档使用稳定锚点 flow--step，链接回图谱的 `#step/<group>/<flow>/<step>`。DSH 查看器和离线查看器都可打开对应文档段落。离线快照同时保存同结构的 Markdown 供编辑器使用。

### 步骤状态与验证

以下节点字段均可省略，图谱仍使用 schemaVersion 1。

| 字段 | 类型与约束 |
| --- | --- |
| state | 字符串。planned 显示「计划」，implemented 显示「有实现依据」，verified 显示「已实际验证」。省略时，有 sources 就显示「有实现依据」，其余显示「计划」。派生状态只用于展示 |
| verification | 数组，最多 20 项。每项包含 id、at、result、summary 和可选的 command。id 是节点内唯一的小写 slug，最长 64 字符。at 为最长 40 字符的单行 ISO-8601 时间，可用 Date.parse 解析。result 取 passed 或 failed。summary 和 command 为非空单行文本，分别最长 360 和 512 字符 |
| divergence | 文本，最多 2000 字符。记录与草稿预期的差异或需要继续核实的结果 |

只有 state 为 verified 时才可填写 verification，且至少有一项 passed。仅有失败结果时可在 divergence 中说明实际情况。文档会话省略这三个宿主管理字段。合并文档会话结果时，沿用同一 group、flow、node ID 时保留原字段。

## 查看器批注

DSH 查看器将批注保存在 `.threadlight/annotations/<功能区 ID>/<UUID>.json`。记录包含 id、text、createdAt、module、graph、target 和可选的 quote。module 为功能区 ID，graph 为创建批注时的图谱 SHA-256。修改正文时补写 ISO-8601 格式的 updatedAt，保留原引用、归属和创建时间。

target 的 kind 可取 group、flow 或 step。group 以 module 为目标，flow 还需指定该模块下的 flow ID，step 另需指定该线路下的 step ID。没有 target 的旧记录按 `{ "kind": "group" }` 读取。text 为 1 至 3000 字符的正文。可选的 quote 最长 3000 字符，保留选文的空白与换行。

`GET /threadlight/api/annotations` 返回指定模块的批注列表。`POST` 新建并返回 `{ note }`，`PATCH` 按 id 修改正文并返回 `{ note }`，`DELETE` 按 id 删除文件并返回 `{ deleted: true }`。请求需提供 workspace、group 和当前 digest，写请求沿用审阅页的同源校验。目标无效返回 400，找不到待修改或删除的批注返回 404，图谱已更新返回 409。

`GET /threadlight/api/annotations?workspace=<id>&all=1` 返回工作区全部批注，附加 group、groupTitle、适用的 flowTitle 和 stepTitle，以及 `submitted: { sessionId, submittedAt } | null`。标题无法解析时显示对应 ID。有多个回执时显示最近一次接收记录。

`POST /threadlight/api/annotations-submit` 接收 workspace、1 至 100 个批注 UUID 组成的 ids，以及可选的 digest。省略 digest 时使用当前图谱摘要。每条批注都须属于该工作区和当前图谱，且能解析到目标。批注缺失返回 404，摘要或批注所属图谱不匹配返回 409。接口只读取批注，DSH 接收任务后返回 `{ submission }`。

回执保存在 `.threadlight/submissions/<digest>.json`，包含 schemaVersion（固定为 1）、digest、noteIds、workspace、sessionId、requestId、prompt 和 ISO-8601 格式的 submittedAt。回执的 digest 取去重、排序后的 UUID 数组 JSON 的 SHA-256，区别于图谱摘要。相同批注 ID 集合重复提交会返回已有回执，顺序和正文编辑不改变提交标识。DSH 拒收时返回 502，同一集合的重试从 `<digest>.pending.json` 复用会话 ID、请求 ID 和提示词。批注箱读取有效的接收回执，跳过待提交记录和损坏文件。

## 流程草稿

DSH Web 将流程草稿保存在工作区的 `.threadlight/drafts/<草稿 ID>/<版本>.json`。草稿有独立的 schemaVersion 1，记录 id、version、时间、plan 和可选的 base。复制已有线路时，base 记录原图谱摘要、线路标识、原始流程和证据。保存按版本追加，既有实现图谱继续作为阅读和导出的依据。

plan 包含线路名称、目标与范围、验收条件、步骤、连线和批注。步骤和连线保留稳定 ID。批注可指向一步或一条连线，也可针对整条线路。提交时只要求填写线路名称，目标与范围、验收条件、步骤名称、步骤说明和分支条件都可留空。连线仍需使用有效步骤端点。提示词明确标记留空字段，包含随任务提交的批注原话，并在有基线时附上证据及适用的流程差异。

提交需要至少一个步骤。没有步骤时，只要至少有一条标记为「随任务提交」的线路批注，就可以提交。提示词将任务标记为用户反馈，并使用一个「用户反馈」步骤承载批注。该步骤只出现在提示词中，无需为它生成步骤实现报告。

草稿可用 plan.layout 保存手动放置的步骤位置，每项包含 step、x 和 y。连线可用 waypoints 保存有序的折线控制点，每条线最多 64 个。坐标使用画布单位，范围为 −100000 到 100000。旧草稿中的 bend 仍可读取，按原有横向比例和两端之间的相对高度映射为控制点。实现提示词与行为差异使用步骤内容、连线端点、类型和条件。

提交使用保存的版本。版本对应的 submission 和 submitted 记录分别保存待提交任务及宿主接收回执，重试复用会话和请求标识。回执表示提示词已被 DSH 接收，后续执行和验证进度在该工作区的 DSH 会话中查看。

## 实现报告

DSH 实现会话把 UTF-8 JSON 写到仓库的 `.threadlight/implementation/<草稿 ID>/<版本>.json`。草稿 ID 为 UUID，版本为正整数。报告结构如下。

~~~json
{
  "schemaVersion": 1,
  "draft": { "id": "50663508-feb0-4d94-8ae7-535cd01cb868", "version": 3 },
  "generatedAt": "2026-11-22T04:30:00.000Z",
  "summary": "实现了上传后的重试操作。",
  "steps": [
    {
      "step": "retry",
      "state": "verified",
      "sources": [{ "path": "lib/upload.mjs", "kind": "source", "line": 12 }],
      "verification": [
        { "id": "check", "at": "2026-11-22T04:29:00.000Z", "result": "passed", "summary": "重试用例通过。", "command": "npm run check" }
      ],
      "divergence": "重试按钮只在网络错误时显示。"
    }
  ]
}
~~~

generatedAt 使用与验证记录相同的时间格式。summary 为可选文本，最长 2000 字符。steps 含 1 至 200 项，step 必须是该草稿 plan.nodes 中的 ID，且报告内唯一。每项提供 sources 数组，遵循图谱证据约定并替换原数组，提供空数组可清空原证据。state、verification 和 divergence 按图谱约定校验，省略时沿用目标步骤原值。实现会话只列出实际运行的验证。

`report` 查找匹配的草稿版本及提交回执，再根据草稿 base 的 group 和 flow 在已发布的 refresh 图谱中定位目标线路。缺少匹配记录、基线或目标线路时跳过该报告。实现期间图谱版本可以变化，当前线路按步骤 ID 匹配。当前图谱中缺失的步骤会列入 skippedSteps，报告中的其他有效步骤仍可发布。整份报告没有可应用的步骤时会跳过，可在图谱补齐步骤后重跑。

先运行 `report` 更新步骤并按当前工作树重新锚定证据，再运行 `refresh` 审阅源码变更。报告发布新的查看器和文档版本，在 state.json 中只更新 revision，保留原源码快照与文档会话记录。发布成功后，`<版本>.applied.json` 保存 reportHash（报告原文件的 SHA-256）、revision 和 at。文件摘要相同时跳过，摘要改变时重新校验。CLI 输出 applied、skipped、rejected 和当前 revision，有拒绝项时退出码为 1。

## Obsidian 文档与连线约定

| 读者要找什么 | 打开哪里 |
| --- | --- |
| 这个项目能做什么 | 项目总览.md 汇集功能区，overview.canvas 提供对应总览 |
| 这个功能从哪几条线路进入 | 功能区笔记列出线路名称和一段短摘要 |
| 一次操作会怎么走 | 线路笔记先给用途和入口，再按步骤写行为与分支 |
| 这一步依据哪段代码 | 展开该步骤的「实现与证据」，查看实现、测试和原始位置 |
| 想直观看分支或重试 | 打开线路 Canvas，卡片显示标题和短摘要，可跳到笔记中对应步骤 |

**笔记图谱**采用「项目总览 → 功能区 → 线路」的链接方向。声明领域时，项目总览按领域分节列出功能区，总览 Canvas 在项目与功能区之间加入领域卡片。读者用 Obsidian 的反向链接找上层。跨线路关系来自显式 links。uses 从使用方指向所使用的线路，continues 从当前线路指向下一条线路。共享源码位置只作为证据，作者需要据实际调用或流程确定跨线路关系。

**线路 Canvas**的箭头按 from 和 to 绘制。并行分支在同一列，重试箭头指回较早的步骤。条件标签来自原始数据。卡片与笔记使用同一个稳定的 step-节点ID 块锚点。

笔记文件名优先用标题，处理 Windows 保留名、Obsidian 链接保留字符和同目录重名。长期引用使用笔记属性 threadlight_id、threadlight_kind 和节点块锚点。标题和文件名可随快照更新。

## 快照

输入最多 8 MiB。导出按输入内容和导出格式计算 SHA-256，在输出根下建立 threadlight-<摘要前缀>。threadlight-export.json 最后写入，表示本次导出已经完成。当前导出格式版本为 5，图谱输入仍为 schemaVersion 1。旧图谱可继续导出，旧版图谱的 snapshot.dirty 仍会写入导出清单。

相同输入复用先前的快照。中断后可补齐一致的文件，遇冲突时报告路径。图谱发生变化时产出独立快照，为跨版本比对和保留手工笔记提供基础。

### 发布历史与变动日志

`refresh` 和 `report` 在图谱、查看器与状态写入成功后，用原子替换更新 `.threadlight/history.json`。该文件使用独立的 schemaVersion 1，`entries` 按发布时间追加，最多保留 200 条。同一 revision 只保留一条。历史缺失或无法解析时按空历史处理。

每项含 `revision`、UTC 时间 `at` 和 `status`。刷新状态为 `updated`、`reviewed` 或 `rendered`，实现报告为 `reported`。可选的 `snapshotId` 对应本次生成或证据定位使用的工作树，`sessionId` 对应文档会话或提交回执中的实现会话。

变动日志按稳定 ID 比较领域、功能区、线路与步骤。新增或删除整个分支时记录该分支的根。已有步骤的证据先按 path、kind 和 line 匹配，再按行号顺序配对同一文件和类型的剩余引用。步骤状态按显示值比较，验证记录按 id 匹配。JSON 每对版本包含 `from`、`to`、目标版本时间 `at`、排序依据 `orderSource` 和 `changes`。排序依据为 `history`、`mtime` 或 `explicit`。

`reset` 与 `refresh`、`report` 共用发布锁。归档包含当前 `state.json`、`viewer.html`、`revisions/` 和已有的 `history.json`、`changes.md`。下次刷新开启新一轮发布历史。

[JSON Canvas 规范](https://jsoncanvas.org/spec/1.0/) · [Obsidian 内部链接](https://obsidian.md/help/links) · [折叠提示框](https://obsidian.md/help/callouts)
