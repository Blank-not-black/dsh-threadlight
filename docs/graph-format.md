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

## 校验错误码

`dsh-threadlight validate <graph.json> --json` 在标准输出写入一个 JSON 对象。成功时退出码为 0，`summary` 给出功能区、线路、步骤和领域的数量。省略 `--json` 时，成功输出直接包含这四个计数字段。

~~~json
{"ok":true,"summary":{"groups":1,"flows":1,"nodes":3,"areas":0}}
~~~

失败时退出码为 1，`error` 描述首个校验错误或输入文件错误。

~~~json
{
  "ok": false,
  "error": {
    "code": "graph/source-path",
    "path": "groups[0].flows[0].nodes[0].sources[0].path",
    "message": "Invalid graph: groups[0].flows[0].nodes[0].sources[].path must be repository-relative",
    "hint": "Use a repository-relative path with forward slashes."
  }
}
~~~

`parseGraph(raw)` 校验失败时抛出 `GraphError`。`inspectGraph(raw)` 返回与 CLI 同形的校验回执，并继续抛出其他异常。`GraphError` 包含以下字段。

- `code` 是下表中的稳定错误码，供程序判断失败原因。
- `path` 指向输入中的字段、数组项或对象，数组下标从 0 开始。`$` 指整个输入。
- `message` 是以 `Invalid graph:` 开头的可读说明。
- `hint` 是可选的修复提示。

