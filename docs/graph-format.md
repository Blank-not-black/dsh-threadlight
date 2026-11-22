# 图谱契约 v1

输入位置为当前 DSH 会话工作目录中的 .threadlight/graph.json。CLI 也可读取用户指定的同格式 JSON。examples/basic.graph.json 是可直接运行的最小例子。

| 层级 | 字段 |
| --- | --- |
| 项目 | schemaVersion 为 1，project.name，groups，可选 glossary |
| 源码快照 | refresh 写入可选 snapshot，含 scope（working-tree）、id（快照 SHA-256）、baseCommit（Git HEAD，无提交时为 null） |
| 术语 | glossary 为对象数组。term 是正文中的词，最长 64 字符。definition 是单行解释，最长 360 字符 |
| 功能区 | id、title、flows，可选 summary |
| 线路 | id、title、summary、nodes、edges，可选 layout.rows 和 links |
| 实现节点 | id、title、summary、details、sources |
| 证据 | path、kind，可选正整数 line。kind 可取 source、test、documentation、workflow。宿主可写入 anchor、status、preview 和 symbol |
| 步骤连线 | from、to、kind。kind 可取 sequence、branch、merge。可选 label 表述走这条边的条件 |
| 跨线路链接 | group、flow、kind。目标为另一条已定义线路，kind 可取 uses、continues |

ID 在各自父级中唯一，使用小写字母、数字和连字符。引用节点的完整身份为 group/flow/node。源码路径用仓库相对路径和正斜杠，行号只是当前快照中的定位依据。保留稳定的语义 ID 可支持后续跨版本批注。没有源码或测试依据时，可以留空 sources 并在 details 中说明待核实的问题。

节点的 summary 写一两句话，说明这一环节发生什么以及用户看到什么。details 记录输入、状态变化、失败后的动作和证据。refresh 提交的新线路和修订线路中，每条 branch 边都要用 label 写明触发条件，例如「摘要不符」「主机可达」。既有图谱仍可读取。重试边明确指回相应步骤。layout.rows 中每个节点出现一次，外层每项为画布的一列。省略布局时按连线排出先后与并行分支，环内节点以输入顺序安置。

项目术语最多 200 条，按不区分大小写的术语名去重。查看器优先显示项目解释，并为常见术语提供内置解释。增量文档补丁里的 glossary 只需包含新增或修订的定义。

## 增量审阅

文档会话用 reviewedPaths 报告变更路径，用 reviewedFlows 逐条回答输入中的 affectedFlows。每项使用 group、flow、reason，reason 为一行最多 360 字符的复核说明。模型可返回空 groups 表示沿用现有文档，程序按线路 ID 比较合并前后的可见内容和证据定位，独立计算实际新增、修改和删除数量。状态文件记录最近一次模型会话的 reviewedFlows。受影响范围根据已记录的证据关联以及待复核标记计算。

refresh 为带行号的证据写入 anchor。lineHash 是引用行的 SHA-256，contextHash 覆盖引用行及相邻两行，unique 和 contextUnique 分别表明引用行和这组上下文在文件内是否唯一。源码改动后，沿用的引用优先按在旧文件和新文件内均唯一的上下文定位，也可用在两份文件内均唯一的引用行定位。定位失败时保留路径，移除行号，以 status: needs-review 显示「证据待复核」。无指纹的旧引用在文件未变时可建立指纹。模型有意在同一位置引用新的内容时，可在补丁中提供精确 lineText。程序校验原文并在发布前移除该字段。

## 步骤、文档与实现依据

工作树快照中的证据可以附带 preview，包含从 startLine 起的短文本片段。文档引用优先填写对应标题或段落的行号。启用 Rust 索引器后，带行号的 JavaScript 证据可以附带 symbol，包含 name、kind、startLine 和 endLine。kind 可取 function、class、method、import 或 call。导入和调用记录来自语法树。测试源码引用用于查找测试定义，实际执行结果需另有验证记录。待复核的引用保留文件位置。

查看器按步骤展示源码、测试和相关文档。同一份源文档可以关联多个步骤，查看器提供返回其他引用步骤的入口。功能区文档使用稳定锚点 flow--step，链接回图谱的 `#step/<group>/<flow>/<step>`。DSH 查看器和离线查看器都可打开对应文档段落。离线快照同时保存同结构的 Markdown 供编辑器使用。

## 流程草稿

DSH Web 将流程草稿保存在工作区的 `.threadlight/drafts/<草稿 ID>/<版本>.json`。草稿有独立的 schemaVersion 1，记录 id、version、时间、plan 和可选的 base。复制已有线路时，base 记录原图谱摘要、线路标识、原始流程和证据。保存按版本追加，既有实现图谱继续作为阅读和导出的依据。

plan 包含线路名称、目标与范围、验收条件、步骤、连线和批注。步骤和连线保留稳定 ID。批注可指向一步或一条连线，也可针对整条线路。连线允许在编辑时留空条件，提交时每条 branch 需有明确条件。提示词包含完整的目标流程、与原线路相比的修改、选中的批注原话和基线证据。

草稿可用 plan.layout 保存手动放置的步骤位置，每项包含 step、x 和 y。连线可用 waypoints 保存有序的折线控制点，每条线最多 64 个。坐标使用画布单位，范围为 −100000 到 100000。旧草稿中的 bend 仍可读取，按原有横向比例和两端之间的相对高度映射为控制点。实现提示词与行为差异使用步骤内容、连线端点、类型和条件。

提交使用保存的版本。版本对应的 submission 和 submitted 记录分别保存待提交任务及宿主接收回执，重试复用会话和请求标识。回执表示提示词已被 DSH 接收，后续执行和验证进度在该工作区的 DSH 会话中查看。

## Obsidian 文档与连线约定

| 读者要找什么 | 打开哪里 |
| --- | --- |
| 这个项目能做什么 | 项目总览.md 汇集功能区，overview.canvas 提供对应总览 |
| 这个功能从哪几条线路进入 | 功能区笔记列出线路名称和一段短摘要 |
| 一次操作会怎么走 | 线路笔记先给用途和入口，再按步骤写行为与分支 |
| 这一步依据哪段代码 | 展开该步骤的「实现与证据」，查看实现、测试和原始位置 |
| 想直观看分支或重试 | 打开线路 Canvas，卡片显示标题和短摘要，可跳到笔记中对应步骤 |

**笔记图谱**采用「项目总览 → 功能区 → 线路」的方向。读者用 Obsidian 的反向链接找上层。跨线路关系来自显式 links。uses 从使用方指向所使用的线路，continues 从当前线路指向下一条线路。共享源码位置只作为证据，作者需要据实际调用或流程确定跨线路关系。

**线路 Canvas**的箭头按 from 和 to 绘制。并行分支在同一列，重试箭头指回较早的步骤。条件标签来自原始数据。卡片与笔记使用同一个稳定的 step-节点ID 块锚点。

笔记文件名优先用标题，处理 Windows 保留名、Obsidian 链接保留字符和同目录重名。长期引用使用笔记属性 threadlight_id、threadlight_kind 和节点块锚点。标题和文件名可随快照更新。

## 快照

输入最多 8 MiB。导出按输入内容和导出格式计算 SHA-256，在输出根下建立 threadlight-<摘要前缀>。threadlight-export.json 最后写入，表示本次导出已经完成。当前导出格式版本为 3，图谱输入仍为 schemaVersion 1。旧图谱可继续导出，旧版图谱的 snapshot.dirty 仍会写入导出清单。

相同输入复用先前的快照。中断后可补齐一致的文件，遇冲突时报告路径。图谱发生变化时产出独立快照，为跨版本比对和保留手工笔记提供基础。

[JSON Canvas 规范](https://jsoncanvas.org/spec/1.0/) · [Obsidian 内部链接](https://obsidian.md/help/links) · [折叠提示框](https://obsidian.md/help/callouts)