| 错误码 | 含义 | 典型修复 |
| --- | --- | --- |
| `graph/arguments` | CLI 校验参数无效 | 传入恰好一个图谱文件路径和可选的 `--json` |
| `graph/input-read` | CLI 无法读取输入文件 | 检查路径、文件类型与读取权限 |
| `graph/input-size` | 输入超过 8 MiB，或 API 收到非字符串输入 | 提供不超过 8 MiB 的 UTF-8 JSON 文本 |
| `graph/json` | JSON 语法错误或文件编码无效 | 修正 JSON 语法并以 UTF-8 保存 |
| `graph/schema-version` | 根值不是图谱对象或 `schemaVersion` 不是 `1` | 使用根对象及数值 `1` |
| `graph/project-name` | 项目名称无效 | 填写最多 160 字符的非空单行名称 |
| `graph/area-list` | 领域数组无效 | 提供 0 至 32 个领域 |
| `graph/area-record` | 领域条目不是对象 | 提供含 `id` 和 `title` 的对象 |
| `graph/area-id-format` | 领域 ID 格式无效 | 使用最多 64 字符的小写 slug |
| `graph/area-id` | 领域 ID 重复 | 为每个领域分配项目内唯一的 ID |
| `graph/area-title` | 领域标题无效 | 填写最多 160 字符的非空单行标题 |
| `graph/area-summary` | 领域摘要无效 | 提供最多 6000 字符的文本，或省略此字段 |
| `graph/glossary-list` | 术语数组无效 | 提供最多 200 个术语对象 |
| `graph/glossary-entry` | 术语条目不是对象 | 提供含 `term` 和 `definition` 的对象 |
| `graph/glossary-term` | 术语文本无效 | 填写最多 64 字符的非空单行术语 |
| `graph/glossary-definition` | 术语解释无效 | 填写最多 360 字符的非空单行解释 |
| `graph/glossary-term-whitespace` | 术语含首尾空白 | 去掉首尾空白 |
| `graph/glossary-term-duplicate` | 术语大小写折叠后重复 | 合并重复的术语定义 |
| `graph/group-list` | 功能区数组无效 | 提供 1 至 64 个功能区 |
| `graph/group-record` | 功能区条目不是对象 | 提供功能区对象 |
| `graph/group-id-format` | 功能区 ID 格式无效 | 使用最多 64 字符的小写 slug，避开 Windows 保留设备名 |
| `graph/group-id` | 功能区 ID 重复 | 为每个功能区分配项目内唯一的 ID |
| `graph/group-title` | 功能区标题无效 | 填写最多 160 字符的非空单行标题 |
| `graph/area-reference-type` | 声明领域后，功能区的 `area` 缺失或不是字符串 | 填写已声明的领域 ID |
| `graph/area-reference` | 功能区引用了未知领域 | 使用 `project.areas` 中已声明的 ID |
| `graph/area-reference-undeclared` | 未声明领域时填写了功能区的 `area` | 省略 `area`，或声明领域并为所有功能区填写归属 |
| `graph/group-summary` | 功能区摘要无效 | 提供最多 6000 字符的非空文本，或省略此字段 |
| `graph/flow-list` | 线路数组无效 | 在功能区内提供 1 至 100 条线路 |
| `graph/flow-record` | 线路条目不是对象 | 提供线路对象 |
| `graph/flow-id-format` | 线路 ID 格式无效 | 使用最多 64 字符的小写 slug，避开 Windows 保留设备名 |
| `graph/flow-id` | 线路 ID 重复 | 为功能区内的每条线路分配唯一 ID |
| `graph/flow-title` | 线路标题无效 | 填写最多 160 字符的非空单行标题 |
| `graph/flow-summary` | 线路摘要无效 | 填写最多 6000 字符的非空文本 |
| `graph/node-list` | 节点数组无效 | 在线路内提供 1 至 200 个节点 |
| `graph/node-record` | 节点条目不是对象 | 提供节点对象 |
| `graph/node-id-format` | 节点 ID 格式无效 | 使用最多 64 字符的小写 slug，避开 Windows 保留设备名 |
| `graph/node-id` | 节点 ID 重复 | 为线路内的每个节点分配唯一 ID |
| `graph/node-title` | 节点标题无效 | 填写最多 160 字符的非空单行标题 |
| `graph/node-summary` | 节点摘要无效 | 填写最多 6000 字符的非空文本 |
| `graph/node-details` | 节点详情数组无效 | 提供最多 50 条详情，可用空数组 |
| `graph/node-detail` | 单条节点详情无效 | 使用最多 6000 字符的非空文本 |
| `graph/source-list` | 节点证据数组无效 | 提供最多 50 条证据，可用空数组 |
| `graph/source-record` | 证据条目不是对象 | 提供含 `path` 和 `kind` 的对象 |
| `graph/source-path` | 证据路径无效 | 使用最多 1024 字符的仓库相对路径和正斜杠 |
| `graph/source-kind` | 证据种类不受支持 | 使用 `source`、`test`、`documentation` 或 `workflow` |
| `graph/source-line` | 证据行号无效 | 使用正的安全整数，或省略行号 |
| `graph/source-status` | 证据待复核状态无效 | 使用 `needs-review`，并省略行号和指纹 |
| `graph/source-anchor` | 证据指纹无效 | 为带行号的引用提供完整的行和上下文指纹 |
| `graph/source-preview` | 预览对象、引用状态或起始行不符合要求 | 提供有效的 `startLine`，并使用适用的未标记待复核引用 |
| `graph/source-preview-text` | 预览文本无效 | 填写最多 1200 字符的非空文本 |
| `graph/source-preview-coverage` | 预览未覆盖引用行 | 调整起始行或文本，让预览包含引用行 |
| `graph/source-symbol` | 符号对象、种类或行号范围无效 | 使用支持的符号种类，并让范围覆盖证据行号 |
| `graph/source-symbol-name` | 符号名称无效 | 填写最多 160 字符的非空单行名称 |
| `graph/node-state` | 节点状态不受支持 | 使用 `planned`、`implemented` 或 `verified` |
| `graph/node-divergence` | 差异说明无效 | 提供最多 2000 字符的文本，或省略此字段 |
| `graph/verification-state` | 非 `verified` 节点带有验证记录 | 移除记录，或在验证通过后将状态设为 `verified` |
| `graph/verification-list` | 验证数组无效 | 提供最多 20 条验证记录的数组 |
| `graph/verification-record` | 验证条目不是对象 | 提供包含 `id`、`at`、`result` 和 `summary` 的对象 |
| `graph/verification-id-format` | 验证记录 ID 格式无效 | 使用最多 64 字符的小写 slug |
| `graph/verification-id` | 验证记录 ID 重复 | 为节点内的每条记录分配唯一 ID |
| `graph/verification-at` | 验证时间无效 | 使用可解析的 ISO-8601 时间 |
| `graph/verification-result` | 验证结果不受支持 | 按实际结果填写 `passed` 或 `failed` |
| `graph/verification-summary` | 验证摘要无效 | 填写最多 360 字符的非空单行摘要 |
| `graph/verification-command` | 验证命令无效 | 提供最多 512 字符的非空单行命令，或省略此字段 |
| `graph/verification` | `verified` 节点缺少通过的验证 | 记录实际通过的验证，或更正节点状态 |
| `graph/edge-list` | 连线数组无效 | 提供最多 2000 条连线，可用空数组 |
| `graph/edge-endpoints` | 连线对象或端点无效 | 将 `from` 和 `to` 指向同一线路中的不同节点 |
| `graph/edge-kind` | 连线种类不受支持 | 使用 `sequence`、`branch` 或 `merge` |
| `graph/edge-label` | 连线标签无效 | 使用最多 120 字符的非空单行标签，或省略此字段 |
| `graph/edge-duplicate` | 连线的起点、终点和种类重复 | 移除重复的连线 |
| `graph/layout-rows` | 布局的外层数组无效 | 提供 1 至 200 列 |
| `graph/layout-row` | 单列布局的数组无效 | 每列放置 1 至 20 个节点 |
| `graph/layout-node` | 布局节点不存在或已放置 | 引用当前线路的节点，每个 ID 只放置一次 |
| `graph/layout-incomplete` | 布局遗漏节点 | 将所有未放置的节点补入布局 |
| `graph/link-list` | 跨线路链接数组无效 | 提供最多 50 条链接，或省略此字段 |
| `graph/link-reference` | 链接对象或 `group`、`flow` 字段类型无效 | 提供链接对象，使用字符串填写目标功能区和线路 ID |
| `graph/link-target` | 链接指向不存在的线路或自身 | 指向另一条已声明的线路 |
| `graph/link-kind` | 跨线路链接种类不受支持 | 使用 `uses` 或 `continues` |
| `graph/link-duplicate` | 链接目标与种类重复 | 移除重复的跨线路链接 |

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

`GET /threadlight/api/annotations?workspace=<id>&all=1` 返回工作区全部批注，附加 group、groupTitle、适用的 flowTitle 和 stepTitle，以及 `submitted: { sessionId, submittedAt } | null`。标题无法解析时显示对应 ID。有多个回执时显示最近一次接收记录。批注箱对每条批注提供修改和删除，分别调用 PATCH 和 DELETE，并带上当前 digest。

`POST /threadlight/api/annotations-submit` 接收 workspace、1 至 100 个批注 UUID 组成的 ids，可选的 digest，以及可选的 `agentPreset`（主会话使用的 DSH agent preset）。省略 digest 时使用当前图谱摘要。每条批注都须属于该工作区和当前图谱，且能解析到目标。批注缺失返回 404，摘要或批注所属图谱不匹配返回 409，preset 不存在返回 400，preset 服务缺失或不可用返回 503。所有批注进入同一个主会话：提示词按模块分组，要求主会话用 `subagent` 工具为每个模块派出子代理、控制并行数量、逐模块复核并汇总结果。接口只读取批注，DSH 接收任务后返回 `{ submission }`；回执记录 `noteIds`、`modules`、可选 `agentPreset` 和 `digest`，同一组批注重复提交复用原会话。

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
